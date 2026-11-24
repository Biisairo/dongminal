//! `/api/chat`·`/api/edges`·`/api/profile` (Go `chat_api_test.go`·`edge_node_test.go`).

use std::sync::{Arc, Mutex};

use otter_gocompat::json::RawMessage;
use otter_shared_chatwire as chatwire;
use otter_shared_toolipc::{
    CHAT_KIND_CHANGED, CHAT_KIND_MSG, ChatEvent, ChatParams, ChatResult, EdgeParams,
    EdgePortParams, EdgeRef, EdgeResult, EdgesEvent,
};
use tokio_util::sync::CancellationToken;

use super::fakes::FakeBroker;
use super::support::{self, call};
use crate::{ChatDaemon, Deps, EdgeDaemon, Server};

/// Go `fakeChatDaemon`.
#[derive(Default)]
pub(crate) struct FakeChat {
    pub(crate) ready: bool,
    pub(crate) got: Mutex<Vec<ChatParams>>,
    pub(crate) res: ChatResult,
    pub(crate) err: Option<String>,
}

impl ChatDaemon for FakeChat {
    fn chat_ready(&self) -> bool {
        self.ready
    }
    fn chat(&self, p: ChatParams) -> Result<ChatResult, String> {
        self.got.lock().unwrap().push(p);
        match &self.err {
            Some(e) => Err(e.clone()),
            None => Ok(self.res.clone()),
        }
    }
}

/// 노드 데몬의 가짜다. 받은 연산을 적고 정해진 답을 낸다.
#[derive(Default)]
pub(crate) struct FakeEdge {
    pub(crate) ready: bool,
    pub(crate) got: Mutex<Vec<EdgeParams>>,
    pub(crate) res: Mutex<EdgeResult>,
    pub(crate) err: Option<String>,
    pub(crate) ports: Mutex<Vec<EdgePortParams>>,
}

impl EdgeDaemon for FakeEdge {
    fn edge_ready(&self) -> bool {
        self.ready
    }
    fn edge(&self, p: EdgeParams) -> Result<EdgeResult, String> {
        self.got.lock().unwrap().push(p);
        match &self.err {
            Some(e) => Err(e.clone()),
            None => Ok(self.res.lock().unwrap().clone()),
        }
    }
    fn edge_port(&self, p: EdgePortParams) -> Result<(), String> {
        self.ports.lock().unwrap().push(p);
        Ok(())
    }
}

struct Env {
    _dir: tempfile::TempDir,
    srv: Arc<Server>,
    cmds: Arc<FakeBroker>,
}

fn env(chat: Option<Arc<FakeChat>>, edge: Option<Arc<FakeEdge>>) -> Env {
    let dir = tempfile::tempdir().unwrap();
    let cmds = Arc::new(FakeBroker::default());
    let srv = support::server(
        dir.path(),
        Deps {
            commands: Some(cmds.clone()),
            chat_daemon: chat.map(|c| c as Arc<dyn ChatDaemon>),
            edge_daemon: edge.map(|e| e as Arc<dyn EdgeDaemon>),
            ..Deps::default()
        },
    );
    Env {
        _dir: dir,
        srv,
        cmds,
    }
}

async fn req(e: &Env, method: &str, target: &str, body: &str) -> support::Resp {
    call(
        &e.srv,
        method,
        target,
        &[("Content-Type", "application/json")],
        body,
        support::LOCAL,
    )
    .await
}

fn last(e: &Env) -> serde_json::Value {
    let p = e.cmds.published();
    serde_json::from_str(p.last().expect("방송하지 않았다")).unwrap()
}

/// FR-DMR-22 (TC-DMR-4): 데몬이 배선되지 않은 서버는 준비되지 않은 데몬과 같다.
#[tokio::test]
async fn chat_no_daemon_is_not_ready() {
    let e = env(None, None);
    for (m, p) in [("GET", "/api/chat"), ("POST", "/api/chat/send")] {
        let r = req(&e, m, p, r#"{"room":"r","text":"x"}"#).await;
        assert_eq!(r.status, 409, "{m} {p}");
        assert_eq!(r.header("X-Error-Code"), "chat_daemon_restart");
        assert_eq!(
            r.body,
            "{\"code\":\"chat_daemon_restart\",\"message\":\"restart the daemon to use chat\"}\n"
        );
    }
}

/// 채팅을 모르는 옛 데몬은 409 chat_daemon_restart 다. 데몬에 보내지 않는다.
#[tokio::test]
async fn chat_old_daemon_needs_restart() {
    let d = Arc::new(FakeChat::default());
    let e = env(Some(d.clone()), None);
    let r = req(&e, "GET", "/api/chat", "").await;
    assert_eq!(r.status, 409);
    assert!(d.got.lock().unwrap().is_empty());
}

/// GET 은 state, POST 는 경로의 op 와 본문을 데몬에 넘기고 답을 그대로 쓴다.
#[tokio::test]
async fn chat_passes_op_and_body() {
    let d = Arc::new(FakeChat {
        ready: true,
        res: ChatResult {
            result: RawMessage(br#"{"me":{"id":"u"}}"#.to_vec()),
            ..Default::default()
        },
        ..Default::default()
    });
    let e = env(Some(d.clone()), None);
    let r = req(&e, "GET", "/api/chat", "").await;
    assert_eq!(r.status, 200);
    assert_eq!(r.body, "{\"me\":{\"id\":\"u\"}}\n");
    assert_eq!(r.header("Content-Type"), "application/json");
    assert_eq!(d.got.lock().unwrap()[0].op, chatwire::OP_STATE);
    for op in [
        chatwire::OP_CREATE,
        chatwire::OP_DIRECT,
        chatwire::OP_JOIN,
        chatwire::OP_LEAVE,
        chatwire::OP_SEND,
        chatwire::OP_KILL,
        chatwire::OP_KICK,
    ] {
        let r = req(&e, "POST", &format!("/api/chat/{op}"), r#"{"room":"r1"}"#).await;
        let got = d.got.lock().unwrap();
        let last = got.last().unwrap();
        assert_eq!(r.status, 200, "{op}");
        assert_eq!(last.op, op);
        assert_eq!(last.args.0, br#"{"room":"r1"}"#);
    }
    let r = req(&e, "POST", "/api/chat/send", "{").await;
    assert_eq!(
        (r.status, r.header("X-Error-Code").as_str()),
        (400, "chat_bad_request")
    );
    assert_eq!(r.json()["message"], "body is not JSON");
}

/// 데몬의 채팅 코드는 chat_ 를 붙여 상태와 함께 낸다.
#[tokio::test]
async fn chat_error_mapping() {
    let cases = [
        (chatwire::CODE_BAD_REQUEST, 400, "chat_bad_request"),
        ("too_large", 413, "chat_too_large"),
        ("rate_limited", 429, "chat_rate_limited"),
        ("not_in_room", 409, "chat_not_in_room"),
        ("no_such_room", 404, "chat_no_such_room"),
        ("no_such_participant", 404, "chat_no_such_participant"),
        (chatwire::CODE_DAEMON_UNAVAILABLE, 503, "chat_unavailable"),
        (chatwire::CODE_BAD_CODE, 403, "chat_bad_code"),
        (chatwire::CODE_LOCKED, 423, "chat_locked"),
        (chatwire::CODE_NO_HELPER, 409, "chat_no_helper"),
        ("모르는_코드", 400, "chat_bad_request"),
    ];
    for (code, status, want) in cases {
        let d = Arc::new(FakeChat {
            ready: true,
            res: ChatResult {
                error: Some(chatwire::Error {
                    code: code.into(),
                    message: "m".into(),
                }),
                ..Default::default()
            },
            ..Default::default()
        });
        let e = env(Some(d), None);
        let r = req(&e, "POST", "/api/chat/send", r#"{"room":"r"}"#).await;
        assert_eq!(
            (r.status, r.header("X-Error-Code").as_str()),
            (status, want),
            "{code}"
        );
        assert_eq!(r.json()["message"], "m");
    }
    let d = Arc::new(FakeChat {
        ready: true,
        err: Some("끊김".into()),
        ..Default::default()
    });
    let e = env(Some(d), None);
    let r = req(&e, "GET", "/api/chat", "").await;
    assert_eq!(
        (r.status, r.header("X-Error-Code").as_str()),
        (502, "chat_unreachable")
    );
    assert_eq!(r.json()["message"], "daemon: 끊김");
}

/// chat push 는 chat_message·chat_changed 로, 다시 붙으면 chat_changed 로 방송한다.
#[tokio::test]
async fn chat_push_broadcasts() {
    let e = env(Some(Arc::new(FakeChat::default())), None);
    e.srv.chat_pushed(&ChatEvent {
        chat_kind: CHAT_KIND_MSG.into(),
        chat: Some(chatwire::Message {
            id: "m1".into(),
            text: "<b>hi</b>".into(),
            ..Default::default()
        }),
        ..Default::default()
    });
    let p = last(&e);
    assert_eq!(p["action"], "chat_message");
    assert_eq!(p["args"]["msg"]["text"], "<b>hi</b>");
    e.srv.chat_pushed(&ChatEvent {
        chat_kind: CHAT_KIND_CHANGED.into(),
        ..Default::default()
    });
    e.srv.chat_resync();
    // TC-CH2B-4: 채팅 상태의 바뀜은 `chat` 토픽으로 간다 — SSE 방송은 글(chat_message)뿐이다.
    assert!(
        e.cmds
            .published()
            .iter()
            .all(|p| !p.contains("chat_changed")),
        "{:?}",
        e.cmds.published()
    );
}

/// FR-DMR-21 (TC-DMR-3): 데몬이 배선되지 않은 서버의 간선 API 는 503 edge_unavailable 이다.
#[tokio::test]
async fn edge_api_without_daemon_is_unavailable() {
    let e = env(None, None);
    for (m, p) in [("GET", "/api/edges"), ("PUT", "/api/profile")] {
        let r = req(&e, m, p, "{}").await;
        assert_eq!(
            (r.status, r.header("X-Error-Code").as_str()),
            (503, "edge_unavailable")
        );
    }
    // 노드 신원 파일을 만들지 않는다.
    for f in [
        otter_shared_otterenv::EDGE_KEY_FILE,
        otter_shared_otterenv::EDGE_CERT_FILE,
        otter_shared_otterenv::EDGES_FILE,
    ] {
        assert!(!e.srv.config().data_dir.join(f).exists(), "{f}");
    }
    assert_eq!(e.srv.profile_handle(), "");
}

/// 데몬이 없으면 start_edge 가 곧바로 끝난다.
#[tokio::test]
async fn start_edge_without_daemon() {
    let e = env(None, None);
    let stop = CancellationToken::new();
    stop.cancel();
    e.srv.start_edge(stop).await.unwrap();
}

/// 노드 기능을 모르는 데몬은 409 edge_daemon_restart 다.
#[tokio::test]
async fn edge_old_daemon_needs_restart() {
    let d = Arc::new(FakeEdge::default());
    let e = env(None, Some(d.clone()));
    let r = req(&e, "GET", "/api/edges", "").await;
    assert_eq!(
        (r.status, r.header("X-Error-Code").as_str()),
        (409, "edge_daemon_restart")
    );
    assert!(d.got.lock().unwrap().is_empty());
}

/// 경로마다 연산과 본문·If-Match 를 넘기고, 노드의 답(상태·ETag·본문)을 그대로 쓴다.
#[tokio::test]
async fn edge_passes_op_and_writes_response() {
    let d = Arc::new(FakeEdge {
        ready: true,
        ..Default::default()
    });
    *d.res.lock().unwrap() = EdgeResult {
        status: 201,
        body: RawMessage(br#"{"ok":true}"#.to_vec()),
        etag: "\"e1\"".into(),
        ..Default::default()
    };
    let e = env(None, Some(d.clone()));
    let cases = [
        ("GET", "/api/edges", "get", false),
        ("PUT", "/api/edges/node", "node", true),
        ("POST", "/api/edges/invite", "invite", true),
        ("POST", "/api/edges/add", "add", true),
        ("POST", "/api/edges/remove", "remove", true),
        ("PUT", "/api/edges/address", "address", true),
        ("POST", "/api/edges/notify", "notify", true),
        ("POST", "/api/edges/invite/send", "invite_send", true),
        ("POST", "/api/edges/invite/accept", "invite_accept", true),
        ("POST", "/api/edges/invite/reject", "invite_reject", true),
        ("GET", "/api/profile", "profile", false),
        ("PUT", "/api/profile", "profile_name", true),
    ];
    for (m, p, op, body) in cases {
        let r = call(
            &e.srv,
            m,
            p,
            &[("Content-Type", "application/json"), ("If-Match", "\"e0\"")],
            r#"{"a":1}"#,
            support::LOCAL,
        )
        .await;
        assert_eq!(r.status, 201, "{p}");
        assert_eq!(r.body, "{\"ok\":true}\n");
        assert_eq!(r.header("ETag"), "\"e1\"");
        let got = d.got.lock().unwrap();
        let last = got.last().unwrap();
        assert_eq!(last.op, op);
        assert_eq!(last.if_match, "\"e0\"");
        assert_eq!(last.args.0.is_empty(), !body, "{p}");
    }
}

/// 노드의 오류는 코드 방언으로 쓰고 ETag 도 싣는다. 데몬에 닿지 않으면 502 edge_unreachable 이다.
#[tokio::test]
async fn edge_errors() {
    let d = Arc::new(FakeEdge {
        ready: true,
        ..Default::default()
    });
    *d.res.lock().unwrap() = EdgeResult {
        status: 409,
        code: "edge_stale".into(),
        message: "바뀌었다".into(),
        etag: "\"e2\"".into(),
        ..Default::default()
    };
    let e = env(None, Some(d));
    let r = req(&e, "PUT", "/api/edges/node", "{}").await;
    assert_eq!(
        (r.status, r.header("X-Error-Code").as_str()),
        (409, "edge_stale")
    );
    assert_eq!(r.header("ETag"), "\"e2\"");
    assert_eq!(
        r.body,
        "{\"code\":\"edge_stale\",\"message\":\"바뀌었다\"}\n"
    );
    let d = Arc::new(FakeEdge {
        ready: true,
        err: Some("끊김".into()),
        ..Default::default()
    });
    let e = env(None, Some(d));
    let r = req(&e, "GET", "/api/edges", "").await;
    assert_eq!(
        (r.status, r.header("X-Error-Code").as_str()),
        (502, "edge_unreachable")
    );
    assert_eq!(r.json()["message"], "daemon: 끊김");
}

/// edges push 는 간선에 번호를 얹어 edges_changed 로 방송하고, 다시 붙으면 빈 인자로 방송한다.
/// 핸들 기억은 바뀜마다 버린다 (NFR-PFN-3).
#[tokio::test]
async fn edge_push_broadcasts_and_invalidates_handle() {
    let d = Arc::new(FakeEdge {
        ready: true,
        ..Default::default()
    });
    *d.res.lock().unwrap() = EdgeResult {
        status: 200,
        body: RawMessage(r#"{"handle":"집#1a2b"}"#.as_bytes().to_vec()),
        ..Default::default()
    };
    let e = env(None, Some(d.clone()));
    assert_eq!(e.srv.profile_handle(), "집#1a2b");
    assert_eq!(e.srv.profile_handle(), "집#1a2b");
    assert_eq!(d.got.lock().unwrap().len(), 1, "기억한 핸들을 다시 물었다");
    let fp = "ab".repeat(32);
    let notice = super::state_topics::tap(&e.srv, "edges.notice").await;
    e.srv.edge_pushed(&EdgesEvent {
        removed: Some(EdgeRef {
            fp: fp.clone(),
            name: "노트북".into(),
        }),
        by_peer: true,
        ..Default::default()
    });
    let got = super::state_topics::heard(&notice, 1).await;
    let p = &got[0]["data"];
    assert_eq!(p["byPeer"], true);
    assert_eq!(p["removed"]["name"], "노트북");
    assert_eq!(p["removed"]["tag"], otter_shared_edge::tag(&fp).as_str());
    assert_eq!(e.srv.profile_handle(), "집#1a2b");
    assert_eq!(
        d.got.lock().unwrap().len(),
        2,
        "바뀐 뒤 핸들을 다시 묻지 않았다"
    );
    // byPeer 는 지운 간선이 있을 때만 싣는다 — 알릴 것이 없으면 사건도 없다.
    e.srv.edge_pushed(&EdgesEvent {
        by_peer: true,
        ..Default::default()
    });
    e.srv.edge_resync();
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    assert!(notice.pop().is_none(), "알릴 것이 없는데 사건이 났다");
    assert!(
        e.cmds
            .published()
            .iter()
            .all(|p| !p.contains("edges_changed")),
        "{:?}",
        e.cmds.published()
    );
}

/// snapshot 조각 `edges` 는 `GET /api/edges` 의 본문이다.
#[tokio::test]
async fn snapshot_carries_edges() {
    let d = Arc::new(FakeEdge {
        ready: true,
        ..Default::default()
    });
    *d.res.lock().unwrap() = EdgeResult {
        status: 200,
        body: RawMessage(br#"{"edges":[]}"#.to_vec()),
        ..Default::default()
    };
    let e = env(None, Some(d));
    let r = support::get(&e.srv, "/api/snapshot?parts=edges").await;
    assert_eq!(r.json()["edges"]["edges"], serde_json::json!([]));
}
