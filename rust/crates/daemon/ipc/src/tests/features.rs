//! 서버가 말한 기능에만 가는 push 와 그 메서드 — 알람·간선·채팅 (attention_test.go · edge_test.go ·
//! chat_test.go).

use std::sync::{Arc, Mutex};

use otter_gocompat::json::RawMessage;
use otter_shared_activity as activity;
use otter_shared_chatwire as chatwire;
use otter_shared_edgenode::{Change, Node, Options, Ref};
use otter_shared_toolipc as ipc;
use serde_json::Value;

use super::{Daemon, Raw, daemon, raw};
use crate::ChatUser;
use crate::conn::lock;

const OSC_SIGNAL: &[u8] = b"\x1b]9;hi\x07";
const SYNC: &str = r#"{"id":50,"method":"busy","params":{"id":"zz"}}"#;
const SYNC_REPLY: &str = r#"{"id":50,"result":{"busy":false}}"#;

fn parse(l: &str) -> Value {
    serde_json::from_str(l).unwrap()
}

/// 동기 요청의 응답이 다음 줄이면 그 앞에 push 가 없었다.
fn assert_no_push(c: &mut Raw) {
    assert_eq!(c.call(SYNC), SYNC_REPLY, "push 가 나갔다");
}

fn connected(features: &[&str], tools: &[&str]) -> (Daemon, Raw) {
    let d = daemon("b");
    for id in tools {
        d.srv.inner.pm.adopt_detached(id);
    }
    let mut c = raw(&d.sock);
    c.hello(features);
    (d, c)
}

/// 판정 결과는 attention 을 말한 서버에만 push 한다. 판정 자체는 언제나 한다.
#[tokio::test(flavor = "multi_thread")]
async fn attn_push_only_to_attention_server() {
    let (d, mut c) = connected(&[], &["t1"]);
    let p = d.srv.inner.pm.get("t1").unwrap();
    p.observe_output(OSC_SIGNAL);
    assert!(p.attention(), "데몬이 판정하지 않았다");
    assert_no_push(&mut c);

    let (d, mut c) = connected(&[ipc::FEATURE_ATTENTION], &["t2"]);
    let p = d.srv.inner.pm.get("t2").unwrap();
    p.observe_output(OSC_SIGNAL);
    p.attend();
    p.report_activity(activity::WORKING, "Bash", "ls", true);
    let evs: Vec<Value> = (0..3).map(|_| parse(&c.recv())).collect();
    assert_no_push(&mut c);
    let e = &evs[0];
    assert_eq!(
        (&e["event"], &e["tool"], &e["kind"], &e["reason"]),
        (
            &Value::from("attn"),
            &Value::from("t2"),
            &Value::from(ipc::ATTN_KIND_ATTENTION),
            &Value::from("signaled")
        ),
        "{e}"
    );
    assert_eq!(e["agent"]["attention"], true, "{e}");
    let e = &evs[1];
    assert_eq!(e["kind"], ipc::ATTN_KIND_CLEAR, "{e}");
    assert!(e.get("reason").is_none(), "{e}");
    assert_ne!(e["agent"]["attention"], true, "{e}");
    assert_eq!(e["agent"]["rearmLocked"], true, "{e}");
    let e = &evs[2];
    assert_eq!(e["kind"], ipc::ATTN_KIND_ACTIVITY, "{e}");
    assert_eq!(e["agent"]["activity"]["tool"], "Bash", "{e}");
}

/// 서버가 없어도 판정은 하고 상태만 바뀐다 (FR-ARD-25).
#[tokio::test(flavor = "multi_thread")]
async fn attn_without_server_still_judges() {
    let d = daemon("b");
    let p = d.srv.inner.pm.adopt_detached("t1");
    p.observe_output(OSC_SIGNAL);
    assert!(p.attention());
}

#[tokio::test(flavor = "multi_thread")]
async fn attend_methods() {
    let (d, mut c) = connected(&[], &["t1", "t2"]);
    let pm = &d.srv.inner.pm;
    let (p1, p2) = (pm.get("t1").unwrap(), pm.get("t2").unwrap());
    p1.observe_output(OSC_SIGNAL);
    assert_eq!(
        c.call(r#"{"id":1,"method":"attend","params":{"tool":"t1"}}"#),
        r#"{"id":1,"result":{}}"#
    );
    let st = p1.agent_state();
    assert!(!st.attention && st.rearm_locked, "보기만 한 해제");
    c.call(r#"{"id":2,"method":"attend","params":{"tool":"t1","typed":true}}"#);
    assert!(
        !p1.agent_state().rearm_locked,
        "키를 누른 해제가 잠금을 풀지 않았다"
    );
    assert_eq!(
        c.call(r#"{"id":3,"method":"attend","params":{"tool":"nope"}}"#),
        r#"{"id":3,"result":{}}"#
    );
    p1.observe_output(OSC_SIGNAL);
    p2.observe_output(OSC_SIGNAL);
    assert_eq!(
        c.call(r#"{"id":4,"method":"attendall","params":{}}"#),
        r#"{"id":4,"result":{"cleared":2}}"#
    );
    assert!(!p1.attention() && !p2.attention());
}

#[tokio::test(flavor = "multi_thread")]
async fn attn_config_applies_to_tools() {
    let (d, mut c) = connected(&[], &["t1"]);
    let p = d.srv.inner.pm.get("t1").unwrap();
    p.observe_output(b"\x07");
    assert!(!p.attention(), "BEL 허용 전에 울었다");
    assert_eq!(
        c.call(r#"{"id":1,"method":"attnconfig","params":{"idleMs":1000,"allowBell":true}}"#),
        r#"{"id":1,"result":{}}"#
    );
    p.observe_output(b"\x07");
    assert!(p.attention(), "attnconfig 의 BEL 허용이 도구에 닿지 않았다");
}

/// 서버 HTTP 로 온 보고는 report 로 넘어와 보고 소켓과 같은 길을 탄다 — 판정 push, report push,
/// 응답 순이다.
#[tokio::test(flavor = "multi_thread")]
async fn report_method_judges_then_pushes_report() {
    let (d, mut c) = connected(&[ipc::FEATURE_ATTENTION], &["t1"]);
    c.send(
        r#"{"id":1,"method":"report","params":{"method":"report.notify","body":{"toolId":"t1"}}}"#,
    );
    assert_eq!(parse(&c.recv())["event"], "attn");
    assert_eq!(
        c.recv(),
        r#"{"event":"report","method":"report.notify","body":{"toolId":"t1"}}"#
    );
    assert_eq!(c.recv(), r#"{"id":1,"result":{}}"#);
    assert!(d.srv.inner.pm.get("t1").unwrap().attention());
    assert_eq!(
        c.call(r#"{"id":2,"method":"report","params":{"method":"report.notify","body":{"toolId":"nope"}}}"#),
        r#"{"id":2,"error":{"code":-32011,"message":"toolhub: tool not found"}}"#
    );
    assert_eq!(
        c.call(r#"{"id":3,"method":"report","params":{"method":"write","body":{}}}"#),
        r#"{"id":3,"error":{"code":-32602,"message":"보고 소켓이 받지 않는 메서드다"}}"#
    );
}

fn edge_node(d: &Daemon) {
    let dir = tempfile::tempdir().unwrap();
    let (s1, s2) = (d.srv.clone(), d.srv.clone());
    let n = Node::new(Options {
        home: dir.keep(),
        hostname: "d".into(),
        dial: None,
        port_status: Some(Arc::new(move || s1.edge_port())),
        on_config: None,
        notify: Some(Arc::new(move |ch: Change| s2.push_edges(&ch))),
        mesh: false,
        now: None,
    })
    .unwrap();
    d.srv.set_edge(Some(n));
}

fn edge_get(c: &mut Raw) -> Value {
    let r = parse(&c.call(r#"{"id":1,"method":"edge","params":{"op":"get"}}"#));
    r["result"].clone()
}

/// edge 는 노드의 답(상태·본문·ETag)을 그대로 돌려준다 (FR-PDM-30). 포트 상태가 get 에 실린다.
#[tokio::test(flavor = "multi_thread")]
async fn edge_get_returns_node_answer() {
    let (d, mut c) = connected(&[ipc::FEATURE_EDGE], &[]);
    edge_node(&d);
    let r = edge_get(&mut c);
    assert_eq!(r["status"], 200, "{r}");
    assert!(r["etag"].as_str().is_some_and(|s| !s.is_empty()), "{r}");
    assert_eq!(r["body"]["node"]["name"], "d", "{r}");
    assert_ne!(r["body"]["node"]["listening"], true, "{r}");
    assert_eq!(
        c.call(
            r#"{"id":2,"method":"edgeport","params":{"listening":true,"addr":"0.0.0.0:58147"}}"#
        ),
        r#"{"id":2,"result":{}}"#
    );
    let r = edge_get(&mut c);
    assert_eq!(r["body"]["node"]["listening"], true, "{r}");
    assert_eq!(r["body"]["node"]["addr"], "0.0.0.0:58147", "{r}");
}

/// edge 한 번이 시한(EDGE_CALL_TIMEOUT)을 넘으면 Go 의 ctx 시한 초과와 같은 답을 낸다 (FR-RDF-3).
/// 상대는 연결만 받고 답하지 않는다. 시한은 시험에서 낮춘다.
#[tokio::test(flavor = "multi_thread")]
async fn edge_op_stops_at_call_timeout() {
    const LIMIT: std::time::Duration = std::time::Duration::from_millis(300);
    const BOUND: std::time::Duration = std::time::Duration::from_secs(3);
    let ln = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = ln.local_addr().unwrap().port();
    std::thread::spawn(move || {
        let mut held = Vec::new();
        while let Ok((c, _)) = ln.accept() {
            held.push(c);
        }
    });
    let (d, mut c) = connected(&[ipc::FEATURE_EDGE], &[]);
    let dir = tempfile::tempdir().unwrap();
    let n = Node::new(Options {
        home: dir.path().to_path_buf(),
        hostname: "d".into(),
        dial: None,
        port_status: None,
        on_config: None,
        notify: None,
        mesh: true,
        now: None,
    })
    .unwrap();
    let fp = "ab".repeat(32);
    n.store()
        .add_edge(otter_shared_edge::Edge {
            name: "x".into(),
            addr: "127.0.0.1".into(),
            port: i64::from(port),
            fingerprint: fp.clone(),
            ..otter_shared_edge::Edge::default()
        })
        .unwrap();
    d.srv.set_edge(Some(n));
    d.srv.inner.set_edge_call_timeout(LIMIT);
    let start = std::time::Instant::now();
    let got = c.call(&format!(
        r#"{{"id":1,"method":"edge","params":{{"op":"notify","args":{{"fp":"{fp}"}}}}}}"#
    ));
    assert!(start.elapsed() < BOUND, "{:?}", start.elapsed());
    assert_eq!(
        got,
        r#"{"id":1,"result":{"code":"edge_unreachable","message":"상대에 닿지 못했다: 상대 노드에 닿지 못했습니다: context deadline exceeded","status":502}}"#
    );
}

/// 노드를 세우지 못한 데몬은 503 edge_unavailable 로 답한다.
#[tokio::test(flavor = "multi_thread")]
async fn edge_without_node_is_unavailable() {
    let (_d, mut c) = connected(&[ipc::FEATURE_EDGE], &[]);
    assert_eq!(
        c.call(r#"{"id":1,"method":"edge","params":{"op":"get"}}"#),
        r#"{"id":1,"result":{"code":"edge_unavailable","message":"edge layer unavailable","status":503}}"#
    );
}

/// 상태가 바뀌면 edges push 를 보낸다. edge 를 모르는 서버에는 보내지 않는다 (FR-PDM-27).
#[tokio::test(flavor = "multi_thread")]
async fn edges_push_only_to_edge_server() {
    let (d, mut c) = connected(&[ipc::FEATURE_EDGE], &[]);
    d.srv.push_edges(&Change {
        removed: Some(Ref {
            fp: "f".into(),
            name: "b".into(),
        }),
        by_peer: true,
        ..Change::default()
    });
    assert_eq!(
        c.recv(),
        r#"{"event":"edges","removed":{"fp":"f","name":"b"},"byPeer":true}"#
    );
    let (d, mut c) = connected(&[], &[]);
    d.srv.push_edges(&Change::default());
    assert_no_push(&mut c);
}

#[derive(Default)]
struct FakeChatUser {
    seen: Mutex<(String, String)>,
    reply: Mutex<Option<Result<RawMessage, chatwire::Error>>>,
}

impl ChatUser for FakeChatUser {
    fn user_call(&self, op: &str, args: &RawMessage) -> Result<RawMessage, chatwire::Error> {
        *lock(&self.seen) = (op.to_owned(), String::from_utf8_lossy(&args.0).into_owned());
        lock(&self.reply).clone().unwrap()
    }
}

/// chat 은 사람 참가자의 답을 그대로 돌려준다.
#[tokio::test(flavor = "multi_thread")]
async fn chat_passes_to_user() {
    let (d, mut c) = connected(&[ipc::FEATURE_CHAT], &[]);
    let u = Arc::new(FakeChatUser::default());
    *lock(&u.reply) = Some(Ok(RawMessage(br#"{"ok":true}"#.to_vec())));
    d.srv.set_chat(Some(Arc::clone(&u) as Arc<dyn ChatUser>));
    assert_eq!(
        c.call(r#"{"id":1,"method":"chat","params":{"op":"join","args":{"room":"r1"}}}"#),
        r#"{"id":1,"result":{"result":{"ok":true}}}"#
    );
    assert_eq!(
        *lock(&u.seen),
        ("join".to_owned(), r#"{"room":"r1"}"#.to_owned())
    );
    *lock(&u.reply) = Some(Err(chatwire::Error {
        code: "not_in_room".into(),
        message: "m".into(),
    }));
    assert_eq!(
        c.call(r#"{"id":2,"method":"chat","params":{"op":"send"}}"#),
        r#"{"id":2,"result":{"error":{"code":"not_in_room","message":"m"}}}"#
    );
}

/// 채팅을 세우지 못한 데몬은 daemon_unavailable 로 답한다.
#[tokio::test(flavor = "multi_thread")]
async fn chat_without_user_is_unavailable() {
    let (_d, mut c) = connected(&[ipc::FEATURE_CHAT], &[]);
    let r = parse(&c.call(r#"{"id":1,"method":"chat","params":{"op":"state"}}"#));
    assert_eq!(
        r["result"]["error"]["code"],
        chatwire::CODE_DAEMON_UNAVAILABLE,
        "{r}"
    );
}

/// 사람에게 온 글과 바뀜 알림은 chat 을 말한 서버에만 push 한다.
#[tokio::test(flavor = "multi_thread")]
async fn chat_push_only_to_chat_server() {
    let (d, mut c) = connected(&[ipc::FEATURE_CHAT], &[]);
    d.srv.push_chat_msg(chatwire::Message {
        id: "m1".into(),
        text: "hi".into(),
        ..chatwire::Message::default()
    });
    d.srv.push_chat_changed();
    let m = parse(&c.recv());
    assert_eq!(
        (&m["event"], &m["chatKind"], &m["chat"]["text"]),
        (
            &Value::from("chat"),
            &Value::from(ipc::CHAT_KIND_MSG),
            &Value::from("hi")
        ),
        "{m}"
    );
    assert_eq!(c.recv(), r#"{"chatKind":"changed","event":"chat"}"#);
    let (d, mut c) = connected(&[], &[]);
    d.srv.push_chat_msg(chatwire::Message::default());
    d.srv.push_chat_changed();
    assert_no_push(&mut c);
}
