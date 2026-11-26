//! UX_BATCH14_SRS FR-ITV-1·2·4·10 (TC-UB14-6·7): 트리의 이슈 원천 조회 `GET /api/runs/issue-tree`.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use serde_json::{Value, json};

use super::golden_554::{RunEnv, run_env, run_env_with};
use super::support::*;
use crate::runs_issue_tree::{GhCall, GhFail};

async fn post(env: &RunEnv, target: &str, body: &str) -> (u16, Value) {
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

async fn get_json(env: &RunEnv, target: &str) -> (u16, Value) {
    let r = get(&env.srv, target).await;
    (
        r.status,
        serde_json::from_str(&r.body).unwrap_or(Value::Null),
    )
}

async fn start_tree(env: &RunEnv, tree: &str, issue_dir: &str) {
    let dir = if issue_dir.is_empty() {
        String::new()
    } else {
        format!(r#","issueDir":"{issue_dir}""#)
    };
    let (code, out) = post(
        env,
        "/api/runs",
        &format!(r#"{{"objective":"o","projection":"dedicated-window","windowId":"win-1","toolId":"coord-1","tree":"{tree}"{dir}}}"#),
    )
    .await;
    assert_eq!(code, 200, "{out}");
}

fn keys(out: &Value) -> Vec<(String, String)> {
    out["issues"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| {
            (
                i["key"].as_str().unwrap().to_owned(),
                i["parent"].as_str().unwrap().to_owned(),
            )
        })
        .collect()
}

fn issue(number: u64, sub_total: u64, id: &str) -> Value {
    json!({"id": id, "number": number, "title": format!("t{number}"), "state": if number == 3 { "CLOSED" } else { "OPEN" },
        "url": format!("https://github.com/o/r/issues/{number}"), "repository": {"nameWithOwner": "o/r"},
        "subIssuesSummary": {"total": sub_total}})
}

/// 가짜 gh: 첫 단계(repository)는 #1 아래 #2(하위 1)·#3, 다음 단계(nodes)는 #2 아래 #4 다.
fn fake_gh(calls: Arc<AtomicUsize>, delay: Duration) -> GhCall {
    Arc::new(move |args: Vec<String>| {
        let calls = calls.clone();
        Box::pin(async move {
            calls.fetch_add(1, Ordering::SeqCst);
            tokio::time::sleep(delay).await;
            let q = args
                .iter()
                .find(|a| a.starts_with("query="))
                .cloned()
                .unwrap_or_default();
            if q.contains("repository(") {
                let mut root = issue(1, 2, "N1");
                root["subIssues"] = json!({"nodes": [issue(2, 1, "N2"), issue(3, 0, "N3")]});
                Ok(json!({"data": {"repository": {"issue": root}}}))
            } else {
                assert!(args.iter().any(|a| a == "ids[]=N2"), "{args:?}");
                Ok(
                    json!({"data": {"nodes": [{"id": "N2", "subIssues": {"nodes": [issue(4, 0, "N4")]}}]}}),
                )
            }
        })
    })
}

fn env_with_gh(gh: GhCall, gap: Duration) -> RunEnv {
    run_env_with(
        true,
        |_| {},
        move |s| {
            *s.issue_trees.gh.lock().unwrap() = gh;
            s.issue_trees.min_gap = gap;
        },
    )
}

#[tokio::test]
async fn github_tree_is_read_level_by_level_in_sub_issue_order() {
    let calls = Arc::new(AtomicUsize::new(0));
    let env = env_with_gh(fake_gh(calls.clone(), Duration::ZERO), Duration::ZERO);
    start_tree(&env, "o/r#1", "").await;
    let (code, out) = get_json(&env, "/api/runs/issue-tree?ref=o%2Fr%231").await;
    assert_eq!(code, 200, "{out}");
    assert_eq!(out["storage"], "github");
    let k = |a: &str, b: &str| (a.to_owned(), b.to_owned());
    assert_eq!(
        keys(&out),
        vec![
            k("o/r#1", ""),
            k("o/r#2", "o/r#1"),
            k("o/r#4", "o/r#2"),
            k("o/r#3", "o/r#1")
        ]
    );
    assert_eq!(out["issues"][0]["num"], "#1");
    assert_eq!(out["issues"][3]["state"], "closed");
    assert_eq!(out["issues"][1]["url"], "https://github.com/o/r/issues/2");
    assert_eq!(calls.load(Ordering::SeqCst), 2, "단계마다 한 번");
}

#[tokio::test]
async fn github_tree_uses_cache_unless_refreshed() {
    let calls = Arc::new(AtomicUsize::new(0));
    let env = env_with_gh(fake_gh(calls.clone(), Duration::ZERO), Duration::ZERO);
    start_tree(&env, "o/r#1", "").await;
    get_json(&env, "/api/runs/issue-tree?ref=o%2Fr%231").await;
    get_json(&env, "/api/runs/issue-tree?ref=o%2Fr%231").await;
    assert_eq!(
        calls.load(Ordering::SeqCst),
        2,
        "refresh 없는 GET 은 gh 를 부르지 않는다 (FR-ITV-3·4)"
    );
    get_json(&env, "/api/runs/issue-tree?ref=o%2Fr%231&refresh=1").await;
    assert_eq!(calls.load(Ordering::SeqCst), 4);
}

#[tokio::test]
async fn concurrent_refreshes_share_one_fetch() {
    let calls = Arc::new(AtomicUsize::new(0));
    let env = env_with_gh(
        fake_gh(calls.clone(), Duration::from_millis(50)),
        Duration::ZERO,
    );
    start_tree(&env, "o/r#1", "").await;
    let a = get_json(&env, "/api/runs/issue-tree?ref=o%2Fr%231&refresh=1");
    let b = get_json(&env, "/api/runs/issue-tree?ref=o%2Fr%231&refresh=1");
    let ((ca, oa), (cb, ob)) = tokio::join!(a, b);
    assert_eq!((ca, cb), (200, 200));
    assert_eq!(keys(&oa), keys(&ob));
    assert_eq!(
        calls.load(Ordering::SeqCst),
        2,
        "겹친 새로고침은 한 번의 조회다"
    );
}

#[tokio::test]
async fn refresh_within_min_gap_returns_last_result() {
    let calls = Arc::new(AtomicUsize::new(0));
    let env = env_with_gh(
        fake_gh(calls.clone(), Duration::ZERO),
        Duration::from_secs(60),
    );
    start_tree(&env, "o/r#1", "").await;
    get_json(&env, "/api/runs/issue-tree?ref=o%2Fr%231").await;
    get_json(&env, "/api/runs/issue-tree?ref=o%2Fr%231&refresh=1").await;
    assert_eq!(
        calls.load(Ordering::SeqCst),
        2,
        "최소 간격 안의 새로고침은 합친다"
    );
}

#[tokio::test]
async fn gh_failure_is_reported_without_retry() {
    let calls = Arc::new(AtomicUsize::new(0));
    let c = calls.clone();
    let gh: GhCall = Arc::new(move |_args| {
        c.fetch_add(1, Ordering::SeqCst);
        Box::pin(async {
            Err(GhFail {
                code: "gh_unavailable",
                message: "gh not found".to_owned(),
            })
        })
    });
    let env = env_with_gh(gh, Duration::ZERO);
    start_tree(&env, "o/r#1", "").await;
    let (code, out) = get_json(&env, "/api/runs/issue-tree?ref=o%2Fr%231").await;
    assert_eq!(code, 200, "{out}");
    assert_eq!(out["error"], "gh_unavailable");
    assert_eq!(out["issues"], json!([]));
    get_json(&env, "/api/runs/issue-tree?ref=o%2Fr%231").await;
    assert_eq!(
        calls.load(Ordering::SeqCst),
        1,
        "실패도 마지막 결과다 — 다시 부르지 않는다 (FR-ITV-10)"
    );
}

#[tokio::test]
async fn local_tree_reads_the_issue_folder_subtree() {
    let dir = tempfile::tempdir().unwrap();
    let d = otter_shared_issuefile::Dir::new(dir.path());
    for (id, title) in [
        ("1", "root"),
        ("1.1", "a"),
        ("1.1.1", "aa"),
        ("1.2", "b"),
        ("2", "other"),
    ] {
        d.create(id, title, &[]).unwrap();
    }
    let env = run_env(true, |_| {});
    let p = dir.path().to_string_lossy().into_owned();
    start_tree(&env, "trial:1", &p).await;
    let (code, out) = get_json(&env, "/api/runs/issue-tree?ref=trial%3A1").await;
    assert_eq!(code, 200, "{out}");
    assert_eq!(out["storage"], "local");
    let k = |a: &str, b: &str| (a.to_owned(), b.to_owned());
    assert_eq!(
        keys(&out),
        vec![k("1", ""), k("1.1", "1"), k("1.1.1", "1.1"), k("1.2", "1")]
    );
    assert_eq!(out["issues"][1]["title"], "a");
    assert_eq!(out["issues"][1]["num"], "1.1");
    assert!(out["issues"][1]["path"].as_str().unwrap().starts_with(&p));
    assert!(out["issues"][0]["state"].is_string());
}

#[tokio::test]
async fn missing_ref_and_unknown_tree_are_rejected() {
    let env = run_env(true, |_| {});
    let (code, _) = get_json(&env, "/api/runs/issue-tree").await;
    assert_eq!(code, 400);
    let (code, _) = get_json(&env, "/api/runs/issue-tree?ref=o%2Fr%239").await;
    assert_eq!(code, 404);
}
