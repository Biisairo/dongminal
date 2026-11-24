//! full·사건 토픽 (`perf/CHANNEL_PROTOCOL.md` §10.3 C2b). 실제 TCP 로 채널에 붙는다.

use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio_tungstenite::tungstenite::Message;

use super::fakes::{FakeBroker, FakeHub, FakeWork};
use super::support::{LOCAL, call, get, server};
use super::ws::listen;
use crate::settings::FileSettings;
use crate::{Deps, Server};

type Client =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

const WAIT: Duration = Duration::from_secs(5);
const QUIET: Duration = Duration::from_millis(300);

struct Env {
    _dir: tempfile::TempDir,
    srv: Arc<Server>,
    broker: Arc<FakeBroker>,
    hub: Arc<FakeHub>,
    port: u16,
}

async fn env() -> Env {
    let dir = tempfile::tempdir().unwrap();
    let broker = Arc::new(FakeBroker::default());
    let hub = Arc::new(FakeHub::default());
    let srv = server(
        dir.path(),
        Deps {
            commands: Some(broker.clone()),
            tools: Some(hub.clone()),
            work: Some(Arc::new(FakeWork::default())),
            settings: Some(Arc::new(FileSettings::new(
                dir.path().join("settings.json"),
            ))),
            ..Deps::default()
        },
    );
    let port = listen(srv.clone()).await;
    Env {
        _dir: dir,
        srv,
        broker,
        hub,
        port,
    }
}

async fn dial(port: u16) -> Client {
    let (mut c, _) = tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{port}/channel?v=1"))
        .await
        .unwrap();
    send(&mut c, json!({"t":"hello","slots":[]})).await;
    assert_eq!(next(&mut c, WAIT).await.unwrap()["t"], "hello");
    c
}

async fn send(c: &mut Client, v: Value) {
    c.send(Message::text(v.to_string())).await.unwrap();
}

async fn next(c: &mut Client, wait: Duration) -> Option<Value> {
    loop {
        match tokio::time::timeout(wait, c.next()).await {
            Ok(Some(Ok(Message::Text(t)))) => return serde_json::from_str(t.as_str()).ok(),
            Ok(Some(Ok(Message::Ping(_) | Message::Pong(_)))) => continue,
            _ => return None,
        }
    }
}

/// 토픽을 구독하고 첫 `full` 의 data 를 돌려준다.
async fn sub_full(c: &mut Client, topic: &str) -> Value {
    send(c, json!({"t":"sub","topic":topic})).await;
    let v = next(c, WAIT).await.expect("full 이 없다");
    assert_eq!(v["t"], "full", "{topic}: {v}");
    assert_eq!(v["topic"], topic);
    v["data"].clone()
}

async fn next_of(c: &mut Client, topic: &str, wait: Duration) -> Option<Value> {
    loop {
        let v = next(c, wait).await?;
        if v["topic"] == topic {
            return Some(v);
        }
    }
}

fn body_json(body: &str) -> Value {
    serde_json::from_str(body).unwrap()
}

/// TC-CH2B-1
#[tokio::test]
async fn full_topics_carry_their_get_body() {
    let e = env().await;
    let mut c = dial(e.port).await;
    for (topic, path) in [
        ("settings", "/api/settings"),
        ("focus", "/api/focus"),
        ("update", "/api/update"),
    ] {
        let got = sub_full(&mut c, topic).await;
        let want = get(&e.srv, path).await;
        if want.status == 200 {
            assert_eq!(got, body_json(&want.body), "{topic}");
        }
    }
    let ws = sub_full(&mut c, "workspace").await;
    let st = get(&e.srv, "/api/state").await;
    let mut want = body_json(&st.body);
    want["$etag"] = json!(st.header("ETag"));
    assert_eq!(ws, want);
}

/// TC-CH2B-2: 설정 저장은 full 을 내고, 같은 본문의 재저장은 내지 않는다.
#[tokio::test]
async fn settings_put_publishes_once_per_change() {
    let e = env().await;
    let mut c = dial(e.port).await;
    sub_full(&mut c, "settings").await;
    let put = |b: &'static str| {
        let s = e.srv.clone();
        async move {
            call(
                &s,
                "PUT",
                "/api/settings",
                &[("Content-Type", "application/json")],
                b,
                LOCAL,
            )
            .await
        }
    };
    assert_eq!(put(r#"{"termFontSize":15}"#).await.status, 200);
    let v = next_of(&mut c, "settings", WAIT)
        .await
        .expect("full 이 없다");
    assert_eq!(v["data"]["termFontSize"], 15, "{v}");
    assert_eq!(put(r#"{"termFontSize":15}"#).await.status, 200);
    assert!(
        next_of(&mut c, "settings", QUIET).await.is_none(),
        "같은 본문인데 다시 냈다"
    );
}

/// TC-CH2B-2: 워크스페이스 저장은 rev 가 오른 full 을 낸다.
#[tokio::test]
async fn workspace_put_publishes_new_rev() {
    let e = env().await;
    let mut c = dial(e.port).await;
    let rev = sub_full(&mut c, "workspace").await["$etag"]
        .as_str()
        .unwrap()
        .to_owned();
    let before: u64 = rev.parse().unwrap();
    let r = call(
        &e.srv,
        "PUT",
        "/api/workspace",
        &[("Content-Type", "application/json"), ("If-Match", &rev)],
        r#"{"schemaVersion":2,"windows":[{"id":"w1","name":"a"}]}"#,
        LOCAL,
    )
    .await;
    assert_eq!(r.status, 200, "{}", r.body);
    let v = next_of(&mut c, "workspace", WAIT)
        .await
        .expect("full 이 없다");
    let after: u64 = v["data"]["$etag"].as_str().unwrap().parse().unwrap();
    assert!(after > before, "{v}");
    assert_eq!(v["data"]["workspace"]["windows"][0]["id"], "w1", "{v}");
}

/// TC-CH2B-2: 도구를 만들면 `/api/state` 의 도구 목록이 바뀐 `workspace` full 이 나간다.
#[tokio::test]
async fn tool_create_publishes_workspace() {
    let e = env().await;
    let mut c = dial(e.port).await;
    let before = sub_full(&mut c, "workspace").await;
    // 데몬이 새 도구를 들게 된 것을 흉내 낸다 — 가짜 허브의 create 는 목록을 바꾸지 않는다.
    e.hub
        .tools
        .lock()
        .unwrap()
        .push(otter_shared_toolhub::ToolInfo {
            id: "t-new".into(),
            ..Default::default()
        });
    let r = call(
        &e.srv,
        "POST",
        "/api/tools",
        &[("Content-Type", "application/json")],
        "{}",
        LOCAL,
    )
    .await;
    assert_eq!(r.status, 200, "{}", r.body);
    let v = next_of(&mut c, "workspace", WAIT)
        .await
        .expect("full 이 없다");
    assert_ne!(v["data"]["tools"], before["tools"], "{v}");
}

/// TC-CH2B-2: 런타임 밖의 스레드(데몬 push 의 읽기 루프)에서 불러도 full 이 나간다.
#[tokio::test]
async fn refresh_from_plain_thread_publishes() {
    let e = env().await;
    let mut c = dial(e.port).await;
    sub_full(&mut c, "focus").await;
    let s = e.srv.clone();
    std::thread::spawn(move || {
        s.focus.claim("cliT", "WT");
        s.broadcast_focus_owners();
    })
    .join()
    .unwrap();
    let v = next_of(&mut c, "focus", WAIT).await.expect("full 이 없다");
    assert_eq!(v["data"]["owners"]["WT"], "cliT", "{v}");
}

/// TC-CH2B-2: 포커스 주장은 소유 맵 full 을 낸다.
#[tokio::test]
async fn focus_claim_publishes_owners() {
    let e = env().await;
    let mut c = dial(e.port).await;
    sub_full(&mut c, "focus").await;
    e.srv.focus.claim("cliA", "W1");
    e.srv.broadcast_focus_owners();
    let v = next_of(&mut c, "focus", WAIT).await.expect("full 이 없다");
    assert_eq!(v["data"], json!({"owners":{"W1":"cliA"}}));
}

/// TC-CH2B-3: 사건 토픽은 구독할 수 있고 사건 본문을 나른다.
#[tokio::test]
async fn event_topics_carry_payloads() {
    let e = env().await;
    let mut c = dial(e.port).await;
    for topic in ["alert", "fs", "edges.notice"] {
        send(&mut c, json!({"t":"sub","topic":topic})).await;
    }
    assert!(
        next(&mut c, QUIET).await.is_none(),
        "사건 토픽 구독에 답이 왔다(unknown_topic?)"
    );
    e.srv
        .claude_account_alert(&otter_webserver_domain_claudeacct::Alert {
            kind: "autoswitch".into(),
            ..Default::default()
        });
    let v = next_of(&mut c, "alert", WAIT).await.expect("alert 가 없다");
    assert_eq!(v["t"], "event");
    assert_eq!(v["data"]["kind"], "autoswitch", "{v}");

    e.srv.publish_fs_changed(&[], true);
    let v = next_of(&mut c, "fs", WAIT).await.expect("fs 가 없다");
    assert_eq!(v["data"], json!({"overflow":true}));
}

/// TC-CH2B-4: 옮긴 방송은 명령 SSE 로 가지 않는다.
#[tokio::test]
async fn migrated_broadcasts_leave_sse() {
    let e = env().await;
    let r = call(
        &e.srv,
        "PUT",
        "/api/settings",
        &[("Content-Type", "application/json")],
        r#"{"termFontSize":14}"#,
        LOCAL,
    )
    .await;
    assert_eq!(r.status, 200);
    call(
        &e.srv,
        "PUT",
        "/api/workspace",
        &[("Content-Type", "application/json"), ("If-Match", "0")],
        r#"{"schemaVersion":2,"windows":[]}"#,
        LOCAL,
    )
    .await;
    e.srv.focus.claim("cliA", "W1");
    e.srv.broadcast_focus_owners();
    e.srv.claude_accounts_changed();
    e.srv.publish_fs_changed(&[], true);
    tokio::time::sleep(QUIET).await;
    for p in e.broker.published() {
        for a in [
            "workspace_changed",
            "settings_changed",
            "window_focus",
            "claude_accounts_changed",
            "claude_account_alert",
            "fs_changed",
        ] {
            assert!(!p.contains(a), "SSE 로 {a} 가 갔다: {p}");
        }
    }
}

/// 토픽 하나를 채널 없이 구독한다 — 서버 안의 발행을 보는 시험용 귀.
pub(crate) async fn tap(srv: &Server, topic: &str) -> Arc<crate::channel::Outbox> {
    let o = crate::channel::Outbox::new();
    srv.topics
        .subscribe(u64::MAX, &o, topic, None, None)
        .await
        .unwrap();
    o
}

/// 귀에 쌓인 프레임. 비동기 발행을 위해 `WAIT` 안에서 `want` 개가 될 때까지 기다린다.
pub(crate) async fn heard(o: &crate::channel::Outbox, want: usize) -> Vec<Value> {
    let mut out = Vec::new();
    let deadline = tokio::time::Instant::now() + WAIT;
    loop {
        while let Some(m) = o.pop() {
            if let crate::channel::Out::Text(t) = m {
                out.push(serde_json::from_str(&t).unwrap());
            }
        }
        if out.len() >= want || tokio::time::Instant::now() >= deadline {
            return out;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

/// 채널 토픽으로 옮겨 가 SSE 로 방송하지 않는 action 이다 (TC-CH2B-4). Go 기준 골든의 기대값에서
/// 이 방송을 걷는다 — 의도한 차이다.
const MIGRATED: &[&str] = &[
    "workspace_changed",
    "settings_changed",
    "update_changed",
    "window_focus",
    "edges_changed",
    "chat_changed",
    "claude_accounts_changed",
    "claude_account_alert",
    "fs_changed",
];

/// 방송 본문(따옴표로 감싼 꼴도)이 옮겨 간 action 인가.
pub(crate) fn migrated(p: &str) -> bool {
    MIGRATED.iter().any(|a| {
        p.contains(&format!(r#""action":"{a}""#)) || p.contains(&format!(r#"\"action\":\"{a}\""#))
    })
}

/// 골든 기대값에서 옮겨 간 방송 줄을 걷는다. `head` 가 있으면 그 줄과 다음 줄을 한 묶음으로 본다.
pub(crate) fn without_migrated(want: &str, head: Option<&str>) -> String {
    let lines: Vec<&str> = want.lines().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < lines.len() {
        let l = lines[i];
        if let Some(h) = head
            && l == h
            && lines.get(i + 1).is_some_and(|n| migrated(n))
        {
            i += 2;
            continue;
        }
        if head.is_none() && l.starts_with("SSE ") && migrated(l) {
            i += 1;
            continue;
        }
        out.push_str(l);
        out.push('\n');
        i += 1;
    }
    out
}
