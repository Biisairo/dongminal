//! Go `handlers_git_operation_test.go` 의 이식 — /api/git/operation (GIT_ACTIONS_SRS FR-GIT-252).
//! Go 의 `gitM5Fake` 대신 같은 gitdir 표식 판정을 지나는 `WriteFake` 를 쓴다.

use std::sync::Arc;

use dm_webserver_apierr as apierr;
use serde_json::json;

use super::harness::*;
use super::wfake::{WEnv, WriteFake, req_await, wserver};
use crate::GitServer;

fn body(rest: &str) -> String {
    format!(r#"{{"repo":{}{rest}}}"#, q(&abs(&["work", "repo"])))
}

/// gitdir 에 표식을 심어 진행 중 상태를 만든다 (Go `opInProgress`).
fn op_in_progress(f: &WriteFake, name: &str) {
    std::fs::create_dir(std::path::Path::new(&f.git_dir()).join(name)).unwrap();
}

async fn post(e: &WEnv, b: &str) -> (u16, serde_json::Value) {
    let r = req(&e.s, "POST", "/api/git/operation", b).await;
    (r.code, r.json())
}

// OP1 (FR-GIT-89·252): 중단은 `confirm:true` 없이 400 이고 실행되지 않는다.
#[tokio::test]
async fn api_git_operation_abort_requires_confirm() {
    let f = WriteFake::new();
    op_in_progress(&f, "rebase-merge");
    let e = wserver(&f);
    let (code, out) = post(&e, &body(r#","kind":"rebase","action":"abort""#)).await;
    assert_eq!(
        (code, out["error"].clone()),
        (400, json!(apierr::CODE_CONFIRM_REQUIRED)),
        "{out}"
    );
    assert!(f.wrote().is_empty(), "확인 없이 실행됐다: {:?}", f.wrote());
}

// OP2: 그 종류에 없는 동작과 모르는 조합은 실행 전에 400 이다. bisect 는 아는 종류지만(FR-GDT-18)
// 출구는 reset(=abort) 하나뿐이다.
#[tokio::test]
async fn api_git_operation_rejects_unknown_combo() {
    for b in [
        body(r#","kind":"merge","action":"skip""#),
        body(r#","kind":"bisect","action":"continue","confirm":true"#),
        body(r#","kind":"rebase","action":"start""#),
    ] {
        let f = WriteFake::new();
        op_in_progress(&f, "rebase-merge");
        let e = wserver(&f);
        let (code, out) = post(&e, &b).await;
        assert_eq!(code, 400, "{b}: {out}");
        assert!(
            f.wrote().is_empty(),
            "{b}: 거부해야 하는데 실행됐다: {:?}",
            f.wrote()
        );
    }
}

// OP3 (FR-GIT-252): 화면이 아는 작업과 저장소의 작업이 다르면 실행하지 않는다.
#[tokio::test]
async fn api_git_operation_mismatch_is_refused() {
    let abort = body(r#","kind":"rebase","action":"abort","confirm":true"#);
    let f = WriteFake::new();
    let e = wserver(&f);
    let (code, out) = post(&e, &abort).await;
    assert_eq!(
        (code, out["error"].clone()),
        (409, json!(apierr::CODE_NO_OPERATION)),
        "{out}"
    );
    assert!(f.wrote().is_empty(), "진행 중이 아닌데 실행됐다");

    let f2 = WriteFake::new();
    std::fs::write(std::path::Path::new(&f2.git_dir()).join("MERGE_HEAD"), "").unwrap();
    let e2 = wserver(&f2);
    let (code, out) = post(&e2, &abort).await;
    assert_eq!(
        (code, out["error"].clone()),
        (409, json!(apierr::CODE_OPERATION_MISMATCH)),
        "{out}"
    );
    assert!(f2.wrote().is_empty(), "어긋났는데 실행됐다");
}

// OP4: 맞는 조합은 그 종류의 argv 로 실행된다.
#[tokio::test]
async fn api_git_operation_runs_matching_action() {
    for (marker, b, want) in [
        (
            "rebase-merge",
            body(r#","kind":"rebase","action":"continue""#),
            "rebase --continue",
        ),
        (
            "rebase-merge",
            body(r#","kind":"rebase","action":"skip""#),
            "rebase --skip",
        ),
        (
            "rebase-merge",
            body(r#","kind":"rebase","action":"abort","confirm":true"#),
            "rebase --abort",
        ),
    ] {
        let f = WriteFake::new();
        op_in_progress(&f, marker);
        let e = wserver(&f);
        let (code, out) = req_await(&e.s, "POST", "/api/git/operation", &b).await;
        assert!(code == 200 && out["ok"] == true, "{b}: {code} {out}");
        let w = f.wrote();
        assert_eq!(w.len(), 1, "{b}: 쓰기 횟수: {w:?}");
        assert_eq!(format!("{} {}", w[0][0], w[0][1]), want, "{b}: {w:?}");
    }
}

// OP5: 라우트가 등록돼 있고 Git 이 없으면 503 이다.
#[tokio::test]
async fn api_git_operation_route_registered_and_unavailable() {
    assert!(
        crate::routes::ROUTES
            .iter()
            .any(|rt| rt.method == "POST" && rt.matcher.matches("/api/git/operation")),
        "/api/git/operation 이 routes 에 없다"
    );
    let s = Arc::new(GitServer {
        tools: Some(Arc::new(FakePaneHub::default())),
        work: Some(Arc::new(FakeWorkspace::default())),
        ..GitServer::default()
    });
    let r = req(
        &s,
        "POST",
        "/api/git/operation",
        &body(r#","kind":"rebase","action":"continue""#),
    )
    .await;
    assert_eq!(
        (r.code, r.json()["error"].clone()),
        (503, json!(apierr::CODE_UNAVAILABLE)),
        "{}",
        r.text()
    );
}
