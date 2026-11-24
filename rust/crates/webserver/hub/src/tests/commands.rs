use std::collections::HashSet;
use std::sync::Arc;
use std::time::{Duration, Instant};

use otter_shared_toolhub::ToolInfo;

use super::FakeBroker;
use crate::payloads::*;
use crate::*;

#[tokio::test]
async fn command_hub_broadcast() {
    let h = CommandHub::new();
    let a = h.add().unwrap();
    let b = h.add().unwrap();
    assert_eq!(h.broadcast(b"x"), 2);
    assert_eq!(a.recv().await.unwrap(), b"x");
    assert_eq!(b.try_recv().unwrap(), b"x");
    h.remove(&a);
    assert!(a.is_closed());
    assert_eq!(h.broadcast(b"y"), 1);
}

// 큐가 가득 찬 구독은 닫고 뺀다 (REPO_FIX 02 §3A-2).
#[tokio::test]
async fn command_hub_broadcast_drop_when_full() {
    let h = CommandHub::new();
    let s = h.add().unwrap();
    for _ in 0..CMD_SUB_QUEUE {
        assert_eq!(h.broadcast(b"m"), 1);
    }
    assert_eq!(h.broadcast(b"overflow"), 0);
    assert!(s.is_closed());
    assert_eq!(h.sub_count(), 0);
    tokio::time::timeout(Duration::from_secs(1), s.closed())
        .await
        .unwrap();
}

#[test]
fn command_hub_allowed_action() {
    let h = CommandHub::new();
    assert!(h.allowed_action("newTab"));
    assert!(!h.allowed_action("tool_attention"));
    assert!(!h.allowed_action(""));
}

#[test]
fn sub_cap_and_remove() {
    let h = CommandHub::new();
    let subs: Vec<_> = (0..SUB_CAP).map(|_| h.add().unwrap()).collect();
    assert!(h.add().is_none(), "상한을 넘겨 받았다");
    h.remove(&subs[0]);
    assert!(h.add().is_some(), "Remove 가 자리를 비우지 않았다");
    h.remove(&CmdSub::new()); // 모르는 구독은 아무 일도 아니다
}

#[tokio::test]
async fn await_delivers() {
    let h = CommandHub::new();
    let s = h.add().unwrap();
    let h2 = h.clone();
    let t = tokio::spawn(async move {
        h2.broadcast_and_await(b"p", "r1", Duration::from_secs(2))
            .await
    });
    s.recv().await.unwrap();
    let res = CmdResult {
        new_tabs: Some(vec![TabRef {
            uuid: "u".into(),
            tool_id: "7".into(),
        }]),
        ..Default::default()
    };
    h.deliver_result("r1", res.clone());
    let (got, n, timed_out) = t.await.unwrap();
    assert_eq!((got, n, timed_out), (res, 1, false));
    assert_eq!(h.pending_count(), 0);
}

#[tokio::test]
async fn await_timeout_and_no_subscriber() {
    let h = CommandHub::new();
    let start = Instant::now();
    let (_, n, to) = h
        .broadcast_and_await(b"p", "r0", Duration::from_secs(5))
        .await;
    assert_eq!((n, to), (0, false));
    assert!(start.elapsed() < Duration::from_secs(1));
    let _s = h.add().unwrap();
    let (r, n, to) = h
        .broadcast_and_await(b"p", "r1", Duration::from_millis(30))
        .await;
    assert_eq!((r, n, to), (CmdResult::default(), 1, true));
    assert_eq!(h.pending_count(), 0, "시한 뒤 pending 이 샜다");
    h.deliver_result("r1", CmdResult::default()); // 만료된 reqId
    h.deliver_result("nope", CmdResult::default());
}

#[test]
fn cmd_result_json_shape() {
    let empty = otter_gocompat::json::marshal(&CmdResult::default()).unwrap();
    assert_eq!(
        empty,
        br#"{"newWindows":null,"newPanes":null,"newTabs":null}"#
    );
    let full = CmdResult {
        new_windows: Some(vec!["w".into()]),
        new_panes: Some(vec![]),
        new_tabs: Some(vec![TabRef {
            uuid: "u".into(),
            tool_id: "1".into(),
        }]),
        new_groups: Some(vec!["g".into()]),
        position: Some(CmdPosition {
            container: "c".into(),
            index: 2,
            count: 3,
        }),
        error: "e".into(),
    };
    assert_eq!(
        otter_gocompat::json::marshal(&full).unwrap(),
        br#"{"newWindows":["w"],"newPanes":[],"newTabs":[{"uuid":"u","toolId":"1"}],"newGroups":["g"],"position":{"container":"c","index":2,"count":3},"error":"e"}"#
    );
    let back: CmdResult =
        otter_gocompat::json::unmarshal(&otter_gocompat::json::marshal(&full).unwrap()).unwrap();
    assert_eq!(back, full);
}

#[test]
fn new_req_id_unique() {
    let ids: HashSet<String> = (0..100).map(|_| new_req_id()).collect();
    assert_eq!(ids.len(), 100);
    assert!(ids.iter().all(|i| i.len() == 36));
}

#[test]
fn cmd_actions_derived_predicates() {
    let names = allowed_cmd_action_names();
    let mut sorted = names.clone();
    sorted.sort();
    assert_eq!(names, sorted);
    assert_eq!(names.len(), 27);
    for a in &names {
        if is_creating_action(a) || awaits_result(a) {
            assert!(
                is_single_executor_action(a),
                "{a}: creating/awaits ⇒ single"
            );
        }
    }
    for a in ["newWindow", "newTab", "splitH", "splitV", "newGroup"] {
        assert!(is_creating_action(a) && awaits_result(a), "{a}");
    }
    for a in ["moveTab", "moveWindow", "moveGroup"] {
        assert!(!is_creating_action(a) && awaits_result(a), "{a}");
    }
    for a in ["renameTab", "renameWindow", "renameGroup", "deleteGroup"] {
        assert!(
            is_allowed_cmd_action(a) && !is_single_executor_action(a),
            "{a}"
        );
    }
    for a in [
        "focus",
        "closeTab",
        "closeWindow",
        "detachTab",
        "windowNext",
        "windowPrev",
        "tabNext",
        "tabPrev",
        "paneUp",
        "paneDown",
        "paneLeft",
        "paneRight",
        "openUrl",
        "openEditorTab",
        "restoreTool",
    ] {
        assert!(is_single_executor_action(a) && !awaits_result(a), "{a}");
    }
    assert!(!is_creating_action("bogus") && !is_single_executor_action("bogus"));
}

#[test]
fn command_result_timeout_default() {
    assert_eq!(command_result_timeout(), Duration::from_secs(3));
}

// 본문 바이트는 Go `sse.Payload(map[string]any)` 와 같다.
#[test]
fn payload_bytes() {
    assert_eq!(
        String::from_utf8(tool_activity_payload("t", "working", "Bash", "<b>")).unwrap(),
        r#"{"action":"tool_activity","args":{"detail":"\u003cb\u003e","state":"working","tool":"Bash","toolId":"t"}}"#
    );
    assert_eq!(
        tool_attention_clear_payload("t"),
        br#"{"action":"tool_attention_clear","args":{"toolId":"t"}}"#
    );
    assert_eq!(
        tool_foreground_payload("t", ""),
        br#"{"action":"tool_foreground","args":{"name":"","toolId":"t"}}"#
    );
    assert_eq!(
        git_changed_payload("/r", "m1"),
        br#"{"action":"git_changed","args":{"mark":"m1","repo":"/r"}}"#
    );
    assert_eq!(
        background_changed_payload(),
        br#"{"action":"tools_background_changed"}"#
    );
    assert_eq!(update_changed_payload(), br#"{"action":"update_changed"}"#);
    assert_eq!(
        claude_accounts_changed_payload(),
        br#"{"action":"claude_accounts_changed"}"#
    );
    #[derive(serde::Serialize)]
    struct Alert {
        name: &'static str,
    }
    assert_eq!(
        claude_account_alert_payload(&Alert { name: "a" }),
        br#"{"action":"claude_account_alert","args":{"name":"a"}}"#
    );
    assert!(valid_activity_state("working") && !valid_activity_state("bogus"));
}

#[test]
fn attention_payload_carries_increasing_seq() {
    let seq = |p: &[u8]| -> u64 {
        let s = String::from_utf8_lossy(p).into_owned();
        let i = s.find(r#""seq":"#).unwrap() + 6;
        s[i..].split(',').next().unwrap().parse().unwrap()
    };
    let a = tool_attention_payload("t", "idle");
    let b = tool_attention_payload("t", "idle");
    assert!(seq(&b) > seq(&a));
    let s = String::from_utf8(a).unwrap();
    assert!(
        s.starts_with(r#"{"action":"tool_attention","args":{"reason":"idle","seq":"#)
            && s.ends_with(r#","toolId":"t"}}"#),
        "{s}"
    );
}

#[test]
fn foreground_snapshot_and_broadcast() {
    let tools = vec![
        ToolInfo {
            id: "1".into(),
            fg_name: "vim".into(),
            ..Default::default()
        },
        ToolInfo {
            id: "2".into(),
            ..Default::default()
        },
    ];
    let snap = foreground_snapshot(&tools);
    assert_eq!(snap.len(), 2);
    assert_eq!(
        snap[1],
        br#"{"action":"tool_foreground","args":{"name":"","toolId":"2"}}"#
    );
    let fb = FakeBroker::new();
    broadcast_foreground(fb.clone())("1", "vim");
    assert_eq!(
        fb.sent(),
        vec![r#"{"action":"tool_foreground","args":{"name":"vim","toolId":"1"}}"#]
    );
}

struct FgSource {
    feature: bool,
    lists: std::sync::Mutex<usize>,
}

impl ForegroundSource for FgSource {
    fn has_feature(&self, name: &str) -> bool {
        self.feature && name == otter_shared_toolipc::FEATURE_FOREGROUND_TICK
    }
    fn list(&self) -> Vec<ToolInfo> {
        *crate::lock(&self.lists) += 1;
        Vec::new()
    }
}

#[tokio::test]
async fn foreground_poll_lists_and_skips_daemon_ticker() {
    for (feature, want) in [(false, 2), (true, 0)] {
        let src = Arc::new(FgSource {
            feature,
            lists: Default::default(),
        });
        let stop = tokio_util::sync::CancellationToken::new();
        let (tx, rx) = tokio::sync::mpsc::channel(1);
        start_foreground_poll(Some(src.clone()), stop.clone(), rx);
        for _ in 0..2 {
            tx.send(()).await.unwrap();
        }
        tx.send(()).await.unwrap(); // 앞의 틱이 처리됐다
        tokio::time::sleep(Duration::from_millis(50)).await;
        stop.cancel();
        let n = *crate::lock(&src.lists);
        assert!(
            n >= want && (want != 0 || n == 0),
            "feature={feature} lists={n}"
        );
    }
    start_foreground_poll(
        None,
        tokio_util::sync::CancellationToken::new(),
        tokio::sync::mpsc::channel(1).1,
    );
}
