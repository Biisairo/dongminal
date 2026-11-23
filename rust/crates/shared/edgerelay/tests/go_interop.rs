//! Go edgerelay 와 섞어 써도 중계가 되는가 (FR-RSP-23). `DM_PARITY_GO_RELAY_BIN` 이 없으면 건너뛴다.
//!
//! ```sh
//! rust/scripts/hermetic.sh go build -o rust/target/go-ref/relayref ./rust/crates/shared/edgerelay/testdata/goref
//! rust/scripts/hermetic.sh env DM_PARITY_GO_RELAY_BIN=$PWD/rust/target/go-ref/relayref \
//!     cargo test -p dm-shared-edgerelay --test go_interop
//! ```

use std::io::{BufRead, BufReader as StdBufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdout, Command, Stdio};
use std::time::Duration;

use dm_shared_edge::Acceptor;
use dm_shared_edgerelay::{
    DIAL_SOCKET_FILE, NODE_SOCKET_FILE, Port, dialer, listen_node, serve_dial,
};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

const PORT_MIN: u16 = 60147;
const PORT_MAX: u16 = 64999;
const WAIT: Duration = Duration::from_secs(10);

fn free_port() -> u16 {
    let span = PORT_MAX - PORT_MIN;
    let start = rand::random::<u16>() % span;
    (0..span)
        .map(|i| PORT_MIN + (start + i) % span)
        .find(|p| std::net::TcpListener::bind(("127.0.0.1", *p)).is_ok())
        .expect("빈 포트가 없다")
}

/// 띄운 Go 참조 프로그램이다. 놓으면 끈다(이 시험이 띄운 PID 만).
struct Go {
    child: Child,
    out: StdBufReader<ChildStdout>,
}

impl Go {
    fn start(bin: &Path, args: &[&str]) -> Self {
        let mut child = Command::new(bin)
            .args(args)
            .stdout(Stdio::piped())
            .stdin(Stdio::null())
            .spawn()
            .unwrap();
        let out = StdBufReader::new(child.stdout.take().unwrap());
        Self { child, out }
    }

    fn line(&mut self) -> String {
        let mut s = String::new();
        self.out.read_line(&mut s).unwrap();
        s.trim_end().to_string()
    }
}

impl Drop for Go {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// 연결 하나를 받아 한 줄을 그대로 돌려주는 TCP 상대다.
async fn echo_target() -> String {
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = l.local_addr().unwrap().to_string();
    tokio::spawn(async move {
        let (c, _) = l.accept().await.unwrap();
        let mut br = BufReader::new(c);
        let mut line = String::new();
        br.read_line(&mut line).await.unwrap();
        br.get_mut().write_all(line.as_bytes()).await.unwrap();
        tokio::time::sleep(Duration::from_secs(2)).await;
    });
    addr
}

async fn round_trip<S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin>(
    c: S,
    msg: &str,
) -> String {
    let mut br = BufReader::new(c);
    br.get_mut()
        .write_all(format!("{msg}\n").as_bytes())
        .await
        .unwrap();
    let mut line = String::new();
    tokio::time::timeout(WAIT, br.read_line(&mut line))
        .await
        .unwrap()
        .unwrap();
    line.trim_end().to_string()
}

fn short_dir() -> tempfile::TempDir {
    tempfile::Builder::new()
        .prefix("dmg")
        .tempdir_in("/tmp")
        .unwrap()
}

fn bin() -> Option<PathBuf> {
    let b = std::env::var_os("DM_PARITY_GO_RELAY_BIN").map(PathBuf::from);
    if b.is_none() {
        eprintln!("DM_PARITY_GO_RELAY_BIN 이 없어 건너뛴다");
    }
    b
}

/// Rust 의 dialer → Go 의 발신 소켓 서비스 → TCP 상대.
#[tokio::test(flavor = "multi_thread")]
async fn rust_dialer_through_go_dial_socket() {
    let Some(bin) = bin() else { return };
    let d = short_dir();
    let sock = d.path().join(DIAL_SOCKET_FILE);
    let mut go = Go::start(&bin, &["dialsrv", &sock.to_string_lossy()]);
    assert_eq!(go.line(), "ready");
    let c = dialer(&sock)(echo_target().await).await.unwrap();
    assert_eq!(round_trip(c, "hello").await, "hello");
    let closed = free_port();
    let err = dialer(&sock)(format!("127.0.0.1:{closed}"))
        .await
        .err()
        .unwrap();
    assert_eq!(
        err.to_string(),
        format!("dial tcp 127.0.0.1:{closed}: connect: connection refused")
    );
}

/// Go 의 Dialer → Rust 의 발신 소켓 서비스 → TCP 상대.
#[tokio::test(flavor = "multi_thread")]
async fn go_dialer_through_rust_dial_socket() {
    let Some(bin) = bin() else { return };
    let d = short_dir();
    let sock = d.path().join(DIAL_SOCKET_FILE);
    let _srv = serve_dial(&sock).unwrap();
    let target = echo_target().await;
    let s = sock.to_string_lossy().into_owned();
    let got = tokio::task::spawn_blocking(move || Go::start(&bin, &["dial", &s, &target]).line())
        .await
        .unwrap();
    assert_eq!(got, "got ping");
}

/// Rust 의 노드 포트 → Go 의 노드 소켓. Go 는 프리앰블로 원래 출발지를 받는다.
#[tokio::test(flavor = "multi_thread")]
async fn rust_port_into_go_node_socket() {
    let Some(bin) = bin() else { return };
    let d = short_dir();
    let sock = d.path().join(NODE_SOCKET_FILE);
    let mut go = Go::start(&bin, &["node", &sock.to_string_lossy()]);
    assert_eq!(go.line(), "ready");
    let p = Port::new(&sock);
    let port = free_port();
    p.apply(true, "127.0.0.1", i64::from(port));
    let c = tokio::net::TcpStream::connect(("127.0.0.1", port))
        .await
        .unwrap();
    let local = c.local_addr().unwrap().to_string();
    assert_eq!(round_trip(c, "hi").await, "hi");
    let remote = tokio::task::spawn_blocking(move || go.line())
        .await
        .unwrap();
    assert_eq!(remote, format!("remote {local}"));
}

/// Go 의 노드 포트 → Rust 의 노드 소켓.
#[tokio::test(flavor = "multi_thread")]
async fn go_port_into_rust_node_socket() {
    let Some(bin) = bin() else { return };
    let d = short_dir();
    let sock = d.path().join(NODE_SOCKET_FILE);
    let node = listen_node(&sock).unwrap();
    let port = free_port();
    let mut go = Go::start(&bin, &["port", &sock.to_string_lossy(), &port.to_string()]);
    assert_eq!(go.line(), "ready true");
    let c = tokio::net::TcpStream::connect(("127.0.0.1", port))
        .await
        .unwrap();
    let local = c.local_addr().unwrap().to_string();
    let server = tokio::spawn(async move {
        let (s, remote) = tokio::time::timeout(WAIT, node.accept())
            .await
            .unwrap()
            .unwrap();
        let mut br = BufReader::new(s);
        let mut line = String::new();
        br.read_line(&mut line).await.unwrap();
        br.get_mut().write_all(line.as_bytes()).await.unwrap();
        tokio::time::sleep(Duration::from_secs(1)).await;
        remote
    });
    assert_eq!(round_trip(c, "yo").await, "yo");
    assert_eq!(server.await.unwrap(), local);
}
