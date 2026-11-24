//! `/api/lsp/*` (Go `handlers_lsp_test.go`·`handlers_lsp_ws_test.go`).

use std::collections::HashMap;
use std::io;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use super::wsc::Message;
use futures_util::future::BoxFuture;
use futures_util::{SinkExt, StreamExt};
use otter_webserver_domain_ext as ext;
use otter_webserver_domain_lsp::{FileEvent, OpenError, PathsError, Tunnel};

use super::fsenv::{FakeWork, qe, seed_root, temp_dir};
use super::support::{self, call};
use super::ws::listen;
use crate::lsp_api::lsp_ws_reason;
use crate::{Config, Deps, LspService, Server};

/// Go `fakeTunnel`.
pub(crate) struct FakeTunnel {
    sent_tx: Mutex<mpsc::Sender<Vec<u8>>>,
    pub(crate) sent: Mutex<mpsc::Receiver<Vec<u8>>>,
    pub(crate) out: Mutex<mpsc::Sender<Vec<u8>>>,
    out_rx: Mutex<mpsc::Receiver<Vec<u8>>>,
    pub(crate) closed: AtomicBool,
}

impl FakeTunnel {
    pub(crate) fn new() -> Arc<FakeTunnel> {
        let (st, sr) = mpsc::channel();
        let (ot, or) = mpsc::channel();
        Arc::new(FakeTunnel {
            sent_tx: Mutex::new(st),
            sent: Mutex::new(sr),
            out: Mutex::new(ot),
            out_rx: Mutex::new(or),
            closed: AtomicBool::new(false),
        })
    }

    /// 프로세스가 끝난 것처럼 recv 를 깨운다.
    fn end(&self) {
        self.closed.store(true, Ordering::SeqCst);
    }

    fn recv_sent(&self) -> Option<Vec<u8>> {
        self.sent
            .lock()
            .unwrap()
            .recv_timeout(Duration::from_secs(5))
            .ok()
    }
}

impl Tunnel for FakeTunnel {
    fn send(&self, body: &[u8]) -> io::Result<()> {
        if self.closed.load(Ordering::SeqCst) {
            return Err(io::Error::other("closed"));
        }
        let _ = self.sent_tx.lock().unwrap().send(body.to_vec());
        Ok(())
    }

    fn recv(&self) -> io::Result<Vec<u8>> {
        let rx = self.out_rx.lock().unwrap();
        loop {
            if self.closed.load(Ordering::SeqCst) {
                return Err(io::Error::other("closed"));
            }
            if let Ok(b) = rx.recv_timeout(Duration::from_millis(10)) {
                return Ok(b);
            }
        }
    }

    fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
    }

    fn last_use(&self) -> SystemTime {
        SystemTime::now()
    }
}

/// Go `fakeLSP`.
#[derive(Default)]
pub(crate) struct FakeLsp {
    pub(crate) statuses: Vec<ext::Status>,
    pub(crate) problems: Vec<String>,
    pub(crate) outcome: ext::Outcome,
    pub(crate) install_id: Mutex<String>,
    pub(crate) paths: Mutex<HashMap<String, String>>,
    pub(crate) set_paths: Mutex<HashMap<String, String>>,
    pub(crate) set_err: Option<PathsError>,
    pub(crate) tunnel: Option<Arc<FakeTunnel>>,
    pub(crate) tunnel_err: Option<OpenError>,
    pub(crate) tunnel_opened: AtomicUsize,
}

impl LspService for FakeLsp {
    fn notify_files(&self, _events: Vec<FileEvent>) {}

    fn status(&self) -> (Vec<ext::Status>, Vec<String>) {
        (self.statuses.clone(), self.problems.clone())
    }

    fn open_tunnel(&self, _root: &str, _desc_id: &str) -> Result<Arc<dyn Tunnel>, OpenError> {
        self.tunnel_opened.fetch_add(1, Ordering::SeqCst);
        if let Some(e) = &self.tunnel_err {
            return Err(e.clone());
        }
        Ok(self.tunnel.clone().expect("통로가 없다"))
    }

    fn paths(&self) -> HashMap<String, String> {
        self.paths.lock().unwrap().clone()
    }

    fn set_paths(
        &self,
        next: HashMap<String, String>,
    ) -> Result<HashMap<String, String>, PathsError> {
        *self.set_paths.lock().unwrap() = next.clone();
        if let Some(e) = &self.set_err {
            return Err(e.clone());
        }
        *self.paths.lock().unwrap() = next.clone();
        Ok(next)
    }

    fn install<'a>(&'a self, _ctx: &'a ext::Ctx, pack_id: &'a str) -> BoxFuture<'a, ext::Outcome> {
        *self.install_id.lock().unwrap() = pack_id.to_owned();
        let out = self.outcome.clone();
        Box::pin(async move { out })
    }
}

fn lsp_server(f: Arc<FakeLsp>) -> (tempfile::TempDir, Arc<Server>) {
    let dir = tempfile::tempdir().unwrap();
    let srv = support::server(
        dir.path(),
        Deps {
            lsp: Some(f),
            ..Deps::default()
        },
    );
    (dir, srv)
}

async fn put_json(srv: &Arc<Server>, target: &str, body: &str) -> support::Resp {
    call(
        srv,
        "PUT",
        target,
        &[("Content-Type", "application/json")],
        body,
        support::LOCAL,
    )
    .await
}

/// TC-LSP-30 (FR-LSP-46): 상태 조회가 서술자 목록을 돌려준다.
#[tokio::test]
async fn lsp_status() {
    let f = Arc::new(FakeLsp {
        statuses: vec![
            ext::Status {
                pack: "gopls".into(),
                id: "gopls".into(),
                langs: vec!["go".into()],
                found: true,
                exe: "/usr/bin/gopls".into(),
                origin: "path".into(),
                ..Default::default()
            },
            ext::Status {
                pack: "pyright".into(),
                id: "pyright".into(),
                ..Default::default()
            },
        ],
        ..Default::default()
    });
    let (_d, srv) = lsp_server(f);
    let r = support::post_json(&srv, "/api/lsp/status", "{}").await;
    assert_eq!(r.status, 200);
    let v = r.json();
    assert_eq!(v["servers"].as_array().unwrap().len(), 2);
    assert_eq!(v["servers"][0]["origin"], "path");
    assert!(v.get("problems").is_none());
}

/// 빈 목록은 Go 의 nil 이라 `null` 이고, 읽지 못한 선언은 `problems` 로 싣는다 (FR-EXT-8).
#[tokio::test]
async fn lsp_status_empty_is_null_and_problems() {
    let f = Arc::new(FakeLsp {
        problems: vec!["x.json: 깨졌다".into()],
        ..Default::default()
    });
    let (_d, srv) = lsp_server(f);
    let r = support::post_json(&srv, "/api/lsp/status", "").await;
    assert_eq!(
        r.body,
        "{\"problems\":[\"x.json: 깨졌다\"],\"servers\":null}\n"
    );
}

/// REPO_FIX 02 §3A-3: 경로 표는 서버가 보관한다 — 조회 GET, 저장 PUT(전체 교체).
#[tokio::test]
async fn lsp_paths_get_put() {
    let f = Arc::new(FakeLsp::default());
    f.paths
        .lock()
        .unwrap()
        .insert("gopls/gopls".into(), "/opt/gopls".into());
    let (_d, srv) = lsp_server(f.clone());
    let r = support::get(&srv, "/api/lsp/paths").await;
    assert_eq!(r.status, 200);
    assert_eq!(r.json()["paths"]["gopls/gopls"], "/opt/gopls");
    let r = put_json(
        &srv,
        "/api/lsp/paths",
        r#"{"paths":{"gopls/gopls":"/usr/local/bin/gopls"}}"#,
    )
    .await;
    assert_eq!(r.status, 200);
    assert_eq!(
        f.set_paths.lock().unwrap()["gopls/gopls"],
        "/usr/local/bin/gopls"
    );
    assert_eq!(
        r.body,
        "{\"paths\":{\"gopls/gopls\":\"/usr/local/bin/gopls\"}}\n"
    );
}

/// 빈 표는 빈 객체다.
#[tokio::test]
async fn lsp_paths_empty_is_object() {
    let (_d, srv) = lsp_server(Arc::new(FakeLsp::default()));
    assert_eq!(
        support::get(&srv, "/api/lsp/paths").await.body,
        "{\"paths\":{}}\n"
    );
}

/// 거부 코드: 상대경로 400 path_must_be_absolute, 저장 실패 500 save_failed, 깨진 JSON 400.
#[tokio::test]
async fn lsp_paths_put_errors() {
    let cases = [
        (
            Some(PathsError::NotAbsolute("y".into())),
            r#"{"paths":{"x":"y"}}"#,
            400,
            "path_must_be_absolute",
        ),
        (
            Some(PathsError::Save("디스크".into())),
            r#"{"paths":{"x":"y"}}"#,
            500,
            "save_failed",
        ),
        (None, "{", 400, "bad_request"),
    ];
    for (err, body, status, code) in cases {
        let f = Arc::new(FakeLsp {
            set_err: err,
            ..Default::default()
        });
        let (_d, srv) = lsp_server(f);
        let r = put_json(&srv, "/api/lsp/paths", body).await;
        assert_eq!(
            (r.status, r.header("X-Error-Code").as_str()),
            (status, code)
        );
    }
}

/// 본문이 상한을 넘으면 413 body_too_large 이고 연결을 닫지 않는다 (FR-OPT-1-10).
#[tokio::test]
async fn lsp_body_too_large() {
    let (_d, srv) = lsp_server(Arc::new(FakeLsp::default()));
    let big = format!(
        r#"{{"id":"{}"}}"#,
        "x".repeat(otter_shared_httpreq::SMALL_LIMIT as usize)
    );
    let r = support::post_json(&srv, "/api/lsp/install", &big).await;
    assert_eq!(r.status, 413);
    assert_eq!(r.header("X-Error-Code"), "body_too_large");
    assert_eq!(r.header("Connection"), "");
    assert_eq!(r.json()["error"], "body too large");
}

/// TC-LSP-32 (FR-LSP-8·10): 설치는 id 를 받아 결과를 돌려준다. 실패도 200 으로 사유와 함께 온다.
#[tokio::test]
async fn lsp_install() {
    let f = Arc::new(FakeLsp {
        outcome: ext::Outcome {
            reason: "go 가 이 기계에 없어…".into(),
            ..Default::default()
        },
        ..Default::default()
    });
    let (_d, srv) = lsp_server(f.clone());
    let r = support::post_json(&srv, "/api/lsp/install", r#"{"id":"gopls"}"#).await;
    assert_eq!(r.status, 200);
    assert_eq!(*f.install_id.lock().unwrap(), "gopls");
    assert_eq!(
        r.body,
        "{\"ok\":false,\"reason\":\"go 가 이 기계에 없어…\"}\n"
    );
}

/// TC-LSP-33 (FR-LSP-8): id 없는 설치는 거절된다.
#[tokio::test]
async fn lsp_install_needs_id() {
    let (_d, srv) = lsp_server(Arc::new(FakeLsp::default()));
    for body in ["{}", "[", r#"{"id":""}"#] {
        let r = support::post_json(&srv, "/api/lsp/install", body).await;
        assert_eq!(r.status, 400);
        assert_eq!(r.json()["error"], "id required");
    }
}

/// TC-LSP-34: LSP 가 배선되지 않은 서버는 503 이며, 그 밖의 동작에는 영향이 없다.
#[tokio::test]
async fn lsp_unwired_is_503() {
    let dir = tempfile::tempdir().unwrap();
    let srv = support::server(dir.path(), Deps::default());
    for path in ["/api/lsp/status", "/api/lsp/install"] {
        let r = support::post_json(&srv, path, r#"{"id":"gopls"}"#).await;
        assert_eq!(r.status, 503, "{path}");
    }
    assert_eq!(support::get(&srv, "/api/ping").await.status, 200);
}

#[test]
fn lsp_ws_reason_cuts_on_char_boundary() {
    let long = "가".repeat(100);
    let r = lsp_ws_reason(&long);
    assert!(r.len() <= 123 && !r.is_empty() && long.starts_with(r));
    assert_eq!(lsp_ws_reason("짧다"), "짧다");
}

// ── WS ───────────────────────────────────────────────────────────────────────

type Client = super::wsc::Client;

struct WsEnv {
    _keep: Vec<tempfile::TempDir>,
    root: String,
    port: u16,
    f: Arc<FakeLsp>,
}

async fn ws_env(f: FakeLsp, read_limit: Option<usize>) -> WsEnv {
    let (rd, root) = temp_dir();
    let data = tempfile::tempdir().unwrap();
    let ws = Arc::new(FakeWork::default());
    seed_root(&ws, &root);
    let f = Arc::new(f);
    let srv = Server::new_with(
        Config {
            data_dir: data.path().to_path_buf(),
            ..Config::default()
        },
        Deps {
            lsp: Some(f.clone()),
            work: Some(ws),
            ..Deps::default()
        },
        |s| {
            if let Some(n) = read_limit {
                s.lsp_ws_read_limit = n;
            }
        },
    );
    let port = listen(srv).await;
    WsEnv {
        _keep: vec![rd, data],
        root,
        port,
        f,
    }
}

/// 업그레이드를 시도한다. 실패면 HTTP 상태를 돌려준다.
async fn dial_ws(e: &WsEnv, root: &str, server: &str, origin: Option<&str>) -> Result<Client, u16> {
    let path = format!("/api/lsp/ws?root={}&server={}", qe(root), qe(server));
    let extra: Vec<(&str, &str)> = origin.map(|o| ("Origin", o)).into_iter().collect();
    let d = super::wsc::dial_with(e.port, &path, Some(super::wsc::OFFER), &extra).await;
    d.client.ok_or(d.status)
}

/// 닫힘 프레임의 (code, reason) 이다.
async fn close_of(c: &mut Client) -> (u16, String) {
    loop {
        match tokio::time::timeout(Duration::from_secs(5), c.next()).await {
            Ok(Some(Ok(Message::Close(Some(f))))) => return (f.code, f.reason),
            Ok(Some(Ok(Message::Close(None)))) => return (1005, String::new()),
            Ok(Some(Ok(_))) => continue,
            other => panic!("닫힘이 오지 않았다: {other:?}"),
        }
    }
}

async fn wait_closed(t: &FakeTunnel, what: &str) {
    for _ in 0..500 {
        if t.closed.load(Ordering::SeqCst) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("{what}");
}

fn with_tunnel(t: &Arc<FakeTunnel>) -> FakeLsp {
    FakeLsp {
        tunnel: Some(t.clone()),
        ..Default::default()
    }
}

/// FR-CMR-100·101: 메시지가 양쪽으로 그대로 오간다.
#[tokio::test]
async fn lsp_ws_relays_both_ways() {
    let t = FakeTunnel::new();
    let e = ws_env(with_tunnel(&t), None).await;
    let mut c = dial_ws(&e, &e.root, "gopls/gopls", None).await.unwrap();
    c.send(Message::text(r#"{"id":1}"#)).await.unwrap();
    let t2 = t.clone();
    let got = tokio::task::spawn_blocking(move || t2.recv_sent())
        .await
        .unwrap();
    assert_eq!(got.as_deref(), Some(&br#"{"id":1}"#[..]));
    t.out
        .lock()
        .unwrap()
        .send(br#"{"id":1,"result":{}}"#.to_vec())
        .unwrap();
    let msg = tokio::time::timeout(Duration::from_secs(5), c.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(
        matches!(&msg, Message::Text(t) if t.as_ref() == br#"{"id":1,"result":{}}"#),
        "{msg:?}"
    );
    // 바이너리는 버린다.
    c.send(Message::binary(vec![1, 2])).await.unwrap();
    c.send(Message::text("next")).await.unwrap();
    let t2 = t.clone();
    let got = tokio::task::spawn_blocking(move || t2.recv_sent())
        .await
        .unwrap();
    assert_eq!(got.as_deref(), Some(&b"next"[..]));
}

/// 브라우저가 닫으면 통로도 닫는다.
#[tokio::test]
async fn lsp_ws_client_close_closes_tunnel() {
    let t = FakeTunnel::new();
    let e = ws_env(with_tunnel(&t), None).await;
    let mut c = dial_ws(&e, &e.root, "gopls/gopls", None).await.unwrap();
    c.close(1000, "").await.unwrap();
    wait_closed(&t, "연결이 닫혔는데 통로가 남았다").await;
}

/// FR-CMR-103: 프로세스가 끝나면 4003 ended 로 닫는다.
#[tokio::test]
async fn lsp_ws_process_exit_closes_socket() {
    let t = FakeTunnel::new();
    let e = ws_env(with_tunnel(&t), None).await;
    let mut c = dial_ws(&e, &e.root, "gopls/gopls", None).await.unwrap();
    t.end();
    assert_eq!(close_of(&mut c).await, (4003, "ended".to_owned()));
}

/// FR-CMR-102: 상한이면 4001 limit 로 닫는다 — 업그레이드 뒤 close code 로 알린다.
#[tokio::test]
async fn lsp_ws_limit_close() {
    let e = ws_env(
        FakeLsp {
            tunnel_err: Some(OpenError::Limit),
            ..Default::default()
        },
        None,
    )
    .await;
    let mut c = dial_ws(&e, &e.root, "gopls/gopls", None).await.unwrap();
    assert_eq!(close_of(&mut c).await, (4001, "limit".to_owned()));
}

/// 기동 실패는 4002 이고 사유를 싣는다 — 123바이트 안의 온전한 UTF-8 이다.
#[tokio::test]
async fn lsp_ws_start_failure_close() {
    let long = "가".repeat(100);
    let e = ws_env(
        FakeLsp {
            tunnel_err: Some(OpenError::Other(long.clone())),
            ..Default::default()
        },
        None,
    )
    .await;
    let mut c = dial_ws(&e, &e.root, "gopls/gopls", None).await.unwrap();
    let (code, reason) = close_of(&mut c).await;
    assert_eq!(code, 4002);
    assert!(!reason.is_empty() && reason.len() <= 123 && long.starts_with(&reason));
}

/// FR-CMR-104: 상한을 넘는 메시지가 오면 1009 로 닫고 통로도 닫는다.
#[tokio::test]
async fn lsp_ws_read_limit() {
    let t = FakeTunnel::new();
    let e = ws_env(with_tunnel(&t), Some(64)).await;
    let mut c = dial_ws(&e, &e.root, "gopls/gopls", None).await.unwrap();
    c.send(Message::text("x".repeat(65))).await.unwrap();
    // 상한을 넘으면 연결이 끝난다. 라이브러리는 읽기 오류 뒤 쓰기를 막아 1009 를 싣지 못한다 (D-12).
    let end = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match c.next().await {
                Some(Ok(Message::Close(_))) | Some(Err(_)) | None => return,
                Some(Ok(_)) => continue,
            }
        }
    })
    .await;
    assert!(end.is_ok(), "상한을 넘은 연결이 끝나지 않았다");
    wait_closed(&t, "상한을 넘은 연결의 통로가 남았다").await;
    assert!(t.sent.lock().unwrap().try_recv().is_err());
}

/// FR-CMR-100: 다른 출처는 업그레이드 전에 막히고 프로세스를 띄우지 않는다.
#[tokio::test]
async fn lsp_ws_cross_origin_rejected() {
    let t = FakeTunnel::new();
    let e = ws_env(with_tunnel(&t), None).await;
    let got = dial_ws(&e, &e.root, "gopls/gopls", Some("https://evil.example")).await;
    assert_eq!(got.err(), Some(403));
    assert_eq!(e.f.tunnel_opened.load(Ordering::SeqCst), 0);
}

/// 루트·서술자가 틀리면 업그레이드 전에 HTTP 로 거절하고 통로를 열지 않는다.
#[tokio::test]
async fn lsp_ws_bad_request() {
    let t = FakeTunnel::new();
    let e = ws_env(with_tunnel(&t), None).await;
    let root = e.root.clone();
    for (r, s) in [
        (root.as_str(), ""),
        ("", "gopls/gopls"),
        ("/not/registered", "gopls/gopls"),
    ] {
        let got = dial_ws(&e, r, s, None).await;
        assert!(matches!(got, Err(code) if code >= 400), "{r} {s}");
    }
    assert_eq!(e.f.tunnel_opened.load(Ordering::SeqCst), 0);
}

/// TC-CH6-4: 편집기 LSP WebSocket 도 같은 구현으로 압축을 협상하고, 제안이 없으면 400 이다.
#[tokio::test]
async fn lsp_ws_negotiates_deflate_and_requires_offer() {
    let t = FakeTunnel::new();
    let e = ws_env(with_tunnel(&t), None).await;
    let path = format!(
        "/api/lsp/ws?root={}&server={}",
        qe(&e.root),
        qe("gopls/gopls")
    );
    let d = super::wsc::dial_with(e.port, &path, Some(super::wsc::OFFER), &[]).await;
    assert_eq!(d.status, 101);
    let ext = d.header("Sec-WebSocket-Extensions").unwrap_or_default();
    assert!(ext.starts_with("permessage-deflate"), "{ext}");
    let d = super::wsc::dial_with(e.port, &path, None, &[]).await;
    assert_eq!(d.status, 400);
}
