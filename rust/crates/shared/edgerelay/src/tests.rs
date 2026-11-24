//! Go relay_test.go·e2e_test.go.

use std::sync::Arc;
use std::time::Duration;

use otter_shared_edge::{
    CallError, Client, Config, Handler, Identity, Listener, Target, edges_only,
    load_or_create_identity,
};
use tempfile::TempDir;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

use super::*;

const PORT_MIN: u16 = 60147;
const PORT_MAX: u16 = 64999;

/// 유닉스 소켓 경로 상한(104바이트)을 넘지 않는 짧은 임시 폴더다.
fn short_dir() -> TempDir {
    tempfile::Builder::new()
        .prefix("otterr")
        .tempdir_in("/tmp")
        .unwrap()
}

/// 비어 있는 loopback 포트다. 운영 보호로 60147 이상만 쓴다.
fn free_port() -> u16 {
    let span = PORT_MAX - PORT_MIN;
    let start = rand::random::<u16>() % span;
    (0..span)
        .map(|i| PORT_MIN + (start + i) % span)
        .find(|p| std::net::TcpListener::bind(("127.0.0.1", *p)).is_ok())
        .expect("빈 포트가 없다")
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
    tokio::time::timeout(Duration::from_secs(5), br.read_line(&mut line))
        .await
        .unwrap()
        .unwrap();
    line.trim_end().to_string()
}

/// 연결 하나를 받아 한 줄을 그대로 돌려주고, 받은 연결의 주소를 낸다.
fn echo_once(node: NodeListener) -> tokio::sync::oneshot::Receiver<String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    tokio::spawn(async move {
        let (c, remote) = node.accept().await.unwrap();
        let _ = tx.send(remote);
        let mut br = BufReader::new(c);
        let mut line = String::new();
        br.read_line(&mut line).await.unwrap();
        br.get_mut().write_all(line.as_bytes()).await.unwrap();
        tokio::time::sleep(Duration::from_secs(1)).await;
        drop(node);
    });
    rx
}

#[test]
fn wire_lines() {
    assert_eq!(preamble("10.0.0.9:4000"), "DMRELAY1 10.0.0.9:4000\n");
    for ok in ["10.0.0.9:4000", "[::1]:80", "h:1", ":80"] {
        assert!(valid_host_port(ok), "{ok}");
    }
    for bad in ["10.0.0.9", "::1:80", "[::1]", "[::1]x:80", "a[b:1"] {
        assert!(!valid_host_port(bad), "{bad}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn port_forwards_to_node_socket() {
    let d = short_dir();
    let sock = d.path().join(NODE_SOCKET_FILE);
    let node = listen_node(&sock).unwrap();
    let remote = echo_once(node);
    let p = Port::new(&sock);
    let port = free_port();
    p.apply(true, "127.0.0.1", i64::from(port));
    assert!(p.status().listening, "{:?}", p.status());
    let c = tokio::net::TcpStream::connect(("127.0.0.1", port))
        .await
        .unwrap();
    let local = c.local_addr().unwrap().to_string();
    assert_eq!(round_trip(c, "hello").await, "hello");
    let r = tokio::time::timeout(Duration::from_secs(5), remote)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(r, local);
    p.close();
}

#[tokio::test(flavor = "multi_thread")]
async fn node_listener_slow_preamble_does_not_block() {
    let d = short_dir();
    let sock = d.path().join(NODE_SOCKET_FILE);
    let node = listen_node(&sock).unwrap();
    let _stuck = ipc().dial(&sock, Duration::from_secs(1)).unwrap();
    let good = ipc().dial(&sock, Duration::from_secs(1)).unwrap();
    (&good)
        .write_all(preamble("10.0.0.9:4000").as_bytes())
        .unwrap();
    let (_, r) = tokio::time::timeout(Duration::from_secs(5), node.accept())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(r, "10.0.0.9:4000");
}

#[tokio::test(flavor = "multi_thread")]
async fn node_listener_rejects_bad_preamble() {
    let d = short_dir();
    let sock = d.path().join(NODE_SOCKET_FILE);
    let node = listen_node(&sock).unwrap();
    let bad = ipc().dial(&sock, Duration::from_secs(1)).unwrap();
    (&bad).write_all(b"GET / HTTP/1.1\n").unwrap();
    bad.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    let mut one = [0u8; 1];
    let n = tokio::task::spawn_blocking(move || (&bad).read(&mut one))
        .await
        .unwrap();
    assert!(
        matches!(n, Ok(0) | Err(_)),
        "틀린 프리앰블 연결이 열려 있다: {n:?}"
    );
    assert!(
        tokio::time::timeout(Duration::from_millis(300), node.accept())
            .await
            .is_err(),
        "틀린 연결이 나왔다"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn port_closes_when_node_socket_missing() {
    let d = short_dir();
    let p = Port::new(d.path().join(NODE_SOCKET_FILE));
    let port = free_port();
    p.apply(true, "127.0.0.1", i64::from(port));
    let mut c = tokio::net::TcpStream::connect(("127.0.0.1", port))
        .await
        .unwrap();
    let mut one = [0u8; 1];
    let n = tokio::time::timeout(Duration::from_secs(5), c.read(&mut one))
        .await
        .unwrap();
    assert!(matches!(n, Ok(0) | Err(_)), "{n:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn port_lifecycle() {
    let d = short_dir();
    let p = Port::new(d.path().join(NODE_SOCKET_FILE));
    let port = i64::from(free_port());
    p.apply(false, "127.0.0.1", port);
    assert!(!p.status().listening);
    p.apply(true, "127.0.0.1", port);
    let g1 = p.status().generation;
    p.apply(true, "127.0.0.1", port);
    assert_eq!(p.status().generation, g1);
    let other = free_port();
    p.apply(true, "127.0.0.1", i64::from(other));
    let st = p.status();
    assert!(
        st.listening && st.addr.ends_with(&format!(":{other}")),
        "{st:?}"
    );
    let busy_port = free_port();
    let _busy = std::net::TcpListener::bind(("127.0.0.1", busy_port)).unwrap();
    p.apply(true, "127.0.0.1", i64::from(busy_port));
    let st = p.status();
    assert!(!st.listening);
    assert_eq!(
        st.err,
        format!("listen tcp 127.0.0.1:{busy_port}: bind: address already in use")
    );
    p.apply(false, "127.0.0.1", port);
    assert!(!p.status().listening);
    p.close();
    p.apply(true, "127.0.0.1", port);
    assert!(!p.status().listening, "닫은 뒤 다시 열었다");
}

#[tokio::test(flavor = "multi_thread")]
async fn dial_service_connects() {
    let d = short_dir();
    let sock = d.path().join(DIAL_SOCKET_FILE);
    let _srv = serve_dial(&sock).unwrap();
    let target = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = target.local_addr().unwrap().to_string();
    tokio::spawn(async move {
        let (c, _) = target.accept().await.unwrap();
        let mut br = BufReader::new(c);
        let mut line = String::new();
        br.read_line(&mut line).await.unwrap();
        br.get_mut().write_all(line.as_bytes()).await.unwrap();
    });
    let c = dialer(&sock)(addr).await.unwrap();
    assert_eq!(round_trip(c, "ping").await, "ping");
}

#[tokio::test(flavor = "multi_thread")]
async fn dial_service_unreachable() {
    let d = short_dir();
    let sock = d.path().join(DIAL_SOCKET_FILE);
    let _srv = serve_dial(&sock).unwrap();
    let closed = free_port();
    let err = dialer(&sock)(format!("127.0.0.1:{closed}"))
        .await
        .err()
        .unwrap();
    assert_eq!(
        err.to_string(),
        format!("dial tcp 127.0.0.1:{closed}: connect: connection refused")
    );
    let err = dialer(&sock)("no-port".into()).await.err().unwrap();
    assert_eq!(err.to_string(), ERR_BAD_LINE);
}

#[tokio::test(flavor = "multi_thread")]
async fn dialer_without_server_fails() {
    let d = short_dir();
    let sock = d.path().join(DIAL_SOCKET_FILE);
    let start = std::time::Instant::now();
    let err = dialer(&sock)("127.0.0.1:1".into()).await.err().unwrap();
    assert!(start.elapsed() < Duration::from_secs(3));
    assert_eq!(
        err.to_string(),
        format!(
            "dial unix {}: connect: no such file or directory",
            sock.display()
        )
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn listen_fresh_refuses_live_and_clears_dead() {
    let d = short_dir();
    let sock = d.path().join(DIAL_SOCKET_FILE);
    let srv = serve_dial(&sock).unwrap();
    let err = serve_dial(&sock).err().unwrap();
    assert_eq!(
        err.to_string(),
        format!("{}: {ERR_SOCKET_BUSY}", sock.display())
    );
    srv.close();
    tokio::time::sleep(Duration::from_millis(100)).await;
    // 죽은 소켓 파일(듣는 프로세스 없음)은 치우고 새로 연다.
    #[cfg(unix)]
    drop(std::os::unix::net::UnixListener::bind(&sock).unwrap());
    assert!(sock.exists());
    let _again = serve_dial(&sock).unwrap();
}

// ---- e2e (Go e2e_test.go) ----

fn identity() -> Identity {
    let d = TempDir::new().unwrap();
    load_or_create_identity(d.path()).unwrap()
}

/// 서버(노드 포트·발신 소켓)와 데몬(노드 소켓 위 노드 리스너) 한 쌍이다.
struct RelayNode {
    _dir: TempDir,
    id: Identity,
    port: u16,
    dial_sock: PathBuf,
    _srv: DialServer,
    _relay: Port,
    _ln: Listener,
}

fn start_relay_node(admit: impl Fn(&str) -> bool + Send + Sync + 'static) -> RelayNode {
    let dir = short_dir();
    let id = identity();
    let node_sock = dir.path().join(NODE_SOCKET_FILE);
    let dial_sock = dir.path().join(DIAL_SOCKET_FILE);
    let srv = serve_dial(&dial_sock).unwrap();
    let port = free_port();
    let relay = Port::new(&node_sock);
    relay.apply(true, "127.0.0.1", i64::from(port));
    let h: Handler = Arc::new(|req| {
        let fp = otter_shared_edge::client_fingerprint(&req).to_string();
        Box::pin(async move { otter_shared_httpresp::json(http::StatusCode::OK, &[("fp", fp)]) })
    });
    let ln = Listener::new(&id, edges_only(admit), h).unwrap();
    let ns = node_sock.clone();
    ln.use_listen(Box::new(move |_, _| {
        listen_node(&ns).map(|n| Box::new(n) as Box<dyn Acceptor>)
    }));
    ln.apply(&Config {
        enabled: true,
        bind: "127.0.0.1".into(),
        port: 1,
        ..Config::default()
    });
    assert!(ln.status().listening, "{:?}", ln.status());
    RelayNode {
        _dir: dir,
        id,
        port,
        dial_sock,
        _srv: srv,
        _relay: relay,
        _ln: ln,
    }
}

/// A 의 데몬이 A 의 발신 소켓으로 나가고, B 의 노드 포트를 지나 B 의 데몬이 TLS 를 끝낸다.
/// 두 서버는 바이트만 옮긴다 (TC-PDM-2·3).
#[tokio::test(flavor = "multi_thread")]
async fn relay_end_to_end_tls() {
    let a_id = identity();
    let a_fp = a_id.fingerprint.clone();
    let b = start_relay_node(move |fp| fp == a_fp);
    let a = start_relay_node(|_| false);
    let client = Client::via(a_id.clone(), dialer(&a.dial_sock));
    let t = Target {
        addr: "127.0.0.1".into(),
        port: i64::from(b.port),
        fingerprint: b.id.fingerprint.clone(),
    };
    let out: Vec<(String, String)> = client.call(&t, "/edge/v1/x", &()).await.unwrap();
    assert_eq!(out, vec![("fp".to_string(), a_id.fingerprint.clone())]);
}

/// 짝이 아닌 노드는 B 의 데몬이 TLS 단계에서 거절한다.
#[tokio::test(flavor = "multi_thread")]
async fn relay_end_to_end_rejects_non_edge() {
    let b = start_relay_node(|_| false);
    let a = start_relay_node(|_| false);
    let client = Client::via(identity(), dialer(&a.dial_sock));
    let t = Target {
        addr: "127.0.0.1".into(),
        port: i64::from(b.port),
        fingerprint: b.id.fingerprint.clone(),
    };
    assert_eq!(
        client.call_raw(&t, "/edge/v1/x", &()).await,
        Err(CallError::Rejected)
    );
}

/// 지문 고정은 발신 소켓을 지나도 그대로다.
#[tokio::test(flavor = "multi_thread")]
async fn relay_end_to_end_fingerprint_pinned() {
    let a_id = identity();
    let a_fp = a_id.fingerprint.clone();
    let b = start_relay_node(move |fp| fp == a_fp);
    let a = start_relay_node(|_| false);
    let client = Client::via(a_id, dialer(&a.dial_sock));
    let t = Target {
        addr: "127.0.0.1".into(),
        port: i64::from(b.port),
        fingerprint: "ab".repeat(32),
    };
    assert_eq!(
        client.call_raw(&t, "/edge/v1/x", &()).await,
        Err(CallError::FingerprintMismatch)
    );
}
