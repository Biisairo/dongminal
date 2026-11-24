//! 서버를 끄지 않고 바인드를 바꾼다 (Go `rebind.go`, HOT_REBIND_SRS 묶음 R).

use std::collections::{BTreeMap, HashMap};
use std::convert::Infallible;
use std::io;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::Duration;

use dm_shared_dmenv as dmenv;
use dm_shared_dmlog::{errorf, infof, warnf};
use dm_shared_httpresp::Response;
use dm_shared_platform::canonical_addr;
use dm_shared_serverconf as serverconf;
use dm_webserver_apierr as apierr;
use http::{Method, StatusCode};
use hyper::body::Incoming;
use hyper_util::rt::{TokioIo, TokioTimer};
use serde::{Deserialize, Serialize};
use tokio::net::TcpStream;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

use crate::Server;
use crate::carry::CarryStore;
use crate::httperr::{code_fail, read_json_body, write_json};
use crate::netx::split_host_port;
use crate::openurl::is_loopback_addr;
use crate::rebind_conns::{ConnIo, ConnSet, ConnTimeouts, DoneBody, Phase};
use crate::req::Req;

/// 포트를 옮긴 뒤 옛 리스너를 남겨 두는 시간이다 (FR-HRB-23 ⑧).
pub(crate) const DEFAULT_BIND_GRACE: Duration = Duration::from_secs(30);
pub(crate) const BIND_PORT_MIN: i64 = 1024;
pub(crate) const BIND_PORT_MAX: i64 = 65535;
pub(crate) const EXPOSE_HOST: &str = "0.0.0.0";
/// expose 를 켤 때 응답과 로그에 싣는 경고다 (FR-HRB-29).
pub(crate) const EXPOSE_WARNING: &str =
    "인증이 없습니다 — 같은 망의 누구나 셸을 얻습니다. Settings ▸ Access 에서 허용 목록을 켜세요";

/// Go `net.Listen("tcp", addr)` 의 자리다. 시험이 바꾼다.
pub(crate) type ListenFn = Arc<dyn Fn(&str) -> io::Result<std::net::TcpListener> + Send + Sync>;

/// 기본 리슨 (Go `net.Listen`). 와일드카드는 가능하면 이중 스택이다.
pub(crate) fn default_listen(addr: &str) -> io::Result<std::net::TcpListener> {
    dm_shared_platform::listen_tcp(addr)
}

/// 실행 중 리바인드의 상태다 (Go `rebindState`).
pub(crate) struct RebindState {
    pub(crate) listen: ListenFn,
    pub(crate) grace: Duration,
    pub(crate) carry: CarryStore,
    /// `Run` 이 세운다. 없으면 리바인드할 수 없다.
    pub(crate) bind: Mutex<Option<Arc<Rebinder>>>,
    /// 연결마다의 머리·유휴 시한이다. 시험만이 줄인다.
    pub(crate) timeouts: ConnTimeouts,
}

impl Default for RebindState {
    fn default() -> Self {
        RebindState {
            listen: Arc::new(default_listen),
            grace: DEFAULT_BIND_GRACE,
            carry: CarryStore::default(),
            bind: Mutex::new(None),
            timeouts: ConnTimeouts {
                read_header: crate::run::READ_HEADER_TIMEOUT,
                idle: crate::run::IDLE_TIMEOUT,
            },
        }
    }
}

impl RebindState {
    pub(crate) fn current(&self) -> Option<Arc<Rebinder>> {
        self.bind.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
}

/// 리스너 하나의 수락 회차다. 닫으면 수락을 멈추고 리스너를 놓는다.
pub(crate) struct LnHandle {
    id: u64,
    cancel: CancellationToken,
    done: JoinHandle<()>,
}

impl LnHandle {
    /// Go `ln.Close()`. 리스너를 실제로 놓을 때까지 기다린다 — 같은 포트로 곧바로 다시 리슨한다.
    pub(crate) async fn close(self) {
        self.cancel.cancel();
        let _ = self.done.await;
    }
}

/// 유예 중인 옛 리스너와 그것이 묶인 호스트다 (FR-HRB-32).
pub(crate) struct GraceEntry {
    ln: LnHandle,
    host: String,
}

pub(crate) struct BindInner {
    pub(crate) busy: bool,
    pub(crate) host: String,
    pub(crate) port: String,
    ln: Option<LnHandle>,
    /// 키는 포트다.
    pub(crate) grace: HashMap<String, GraceEntry>,
}

/// `Run` 이 돌리는 서버와 그 리스너들이다 (Go `rebinder`).
pub(crate) struct Rebinder {
    srv: Weak<Server>,
    home: PathBuf,
    pub(crate) conns: Arc<ConnSet>,
    pub(crate) st: Mutex<BindInner>,
    timeouts: ConnTimeouts,
    /// 정중한 종료(Go `Shutdown`): 수락을 멈추고 유휴 연결을 닫는다.
    pub(crate) shutdown: CancellationToken,
    /// 강제 종료(Go `Close`).
    pub(crate) force: CancellationToken,
    pub(crate) tasks: TaskTracker,
    next_ln: AtomicU64,
}

impl Rebinder {
    pub(crate) fn new(srv: &Arc<Server>, host: String, port: String) -> Arc<Rebinder> {
        Arc::new(Rebinder {
            srv: Arc::downgrade(srv),
            home: srv.cfg.data_dir.clone(),
            conns: Arc::new(ConnSet::default()),
            st: Mutex::new(BindInner {
                busy: false,
                host,
                port,
                ln: None,
                grace: HashMap::new(),
            }),
            timeouts: srv.rebind.timeouts,
            shutdown: CancellationToken::new(),
            force: CancellationToken::new(),
            tasks: TaskTracker::new(),
            next_ln: AtomicU64::new(1),
        })
    }

    pub(crate) fn lock(&self) -> MutexGuard<'_, BindInner> {
        self.st.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub(crate) fn addr(&self) -> String {
        let st = self.lock();
        dm_shared_dmenv::join_host_port(&st.host, &st.port)
    }

    pub(crate) fn set_ln(&self, ln: LnHandle) {
        self.lock().ln = Some(ln);
    }

    /// 노출을 거둔다 (FR-HRB-32). 노출된 유예 리스너를 먼저 닫고, 같은 망에서 맺은 연결을 끊는다.
    async fn revoke_exposure(&self) {
        let closing: Vec<LnHandle> = {
            let mut st = self.lock();
            let ports: Vec<String> = st
                .grace
                .iter()
                .filter(|(_, g)| dmenv::is_exposed_host(&g.host))
                .map(|(p, _)| p.clone())
                .collect();
            ports
                .iter()
                .filter_map(|p| st.grace.remove(p).map(|g| g.ln))
                .collect()
        };
        for ln in closing {
            ln.close().await;
        }
        self.conns.revoke_remote();
    }

    /// 리스너 하나를 서빙한다. 일부러 닫은 리스너의 끝은 서버의 끝이 아니다.
    pub(crate) fn serve(self: &Arc<Self>, ln: std::net::TcpListener) -> io::Result<LnHandle> {
        ln.set_nonblocking(true)?;
        let ln = tokio::net::TcpListener::from_std(ln)?;
        let id = self.next_ln.fetch_add(1, Ordering::Relaxed);
        let cancel = CancellationToken::new();
        let b = Arc::clone(self);
        let c = cancel.clone();
        let done = self.tasks.spawn(async move { b.accept_loop(ln, c).await });
        Ok(LnHandle { id, cancel, done })
    }

    async fn accept_loop(self: Arc<Self>, ln: tokio::net::TcpListener, cancel: CancellationToken) {
        let mut delay = Duration::ZERO;
        loop {
            let acc = tokio::select! {
                _ = cancel.cancelled() => return,
                _ = self.shutdown.cancelled() => return,
                r = ln.accept() => r,
            };
            match acc {
                Ok((sock, remote)) => {
                    delay = Duration::ZERO;
                    self.spawn_conn(sock, canonical_addr(remote));
                }
                Err(e) => {
                    // Go `Server.Serve` 의 일시 오류 물러서기 (5ms 부터 두 배, 1초까지).
                    delay = if delay.is_zero() {
                        Duration::from_millis(5)
                    } else {
                        (delay * 2).min(Duration::from_secs(1))
                    };
                    errorf!(
                        None,
                        "http: Accept error: {e}; retrying in {}",
                        dm_gocompat::time::format_std_duration(delay)
                    );
                    tokio::select! {
                        _ = cancel.cancelled() => return,
                        _ = self.shutdown.cancelled() => return,
                        _ = tokio::time::sleep(delay) => {}
                    }
                }
            }
        }
    }

    fn spawn_conn(self: &Arc<Self>, sock: TcpStream, remote: SocketAddr) {
        let Some(srv) = self.srv.upgrade() else {
            return;
        };
        let Ok(local) = sock.local_addr().map(canonical_addr) else {
            return;
        };
        let phase = Phase::new(self.timeouts);
        let io = ConnIo::new(sock, self.conns.track(remote), Arc::clone(&phase));
        let b = Arc::clone(self);
        self.tasks.spawn(async move {
            let (shutdown, force) = (b.shutdown.clone(), b.force.clone());
            let svc = hyper::service::service_fn(move |req: http::Request<Incoming>| {
                let (srv, b, phase) = (Arc::clone(&srv), Arc::clone(&b), Arc::clone(&phase));
                async move {
                    let guard = phase.begin();
                    let res = b.handle(&srv, req, remote, local).await;
                    if res.status() == StatusCode::SWITCHING_PROTOCOLS {
                        phase.upgraded();
                    }
                    Ok::<_, Infallible>(res.map(|inner| DoneBody {
                        inner,
                        _guard: guard,
                    }))
                }
            });
            let mut builder = hyper::server::conn::http1::Builder::new();
            builder.timer(TokioTimer::new()).header_read_timeout(None);
            let conn = builder
                .serve_connection(TokioIo::new(io), svc)
                .with_upgrades();
            tokio::pin!(conn);
            tokio::select! {
                _ = conn.as_mut() => return,
                _ = force.cancelled() => return,
                _ = shutdown.cancelled() => {}
            }
            conn.as_mut().graceful_shutdown();
            tokio::select! {
                _ = conn.as_mut() => {}
                _ = force.cancelled() => {}
            }
        });
    }

    /// 요청 하나 (Go `http.Server` 의 요청 검사 → `graceRedirect` → 처리기).
    async fn handle(
        &self,
        srv: &Arc<Server>,
        req: http::Request<Incoming>,
        remote: SocketAddr,
        local: SocketAddr,
    ) -> Response {
        if let Some(res) = crate::run::host_check(&req) {
            return res;
        }
        if let Some(res) = self.grace_redirect(&req, local) {
            return res;
        }
        srv.serve(req, remote).await
    }

    /// 요청이 유예 중인 옛 리스너로 왔으면 지금 포트를 준다.
    fn moved_from(&self, local: SocketAddr) -> Option<String> {
        let st = self.lock();
        st.grace
            .contains_key(&local.port().to_string())
            .then(|| st.port.clone())
    }

    /// 유예 중인 옛 주소의 문서 요청을 같은 호스트 이름의 새 포트로 보낸다 (FR-HRB-23 ⑧). API 와
    /// WebSocket 은 그대로 서빙한다.
    fn grace_redirect<B>(&self, req: &http::Request<B>, local: SocketAddr) -> Option<Response> {
        if req.method() != Method::GET {
            return None;
        }
        let path = dm_gocompat::neturl::path_unescape(req.uri().path()).ok()?;
        if path != b"/" {
            return None;
        }
        let port = self.moved_from(local)?;
        let host = crate::run::request_host(req);
        let name = split_host_port(&host).map_or(host.as_str(), |(h, _)| h);
        let mut to = format!("http://{}/", dm_shared_dmenv::join_host_port(name, &port));
        if let Some(q) = req.uri().query() {
            to.push('?');
            to.push_str(q);
        }
        Some(crate::serve::redirect(req.method(), &to))
    }

    /// 포트를 옮긴다 (FR-HRB-23·25). 실패하면 옛 바인드가 그대로다.
    async fn move_port(
        self: &Arc<Self>,
        srv: &Server,
        host: &str,
        port: &str,
    ) -> Result<(), (StatusCode, &'static str)> {
        let back = self.lock().grace.remove(port);
        if let Some(old) = back {
            // 유예 중인 옛 포트로 되돌린다 — 그 리스너가 포트를 쥐고 있다.
            old.ln.close().await;
        }
        let addr = dm_shared_dmenv::join_host_port(host, port);
        let ln = match (srv.rebind.listen)(&addr) {
            Ok(ln) => ln,
            Err(e) => {
                infof!(None, "[bind] {addr} 에 리슨하지 못했습니다: {e}");
                return Err((StatusCode::CONFLICT, apierr::CODE_BIND_PORT_IN_USE));
            }
        };
        if let Err(e) = save_bind(&self.home, host, port) {
            drop(ln);
            let st = self.lock();
            let _ = save_bind(&self.home, &st.host, &st.port);
            drop(st);
            warnf!(None, "[bind] 저장 실패: {e}");
            return Err((StatusCode::INTERNAL_SERVER_ERROR, apierr::CODE_SAVE_FAILED));
        }
        let new_ln = self.serve(ln).map_err(|e| {
            warnf!(None, "[bind] {addr} 를 서빙하지 못했습니다: {e}");
            (StatusCode::CONFLICT, apierr::CODE_BIND_PORT_IN_USE)
        })?;
        let (old, old_port, old_id, keep) = {
            let mut st = self.lock();
            let old = st.ln.replace(new_ln);
            let old_id = old.as_ref().map(|l| l.id);
            let old_host = std::mem::replace(&mut st.host, host.to_owned());
            let old_port = std::mem::replace(&mut st.port, port.to_owned());
            // FR-HRB-32: 노출을 끄며 옮기면 노출된 옛 리스너를 유예로 남기지 않는다.
            let keep = !dmenv::is_exposed_host(&old_host) || dmenv::is_exposed_host(host);
            let mut old = old;
            if keep && let Some(ln) = old.take() {
                st.grace
                    .insert(old_port.clone(), GraceEntry { ln, host: old_host });
            }
            (old, old_port, old_id, keep)
        };
        if let Some(ln) = old {
            ln.close().await;
        }
        let payload = dm_webserver_sse::payload(
            "server_moving",
            Some(&BTreeMap::from([("port", port.to_owned())])),
        );
        if let Some(c) = srv.commands() {
            c.broadcast(&payload);
        }
        if keep {
            let b = Arc::clone(self);
            let wait = srv.rebind.grace;
            tokio::spawn(async move {
                tokio::select! {
                    _ = tokio::time::sleep(wait) => {}
                    _ = b.shutdown.cancelled() => return,
                }
                let ln = {
                    let mut st = b.lock();
                    let same =
                        old_id.is_some() && st.grace.get(&old_port).map(|g| g.ln.id) == old_id;
                    if same {
                        st.grace.remove(&old_port)
                    } else {
                        None
                    }
                };
                if let Some(g) = ln {
                    g.ln.close().await;
                }
            });
        }
        Ok(())
    }

    /// 같은 포트를 다른 호스트로 다시 묶는다 (FR-HRB-24 / D-HRB-8). 새 리슨이 실패하면 옛 호스트로
    /// 다시 리슨한다.
    async fn swap_host(
        self: &Arc<Self>,
        srv: &Server,
        host: &str,
    ) -> Result<(), (StatusCode, &'static str)> {
        let (old, old_host, port) = {
            let mut st = self.lock();
            (st.ln.take(), st.host.clone(), st.port.clone())
        };
        if let Some(ln) = old {
            ln.close().await;
        }
        let addr = dm_shared_dmenv::join_host_port(host, &port);
        let mut res = (srv.rebind.listen)(&addr).map_err(|e| e.to_string());
        if let Ok(ln) = res {
            res = match save_bind(&self.home, host, &port) {
                Ok(()) => Ok(ln),
                Err(e) => {
                    drop(ln);
                    let _ = save_bind(&self.home, &old_host, &port);
                    Err(e.to_string())
                }
            };
        }
        let served = res.and_then(|ln| self.serve(ln).map_err(|e| e.to_string()));
        match served {
            Ok(h) => {
                let mut st = self.lock();
                st.ln = Some(h);
                st.host = host.to_owned();
                Ok(())
            }
            Err(e) => {
                warnf!(None, "[bind] {addr} 로 다시 리슨하지 못했습니다: {e}");
                let back_addr = dm_shared_dmenv::join_host_port(&old_host, &port);
                let back = (srv.rebind.listen)(&back_addr).and_then(|ln| self.serve(ln));
                match back {
                    Ok(h) => {
                        self.set_ln(h);
                        Err((StatusCode::CONFLICT, apierr::CODE_BIND_REBIND_FAILED))
                    }
                    Err(be) => {
                        errorf!(
                            None,
                            "[bind] 옛 바인드 {back_addr} 로도 돌아가지 못했습니다: {be}"
                        );
                        Err((
                            StatusCode::INTERNAL_SERVER_ERROR,
                            apierr::CODE_BIND_REBIND_FAILED,
                        ))
                    }
                }
            }
        }
    }

    /// Go `srv.Shutdown(grace)` 다음 `srv.Close()`.
    pub(crate) async fn stop(&self, grace: Duration) {
        self.shutdown.cancel();
        self.tasks.close();
        let _ = tokio::time::timeout(grace, self.tasks.wait()).await;
        self.force.cancel();
        self.tasks.wait().await;
    }
}

/// `server.json` 과 주소 파일을 새 바인드로 쓴다 (FR-HRB-23 ④).
fn save_bind(home: &Path, host: &str, port: &str) -> Result<(), serverconf::Error> {
    serverconf::set_bind(home, host, port)?;
    serverconf::write_addr(home, &dm_shared_dmenv::join_host_port(host, port))
}

/// 리바인드 응답이다 (Go `bindView`).
#[derive(Serialize)]
struct BindView {
    host: String,
    port: String,
    expose: bool,
    url: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    warning: String,
}

fn view_of(host: &str, port: &str) -> BindView {
    BindView {
        host: host.to_owned(),
        port: port.to_owned(),
        expose: dmenv::is_exposed_host(host),
        url: dmenv::base_url(host, port),
        warning: String::new(),
    }
}

/// `GET /api/server/bind` 의 응답이다. Go 의 임베딩을 펼쳐 적는다.
#[derive(Serialize)]
struct BindGetView {
    host: String,
    port: String,
    expose: bool,
    url: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    warning: String,
    local: bool,
    source: BTreeMap<&'static str, &'static str>,
}

/// `POST /api/server/bind` 의 본문이다. 빈 필드는 그대로 둔다는 뜻이다.
#[derive(Deserialize, Default)]
#[serde(default)]
pub(crate) struct BindReq {
    pub(crate) port: Option<i64>,
    pub(crate) expose: Option<bool>,
}

/// 포트가 없거나 범위 안인가다.
pub(crate) fn bind_port_valid(port: Option<i64>) -> bool {
    port.is_none_or(|p| (BIND_PORT_MIN..=BIND_PORT_MAX).contains(&p))
}

/// 지금 바인드와 요청으로 새 바인드를 정한다. expose 를 끄면 노출 주소일 때만 기본 주소로 돌린다.
pub(crate) fn bind_target(cur_host: &str, cur_port: &str, r: &BindReq) -> (String, String) {
    let mut host = cur_host.to_owned();
    let mut port = cur_port.to_owned();
    match r.expose {
        Some(true) => host = EXPOSE_HOST.to_owned(),
        Some(false) if dmenv::is_exposed_host(cur_host) => host = dmenv::DEFAULT_HOST.to_owned(),
        _ => {}
    }
    if let Some(p) = r.port {
        port = p.to_string();
    }
    (host, port)
}

/// 바꾼 까닭의 로그 이름이다 — 포트가 같으면 노출만 바뀌었다.
pub(crate) fn bind_reason(cur_port: &str, new_port: &str) -> &'static str {
    if new_port == cur_port {
        "expose"
    } else {
        "port"
    }
}

/// 바쁨 표시를 풀어 둔다 (Go 의 `defer`).
struct BusyGuard<'a>(&'a Rebinder);

impl Drop for BusyGuard<'_> {
    fn drop(&mut self) {
        self.0.lock().busy = false;
    }
}

impl Server {
    /// GET /api/server/bind — Settings 의 Server 구역이 읽는다 (FR-HRB-40).
    pub(crate) async fn api_server_bind_get(&self, r: &mut Req) -> Response {
        let conf = serverconf::resolve(&serverconf::Inputs {
            home: &self.cfg.data_dir,
            ..serverconf::Inputs::default()
        });
        let (mut host, mut port) = (conf.host.value.clone(), conf.port.value.clone());
        if let Some(b) = self.rebind.current() {
            let st = b.lock();
            host = st.host.clone();
            port = st.port.clone();
        }
        let v = view_of(&host, &port);
        write_json(&BindGetView {
            host: v.host,
            port: v.port,
            expose: v.expose,
            url: v.url,
            warning: v.warning,
            local: is_loopback_addr(&r.remote_addr),
            source: BTreeMap::from([
                ("host", conf.host.source.as_str()),
                ("port", conf.port.source.as_str()),
            ]),
        })
    }

    /// POST /api/server/bind (FR-HRB-20~31).
    pub(crate) async fn api_server_bind(&self, r: &mut Req) -> Response {
        if !is_loopback_addr(&r.remote_addr) {
            return code_fail(
                StatusCode::FORBIDDEN,
                apierr::CODE_BIND_LOCAL_ONLY,
                "bind is local only",
            );
        }
        let Some(b) = self.rebind.current() else {
            return code_fail(
                StatusCode::SERVICE_UNAVAILABLE,
                apierr::CODE_BIND_UNAVAILABLE,
                "rebind unavailable",
            );
        };
        let req: BindReq = match read_json_body(r).await {
            Ok(v) => v,
            Err(res) => return res,
        };
        if !bind_port_valid(req.port) {
            return code_fail(
                StatusCode::BAD_REQUEST,
                apierr::CODE_BIND_PORT_INVALID,
                "port out of range",
            );
        }
        let (cur_host, cur_port) = {
            let mut st = b.lock();
            if st.busy {
                drop(st);
                return code_fail(
                    StatusCode::CONFLICT,
                    apierr::CODE_BIND_BUSY,
                    "rebind in progress",
                );
            }
            st.busy = true;
            (st.host.clone(), st.port.clone())
        };
        let _busy = BusyGuard(&b);
        let (new_host, new_port) = bind_target(&cur_host, &cur_port, &req);
        if new_host == cur_host && new_port == cur_port {
            return write_json(&view_of(&cur_host, &cur_port));
        }
        self.apply_bind(&b, &cur_host, &cur_port, &new_host, &new_port)
            .await
    }

    /// 새 바인드로 옮기고 답한다. 부르는 쪽이 바쁨 표시를 쥔 채로 부른다.
    async fn apply_bind(
        &self,
        b: &Arc<Rebinder>,
        cur_host: &str,
        cur_port: &str,
        new_host: &str,
        new_port: &str,
    ) -> Response {
        let res = if new_port != cur_port {
            b.move_port(self, new_host, new_port).await
        } else {
            b.swap_host(self, new_host).await
        };
        if let Err((status, code)) = res {
            return code_fail(status, code, "rebind failed");
        }
        if dmenv::is_exposed_host(cur_host) && !dmenv::is_exposed_host(new_host) {
            // FR-HRB-32: expose 를 껐으면 노출된 유예 리스너와 같은 망에서 맺은 연결을 거둔다.
            b.revoke_exposure().await;
        }
        let mut view = view_of(new_host, new_port);
        infof!(
            None,
            "[bind] {} → {} ({})",
            dm_shared_dmenv::join_host_port(cur_host, cur_port),
            dm_shared_dmenv::join_host_port(new_host, new_port),
            bind_reason(cur_port, new_port)
        );
        if view.expose && !dmenv::is_exposed_host(cur_host) {
            view.warning = EXPOSE_WARNING.to_owned();
            warnf!(None, "[bind] {EXPOSE_WARNING}");
        }
        write_json(&view)
    }
}
