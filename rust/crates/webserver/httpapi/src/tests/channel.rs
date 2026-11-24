//! 채널 `/channel` 의 뼈대 (PERF_OPTIMIZATION_SRS FR-CON · `perf/CHANNEL_PROTOCOL.md` §10.1 C1).
//! 실제 TCP 로 업그레이드한다.

use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use http::Method;
use serde_json::{Value, json};
use tokio_tungstenite::tungstenite::Message;

use super::ws::listen;
use crate::{Config, Deps, Server};

type Client =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

const WAIT: Duration = Duration::from_secs(5);

struct Env {
    _dir: tempfile::TempDir,
    srv: Arc<Server>,
    port: u16,
}

async fn env() -> Env {
    let dir = tempfile::tempdir().unwrap();
    let srv = Server::new(
        Config {
            data_dir: dir.path().to_path_buf(),
            ..Config::default()
        },
        Deps::default(),
    );
    let port = listen(srv.clone()).await;
    Env {
        _dir: dir,
        srv,
        port,
    }
}

async fn dial(port: u16) -> Client {
    let (c, _) = tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{port}/channel?v=1"))
        .await
        .unwrap();
    c
}

async fn send(c: &mut Client, v: Value) {
    c.send(Message::text(v.to_string())).await.unwrap();
}

/// 다음 텍스트 프레임. 닫히거나 시한이 지나면 `None`.
async fn next_json(c: &mut Client) -> Option<Value> {
    loop {
        match tokio::time::timeout(WAIT, c.next()).await {
            Ok(Some(Ok(Message::Text(t)))) => return serde_json::from_str(t.as_str()).ok(),
            Ok(Some(Ok(Message::Ping(_) | Message::Pong(_)))) => continue,
            _ => return None,
        }
    }
}

/// 서버가 연결을 닫았는가 (닫기 프레임 또는 스트림 끝).
async fn closed(c: &mut Client) -> bool {
    loop {
        match tokio::time::timeout(WAIT, c.next()).await {
            Ok(None | Some(Err(_)) | Some(Ok(Message::Close(_)))) => return true,
            Ok(Some(Ok(_))) => continue,
            Err(_) => return false,
        }
    }
}

async fn hello(c: &mut Client, slots: &[&str]) -> Value {
    send(c, json!({"t":"hello","slots":slots})).await;
    let v = next_json(c).await.expect("hello 답이 없다");
    assert_eq!(v["t"], "hello", "{v}");
    v
}

async fn wait_live(s: &Server, want: usize) {
    let deadline = tokio::time::Instant::now() + WAIT;
    while s.focus.live_count() != want && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(s.focus.live_count(), want);
}

/// TC-CH1-1
#[tokio::test]
async fn plain_get_is_400_and_channel_opens_without_tools() {
    let e = env().await;
    let r = reqwest_get(e.port, "/channel?v=1").await;
    assert_eq!(r, 400);
    let mut c = dial(e.port).await;
    hello(&mut c, &[]).await;
    assert!(
        !crate::reqgate::gate_exempt(&Method::GET, "/channel"),
        "채널은 출처 게이트를 지나야 한다"
    );
}

/// 업그레이드 헤더 없는 GET 의 상태 코드.
async fn reqwest_get(port: u16, path: &str) -> u16 {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut s = tokio::net::TcpStream::connect(("127.0.0.1", port))
        .await
        .unwrap();
    let req = format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    s.write_all(req.as_bytes()).await.unwrap();
    let mut buf = Vec::new();
    let _ = tokio::time::timeout(WAIT, s.read_to_end(&mut buf)).await;
    let head = String::from_utf8_lossy(&buf);
    head.split_whitespace()
        .nth(1)
        .and_then(|c| c.parse().ok())
        .unwrap_or(0)
}

/// TC-CH1-2
#[tokio::test]
async fn first_frame_must_be_hello() {
    let e = env().await;
    let mut c = dial(e.port).await;
    send(&mut c, json!({"t":"ping","n":1})).await;
    let v = next_json(&mut c).await.expect("error 프레임이 없다");
    assert_eq!(v["t"], "error");
    assert_eq!(v["code"], "hello_required");
    assert!(closed(&mut c).await, "hello 없이 연결이 남았다");
}

/// TC-CH1-3
#[tokio::test]
async fn hello_answers_epoch_and_server_info() {
    let e = env().await;
    let mut a = dial(e.port).await;
    let mut b = dial(e.port).await;
    let ha = hello(&mut a, &[]).await;
    let hb = hello(&mut b, &[]).await;
    let ep = ha["epoch"].as_str().unwrap_or_default();
    assert!(!ep.is_empty(), "{ha}");
    assert_eq!(ha["epoch"], hb["epoch"], "같은 프로세스의 epoch 가 다르다");
    let want = e.srv.asset_version();
    if want.is_empty() {
        assert!(ha["server"].get("assetVersion").is_none(), "{ha}");
    } else {
        assert_eq!(ha["server"]["assetVersion"], want.as_str(), "{ha}");
    }
}

/// TC-CH1-4
#[tokio::test]
async fn slots_hold_focus_lease_for_channel_lifetime() {
    let e = env().await;
    let mut c = dial(e.port).await;
    hello(&mut c, &["slotA", "slotB"]).await;
    wait_live(&e.srv, 2).await;

    hello(&mut c, &["slotB", "slotC"]).await;
    wait_live(&e.srv, 2).await;
    // 실행자는 산 구독 중 가장 최근에 주장한 신원이다 — 주장한 신원이 죽었으면 뽑히지 않는다.
    e.srv.focus.claim("slotA", "W1");
    assert_ne!(e.srv.focus.executor(), "slotA", "빠진 신원이 아직 산다");
    e.srv.focus.claim("slotC", "W2");
    assert_eq!(e.srv.focus.executor(), "slotC", "새 신원이 붙지 않았다");

    drop(c);
    wait_live(&e.srv, 0).await;
}

/// TC-CH1-5
#[tokio::test]
async fn ping_gets_pong_with_same_n() {
    let e = env().await;
    let mut c = dial(e.port).await;
    hello(&mut c, &[]).await;
    send(&mut c, json!({"t":"ping","n":7})).await;
    let v = next_json(&mut c).await.unwrap();
    assert_eq!(v, json!({"t":"pong","n":7}));
}

/// TC-CH1-6
#[tokio::test]
async fn bad_frames_get_error_and_connection_stays() {
    let e = env().await;
    let mut c = dial(e.port).await;
    hello(&mut c, &[]).await;

    c.send(Message::text("{not json")).await.unwrap();
    let v = next_json(&mut c).await.unwrap();
    assert_eq!(v["t"], "error", "{v}");

    send(&mut c, json!({"t":"nope"})).await;
    let v = next_json(&mut c).await.unwrap();
    assert_eq!(v["t"], "error", "{v}");

    c.send(Message::binary(vec![0u8, 0, 0, 0, 1]))
        .await
        .unwrap();
    let v = next_json(&mut c).await.unwrap();
    assert_eq!(v["t"], "error", "{v}");

    send(&mut c, json!({"t":"ping","n":1})).await;
    assert_eq!(next_json(&mut c).await.unwrap()["t"], "pong");
}

// ── 토픽 기반 (§11.1) ────────────────────────────────────────────────────────

use std::collections::BTreeMap;
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

use futures_util::FutureExt;

use crate::channel::{
    CHANNEL_PENDING_MAX, DeltaOp, Out, Outbox, Seed, TOPIC_PENDING_MAX, TOPIC_RING, TopicHub,
};

/// Outbox 에 쌓인 것을 쓰기 태스크처럼 꺼낸다. `NeedFull` 은 허브의 지금 상태로 바꾼다.
fn drain(o: &Outbox, hub: &TopicHub) -> Vec<Value> {
    let mut out = Vec::new();
    while let Some(m) = o.pop() {
        match m {
            Out::Text(t) => out.push(serde_json::from_str(&t).unwrap()),
            Out::NeedFull(topic) => {
                if let Some(it) = hub.full_item(&topic) {
                    o.drop_upto(&topic, it.seq);
                    out.push(serde_json::from_str(&it.frame).unwrap());
                }
            }
            Out::Binary(b) => out.push(json!({"bin": b.len()})),
            Out::Close => out.push(json!({"close": true})),
        }
    }
    out
}

fn put(id: &str, v: Value) -> DeltaOp {
    DeltaOp::Put { id: id.into(), v }
}

fn map_hub(topic: &'static str) -> (TopicHub, Arc<AtomicUsize>) {
    let hub = TopicHub::default();
    let calls = Arc::new(AtomicUsize::new(0));
    let c = calls.clone();
    hub.register_seed(topic, move |_t| {
        c.fetch_add(1, Ordering::SeqCst);
        async { Some(Seed::Map(BTreeMap::from([("a".into(), json!(1))]))) }.boxed()
    });
    (hub, calls)
}

#[tokio::test]
async fn hub_first_sub_gets_full_from_seed_once() {
    let (hub, calls) = map_hub("runs");
    let o = Outbox::new();
    hub.subscribe(1, &o, "runs", None, None).await.unwrap();
    assert_eq!(
        drain(&o, &hub),
        [json!({"t":"full","topic":"runs","seq":0,"data":{"a":1}})]
    );
    let o2 = Outbox::new();
    hub.subscribe(2, &o2, "runs", None, None).await.unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 1, "seed 는 한 번만");
}

#[tokio::test]
async fn hub_unknown_topic_is_error() {
    let hub = TopicHub::default();
    let o = Outbox::new();
    assert!(hub.subscribe(1, &o, "nope", None, None).await.is_err());
}

#[tokio::test]
async fn hub_seq_is_monotonic_and_delta_reaches_subscribers() {
    let (hub, _) = map_hub("runs");
    let o = Outbox::new();
    hub.subscribe(1, &o, "runs", None, None).await.unwrap();
    drain(&o, &hub);
    hub.publish_delta("runs", vec![put("b", json!(2))]);
    hub.publish_delta("runs", vec![DeltaOp::Del { id: "a".into() }]);
    let got = drain(&o, &hub);
    assert_eq!(got[0]["seq"], 1);
    assert_eq!(got[1]["seq"], 2);
    assert_eq!(got[0]["ops"], json!([{"op":"put","id":"b","v":2}]));
    assert_eq!(got[1]["ops"], json!([{"op":"del","id":"a"}]));
    // full 은 delta 가 적용된 상태로 만든다.
    let it = hub.full_item("runs").unwrap();
    let v: Value = serde_json::from_str(&it.frame).unwrap();
    assert_eq!(v, json!({"t":"full","topic":"runs","seq":2,"data":{"b":2}}));
}

#[tokio::test]
async fn hub_resub_within_ring_sends_only_missing() {
    let (hub, _) = map_hub("runs");
    let o = Outbox::new();
    hub.subscribe(1, &o, "runs", None, None).await.unwrap();
    drain(&o, &hub);
    for i in 0..3 {
        hub.publish_delta("runs", vec![put("k", json!(i))]);
    }
    hub.unsubscribe_all(1);
    let ep = hub.epoch().to_owned();
    let o2 = Outbox::new();
    hub.subscribe(1, &o2, "runs", Some(1), Some(&ep))
        .await
        .unwrap();
    let got = drain(&o2, &hub);
    let seqs: Vec<_> = got.iter().map(|v| v["seq"].clone()).collect();
    assert_eq!(seqs, [json!(2), json!(3)]);
    assert!(got.iter().all(|v| v["t"] == "delta"));
    // 최신과 같으면 아무것도 없다.
    let o3 = Outbox::new();
    hub.subscribe(3, &o3, "runs", Some(3), Some(&ep))
        .await
        .unwrap();
    assert!(drain(&o3, &hub).is_empty());
}

#[tokio::test]
async fn hub_resub_outside_ring_or_other_epoch_gets_full() {
    let (hub, _) = map_hub("runs");
    let ep = hub.epoch().to_owned();
    for i in 0..(TOPIC_RING as i64 + 5) {
        hub.publish_delta("runs", vec![put("k", json!(i))]);
    }
    let o = Outbox::new();
    hub.subscribe(1, &o, "runs", Some(1), Some(&ep))
        .await
        .unwrap();
    let got = drain(&o, &hub);
    assert_eq!(got.len(), 1);
    assert_eq!(got[0]["t"], "full");
    let o2 = Outbox::new();
    let last = TOPIC_RING as u64 + 4;
    hub.subscribe(2, &o2, "runs", Some(last), Some("other-epoch"))
        .await
        .unwrap();
    assert_eq!(drain(&o2, &hub)[0]["t"], "full");
}

#[tokio::test]
async fn hub_event_topic_gap_is_reset() {
    let hub = TopicHub::default();
    hub.register_seed("fs", |_t| async { Some(Seed::Event) }.boxed());
    let ep = hub.epoch().to_owned();
    let o = Outbox::new();
    hub.subscribe(1, &o, "fs", None, None).await.unwrap();
    assert!(
        drain(&o, &hub).is_empty(),
        "새 사건 구독에는 보낼 것이 없다"
    );
    hub.publish_event("fs", json!({"p":1}));
    assert_eq!(
        drain(&o, &hub),
        [json!({"t":"event","topic":"fs","seq":1,"data":{"p":1}})]
    );
    for _ in 0..TOPIC_RING + 2 {
        hub.publish_event("fs", json!({}));
    }
    let o2 = Outbox::new();
    hub.subscribe(2, &o2, "fs", Some(1), Some(&ep))
        .await
        .unwrap();
    assert_eq!(drain(&o2, &hub), [json!({"t":"reset","topic":"fs"})]);
}

#[tokio::test]
async fn hub_full_topic_publish_replaces_value() {
    let hub = TopicHub::default();
    hub.register_seed("settings", |_t| {
        async { Some(Seed::Full(json!({"v":0}))) }.boxed()
    });
    let o = Outbox::new();
    hub.subscribe(1, &o, "settings", None, None).await.unwrap();
    hub.publish_full("settings", json!({"v":1}));
    let got = drain(&o, &hub);
    assert_eq!(got.last().unwrap()["data"], json!({"v":1}));
}

#[test]
fn outbox_priority_control_then_term_then_state() {
    let hub = TopicHub::default();
    let o = Outbox::new();
    hub.publish_full("x", json!(1));
    o.push_state(hub.full_item("x").unwrap());
    o.push_term(0, 7, b"hi");
    o.push_control(r#"{"t":"pong","n":1}"#.into());
    let got = drain(&o, &hub);
    assert_eq!(got[0]["t"], "pong");
    assert_eq!(got[1], json!({"bin": 7}));
    assert_eq!(got[2]["t"], "full");
}

#[test]
fn outbox_term_frame_is_op_sid_payload() {
    let o = Outbox::new();
    o.push_term(4, 0x01020304, b"ab");
    let Some(Out::Binary(b)) = o.pop() else {
        panic!("바이너리가 아니다")
    };
    assert_eq!(b, [4, 1, 2, 3, 4, b'a', b'b']);
}

#[test]
fn outbox_coalesces_full_and_overflowing_deltas() {
    let hub = TopicHub::default();
    let o = Outbox::new();
    hub.publish_full("s", json!(1));
    o.push_state(hub.full_item("s").unwrap());
    hub.publish_full("s", json!(2));
    o.push_state(hub.full_item("s").unwrap());
    let got = drain(&o, &hub);
    assert_eq!(got.len(), 1, "full 은 최신만 남는다");
    assert_eq!(got[0]["data"], 2);

    let (dh, _) = map_hub("d");
    let o = Outbox::new();
    let sub = dh.subscribe(1, &o, "d", None, None);
    futures_util::FutureExt::now_or_never(sub).unwrap().unwrap();
    drain(&o, &dh);
    for i in 0..=TOPIC_PENDING_MAX {
        dh.publish_delta("d", vec![put("k", json!(i))]);
    }
    let got = drain(&o, &dh);
    assert_eq!(
        got.len(),
        1,
        "밀린 delta 가 full 하나로 합쳐져야 한다: {got:?}"
    );
    assert_eq!(got[0]["t"], "full");
    assert_eq!(got[0]["seq"], TOPIC_PENDING_MAX as u64 + 1);
    assert_eq!(got[0]["data"]["k"], TOPIC_PENDING_MAX as i64);
}

#[test]
fn outbox_closes_over_channel_cap() {
    let o = Outbox::new();
    let chunk = vec![0u8; 1 << 20];
    for _ in 0..(CHANNEL_PENDING_MAX >> 20) + 1 {
        o.push_term(0, 1, &chunk);
    }
    assert!(o.is_closed());
    assert!(matches!(o.pop(), Some(Out::Close)));
}

// ── 통합 ──

async fn sub_msg(c: &mut Client, topic: &str, seq: Option<u64>, epoch: Option<&str>) {
    let mut v = json!({"t":"sub","topic":topic});
    if let Some(s) = seq {
        v["seq"] = json!(s);
    }
    if let Some(e) = epoch {
        v["epoch"] = json!(e);
    }
    send(c, v).await;
}

fn seed_runs(srv: &Server) {
    srv.topics.register_seed("test.runs", |_t| {
        async { Some(Seed::Map(BTreeMap::new())) }.boxed()
    });
}

#[tokio::test]
async fn ws_sub_delta_unsub_and_resume() {
    let e = env().await;
    seed_runs(&e.srv);
    let mut c = dial(e.port).await;
    let h = hello(&mut c, &[]).await;
    let ep = h["epoch"].as_str().unwrap().to_owned();
    sub_msg(&mut c, "test.runs", None, None).await;
    let v = next_json(&mut c).await.unwrap();
    assert_eq!(v["t"], "full", "{v}");
    e.srv
        .topics
        .publish_delta("test.runs", vec![put("r1", json!({"n":1}))]);
    let v = next_json(&mut c).await.unwrap();
    assert_eq!(
        (v["t"].clone(), v["seq"].clone()),
        (json!("delta"), json!(1))
    );

    send(&mut c, json!({"t":"unsub","topic":"test.runs"})).await;
    send(&mut c, json!({"t":"ping","n":9})).await;
    assert_eq!(next_json(&mut c).await.unwrap()["t"], "pong");
    e.srv
        .topics
        .publish_delta("test.runs", vec![put("r2", json!({}))]);
    send(&mut c, json!({"t":"ping","n":10})).await;
    let v = next_json(&mut c).await.unwrap();
    assert_eq!(v["t"], "pong", "해지한 토픽이 왔다: {v}");

    drop(c);
    e.srv
        .topics
        .publish_delta("test.runs", vec![put("r3", json!({}))]);
    let mut c = dial(e.port).await;
    hello(&mut c, &[]).await;
    sub_msg(&mut c, "test.runs", Some(1), Some(&ep)).await;
    let a = next_json(&mut c).await.unwrap();
    let b = next_json(&mut c).await.unwrap();
    assert_eq!((a["seq"].clone(), b["seq"].clone()), (json!(2), json!(3)));
    assert_eq!(a["t"], "delta");
}

#[tokio::test]
async fn ws_unknown_topic_is_error() {
    let e = env().await;
    let mut c = dial(e.port).await;
    hello(&mut c, &[]).await;
    sub_msg(&mut c, "nope", None, None).await;
    let v = next_json(&mut c).await.unwrap();
    assert_eq!(
        (v["t"].clone(), v["code"].clone()),
        (json!("error"), json!("unknown_topic"))
    );
}

#[tokio::test]
async fn ws_on_demand_follows_subscribers() {
    let e = env().await;
    seed_runs(&e.srv);
    let log = Arc::new(Mutex::new(Vec::<(String, bool)>::new()));
    let l = log.clone();
    e.srv.topics.on_demand("test.runs", move |t, on| {
        l.lock().unwrap().push((t.into(), on))
    });
    let mut a = dial(e.port).await;
    hello(&mut a, &[]).await;
    sub_msg(&mut a, "test.runs", None, None).await;
    next_json(&mut a).await.unwrap();
    let mut b = dial(e.port).await;
    hello(&mut b, &[]).await;
    sub_msg(&mut b, "test.runs", None, None).await;
    next_json(&mut b).await.unwrap();
    assert_eq!(*log.lock().unwrap(), [("test.runs".to_owned(), true)]);
    send(&mut a, json!({"t":"unsub","topic":"test.runs"})).await;
    drop(b);
    let deadline = tokio::time::Instant::now() + WAIT;
    while log.lock().unwrap().len() < 2 && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(
        *log.lock().unwrap(),
        [
            ("test.runs".to_owned(), true),
            ("test.runs".to_owned(), false)
        ]
    );
}
