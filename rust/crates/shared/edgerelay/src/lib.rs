//! Go 기준선 `otterminal/internal/shared/edgerelay` 의 Rust 포팅. RUST_PORT_SRS 참고.
//!
//! 서버(노드 포트·발신 소켓)와 데몬(노드 소켓) 사이의 중계다 (PEER_DAEMON_SRS FR-PDM-10~13·22).
//! 서버는 바이트만 옮기고, TLS 는 데몬이 끝낸다.

use std::io::{self, Read, Write};
use std::net::{Shutdown, TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, mpsc};
use std::time::{Duration, Instant};

use otter_gocompat::oserr::{go_error_string, syscall_error};
use otter_shared_edge::{
    Acceptor, BoxFuture, BoxStream, DIAL_TIMEOUT, Dial, REQUEST_TIMEOUT, Status,
};
use otter_shared_otterlog as otterlog;
use otter_shared_platform::{IpcListener, IpcStream};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::runtime::Handle;
use tokio::sync::watch;

/// 데몬이 여는 노드 소켓이다 (FR-PDM-11).
pub const NODE_SOCKET_FILE: &str = "node.sock";
/// 서버가 여는 발신 소켓이다 (FR-PDM-12).
pub const DIAL_SOCKET_FILE: &str = "dial.sock";

const PREAMBLE_TAG: &str = "DMRELAY1 ";
const DIAL_TAG: &str = "DMDIAL1 ";
const REPLY_OK: &str = "OK";
const REPLY_ERR: &str = "ERR ";
/// 프리앰블·요청·답 한 줄의 상한이다.
const LINE_MAX: usize = 256;
/// 프리앰블·요청·답을 기다리는 시한이다.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);
/// 로컬 소켓에 붙는 시한이다.
const LOCAL_DIAL_TIMEOUT: Duration = Duration::from_secs(2);
/// 한쪽이 끝난 뒤 다른 쪽을 기다리는 시한이다. 보내는 쪽의 요청 한도보다 길다 (FR-PNW-44).
const DRAIN_TIMEOUT: Duration = REQUEST_TIMEOUT.saturating_add(Duration::from_secs(5));
const COPY_BUF: usize = 32 << 10;

const ERR_BAD_LINE: &str = "통로 줄 형식이 틀렸습니다";
const ERR_SOCKET_BUSY: &str = "다른 프로세스가 이 소켓을 듣고 있습니다";

/// home 의 노드 소켓 경로다. 데몬 IPC 종단과 같은 폴더(0700)에 둔다.
pub fn node_socket_path(home: &Path) -> PathBuf {
    otter_shared_platform::sibling_socket(home, NODE_SOCKET_FILE)
}

/// home 의 발신 소켓 경로다.
pub fn dial_socket_path(home: &Path) -> PathBuf {
    otter_shared_platform::sibling_socket(home, DIAL_SOCKET_FILE)
}

fn ipc() -> &'static dyn otter_shared_platform::Ipc {
    otter_shared_platform::current().ipc
}

fn preamble(addr: &str) -> String {
    format!("{PREAMBLE_TAG}{addr}\n")
}

/// path 에 소켓을 연다. 남은 소켓이 죽어 있으면 치우고, 살아 있으면 거절한다.
fn listen_fresh(path: &Path) -> io::Result<IpcListener> {
    if ipc().exists(path) {
        if ipc().dial(path, LOCAL_DIAL_TIMEOUT).is_ok() {
            return Err(io::Error::new(
                io::ErrorKind::AddrInUse,
                format!("{}: {ERR_SOCKET_BUSY}", path.display()),
            ));
        }
        ipc().remove(path)?;
    }
    ipc().listen(path)
}

/// '\n' 까지 한 바이트씩 읽는다. 버퍼를 두면 줄 뒤의 TLS 바이트를 먹는다.
fn read_line(mut c: &IpcStream) -> io::Result<String> {
    let mut b = Vec::new();
    let mut one = [0u8; 1];
    while b.len() < LINE_MAX {
        if c.read(&mut one)? == 0 {
            return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "EOF"));
        }
        if one[0] == b'\n' {
            return Ok(String::from_utf8_lossy(&b).into_owned());
        }
        b.push(one[0]);
    }
    Err(io::Error::new(io::ErrorKind::InvalidData, ERR_BAD_LINE))
}

/// Go `net.SplitHostPort` 가 받는 꼴인가다.
fn valid_host_port(s: &str) -> bool {
    if let Some(rest) = s.strip_prefix('[') {
        let Some((host, port)) = rest.split_once(']') else {
            return false;
        };
        return !host.contains(['[', ']'])
            && port
                .strip_prefix(':')
                .is_some_and(|p| !p.contains([':', '[', ']']));
    }
    match s.rsplit_once(':') {
        Some((host, port)) => !host.contains([':', '[', ']']) && !port.contains(['[', ']']),
        None => false,
    }
}

/// 블로킹 IPC 연결을 tokio 쪽에서 쓰는 흐름으로 잇는다. 두 스레드가 바이트를 옮긴다.
fn bridge(s: IpcStream, rt: &Handle) -> tokio::io::DuplexStream {
    let (mine, theirs) = tokio::io::duplex(COPY_BUF);
    let (mut rd, mut wr) = tokio::io::split(theirs);
    let s = Arc::new(s);
    let (s1, rt1) = (s.clone(), rt.clone());
    let (done_tx, done_rx) = mpsc::channel::<()>();
    std::thread::spawn(move || {
        let mut buf = vec![0u8; COPY_BUF];
        loop {
            match (&*s1).read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if rt1.block_on(wr.write_all(&buf[..n])).is_err() {
                        // tokio 쪽이 닫혔다. 여기서 양방향을 닫으면 쓰기 스레드가 아직 내보내지
                        // 못한 바이트(TLS 거절 경보 등)를 잃는다. 남은 입력은 읽어 버리고, 닫기는
                        // 쓰기 스레드에 맡긴다.
                        while matches!((&*s1).read(&mut buf), Ok(n) if n > 0) {}
                        break;
                    }
                }
            }
        }
        let _ = rt1.block_on(wr.shutdown());
        let _ = done_tx.send(());
    });
    let rt2 = rt.clone();
    std::thread::spawn(move || {
        let mut buf = vec![0u8; COPY_BUF];
        loop {
            match rt2.block_on(rd.read(&mut buf)) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if (&*s).write_all(&buf[..n]).is_err() {
                        // 상대가 먼저 닫았다. tokio 쪽의 쓰기가 끊기면 이미 받은 바이트(TLS 거절
                        // 경보 등)를 읽기 전에 쓰기 오류가 먼저 나므로, 끝까지 읽어 버린다.
                        while matches!(rt2.block_on(rd.read(&mut buf)), Ok(n) if n > 0) {}
                        break;
                    }
                }
            }
        }
        // tokio 쪽이 끝났다. 쓰기를 닫고, 상대가 끝내기를 시한까지 기다린 뒤 닫는다.
        let _ = s.shutdown(Shutdown::Write);
        let _ = done_rx.recv_timeout(DRAIN_TIMEOUT);
        let _ = s.shutdown(Shutdown::Both);
    });
    mine
}

/// a 와 b 사이의 바이트를 양방향으로 옮긴다. 한쪽이 끝나면 반대쪽의 쓰기를 닫고, 다른 쪽을
/// 시한까지 기다린 뒤 둘 다 닫는다.
async fn splice<A, B>(a: A, b: B)
where
    A: AsyncRead + AsyncWrite + Send + 'static,
    B: AsyncRead + AsyncWrite + Send + 'static,
{
    let (mut ar, mut aw) = tokio::io::split(a);
    let (mut br, mut bw) = tokio::io::split(b);
    let ab = async move {
        let _ = tokio::io::copy(&mut ar, &mut bw).await;
        let _ = bw.shutdown().await;
    };
    let ba = async move {
        let _ = tokio::io::copy(&mut br, &mut aw).await;
        let _ = aw.shutdown().await;
    };
    let (mut ab, mut ba) = (Box::pin(ab), Box::pin(ba));
    tokio::select! {
        () = &mut ab => { let _ = tokio::time::timeout(DRAIN_TIMEOUT, ba).await; }
        () = &mut ba => { let _ = tokio::time::timeout(DRAIN_TIMEOUT, ab).await; }
    }
}

/// 블로킹 양쪽 사이의 [`splice`] 다.
fn splice_blocking(a: IpcStream, b: TcpStream) {
    let a = Arc::new(a);
    let b = Arc::new(b);
    let (tx, rx) = mpsc::channel();
    {
        let (a, b, tx) = (a.clone(), b.clone(), tx.clone());
        std::thread::spawn(move || {
            let _ = io::copy(&mut &*a, &mut &*b);
            let _ = b.shutdown(Shutdown::Write);
            let _ = tx.send(());
        });
    }
    {
        let (a, b) = (a.clone(), b.clone());
        std::thread::spawn(move || {
            let _ = io::copy(&mut &*b, &mut &*a);
            let _ = a.shutdown(Shutdown::Write);
            let _ = tx.send(());
        });
    }
    let _ = rx.recv();
    let _ = rx.recv_timeout(DRAIN_TIMEOUT);
    let _ = a.shutdown(Shutdown::Both);
    let _ = b.shutdown(Shutdown::Both);
}

/// 블로킹 accept 를 도는 스레드를 멈추는 손잡이다. 멈출 때 자기 소켓에 한 번 붙어 accept 를 깨운다.
struct Stopper {
    stopped: AtomicBool,
    path: PathBuf,
}

impl Stopper {
    fn stop(&self) {
        if !self.stopped.swap(true, Ordering::SeqCst) {
            let _ = ipc().dial(&self.path, LOCAL_DIAL_TIMEOUT);
        }
    }

    fn is_stopped(&self) -> bool {
        self.stopped.load(Ordering::SeqCst)
    }
}

/// ln 이 멈출 때까지 받은 연결마다 스레드에서 f 를 부른다. 멈추면 ln 을 놓아 소켓 파일을 지운다.
fn accept_loop(ln: IpcListener, stop: Arc<Stopper>, f: impl Fn(IpcStream) + Send + Sync + 'static) {
    let f = Arc::new(f);
    std::thread::spawn(move || {
        loop {
            let c = ln.accept();
            if stop.is_stopped() {
                return;
            }
            match c {
                Ok(c) => {
                    let f = f.clone();
                    std::thread::spawn(move || f(c));
                }
                Err(_) => {
                    stop.stopped.store(true, Ordering::SeqCst);
                    return;
                }
            }
        }
    });
}

// ── 서버: 노드 포트 ──────────────────────────────────────────────────────────

#[derive(Clone, PartialEq, Eq, Default)]
struct PortKey {
    enabled: bool,
    bind: String,
    port: i64,
}

#[derive(Default)]
struct PortState {
    applied: bool,
    closed: bool,
    key: PortKey,
    status: Status,
    opened: u64,
    stop: Option<watch::Sender<bool>>,
}

/// 서버의 노드 포트다. 받은 연결을 노드 소켓으로 넘긴다 (FR-PDM-10). 생명주기는
/// [`otter_shared_edge::Listener`] 와 같다 (FR-PNW-4·8·9).
pub struct Port {
    node_sock: PathBuf,
    state: Mutex<PortState>,
}

impl Port {
    /// node_sock 으로 넘기는 노드 포트다. apply 전에는 듣지 않는다.
    pub fn new(node_sock: impl Into<PathBuf>) -> Self {
        Self {
            node_sock: node_sock.into(),
            state: Mutex::default(),
        }
    }

    fn lock(&self) -> MutexGuard<'_, PortState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// enabled·bind·port 에 맞춰 연다·닫는다·다시 연다. 셋이 같고 지금 상태가 그 값과 맞으면
    /// 아무것도 하지 않는다. 열지 못하면 사유를 [`Status`] 에 남긴다. tokio 런타임 안에서 부른다.
    pub fn apply(&self, enabled: bool, bind: &str, port: i64) {
        let key = PortKey {
            enabled,
            bind: bind.to_string(),
            port,
        };
        let mut st = self.lock();
        if st.closed || (st.applied && key == st.key && st.status.listening == key.enabled) {
            return;
        }
        close_port(&mut st);
        st.applied = true;
        st.key = key;
        if !enabled {
            return;
        }
        let ln = match listen_tcp(bind, port) {
            Ok(l) => l,
            Err(e) => {
                let msg = e.to_string();
                otterlog::info(None, &format!("edge relay port: {msg}"), &[]);
                st.status = Status {
                    err: msg,
                    ..Status::default()
                };
                return;
            }
        };
        st.opened += 1;
        let addr = ln.local_addr().map(|a| a.to_string()).unwrap_or_default();
        let (tx, rx) = watch::channel(false);
        st.stop = Some(tx);
        st.status = Status {
            listening: true,
            addr: addr.clone(),
            err: String::new(),
            generation: st.opened,
        };
        tokio::spawn(serve_port(ln, self.node_sock.clone(), rx));
        otterlog::info(None, &format!("edge relay port on {addr}"), &[]);
    }

    /// 지금 상태의 사본이다.
    pub fn status(&self) -> Status {
        self.lock().status.clone()
    }

    /// 포트를 닫는다. 그 뒤의 apply 는 아무것도 열지 않는다.
    pub fn close(&self) {
        let mut st = self.lock();
        close_port(&mut st);
        st.applied = false;
        st.closed = true;
    }
}

impl Drop for Port {
    fn drop(&mut self) {
        close_port(&mut self.lock());
    }
}

fn close_port(st: &mut PortState) {
    if let Some(tx) = st.stop.take() {
        let _ = tx.send(true);
    }
    st.status = Status::default();
}

/// Go `net.Listen("tcp", JoinHostPort(bind, port))` 이다. 오류 문구도 Go 꼴이다.
fn listen_tcp(bind: &str, port: i64) -> io::Result<TcpListener> {
    let hp = if bind.contains(':') {
        format!("[{bind}]:{port}")
    } else {
        format!("{bind}:{port}")
    };
    let go = |e: io::Error| {
        io::Error::new(
            e.kind(),
            format!(
                "listen tcp {hp}: {}",
                go_error_string(&syscall_error("bind", e))
            ),
        )
    };
    let std = otter_shared_platform::listen_tcp(&hp).map_err(go)?;
    std.set_nonblocking(true).map_err(go)?;
    TcpListener::from_std(std).map_err(go)
}

async fn serve_port(ln: TcpListener, node_sock: PathBuf, mut stop: watch::Receiver<bool>) {
    loop {
        let accepted = tokio::select! {
            _ = stop.changed() => return,
            r = ln.accept() => r,
        };
        let Ok((c, peer)) = accepted else {
            return;
        };
        tokio::spawn(forward(c, peer.to_string(), node_sock.clone()));
    }
}

/// c 를 노드 소켓에 잇는다. 노드 소켓이 없으면(데몬이 안 떠 있음) c 를 닫는다.
async fn forward(c: tokio::net::TcpStream, peer: String, node_sock: PathBuf) {
    let rt = Handle::current();
    let d = tokio::task::spawn_blocking(move || -> io::Result<IpcStream> {
        let d = ipc().dial(&node_sock, LOCAL_DIAL_TIMEOUT)?;
        d.set_write_timeout(Some(HANDSHAKE_TIMEOUT))?;
        (&d).write_all(preamble(&peer).as_bytes())?;
        d.set_write_timeout(None)?;
        Ok(d)
    })
    .await;
    if let Ok(Ok(d)) = d {
        splice(c, bridge(d, &rt)).await;
    }
}

// ── 데몬: 노드 소켓 ──────────────────────────────────────────────────────────

struct NodeInner {
    rx: tokio::sync::Mutex<tokio::sync::mpsc::Receiver<(BoxStream, String)>>,
    stop: Arc<Stopper>,
    path: String,
}

/// 노드 소켓의 [`Acceptor`] 다. 프리앰블을 읽은 연결만 낸다. 받은 연결의 주소는 서버가
/// 프리앰블로 알린 원래 출발지다. 놓으면 소켓을 닫는다.
pub struct NodeListener(Arc<NodeInner>);

impl Drop for NodeListener {
    fn drop(&mut self) {
        self.0.stop.stop();
    }
}

impl Acceptor for NodeListener {
    fn accept(&self) -> BoxFuture<io::Result<(BoxStream, String)>> {
        let inner = self.0.clone();
        Box::pin(async move {
            inner
                .rx
                .lock()
                .await
                .recv()
                .await
                .ok_or_else(|| io::Error::other("use of closed network connection"))
        })
    }

    fn local_addr(&self) -> String {
        self.0.path.clone()
    }
}

/// path 에 노드 소켓을 연다 (FR-PDM-11). 프리앰블은 연결마다 따로 읽으므로 느린 연결 하나가
/// 다른 연결을 막지 않는다. tokio 런타임 안에서 부른다.
pub fn listen_node(path: &Path) -> io::Result<NodeListener> {
    let ln = listen_fresh(path)?;
    let rt = Handle::current();
    let stop = Arc::new(Stopper {
        stopped: AtomicBool::new(false),
        path: path.to_path_buf(),
    });
    let (tx, rx) = tokio::sync::mpsc::channel(1);
    let s = stop.clone();
    accept_loop(ln, stop.clone(), move |c| {
        if let Some(addr) = admit(&c)
            && !s.is_stopped()
        {
            let conn = Box::new(bridge(c, &rt)) as BoxStream;
            let _ = rt.block_on(tx.send((conn, addr)));
        }
    });
    Ok(NodeListener(Arc::new(NodeInner {
        rx: tokio::sync::Mutex::new(rx),
        stop,
        path: path.to_string_lossy().into_owned(),
    })))
}

/// 프리앰블을 읽어 원래 출발지 주소를 낸다. 틀리면 연결을 닫는다(놓는다).
fn admit(c: &IpcStream) -> Option<String> {
    c.set_read_timeout(Some(HANDSHAKE_TIMEOUT)).ok()?;
    let line = read_line(c).ok()?;
    let addr = line.strip_prefix(PREAMBLE_TAG)?;
    if !valid_host_port(addr) {
        return None;
    }
    c.set_read_timeout(None).ok()?;
    Some(addr.to_string())
}

// ── 발신 소켓 ────────────────────────────────────────────────────────────────

/// 서버의 발신 소켓 서비스다 (FR-PDM-12). 요청마다 TCP 로 연결하고 결과를 알린 뒤 바이트를
/// 잇는다. 놓거나 [`DialServer::close`] 하면 소켓을 닫는다.
pub struct DialServer {
    stop: Arc<Stopper>,
}

impl DialServer {
    pub fn close(&self) {
        self.stop.stop();
    }
}

impl Drop for DialServer {
    fn drop(&mut self) {
        self.close();
    }
}

/// path 에 발신 소켓을 열고 요청을 받기 시작한다 (Go `ListenDial` + `ServeDial`).
pub fn serve_dial(path: &Path) -> io::Result<DialServer> {
    let ln = listen_fresh(path)?;
    let stop = Arc::new(Stopper {
        stopped: AtomicBool::new(false),
        path: path.to_path_buf(),
    });
    accept_loop(ln, stop.clone(), serve_dial_one);
    Ok(DialServer { stop })
}

fn serve_dial_one(c: IpcStream) {
    if c.set_read_timeout(Some(HANDSHAKE_TIMEOUT)).is_err()
        || c.set_write_timeout(Some(HANDSHAKE_TIMEOUT)).is_err()
    {
        return;
    }
    let Ok(line) = read_line(&c) else {
        return;
    };
    let Some(addr) = line.strip_prefix(DIAL_TAG) else {
        return;
    };
    if !valid_host_port(addr) {
        return reply_fail(&c, ERR_BAD_LINE);
    }
    let r = match dial_tcp(addr) {
        Ok(r) => r,
        Err(e) => return reply_fail(&c, &e.to_string()),
    };
    if (&c).write_all(format!("{REPLY_OK}\n").as_bytes()).is_err() {
        return;
    }
    if c.set_read_timeout(None).is_err() || c.set_write_timeout(None).is_err() {
        return;
    }
    splice_blocking(c, r);
}

/// Go `net.DialTimeout("tcp", addr, edge.DialTimeout)` 이다. 오류 문구도 Go 꼴이다.
fn dial_tcp(addr: &str) -> io::Result<TcpStream> {
    let deadline = Instant::now() + DIAL_TIMEOUT;
    let addrs: Vec<_> = match addr.to_socket_addrs() {
        Ok(a) => a.collect(),
        Err(e) => {
            let host = addr
                .rsplit_once(':')
                .map_or(addr, |(h, _)| h)
                .trim_matches(['[', ']']);
            return Err(io::Error::new(
                e.kind(),
                format!("dial tcp: lookup {host}: no such host"),
            ));
        }
    };
    let mut last = io::Error::new(
        io::ErrorKind::NotFound,
        format!("dial tcp {addr}: no suitable address"),
    );
    for sa in addrs {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                format!("dial tcp {sa}: i/o timeout"),
            ));
        }
        match TcpStream::connect_timeout(&sa, left) {
            Ok(s) => return Ok(s),
            Err(e) if e.kind() == io::ErrorKind::TimedOut => {
                last = io::Error::new(
                    io::ErrorKind::TimedOut,
                    format!("dial tcp {sa}: i/o timeout"),
                );
            }
            Err(e) => {
                let kind = e.kind();
                last = io::Error::new(
                    kind,
                    format!(
                        "dial tcp {sa}: {}",
                        go_error_string(&syscall_error("connect", e))
                    ),
                );
            }
        }
    }
    Err(last)
}

fn reply_fail(mut c: &IpcStream, msg: &str) {
    let mut m = msg.replace('\n', " ").into_bytes();
    m.truncate(LINE_MAX - REPLY_ERR.len() - 1);
    let mut line = REPLY_ERR.as_bytes().to_vec();
    line.extend_from_slice(&m);
    line.push(b'\n');
    let _ = c.write_all(&line);
}

/// 발신 소켓 sock 을 지나 TCP 연결을 얻는 [`Dial`] 이다 (FR-PDM-22). 서버가 꺼져 있으면(소켓
/// 없음) 바로 실패한다 (FR-PDM-13). 오류 문구는 서버가 알린 그대로다.
pub fn dialer(sock: impl Into<PathBuf>) -> Dial {
    let sock = sock.into();
    Arc::new(move |addr: String| {
        let sock = sock.clone();
        Box::pin(async move {
            let rt = Handle::current();
            let s = tokio::task::spawn_blocking(move || dial_via(&sock, &addr))
                .await
                .map_err(io::Error::other)??;
            Ok(Box::new(bridge(s, &rt)) as BoxStream)
        })
    })
}

fn dial_via(sock: &Path, addr: &str) -> io::Result<IpcStream> {
    let c = ipc().dial(sock, LOCAL_DIAL_TIMEOUT)?;
    let deadline = DIAL_TIMEOUT + HANDSHAKE_TIMEOUT;
    c.set_read_timeout(Some(deadline))?;
    c.set_write_timeout(Some(deadline))?;
    (&c).write_all(format!("{DIAL_TAG}{addr}\n").as_bytes())?;
    let line = read_line(&c)?;
    if line != REPLY_OK {
        return Err(io::Error::other(
            line.strip_prefix(REPLY_ERR).unwrap_or(&line).to_string(),
        ));
    }
    c.set_read_timeout(None)?;
    c.set_write_timeout(None)?;
    Ok(c)
}

#[cfg(test)]
mod tests;
