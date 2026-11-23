//! Go `handlers_git_write_test.go`·`handlers_git_stage_sub_test.go`·`handlers_git_shutdown_test.go`
//! (stage 갈래)·`handlers_git_actions_commit_test.go` 중 5.4.2 범위의 이식.
//!
//! 옮기지 않은 것:
//! - `TestStageSubmoduleInnerOnly_RealGit`: 실제 git 서브모듈 픽스처(`submoduleTestServer`)가
//!   5.4.3 종단 /api/git/submodules* 의 하네스다.
//! - `TestCommitAnswerMatchesRejection` 의 답 종단 절반: 5.4.3 종단 /api/git/actions. 실행 종단
//!   (/api/git/commit) 쪽 거절만 옮긴다.
//! - `fakeJobRunner`·`gitJobDone`·`gitReqAwait`: 하네스(`wfake.rs`)로 옮겼다.
//!
//! Go 의 `writeErr` 안에서 바꾸던 상태는 `write_ctx` 에서 바꾼다 — `write_err` 는 fake 잠금 안에서 불린다.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, SystemTime};

use dm_webserver_action as action;
use dm_webserver_apierr as apierr;
use dm_webserver_domain_git_core::{self as core, Ctx, Output};
use dm_webserver_domain_git_query::{self as query, Block, FileEntry, Preflight, Status};
use dm_webserver_domain_git_store::{Store, StoreOptions};
use dm_webserver_domain_git_write as write;
use serde_json::{Value, json};

use super::harness::*;
use super::wfake::{
    WEnv, WriteFake, job_done, remote_hold, req_await, write_status, wserver, wserver_with,
};
use crate::GitServer;
use crate::answers::{commit_message_answer, commit_state_answer, stage_answer};

fn repo() -> String {
    abs(&["work", "repo"])
}

fn body(rest: &str) -> String {
    format!(r#"{{"repo":{}{rest}}}"#, q(&repo()))
}

fn stage_body() -> String {
    body(r#","paths":["a.txt"]"#)
}

fn changes_after_write(f: &WriteFake) {
    f.lock().on_write = Some(Arc::new(|st, _| st.status = write_status("b.txt", ".M")));
}

/// 커밋 하나를 만들어 undo 토큰을 발급받는다 (Go `gitIssueUndo`).
async fn issue_undo(e: &WEnv) -> String {
    let res = req(&e.s, "POST", "/api/git/commit", &body(r#","message":"m""#)).await;
    assert_eq!(res.code, 200, "commit: {}", res.text());
    let jb = job_done(&e.s, &res.json()).await;
    let tok = jb
        .result
        .as_ref()
        .map(|r| r.undo_token.clone())
        .unwrap_or_default();
    assert!(!tok.is_empty(), "undoToken 이 비었다: {jb:?}");
    e.f.reset_writes();
    tok
}

fn undo_body(tok: &str) -> String {
    body(&format!(r#","undoToken":{}"#, q(tok)))
}

async fn post(e: &WEnv, path: &str, b: &str) -> (u16, Value) {
    let r = req(&e.s, "POST", path, b).await;
    (r.code, r.json())
}

fn no_git_server() -> Arc<GitServer> {
    Arc::new(GitServer {
        tools: Some(Arc::new(FakePaneHub::default())),
        work: Some(Arc::new(FakeWorkspace::default())),
        commands: Some(Arc::new(FakeBroker::default())),
        ..GitServer::default()
    })
}

fn fail_out(stderr: &str) -> Output {
    Output {
        exit_code: 1,
        stderr: stderr.to_owned(),
        ..Output::default()
    }
}

// S15 (V30, FR-GIT-71): 쓰기 라우트의 응답에 실행 후 status 가 함께 온다. 경로는 축자 pathspec
// 이다 (DIFF-14, Go 와 다르다).
#[tokio::test]
async fn api_git_write_routes_return_fresh_status() {
    let cases: [(&str, String, Option<Vec<&str>>); 4] = [
        (
            "/api/git/stage",
            stage_body(),
            Some(vec!["add", "--", ":(literal)a.txt"]),
        ),
        (
            "/api/git/unstage",
            stage_body(),
            Some(vec!["reset", "-q", "HEAD", "--", ":(literal)a.txt"]),
        ),
        (
            "/api/git/discard",
            body(r#","tracked":["a.txt"],"untracked":["n.txt"],"confirm":true"#),
            Some(vec!["checkout", "-q", "--", ":(literal)a.txt"]),
        ),
        ("/api/git/undo-last", body(r#","undoToken":"""#), None),
    ];
    for (path, b, want) in cases {
        let f = WriteFake::new();
        changes_after_write(&f);
        let e = wserver(&f);
        let b = if path == "/api/git/undo-last" {
            undo_body(&issue_undo(&e).await)
        } else {
            b
        };
        let (code, out) = post(&e, path, &b).await;
        assert_eq!(code, 200, "{path}: {out}");
        assert_eq!(out["requested"], json!(repo()), "{path}: {out}");
        assert_eq!(out["repo"], json!(repo()), "{path}: {out}");
        assert_eq!(
            (out["ok"].clone(), out["partial"].clone()),
            (json!(true), json!(false)),
            "{path}: {out}"
        );
        assert!(out["status"].is_object(), "{path}: {out}");
        assert_eq!(
            out["status"]["changes"].as_array().map(Vec::len),
            Some(1),
            "{path}: 실행 후 status 가 아니다: {out}"
        );
        if let Some(want) = want {
            let got = f.wrote();
            assert!(!got.is_empty() && got[0] == want, "{path}: argv = {got:?}");
        }
    }
}

// REPO_FIX 01 §5.2·6.3: 커밋은 잡이다 — 쓰기 이후 status·oid·undoToken 은 잡의 result 에 온다.
#[tokio::test]
async fn api_git_commit_job_result_carries_fresh_status_and_undo() {
    let f = WriteFake::new();
    changes_after_write(&f);
    let e = wserver(&f);
    let (code, out) = post(&e, "/api/git/commit", &body(r#","message":"m""#)).await;
    assert!(
        code == 200 && !out["job"].is_null() && out["repo"] == json!(repo()),
        "{code} {out}"
    );
    let jb = job_done(&e.s, &out).await;
    assert_eq!((jb.kind.as_str(), jb.exit_code), ("commit", 0), "{jb:?}");
    let r = jb.result.as_ref().expect("result");
    let st = r.status.as_ref().expect("status");
    assert!(
        st.changes.len() == 1 && !r.undo_token.is_empty() && !r.oid.is_empty(),
        "{r:?}"
    );
    assert_eq!(
        f.wrote(),
        vec![vec!["commit", "--file=-", "--cleanup=strip"]]
    );
}

// 실패한 커밋에는 undo 토큰이 없다.
#[tokio::test]
async fn api_git_commit_failed_job_has_no_undo() {
    let f = WriteFake::new();
    f.lock().write_err = Some(Arc::new(|_| Ok(fail_out("hook failed"))));
    let e = wserver(&f);
    let (_, out) = post(&e, "/api/git/commit", &body(r#","message":"m""#)).await;
    let jb = job_done(&e.s, &out).await;
    let r = jb.result.as_ref();
    assert!(
        !jb.err.is_empty() && r.is_some_and(|r| r.undo_token.is_empty() && r.status.is_some()),
        "{jb:?}"
    );
}

// 커밋 잡이 도는 동안 같은 저장소의 동기 쓰기는 409 job_busy (§5.4).
#[tokio::test]
async fn api_git_commit_job_blocks_sync_write() {
    let f = WriteFake::new();
    let release = Arc::new(tokio::sync::Semaphore::new(0));
    let rel = release.clone();
    let e = wserver_with(&f, move |s| s.job_runner = Some(remote_hold(rel)));
    let (_, out) = post(&e, "/api/git/commit", &body(r#","message":"m""#)).await;
    assert!(!out["job"].is_null(), "잡이 아니다: {out}");
    let (code, out) = post(&e, "/api/git/stage", &stage_body()).await;
    release.add_permits(1);
    assert_eq!(
        (code, out["error"].clone()),
        (409, json!("job_busy")),
        "{out}"
    );
}

// S11 (V35, FR-GIT-83): 발급된 토큰은 5초 뒤 만료된다.
#[tokio::test]
async fn api_git_undo_last_expires() {
    let f = WriteFake::new();
    let e = wserver(&f);
    let tok = issue_undo(&e).await;
    e.advance_undo(write::UNDO_TTL + Duration::from_millis(1));
    let (code, out) = post(&e, "/api/git/undo-last", &undo_body(&tok)).await;
    assert_eq!(
        (code, out["error"].clone()),
        (409, json!("undo_expired")),
        "{out}"
    );
    assert!(f.wrote().is_empty(), "만료된 undo 가 실행됐다");
}

// S12 (V35, FR-GIT-83): 새 커밋이 이전 토큰을 밀어낸다.
#[tokio::test]
async fn api_git_undo_last_new_commit_invalidates() {
    let f = WriteFake::new();
    let e = wserver(&f);
    let first = issue_undo(&e).await;
    let second = issue_undo(&e).await;
    assert_ne!(first, second, "두 커밋이 같은 토큰을 받았다");
    let (code, out) = post(&e, "/api/git/undo-last", &undo_body(&first)).await;
    assert_eq!(
        (code, out["error"].clone()),
        (409, json!("undo_expired")),
        "{out}"
    );
    let (code, out) = post(&e, "/api/git/undo-last", &undo_body(&second)).await;
    assert_eq!(code, 200, "{out}");
}

// S13 (V35): 소비된 토큰은 재사용할 수 없다.
#[tokio::test]
async fn api_git_undo_last_consumed_once() {
    let f = WriteFake::new();
    let e = wserver(&f);
    let b = undo_body(&issue_undo(&e).await);
    let (code, out) = post(&e, "/api/git/undo-last", &b).await;
    assert_eq!(code, 200, "첫 undo: {out}");
    // FR-GIT-82
    let msg = f.lock().message.clone();
    assert_eq!(out["message"], json!(msg));
    assert_eq!(f.wrote(), vec![vec!["reset", "--soft", "HEAD@{1}"]]);
    let (code, out) = post(&e, "/api/git/undo-last", &b).await;
    assert_eq!(
        (code, out["error"].clone()),
        (409, json!("undo_expired")),
        "재사용: {out}"
    );
    assert_eq!(f.wrote().len(), 1, "undo 가 두 번 실행됐다");
}

// TC-ATF-2 (FR-ATF-2, AT-GAPI-2): 발급 뒤 HEAD 가 옮겨지면 409 stale_observation 이고 토큰은 남는다.
#[tokio::test]
async fn api_git_undo_last_head_moved_is_stale() {
    let f = WriteFake::new();
    let e = wserver(&f);
    let b = undo_body(&issue_undo(&e).await);
    let issued = std::mem::replace(&mut f.lock().head_oid, "b".repeat(40));
    let (code, out) = post(&e, "/api/git/undo-last", &b).await;
    assert_eq!(
        (code, out["error"].clone()),
        (409, json!("stale_observation")),
        "{out}"
    );
    assert!(f.wrote().is_empty(), "다른 커밋을 되돌렸다");
    f.lock().head_oid = issued;
    let (code, out) = post(&e, "/api/git/undo-last", &b).await;
    assert_eq!(code, 200, "토큰이 소모됐다: {out}");
}

// FR-ATF-2 (AT-GAPI-3): 메시지 읽기가 실패하면 토큰을 소모하지 않는다.
#[tokio::test]
async fn api_git_undo_last_read_failure_keeps_token() {
    let f = WriteFake::new();
    let e = wserver(&f);
    let b = undo_body(&issue_undo(&e).await);
    f.lock().log_err = Some(core::Error::other("log 실패"));
    let (code, out) = post(&e, "/api/git/undo-last", &b).await;
    assert_ne!(code, 200, "읽기 실패가 성공으로 답했다: {out}");
    f.lock().log_err = None;
    let (code, out) = post(&e, "/api/git/undo-last", &b).await;
    assert_eq!(code, 200, "재시도: {out}");
}

// S14 (V36, FR-GIT-86·88): preflight 가 막으면 409 이고 커밋이 만들어지지 않는다.
#[tokio::test]
async fn api_git_commit_preflight_blocked() {
    let f = WriteFake::new();
    f.lock().identity = false;
    let e = wserver(&f);
    let (code, out) = post(&e, "/api/git/commit", &body(r#","message":"m""#)).await;
    assert_eq!(
        (code, out["error"].clone()),
        (409, json!("preflight_blocked")),
        "{out}"
    );
    assert!(f.wrote().is_empty(), "차단됐는데 커밋이 실행됐다");
    let blocks = out["preflight"]["blocks"]
        .as_array()
        .expect("preflight.blocks");
    assert_eq!(blocks.len(), 1, "{out}");
    let b = &blocks[0];
    assert!(
        b["code"] == "identity_missing" && b["reason"] != "" && b["fix"] != "",
        "{b}"
    );
}

// S16 (V37, FR-GIT-89): `/discard` 는 confirm 없이는 400 이다.
#[tokio::test]
async fn api_git_discard_requires_confirm() {
    let f = WriteFake::new();
    let e = wserver(&f);
    let (code, out) = post(&e, "/api/git/discard", &body(r#","tracked":["a.txt"]"#)).await;
    assert_eq!(
        (code, out["error"].clone()),
        (400, json!("confirmation_required")),
        "{out}"
    );
    assert!(f.wrote().is_empty(), "확인 없이 실행됐다");
    let hints = e.s.git.as_ref().unwrap().service().hints(0);
    assert!(
        hints.is_empty(),
        "실행하지 않았는데 hint 가 남았다: {hints:?}"
    );
}

// S16 (V37, FR-GIT-92): confirm 이 있으면 실행하고, recovery hint 가 남는다.
#[tokio::test]
async fn api_git_discard_leaves_hint() {
    let f = WriteFake::new();
    let e = wserver(&f);
    let (code, out) = post(
        &e,
        "/api/git/discard",
        &body(r#","tracked":["a.txt"],"untracked":["n.txt"],"confirm":true"#),
    )
    .await;
    assert_eq!(code, 200, "{out}");
    let hints = e.s.git.as_ref().unwrap().service().hints(0);
    assert!(
        hints.len() == 1 && hints[0].action == "discard",
        "{hints:?}"
    );
    assert_eq!(
        hints[0].targets,
        Some(vec!["a.txt".to_owned(), "n.txt".to_owned()])
    );
}

// S17 (FR-GIT-84): 빈 메시지와 staged 없음은 400 이며 사유가 코드로 구분된다.
#[tokio::test]
async fn api_git_commit_rejects_empty_message_and_nothing_staged() {
    let cases = [
        ("빈 메시지", body(r#","message":"""#), true, "empty_message"),
        (
            "공백뿐인 메시지",
            body(r#","message":"  \n ""#),
            true,
            "empty_message",
        ),
        (
            "staged 없음",
            body(r#","message":"m""#),
            false,
            "nothing_staged",
        ),
    ];
    for (name, b, staged, want) in cases {
        let f = WriteFake::new();
        if !staged {
            f.lock().status = write_status("a.txt", ".M");
        }
        let e = wserver(&f);
        let (code, out) = post(&e, "/api/git/commit", &b).await;
        assert_eq!(
            (code, out["error"].clone()),
            (400, json!(want)),
            "{name}: {out}"
        );
        assert!(f.wrote().is_empty(), "{name}: 거부됐는데 실행됐다");
    }
}

// S17 (FR-GIT-84): `all:true` 는 staged 가 없어도 통과한다.
#[tokio::test]
async fn api_git_commit_all_without_staged() {
    let f = WriteFake::new();
    f.lock().status = write_status("a.txt", ".M");
    let e = wserver(&f);
    let (code, out) = req_await(
        &e.s,
        "POST",
        "/api/git/commit",
        &body(r#","message":"m","all":true"#),
    )
    .await;
    assert_eq!(code, 200, "{out}");
    assert_eq!(
        f.wrote(),
        vec![vec!["commit", "--file=-", "--cleanup=strip", "-a"]]
    );
}

// S6 의 서버측 절반 (FR-GIT-77): 메시지는 stdin 으로만 간다.
#[tokio::test]
async fn api_git_commit_message_stays_in_stdin() {
    let f = WriteFake::new();
    let e = wserver(&f);
    let (code, out) = req_await(
        &e.s,
        "POST",
        "/api/git/commit",
        &body(r#","message":"제목\n\n본문 줄","signoff":true,"noVerify":true"#),
    )
    .await;
    assert_eq!(code, 200, "{out}");
    let st = f.lock();
    assert_eq!(st.stdins, vec!["제목\n\n본문 줄"]);
    for a in &st.writes[0] {
        assert!(
            !a.contains("제목") && !a.contains("본문"),
            "argv 에 메시지가 실렸다: {:?}",
            st.writes[0]
        );
    }
    assert_eq!(
        st.writes[0],
        vec![
            "commit",
            "--file=-",
            "--cleanup=strip",
            "--signoff",
            "--no-verify"
        ]
    );
}

// S4 의 서버측 절반 (FR-GIT-73, §7.1 I2): 실패는 `partial` 과 무엇이 바뀌었는지로 보고된다.
#[tokio::test]
async fn api_git_stage_reports_partial() {
    let f = WriteFake::new();
    f.lock().status = write_status("a.txt", ".M");
    // 실행은 됐고 실패했다 — 앞쪽 경로는 이미 적용됐다.
    let g = f.clone();
    f.lock().write_ctx = Some(Arc::new(move |_| {
        g.lock().status = write_status("a.txt", "M.") + &write_status("b.txt", ".M");
    }));
    f.lock().write_err = Some(Arc::new(|_| {
        Ok(fail_out("error: pathspec 'b.txt' did not match"))
    }));
    let e = wserver(&f);
    let (code, out) = post(&e, "/api/git/stage", &body(r#","paths":["a.txt","b.txt"]"#)).await;
    assert_eq!(
        (code, out["error"].clone()),
        (500, json!("git_failed")),
        "{out}"
    );
    assert_eq!(out["partial"], true, "{out}");
    assert!(
        out["changed"].as_array().is_some_and(|c| !c.is_empty()),
        "무엇이 바뀌었는지가 없다: {out}"
    );
}

// FR-GIT-62: 절대경로·부모 참조는 400 이며 실행되지 않는다.
#[tokio::test]
async fn api_git_stage_rejects_unsafe_paths() {
    for b in [
        body(r#","paths":[]"#),
        body(r#","paths":["/etc/passwd"]"#),
        body(r#","paths":["../outside"]"#),
        r#"{"repo":"relative","paths":["a.txt"]}"#.to_owned(),
        r#"{"paths":["a.txt"]}"#.to_owned(),
    ] {
        let f = WriteFake::new();
        let e = wserver(&f);
        let (code, out) = post(&e, "/api/git/stage", &b).await;
        assert_eq!(
            (code, out["error"].clone()),
            (400, json!("bad_request")),
            "{b}: {out}"
        );
        assert!(f.wrote().is_empty(), "{b} 가 실행됐다");
    }
}

// FR-GIT-60: git 표면이 구성되지 않았으면 503 이다.
#[tokio::test]
async fn api_git_write_unavailable() {
    let s = no_git_server();
    for path in [
        "/api/git/stage",
        "/api/git/unstage",
        "/api/git/discard",
        "/api/git/commit",
        "/api/git/undo-last",
    ] {
        let r = req(&s, "POST", path, &body("")).await;
        assert_eq!(
            (r.code, r.json()["error"].clone()),
            (503, json!("git_unavailable")),
            "{path}: {}",
            r.text()
        );
    }
}

// 쓰기 라우트는 POST 만 받는다.
#[tokio::test]
async fn api_git_write_post_only() {
    let f = WriteFake::new();
    let e = wserver(&f);
    for path in [
        "/api/git/stage",
        "/api/git/unstage",
        "/api/git/discard",
        "/api/git/undo-last",
    ] {
        let r = req(&e.s, "GET", path, "").await;
        assert_ne!(r.code, 200, "GET {path} 가 200 이다");
    }
    assert!(f.wrote().is_empty(), "GET 이 쓰기를 실행했다");
}

// REPO_FIX 01 §7.4: 하나라도 실패하면 409 resolve_partial 이고 경로별 결과를 싣는다.
#[tokio::test]
async fn api_git_resolve_partial_carries_per_path_results() {
    let f = WriteFake::new();
    f.lock().write_err = Some(Arc::new(|argv| {
        if argv[0] == "checkout" && argv.last().map(String::as_str) == Some(":(literal)b.txt") {
            return Ok(fail_out("error: 실패"));
        }
        Ok(Output::default())
    }));
    let e = wserver(&f);
    let (code, out) = post(
        &e,
        "/api/git/resolve",
        &body(r#","side":"ours","paths":["a.txt","b.txt"],"confirm":true"#),
    )
    .await;
    assert_eq!(
        (code, out["error"].clone()),
        (409, json!("resolve_partial")),
        "{out}"
    );
    let results = out["results"].as_array().expect("results");
    assert_eq!(results.len(), 2, "{out}");
    let (a, b) = (&results[0], &results[1]);
    assert!(
        a["ok"] == true && b["ok"] == false && b["error"] != "",
        "경로별 결과 = {results:?}"
    );
    assert!(
        out["partial"] == true && !out["status"].is_null(),
        "partial·status 가 없다: {out}"
    );
}

// §7.4: 전부 성공하면 200 에 경로별 결과와 status 를 싣는다.
#[tokio::test]
async fn api_git_resolve_all_ok() {
    let f = WriteFake::new();
    let e = wserver(&f);
    let (code, out) = post(
        &e,
        "/api/git/resolve",
        &body(r#","side":"theirs","paths":["a.txt"],"confirm":true"#),
    )
    .await;
    assert!(code == 200 && out["ok"] == true, "{code} {out}");
    assert_eq!(out["results"].as_array().map(Vec::len), Some(1), "{out}");
}

// TC-ATF-74 (AT-GAPI-4): 쓰기는 적용됐고 재조회만 실패하면 200 + statusStale:true 다.
#[tokio::test]
async fn api_git_write_status_reread_fail_is_stale_ok() {
    for (path, b) in [
        ("/api/git/stage", stage_body()),
        (
            "/api/git/resolve",
            body(r#","side":"theirs","paths":["a.txt"],"confirm":true"#),
        ),
    ] {
        let f = WriteFake::new();
        f.lock().on_write = Some(Arc::new(|st, _| {
            st.status_err = Some(core::Error::other("status 재조회 실패"));
        }));
        let e = wserver(&f);
        let (code, out) = post(&e, path, &b).await;
        assert!(
            code == 200 && out["ok"] == true && out["statusStale"] == true,
            "{path}: {code} {out}"
        );
        assert!(
            out.get("status").is_none(),
            "{path}: 낡은 응답에 status 가 실렸다: {out}"
        );
        assert!(
            out["requested"] == json!(repo()) && out["repo"] == json!(repo()),
            "{path}: {out}"
        );
        assert!(!f.wrote().is_empty(), "{path}: 쓰기가 실행되지 않았다");
    }
}

// 재조회가 성공하면 statusStale 을 싣지 않는다.
#[tokio::test]
async fn api_git_write_fresh_status_has_no_stale_flag() {
    let f = WriteFake::new();
    let e = wserver(&f);
    let (code, out) = post(&e, "/api/git/stage", &stage_body()).await;
    assert!(code == 200 && !out["status"].is_null(), "{code} {out}");
    assert!(out.get("statusStale").is_none(), "{out}");
}

// 쓰기가 실패하고 재조회도 실패하면 여전히 오류다.
#[tokio::test]
async fn api_git_write_run_fail_with_status_fail_stays_error() {
    let f = WriteFake::new();
    let g = f.clone();
    f.lock().write_ctx = Some(Arc::new(move |_| {
        g.lock().status_err = Some(core::Error::other("status 재조회 실패"));
    }));
    f.lock().write_err = Some(Arc::new(|_| Ok(fail_out("fatal: 실패"))));
    let e = wserver(&f);
    let (code, out) = post(&e, "/api/git/stage", &stage_body()).await;
    assert!(
        code != 200 && out.get("statusStale").is_none_or(Value::is_null),
        "{code} {out}"
    );
}

// REPO_FIX 01 §7.7 (FR-GIT-84 개정): amend 면 staged 가 없어도 메시지만 고칠 수 있다.
#[tokio::test]
async fn api_git_commit_amend_message_only() {
    let f = WriteFake::new();
    f.lock().status = write_status("a.txt", ".M");
    let e = wserver(&f);
    let (code, out) = req_await(
        &e.s,
        "POST",
        "/api/git/commit",
        &body(r#","message":"고친 제목","amend":true"#),
    )
    .await;
    assert_eq!(code, 200, "{out}");
    let got = f.wrote();
    assert!(
        got.len() == 1 && got[0].iter().any(|a| a == "--amend"),
        "{got:?}"
    );
}

// §7.7: amend 인데 메시지가 직전과 같고 staged 도 없으면 실행하지 않는다.
#[tokio::test]
async fn api_git_commit_amend_same_message_rejected() {
    let f = WriteFake::new();
    f.lock().status = write_status("a.txt", ".M");
    let e = wserver(&f);
    let (code, out) = post(
        &e,
        "/api/git/commit",
        &body(r#","message":"직전 커밋 제목  \n\n본문\n","amend":true"#),
    )
    .await;
    assert_eq!(
        (code, out["error"].clone()),
        (400, json!("nothing_staged")),
        "{out}"
    );
    assert!(f.wrote().is_empty(), "바뀔 것이 없는데 실행했다");
}

// §7.7: signoff 가 켜져 있고 직전 메시지에 Signed-off-by 가 없으면 바뀔 것이 있다.
#[tokio::test]
async fn api_git_commit_amend_same_message_with_new_signoff() {
    let f = WriteFake::new();
    f.lock().status = write_status("a.txt", ".M");
    let e = wserver(&f);
    let (code, out) = req_await(
        &e.s,
        "POST",
        "/api/git/commit",
        &body(r#","message":"직전 커밋 제목\n\n본문","amend":true,"signoff":true"#),
    )
    .await;
    assert_eq!(code, 200, "{out}");
}

// ── handlers_git_stage_sub_test.go — REFACTOR3_FE_REST1_SRS FU-17

fn clean_status() -> String {
    format!("# branch.oid {}\0# branch.head main\0", "a".repeat(40))
}

/// 안쪽만 바뀐 서브모듈 `sub`(상태 B)·커밋 몫이 있는 `subc`(상태 C)·파일 `x.txt` (Go `gitSubStatus`).
fn sub_status() -> String {
    let oid = "b".repeat(40);
    format!(
        "{}1 .M S..U 160000 160000 160000 {oid} {oid} sub\0\
         1 .M SC.U 160000 160000 160000 {oid} {oid} subc\0\
         1 .M N... 100644 100644 100644 {oid} {oid} x.txt\0",
        clean_status()
    )
}

// TC-FR1-4: 요청 경로가 모두 상태 B 일 때만 거절한다 (D-FR1-3).
#[test]
fn stage_answer_table() {
    let st = query::parse_status_v2(&sub_status()).unwrap();
    let cases: [(&str, &[&str], bool); 7] = [
        ("경로 없음", &[], false),
        ("상태 B 하나", &["sub"], true),
        ("상태 B · 끝 슬래시", &["sub/"], true),
        ("상태 B + 파일", &["sub", "x.txt"], false),
        ("상태 C", &["subc"], false),
        ("파일", &["x.txt"], false),
        ("status 에 없는 경로", &["nope"], false),
    ];
    for (name, paths, deny) in cases {
        let a = stage_answer(&st, paths);
        assert_ne!(a.ok, deny, "{name}: {a:?}");
        if !deny {
            continue;
        }
        assert_eq!(
            (a.why.as_str(), a.status),
            (apierr::CODE_SUBMODULE_INNER_ONLY, 409),
            "{name}: {a:?}"
        );
        assert!(
            action::may_give(&action::catalog(), action::GIT_STAGE, &a.why),
            "{name}: 동작 목록에 {} 가 없다",
            a.why
        );
    }
}

async fn status_out(s: &Arc<GitServer>) -> Value {
    let r = req(
        s,
        "GET",
        &format!("/api/git/status?repo={}", qe(&repo())),
        "",
    )
    .await;
    assert_eq!(r.code, 200, "status: {}", r.text());
    let out = r.json();
    assert!(
        out["actions"].is_object(),
        "status 응답에 actions 가 없다: {out}"
    );
    out
}

// TC-FR1-5 (FR-FR1-8): status 응답의 rowActions 는 서브모듈 행마다 git.stage 답을 싣는다.
#[tokio::test]
async fn status_row_actions_submodule() {
    let f = WriteFake::new();
    f.lock().status = sub_status();
    let e = wserver(&f);
    let out = status_out(&e.s).await;
    let rows = out["rowActions"].as_object().expect("rowActions");
    let ans = |p: &str| rows.get(p).map(|r| r[action::GIT_STAGE].clone());
    let sub = ans("sub").unwrap_or_default();
    assert!(
        sub["ok"] == false && sub["why"] == apierr::CODE_SUBMODULE_INNER_ONLY,
        "sub = {sub}"
    );
    assert_eq!(
        ans("subc").unwrap_or_default()["ok"],
        true,
        "subc: {rows:?}"
    );
    assert!(
        !rows.contains_key("x.txt"),
        "서브모듈이 아닌 행은 싣지 않는다: {rows:?}"
    );
}

// TC-FR1-5 (FR-FR1-7): 답이 거짓이면 실행이 같은 코드로 거절되고, 섞인 요청은 실행된다.
#[tokio::test]
async fn stage_rejects_submodule_inner_only() {
    let f = WriteFake::new();
    f.lock().status = sub_status();
    let e = wserver(&f);
    let (code, out) = post(&e, "/api/git/stage", &body(r#","paths":["sub"]"#)).await;
    assert_eq!(
        (code, out["error"].clone()),
        (409, json!(apierr::CODE_SUBMODULE_INNER_ONLY)),
        "{out}"
    );
    assert!(
        out.get("message").is_none(),
        "서버가 문구를 실었다 (D-SDA-5): {out}"
    );
    assert!(f.wrote().is_empty(), "실행됐다: {:?}", f.wrote());
    let (code, out) = post(&e, "/api/git/stage", &body(r#","paths":["sub","x.txt"]"#)).await;
    assert_eq!(code, 200, "섞인 요청: {out}");
    let w = f.wrote();
    assert!(
        w.last().is_some_and(|a| a[0] == "add"),
        "add 가 실행되지 않았다: {w:?}"
    );
}

// ── handlers_git_shutdown_test.go 의 stage 갈래 — REPO_FIX 01 §8

fn shutdown_server(f: &WriteFake) -> (WEnv, Ctx) {
    let root = Ctx::background();
    let at = SystemTime::now();
    let store = Store::new(
        Arc::new(f.service()),
        StoreOptions::default()
            .clock(Arc::new(move || at))
            .root(root.clone()),
    );
    (wserver_with(f, move |s| s.git = Some(store)), root)
}

// 쓰기 도중 루트가 취소되면 재조회하지 않고 503 server_shutdown.
#[tokio::test]
async fn shutdown_sync_write_cut_is_503() {
    let f = WriteFake::new();
    let (e, root) = shutdown_server(&f);
    f.lock().write_ctx = Some(Arc::new(move |_| root.cancel()));
    let calls = Arc::new(AtomicUsize::new(0));
    let c = calls.clone();
    f.lock().on_status = Some(Arc::new(move || {
        c.fetch_add(1, Ordering::SeqCst);
    }));
    let (code, out) = post(&e, "/api/git/stage", &stage_body()).await;
    assert_eq!(
        (code, out["error"].clone()),
        (503, json!(apierr::CODE_SERVER_SHUTDOWN)),
        "{out}"
    );
    assert!(
        out.get("partial").is_none(),
        "종료 응답에 partial 이 실렸다: {out}"
    );
    assert_eq!(
        calls.load(Ordering::SeqCst),
        1,
        "종료 뒤 재조회 없음이어야 한다"
    );
}

// 루트가 이미 끝났으면 쓰기를 시작하지 않는다.
#[tokio::test]
async fn shutdown_sync_write_after_shutdown_not_run() {
    let f = WriteFake::new();
    let (e, root) = shutdown_server(&f);
    f.lock().on_status = Some(Arc::new(move || root.cancel()));
    let (code, out) = post(&e, "/api/git/stage", &stage_body()).await;
    assert_eq!(
        (code, out["error"].clone()),
        (503, json!(apierr::CODE_SERVER_SHUTDOWN)),
        "{out}"
    );
    let adds = f.wrote().iter().filter(|a| a[0] == "add").count();
    assert_eq!(adds, 0, "종료 뒤 쓰기가 실행됐다");
}

// ── handlers_git_actions_commit_test.go

// TC-SDA-1 (GR-3b): 커밋 판정의 표 시험.
#[tokio::test]
async fn commit_answers() {
    let staged = Status {
        staged: vec![FileEntry {
            path: "a".to_owned(),
            ..FileEntry::default()
        }],
        ..Status::default()
    };
    let blocked = Preflight {
        blocks: vec![Block {
            code: "merge".to_owned(),
            reason: "r".to_owned(),
            fix: "f".to_owned(),
        }],
        ..Preflight::default()
    };
    let none = Status::default();
    let pf = Preflight::default();
    let same = || async { true };
    let diff = || async { false };
    let cases = [
        (
            "빈 메시지",
            commit_message_answer("  \n"),
            apierr::CODE_EMPTY_MESSAGE,
            400,
        ),
        ("메시지 있음", commit_message_answer("m"), "", 0),
        (
            "preflight 막힘",
            commit_state_answer(&staged, &blocked, false, false, diff).await,
            apierr::CODE_PREFLIGHT_BLOCKED,
            409,
        ),
        (
            "staged 없음",
            commit_state_answer(&none, &pf, false, false, diff).await,
            apierr::CODE_NOTHING_STAGED,
            400,
        ),
        (
            "staged 없음 · all",
            commit_state_answer(&none, &pf, true, false, diff).await,
            "",
            0,
        ),
        (
            "amend · 메시지 바뀜",
            commit_state_answer(&none, &pf, false, true, diff).await,
            "",
            0,
        ),
        (
            "amend · 메시지 같음",
            commit_state_answer(&none, &pf, false, true, same).await,
            apierr::CODE_NOTHING_STAGED,
            400,
        ),
        (
            "staged 있음",
            commit_state_answer(&staged, &pf, false, false, diff).await,
            "",
            0,
        ),
    ];
    for (name, got, why, status) in cases {
        assert!(
            got.ok == why.is_empty() && got.why == why && got.status == status,
            "{name}: answer = {got:?}, want why={why:?} status={status}"
        );
        if !got.ok {
            assert!(
                action::may_give(&action::catalog(), action::GIT_COMMIT, &got.why),
                "{name}: 사유 {:?} 가 동작 목록에 없다",
                got.why
            );
        }
    }
    let a = commit_state_answer(&staged, &blocked, false, false, diff).await;
    assert!(
        a.args.as_ref().is_some_and(|m| m.contains_key("blocks")),
        "preflight 거절에 막은 항목(args.blocks)이 없다"
    );
}

// TC-SDA-1 (D-SDA-6 · FR-SDA-23): 답이 거짓이면 실행이 같은 코드로 거절된다 — 실행 종단 쪽.
#[tokio::test]
async fn commit_answer_matches_rejection() {
    let cases = [
        (
            "빈 메시지",
            write_status("a.txt", "M."),
            body(r#","message":" ""#),
            apierr::CODE_EMPTY_MESSAGE,
        ),
        (
            "staged 없음",
            write_status("a.txt", ".M"),
            body(r#","message":"m""#),
            apierr::CODE_NOTHING_STAGED,
        ),
        (
            "staged 있음",
            write_status("a.txt", "M."),
            body(r#","message":"m""#),
            "",
        ),
        (
            "all",
            write_status("a.txt", ".M"),
            body(r#","message":"m","all":true"#),
            "",
        ),
    ];
    for (name, status, b, why) in cases {
        let f = WriteFake::new();
        f.lock().status = status;
        let e = wserver(&f);
        let (code, out) = post(&e, "/api/git/commit", &b).await;
        if why.is_empty() {
            assert_eq!(code, 200, "{name}: 답은 참인데 실행이 거절됐다: {out}");
            job_done(&e.s, &out).await;
            continue;
        }
        assert_eq!(out["error"], json!(why), "{name}: {code} {out}");
        assert!(
            out.get("message").is_none(),
            "{name}: 서버가 문구를 실었다 (D-SDA-5): {out}"
        );
    }
}

// GR-3a: 커밋 답은 입력이 바꾸므로 1층에 싣지 않는다.
#[tokio::test]
async fn status_actions_no_commit() {
    let f = WriteFake::new();
    let e = wserver(&f);
    let out = status_out(&e.s).await;
    assert!(
        out["actions"].get(action::GIT_COMMIT).is_none(),
        "1층에 git.commit 이 있다: {}",
        out["actions"][action::GIT_COMMIT]
    );
}
