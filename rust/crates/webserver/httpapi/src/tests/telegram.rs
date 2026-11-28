//! `/api/telegram/*` 과 브리지 이음매 (Go `telegram_api_test.go`·`telegram_wire_test.go`).

use std::convert::Infallible;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};

use bytes::Bytes;
use http_body_util::Full;
use hyper_util::rt::TokioIo;
use otter_gocompat::json::RawMessage;
use otter_shared_agentrec::ActivityReport;
use otter_webserver_domain_telegram as telegram;
use otter_webserver_hub::{AttnTracker, CommandBroker, CommandHub};
use otter_webserver_seam_toolaccess::{Error, WorkspaceEntry, WorkspaceReader};
use telegram::Host;

use otter_shared_chatwire as chatwire;
use otter_shared_toolipc::{CHAT_KIND_CHANGED, CHAT_KIND_MSG, ChatEvent, ChatResult};

use super::attnenv::LiveIo;
use super::fakes::{FakeBroker, FakeHub};
use super::peer::FakeChat;
use super::support::{self, call};
use crate::telegram_api::{TelegramHost, TelegramSink, TelegramWire};
use crate::{ChatDaemon, Config, Deps, Server};

const TG_GOOD_TOKEN: &str = "111:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TG_NO_TOPICS_TOKEN: &str = "222:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const TG_BAD_TOKEN: &str = "333:cccccccccccccccccccccccccccccccc";

/// Go `tgFakeAPI`: getMe 만 아는 가짜 Bot API 다. 60147 이상의 loopback 포트에만 붙는다.
async fn tg_fake_api() -> (String, Arc<AtomicI64>, tokio::task::JoinHandle<()>) {
    let hits = Arc::new(AtomicI64::new(0));
    let start = 61000 + (std::process::id() as u16 % 2000);
    for p in (start..64999).chain(60147..start) {
        let Ok(l) = tokio::net::TcpListener::bind(("127.0.0.1", p)).await else {
            continue;
        };
        let h = hits.clone();
        let task = tokio::spawn(async move {
            while let Ok((sock, _)) = l.accept().await {
                let h = h.clone();
                tokio::spawn(async move {
                    let svc = hyper::service::service_fn(move |req: http::Request<_>| {
                        h.fetch_add(1, Ordering::SeqCst);
                        let path = req.uri().path().to_owned();
                        async move {
                            let (status, body) = if path == format!("/bot{TG_GOOD_TOKEN}/getMe") {
                                (
                                    200,
                                    r#"{"ok":true,"result":{"id":9,"is_bot":true,"username":"good_bot","has_topics_enabled":true}}"#,
                                )
                            } else if path == format!("/bot{TG_NO_TOPICS_TOKEN}/getMe") {
                                (
                                    200,
                                    r#"{"ok":true,"result":{"id":9,"is_bot":true,"username":"plain_bot","has_topics_enabled":false}}"#,
                                )
                            } else {
                                (
                                    401,
                                    r#"{"ok":false,"error_code":401,"description":"Unauthorized"}"#,
                                )
                            };
                            let mut res = http::Response::new(Full::new(Bytes::from(body)));
                            *res.status_mut() = http::StatusCode::from_u16(status).unwrap();
                            Ok::<_, Infallible>(res)
                        }
                    });
                    let _ = hyper::server::conn::http1::Builder::new()
                        .serve_connection(TokioIo::new(sock), svc)
                        .await;
                });
            }
        });
        return (format!("http://127.0.0.1:{p}"), hits, task);
    }
    panic!("빈 포트가 없다");
}

struct ApiEnv {
    _dir: tempfile::TempDir,
    srv: Arc<Server>,
}

fn tg_api_server(base: &str) -> ApiEnv {
    let dir = tempfile::tempdir().unwrap();
    let srv = Server::new(
        Config {
            data_dir: dir.path().to_path_buf(),
            telegram_api: base.to_owned(),
            ..Config::default()
        },
        Deps::default(),
    );
    ApiEnv { _dir: dir, srv }
}

async fn tg_do(e: &ApiEnv, method: &str, path: &str, body: &str) -> support::Resp {
    call(
        &e.srv,
        method,
        path,
        &[("Content-Type", "application/json")],
        body,
        support::LOCAL,
    )
    .await
}

fn want_err(r: &support::Resp, status: u16, code: &str) {
    assert_eq!(
        (r.status, r.header("X-Error-Code").as_str()),
        (status, code),
        "{}",
        r.body
    );
}

#[tokio::test]
async fn telegram_api_get_default() {
    let (base, _, _t) = tg_fake_api().await;
    let e = tg_api_server(&base);
    let r = tg_do(&e, "GET", "/api/telegram", "").await;
    assert_eq!(r.status, 200);
    assert_eq!(
        r.body,
        "{\"enabled\":false,\"tokenSet\":false,\"botName\":\"\",\"paired\":false,\"silenceMin\":5,\"pair\":null}\n"
    );
}

/// FR-TGB-3·4: getMe 로 확인한다. 실패는 거절하고, 응답에 token 이 없다.
#[tokio::test]
async fn telegram_api_token() {
    let (base, hits, _t) = tg_fake_api().await;
    let e = tg_api_server(&base);
    let r = tg_do(&e, "PUT", "/api/telegram/token", r#"{"token":"12/../x"}"#).await;
    want_err(&r, 400, "telegram_token_invalid");
    assert_eq!(
        hits.load(Ordering::SeqCst),
        0,
        "모양이 틀린 token 으로 Telegram 을 불렀다"
    );
    let r = tg_do(
        &e,
        "PUT",
        "/api/telegram/token",
        &format!(r#"{{"token":"{TG_BAD_TOKEN}"}}"#),
    )
    .await;
    want_err(&r, 400, "telegram_token_invalid");
    assert_eq!(r.json()["message"], "telegram rejected the token");
    assert!(!r.body.contains(TG_BAD_TOKEN));
    let r = tg_do(
        &e,
        "PUT",
        "/api/telegram/token",
        &format!(r#"{{"token":"{TG_NO_TOPICS_TOKEN}"}}"#),
    )
    .await;
    assert_eq!(
        (r.status, &r.json()["botName"]),
        (200, &serde_json::json!("plain_bot"))
    );
    let r = tg_do(
        &e,
        "PUT",
        "/api/telegram/token",
        &format!(r#"{{"token":"{TG_GOOD_TOKEN}"}}"#),
    )
    .await;
    assert_eq!(r.status, 200);
    assert_eq!(r.json()["tokenSet"], true);
    assert_eq!(r.json()["botName"], "good_bot");
    assert!(!r.body.contains(TG_GOOD_TOKEN));
    assert_eq!(
        tg_do(&e, "GET", "/api/telegram", "").await.json()["tokenSet"],
        true
    );
}

/// Telegram 에 닿지 않으면 502 다.
#[tokio::test]
async fn telegram_api_token_unreachable() {
    // 듣는 이가 없는 주소다. 포트 0 은 연결이 곧바로 실패한다.
    let e = tg_api_server("http://127.0.0.1:0");
    let r = tg_do(
        &e,
        "PUT",
        "/api/telegram/token",
        &format!(r#"{{"token":"{TG_GOOD_TOKEN}"}}"#),
    )
    .await;
    want_err(&r, 502, "telegram_unreachable");
}

#[tokio::test]
async fn telegram_api_enabled_and_silence() {
    let (base, _, _t) = tg_fake_api().await;
    let e = tg_api_server(&base);
    let r = tg_do(&e, "PUT", "/api/telegram/enabled", r#"{"enabled":true}"#).await;
    assert_eq!(
        (r.status, &r.json()["enabled"]),
        (200, &serde_json::json!(true))
    );
    let r = tg_do(&e, "PUT", "/api/telegram/silence", r#"{"minutes":-1}"#).await;
    want_err(&r, 400, "telegram_config_invalid");
    assert_eq!(r.json()["message"], "무음 시간은 0~1440분입니다");
    let r = tg_do(&e, "PUT", "/api/telegram/silence", r#"{"minutes":0}"#).await;
    assert_eq!(
        (r.status, &r.json()["silenceMin"]),
        (200, &serde_json::json!(0))
    );
    let r = tg_do(&e, "PUT", "/api/telegram/silence", "{bad").await;
    want_err(&r, 400, "invalid_json");
}

/// FR-TGB-10·11: 코드는 만든 응답에만 있고, GET 은 만료만 보인다. 해제는 계정과 코드를 지운다.
#[tokio::test]
async fn telegram_api_pair() {
    let (base, _, _t) = tg_fake_api().await;
    let e = tg_api_server(&base);
    let r = tg_do(&e, "POST", "/api/telegram/pair", "").await;
    want_err(&r, 409, "telegram_no_token");
    tg_do(
        &e,
        "PUT",
        "/api/telegram/token",
        &format!(r#"{{"token":"{TG_GOOD_TOKEN}"}}"#),
    )
    .await;
    let r = tg_do(&e, "POST", "/api/telegram/pair", "").await;
    let v = r.json();
    let code = v["code"].as_str().unwrap().to_owned();
    assert_eq!(r.status, 200);
    assert!(
        code.len() == 6 && code.bytes().all(|c| c.is_ascii_digit()),
        "{code}"
    );
    assert!(v["expires"].is_string());
    let r = tg_do(&e, "GET", "/api/telegram", "").await;
    assert!(r.json()["pair"]["expires"].is_string());
    assert!(!r.body.contains(&code));
    let tg = e.srv.tg.as_ref().unwrap();
    tg.st.set_user(42).unwrap();
    let r = tg_do(&e, "DELETE", "/api/telegram/pair", "").await;
    assert_eq!(r.status, 200);
    assert_eq!(r.json()["paired"], false);
    assert!(r.json()["pair"].is_null());
    assert!(!tg.bridge.as_ref().unwrap().pairing().redeem(&code));
}

#[tokio::test]
async fn telegram_api_unavailable() {
    let srv = Server::new(Config::default(), Deps::default());
    let r = call(&srv, "GET", "/api/telegram", &[], "", support::LOCAL).await;
    want_err(&r, 503, "telegram_unavailable");
}

/// FR-TGB-5: token 을 바꾸면 바꾸기 전에 만든 등록 코드도 버린다.
#[tokio::test]
async fn telegram_api_token_change_cancels_pairing() {
    let (base, _, _t) = tg_fake_api().await;
    let e = tg_api_server(&base);
    let tok = format!(r#"{{"token":"{TG_GOOD_TOKEN}"}}"#);
    tg_do(&e, "PUT", "/api/telegram/token", &tok).await;
    let r = tg_do(&e, "POST", "/api/telegram/pair", "").await;
    let code = r.json()["code"].as_str().unwrap().to_owned();
    let r = tg_do(&e, "PUT", "/api/telegram/token", &tok).await;
    assert_eq!(r.status, 200);
    assert!(r.json()["pair"].is_null());
    let tg = e.srv.tg.as_ref().unwrap();
    assert!(!tg.bridge.as_ref().unwrap().pairing().redeem(&code));
}

// ── 이음매 ──────────────────────────────────────────────────────────────────

/// Go `tgRec`: 브리지 자리에 꽂는 기록기다.
#[derive(Default)]
struct TgRec {
    evs: Mutex<Vec<telegram::Event>>,
    attn: Mutex<Vec<String>>,
    chat: AtomicI64,
    posts: Mutex<Vec<telegram::ChatPost>>,
}

impl TelegramSink for TgRec {
    fn on_activity(&self, ev: telegram::Event) {
        self.evs.lock().unwrap().push(ev);
    }
    fn on_attention(&self, tool_id: &str, reason: &str) {
        self.attn
            .lock()
            .unwrap()
            .push(format!("{tool_id}:{reason}"));
    }
    fn on_attention_clear(&self, tool_id: &str) {
        self.attn.lock().unwrap().push(format!("{tool_id}:clear"));
    }
    fn on_tool_gone(&self, tool_id: &str) {
        self.attn.lock().unwrap().push(format!("{tool_id}:gone"));
    }
    fn on_chat_changed(&self) {
        self.chat.fetch_add(1, Ordering::SeqCst);
    }
    fn on_chat_post(&self, p: telegram::ChatPost) {
        self.posts.lock().unwrap().push(p);
    }
}

/// 도구 p1 이 윈도우 "작업창", 탭 "작업탭" 에 있는 색인이다.
struct EntryIndex;

impl WorkspaceReader for EntryIndex {
    fn resolve(&self, id: &str) -> Result<String, Error> {
        Ok(id.to_owned())
    }
    fn resolve_strict(&self, id: &str) -> Result<String, Error> {
        Ok(id.to_owned())
    }
    fn entries(&self) -> Vec<WorkspaceEntry> {
        vec![WorkspaceEntry {
            tool_id: "p1".into(),
            window_name: "작업창".into(),
            tab_name: "작업탭".into(),
            ..Default::default()
        }]
    }
    fn coordinate_of(&self, id: &str) -> Result<String, Error> {
        Ok(id.to_owned())
    }
    fn is_known_tab_id(&self, _: &str) -> bool {
        false
    }
    fn changes(&self) -> otter_shared_pollwait::Changed {
        otter_shared_pollwait::Signal::default().c()
    }
}

struct WireEnv {
    _dir: tempfile::TempDir,
    srv: Arc<Server>,
    rec: Arc<TgRec>,
    tr: Arc<AttnTracker>,
}

/// Go `tgServer`: 도구 p1 과 브리지 기록기를 가진 서버다. 방송은 실제 허브로 가고, 그 허브의
/// 관찰자가 기록기에 잇는다.
fn tg_server(enabled: bool) -> WireEnv {
    let dir = tempfile::tempdir().unwrap();
    let st = Arc::new(telegram::Store::open(dir.path().join("tg.json")));
    st.set_enabled(enabled).unwrap();
    let rec = Arc::new(TgRec::default());
    let hub = CommandHub::new();
    let tr = AttnTracker::new(hub.clone() as Arc<dyn CommandBroker>, 0);
    let io = Arc::new(LiveIo::default());
    io.set_has("p1", true);
    let tools = Arc::new(FakeHub::default());
    tools.seed("p1", "p1");
    let (r2, h2) = (rec.clone(), hub.clone());
    let srv = Server::new_with(
        Config::default(),
        Deps {
            tools: Some(tools),
            commands: Some(hub.clone()),
            attn_tracker: Some(tr.clone()),
            tool_io: Some(io),
            work_index: Some(Arc::new(EntryIndex)),
            ..Deps::default()
        },
        move |s| {
            s.tg = Some(TelegramWire {
                st,
                sink: r2,
                bridge: None,
            });
        },
    );
    srv.wire_telegram_attention(&h2);
    WireEnv {
        _dir: dir,
        srv,
        rec,
        tr,
    }
}

/// FR-TGB-80·81: main 보고는 브리지 사건으로 옮겨진다. 서브에이전트 보고는 넘기지 않는다.
#[tokio::test]
async fn telegram_wire_forwards_main_reports() {
    let e = tg_server(true);
    let input = RawMessage(br#"{"command":"ls"}"#.to_vec());
    let got = e.srv.apply_activity_report(&ActivityReport {
        tool_id: "p1".into(),
        state: "waiting".into(),
        tool: "Bash".into(),
        detail: "ls".into(),
        session_id: "S1".into(),
        hook: "PermissionRequest".into(),
        input: input.clone(),
        input_over: true,
        transcript: "/t/x.jsonl".into(),
        ..Default::default()
    });
    assert_eq!(got, None);
    let evs = e.rec.evs.lock().unwrap().clone();
    assert_eq!(
        evs,
        vec![telegram::Event {
            tool_id: "p1".into(),
            hook: "PermissionRequest".into(),
            tool: "Bash".into(),
            detail: "ls".into(),
            input: input.0,
            input_over: true,
            transcript: "/t/x.jsonl".into(),
        }]
    );
    let got = e.srv.apply_activity_report(&ActivityReport {
        tool_id: "p1".into(),
        state: "working".into(),
        agent_id: "a1".into(),
        session_id: "S1".into(),
        ..Default::default()
    });
    assert_eq!(got, None);
    assert_eq!(
        e.rec.evs.lock().unwrap().len(),
        1,
        "서브에이전트 보고가 넘어갔다"
    );
}

/// FR-TGB-82 · NFR-TGB-1: 꺼져 있으면 넘기지 않는다.
#[tokio::test]
async fn telegram_wire_off_forwards_nothing() {
    let e = tg_server(false);
    e.srv.apply_activity_report(&ActivityReport {
        tool_id: "p1".into(),
        state: "working".into(),
        session_id: "S1".into(),
        ..Default::default()
    });
    assert!(e.rec.evs.lock().unwrap().is_empty());
}

/// FR-TGB-56 · D-TGB-17: 위치는 기기 › 윈도우 › 탭 이다. 노드가 없으면 기기는 호스트 이름이다.
/// FR-TGB-58a: 읽음은 포커스와 같은 해제다.
#[tokio::test]
async fn telegram_host() {
    let e = tg_server(true);
    let h = TelegramHost(Arc::downgrade(&e.srv));
    let host = otter_shared_platform::hostname().unwrap_or_default();
    assert_eq!(
        h.location("p1"),
        telegram::Location {
            device: host.clone(),
            window: "작업창".into(),
            tab: "작업탭".into(),
        }
    );
    assert_eq!(
        h.location("zz"),
        telegram::Location {
            device: host,
            window: String::new(),
            tab: "zz".into(),
        }
    );
    e.srv.attention().signal_attention("p1", "bell");
    assert!(e.tr.attention("p1"));
    h.attend("p1", false);
    assert!(!e.tr.attention("p1"), "읽음으로 알람이 꺼지지 않았다");
    let before = time::OffsetDateTime::now_utc();
    e.srv.browser_in.mark("p1");
    assert!(h.last_browser_input("p1").unwrap() >= before - time::Duration::seconds(1));
}

/// FR-TGB-50·58b·GD-12: PC 알람과 그 해제, 도구를 잊은 것은 허브 관찰자를 거쳐 브리지에 간다.
#[tokio::test]
async fn telegram_wire_attention_observer() {
    let e = tg_server(true);
    e.srv.attention().signal_attention("p1", "bell");
    e.srv.attention().attend("p1", false);
    e.srv.attention().forget("p1");
    assert_eq!(
        *e.rec.attn.lock().unwrap(),
        vec!["p1:bell", "p1:clear", "p1:gone"]
    );
}

/// NFR-TGB-1 · TC-TGB-80: 꺼져 있으면(기본값) 브리지를 띄우고 보고가 와도 Telegram 요청이 0건이다.
#[tokio::test]
async fn telegram_wire_off_sends_no_requests() {
    let (base, hits, _t) = tg_fake_api().await;
    let e = tg_api_server(&base);
    let stop = tokio_util::sync::CancellationToken::new();
    let done = e.srv.start_telegram(stop.clone());
    e.srv.apply_activity_report(&ActivityReport {
        tool_id: "p1".into(),
        state: "waiting".into(),
        hook: "Stop".into(),
        session_id: "S1".into(),
        ..Default::default()
    });
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    stop.cancel();
    done.await.unwrap();
    assert_eq!(hits.load(Ordering::SeqCst), 0);
}

// ISSUE_TREE_CHAT_SRS FR-TGT-1·2: 채팅 토픽 켜기. 전제(켜기·token·허용 계정)와 봇의 토픽 모드를 본다.
#[tokio::test]
async fn telegram_api_chat_topics() {
    let (base, _, _t) = tg_fake_api().await;
    let e = tg_api_server(&base);
    let st = || e.srv.tg.as_ref().unwrap().st.clone();
    let r = tg_do(&e, "PUT", "/api/telegram/topics", r#"{"topics":true}"#).await;
    want_err(&r, 409, "telegram_topics_need_bridge");

    let r = tg_do(
        &e,
        "PUT",
        "/api/telegram/token",
        &format!(r#"{{"token":"{TG_NO_TOPICS_TOKEN}"}}"#),
    )
    .await;
    assert_eq!(r.status, 200, "{}", r.body);
    tg_do(&e, "PUT", "/api/telegram/enabled", r#"{"enabled":true}"#).await;
    st().set_user(42).unwrap();
    let r = tg_do(&e, "PUT", "/api/telegram/topics", r#"{"topics":true}"#).await;
    want_err(&r, 409, "telegram_topics_mode_off");
    assert!(!st().config().chat_topics);

    tg_do(
        &e,
        "PUT",
        "/api/telegram/token",
        &format!(r#"{{"token":"{TG_GOOD_TOKEN}"}}"#),
    )
    .await;
    st().set_user(42).unwrap();
    let r = tg_do(&e, "PUT", "/api/telegram/topics", r#"{"topics":true}"#).await;
    assert_eq!(r.status, 200, "{}", r.body);
    assert!(r.body.contains(r#""chatTopics":true"#), "{}", r.body);
    let r = tg_do(&e, "GET", "/api/telegram", "").await;
    assert!(r.body.contains(r#""chatTopics":true"#), "{}", r.body);

    let r = tg_do(&e, "PUT", "/api/telegram/topics", r#"{"topics":false}"#).await;
    assert_eq!(r.status, 200, "{}", r.body);
    assert!(!r.body.contains("chatTopics"), "{}", r.body);
}

// ── 채팅 토픽 거울 (ISSUE_TREE_CHAT_SRS FR-TGT-3) ─────────────────────────────

/// 채팅 데몬과 브리지 기록기를 가진 서버다.
fn tg_chat_server(chat: Arc<FakeChat>) -> (Arc<Server>, Arc<TgRec>, tempfile::TempDir) {
    let (srv, rec, dir, _cmds) = tg_chat_server_with(chat);
    (srv, rec, dir)
}

/// 방송을 기록하는 허브까지 돌려준다.
fn tg_chat_server_with(
    chat: Arc<FakeChat>,
) -> (Arc<Server>, Arc<TgRec>, tempfile::TempDir, Arc<FakeBroker>) {
    let cmds = Arc::new(FakeBroker::default());
    let dir = tempfile::tempdir().unwrap();
    let st = Arc::new(telegram::Store::open(dir.path().join("tg.json")));
    let rec = Arc::new(TgRec::default());
    let r2 = rec.clone();
    let srv = Server::new_with(
        Config::default(),
        Deps {
            commands: Some(cmds.clone()),
            chat_daemon: Some(chat as Arc<dyn ChatDaemon>),
            ..Deps::default()
        },
        move |s| {
            s.tg = Some(TelegramWire {
                st,
                sink: r2,
                bridge: None,
            });
        },
    );
    (srv, rec, dir, cmds)
}

/// FR-TGT-3: 방을 바꾸는 채팅 연산이 성공하거나, 데몬이 바뀜을 밀거나, 데몬에 다시 붙으면 거울을 맞추게 한다.
/// 읽기·실패한 연산·글은 맞추지 않는다(글은 T-4 가 따로 다룬다).
#[tokio::test]
async fn telegram_chat_changes_reach_bridge() {
    let d = Arc::new(FakeChat {
        ready: true,
        res: ChatResult {
            result: RawMessage(br#"{"ok":true}"#.to_vec()),
            ..Default::default()
        },
        ..Default::default()
    });
    let (srv, rec, _d) = tg_chat_server(d);
    let n = || rec.chat.load(Ordering::SeqCst);
    let body = r#"{"room":"r1"}"#;
    let hdr = [("Content-Type", "application/json")];
    call(&srv, "GET", "/api/chat", &hdr, "", support::LOCAL).await;
    assert_eq!(n(), 0, "읽기가 맞추기를 불렀다");
    let r = call(&srv, "POST", "/api/chat/join", &hdr, body, support::LOCAL).await;
    assert_eq!(r.status, 200);
    assert_eq!(n(), 1);
    srv.chat_pushed(&ChatEvent {
        chat_kind: CHAT_KIND_CHANGED.into(),
        ..Default::default()
    });
    assert_eq!(n(), 2);
    srv.chat_pushed(&ChatEvent {
        chat_kind: CHAT_KIND_MSG.into(),
        ..Default::default()
    });
    assert_eq!(n(), 2, "글이 맞추기를 불렀다");
    srv.chat_resync();
    assert_eq!(n(), 3);
}

/// 데몬이 거절한 연산은 거울을 맞추지 않는다.
#[tokio::test]
async fn telegram_failed_chat_op_does_not_sync() {
    let d = Arc::new(FakeChat {
        ready: true,
        res: ChatResult {
            error: Some(chatwire::Error {
                code: "no_such_room".into(),
                message: "r1".into(),
            }),
            ..Default::default()
        },
        ..Default::default()
    });
    let (srv, rec, _d) = tg_chat_server(d);
    let hdr = [("Content-Type", "application/json")];
    let r = call(
        &srv,
        "POST",
        "/api/chat/join",
        &hdr,
        r#"{"room":"r1"}"#,
        support::LOCAL,
    )
    .await;
    assert_eq!(r.status, 404);
    assert_eq!(rec.chat.load(Ordering::SeqCst), 0);
}

const STATE: &str = r##"{"me":{"id":"fpA-u1","label":"mac/나","kind":"user"},
 "rooms":[
  {"id":"g1","kind":"group","name":"#설계","purpose":"설계 논의","members":3,"joined":true,"notify":"all",
   "people":[{"id":"fpA-u1","label":"mac/나"},{"id":"fpA-a1","label":"mac/설계탭"},{"id":"fpB-a7","label":"office/빌드"}]},
  {"id":"g2","kind":"group","name":"리뷰","purpose":"","members":1,"joined":false},
  {"id":"d1","kind":"direct","purpose":"질문","members":2,"joined":true,
   "people":[{"id":"fpA-u1","label":"mac/나"},{"id":"fpB-a7","label":"office/빌드"}]},
  {"id":"d2","kind":"direct","purpose":"","members":1,"joined":true,
   "people":[{"id":"fpA-u1","label":"mac/나"}]}]}"##;

/// FR-TGT-3·CUX-9: 채팅 상태를 브리지의 보기로 옮긴다. 단체채팅은 `#` 없는 방 이름, 개인채팅은 상대의
/// 표시 이름이고, 상대가 없으면 `개인채팅` 이다. 방마다 내 알림 단계와 참가자 표시 이름을 싣는다.
#[tokio::test]
async fn telegram_host_reads_chat_view() {
    let d = Arc::new(FakeChat {
        ready: true,
        res: ChatResult {
            result: RawMessage(STATE.as_bytes().to_vec()),
            ..Default::default()
        },
        ..Default::default()
    });
    let (srv, _rec, _d) = tg_chat_server(d.clone());
    let host = TelegramHost(Arc::downgrade(&srv));
    let view = host.chat_view().expect("채팅을 읽지 못했다");
    let person = |id: &str, name: &str| telegram::ChatPerson {
        id: id.into(),
        name: name.into(),
        human: false,
    };
    // CHAT_TELEGRAM_UX_SRS V-CTU-73: kind 가 user 인 참가자는 사람이다.
    assert_eq!(
        view.me,
        telegram::ChatPerson {
            human: true,
            ..person("fpA-u1", "나")
        }
    );
    let room =
        |id: &str, name: &str, purpose: &str, members: i64, joined: bool| telegram::ChatRoom {
            id: id.into(),
            name: name.into(),
            purpose: purpose.into(),
            members,
            joined,
            ..Default::default()
        };
    let mut g1 = room("g1", "설계", "설계 논의", 3, true);
    g1.notify = "all".into();
    g1.people = vec![
        person("fpA-u1", "나"),
        person("fpA-a1", "설계탭"),
        person("fpB-a7", "office › 빌드"),
    ];
    let mut d1 = room("d1", "office › 빌드", "질문", 2, true);
    d1.people = vec![person("fpA-u1", "나"), person("fpB-a7", "office › 빌드")];
    let mut d2 = room("d2", "개인채팅", "", 1, true);
    d2.people = vec![person("fpA-u1", "나")];
    assert_eq!(
        view.rooms,
        vec![g1, room("g2", "리뷰", "", 1, false), d1, d2]
    );
    assert_eq!(d.got.lock().unwrap()[0].op, chatwire::OP_STATE);
}

/// 데몬이 없거나, 준비되지 않았거나, 실패하면 방 목록을 모른다(None) — 브리지는 아무것도 지우지 않는다.
#[tokio::test]
async fn telegram_host_view_unknown_without_daemon() {
    let srv = Server::new(Config::default(), Deps::default());
    assert_eq!(TelegramHost(Arc::downgrade(&srv)).chat_view(), None);
    let (srv, _r, _d) = tg_chat_server(Arc::new(FakeChat::default()));
    assert_eq!(TelegramHost(Arc::downgrade(&srv)).chat_view(), None);
    let (srv, _r, _d) = tg_chat_server(Arc::new(FakeChat {
        ready: true,
        err: Some("broken pipe".into()),
        ..Default::default()
    }));
    assert_eq!(TelegramHost(Arc::downgrade(&srv)).chat_view(), None);
}

/// FR-TGT-7: 데몬이 사람에게 민 글은 브리지 글로 옮긴다(부름·시각·보낸 이 그대로).
#[tokio::test]
async fn telegram_pushed_message_reaches_bridge() {
    let (srv, rec, _d) = tg_chat_server(Arc::new(FakeChat::default()));
    srv.chat_pushed(&ChatEvent {
        chat_kind: CHAT_KIND_MSG.into(),
        chat: Some(chatwire::Message {
            id: "m1".into(),
            room: "g1".into(),
            from: "fpB-a7".into(),
            from_label: "office/빌드".into(),
            text: "**확인** 부탁".into(),
            at: 1_700_000_000_123,
            call: vec!["user".into()],
            called: true,
            ..Default::default()
        }),
        ..Default::default()
    });
    assert_eq!(
        rec.posts.lock().unwrap().clone(),
        vec![telegram::ChatPost {
            room: "g1".into(),
            from: "fpB-a7".into(),
            from_label: "office/빌드".into(),
            text: "**확인** 부탁".into(),
            at_ms: 1_700_000_000_123,
            call: vec!["user".into()],
            called: true,
            mine: false,
        }]
    );
}

/// FR-TGT-7: 웹에서 보낸 내 글도 올린다. 데몬이 거절한 글은 올리지 않는다.
#[tokio::test]
async fn telegram_my_sent_message_reaches_bridge() {
    let ok = Arc::new(FakeChat {
        ready: true,
        res: ChatResult {
            result: RawMessage(br#"{"ok":true}"#.to_vec()),
            ..Default::default()
        },
        ..Default::default()
    });
    let (srv, rec, _d) = tg_chat_server(ok);
    let hdr = [("Content-Type", "application/json")];
    let body = r#"{"room":"g1","text":"안녕","call":["fpB-a7"]}"#;
    let r = call(&srv, "POST", "/api/chat/send", &hdr, body, support::LOCAL).await;
    assert_eq!(r.status, 200);
    let posts = rec.posts.lock().unwrap().clone();
    assert_eq!(posts.len(), 1);
    let p = &posts[0];
    assert_eq!(
        (
            p.room.as_str(),
            p.text.as_str(),
            p.call.clone(),
            p.mine,
            p.called
        ),
        ("g1", "안녕", vec!["fpB-a7".to_string()], true, false)
    );
    assert!(p.at_ms > 0);
    let r = call(
        &srv,
        "POST",
        "/api/chat/join",
        &hdr,
        r#"{"room":"g1"}"#,
        support::LOCAL,
    )
    .await;
    assert_eq!(r.status, 200);
    assert_eq!(
        rec.posts.lock().unwrap().len(),
        1,
        "send 아닌 연산이 글을 올렸다"
    );
    let bad = Arc::new(FakeChat {
        ready: true,
        res: ChatResult {
            error: Some(chatwire::Error {
                code: "not_in_room".into(),
                message: "g1".into(),
            }),
            ..Default::default()
        },
        ..Default::default()
    });
    let (srv, rec, _d) = tg_chat_server(bad);
    let r = call(&srv, "POST", "/api/chat/send", &hdr, body, support::LOCAL).await;
    assert_eq!(r.status, 409);
    assert!(rec.posts.lock().unwrap().is_empty());
}

/// FR-TGT-6·9: 토픽의 단추와 글은 데몬의 사람 참가자 연산이다. 성공하면 화면과 거울을 다시 맞추게 한다.
#[tokio::test]
async fn telegram_host_chat_ops() {
    let d = Arc::new(FakeChat {
        ready: true,
        res: ChatResult {
            result: RawMessage(br#"{"ok":true}"#.to_vec()),
            ..Default::default()
        },
        ..Default::default()
    });
    let (srv, rec, _d) = tg_chat_server(d.clone());
    let host = TelegramHost(Arc::downgrade(&srv));
    assert_eq!(host.chat_join("r1", true), Ok(()));
    assert_eq!(host.chat_join("r1", false), Ok(()));
    assert_eq!(
        host.chat_send("r1", "안녕", &["fpB-a7".to_string()]),
        Ok(())
    );
    assert_eq!(host.chat_send("r1", "둘", &[]), Ok(()));
    let got: Vec<(String, String)> = d
        .got
        .lock()
        .unwrap()
        .iter()
        .filter(|p| p.op != chatwire::OP_STATE)
        .map(|p| (p.op.clone(), String::from_utf8(p.args.0.clone()).unwrap()))
        .collect();
    assert_eq!(
        got,
        vec![
            (
                chatwire::OP_JOIN.to_string(),
                r#"{"room":"r1"}"#.to_string()
            ),
            (
                chatwire::OP_LEAVE.to_string(),
                r#"{"room":"r1"}"#.to_string()
            ),
            (
                chatwire::OP_SEND.to_string(),
                r#"{"room":"r1","text":"안녕","call":["fpB-a7"]}"#.to_string()
            ),
            (
                chatwire::OP_SEND.to_string(),
                r#"{"room":"r1","text":"둘"}"#.to_string()
            ),
        ]
    );
    assert_eq!(rec.chat.load(Ordering::SeqCst), 4);
    assert!(
        rec.posts.lock().unwrap().is_empty(),
        "토픽에서 온 글을 토픽에 되올렸다"
    );
}

/// 데몬이 없거나 거절하면 오류다. 거울은 맞추지 않는다.
#[tokio::test]
async fn telegram_host_chat_ops_fail() {
    let srv = Server::new(Config::default(), Deps::default());
    let host = TelegramHost(Arc::downgrade(&srv));
    assert!(host.chat_join("r1", true).is_err());
    let d = Arc::new(FakeChat {
        ready: true,
        res: ChatResult {
            error: Some(chatwire::Error {
                code: "not_in_room".into(),
                message: "r1".into(),
            }),
            ..Default::default()
        },
        ..Default::default()
    });
    let (srv, rec, _d) = tg_chat_server(d);
    let host = TelegramHost(Arc::downgrade(&srv));
    assert_eq!(
        host.chat_send("r1", "x", &[]),
        Err("not_in_room".to_string())
    );
    assert_eq!(host.chat_join("r1", true), Err("not_in_room".to_string()));
    let (srv, _r, _d) = tg_chat_server(Arc::new(FakeChat {
        ready: true,
        err: Some("broken pipe".into()),
        ..Default::default()
    }));
    assert!(
        TelegramHost(Arc::downgrade(&srv))
            .chat_send("r1", "x", &[])
            .is_err()
    );
    assert_eq!(rec.chat.load(Ordering::SeqCst), 0);
}

/// FR-TGT-9: 토픽에서 쓴 글이 방에 닿으면 웹 채팅 창에도 내 글로 보인다(`chat_message`, 보낸 이 = 나).
/// 단추(join·leave)와 실패한 글은 방송하지 않는다.
#[tokio::test]
async fn telegram_sent_message_shows_on_web_as_mine() {
    let d = Arc::new(FakeChat {
        ready: true,
        res: ChatResult {
            result: RawMessage(
                br#"{"ok":true,"me":{"id":"fpA-u1","label":"mac/me","kind":"user"}}"#.to_vec(),
            ),
            ..Default::default()
        },
        ..Default::default()
    });
    let (srv, _rec, _d, cmds) = tg_chat_server_with(d);
    let host = TelegramHost(Arc::downgrade(&srv));
    host.chat_join("r1", true).unwrap();
    assert!(cmds.published().iter().all(|p| !p.contains("chat_message")));
    host.chat_send("r1", "안녕 <b>", &["fpB-a7".to_string()])
        .unwrap();
    let msgs: Vec<serde_json::Value> = cmds
        .published()
        .iter()
        .map(|p| serde_json::from_str::<serde_json::Value>(p).unwrap())
        .filter(|v| v["action"] == "chat_message")
        .collect();
    assert_eq!(msgs.len(), 1);
    let m = &msgs[0]["args"]["msg"];
    assert_eq!(m["room"], "r1");
    assert_eq!(m["from"], "fpA-u1");
    assert_eq!(m["fromLabel"], "mac/me");
    assert_eq!(m["fromKind"], "user");
    assert_eq!(m["text"], "안녕 <b>");
    assert_eq!(m["call"], serde_json::json!(["fpB-a7"]));
    assert!(m["id"].as_str().unwrap().starts_with("tg-"));
    assert!(m["at"].as_i64().unwrap() > 0);
    assert!(m.get("called").is_none());
}

/// CHAT_TELEGRAM_UX_SRS FR-CTU-23·26: 메뉴의 방 만들기와 개인채팅은 데몬의 create·direct 다. 성공하면 거울을 맞추게 한다.
#[tokio::test]
async fn telegram_host_create_and_direct() {
    let d = Arc::new(FakeChat {
        ready: true,
        res: ChatResult {
            result: RawMessage(br#"{"ok":true}"#.to_vec()),
            ..Default::default()
        },
        ..Default::default()
    });
    let (srv, rec, _d) = tg_chat_server(d.clone());
    let host = TelegramHost(Arc::downgrade(&srv));
    assert_eq!(host.chat_create("배포", "점검"), Ok(()));
    assert_eq!(host.chat_direct("fpB-a7"), Ok(()));
    let got: Vec<(String, String)> = d
        .got
        .lock()
        .unwrap()
        .iter()
        .map(|p| (p.op.clone(), String::from_utf8(p.args.0.clone()).unwrap()))
        .collect();
    assert_eq!(
        got,
        vec![
            (
                chatwire::OP_CREATE.to_string(),
                r#"{"name":"배포","purpose":"점검"}"#.to_string()
            ),
            (
                chatwire::OP_DIRECT.to_string(),
                r#"{"participant":"fpB-a7","purpose":""}"#.to_string()
            ),
        ]
    );
    assert_eq!(rec.chat.load(Ordering::SeqCst), 2);
}

const ONLINE: &str = r#"{"nodes":[{"fp":"fpA","name":"mac","online":true,"self":true},
  {"fp":"fpB","name":"office","online":true,"self":false}],
 "participants":[
  {"id":"fpA-u1","label":"mac/나","kind":"user","node":"fpA","online":true},
  {"id":"fpB-a7","label":"office/빌드","kind":"agent","node":"fpB","online":true},
  {"id":"fpB-a8","label":"office/쉼","kind":"agent","node":"fpB","online":false},
  {"id":"fpC-u9","label":"lab/User","kind":"user","node":"fpC","online":true}]}"#;

/// CHAT_TELEGRAM_UX_SRS FR-CTU-25: 접속자는 online 연산에서 접속한 참가자만 옮긴다. 이름은 표시 이름(FR-CUX-9),
/// 노드는 노드 이름(모르면 지문), 사람인지는 종류로 정한다.
#[tokio::test]
async fn telegram_host_reads_online() {
    let d = Arc::new(FakeChat {
        ready: true,
        res: ChatResult {
            result: RawMessage(ONLINE.as_bytes().to_vec()),
            ..Default::default()
        },
        ..Default::default()
    });
    let (srv, _rec, _d) = tg_chat_server(d.clone());
    let host = TelegramHost(Arc::downgrade(&srv));
    let o = |id: &str, name: &str, node: &str, human: bool| telegram::ChatOnline {
        id: id.into(),
        name: name.into(),
        node: node.into(),
        human,
    };
    assert_eq!(
        host.chat_online(),
        Some(vec![
            o("fpA-u1", "나", "mac", true),
            o("fpB-a7", "office › 빌드", "office", false),
            o("fpC-u9", "lab › User", "fpC", true),
        ])
    );
    assert_eq!(d.got.lock().unwrap()[0].op, chatwire::OP_ONLINE);
    let srv = Server::new(Config::default(), Deps::default());
    assert_eq!(TelegramHost(Arc::downgrade(&srv)).chat_online(), None);
}

/// CHAT_TELEGRAM_UX_SRS V-CTU-32: 알림 켜고 끄기. 전제 없이 저장하고, 꺼짐일 때만 화면 값에 싣는다.
#[tokio::test]
async fn telegram_api_alarms() {
    let (base, _, _t) = tg_fake_api().await;
    let e = tg_api_server(&base);
    let st = || e.srv.tg.as_ref().unwrap().st.clone();
    let r = tg_do(&e, "GET", "/api/telegram", "").await;
    assert!(!r.body.contains("alarmsOff"), "{}", r.body);
    let r = tg_do(&e, "PUT", "/api/telegram/alarms", r#"{"alarms":false}"#).await;
    assert_eq!(r.status, 200, "{}", r.body);
    assert!(r.body.contains(r#""alarmsOff":true"#), "{}", r.body);
    assert!(st().config().alarms_off);
    let r = tg_do(&e, "PUT", "/api/telegram/alarms", r#"{"alarms":true}"#).await;
    assert_eq!(r.status, 200, "{}", r.body);
    assert!(!r.body.contains("alarmsOff"), "{}", r.body);
    assert!(!st().config().alarms_off);
}
