//! ISSUE_TREE_CHAT_SRS FR-ITR-1·3·10 (TC-ITH-18 서버 몫): 트리 Run 의 채팅 방 기록과 데몬의 트리 방 규칙 맞추기.

use std::sync::Arc;
use std::time::{Duration, Instant};

use otter_shared_chatwire as chatwire;
use serde_json::Value;

use super::golden_554::run_env;
use super::peer::FakeChat;
use super::support::*;

async fn post(env: &super::golden_554::RunEnv, target: &str, body: &str) -> (u16, Value) {
    let r = call(
        &env.srv,
        "POST",
        target,
        &[("Content-Type", "application/json")],
        body,
        LOCAL,
    )
    .await;
    (
        r.status,
        serde_json::from_str(&r.body).unwrap_or(Value::Null),
    )
}

/// 데몬에 간 마지막 tree 연산의 인자다.
fn last_tree(chat: &FakeChat) -> Option<chatwire::TreeArgs> {
    chat.got
        .lock()
        .unwrap()
        .iter()
        .rev()
        .find(|p| p.op == chatwire::OP_TREE)
        .map(|p| serde_json::from_slice(&p.args.0).unwrap())
}

async fn eventually(what: &str, mut cond: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < deadline {
        if cond() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    panic!("{what}: 시간 초과");
}

#[tokio::test(flavor = "multi_thread")]
async fn tree_room_rule_follows_run() {
    let chat = Arc::new(FakeChat {
        ready: true,
        ..FakeChat::default()
    });
    let c2 = chat.clone();
    let env = run_env(true, move |d| d.chat_daemon = Some(c2));
    let (code, out) = post(
        &env,
        "/api/runs",
        r#"{"objective":"o","projection":"dedicated-window","windowId":"win-1","toolId":"coord-1","tree":"perf:2","issueDir":"/repo/perf/issues","chatRoom":"room-1"}"#,
    )
    .await;
    assert_eq!(code, 200, "{out}");
    assert_eq!(out["chatRoom"], "room-1");
    let run_id = out["id"].as_str().unwrap().to_owned();
    let (code, out) = post(
        &env,
        "/api/runs/members",
        &format!(r#"{{"runId":"{run_id}","role":"perf:2","agent":"claude","id":"tab-b","assign":{{"issue":"2"}}}}"#),
    )
    .await;
    assert_eq!(code, 200, "{out}");
    let member_id = out["id"].as_str().unwrap().to_owned();
    let r = get(&env.srv, &format!("/api/runs/preamble?member={member_id}")).await;
    let v: Value = serde_json::from_str(&r.body).unwrap();
    assert_eq!(
        v["promptFile"], true,
        "트리 방이 있는 트리 멤버는 첫 지시를 파일로 받는다 (FR-ITR-6)"
    );
    assert!(v["preamble"].as_str().unwrap().contains("트리 방: room-1"));
    eventually("멤버를 더하면 규칙에 그 도구가 든다", || {
        last_tree(&chat).is_some_and(|a| {
            let t = a.tools.unwrap_or_default();
            a.room == "room-1"
                && !a.close
                && t.contains(&"coord-1".to_owned())
                && t.contains(&"tool-b".to_owned())
        })
    })
    .await;
    let (code, out) = post(
        &env,
        "/api/runs/close",
        &format!(r#"{{"runId":"{run_id}","force":true}}"#),
    )
    .await;
    assert_eq!(code, 200, "{out}");
    eventually("트리가 닫히면 규칙을 닫는다", || {
        last_tree(&chat).is_some_and(|a| a.room == "room-1" && a.close)
    })
    .await;
}

/// 방이 없는 트리 Run 은 데몬에 아무것도 보내지 않는다. chatRoom 은 트리와 함께만 받는다.
#[tokio::test(flavor = "multi_thread")]
async fn no_room_no_rule() {
    let chat = Arc::new(FakeChat {
        ready: true,
        ..FakeChat::default()
    });
    let c2 = chat.clone();
    let env = run_env(true, move |d| d.chat_daemon = Some(c2));
    let (code, _) = post(
        &env,
        "/api/runs",
        r#"{"objective":"o","projection":"dedicated-window","toolId":"coord-1","tree":"o/r#5"}"#,
    )
    .await;
    assert_eq!(code, 200);
    let (code, out) = post(
        &env,
        "/api/runs",
        r#"{"objective":"o","projection":"dedicated-window","toolId":"coord-2","chatRoom":"r"}"#,
    )
    .await;
    assert_eq!(code, 400, "{out}");
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(last_tree(&chat).is_none());
}
