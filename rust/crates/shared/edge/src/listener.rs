//! 노드 전용 리스너 (FR-PNW-4·5·8·9·31·41). UI 리스너와 따로 열고 닫는다.

use std::future::Future;
use std::io;
use std::pin::Pin;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use dm_gocompat::oserr::{go_error_string, syscall_error};
use dm_shared_dmlog as dmlog;
use http::{Request, StatusCode, header};
use hyper::body::Incoming;
use hyper::service::service_fn;
use hyper_util::rt::{TokioIo, TokioTimer};
use serde::Serialize;
use tokio::net::TcpListener;
use tokio::sync::watch;
use tokio_rustls::TlsAcceptor;

use crate::client::{BoxStream, REQUEST_TIMEOUT, host_port};
use crate::codes::CODE_NOT_EDGE;
use crate::config::Config;
use crate::identity::{Identity, fingerprint_of};
use crate::tls::{TlsAdmit, server_config};

/// 헤더를 다 읽을 때까지의 시한이다. TLS 핸드셰이크에도 같은 시한을 둔다.
const READ_HEADER_TIMEOUT: Duration = Duration::from_secs(10);
/// 핸들러가 응답을 끝낼 때까지의 시한이다. 보내는 쪽의 요청 시한보다 길다.
const WRITE_TIMEOUT: Duration = REQUEST_TIMEOUT.saturating_add(Duration::from_secs(5));
const MAX_HEADER_BYTES: usize = 16 << 10;
/// Go `http.Server` 가 MaxHeaderBytes 에 더하는 여유다.
const HEADER_SLACK: usize = 4096;
const ACCEPT_RETRY: Duration = Duration::from_millis(5);
/// 핸드셰이크 실패를 모아 한 줄로 남기는 주기다.
pub(crate) const HANDSHAKE_AGGREGATE: Duration = Duration::from_secs(60);
const NOT_EDGE_BODY: &str = r#"{"code":"edge_not_edge","message":"간선이 아닌 노드입니다"}"#;

pub type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send>>;
/// 노드 포트의 요청 처리기다. 보낸 노드의 지문은 [`client_fingerprint`] 로 꺼낸다.
pub type Handler =
    Arc<dyn Fn(Request<Incoming>) -> BoxFuture<dm_shared_httpresp::Response> + Send + Sync>;
/// 요청마다 지문과 경로를 보고 들일지 가른다.
pub type RequestAdmit = Arc<dyn Fn(&str, &str) -> bool + Send + Sync>;

/// 누가 노드 포트에 들어오는가다. tls 는 핸드셰이크에서 지문만 보고, request 는 요청마다
/// 지문과 경로를 함께 본다 (I-1).
#[derive(Clone)]
pub struct Admission {
    pub tls: TlsAdmit,
    pub request: RequestAdmit,
}

/// 두 단계 모두 is_edge 하나로 거르는 [`Admission`] 이다.
pub fn edges_only(is_edge: impl Fn(&str) -> bool + Send + Sync + 'static) -> Admission {
    let f = Arc::new(is_edge);
    let g = f.clone();
    Admission {
        tls: Arc::new(move |fp| f(fp)),
        request: Arc::new(move |fp, _| g(fp)),
    }
}

/// 요청을 보낸 노드의 지문이다(요청 extensions 에 실린다).
#[derive(Debug, Clone)]
struct PeerFingerprint(String);

/// 요청을 보낸 노드의 지문이다. 노드 포트 밖의 요청이면 빈 값이다.
pub fn client_fingerprint<B>(req: &Request<B>) -> &str {
    req.extensions()
        .get::<PeerFingerprint>()
        .map_or("", |p| p.0.as_str())
}

/// 노드 포트의 지금 상태다 (FR-PNW-9). err 는 열지 못한 사유다.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct Status {
    pub listening: bool,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub addr: String,
    #[serde(rename = "error", skip_serializing_if = "String::is_empty")]
    pub err: String,
    /// 연 횟수다. 같은 값이면 같은 리스너다.
    #[serde(skip)]
    pub generation: u64,
}

/// 연결을 받는 자리다. TCP 가 아닌 자리(데몬이 넘겨받은 노드 소켓 등)도 이것으로 듣는다.
pub trait Acceptor: Send + Sync + 'static {
    /// 연결 하나와 상대 주소(`host:port`)다.
    fn accept(&self) -> BoxFuture<io::Result<(BoxStream, String)>>;
    fn local_addr(&self) -> String;
}

impl Acceptor for Arc<TcpListener> {
    fn accept(&self) -> BoxFuture<io::Result<(BoxStream, String)>> {
        let l = self.clone();
        Box::pin(async move {
            let (s, peer) = TcpListener::accept(&l).await?;
            Ok((Box::new(s) as BoxStream, peer.to_string()))
        })
    }

    fn local_addr(&self) -> String {
        TcpListener::local_addr(self)
            .map(|a| a.to_string())
            .unwrap_or_default()
    }
}

/// [`Listener::apply`] 가 여는 자리를 정한다(bind, port). 오류 문구는 [`Status::err`] 에 실린다.
pub type ListenFn = Box<dyn Fn(&str, i64) -> io::Result<Box<dyn Acceptor>> + Send + Sync>;

#[derive(Clone, PartialEq, Eq, Default)]
struct ListenKey {
    enabled: bool,
    bind: String,
    port: i64,
}

#[derive(Default)]
struct State {
    applied: bool,
    key: ListenKey,
    status: Status,
    opened: u64,
    closed: bool,
    listen: Option<ListenFn>,
    stop: Option<watch::Sender<bool>>,
}

/// 노드 전용 리스너다.
pub struct Listener {
    tls: TlsAcceptor,
    admit: RequestAdmit,
    handler: Handler,
    hs_log: Arc<HandshakeLog>,
    state: Mutex<State>,
}

impl Listener {
    /// id 를 서버 인증서로 쓰고 adm 이 받는 클라이언트만 들이는 리스너다. apply 전에는 아무것도
    /// 듣지 않는다.
    pub fn new(id: &Identity, adm: Admission, handler: Handler) -> Result<Self, rustls::Error> {
        Ok(Self {
            tls: TlsAcceptor::from(server_config(id, adm.tls)?),
            admit: adm.request,
            handler,
            hs_log: Arc::new(HandshakeLog::new(Arc::new(after_func))),
            state: Mutex::new(State::default()),
        })
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// apply 가 TCP 대신 f 가 연 자리를 듣게 한다. apply 전에 부른다.
    pub fn use_listen(&self, f: ListenFn) {
        self.lock().listen = Some(f);
    }

    /// c 의 enabled·bind·port 에 맞춰 연다·닫는다·다시 연다 (FR-PNW-4·8). 그 셋이 같고 지금
    /// 상태가 그 값과 맞으면 아무것도 하지 않는다. 열지 못하면 사유를 [`Status`] 에 남긴다.
    /// tokio 런타임 안에서 부른다.
    pub fn apply(&self, c: &Config) {
        let key = ListenKey {
            enabled: c.enabled,
            bind: c.bind.clone(),
            port: c.port,
        };
        let mut st = self.lock();
        if st.closed || (st.applied && key == st.key && st.status.listening == key.enabled) {
            return;
        }
        close_locked(&mut st);
        st.applied = true;
        st.key = key.clone();
        if !key.enabled {
            return;
        }
        let opened = match &st.listen {
            Some(f) => f(&key.bind, key.port),
            None => listen_tcp(&key.bind, key.port),
        };
        let acc = match opened {
            Ok(a) => a,
            Err(e) => {
                let msg = e.to_string();
                dmlog::info(None, &format!("edge listener: {msg}"), &[]);
                st.status = Status {
                    err: msg,
                    ..Status::default()
                };
                return;
            }
        };
        st.opened += 1;
        let addr = acc.local_addr();
        let (tx, rx) = watch::channel(false);
        st.stop = Some(tx);
        st.status = Status {
            listening: true,
            addr: addr.clone(),
            err: String::new(),
            generation: st.opened,
        };
        let srv = Serve {
            tls: self.tls.clone(),
            admit: self.admit.clone(),
            handler: self.handler.clone(),
            hs_log: self.hs_log.clone(),
        };
        tokio::spawn(srv.run(acc, rx));
        dmlog::info(None, &format!("edge listener on {addr}"), &[]);
    }

    /// 지금 상태의 사본이다.
    pub fn status(&self) -> Status {
        self.lock().status.clone()
    }

    /// 리스너와 열린 연결을 닫는다. 여러 번 불러도 된다. 닫은 뒤에는 apply 가 다시 열지 않는다.
    pub fn close(&self) {
        let mut st = self.lock();
        close_locked(&mut st);
        st.applied = false;
        st.closed = true;
    }
}

impl Drop for Listener {
    fn drop(&mut self) {
        close_locked(&mut self.lock());
    }
}

fn close_locked(st: &mut State) {
    if let Some(tx) = st.stop.take() {
        let _ = tx.send(true);
    }
    st.status = Status::default();
}

/// Go `net.Listen("tcp", JoinHostPort(bind, port))` 이다. 오류 문구도 Go 꼴이다.
fn listen_tcp(bind: &str, port: i64) -> io::Result<Box<dyn Acceptor>> {
    let hp = host_port(bind, port);
    let go = |e: io::Error| {
        io::Error::new(
            e.kind(),
            format!(
                "listen tcp {hp}: {}",
                go_error_string(&syscall_error("bind", e))
            ),
        )
    };
    let std = std::net::TcpListener::bind(hp.as_str()).map_err(go)?;
    std.set_nonblocking(true).map_err(go)?;
    Ok(Box::new(Arc::new(TcpListener::from_std(std).map_err(go)?)))
}

#[derive(Clone)]
struct Serve {
    tls: TlsAcceptor,
    admit: RequestAdmit,
    handler: Handler,
    hs_log: Arc<HandshakeLog>,
}

impl Serve {
    async fn run(self, acc: Box<dyn Acceptor>, mut stop: watch::Receiver<bool>) {
        loop {
            let accepted = tokio::select! {
                _ = stop.changed() => return,
                r = acc.accept() => r,
            };
            match accepted {
                Ok((s, peer)) => {
                    tokio::spawn(self.clone().conn(s, peer, stop.clone()));
                }
                Err(e) => {
                    dmlog::info(
                        None,
                        &format!("edge listener: http: Accept error: {e}; retrying in 5ms"),
                        &[],
                    );
                    tokio::time::sleep(ACCEPT_RETRY).await;
                }
            }
        }
    }

    async fn conn(self, s: BoxStream, peer: String, mut stop: watch::Receiver<bool>) {
        let hs = tokio::time::timeout(READ_HEADER_TIMEOUT, self.tls.accept(s));
        let tls = tokio::select! {
            _ = stop.changed() => return,
            r = hs => match r {
                Ok(Ok(t)) => t,
                Ok(Err(e)) => return self.hs_log.write(&format!("http: TLS handshake error from {peer}: {e}")),
                Err(_) => return self.hs_log.write(&format!("http: TLS handshake error from {peer}: i/o timeout")),
            },
        };
        let fp = tls
            .get_ref()
            .1
            .peer_certificates()
            .and_then(|c| c.first())
            .and_then(|c| fingerprint_of(c));
        let fp = PeerFingerprint(fp.unwrap_or_default());
        let (admit, handler) = (self.admit.clone(), self.handler.clone());
        let svc = service_fn(move |mut req: Request<Incoming>| {
            req.extensions_mut().insert(fp.clone());
            let (admit, handler) = (admit.clone(), handler.clone());
            async move { serve_one(req, &admit, &handler).await }
        });
        let conn = hyper::server::conn::http1::Builder::new()
            .timer(TokioTimer::new())
            .header_read_timeout(READ_HEADER_TIMEOUT)
            .max_buf_size(MAX_HEADER_BYTES + HEADER_SLACK)
            .title_case_headers(true)
            .serve_connection(TokioIo::new(tls), svc)
            .with_upgrades();
        tokio::select! {
            _ = stop.changed() => {}
            _ = conn => {}
        }
    }
}

/// 요청마다 다시 거른다. 간선을 지운 뒤에도 열려 있던 연결이 핸들러에 닿지 않게 한다
/// (FR-PNW-31). 거절은 403 `edge_not_edge` 다 (FR-EPR-22·41).
/// 핸들러가 시한을 넘기면 응답 없이 연결을 끊는다(Go WriteTimeout 처럼).
async fn serve_one(
    req: Request<Incoming>,
    admit: &RequestAdmit,
    handler: &Handler,
) -> Result<dm_shared_httpresp::Response, io::Error> {
    let fp = client_fingerprint(&req);
    if fp.is_empty() || !admit(fp, req.uri().path()) {
        let mut resp =
            dm_shared_httpresp::fail_raw(StatusCode::FORBIDDEN, CODE_NOT_EDGE, NOT_EDGE_BODY);
        resp.headers_mut().insert(
            header::CONNECTION,
            header::HeaderValue::from_static("close"),
        );
        return Ok(resp);
    }
    tokio::time::timeout(WRITE_TIMEOUT, handler(req))
        .await
        .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "write timeout"))
}

pub(crate) type AfterFn = Arc<dyn Fn(Duration, Box<dyn FnOnce() + Send>) + Send + Sync>;

fn after_func(d: Duration, f: Box<dyn FnOnce() + Send>) {
    std::thread::spawn(move || {
        std::thread::sleep(d);
        f();
    });
}

#[derive(Default)]
struct HsState {
    open: bool,
    n: usize,
    last: String,
}

/// 핸드셰이크 실패의 기록이다. 짝이 아닌 누구나 핸드셰이크를 실패시킬 수 있으므로 창(1분)마다
/// 묶는다. 창의 첫 실패는 바로 한 줄, 창이 끝나면 나머지 건수를 한 줄로 남긴다 (I-71).
pub(crate) struct HandshakeLog {
    after: AfterFn,
    state: Arc<Mutex<HsState>>,
}

impl HandshakeLog {
    pub(crate) fn new(after: AfterFn) -> Self {
        Self {
            after,
            state: Arc::default(),
        }
    }

    pub(crate) fn write(&self, line: &str) {
        let line = line.trim_matches(char::is_whitespace);
        if !line.contains("TLS handshake error") {
            dmlog::info(None, &format!("edge listener: {line}"), &[]);
            return;
        }
        {
            let mut st = self.state.lock().unwrap_or_else(PoisonError::into_inner);
            if st.open {
                st.n += 1;
                st.last = line.to_string();
                return;
            }
            st.open = true;
        }
        dmlog::info(
            None,
            &format!("edge listener: TLS handshake failure count=1 ({line})"),
            &[],
        );
        let state = self.state.clone();
        (self.after)(HANDSHAKE_AGGREGATE, Box::new(move || flush(&state)));
    }
}

/// 창을 닫고, 창의 첫 실패 뒤에 온 건수를 남긴다.
fn flush(state: &Mutex<HsState>) {
    let (n, last) = {
        let mut st = state.lock().unwrap_or_else(PoisonError::into_inner);
        let out = (st.n, std::mem::take(&mut st.last));
        *st = HsState::default();
        out
    };
    if n > 0 {
        let window = dm_gocompat::time::format_std_duration(HANDSHAKE_AGGREGATE);
        dmlog::info(
            None,
            &format!(
                "edge listener: TLS handshake failure count={n} within {window} (최근: {last})"
            ),
            &[],
        );
    }
}
