//! client·listener·upgrade 시험 (Go client_test·listener_test·upgrade_test).

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use bytes::Bytes;
use http::{Request, StatusCode};
use http_body_util::{BodyExt, Empty};
use hyper_util::rt::TokioIo;
use rustls::ClientConfig;
use tempfile::TempDir;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tokio_rustls::TlsConnector;

use crate::listener::{HANDSHAKE_AGGREGATE, HandshakeLog};
use crate::*;

const FREE_PORT_MIN: u16 = 60147;
const FREE_PORT_MAX: u16 = 64999;

fn identity() -> Identity {
    let d = TempDir::new().unwrap();
    load_or_create_identity(d.path()).unwrap()
}

/// 지금 비어 있는 loopback 포트다. 운영 보호로 60147 이상만 쓴다.
fn free_port() -> i64 {
    let span = FREE_PORT_MAX - FREE_PORT_MIN;
    let start = rand::random::<u16>() % span;
    for i in 0..span {
        let p = FREE_PORT_MIN + (start + i) % span;
        if std::net::TcpListener::bind(("127.0.0.1", p)).is_ok() {
            return i64::from(p);
        }
    }
    panic!("빈 포트가 없다");
}

fn enabled_at(port: i64) -> Config {
    Config {
        enabled: true,
        bind: "127.0.0.1".into(),
        port,
        ..Config::default()
    }
}

fn handler<F, Fut>(f: F) -> Handler
where
    F: Fn(Request<hyper::body::Incoming>) -> Fut + Send + Sync + 'static,
    Fut: std::future::Future<Output = dm_shared_httpresp::Response> + Send + 'static,
{
    Arc::new(move |r| Box::pin(f(r)))
}

fn status_only(code: StatusCode) -> dm_shared_httpresp::Response {
    let mut r = http::Response::new(dm_shared_httpresp::empty());
    *r.status_mut() = code;
    r
}

struct Fixture {
    ln: Listener,
    server: Identity,
    edge: Identity,
    strange: Identity,
    handled: Arc<AtomicI64>,
}

fn counting(handled: &Arc<AtomicI64>) -> Handler {
    let h = handled.clone();
    handler(move |_| {
        h.fetch_add(1, Ordering::SeqCst);
        async { status_only(StatusCode::NO_CONTENT) }
    })
}

fn fixture_with(adm: impl FnOnce(&Identity, &Identity) -> Admission) -> Fixture {
    let (server, edge, strange) = (identity(), identity(), identity());
    let handled = Arc::new(AtomicI64::new(0));
    let ln = Listener::new(&server, adm(&edge, &strange), counting(&handled)).unwrap();
    Fixture {
        ln,
        server,
        edge,
        strange,
        handled,
    }
}

fn fixture() -> Fixture {
    fixture_with(|edge, _| {
        let fp = edge.fingerprint.clone();
        edges_only(move |x| x == fp)
    })
}

/// 서버 지문을 고정하는 시험용 클라이언트 설정이다. id 가 없으면 인증서를 내밀지 않는다.
fn raw_client(server_fp: &str, id: Option<&Identity>, tls12_only: bool) -> Arc<ClientConfig> {
    let p = Arc::new(rustls::crypto::ring::default_provider());
    let versions: &[&rustls::SupportedProtocolVersion] = if tls12_only {
        &[&rustls::version::TLS12]
    } else {
        &[&rustls::version::TLS13]
    };
    let b = ClientConfig::builder_with_provider(p)
        .with_protocol_versions(versions)
        .unwrap()
        .dangerous()
        .with_custom_certificate_verifier(crate::tls::pin_server(server_fp));
    Arc::new(match id {
        Some(id) => b
            .with_client_auth_cert(vec![id.certificate.clone()], id.private_key())
            .unwrap(),
        None => b.with_no_client_auth(),
    })
}

type Sender = hyper::client::conn::http1::SendRequest<Empty<Bytes>>;

async fn open(cfg: Arc<ClientConfig>, addr: &str) -> Result<Sender, String> {
    let tcp = TcpStream::connect(addr).await.map_err(|e| e.to_string())?;
    let name = rustls::pki_types::ServerName::try_from("127.0.0.1").unwrap();
    let tls = TlsConnector::from(cfg)
        .connect(name, tcp)
        .await
        .map_err(|e| e.to_string())?;
    let (s, conn) = hyper::client::conn::http1::handshake(TokioIo::new(tls))
        .await
        .map_err(|e| e.to_string())?;
    tokio::spawn(conn);
    Ok(s)
}

async fn send(s: &mut Sender, path: &str) -> Result<u16, String> {
    let req = Request::get(path)
        .header("host", "127.0.0.1")
        .body(Empty::new())
        .unwrap();
    let r = tokio::time::timeout(Duration::from_secs(3), s.send_request(req))
        .await
        .map_err(|_| "timeout".to_string())?
        .map_err(|e| e.to_string())?;
    let st = r.status().as_u16();
    let _ = r.into_body().collect().await;
    Ok(st)
}

async fn get(cfg: Arc<ClientConfig>, addr: &str, path: &str) -> Result<u16, String> {
    let mut s = open(cfg, addr).await?;
    send(&mut s, path).await
}

async fn dialable(addr: &str) -> bool {
    TcpStream::connect(addr).await.is_ok()
}

#[tokio::test]
async fn listener_disabled_does_not_listen() {
    let f = fixture();
    let port = free_port();
    f.ln.apply(&Config {
        enabled: false,
        bind: "127.0.0.1".into(),
        port,
        ..Config::default()
    });
    let st = f.ln.status();
    assert!(!st.listening && st.err.is_empty(), "{st:?}");
    assert!(!dialable(&format!("127.0.0.1:{port}")).await);
}

#[tokio::test]
async fn listener_serves_edge() {
    let f = fixture();
    f.ln.apply(&enabled_at(free_port()));
    let st = f.ln.status();
    assert!(st.listening, "{st:?}");
    let code = get(
        raw_client(&f.server.fingerprint, Some(&f.edge), false),
        &st.addr,
        "/edge/v1/x",
    )
    .await;
    assert_eq!(code, Ok(204));
    assert_eq!(
        dm_gocompat::json::marshal(&st).unwrap(),
        format!(r#"{{"listening":true,"addr":"{}"}}"#, st.addr).into_bytes()
    );
}

#[tokio::test]
async fn listener_requires_client_cert() {
    let f = fixture();
    f.ln.apply(&enabled_at(free_port()));
    assert!(
        get(
            raw_client(&f.server.fingerprint, None, false),
            &f.ln.status().addr,
            "/edge/v1/x"
        )
        .await
        .is_err()
    );
    assert_eq!(f.handled.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn listener_rejects_non_edge() {
    let f = fixture();
    f.ln.apply(&enabled_at(free_port()));
    assert!(
        get(
            raw_client(&f.server.fingerprint, Some(&f.strange), false),
            &f.ln.status().addr,
            "/edge/v1/x"
        )
        .await
        .is_err()
    );
    assert_eq!(f.handled.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn listener_rejects_tls12() {
    let f = fixture();
    f.ln.apply(&enabled_at(free_port()));
    assert!(
        get(
            raw_client(&f.server.fingerprint, Some(&f.edge), true),
            &f.ln.status().addr,
            "/edge/v1/x"
        )
        .await
        .is_err()
    );
}

#[tokio::test]
async fn listener_reapplies_on_port_change() {
    let f = fixture();
    f.ln.apply(&enabled_at(free_port()));
    let old = f.ln.status().addr;
    f.ln.apply(&enabled_at(free_port()));
    let st = f.ln.status();
    assert!(st.listening && st.addr != old, "{st:?}");
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(!dialable(&old).await, "옛 포트가 열려 있다");
    assert_eq!(
        get(
            raw_client(&f.server.fingerprint, Some(&f.edge), false),
            &st.addr,
            "/edge/v1/x"
        )
        .await,
        Ok(204)
    );
}

#[tokio::test]
async fn listener_apply_same_keeps() {
    let f = fixture();
    let mut cfg = enabled_at(free_port());
    f.ln.apply(&cfg);
    let before = f.ln.status();
    cfg.name = "renamed".into();
    cfg.edges = vec![Edge {
        name: "x".into(),
        ..Edge::default()
    }];
    f.ln.apply(&cfg);
    let after = f.ln.status();
    assert!(before == after && before.generation == after.generation);
}

#[tokio::test]
async fn listener_disable_closes() {
    let f = fixture();
    let mut cfg = enabled_at(free_port());
    f.ln.apply(&cfg);
    let addr = f.ln.status().addr;
    cfg.enabled = false;
    f.ln.apply(&cfg);
    assert!(!f.ln.status().listening);
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(!dialable(&addr).await);
}

#[tokio::test]
async fn listener_port_busy_reports_reason() {
    let f = fixture();
    let port = free_port();
    let _busy = std::net::TcpListener::bind(("127.0.0.1", u16::try_from(port).unwrap())).unwrap();
    f.ln.apply(&enabled_at(port));
    let st = f.ln.status();
    assert!(!st.listening);
    assert_eq!(
        st.err,
        format!("listen tcp 127.0.0.1:{port}: bind: address already in use")
    );
    assert_eq!(
        dm_gocompat::json::marshal(&st).unwrap(),
        format!(r#"{{"listening":false,"error":"{}"}}"#, st.err).into_bytes()
    );
    f.ln.apply(&enabled_at(free_port()));
    let st = f.ln.status();
    assert!(st.listening && st.err.is_empty(), "{st:?}");
}

#[tokio::test]
async fn listener_close() {
    let f = fixture();
    f.ln.apply(&enabled_at(free_port()));
    let addr = f.ln.status().addr;
    f.ln.close();
    f.ln.close();
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(!dialable(&addr).await);
}

#[tokio::test]
async fn listener_revoked_edge_on_open_connection() {
    let allowed = Arc::new(AtomicBool::new(true));
    let a = allowed.clone();
    let f = fixture_with(move |edge, _| {
        let fp = edge.fingerprint.clone();
        edges_only(move |x| a.load(Ordering::SeqCst) && x == fp)
    });
    f.ln.apply(&enabled_at(free_port()));
    let mut s = open(
        raw_client(&f.server.fingerprint, Some(&f.edge), false),
        &f.ln.status().addr,
    )
    .await
    .unwrap();
    assert_eq!(send(&mut s, "/edge/v1/x").await, Ok(204));
    allowed.store(false, Ordering::SeqCst);
    assert_eq!(send(&mut s, "/edge/v1/x").await, Ok(403));
    assert_eq!(f.handled.load(Ordering::SeqCst), 1);
}

/// rustls 서버는 재개 때 검증기를 부르지 않는다. 그래서 재개 자체를 끈다 — 세션 캐시를 가진
/// 클라이언트도 두 번째 연결에서 전체 핸드셰이크를 하고 거절된다.
#[tokio::test]
async fn listener_revoked_edge_on_resumed_session() {
    let allowed = Arc::new(AtomicBool::new(true));
    let a = allowed.clone();
    let f = fixture_with(move |edge, _| {
        let fp = edge.fingerprint.clone();
        Admission {
            tls: Arc::new(move |x| a.load(Ordering::SeqCst) && x == fp),
            request: Arc::new(|_, _| true),
        }
    });
    f.ln.apply(&enabled_at(free_port()));
    let addr = f.ln.status().addr;
    let cfg = raw_client(&f.server.fingerprint, Some(&f.edge), false);
    let tcp = TcpStream::connect(&addr).await.unwrap();
    let name = rustls::pki_types::ServerName::try_from("127.0.0.1").unwrap();
    let mut tls = TlsConnector::from(cfg.clone())
        .connect(name, tcp)
        .await
        .unwrap();
    tls.write_all(b"GET /edge/v1/x HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n")
        .await
        .unwrap();
    let mut line = String::new();
    BufReader::new(&mut tls).read_line(&mut line).await.unwrap();
    assert!(line.starts_with("HTTP/1.1 204"), "{line}");
    allowed.store(false, Ordering::SeqCst);
    assert!(
        get(cfg, &addr, "/edge/v1/x").await.is_err(),
        "해제한 짝이 들어왔다"
    );
    assert_eq!(f.handled.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn listener_request_admission_by_path() {
    let f = fixture_with(|_, strange| {
        let (a, b) = (strange.fingerprint.clone(), strange.fingerprint.clone());
        Admission {
            tls: Arc::new(move |x| x == a),
            request: Arc::new(move |x, p| x == b && p == "/edge/v1/pair"),
        }
    });
    f.ln.apply(&enabled_at(free_port()));
    let addr = f.ln.status().addr;
    let c = raw_client(&f.server.fingerprint, Some(&f.strange), false);
    assert_eq!(get(c.clone(), &addr, "/edge/v1/pair").await, Ok(204));
    let mut s = open(c, &addr).await.unwrap();
    let req = Request::get("/edge/v1/node.info")
        .header("host", "x")
        .body(Empty::new())
        .unwrap();
    let r = s.send_request(req).await.unwrap();
    assert_eq!(r.status(), 403);
    assert_eq!(r.headers()["connection"], "close");
    assert_eq!(r.headers()["x-error-code"], "edge_not_edge");
    let body = r.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(
        &body[..],
        r#"{"code":"edge_not_edge","message":"간선이 아닌 노드입니다"}"#.as_bytes()
    );
    assert_eq!(f.handled.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn listener_apply_after_close_stays_closed() {
    let f = fixture_with(|_, _| edges_only(|_| false));
    f.ln.apply(&enabled_at(free_port()));
    assert!(f.ln.status().listening);
    f.ln.close();
    f.ln.apply(&enabled_at(free_port()));
    assert!(!f.ln.status().listening);
}

/// Go TestHandshakeLogAggregates.
#[test]
fn handshake_log_aggregates() {
    #[derive(Clone, Default)]
    struct Buf(Arc<Mutex<Vec<u8>>>);
    impl std::io::Write for Buf {
        fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(b);
            Ok(b.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let buf = Buf::default();
    dm_shared_dmlog::init(dm_shared_dmlog::Options {
        out: Some(Box::new(buf.clone())),
        ..Default::default()
    });
    let text = || String::from_utf8(buf.0.lock().unwrap().clone()).unwrap();
    type Pending = Arc<Mutex<Option<(Duration, Box<dyn FnOnce() + Send>)>>>;
    let pending: Pending = Arc::default();
    let p = pending.clone();
    let h = HandshakeLog::new(Arc::new(move |d, f| *p.lock().unwrap() = Some((d, f))));
    for _ in 0..100 {
        h.write("http: TLS handshake error from 10.0.0.9:4000: 짝이 아닌 노드입니다\n");
    }
    assert_eq!(text().matches("handshake failure").count(), 1, "{}", text());
    assert!(text().contains("count=1 "));
    let (wait, flush) = pending
        .lock()
        .unwrap()
        .take()
        .expect("창 끝 내보내기를 걸지 않았다");
    assert_eq!(wait, HANDSHAKE_AGGREGATE);
    flush();
    assert!(text().contains("count=99 within 1m0s (최근: http: TLS handshake error from 10.0.0.9:4000: 짝이 아닌 노드입니다)"), "{}", text());
    h.write("http: TLS handshake error from 10.0.0.8:4000: x\n");
    assert!(pending.lock().unwrap().is_some() && text().contains("10.0.0.8"));
    h.write("http: panic serving 1.2.3.4: boom\n");
    assert!(text().contains("edge listener: http: panic serving"));
    dm_shared_dmlog::reset();
}

// ---- client (Go client_test.go) ----

struct ClientFixture {
    _ln: Listener,
    caller: Identity,
    target: Target,
    hits: Arc<AtomicI64>,
}

fn client_fixture(h: Handler) -> ClientFixture {
    let (server, caller) = (identity(), identity());
    let hits = Arc::new(AtomicI64::new(0));
    let hh = hits.clone();
    let wrapped: Handler = Arc::new(move |r| {
        hh.fetch_add(1, Ordering::SeqCst);
        h(r)
    });
    let fp = caller.fingerprint.clone();
    let ln = Listener::new(&server, edges_only(move |x| x == fp), wrapped).unwrap();
    ln.apply(&enabled_at(free_port()));
    let addr = ln.status().addr;
    let (host, port) = addr.rsplit_once(':').unwrap();
    let target = Target {
        addr: host.into(),
        port: port.parse().unwrap(),
        fingerprint: server.fingerprint.clone(),
    };
    ClientFixture {
        _ln: ln,
        caller,
        target,
        hits,
    }
}

fn echo() -> Handler {
    handler(|r: Request<hyper::body::Incoming>| async move {
        let path = r.uri().path().to_string();
        let body = r.into_body().collect().await.unwrap().to_bytes();
        let mut m: BTreeMap<String, String> =
            dm_gocompat::json::unmarshal(&body).unwrap_or_default();
        m.insert("path".into(), path);
        dm_shared_httpresp::json(StatusCode::OK, &m)
    })
}

fn fixed(code: StatusCode, body: &'static str) -> Handler {
    handler(move |_| async move {
        let mut r = http::Response::new(dm_shared_httpresp::full(body));
        *r.status_mut() = code;
        r
    })
}

fn fp_of(prefix: &str) -> String {
    format!("{prefix}{}", "0".repeat(64 - prefix.len()))
}

#[tokio::test]
async fn client_call() {
    let f = client_fixture(echo());
    let mut input = BTreeMap::new();
    input.insert("a", "b");
    let out: BTreeMap<String, String> = Client::new(f.caller.clone())
        .call(&f.target, "/edge/v1/x", &input)
        .await
        .unwrap();
    assert_eq!(out["a"], "b");
    assert_eq!(out["path"], "/edge/v1/x");
}

#[tokio::test]
async fn client_fingerprint_mismatch() {
    let f = client_fixture(echo());
    let mut wrong = f.target.clone();
    wrong.fingerprint = fp_of("ee");
    let err = Client::new(f.caller.clone())
        .call_raw(&wrong, "/edge/v1/x", &())
        .await
        .unwrap_err();
    assert_eq!(err, CallError::FingerprintMismatch);
    assert_eq!(err.to_string(), "상대 노드의 지문이 기대와 다릅니다");
    assert_eq!(f.hits.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn client_unreachable() {
    let port = free_port();
    let tgt = Target {
        addr: "127.0.0.1".into(),
        port,
        fingerprint: fp_of("aa"),
    };
    let err = Client::new(identity())
        .call_raw(&tgt, "/edge/v1/x", &())
        .await
        .unwrap_err();
    assert_eq!(
        err.to_string(),
        format!(
            "상대 노드에 닿지 못했습니다: Post \"https://127.0.0.1:{port}/edge/v1/x\": dial tcp 127.0.0.1:{port}: connect: connection refused"
        )
    );
}

#[tokio::test]
async fn client_remote_error() {
    let f = client_fixture(fixed(
        StatusCode::FORBIDDEN,
        r#"{"code":"edge_token_invalid","message":"bad token"}"#,
    ));
    let err = Client::new(f.caller.clone())
        .call_raw(&f.target, "/edge/v1/pair", &())
        .await
        .unwrap_err();
    let want = RemoteError {
        status: 403,
        code: "edge_token_invalid".into(),
        message: "bad token".into(),
    };
    assert_eq!(err, CallError::Remote(want));
    assert_eq!(
        err.to_string(),
        "상대 노드가 거절했습니다 (403 edge_token_invalid): bad token"
    );
}

#[tokio::test]
async fn client_rejected_by_edge() {
    let f = client_fixture(echo());
    let err = Client::new(identity())
        .call_raw(&f.target, "/edge/v1/x", &())
        .await
        .unwrap_err();
    assert_eq!(err, CallError::Rejected);
    assert_eq!(err.to_string(), "상대 노드가 이 노드를 받지 않았습니다");
}

#[tokio::test]
async fn client_forbidden_without_code_is_rejected() {
    let f = client_fixture(fixed(StatusCode::FORBIDDEN, "nope"));
    assert_eq!(
        Client::new(f.caller.clone())
            .call_raw(&f.target, "/x", &())
            .await,
        Err(CallError::Rejected)
    );
}

#[tokio::test]
async fn client_remote_error_cleans_message() {
    let no_code: &'static str =
        Box::leak(format!("\x1b]52;c;cHduZWQ=\x07{}", "x".repeat(4096)).into_boxed_str());
    let with_code: &'static str = Box::leak(
        format!(
            r#"{{"code":"edge_x","message":"a\u001b[2Jb{}"}}"#,
            "y".repeat(4096)
        )
        .into_boxed_str(),
    );
    for body in [no_code, with_code] {
        let f = client_fixture(fixed(StatusCode::INTERNAL_SERVER_ERROR, body));
        let Err(CallError::Remote(re)) = Client::new(f.caller.clone())
            .call_raw(&f.target, "/x", &())
            .await
        else {
            panic!("RemoteError 가 아니다");
        };
        assert!(
            !re.message.contains(['\x1b', '\x07']) && re.message.len() <= REMOTE_MESSAGE_MAX,
            "{re:?}"
        );
    }
}

#[tokio::test]
async fn client_remote_error_cleans_code() {
    let body: &'static str = Box::leak(
        format!(
            r#"{{"code":"x\u001b]0;t\u0007{}","message":"m"}}"#,
            "c".repeat(4096)
        )
        .into_boxed_str(),
    );
    let f = client_fixture(fixed(StatusCode::INTERNAL_SERVER_ERROR, body));
    let Err(CallError::Remote(re)) = Client::new(f.caller.clone())
        .call_raw(&f.target, "/x", &())
        .await
    else {
        panic!("RemoteError 가 아니다");
    };
    assert!(
        !re.code.contains(['\x1b', '\x07']) && re.code.len() <= REMOTE_MESSAGE_MAX,
        "{re:?}"
    );
}

#[tokio::test]
async fn client_does_not_follow_redirect() {
    let h = handler(|r: Request<hyper::body::Incoming>| async move {
        assert_eq!(r.uri().path(), "/edge/v1/x", "리다이렉트를 따라갔다");
        let mut resp = status_only(StatusCode::TEMPORARY_REDIRECT);
        resp.headers_mut().insert(
            "location",
            http::HeaderValue::from_static("/edge/v1/elsewhere"),
        );
        resp
    });
    let f = client_fixture(h);
    let err = Client::new(f.caller.clone())
        .call_raw(&f.target, "/edge/v1/x", &())
        .await
        .unwrap_err();
    assert!(
        matches!(err, CallError::Remote(RemoteError { status: 307, .. })),
        "{err:?}"
    );
    assert_eq!(f.hits.load(Ordering::SeqCst), 1);
}

#[test]
fn clean_message_removes_format_chars() {
    let CallError::Remote(re) = crate::client::remote_failure(
        StatusCode::INTERNAL_SERVER_ERROR,
        "a\u{202e}b\u{200b}c".as_bytes(),
    ) else {
        panic!();
    };
    assert_eq!(re.message, "abc");
}

// ---- upgrade (Go upgrade_test.go) ----

const TEST_PROTO: &str = "dmchat1";

fn echo_upgrade() -> Handler {
    handler(|mut r: Request<hyper::body::Incoming>| async move {
        let (resp, pending) = accept_upgrade(&mut r, TEST_PROTO);
        if let Some(p) = pending {
            tokio::spawn(async move {
                let Ok(conn) = p.conn().await else { return };
                let mut br = BufReader::new(conn);
                let mut line = String::new();
                if br.read_line(&mut line).await.is_ok() {
                    let _ = br
                        .get_mut()
                        .write_all(format!("echo {line}").as_bytes())
                        .await;
                }
            });
        }
        resp
    })
}

#[tokio::test]
async fn upgrade_echoes() {
    let f = client_fixture(echo_upgrade());
    let mut conn = Client::new(f.caller.clone())
        .upgrade(&f.target, "/edge/v1/chat", TEST_PROTO)
        .await
        .unwrap();
    conn.write_all(b"hi\n").await.unwrap();
    let mut line = String::new();
    tokio::time::timeout(
        Duration::from_secs(5),
        BufReader::new(&mut conn).read_line(&mut line),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(line, "echo hi\n");
}

#[tokio::test]
async fn upgrade_rejects_non_edge() {
    let f = client_fixture(echo_upgrade());
    let err = Client::new(identity())
        .upgrade(&f.target, "/edge/v1/chat", TEST_PROTO)
        .await
        .err();
    assert_eq!(err, Some(CallError::Rejected));
}

#[tokio::test]
async fn upgrade_fingerprint_mismatch() {
    let f = client_fixture(echo_upgrade());
    let mut tgt = f.target.clone();
    tgt.fingerprint = "00".into();
    let err = Client::new(f.caller.clone())
        .upgrade(&tgt, "/edge/v1/chat", TEST_PROTO)
        .await
        .err();
    assert_eq!(err, Some(CallError::FingerprintMismatch));
}

#[tokio::test]
async fn upgrade_without_header_is_400() {
    let f = client_fixture(echo_upgrade());
    let err = Client::new(f.caller.clone())
        .call_raw(&f.target, "/edge/v1/chat", &())
        .await
        .unwrap_err();
    let want = RemoteError {
        status: 400,
        code: "bad_request".into(),
        message: "upgrade required".into(),
    };
    assert_eq!(err, CallError::Remote(want));
}

#[tokio::test]
async fn upgrade_server_refusal_is_remote_error() {
    let f = client_fixture(handler(|_| async { status_only(StatusCode::NOT_FOUND) }));
    let err = Client::new(f.caller.clone())
        .upgrade(&f.target, "/edge/v1/chat", TEST_PROTO)
        .await
        .err();
    assert!(
        matches!(
            err,
            Some(CallError::Remote(RemoteError { status: 404, .. }))
        ),
        "{err:?}"
    );
}
