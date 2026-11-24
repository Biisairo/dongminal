//! 서버 수명·리바인드·이사 보관 (Go `rebind_test.go`·`addr_file_test.go`·`server_verdict_test.go`
//! 의 바인드 판정). 실제 리스너로 잰다.
//!
//! 격리 규칙(C-RSP-1)대로 루프백 60147 이상 포트만 쓴다 — Go 시험의 `127.0.0.1:0` 자리를 65000 위
//! 구간의 빈 포트로 바꿨다. `ws.rs` 시험(60147~64999)과 겹치지 않는다.
//! Go `http.Server` 의 Host 검사·머리/유휴 시한 시험은 Go 에 없어 새로 둔다.

use std::collections::HashMap;
use std::io;
use std::path::Path;
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use http::Method;
use otter_shared_serverconf as serverconf;
use otter_webserver_apierr as apierr;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio_util::sync::CancellationToken;

use crate::rebind::{BindReq, EXPOSE_HOST, bind_port_valid, bind_reason, bind_target};
use crate::rebind_conns::ConnSet;
use crate::req::Req;
use crate::{Config, Deps, Server};

const PORT_LO: u16 = 65000;
const PORT_HI: u16 = 65500;

static NEXT_PORT: AtomicU16 = AtomicU16::new(0);

/// 빈 루프백 포트 하나 (Go `freeTCPPort`).
fn free_port() -> u16 {
    let _ = NEXT_PORT.compare_exchange(
        0,
        PORT_LO + (std::process::id() % 300) as u16,
        Ordering::SeqCst,
        Ordering::SeqCst,
    );
    for _ in 0..(PORT_HI - PORT_LO) {
        let mut p = NEXT_PORT.fetch_add(1, Ordering::SeqCst);
        if p >= PORT_HI {
            NEXT_PORT.store(PORT_LO + 1, Ordering::SeqCst);
            p = PORT_LO;
        }
        if std::net::TcpListener::bind(("127.0.0.1", p)).is_ok() {
            return p;
        }
    }
    panic!("빈 포트가 없다");
}

/// 응답 하나: 상태 줄, 소문자 머리, 본문.
struct Raw {
    line: String,
    status: u16,
    headers: HashMap<String, String>,
    body: String,
}

impl Raw {
    fn json(&self) -> serde_json::Value {
        serde_json::from_str(&self.body).unwrap_or(serde_json::Value::Null)
    }
    fn h(&self, k: &str) -> String {
        self.headers.get(k).cloned().unwrap_or_default()
    }
}

fn parse_raw(buf: &[u8]) -> Option<Raw> {
    let text = String::from_utf8_lossy(buf).into_owned();
    let (head, body) = text.split_once("\r\n\r\n")?;
    let mut lines = head.split("\r\n");
    let line = lines.next()?.to_owned();
    let status = line.split(' ').nth(1)?.parse().ok()?;
    let headers = lines
        .filter_map(|l| l.split_once(':'))
        .map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_owned()))
        .collect();
    Some(Raw {
        line,
        status,
        headers,
        body: body.to_owned(),
    })
}

/// 요청 바이트를 그대로 보내고 끝까지 읽는다.
async fn send_raw(port: u16, req: &str) -> Option<Raw> {
    let mut c = TcpStream::connect(("127.0.0.1", port)).await.ok()?;
    c.write_all(req.as_bytes()).await.ok()?;
    let mut buf = Vec::new();
    tokio::time::timeout(Duration::from_secs(3), c.read_to_end(&mut buf))
        .await
        .ok()?
        .ok()?;
    parse_raw(&buf)
}

/// keep-alive 없는 요청 하나 (Go `noKeepAlive`).
async fn request(port: u16, method: &str, path: &str, body: &str) -> Option<Raw> {
    let mut req =
        format!("{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n");
    if !body.is_empty() {
        req.push_str(&format!(
            "Content-Type: application/json\r\nContent-Length: {}\r\n",
            body.len()
        ));
    }
    req.push_str("\r\n");
    req.push_str(body);
    send_raw(port, &req).await
}

async fn ping_ok(port: u16) -> bool {
    request(port, "GET", "/api/ping", "")
        .await
        .is_some_and(|r| r.status == 200)
}

async fn post_bind(port: u16, body: &str) -> (u16, String, serde_json::Value) {
    let r = request(port, "POST", "/api/server/bind", body)
        .await
        .expect("응답이 없다");
    (r.status, r.h("x-error-code"), r.json())
}

fn server_json(home: &Path) -> serde_json::Value {
    match std::fs::read(home.join(serverconf::FILE_NAME)) {
        Ok(b) => serde_json::from_slice(&b).unwrap(),
        Err(e) if e.kind() == io::ErrorKind::NotFound => serde_json::json!({}),
        Err(e) => panic!("{e}"),
    }
}

fn is_empty_obj(v: &serde_json::Value) -> bool {
    v.as_object().is_some_and(|m| m.is_empty())
}

struct Running {
    srv: Arc<Server>,
    home: tempfile::TempDir,
    port: u16,
    stop: CancellationToken,
    done: Option<tokio::task::JoinHandle<io::Result<()>>>,
}

impl Running {
    async fn shutdown(mut self) {
        self.stop.cancel();
        if let Some(d) = self.done.take() {
            d.await.unwrap().unwrap();
        }
    }
}

/// 임시 홈·빈 포트로 `run` 을 돌린다 (Go `startBindServer`). `prep` 은 서버를 세우기 전에 고친다.
async fn start(prep: impl FnOnce(&mut Server)) -> Running {
    let home = tempfile::tempdir().unwrap();
    let srv = Server::new_with(
        Config {
            data_dir: home.path().to_path_buf(),
            ..Config::default()
        },
        Deps::default(),
        |s| {
            s.rebind.grace = Duration::from_millis(300);
            prep(s);
        },
    );
    let port = free_port();
    let stop = CancellationToken::new();
    let (s, t) = (srv.clone(), stop.clone());
    let done = tokio::spawn(async move { s.run(t, &format!("127.0.0.1:{port}")).await });
    let deadline = Instant::now() + Duration::from_secs(3);
    while !ping_ok(port).await {
        assert!(Instant::now() < deadline, "서버가 뜨지 않았다");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    Running {
        srv,
        home,
        port,
        stop,
        done: Some(done),
    }
}

/// 0.0.0.0 을 127.0.0.1 로 바꿔 리슨한다 — 시험이 같은 망에 포트를 열지 않는다.
fn expose_listen(fail: bool, asked: Arc<Mutex<Vec<String>>>) -> crate::rebind::ListenFn {
    Arc::new(move |addr: &str| {
        asked.lock().unwrap().push(addr.to_owned());
        let (h, p) = addr.rsplit_once(':').unwrap();
        if h == EXPOSE_HOST {
            if fail {
                return Err(io::Error::other("주입한 실패"));
            }
            return std::net::TcpListener::bind(format!("127.0.0.1:{p}"));
        }
        std::net::TcpListener::bind(addr)
    })
}

// TC-HRB-4 (FR-HRB-10): 리슨에 성공하면 주소 파일을 쓰고, 정상 종료 때 지운다.
#[tokio::test]
async fn run_writes_and_removes_addr_file() {
    let mut r = start(|_| {}).await;
    let home = r.home.path().to_path_buf();
    assert_eq!(
        serverconf::read_addr(&home),
        Some(("127.0.0.1".to_owned(), r.port.to_string()))
    );
    r.stop.cancel();
    let res = r.done.take().unwrap().await.unwrap();
    assert!(res.is_ok(), "{res:?}");
    assert_eq!(
        serverconf::read_addr(&home),
        None,
        "정상 종료 뒤에도 주소 파일이 남았다"
    );
    assert!(!ping_ok(r.port).await, "종료 뒤에도 받는다");
}

// 리슨에 실패하면 주소 파일을 쓰지 않는다.
#[tokio::test]
async fn run_listen_failure_writes_no_addr() {
    let home = tempfile::tempdir().unwrap();
    let port = free_port();
    let _busy = std::net::TcpListener::bind(("127.0.0.1", port)).unwrap();
    let srv = Server::new(
        Config {
            data_dir: home.path().to_path_buf(),
            ..Config::default()
        },
        Deps::default(),
    );
    let res = srv
        .run(CancellationToken::new(), &format!("127.0.0.1:{port}"))
        .await;
    assert!(res.is_err(), "쓰이는 포트에서 run 이 성공했다");
    assert_eq!(serverconf::read_addr(home.path()), None);
}

// TC-HRB-7 (FR-HRB-20·23): 새 포트가 받고, 파일 둘이 바뀌고, 옛 포트는 유예 동안 GET / 를 307 로
// 보내고, 유예 뒤 닫힌다.
#[tokio::test]
async fn rebind_port() {
    let r = start(|_| {}).await;
    let (p1, p2) = (r.port, free_port());
    let (code, _, body) = post_bind(p1, &format!(r#"{{"port":{p2}}}"#)).await;
    assert_eq!(code, 200, "{body}");
    assert_eq!(body["port"], p2.to_string());
    assert_eq!(body["expose"], false);
    assert!(ping_ok(p2).await, "새 포트가 받지 않는다");
    assert_eq!(server_json(r.home.path())["port"], p2.to_string());
    assert_eq!(
        serverconf::read_addr(r.home.path()),
        Some(("127.0.0.1".to_owned(), p2.to_string()))
    );

    let old = request(p1, "GET", "/?x=1", "")
        .await
        .expect("유예 중 옛 포트가 닫혔다");
    assert_eq!(old.status, 307);
    assert_eq!(old.h("location"), format!("http://127.0.0.1:{p2}/?x=1"));
    assert_eq!(
        old.body,
        format!("<a href=\"http://127.0.0.1:{p2}/?x=1\">Temporary Redirect</a>.\n\n")
    );
    assert!(
        old.h("x-request-id").is_empty(),
        "리다이렉트는 처리기 사슬 밖이다"
    );
    assert!(ping_ok(p1).await, "유예 중 옛 포트의 API 가 서지 않는다");

    let deadline = Instant::now() + Duration::from_secs(3);
    while ping_ok(p1).await {
        assert!(Instant::now() < deadline, "유예 뒤에도 옛 포트가 열려 있다");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(ping_ok(p2).await, "옛 포트를 닫으며 새 포트도 닫혔다");
    r.shutdown().await;
}

// FR-HRB-22: 바뀌는 것이 없으면 200 과 지금 바인드.
#[tokio::test]
async fn rebind_no_change() {
    let r = start(|_| {}).await;
    let p1 = r.port;
    let (code, _, body) = post_bind(p1, &format!(r#"{{"port":{p1},"expose":false}}"#)).await;
    assert_eq!(code, 200);
    assert_eq!(body["port"], p1.to_string());
    assert!(
        is_empty_obj(&server_json(r.home.path())),
        "바뀐 것이 없는데 server.json 을 썼다"
    );
    r.shutdown().await;
}

// TC-HRB-7 (FR-HRB-23): 쓰이는 포트·범위 밖은 각 코드로 거절되고 옛 바인드가 그대로다.
#[tokio::test]
async fn rebind_rejects() {
    let r = start(|_| {}).await;
    let p1 = r.port;
    let bp = free_port();
    let _busy = std::net::TcpListener::bind(("127.0.0.1", bp)).unwrap();
    for (body, status, code) in [
        (
            format!(r#"{{"port":{bp}}}"#),
            409,
            apierr::CODE_BIND_PORT_IN_USE,
        ),
        (
            r#"{"port":80}"#.to_owned(),
            400,
            apierr::CODE_BIND_PORT_INVALID,
        ),
        (
            r#"{"port":70000}"#.to_owned(),
            400,
            apierr::CODE_BIND_PORT_INVALID,
        ),
    ] {
        let (c, ec, _) = post_bind(p1, &body).await;
        assert_eq!((c, ec.as_str()), (status, code), "{body}");
    }
    assert!(ping_ok(p1).await, "거절 뒤 옛 포트가 닫혔다");
    assert!(is_empty_obj(&server_json(r.home.path())));
    assert_eq!(
        serverconf::read_addr(r.home.path()).map(|a| a.1),
        Some(p1.to_string())
    );
    r.shutdown().await;
}

// TC-HRB-7 (FR-HRB-27): 진행 중이면 409 bind_busy.
#[tokio::test]
async fn rebind_busy() {
    let r = start(|_| {}).await;
    let b = r.srv.rebind.current().unwrap();
    b.lock().busy = true;
    let (c, ec, _) = post_bind(r.port, &format!(r#"{{"port":{}}}"#, free_port())).await;
    assert_eq!((c, ec.as_str()), (409, apierr::CODE_BIND_BUSY));
    b.lock().busy = false;
    r.shutdown().await;
}

// 유예 중인 옛 포트로 되돌릴 수 있다.
#[tokio::test]
async fn rebind_back_to_grace_port() {
    let r = start(|s| s.rebind.grace = Duration::from_secs(5)).await;
    let (p1, p2) = (r.port, free_port());
    let (c, _, body) = post_bind(p1, &format!(r#"{{"port":{p2}}}"#)).await;
    assert_eq!(c, 200, "p2 로: {body}");
    let (c, _, body) = post_bind(p2, &format!(r#"{{"port":{p1}}}"#)).await;
    assert_eq!(c, 200, "p1 로 되돌리기: {body}");
    assert_eq!(body["port"], p1.to_string());
    let res = request(p1, "GET", "/", "").await.unwrap();
    assert_ne!(res.status, 307, "지금 포트가 옛 포트처럼 307 을 낸다");
    r.shutdown().await;
}

// TC-HRB-8 (FR-HRB-24·29): expose 만 바꾸면 같은 포트로 다시 리슨하고, 경고를 싣는다.
#[tokio::test]
async fn rebind_expose_only() {
    let asked = Arc::new(Mutex::new(Vec::new()));
    let a = asked.clone();
    let r = start(move |s| s.rebind.listen = expose_listen(false, a)).await;
    let p1 = r.port;
    let (c, _, body) = post_bind(p1, r#"{"expose":true}"#).await;
    assert_eq!(c, 200, "{body}");
    assert_eq!(body["expose"], true);
    assert_eq!(body["port"], p1.to_string());
    assert_eq!(body["host"], "0.0.0.0");
    assert!(
        body["warning"]
            .as_str()
            .unwrap_or_default()
            .contains("허용 목록"),
        "경고가 없다: {body}"
    );
    assert_eq!(
        asked.lock().unwrap().last().cloned(),
        Some(format!("0.0.0.0:{p1}"))
    );
    assert!(ping_ok(p1).await, "다시 리슨하지 않았다");
    assert_eq!(server_json(r.home.path())["host"], "0.0.0.0");
    assert_eq!(
        serverconf::read_addr(r.home.path()).map(|a| a.0),
        Some("0.0.0.0".to_owned())
    );
    r.shutdown().await;
}

// TC-HRB-8: 새 호스트로 리슨하지 못하면 옛 호스트로 돌아가고 409 bind_rebind_failed.
#[tokio::test]
async fn rebind_expose_failure_rolls_back() {
    let asked = Arc::new(Mutex::new(Vec::new()));
    let a = asked.clone();
    let r = start(move |s| s.rebind.listen = expose_listen(true, a)).await;
    let (c, ec, _) = post_bind(r.port, r#"{"expose":true}"#).await;
    assert_eq!((c, ec.as_str()), (409, apierr::CODE_BIND_REBIND_FAILED));
    assert!(ping_ok(r.port).await, "옛 호스트로 돌아가지 않았다");
    assert!(is_empty_obj(&server_json(r.home.path())));
    r.shutdown().await;
}

// TC-HRB-9 (FR-HRB-21): 루프백이 아닌 출발지는 403 bind_local_only. Run 밖의 서버는 503.
#[tokio::test]
async fn rebind_local_only() {
    let home = tempfile::tempdir().unwrap();
    let srv = super::support::server(home.path(), Deps::default());
    let mut r = Req::for_test(Method::POST, "/api/server/bind", r#"{"port":9999}"#);
    r.remote_addr = "192.168.1.9:51000".to_owned();
    let res = srv.api_server_bind(&mut r).await;
    assert_eq!(res.status(), 403);
    assert_eq!(
        res.headers()[otter_shared_httpresp::CODE_HEADER],
        apierr::CODE_BIND_LOCAL_ONLY
    );
    let mut r = Req::for_test(Method::POST, "/api/server/bind", r#"{"port":9999}"#);
    r.remote_addr = "127.0.0.1:51000".to_owned();
    let res = srv.api_server_bind(&mut r).await;
    assert_eq!(res.status(), 503);
    assert_eq!(
        res.headers()[otter_shared_httpresp::CODE_HEADER],
        apierr::CODE_BIND_UNAVAILABLE
    );
}

async fn body_of(res: otter_shared_httpresp::Response) -> String {
    use http_body_util::BodyExt;
    let b = res.into_body().collect().await.unwrap().to_bytes();
    String::from_utf8_lossy(&b).into_owned()
}

async fn carry_post(srv: &Server, body: &[u8]) -> (u16, String, String) {
    use http_body_util::BodyExt;
    let path = "/api/server/carry";
    let mut r = Req::new(
        Method::POST,
        path.to_owned(),
        path.parse().unwrap(),
        http::HeaderMap::new(),
        "localhost".to_owned(),
        "127.0.0.1:50000".to_owned(),
        http::Extensions::new(),
        http_body_util::Full::new(bytes::Bytes::from(body.to_vec()))
            .map_err(|e| match e {})
            .boxed_unsync(),
        None,
    );
    let res = srv.api_server_carry_post(&mut r).await;
    let code = res
        .headers()
        .get(otter_shared_httpresp::CODE_HEADER)
        .map(|v| v.to_str().unwrap().to_owned())
        .unwrap_or_default();
    (res.status().as_u16(), code, body_of(res).await)
}

async fn carry_get(srv: &Server, token: &str) -> (u16, String, String) {
    let mut r = Req::for_test(Method::GET, &format!("/api/server/carry/{token}"), "");
    let res = srv.api_server_carry_get(&mut r).await;
    let code = res
        .headers()
        .get(otter_shared_httpresp::CODE_HEADER)
        .map(|v| v.to_str().unwrap().to_owned())
        .unwrap_or_default();
    (res.status().as_u16(), code, body_of(res).await)
}

fn token_of(body: &str) -> String {
    let v: serde_json::Value = serde_json::from_str(body).unwrap();
    v["token"].as_str().unwrap().to_owned()
}

// TC-HRB-10 (FR-HRB-26): 토큰은 한 번만, 60초 안에만 쓰인다. 1 MiB 상한, 16개 상한.
#[tokio::test]
async fn carry() {
    let home = tempfile::tempdir().unwrap();
    let srv = super::support::server(home.path(), Deps::default());
    let t0 = Instant::now();
    *srv.rebind.carry.now.lock().unwrap() = Some(t0);

    let (c, _, body) = carry_post(&srv, br#"{"theme":"dark"}"#).await;
    assert_eq!(c, 200, "{body}");
    let tok = token_of(&body);
    assert!(tok.len() >= 32);
    let (c, _, got) = carry_get(&srv, &tok).await;
    assert_eq!((c, got.trim()), (200, r#"{"theme":"dark"}"#));
    let (c, code, _) = carry_get(&srv, &tok).await;
    assert_eq!((c, code.as_str()), (404, apierr::CODE_NOT_FOUND));

    let (_, _, body) = carry_post(&srv, b"{}").await;
    let tok = token_of(&body);
    *srv.rebind.carry.now.lock().unwrap() = Some(t0 + Duration::from_secs(61));
    assert_eq!(carry_get(&srv, &tok).await.0, 404, "60초 뒤 찾기");

    let mut big = br#"{"x":""#.to_vec();
    big.extend(std::iter::repeat_n(b'a', 1 << 20));
    big.extend(br#""}"#);
    assert_eq!(carry_post(&srv, &big).await.0, 413);
    assert_eq!(carry_post(&srv, b"not json").await.0, 400);
    for i in 0..16 {
        assert_eq!(carry_post(&srv, b"{}").await.0, 200, "{i}번째 맡기기");
    }
    let (c, code, _) = carry_post(&srv, b"{}").await;
    assert_eq!((c, code.as_str()), (503, apierr::CODE_BUSY));
}

// carry 는 실제 경로로도 닿는다 — 받은 바이트를 그대로 돌려준다.
#[tokio::test]
async fn carry_routes() {
    let home = tempfile::tempdir().unwrap();
    let srv = super::support::server(home.path(), Deps::default());
    let res = super::support::post_json(&srv, "/api/server/carry", r#"{"a":"<&>"}"#).await;
    assert_eq!(res.status, 200, "{}", res.body);
    let tok = token_of(&res.body);
    let got = super::support::get(&srv, &format!("/api/server/carry/{tok}")).await;
    assert_eq!(got.status, 200);
    assert_eq!(got.header("content-type"), "application/json");
    assert_eq!(got.body, r#"{"a":"<&>"}"#);
}

// FR-HRB-32: expose 를 끄면 루프백이 아닌 출발지의 연결을 끊는다. 루프백 연결은 남긴다.
#[test]
fn conn_set_revoke_remote() {
    let set = Arc::new(ConnSet::default());
    let lan = set.track("192.168.1.9:5000".parse().unwrap());
    let lo = set.track("127.0.0.1:5001".parse().unwrap());
    set.revoke_remote();
    assert!(lan.kill.is_cancelled());
    assert!(!lo.kill.is_cancelled());
    drop(lan);
    assert_eq!(set.size(), 1, "닫힌 연결은 집합에서 빠진다");
}

// FR-HRB-32: 노출된 옛 리스너는 expose 를 끄며 포트를 옮길 때 유예 없이 닫힌다.
#[tokio::test]
async fn rebind_unexpose_move_closes_old_at_once() {
    let asked = Arc::new(Mutex::new(Vec::new()));
    let a = asked.clone();
    let r = start(move |s| {
        s.rebind.grace = Duration::from_secs(5);
        s.rebind.listen = expose_listen(false, a);
    })
    .await;
    let p1 = r.port;
    let (c, _, body) = post_bind(p1, r#"{"expose":true}"#).await;
    assert_eq!(c, 200, "expose: {body}");
    let p2 = free_port();
    let (c, _, body) = post_bind(p1, &format!(r#"{{"port":{p2},"expose":false}}"#)).await;
    assert_eq!(c, 200, "이동: {body}");
    assert_eq!(body["expose"], false);
    assert!(!ping_ok(p1).await, "노출된 옛 리스너가 유예로 남았다");
    assert_eq!(r.srv.rebind.current().unwrap().lock().grace.len(), 0);
    assert!(ping_ok(p2).await, "새 포트가 받지 않는다");
    r.shutdown().await;
}

// FR-HRB-40: Settings 가 읽는 지금 바인드와 server.json 의 출처. 루프백인지(local)도 싣는다.
#[tokio::test]
async fn server_bind_get() {
    let r = start(|_| {}).await;
    let p1 = r.port;
    let get = |p: u16| async move {
        let res = request(p, "GET", "/api/server/bind", "").await.unwrap();
        assert_eq!(res.status, 200);
        res.json()
    };
    let m = get(p1).await;
    assert_eq!(m["port"], p1.to_string());
    assert_eq!(m["host"], "127.0.0.1");
    assert_eq!(m["expose"], false);
    assert_eq!(m["local"], true);
    assert_eq!(m["source"]["port"], "default");
    let p2 = free_port();
    let (c, _, body) = post_bind(p1, &format!(r#"{{"port":{p2}}}"#)).await;
    assert_eq!(c, 200, "{body}");
    let m = get(p2).await;
    assert_eq!(m["port"], p2.to_string());
    assert_eq!(m["source"]["port"], "file");
    r.shutdown().await;
}

// 응답 본문의 필드 순서는 Go 구조체 임베딩 순서다.
#[tokio::test]
async fn server_bind_get_wire() {
    let home = tempfile::tempdir().unwrap();
    let srv = super::support::server(home.path(), Deps::default());
    let res = super::support::get(&srv, "/api/server/bind").await;
    assert_eq!(res.status, 200);
    assert_eq!(
        res.body,
        format!(
            "{{\"host\":\"127.0.0.1\",\"port\":\"{}\",\"expose\":false,\"url\":\"http://127.0.0.1:{}\",\"local\":true,\"source\":{{\"host\":\"default\",\"port\":\"default\"}}}}\n",
            otter_shared_otterenv::DEFAULT_PORT,
            otter_shared_otterenv::DEFAULT_PORT
        )
    );
}

// FR-HRB-32: 노출된 채 옮겨 옛 리스너가 유예 중일 때 expose 만 끄면, 그 옛 리스너도 바로 닫는다.
#[tokio::test]
async fn rebind_unexpose_closes_exposed_grace() {
    let asked = Arc::new(Mutex::new(Vec::new()));
    let a = asked.clone();
    let r = start(move |s| {
        s.rebind.grace = Duration::from_secs(5);
        s.rebind.listen = expose_listen(false, a);
    })
    .await;
    let p1 = r.port;
    let (c, _, body) = post_bind(p1, r#"{"expose":true}"#).await;
    assert_eq!(c, 200, "expose: {body}");
    let p2 = free_port();
    let (c, _, body) = post_bind(p1, &format!(r#"{{"port":{p2}}}"#)).await;
    assert_eq!(c, 200, "노출 유지 이동: {body}");
    assert_eq!(body["expose"], true);
    assert!(
        ping_ok(p1).await,
        "노출이 그대로면 옛 리스너는 유예로 남아야 한다"
    );
    let (c, _, body) = post_bind(p2, r#"{"expose":false}"#).await;
    assert_eq!(c, 200, "expose 끄기: {body}");
    assert_eq!(body["expose"], false);
    assert!(
        !ping_ok(p1).await,
        "expose 를 껐는데 노출된 유예 리스너가 남았다"
    );
    assert!(ping_ok(p2).await, "지금 포트가 받지 않는다");
    r.shutdown().await;
}

#[test]
fn bind_port_valid_table() {
    for (port, want) in [
        (None, true),
        (Some(1024), true),
        (Some(65535), true),
        (Some(1023), false),
        (Some(65536), false),
    ] {
        assert_eq!(bind_port_valid(port), want, "{port:?}");
    }
}

#[test]
fn bind_target_table() {
    let d = otter_shared_otterenv::DEFAULT_HOST;
    let cases: [(&str, &str, BindReq, &str, &str); 6] = [
        (d, "1", BindReq::default(), d, "1"),
        (
            d,
            "1",
            BindReq {
                expose: Some(true),
                ..BindReq::default()
            },
            EXPOSE_HOST,
            "1",
        ),
        (
            EXPOSE_HOST,
            "1",
            BindReq {
                expose: Some(false),
                ..BindReq::default()
            },
            d,
            "1",
        ),
        (
            d,
            "1",
            BindReq {
                expose: Some(false),
                ..BindReq::default()
            },
            d,
            "1",
        ),
        (
            d,
            "1",
            BindReq {
                port: Some(2000),
                ..BindReq::default()
            },
            d,
            "2000",
        ),
        (
            d,
            "1",
            BindReq {
                port: Some(2000),
                expose: Some(true),
            },
            EXPOSE_HOST,
            "2000",
        ),
    ];
    for (ch, cp, req, wh, wp) in cases {
        assert_eq!(
            bind_target(ch, cp, &req),
            (wh.to_owned(), wp.to_owned()),
            "{ch} {cp} {:?} {:?}",
            req.port,
            req.expose
        );
    }
}

#[test]
fn bind_reason_table() {
    assert_eq!(bind_reason("1", "1"), "expose");
    assert_eq!(bind_reason("1", "2"), "port");
}

// Go `http.Server` 의 Host 검사: 1.1 에 Host 가 없거나 틀리면 사유가 붙은 400 이고 연결을 닫는다.
#[tokio::test]
async fn run_rejects_bad_host_header() {
    let r = start(|_| {}).await;
    let p = r.port;
    let res = send_raw(p, "GET /api/ping HTTP/1.1\r\n\r\n").await.unwrap();
    assert_eq!(
        res.line,
        "HTTP/1.1 400 Bad Request: missing required Host header"
    );
    assert_eq!(res.body, "400 Bad Request: missing required Host header");
    assert_eq!(res.h("content-type"), "text/plain; charset=utf-8");
    assert_eq!(res.h("connection"), "close");

    let res = send_raw(p, "GET /api/ping HTTP/1.1\r\nHost: a b\r\n\r\n")
        .await
        .unwrap();
    assert_eq!(res.line, "HTTP/1.1 400 Bad Request: malformed Host header");
    assert_eq!(res.body, "400 Bad Request: malformed Host header");

    let res = send_raw(
        p,
        "GET /api/ping HTTP/1.1\r\nHost: 127.0.0.1\r\nHost: 127.0.0.1\r\n\r\n",
    )
    .await
    .unwrap();
    assert_eq!(res.line, "HTTP/1.1 400 Bad Request");
    assert_eq!(res.body, "400 Bad Request");

    // HTTP/1.0 은 Host 가 없어도 된다.
    let res = send_raw(p, "GET /api/ping HTTP/1.0\r\n\r\n").await.unwrap();
    assert_eq!(res.status, 200, "{}", res.line);
    r.shutdown().await;
}

#[test]
fn valid_host_header_table() {
    use crate::run::valid_host_header;
    for h in ["", "example.com:80", "[::1]:8080", "a_b~c!$&'()*+,;=%"] {
        assert!(valid_host_header(h.as_bytes()), "{h}");
    }
    for h in ["a b", "a/b", "a\"b", "a@b", "\u{e9}"] {
        assert!(!valid_host_header(h.as_bytes()), "{h}");
    }
}

// FR-RQG-18: 머리를 보내지 않는 연결은 머리 시한에 닫히고, 응답을 마친 연결은 유휴 시한까지 산다.
#[tokio::test]
async fn run_header_and_idle_timeouts() {
    let r = start(|s| {
        s.rebind.timeouts.read_header = Duration::from_millis(300);
        s.rebind.timeouts.idle = Duration::from_millis(1500);
    })
    .await;
    let p = r.port;

    let mut c = TcpStream::connect(("127.0.0.1", p)).await.unwrap();
    let t0 = Instant::now();
    let mut buf = Vec::new();
    let n = tokio::time::timeout(Duration::from_secs(3), c.read_to_end(&mut buf))
        .await
        .expect("머리 시한에 닫히지 않았다");
    assert!(n.is_ok_and(|n| n == 0) || buf.is_empty());
    assert!(t0.elapsed() >= Duration::from_millis(250));

    let mut c = TcpStream::connect(("127.0.0.1", p)).await.unwrap();
    let req = format!("GET /api/ping HTTP/1.1\r\nHost: 127.0.0.1:{p}\r\n\r\n");
    let read_one = async |c: &mut TcpStream| {
        let mut b = vec![0u8; 4096];
        let n = c.read(&mut b).await.unwrap();
        String::from_utf8_lossy(&b[..n]).into_owned()
    };
    c.write_all(req.as_bytes()).await.unwrap();
    assert!(read_one(&mut c).await.starts_with("HTTP/1.1 200"));
    // 머리 시한보다 길게 쉬어도 유휴 중이면 끊기지 않는다.
    tokio::time::sleep(Duration::from_millis(600)).await;
    c.write_all(req.as_bytes()).await.unwrap();
    assert!(read_one(&mut c).await.starts_with("HTTP/1.1 200"));
    let t1 = Instant::now();
    let mut rest = Vec::new();
    tokio::time::timeout(Duration::from_secs(4), c.read_to_end(&mut rest))
        .await
        .expect("유휴 시한에 닫히지 않았다")
        .unwrap();
    assert!(
        t1.elapsed() >= Duration::from_millis(1200),
        "{:?}",
        t1.elapsed()
    );
    r.shutdown().await;
}

// FR-RQG-19: 종료할 때 진행 중이 아닌 연결은 곧바로 닫히고, run 은 유예 안에 돌아온다.
#[tokio::test]
async fn run_shutdown_closes_idle_connections() {
    let r = start(|_| {}).await;
    let p = r.port;
    let mut c = TcpStream::connect(("127.0.0.1", p)).await.unwrap();
    c.write_all(format!("GET /api/ping HTTP/1.1\r\nHost: 127.0.0.1:{p}\r\n\r\n").as_bytes())
        .await
        .unwrap();
    let mut b = vec![0u8; 1024];
    let n = c.read(&mut b).await.unwrap();
    assert!(String::from_utf8_lossy(&b[..n]).starts_with("HTTP/1.1 200"));
    let t0 = Instant::now();
    r.shutdown().await;
    assert!(t0.elapsed() < Duration::from_secs(2), "{:?}", t0.elapsed());
    let mut rest = Vec::new();
    let n = tokio::time::timeout(Duration::from_secs(1), c.read_to_end(&mut rest))
        .await
        .expect("유휴 연결이 닫히지 않았다");
    assert!(n.is_ok());
}

/// 명시한 루프백은 그 주소에만 리슨한다.
#[test]
fn default_listen_loopback_host_is_v4_only() {
    let p = free_port();
    let ln = crate::rebind::default_listen(&format!("127.0.0.1:{p}")).unwrap();
    assert_eq!(
        ln.local_addr().unwrap(),
        format!("127.0.0.1:{p}").parse().unwrap()
    );
}
