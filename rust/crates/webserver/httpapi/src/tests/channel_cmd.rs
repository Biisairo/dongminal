//! 채널의 명령·사건 스트림 (`perf/CHANNEL_PROTOCOL.md` §10.2 C2a). 실제 TCP 로 업그레이드한다.

use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use super::wsc::{Message, TextOf};
use futures_util::{SinkExt, StreamExt};
use otter_shared_toolhub::ToolInfo;
use otter_webserver_hub::{CMD_SUB_QUEUE, CommandBroker, CommandHub, SUB_CAP};
use serde_json::{Value, json};

use super::fakes::*;
use super::support::*;
use super::ws::listen;
use crate::{Deps, Server};

type Client = super::wsc::Client;

const WAIT: Duration = Duration::from_secs(5);

struct Env {
    _dir: tempfile::TempDir,
    srv: Arc<Server>,
    port: u16,
}

async fn env(deps: Deps) -> Env {
    let dir = tempfile::tempdir().unwrap();
    let srv = server(dir.path(), deps);
    let port = listen(srv.clone()).await;
    Env {
        _dir: dir,
        srv,
        port,
    }
}

async fn dial(port: u16) -> Client {
    super::wsc::dial(port, "/channel?v=1").await
}

async fn send(c: &mut Client, v: Value) {
    c.send(Message::text(v.to_string())).await.unwrap();
}

async fn next_json_within(c: &mut Client, limit: Duration) -> Option<Value> {
    loop {
        match tokio::time::timeout(limit, c.next()).await {
            Ok(Some(Ok(Message::Text(t)))) => return serde_json::from_str(t.as_str()).ok(),
            Ok(Some(Ok(Message::Ping(_) | Message::Pong(_)))) => continue,
            _ => return None,
        }
    }
}

async fn next_json(c: &mut Client) -> Option<Value> {
    next_json_within(c, WAIT).await
}

/// `pred` 를 만족하는 프레임까지 읽는다.
async fn until(c: &mut Client, pred: impl Fn(&Value) -> bool) -> Option<Value> {
    while let Some(v) = next_json(c).await {
        if pred(&v) {
            return Some(v);
        }
    }
    None
}

async fn hello(c: &mut Client, client: Option<&str>) {
    let mut h = json!({"t":"hello","slots":[]});
    if let Some(id) = client {
        h["client"] = json!(id);
    }
    send(c, h).await;
    let v = next_json(c).await.expect("hello 답이 없다");
    assert_eq!(v["t"], "hello", "{v}");
}

async fn eventually(what: &str, f: impl Fn() -> bool) {
    let deadline = tokio::time::Instant::now() + WAIT;
    while !f() && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(f(), "{what}");
}

/// TC-CH2A-1 (포커스 몫 — 파일 감시 몫은 `fs_5572.rs`)
#[tokio::test]
async fn client_holds_focus_lease_for_channel_lifetime() {
    let e = env(Deps::default()).await;
    let mut c = dial(e.port).await;
    hello(&mut c, Some("cliA")).await;
    eventually("client 가 포커스 구독을 쥐지 않았다", || {
        e.srv.focus.live_count() == 1
    })
    .await;
    drop(c);
    eventually("닫힌 채널이 소유권을 쥐고 있다", || {
        e.srv.focus.live_count() == 0
    })
    .await;
}

/// TC-CH2A-2
#[tokio::test]
async fn client_hello_triggers_update_check_once() {
    let f = Arc::new(FakeUpdates::default());
    let e = env(Deps {
        updates: Some(f.clone()),
        ..Deps::default()
    })
    .await;
    let mut slot_only = dial(e.port).await;
    hello(&mut slot_only, None).await;
    let mut c = dial(e.port).await;
    hello(&mut c, Some("cliA")).await;
    hello(&mut c, Some("cliA")).await;
    eventually("판 확인이 걸리지 않았다", || {
        f.triggers.load(Ordering::SeqCst) >= 1
    })
    .await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(f.triggers.load(Ordering::SeqCst), 1);
}

/// TC-CH2A-3
#[tokio::test]
async fn broadcast_reaches_client_channels_as_cmd() {
    let h: Arc<dyn CommandBroker> = CommandHub::new();
    let e = env(Deps {
        commands: Some(h.clone()),
        ..Deps::default()
    })
    .await;
    let mut anon = dial(e.port).await;
    hello(&mut anon, None).await;
    let mut c = dial(e.port).await;
    hello(&mut c, Some("cliA")).await;
    eventually("명령 구독이 붙지 않았다", || {
        h.broadcast(br#"{"action":"noop-probe"}"#) == 1
    })
    .await;
    assert_eq!(h.broadcast(br#"{"action":"x","args":{"a":1}}"#), 1);
    let v = until(&mut c, |v| v["action"] == "x").await.unwrap();
    assert_eq!(v, json!({"t":"cmd","action":"x","args":{"a":1}}));
    assert!(
        next_json_within(&mut anon, Duration::from_millis(200))
            .await
            .is_none(),
        "client 없는 채널에 명령이 왔다"
    );
}

/// TC-CH2A-4
#[tokio::test]
async fn foreground_snapshot_follows_hello() {
    let hub = Arc::new(FakeHub {
        tools: vec![
            ToolInfo {
                id: "t1".into(),
                fg_name: "~".into(),
                ..ToolInfo::default()
            },
            ToolInfo {
                id: "t2".into(),
                ..ToolInfo::default()
            },
        ]
        .into(),
        ..FakeHub::default()
    });
    let e = env(Deps {
        tools: Some(hub),
        ..Deps::default()
    })
    .await;
    let mut c = dial(e.port).await;
    hello(&mut c, Some("cliA")).await;
    let mut got = Vec::new();
    for _ in 0..2 {
        got.push(next_json(&mut c).await.unwrap());
    }
    got.sort_by_key(|v| v["args"]["toolId"].as_str().unwrap_or_default().to_owned());
    assert_eq!(
        got,
        [
            json!({"t":"cmd","action":"tool_foreground","args":{"name":"~","toolId":"t1"}}),
            json!({"t":"cmd","action":"tool_foreground","args":{"name":"","toolId":"t2"}}),
        ]
    );
}

/// TC-CH2A-5
#[tokio::test]
async fn cmd_result_answers_waiting_command() {
    let h: Arc<dyn CommandBroker> = CommandHub::new();
    let e = env(Deps {
        commands: Some(h.clone()),
        ..Deps::default()
    })
    .await;
    let mut c = dial(e.port).await;
    hello(&mut c, Some("cliA")).await;
    eventually("명령 구독이 붙지 않았다", || {
        h.broadcast(br#"{"action":"noop-probe"}"#) == 1
    })
    .await;
    let srv = e.srv.clone();
    let post = tokio::spawn(async move {
        post_json(&srv, "/api/commands", r#"{"action":"splitH"}"#)
            .await
            .json()
    });
    let cmd = until(&mut c, |v| v["action"] == "splitH").await.unwrap();
    let req_id = cmd["reqId"].as_str().expect("reqId 가 없다").to_owned();
    send(
        &mut c,
        json!({"t":"cmd.result","reqId":req_id,"newPanes":["r10"],
               "newTabs":[{"uuid":"t10","toolId":"410"}]}),
    )
    .await;
    let v = tokio::time::timeout(WAIT, post).await.unwrap().unwrap();
    assert_eq!(v["newTabs"], json!([{"uuid":"t10","toolId":"410"}]), "{v}");
    assert_eq!(v["newPanes"], json!(["r10"]), "{v}");
}

/// TC-CH2A-6
#[tokio::test]
async fn command_sub_cap_is_error_and_channel_stays() {
    let h: Arc<dyn CommandBroker> = CommandHub::new();
    let _held: Vec<_> = (0..SUB_CAP).map(|_| h.add().unwrap()).collect();
    let e = env(Deps {
        commands: Some(h.clone()),
        ..Deps::default()
    })
    .await;
    let mut c = dial(e.port).await;
    hello(&mut c, Some("cliA")).await;
    let v = until(&mut c, |v| v["t"] == "error").await.unwrap();
    assert_eq!(v["code"], "subscribe_rejected");
    send(&mut c, json!({"t":"ping","n":3})).await;
    assert_eq!(until(&mut c, |v| v["t"] == "pong").await.unwrap()["n"], 3);
}

/// 1.17: 큐가 넘쳐 허브가 명령 구독을 닫으면 채널도 닫는다 — 브라우저가 다시 연결해 새로 구독한다.
#[tokio::test]
async fn overflowed_command_sub_closes_channel() {
    let h: Arc<dyn CommandBroker> = CommandHub::new();
    let e = env(Deps {
        commands: Some(h.clone()),
        ..Deps::default()
    })
    .await;
    let mut c = dial(e.port).await;
    hello(&mut c, Some("cliA")).await;
    eventually("명령 구독이 붙지 않았다", || {
        h.broadcast(br#"{"action":"noop-probe"}"#) == 1
    })
    .await;
    // 단일 스레드 런타임이라 펌프가 끼어들지 못해 큐가 넘친다.
    for _ in 0..=CMD_SUB_QUEUE {
        h.broadcast(br#"{"action":"flood"}"#);
    }
    assert_eq!(h.broadcast(br#"{"action":"after"}"#), 0);
    let closed = loop {
        match tokio::time::timeout(WAIT, c.next()).await {
            Ok(Some(Ok(Message::Close(_)))) | Ok(None) | Ok(Some(Err(_))) => break true,
            Ok(Some(Ok(_))) => continue,
            Err(_) => break false,
        }
    };
    assert!(closed, "명령 구독을 잃은 채널이 열린 채 남았다");
}

/// TC-CH2A-7
#[tokio::test]
async fn old_sse_and_result_endpoints_are_gone() {
    let e = env(Deps {
        commands: Some(CommandHub::new()),
        ..Deps::default()
    })
    .await;
    assert_eq!(get(&e.srv, "/api/commands/sse").await.status, 404);
    assert_eq!(
        post_json(&e.srv, "/api/command-result", r#"{"reqId":"a"}"#)
            .await
            .status,
        404
    );
}
