//! ISSUE_TREE_CHAT_SRS FR-LIS-7·17 (TC-ITH-16): 로컬 이슈 트리의 원본 폴더 기록과 조회, 트리 응답의 보관 방식.

use serde_json::Value;

use super::golden_554::{RunEnv, run_env};
use super::support::*;

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

async fn start_tree(env: &RunEnv, coord: &str, tree: &str, issue_dir: &str) -> (u16, Value) {
    let dir = if issue_dir.is_empty() {
        String::new()
    } else {
        format!(r#","issueDir":"{issue_dir}""#)
    };
    post(
        env,
        "/api/runs",
        &format!(
            r#"{{"objective":"o","projection":"dedicated-window","windowId":"win-1","toolId":"{coord}","tree":"{tree}"{dir}}}"#
        ),
    )
    .await
}

#[tokio::test]
async fn local_tree_issue_dir_is_found_by_member_and_coordinator() {
    let env = run_env(true, |_| {});
    let (code, out) = start_tree(&env, "coord-1", "perf:2", "/repo/perf/issues").await;
    assert_eq!(code, 200, "{out}");
    assert_eq!(out["issueDir"], "/repo/perf/issues");
    let run_id = out["id"].as_str().unwrap().to_owned();
    let (code, out) = post(
        &env,
        "/api/runs/members",
        &format!(r#"{{"runId":"{run_id}","role":"2","agent":"claude","id":"tab-b","assign":{{"issue":"2"}}}}"#),
    )
    .await;
    assert_eq!(code, 200, "{out}");
    for caller in ["tool-b", "coord-1"] {
        let (code, out) = get_json(&env, &format!("/api/runs/issues?toolId={caller}")).await;
        assert_eq!(code, 200, "{caller}: {out}");
        assert_eq!(out["runId"], run_id.as_str());
        assert_eq!(out["tree"], "perf:2");
        assert_eq!(out["storage"], "local");
        assert_eq!(out["issueDir"], "/repo/perf/issues");
    }
    let (code, out) = get_json(&env, "/api/runs/issues?toolId=stranger").await;
    assert_eq!(code, 403, "{out}");
}

#[tokio::test]
async fn issue_dir_must_be_absolute_and_with_tree() {
    let env = run_env(true, |_| {});
    let (code, out) = start_tree(&env, "coord-1", "perf:2", "rel/issues").await;
    assert_eq!(code, 400, "{out}");
    let (code, out) = post(
        &env,
        "/api/runs",
        r#"{"objective":"o","projection":"dedicated-window","toolId":"c","issueDir":"/x"}"#,
    )
    .await;
    assert_eq!(code, 400, "{out}");
}

/// FR-LIS-1·14: coord 는 Run 에 기록되고, 그 멤버는 일꾼 프리앰블을 받는다. 로컬 트리의 그룹은
/// 표지가 없으므로 이름(`<별칭>:<ID> <제목>`)으로 찾는다.
#[tokio::test]
async fn coord_mode_and_local_group_reach_preamble() {
    let env = run_env(true, |_| {});
    *env.ws.raw.lock().unwrap() = r#"{"windows":[{"id":"win-1","layout":{"tabs":[{"id":"tab-b"}]}}],"windowGroups":[{"id":"grp-gh","tree":{"repo":"o/r","root":1}},{"id":"grp-perf","name":"perf:2 묶음 둘"}]}"#.as_bytes().to_vec();
    let (code, out) = post(
        &env,
        "/api/runs",
        r#"{"objective":"o","projection":"dedicated-window","windowId":"win-1","toolId":"coord-1","tree":"perf:2","issueDir":"/repo/perf/issues","mode":"coord"}"#,
    )
    .await;
    assert_eq!(code, 200, "{out}");
    assert_eq!(out["mode"], "coord");
    let run_id = out["id"].as_str().unwrap().to_owned();
    let (code, out) = post(
        &env,
        "/api/runs/members",
        &format!(r#"{{"runId":"{run_id}","role":"perf:2.1","agent":"claude","id":"tab-b","assign":{{"issue":"2.1"}}}}"#),
    )
    .await;
    assert_eq!(code, 200, "{out}");
    let p = out["preamble"].as_str().unwrap();
    assert!(p.contains("(coord)의 일꾼이다"), "{p}");
    assert!(p.contains("그룹: grp-perf"), "{p}");
    let (code, out) = post(
        &env,
        "/api/runs",
        r#"{"objective":"o","projection":"dedicated-window","toolId":"coord-2","tree":"o/r#9","mode":"bogus"}"#,
    )
    .await;
    assert_eq!(code, 400, "{out}");
}

/// FR-LIS-17: 트리 응답은 로컬이면 보관 방식과 원본 폴더를 싣는다. GitHub 트리는 Go 기준선 모양 그대로(키 없음 = github)다.
#[tokio::test]
async fn runs_tree_carries_storage() {
    let env = run_env(true, |_| {});
    start_tree(&env, "coord-1", "perf:2", "/repo/perf/issues").await;
    start_tree(&env, "coord-2", "o/r#7", "").await;
    let (code, out) = get_json(&env, "/api/runs/tree?ref=perf%3A2").await;
    assert_eq!(code, 200, "{out}");
    assert_eq!(out["storage"], "local");
    assert_eq!(out["issueDir"], "/repo/perf/issues");
    let (_, out) = get_json(&env, "/api/runs/tree?ref=o%2Fr%237").await;
    assert!(
        out.get("storage").is_none() && out.get("issueDir").is_none(),
        "{out}"
    );
    let (_, out) = get_json(&env, "/api/runs/issues?toolId=coord-2").await;
    assert_eq!(out["storage"], "github");
}
