use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use otter_gocompat::json;
use otter_shared_edge::{
    BoxStream, CODE_NOT_EDGE, CallError, Edge, Handler, Identity, Target, accept_upgrade,
    client_fingerprint,
};
use otter_shared_termtext::{FP_SHORT, cut};
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::runtime::Handle;
use tokio::sync::{Notify, mpsc};
use tokio_util::sync::CancellationToken;

use crate::error::{ErrorKind, MeshError};
use crate::frame::{FRAME_HELLO, FRAME_INVITE, FRAME_NET, FRAME_PING, Frame, encode, public_key};
use crate::invite::{Invite, InviteState};
use crate::net::{MAX_NODES, NetState, broadcast_locked};

/// 간선 연결의 노드 포트 경로, PROTO 는 그 Upgrade 프로토콜 이름이다 (FR-EGM-2).
pub const PATH: &str = "/edge/v1/link";
pub const PROTO: &str = "dmlink1";
/// 프레임 한 줄의 상한이다 (NFR-EGM-2).
pub(crate) const MAX_LINE: usize = 1 << 20;
/// 연결 하나의 보낼 줄 상한이다 (NFR-EGM-2).
const OUT_QUEUE: usize = 1024;
pub(crate) use otter_shared_cadence::{
    MESH_REDIAL_MAX as REDIAL_MAX, MESH_REDIAL_MIN as REDIAL_MIN,
};
/// hello 를 다 쓰기까지 간선 하나를 기다리는 상한이다 (FR-EGM-23). 노드가 바뀐 직접 정보를 모든
/// 간선에 알릴 때도 이 값을 쓴다.
pub const HELLO_WAIT: Duration = Duration::from_secs(2);
use otter_shared_cadence::MESH_PING_EVERY as PING_EVERY;
const DEAD_AFTER: Duration = Duration::from_secs(45);
const PING_LINE: &[u8] = b"{\"t\":\"ping\"}\n";
const CONTEXT_CANCELED: &str = "context canceled";
const STATUS_NOT_FOUND: u16 = 404;

/// 직접 정보다 (FR-EGM-20). `port` 가 0 이면 주소를 싣지 않은 것이다.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "edgemesh.Hello")]
pub struct Hello {
    pub name: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub addr: String,
    #[serde(skip_serializing_if = "is_zero")]
    pub port: i64,
}

fn is_zero(p: &i64) -> bool {
    *p == 0
}

/// 간선 연결 위에 얹힌 계층이다 (FR-EGM-5). 간선 계층은 자기 잠금 밖에서만 부른다.
pub trait Upper: Send + Sync {
    /// 간선 계층이 모르는 종류의 프레임이다. from 은 받은 연결의 상대다.
    fn frame(&self, from: &str, fr: Frame);
    /// 새 연결이다. 위층은 그 연결로 처음 보낼 줄을 [`Mesh::open`] 으로 넣어야 한다. 막혀도 되는
    /// 스레드에서 불린다.
    fn linked(&self, fp: &str);
    /// 망 그림(연결·온라인·이름)이 바뀌었을 수 있다는 알림이다.
    fn changed(&self);
}

pub type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send>>;
pub type NowFn = Arc<dyn Fn() -> OffsetDateTime + Send + Sync>;
/// 간선 상대에게 간선 연결을 연다 (Go `Dial`).
pub type DialFn = Arc<dyn Fn(Target) -> BoxFuture<Result<Conn, CallError>> + Send + Sync>;

/// 상대의 hello 를 받는다: (상대 지문, hello, 출발지 IP).
pub type OnHelloFn = Arc<dyn Fn(&str, Hello, &str) + Send + Sync>;
/// 간선 하나에 대한 알림이다.
pub type FpFn = Arc<dyn Fn(&str) + Send + Sync>;

/// 간선 연결 하나다. `remote_host` 는 상대의 출발지 IP 다(모르면 빈 값).
pub struct Conn {
    pub io: BoxStream,
    pub remote_host: String,
}

impl Conn {
    pub fn new(io: BoxStream) -> Self {
        Self {
            io,
            remote_host: String::new(),
        }
    }
}

/// 간선 계층을 세우는 값이다.
#[derive(Clone)]
pub struct Options {
    pub identity: Identity,
    /// 이 노드의 지금 이름이다.
    pub name: Option<Arc<dyn Fn() -> String + Send + Sync>>,
    /// 연결이 열릴 때 보낼 직접 정보다. `None` 이면 이름만 싣는다.
    pub hello: Option<Arc<dyn Fn() -> Hello + Send + Sync>>,
    /// 지금의 간선이다. 주소를 아는 간선마다 연결을 건다.
    pub edges: Option<Arc<dyn Fn() -> Vec<Edge> + Send + Sync>>,
    /// `None` 이면 걸지 않는다.
    pub dial: Option<DialFn>,
    /// 상대의 hello 다. 셋째 인자는 그 연결의 출발지 IP 다(모르면 빈 값).
    pub on_hello: Option<OnHelloFn>,
    /// 상대에게 hello 를 다 썼다는 알림이다.
    pub on_hello_sent: Option<FpFn>,
    /// 이 노드에게 온, 열린 간선 초대다.
    pub on_invite: Option<Arc<dyn Fn(Invite) + Send + Sync>>,
    /// 상대가 이 노드를 간선이 아니라고(edge_not_edge) 답했다는 알림이다.
    pub on_not_edge: Option<FpFn>,
    /// 망 그림이나 옛 판 표시가 바뀌었다는 알림이다. 여러 번을 한 번으로 묶는다.
    pub on_changed: Option<Arc<dyn Fn() + Send + Sync>>,
    pub now: Option<NowFn>,
}

impl Options {
    pub fn new(identity: Identity) -> Self {
        Self {
            identity,
            name: None,
            hello: None,
            edges: None,
            dial: None,
            on_hello: None,
            on_hello_sent: None,
            on_invite: None,
            on_not_edge: None,
            on_changed: None,
            now: None,
        }
    }
}

type SentFn = Box<dyn FnOnce() + Send>;

struct OutItem {
    line: Vec<u8>,
    sent: Option<SentFn>,
}

/// 간선 상대 하나와의 간선 연결이다.
pub(crate) struct Link {
    fp: String,
    /// 이 연결을 건 노드의 지문이다. 중복 연결 정리에 쓴다.
    dialer: String,
    remote: String,
    out: mpsc::Sender<OutItem>,
    done: CancellationToken,
    /// 연결이 열릴 때 보낸 hello 를 다 쓰면 닫힌다.
    hello_done: CancellationToken,
    last_seen: AtomicI64,
    /// 연결이 붙은 시각이다. 끊길 때 다시 걸기 간격을 정한다 (FR-ATF-77).
    since: OffsetDateTime,
    /// 위층이 첫 줄을 넣었는가다 (FR-EGM-6). Mesh 의 잠금 안에서 바꾼다.
    open: AtomicBool,
}

impl Link {
    fn close(&self) {
        self.done.cancel();
    }

    pub(crate) fn is_open(&self) -> bool {
        self.open.load(Ordering::Relaxed)
    }

    /// 줄 하나를 보낼 줄에 넣는다. 가득 차면 연결을 끊는다.
    pub(crate) fn send(&self, line: Vec<u8>, sent: Option<SentFn>) {
        if self.done.is_cancelled() {
            return;
        }
        if let Err(mpsc::error::TrySendError::Full(_)) = self.out.try_send(OutItem { line, sent }) {
            self.close();
        }
    }
}

/// 간선 하나의 걸기 상태다. 자동 재연결과 notify 가 함께 쓴다 (FR-ATF-50).
pub(crate) struct DialState {
    pub next: Option<OffsetDateTime>,
    pub wait: Duration,
    pub running: bool,
    /// 지금 걸기가 끝나면 닫힌다. err 는 마지막 걸기의 결과다.
    pub done: Option<CancellationToken>,
    pub err: Option<MeshError>,
}

type SharedDial = Arc<Mutex<DialState>>;

impl DialState {
    /// 걸기 실패를 센다: 다음 걸기를 지금 간격 뒤로 미루고 간격을 두 배로 늘린다.
    fn fail(&mut self, now: OffsetDateTime) {
        self.next = Some(now + self.wait);
        self.wait = (self.wait * 2).min(REDIAL_MAX);
    }

    fn start(&mut self) -> CancellationToken {
        self.running = true;
        let done = CancellationToken::new();
        self.done = Some(done.clone());
        done
    }
}

fn lock_dial(d: &SharedDial) -> MutexGuard<'_, DialState> {
    d.lock().unwrap_or_else(|e| e.into_inner())
}

pub(crate) struct State {
    pub upper: Option<Arc<dyn Upper>>,
    pub links: HashMap<String, Arc<Link>>,
    pub dialing: HashMap<String, SharedDial>,
    pub outdated: HashSet<String>,
    pub closed: bool,
    pub ping_every: Duration,
    pub dead_after: Duration,
    pub max_nodes: usize,
    pub net: NetState,
    pub inv: InviteState,
}

pub(crate) struct Inner {
    pub id: Identity,
    pub key: String,
    opts: Options,
    now: NowFn,
    rt: Handle,
    pokes: Notify,
    /// [`Mesh::run`] 이 마감을 다시 잡게 깨운다 — 간선·연결·걸기 상태가 바뀌었다.
    wake: Notify,
    /// [`Mesh::run`] 이 깨어난 횟수다 (시험용 깨어남 카운터).
    ticks: AtomicU64,
    done: CancellationToken,
    st: Mutex<State>,
}

/// 이 노드의 간선 계층이다. 복제하면 같은 계층을 가리킨다.
#[derive(Clone)]
pub struct Mesh {
    pub(crate) inner: Arc<Inner>,
}

impl Inner {
    pub(crate) fn lock(&self) -> MutexGuard<'_, State> {
        self.st.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub(crate) fn now(&self) -> OffsetDateTime {
        (self.now)()
    }

    pub(crate) fn poke(&self) {
        self.pokes.notify_one();
    }

    pub(crate) fn name(&self) -> String {
        self.opts.name.as_ref().map(|f| f()).unwrap_or_default()
    }

    fn hello(&self) -> Hello {
        match &self.opts.hello {
            Some(f) => f(),
            None => Hello {
                name: self.name(),
                ..Hello::default()
            },
        }
    }

    fn hello_sent(&self, fp: &str) {
        if let Some(f) = &self.opts.on_hello_sent {
            f(fp);
        }
    }
}

fn hello_line(h: &Hello) -> Vec<u8> {
    let raw = json::marshal(h).unwrap_or_default();
    encode(&Frame {
        t: FRAME_HELLO.to_string(),
        b: json::RawMessage(raw),
        s: String::new(),
    })
}

fn unix_nanos(t: OffsetDateTime) -> i64 {
    i64::try_from(t.unix_timestamp_nanos()).unwrap_or(i64::MAX)
}

/// Go `net.SplitHostPort(c.RemoteAddr().String())` 의 host 다.
pub(crate) fn remote_host(a: SocketAddr) -> String {
    match a {
        SocketAddr::V6(v6) => match v6.ip().to_ipv4_mapped() {
            Some(v4) => v4.to_string(),
            None => v6.ip().to_string(),
        },
        SocketAddr::V4(v4) => v4.ip().to_string(),
    }
}

/// 한 줄을 읽는다(줄바꿈과 그 앞 `\r` 은 뺀다). 끝이거나 줄이 상한을 넘으면 거짓이다 (Go
/// `bufio.Scanner`).
async fn read_line<R: AsyncBufRead + Unpin>(r: &mut R, buf: &mut Vec<u8>) -> bool {
    buf.clear();
    let n = match (&mut *r).take(MAX_LINE as u64).read_until(b'\n', buf).await {
        Ok(n) => n,
        Err(_) => return false,
    };
    if n == 0 {
        return false;
    }
    if buf.last() == Some(&b'\n') {
        buf.pop();
    } else if n >= MAX_LINE {
        return false;
    }
    if buf.last() == Some(&b'\r') {
        buf.pop();
    }
    true
}

async fn write_loop(
    l: Arc<Link>,
    mut rx: mpsc::Receiver<OutItem>,
    mut wr: tokio::io::WriteHalf<BoxStream>,
) {
    loop {
        let it = tokio::select! {
            biased;
            _ = l.done.cancelled() => return,
            it = rx.recv() => it,
        };
        let Some(it) = it else { return };
        let ok = tokio::select! {
            _ = l.done.cancelled() => return,
            r = async {
                wr.write_all(&it.line).await?;
                wr.flush().await
            } => r.is_ok(),
        };
        if !ok {
            l.close();
            return;
        }
        if let Some(f) = it.sent {
            f();
        }
    }
}

async fn wait_done(cancel: &CancellationToken, done: &CancellationToken) -> Result<(), MeshError> {
    tokio::select! {
        _ = done.cancelled() => Ok(()),
        _ = tokio::time::sleep(HELLO_WAIT) => Err(ErrorKind::Unreachable.into()),
        _ = cancel.cancelled() => Err(ErrorKind::Unreachable.into()),
    }
}

impl Mesh {
    /// 간선 계층을 세운다. 연결 유지는 [`Mesh::run`] 이 한다. tokio 런타임 안에서 부른다.
    pub fn new(o: Options) -> Mesh {
        let now: NowFn = o
            .now
            .clone()
            .unwrap_or_else(|| Arc::new(OffsetDateTime::now_utc));
        let net = NetState::new(now());
        let inner = Arc::new(Inner {
            key: public_key(&o.identity),
            id: o.identity.clone(),
            opts: o,
            now,
            rt: Handle::current(),
            pokes: Notify::new(),
            wake: Notify::new(),
            ticks: AtomicU64::new(0),
            done: CancellationToken::new(),
            st: Mutex::new(State {
                upper: None,
                links: HashMap::new(),
                dialing: HashMap::new(),
                outdated: HashSet::new(),
                closed: false,
                ping_every: PING_EVERY,
                dead_after: DEAD_AFTER,
                max_nodes: MAX_NODES,
                net,
                inv: InviteState::default(),
            }),
        });
        {
            let mut st = inner.lock();
            inner.announce_locked(&mut st, None);
        }
        let m = Mesh { inner };
        let n = m.inner.clone();
        m.inner.rt.spawn(async move { n.notify_loop().await });
        m
    }

    /// 이 노드의 지문이다.
    pub fn node(&self) -> &str {
        &self.inner.id.fingerprint
    }

    /// 위층을 싣는다. 실은 뒤에 열린 연결부터 위층의 첫 줄을 기다린다.
    pub fn set_upper(&self, u: Arc<dyn Upper>) {
        self.inner.lock().upper = Some(u);
    }

    /// 모든 연결을 닫는다. 그 뒤에는 연결을 받지 않는다.
    pub fn close(&self) {
        let links: Vec<Arc<Link>> = {
            let mut st = self.inner.lock();
            if st.closed {
                return;
            }
            st.closed = true;
            self.inner.done.cancel();
            st.links.drain().map(|(_, l)| l).collect()
        };
        for l in links {
            l.close();
        }
    }

    /// 노드 포트의 간선 연결 경로다. 판정은 노드 포트가 이미 했다 — 간선만 닿는다. 출발지 IP 는
    /// 요청 extensions 의 `SocketAddr` 에서 읽는다(없으면 빈 값).
    pub fn handler(&self) -> Handler {
        let m = self.clone();
        Arc::new(move |mut req| {
            let m = m.clone();
            Box::pin(async move {
                let fp = client_fingerprint(&req).to_string();
                let remote = req
                    .extensions()
                    .get::<SocketAddr>()
                    .map(|a| remote_host(*a))
                    .unwrap_or_default();
                let (resp, pending) = accept_upgrade(&mut req, PROTO);
                if let Some(p) = pending {
                    tokio::spawn(async move {
                        if let Ok(io) = p.conn().await {
                            m.attach(
                                &fp,
                                Conn {
                                    io: Box::new(io),
                                    remote_host: remote,
                                },
                                false,
                            );
                        }
                    });
                }
                resp
            })
        })
    }

    /// 상대 fp 와의 연결을 붙인다. 같은 상대와 이미 연결이 있으면 하나만 남긴다: 지문이 작은 쪽이
    /// 건 연결을 남기고, 같으면 새 연결을 남긴다 (FR-EGM-3). 새 연결에는 hello, 자기 net, 아는
    /// 노드들의 net 을 먼저 넣고 위층을 부른다 (FR-EGM-6).
    pub fn attach(&self, fp: &str, conn: Conn, dialed: bool) {
        self.inner.attach(fp, conn, dialed);
    }

    /// 위층이 연결 fp 로 처음 보낼 줄을 넣고, 그 연결을 위층의 broadcast 에 연다 (FR-EGM-6).
    /// 위층은 자기 잠금 안에서 불러, 그 사이에 다른 줄이 끼지 않게 한다.
    pub fn open(&self, fp: &str, lines: Vec<Vec<u8>>) {
        let mut st = self.inner.lock();
        let Some(l) = st.links.get(fp).cloned() else {
            return;
        };
        if l.is_open() {
            return;
        }
        for line in lines {
            l.send(line, None);
        }
        l.open.store(true, Ordering::Relaxed);
        self.inner.announce_locked(&mut st, None);
        self.inner.topology_locked(&mut st);
    }

    /// 위층의 프레임을 skip 을 뺀 모든 열린 연결로 보낸다.
    pub fn broadcast(&self, fr: &Frame, skip: &str) {
        let line = encode(fr);
        let st = self.inner.lock();
        for l in st.links.values() {
            if l.fp != skip && l.is_open() {
                l.send(line.clone(), None);
            }
        }
    }

    /// 위층의 프레임을 연결 fp 하나로 보낸다. 열린 연결이 없으면 버린다.
    pub fn send(&self, fp: &str, fr: &Frame) {
        let st = self.inner.lock();
        if let Some(l) = st.links.get(fp)
            && l.is_open()
        {
            l.send(encode(fr), None);
        }
    }

    /// 연결을 유지한다: 간선마다 연결을 걸고, ping 을 보내고, 조용한 연결과 지워진 간선의 연결을
    /// 끊는다 (FR-EGM-3). 주기 틱이 없다 — 가장 이른 마감(다음 ping·다음 다시 걸기)까지 자고,
    /// 간선·연결·걸기 상태가 바뀌면 깬다. 간선도 연결도 없으면 무기한 잔다 (PERF M4 D4). cancel 이
    /// 끝나거나 close 하면 돌아온다.
    pub async fn run(&self, cancel: CancellationToken) {
        let inner = &self.inner;
        let mut next_ping: Option<tokio::time::Instant> = None;
        loop {
            let (linked, ping_every) = {
                let st = inner.lock();
                (!st.links.is_empty(), st.ping_every)
            };
            let at = tokio::time::Instant::now();
            next_ping = match next_ping {
                _ if !linked => None,
                None => Some(at + ping_every),
                p => p,
            };
            let redial = inner.next_dial_in(inner.now()).map(|d| at + d);
            let deadline = match (next_ping, redial) {
                (Some(p), Some(r)) => Some(p.min(r)),
                (p, r) => p.or(r),
            };
            tokio::select! {
                _ = cancel.cancelled() => return,
                _ = inner.done.cancelled() => return,
                _ = inner.wake.notified() => {}
                _ = sleep_until(deadline) => {}
            }
            inner.ticks.fetch_add(1, Ordering::Relaxed);
            let now = inner.now();
            if next_ping.is_some_and(|p| tokio::time::Instant::now() >= p) {
                next_ping = Some(tokio::time::Instant::now() + ping_every);
                inner.ping_all(now);
            }
            inner.dial_edges(&cancel, now);
        }
    }

    /// 간선 목록이 바뀌었다는 알림이다. 연결 유지가 걸 간선을 다시 본다.
    pub fn edges_changed(&self) {
        self.inner.wake.notify_one();
    }

    /// 간선 fp 의 연결을 바로 닫는다. 간선을 지운 뒤 부른다. 연결이 없으면 아무것도 하지 않는다.
    pub fn drop_link(&self, fp: &str) {
        let l = {
            let mut st = self.inner.lock();
            st.outdated.remove(fp);
            st.links.get(fp).cloned()
        };
        if let Some(l) = l {
            self.inner.detach(&l);
        }
    }

    /// 간선 fp 를 옛 판으로 표시한다 (FR-EGM-7). 연결이 맺어지면 지워진다.
    pub fn mark_outdated(&self, fp: &str) {
        self.inner.mark_outdated(fp);
    }

    /// 간선 fp 가 옛 판으로 표시되었는가다.
    pub fn outdated(&self, fp: &str) -> bool {
        self.inner.lock().outdated.contains(fp)
    }

    /// 간선 fp 와의 연결이 열려 있는가다.
    pub fn linked(&self, fp: &str) -> bool {
        self.inner.lock().links.contains_key(fp)
    }

    /// 열린 연결마다 h 를 한 번 보내고, 다 쓰거나 간선마다 wait 이 지날 때까지 기다린다
    /// (FR-EGM-23). 다시 시도하지 않는다.
    pub async fn hello_all(&self, h: &Hello, wait: Duration) {
        let line = hello_line(h);
        let mut waits = Vec::new();
        {
            let st = self.inner.lock();
            for (fp, l) in &st.links {
                let done = CancellationToken::new();
                waits.push(done.clone());
                // 기록을 먼저 하고 신호를 닫는다 — hello_all 이 돌아오면 on_hello_sent 도 끝나
                // 있다.
                let (inner, fp) = (self.inner.clone(), fp.clone());
                l.send(
                    line.clone(),
                    Some(Box::new(move || {
                        inner.hello_sent(&fp);
                        done.cancel();
                    })),
                );
            }
        }
        let deadline = tokio::time::sleep(wait);
        tokio::pin!(deadline);
        for done in waits {
            tokio::select! {
                _ = done.cancelled() => {}
                _ = &mut deadline => return,
            }
        }
    }

    /// 간선 fp 에게 지금 hello 를 보낸다 (FR-EGM-26). 연결이 열려 있으면 그 연결로 보내고, 없으면
    /// 다시 걸기 간격을 무시하고 바로 건다 — 연결이 열리면 hello 가 간다.
    pub async fn notify(&self, cancel: &CancellationToken, fp: &str) -> Result<(), MeshError> {
        let inner = &self.inner;
        let existing = inner.lock().links.get(fp).cloned();
        if let Some(l) = existing {
            let done = CancellationToken::new();
            let (i2, fp2, d2) = (inner.clone(), fp.to_string(), done.clone());
            l.send(
                hello_line(&inner.hello()),
                Some(Box::new(move || {
                    d2.cancel();
                    i2.hello_sent(&fp2);
                })),
            );
            return wait_done(cancel, &done).await;
        }
        let Some(e) = inner.edges().remove(fp) else {
            return Err(ErrorKind::NotEdge.into());
        };
        if e.addr.is_empty() {
            return Err(ErrorKind::AddrUnknown.into());
        }
        if inner.opts.dial.is_none() {
            return Err(ErrorKind::Unreachable.into());
        }
        // 걸고 있는 중이면 그 걸기를 기다린다 — 같은 간선에 두 번 걸지 않는다 (FR-ATF-50).
        let (d, running) = {
            let mut st = inner.lock();
            let d = dial_state_locked(&mut st, fp);
            let running = {
                let mut g = lock_dial(&d);
                if g.running {
                    g.done.clone()
                } else {
                    g.start();
                    None
                }
            };
            (d, running)
        };
        let l = match running {
            Some(done) => {
                tokio::select! {
                    _ = done.cancelled() => {}
                    _ = cancel.cancelled() => return Err(ErrorKind::Unreachable.into()),
                }
                let st = inner.lock();
                let err = lock_dial(&d).err.clone();
                let l = st.links.get(fp).cloned();
                if let (None, Some(err)) = (&l, err) {
                    return Err(err);
                }
                l
            }
            None => {
                // 중복으로 버려졌으면 먼저 있던 연결로 hello 가 간다.
                if let Err(err) = inner.redial(cancel.clone(), e, d).await
                    && err.kind() != ErrorKind::Duplicate
                {
                    return Err(err);
                }
                inner.lock().links.get(fp).cloned()
            }
        };
        let Some(l) = l else {
            return Err(ErrorKind::Unreachable.into());
        };
        wait_done(cancel, &l.hello_done).await
    }
}

/// `at` 까지 잔다. `None` 이면 깨우는 다른 갈래가 올 때까지 잔다.
async fn sleep_until(at: Option<tokio::time::Instant>) {
    match at {
        Some(at) => tokio::time::sleep_until(at).await,
        None => std::future::pending().await,
    }
}

fn dial_state_locked(st: &mut State, fp: &str) -> SharedDial {
    st.dialing
        .entry(fp.to_string())
        .or_insert_with(|| {
            Arc::new(Mutex::new(DialState {
                next: None,
                wait: REDIAL_MIN,
                running: false,
                done: None,
                err: None,
            }))
        })
        .clone()
}

impl Inner {
    async fn notify_loop(self: Arc<Self>) {
        loop {
            tokio::select! {
                _ = self.done.cancelled() => return,
                _ = self.pokes.notified() => {}
            }
            let up = self.lock().upper.clone();
            if let Some(up) = up {
                up.changed();
            }
            if let Some(f) = &self.opts.on_changed {
                f();
            }
        }
    }

    /// attach 이고, 연결을 붙였는가를 돌려준다.
    pub(crate) fn attach(self: &Arc<Self>, fp: &str, conn: Conn, dialed: bool) -> bool {
        let (tx, rx) = mpsc::channel(OUT_QUEUE);
        let since = self.now();
        let l = Arc::new(Link {
            fp: fp.to_string(),
            dialer: if dialed {
                self.id.fingerprint.clone()
            } else {
                fp.to_string()
            },
            remote: conn.remote_host,
            out: tx,
            done: CancellationToken::new(),
            hello_done: CancellationToken::new(),
            last_seen: AtomicI64::new(unix_nanos(since)),
            since,
            open: AtomicBool::new(false),
        });
        let h = self.hello();
        let mut st = self.lock();
        if st.closed || fp.is_empty() || fp == self.id.fingerprint {
            return false;
        }
        let mut replaced = None;
        if let Some(old) = st.links.get(fp) {
            if !self.prefer_new(old, &l) {
                return false;
            }
            replaced = Some(old.clone());
        }
        st.links.insert(fp.to_string(), l.clone());
        st.outdated.remove(fp);
        let up = st.upper.clone();
        l.open.store(up.is_none(), Ordering::Relaxed);
        let (rd, wr) = tokio::io::split(conn.io);
        self.rt.spawn(write_loop(l.clone(), rx, wr));
        let (inner, fp2, hd) = (self.clone(), fp.to_string(), l.hello_done.clone());
        l.send(
            hello_line(&h),
            Some(Box::new(move || {
                hd.cancel();
                inner.hello_sent(&fp2);
            })),
        );
        self.announce_locked(&mut st, Some(&l));
        l.send(encode(&st.net.own), None);
        for r in st.net.nodes.values() {
            l.send(encode(&r.raw), None);
        }
        self.topology_locked(&mut st);
        drop(st);
        self.wake.notify_one();
        if let Some(old) = replaced {
            old.close();
        }
        if let Some(up) = up {
            let fp = fp.to_string();
            self.rt.spawn_blocking(move || up.linked(&fp));
        }
        self.rt.spawn(self.clone().read_loop(l, rd));
        true
    }

    fn prefer_new(&self, old: &Link, l: &Link) -> bool {
        let lo = std::cmp::min(self.id.fingerprint.as_str(), l.fp.as_str());
        old.dialer != lo || l.dialer == lo
    }

    pub(crate) fn detach(&self, l: &Arc<Link>) {
        l.close();
        let mut st = self.lock();
        match st.links.get(&l.fp) {
            Some(cur) if Arc::ptr_eq(cur, l) => {}
            _ => return,
        }
        st.links.remove(&l.fp);
        // 생존 판정 시간(dead_after)을 버틴 연결만 걸기 간격을 처음 값으로 되돌린다. 그보다 일찍
        // 끊기면 걸기 실패로 센다 (ATTIC_FIX_SRS FR-ATF-77 · AT-MESH-1).
        if let Some(d) = st.dialing.get(&l.fp) {
            let now = self.now();
            let mut g = lock_dial(d);
            if now - l.since >= st.dead_after {
                g.wait = REDIAL_MIN;
            } else {
                g.fail(now);
            }
        }
        if !st.closed {
            self.announce_locked(&mut st, None);
            self.topology_locked(&mut st);
        }
        drop(st);
        self.wake.notify_one();
    }

    async fn read_loop(self: Arc<Self>, l: Arc<Link>, rd: tokio::io::ReadHalf<BoxStream>) {
        let mut r = BufReader::new(rd);
        let mut buf = Vec::new();
        loop {
            let ok = tokio::select! {
                _ = l.done.cancelled() => false,
                ok = read_line(&mut r, &mut buf) => ok,
            };
            if !ok {
                break;
            }
            l.last_seen.store(unix_nanos(self.now()), Ordering::Relaxed);
            let Ok(fr) = json::unmarshal::<Frame>(&buf) else {
                break;
            };
            self.handle(&l, fr);
        }
        self.detach(&l);
    }

    fn handle(&self, from: &Arc<Link>, fr: Frame) {
        match fr.t.as_str() {
            FRAME_PING => {}
            FRAME_HELLO => {
                let Some(f) = &self.opts.on_hello else { return };
                if let Ok(h) = json::unmarshal::<Hello>(&fr.b.0) {
                    f(&from.fp, h, &from.remote);
                }
            }
            FRAME_NET => {
                let mut st = self.lock();
                if self.accept_net_locked(&mut st, &fr) {
                    broadcast_locked(&st, &encode(&fr), Some(from));
                    self.topology_locked(&mut st);
                }
            }
            FRAME_INVITE => {
                let inv = {
                    let mut st = self.lock();
                    let (inv, ok) = self.accept_invite_locked(&mut st, &fr);
                    if ok {
                        broadcast_locked(&st, &encode(&fr), Some(from));
                    }
                    inv
                };
                if let (Some(inv), Some(f)) = (inv, &self.opts.on_invite) {
                    f(inv);
                }
            }
            _ => {
                let up = self.lock().upper.clone();
                if let Some(up) = up {
                    up.frame(&from.fp, fr);
                }
            }
        }
    }

    pub(crate) fn ping_all(&self, now: OffsetDateTime) {
        let (dead, dead_after) = {
            let st = self.lock();
            let now_ns = unix_nanos(now);
            let mut dead = Vec::new();
            for l in st.links.values() {
                let quiet = now_ns.saturating_sub(l.last_seen.load(Ordering::Relaxed));
                if quiet > i64::try_from(st.dead_after.as_nanos()).unwrap_or(i64::MAX) {
                    dead.push(l.clone());
                    continue;
                }
                l.send(PING_LINE.to_vec(), None);
            }
            (dead, st.dead_after)
        };
        for l in dead {
            otter_shared_otterlog::infof!(
                None,
                "edge link: {} 에서 {} 동안 받은 것이 없어 끊는다",
                cut(&l.fp, FP_SHORT),
                otter_gocompat::time::format_std_duration(dead_after)
            );
            self.detach(&l);
        }
    }

    fn edges(&self) -> HashMap<String, Edge> {
        match &self.opts.edges {
            Some(f) => f()
                .into_iter()
                .map(|e| (e.fingerprint.clone(), e))
                .collect(),
            None => HashMap::new(),
        }
    }

    /// [`Inner::dial_edges`] 가 다음에 할 일까지 남은 시간이다: 지워진 간선의 연결이 있거나 걸 때가
    /// 된 간선이 있으면 0, 다시 걸기 간격을 기다리는 간선만 있으면 그 가장 이른 끝, 할 일이 없으면
    /// `None` 이다. 걸고 있는 간선은 걸기가 끝날 때 깨우므로 세지 않는다.
    fn next_dial_in(&self, now: OffsetDateTime) -> Option<Duration> {
        if self.opts.edges.is_none() || self.opts.dial.is_none() {
            return None;
        }
        let paired = self.edges();
        let st = self.lock();
        if st.links.keys().any(|fp| !paired.contains_key(fp)) {
            return Some(Duration::ZERO);
        }
        let mut best: Option<Duration> = None;
        for (fp, e) in &paired {
            if st.links.contains_key(fp) || e.addr.is_empty() {
                continue;
            }
            let wait = match st.dialing.get(fp) {
                None => Duration::ZERO,
                Some(d) => {
                    let g = lock_dial(d);
                    if g.running {
                        continue;
                    }
                    g.next
                        .filter(|n| now < *n)
                        .and_then(|n| Duration::try_from(n - now).ok())
                        .unwrap_or(Duration::ZERO)
                }
            };
            best = Some(best.map_or(wait, |b| b.min(wait)));
        }
        best
    }

    pub(crate) fn dial_edges(self: &Arc<Self>, cancel: &CancellationToken, now: OffsetDateTime) {
        if self.opts.edges.is_none() || self.opts.dial.is_none() {
            return;
        }
        let paired = self.edges();
        let stale: Vec<Arc<Link>> = {
            let mut st = self.lock();
            let stale = st
                .links
                .iter()
                .filter(|(fp, _)| !paired.contains_key(*fp))
                .map(|(_, l)| l.clone())
                .collect();
            st.dialing.retain(|fp, _| paired.contains_key(fp));
            for (fp, e) in &paired {
                // 주소를 모르는 간선(상대의 노드 포트가 닫혀 있었음)에는 걸지 않는다 — 상대가 건다.
                if st.links.contains_key(fp) || e.addr.is_empty() {
                    continue;
                }
                let d = dial_state_locked(&mut st, fp);
                {
                    let mut g = lock_dial(&d);
                    if g.running || g.next.is_some_and(|n| now < n) {
                        continue;
                    }
                    g.start();
                }
                let (inner, cancel, e) = (self.clone(), cancel.clone(), e.clone());
                self.rt.spawn(async move {
                    let _ = inner.redial(cancel, e, d).await;
                });
            }
            stale
        };
        for l in stale {
            self.detach(&l);
        }
    }

    async fn redial(
        self: &Arc<Self>,
        cancel: CancellationToken,
        e: Edge,
        d: SharedDial,
    ) -> Result<(), MeshError> {
        let r = self.dial(&cancel, &e).await;
        let _st = self.lock();
        let mut g = lock_dial(&d);
        g.running = false;
        g.err = r.as_ref().err().cloned();
        // 성공해도 간격을 되돌리지 않는다 — 연결이 dead_after 를 버티고 끊길 때 detach 가 되돌린다.
        //	이전: TCP·TLS 성공만으로 1초로 되돌려, 붙자마자 끊기는 상대에 1초마다 걸었다
        if r.is_err() {
            g.fail(self.now());
        }
        if let Some(done) = &g.done {
            done.cancel();
        }
        self.wake.notify_one();
        r
    }

    /// 간선 e 에 걸어 붙인다. 404 면 옛 판으로 표시하고(FR-EGM-7), edge_not_edge 면 간선을
    /// 지우라고 알린다.
    async fn dial(self: &Arc<Self>, cancel: &CancellationToken, e: &Edge) -> Result<(), MeshError> {
        let Some(dial) = self.opts.dial.clone() else {
            return Err(ErrorKind::Unreachable.into());
        };
        let t = Target {
            addr: e.addr.clone(),
            port: e.port,
            fingerprint: e.fingerprint.clone(),
        };
        let r = tokio::select! {
            _ = cancel.cancelled() => Err(CallError::Unreachable(CONTEXT_CANCELED.to_string())),
            r = dial(t) => r,
        };
        match r {
            Ok(conn) => {
                if self.attach(&e.fingerprint, conn, true) {
                    Ok(())
                } else {
                    Err(ErrorKind::Duplicate.into())
                }
            }
            Err(CallError::Remote(re)) if re.code == CODE_NOT_EDGE => {
                // 지문을 고정한 상대의 서버가 낸 답이라 믿는다 (EDGE_PAIRING_SRS D-EPR-3).
                otter_shared_otterlog::infof!(
                    None,
                    "edge link: {} 가 이 노드를 간선으로 알지 않는다 — 간선을 지운다",
                    cut(&e.fingerprint, FP_SHORT)
                );
                if let Some(f) = &self.opts.on_not_edge {
                    f(&e.fingerprint);
                }
                Err(MeshError::with_call(
                    ErrorKind::NotEdge,
                    CallError::Remote(re),
                ))
            }
            Err(CallError::Remote(re)) if re.status == STATUS_NOT_FOUND => {
                self.mark_outdated(&e.fingerprint);
                Err(ErrorKind::Outdated.into())
            }
            Err(err) => Err(MeshError::with_call(ErrorKind::Unreachable, err)),
        }
    }

    fn mark_outdated(&self, fp: &str) {
        let mut st = self.lock();
        if st.outdated.insert(fp.to_string()) {
            self.poke();
        }
    }
}

#[cfg(test)]
impl Mesh {
    pub(crate) fn link_count(&self) -> usize {
        self.inner.lock().links.len()
    }

    pub(crate) fn ticks(&self) -> u64 {
        self.inner.ticks.load(Ordering::Relaxed)
    }

    /// 연결 fp 에서 마지막으로 받은 시각(유닉스 나노초)이다.
    pub(crate) fn last_seen(&self, fp: &str) -> Option<i64> {
        self.inner
            .lock()
            .links
            .get(fp)
            .map(|l| l.last_seen.load(Ordering::Relaxed))
    }
}
