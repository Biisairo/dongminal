use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use otter_daemon_ipc::PanedServer;
use otter_gocompat::json;
use otter_shared_activity as activity;
use otter_shared_edge::Config;
use otter_shared_otterenv as otterenv;
use otter_shared_toolhub::{ActivityState, ToolManager};

use crate::edge::{HELPER_DROP, HelperWatch, resting};
use crate::{referenced_tools, start_edge};

// PEER_CHAT_SRS §3.10 (FR-PCH-61): 쉬는 중은 idle·done 뿐이다. 보고가 없으면 쉬는 중이 아니다.
#[test]
fn resting_is_idle_or_done() {
    for (state, want) in [
        (activity::IDLE, true),
        (activity::DONE, true),
        (activity::WORKING, false),
        (activity::WAITING, false),
        (activity::ENDED, false),
    ] {
        let a = ActivityState {
            state: state.into(),
            ..ActivityState::default()
        };
        assert_eq!(resting(Some(&a)), want, "{state}");
    }
    assert!(!resting(None), "보고 없음을 쉬는 중으로 봤다");
}

// PEER_CHAT_SRS §3.12a R-7: 키는 얻으면 바로 싣고, 비우는 것은 연속 3번 실패한 뒤다.
#[test]
fn helper_watch_drops_after_three_failures() {
    assert_eq!(HELPER_DROP, 3);
    assert_eq!(crate::edge::HELPER_EVERY, Duration::from_secs(30));
    let mut w = HelperWatch::default();
    assert_eq!(w.next("K", true).as_deref(), Some("K"));
    for i in 1..=2 {
        assert_eq!(w.next("", false), None, "{i}번째 실패에 키를 바꿨다");
    }
    assert_eq!(
        w.next("", false).as_deref(),
        Some(""),
        "3번째 실패는 비워야 한다"
    );
    assert_eq!(w.next("K2", true).as_deref(), Some("K2"));
    assert_eq!(w.next("", false), None, "성공 뒤 첫 실패는 0 부터 센다");
    // 오류 없이 빈 키도 실패로 센다(Go: err == nil && key != "").
    let mut w = HelperWatch::default();
    for _ in 0..2 {
        assert_eq!(w.next("", true), None);
    }
    assert_eq!(w.next("", true).as_deref(), Some(""));
}

// FR-EM-14: 없는 파일·해석 실패는 빈 집합이고, 탭이 가리키는 도구 id 를 낸다.
#[test]
fn referenced_tools_reads_workspace() {
    let d = tempfile::tempdir().unwrap();
    let p = d.path().join(otterenv::WORKSPACE_FILE);
    assert!(referenced_tools(&p).is_empty());
    std::fs::write(&p, b"{not json").unwrap();
    assert!(referenced_tools(&p).is_empty());
    std::fs::write(&p, b"{}").unwrap();
    assert!(referenced_tools(&p).is_empty());
    let ws = br#"{"schemaVersion":2,"windows":[{"id":"w","layout":{"type":"pane","id":"p","tabs":[{"id":"t1","toolId":"tool-a"},{"id":"t2","toolId":"tool-b"}]}}]}"#;
    std::fs::write(&p, ws).unwrap();
    let want: HashSet<String> = ["tool-a", "tool-b"].map(String::from).into();
    assert_eq!(referenced_tools(&p), want);
}

// PEER_DAEMON_SRS FR-PDM-20~22: 데몬이 노드를 세운다 — 신원을 만들고, 켜진 설정이면 노드 소켓을
// 듣는다. 돌려준 함수가 노드 소켓을 닫는다.
#[tokio::test(flavor = "multi_thread")]
async fn start_edge_identity_and_node_socket() {
    let home = tempfile::Builder::new()
        .prefix("be")
        .tempdir_in("/tmp")
        .unwrap();
    let home = home.path().to_path_buf();
    let raw = json::marshal(&Config {
        enabled: true,
        name: "bnode".into(),
        ..Config::default()
    })
    .unwrap();
    std::fs::write(home.join(otterenv::EDGES_FILE), raw).unwrap();
    let tools = tempfile::tempdir().unwrap();
    let pm = Arc::new(ToolManager::new(&tools.path().to_string_lossy(), None));
    let ps = PanedServer::new(Arc::clone(&pm), &home.join("s"), None);

    let close_edge = start_edge(&home, &ps, &pm);

    assert!(
        home.join(otterenv::EDGE_KEY_FILE).exists(),
        "노드 신원이 없다"
    );
    let sock = otter_shared_edgerelay::node_socket_path(&home);
    let ipc = otter_shared_platform::current().ipc;
    let s2 = sock.clone();
    let c = tokio::task::spawn_blocking(move || ipc.dial(&s2, Duration::from_secs(1)))
        .await
        .unwrap();
    assert!(
        c.is_ok(),
        "켜진 설정인데 노드 소켓을 듣지 않는다: {:?}",
        c.err()
    );
    drop(c);

    tokio::task::spawn_blocking(close_edge).await.unwrap();
    pm.stop_saving();
    // Rust 의 edge 리스너는 닫기를 리스너 태스크에 알리고, 태스크가 소켓을 놓는다(비동기).
    let closed = tokio::task::spawn_blocking(move || {
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while std::time::Instant::now() < deadline {
            if ipc.dial(&sock, Duration::from_millis(200)).is_err() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        false
    })
    .await
    .unwrap();
    assert!(closed, "닫은 뒤에도 노드 소켓이 열려 있다");
}
