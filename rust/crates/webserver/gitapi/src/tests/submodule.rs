//! Go `handlers_git_submodule_test.go` 의 이식 (DRIFT_RECLAIM_SRS FR-DRC-6). 그리고
//! `handlers_git_worktree_excl_test.go` 의 submodule sync 두 건과 `handlers_git_stage_sub_test.go` 의
//! `TestStageSubmoduleInnerOnly_RealGit` 을 함께 둔다. 실제 git 을 쓰는 것은 임시 저장소에서 돌고, git 이
//! 없으면 건너뛴다.
//!
//! 옮기지 않은 것:
//! - `handlers_git_stage_sub_test.go` 의 TestStageAnswer·TestStatusRowActions_Submodule·
//!   TestStageRejectsSubmoduleInnerOnly: 5.4.2 가 옮겼다(이 파일의 범위는 RealGit 한 건이다).

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

use otter_webserver_action as action;
use otter_webserver_apierr as apierr;
use otter_webserver_domain_git_core::{self as core, Ctx, Service};
use otter_webserver_domain_git_store::{Store, StoreOptions};
use otter_webserver_domain_submodule::{self as submodule, Failure, Manager};
use serde_json::Value;

use super::harness::{abs, q, qe, req};
use super::wfake::{WriteFake, job_id, remote_emit, remote_hold, wait_done, wserver_with};
use crate::GitServer;

/// Go `submoduleTestServer`: 실제 git 을 쓰는 GitServer. `edit` 는 Arc 로 감싸기 전에 서버를 고친다.
struct Sub {
    s: Arc<GitServer>,
    repo: String,
    _repo: otter_shared_gittest::Repo,
}

fn sub_server(edit: impl FnOnce(&mut GitServer)) -> Option<Sub> {
    let repo = otter_shared_gittest::repo()?;
    let mut s = GitServer {
        git: Some(Store::new(
            Arc::new(Service::new()),
            StoreOptions::default(),
        )),
        submodules: Some(Arc::new(Manager::new(submodule::runner_for(None)))),
        ..GitServer::default()
    };
    edit(&mut s);
    Some(Sub {
        s: Arc::new(s),
        repo: repo.path().to_string_lossy().into_owned(),
        _repo: repo,
    })
}

async fn sreq(s: &Arc<GitServer>, method: &str, target: &str, body: &str) -> (u16, Value) {
    let r = req(s, method, target, body).await;
    (r.code, r.json())
}

/// Go `wantNoOK`.
fn want_no_ok(out: &Value) {
    assert!(
        out.get("ok").is_none(),
        "실패 응답에 ok 가 있으면 안 된다: {out}"
    );
}

fn list_target(repo: &str) -> String {
    format!("/api/git/submodules?repo={}", qe(repo))
}

const WRITES: [&str; 2] = ["/api/git/submodules/update", "/api/git/submodules/sync"];

/// `inner` 를 repo 의 `at` 에 서브모듈로 붙이고 커밋한다.
fn add_submodule(repo: &str, inner: &str, at: &str) {
    let dir = std::path::Path::new(repo);
    otter_shared_gittest::run(
        dir,
        &[
            "-c",
            "protocol.file.allow=always",
            "submodule",
            "add",
            inner,
            at,
        ],
    );
    otter_shared_gittest::run(dir, &["commit", "-m", "add submodule"]);
}

// 라우팅 등록 + Submodules 가 없으면 503.
#[tokio::test]
async fn submodule_routes_registered_and_unavailable() {
    let s = Arc::new(GitServer::default());
    for (method, path, body) in [
        ("GET", list_target(&abs(&["x"])), ""),
        ("POST", WRITES[0].to_owned(), "{}"),
        ("POST", WRITES[1].to_owned(), "{}"),
    ] {
        let (code, out) = sreq(&s, method, &path, body).await;
        assert_eq!(code, 503, "{method} {path}: {out}");
        assert_eq!(out["error"], apierr::CODE_UNAVAILABLE, "{method} {path}");
        want_no_ok(&out);
    }
}

// 서브모듈이 없는 저장소는 빈 목록이며 오류가 아니다 (FR-SUB-10).
#[tokio::test]
async fn submodules_empty_repo_is_empty_list() {
    let Some(w) = sub_server(|_| {}) else { return };
    let (code, out) = sreq(&w.s, "GET", &list_target(&w.repo), "").await;
    assert_eq!(code, 200, "{out}");
    assert_eq!(out["repo"], w.repo.as_str());
    assert_eq!(out["requested"], w.repo.as_str());
    let list = out["submodules"].as_array();
    assert!(list.is_some_and(Vec::is_empty), "빈 배열이어야 한다: {out}");
}

// 목록은 `git submodule status` 가 진실이다 — 등록된 것이 보이고 absPath 는 서버가 계산한다.
#[tokio::test]
async fn submodules_lists_registered_entry_with_abs_path() {
    let Some(w) = sub_server(|_| {}) else { return };
    let Some(inner) = otter_shared_gittest::repo() else {
        return;
    };
    add_submodule(&w.repo, inner.path().to_str().unwrap(), "vendor/inner");
    let (code, out) = sreq(&w.s, "GET", &list_target(&w.repo), "").await;
    assert_eq!(code, 200, "{out}");
    let list = out["submodules"].as_array().cloned().unwrap_or_default();
    assert_eq!(list.len(), 1, "한 줄이어야 한다: {out}");
    let e = &list[0];
    assert_eq!(e["path"], "vendor/inner");
    let want = std::path::Path::new(&w.repo).join("vendor").join("inner");
    assert_eq!(e["absPath"], want.to_str().unwrap());
    assert_eq!(e["oid"].as_str().map(str::len), Some(40), "oid: {e}");
}

// 저장소가 아닌 자리는 실패다.
#[tokio::test]
async fn submodules_not_a_repo() {
    let Some(w) = sub_server(|_| {}) else { return };
    let tmp = otter_shared_gittest::TempDir::new("otter-gitapi-sub-plain-");
    let plain = std::fs::canonicalize(tmp.path()).unwrap();
    let (code, out) = sreq(&w.s, "GET", &list_target(plain.to_str().unwrap()), "").await;
    assert_ne!(code, 200, "저장소가 아니면 실패해야 한다: {out}");
    want_no_ok(&out);
}

// 쓰기 둘 다 confirm 을 요구한다 (FR-SUB-4·5) — 코드는 confirmation_required 다 (FR-DRC-5).
#[tokio::test]
async fn submodule_writes_require_confirm() {
    let Some(w) = sub_server(|_| {}) else { return };
    for path in WRITES {
        let (code, out) = sreq(&w.s, "POST", path, &format!(r#"{{"repo":{}}}"#, q(&w.repo))).await;
        assert_eq!(code, 400, "{path}: {out}");
        assert_eq!(out["error"], apierr::CODE_CONFIRM_REQUIRED, "{path}");
        want_no_ok(&out);
    }
}

// confirm 검사는 repo 해석보다 앞이다.
#[tokio::test]
async fn submodule_writes_confirm_checked_before_repo() {
    let Some(w) = sub_server(|_| {}) else { return };
    let (code, out) = sreq(
        &w.s,
        "POST",
        WRITES[0],
        r#"{"repo":"/definitely/not/a/repo"}"#,
    )
    .await;
    assert_eq!(
        out["error"],
        apierr::CODE_CONFIRM_REQUIRED,
        "confirm 이 먼저 걸려야 한다: {code} {out}"
    );
}

// 본문이 JSON 이 아니면 bad_request 다.
#[tokio::test]
async fn submodule_writes_reject_non_json_body() {
    let Some(w) = sub_server(|_| {}) else { return };
    for path in WRITES {
        let (code, out) = sreq(&w.s, "POST", path, "not json").await;
        assert!(
            code == 400 && out["error"] == apierr::CODE_BAD_REQUEST,
            "{path}: 400 bad_request 여야 한다, got {code} {out}"
        );
        want_no_ok(&out);
    }
}

// 안전 가드의 거부는 400 이다 — 실행 실패(500)와 가른다.
#[tokio::test]
async fn submodule_writes_unsafe_path_is_bad_request() {
    let Some(w) = sub_server(|_| {}) else { return };
    let body = format!(
        r#"{{"repo":{},"path":"../escape","confirm":true}}"#,
        q(&w.repo)
    );
    let (code, out) = sreq(&w.s, "POST", WRITES[0], &body).await;
    assert_eq!(code, 400, "{out}");
    assert_eq!(out["error"], apierr::CODE_BAD_REQUEST);
    want_no_ok(&out);
}

// 성공의 판정은 본문의 ok(update 는 job)다. repo 는 해석된 루트, requested 는 보낸 경로다.
#[tokio::test]
async fn submodule_writes_ok_carries_resolved_repo() {
    let Some(w) = sub_server(|s| s.job_runner = Some(remote_emit(&["done"]))) else {
        return;
    };
    let sub = std::path::Path::new(&w.repo).join("nested");
    std::fs::create_dir_all(&sub).unwrap();
    let sub = sub.to_string_lossy().into_owned();
    for path in WRITES {
        let body = format!(r#"{{"repo":{},"confirm":true}}"#, q(&sub));
        let (code, out) = sreq(&w.s, "POST", path, &body).await;
        assert_eq!(code, 200, "{path}: {out}");
        if path == WRITES[0] {
            job_id(&out);
        } else {
            assert_eq!(out["ok"], true, "{path}: {out}");
        }
        assert_eq!(out["repo"], w.repo.as_str(), "{path}: 해석된 루트여야 한다");
        assert_eq!(out["requested"], sub.as_str(), "{path}");
    }
}

// M8 D-A-27 (FBE-08): update 는 작업이다 — 응답은 {job} 이고 진행·취소는 원격 작업의 종단을 쓴다.
#[tokio::test]
async fn submodule_update_is_a_job() {
    let release = Arc::new(tokio::sync::Semaphore::new(0));
    let rc = release.clone();
    let Some(w) = sub_server(move |s| s.job_runner = Some(remote_hold(rc))) else {
        return;
    };
    let body = format!(
        r#"{{"repo":{},"path":"vendor/x","init":true,"confirm":true}}"#,
        q(&w.repo)
    );
    let (code, out) = sreq(&w.s, "POST", WRITES[0], &body).await;
    assert_eq!(code, 200, "{out}");
    let id = job_id(&out);
    assert_eq!(out["job"]["kind"], "submodule", "{out}");
    let argv = out["job"]["argv"].as_array().cloned().unwrap_or_default();
    assert!(
        argv.len() >= 2 && argv[0] == "submodule" && argv[1] == "update",
        "argv={argv:?}"
    );
    let (code, out) = sreq(&w.s, "POST", WRITES[0], &body).await;
    assert!(
        code == 409 && out["error"] == apierr::CODE_JOB_BUSY,
        "busy 여야 한다: {code} {out}"
    );
    let cancel = format!(r#"{{"repo":{},"id":{}}}"#, q(&w.repo), q(&id));
    let (code, out) = sreq(&w.s, "POST", "/api/git/job/cancel", &cancel).await;
    assert_eq!(code, 200, "cancel: {out}");
    let fin = wait_done(&w.s, &id).await;
    assert!(fin.canceled, "final={fin:?}");
    release.close();
    let body = format!(r#"{{"repo":{},"confirm":true}}"#, q(&w.repo));
    let (code, out) = sreq(&w.s, "POST", WRITES[1], &body).await;
    assert!(code == 200 && out["ok"] == true, "sync: {code} {out}");
}

// ── handlers_git_worktree_excl_test.go 의 submodule sync ──

fn sync_body() -> String {
    format!(
        r#"{{"repo":{},"confirm":true}}"#,
        q(&abs(&["work", "repo"]))
    )
}

fn sync_fail(kind: core::Kind) -> Result<String, Failure> {
    Err(Failure {
        text: String::new(),
        err: submodule::Error::from(core::Error::new(kind, "git submodule sync")),
    })
}

// sync 실패가 index.lock 이면 409 index_locked + lock 필드. 쓰기 단계는 서버 루트 파생 + 180s 다.
#[tokio::test]
async fn submodule_sync_index_locked_carries_lock_and_root_ctx() {
    let f = WriteFake::new();
    let deadline: Arc<Mutex<Option<Instant>>> = Arc::default();
    let d = deadline.clone();
    let runner: submodule::Runner = Arc::new(move |ctx: Ctx, _, _| {
        *d.lock().unwrap() = ctx.deadline();
        Box::pin(async { sync_fail(core::Kind::IndexLocked) })
    });
    let e = wserver_with(&f, move |s| {
        s.submodules = Some(Arc::new(Manager::new(runner)));
    });
    std::fs::write(std::path::Path::new(&f.git_dir()).join("index.lock"), "").unwrap();
    let (code, out) = sreq(&e.s, "POST", WRITES[1], &sync_body()).await;
    assert!(
        code == 409 && out["error"] == apierr::CODE_INDEX_LOCKED && !out["lock"].is_null(),
        "= {code} {out}, want 409 index_locked + lock"
    );
    let at = deadline.lock().unwrap().expect("마감이 없다");
    let left = at.saturating_duration_since(Instant::now());
    assert!(
        left >= core::MANAGER_WRITE_TIMEOUT - Duration::from_secs(10),
        "쓰기 단계 마감이 {left:?} 남았다 — want ≈ {:?}",
        core::MANAGER_WRITE_TIMEOUT
    );
}

// 종료로 끊긴 sync 는 503 server_shutdown.
#[tokio::test]
async fn submodule_sync_shutdown_is_503() {
    let f = WriteFake::new();
    let root = Ctx::background();
    let at = SystemTime::now();
    let store = Store::new(
        Arc::new(f.service()),
        StoreOptions::default()
            .clock(Arc::new(move || at))
            .root(root.clone()),
    );
    let runner: submodule::Runner = Arc::new(move |ctx: Ctx, _, _| {
        root.cancel();
        Box::pin(async move {
            ctx.done().await;
            sync_fail(core::Kind::Canceled)
        })
    });
    let e = wserver_with(&f, move |s| {
        s.git = Some(store);
        s.submodules = Some(Arc::new(Manager::new(runner)));
    });
    let (code, out) = sreq(&e.s, "POST", WRITES[1], &sync_body()).await;
    assert!(
        code == 503 && out["error"] == apierr::CODE_SERVER_SHUTDOWN,
        "= {code} {out}, want 503 server_shutdown"
    );
}

// ── handlers_git_stage_sub_test.go ──

// TC-FR1-5: 실제 git — 서브모듈 안에 파일만 더하면 stage 는 409 이고, 행 답도 거짓이다.
#[tokio::test]
async fn stage_submodule_inner_only_real_git() {
    let Some(w) = sub_server(|_| {}) else { return };
    let Some(inner) = otter_shared_gittest::repo() else {
        return;
    };
    add_submodule(&w.repo, inner.path().to_str().unwrap(), "sub");
    let repo = std::path::Path::new(&w.repo);
    std::fs::write(repo.join("sub").join("new.txt"), "x").unwrap();
    let (code, out) = sreq(
        &w.s,
        "GET",
        &format!("/api/git/status?repo={}", qe(&w.repo)),
        "",
    )
    .await;
    let a = &out["rowActions"]["sub"][action::GIT_STAGE];
    assert!(
        code == 200 && a["why"] == apierr::CODE_SUBMODULE_INNER_ONLY,
        "status = {code} rowActions={}",
        out["rowActions"]
    );
    let body = format!(r#"{{"repo":{},"paths":["sub"]}}"#, q(&w.repo));
    let (code, out) = sreq(&w.s, "POST", "/api/git/stage", &body).await;
    assert!(
        code == 409 && out["error"] == apierr::CODE_SUBMODULE_INNER_ONLY,
        "stage = {code} {out}"
    );
    let cached = otter_shared_gittest::run(repo, &["diff", "--cached", "--name-only"]);
    assert_eq!(cached, "", "index 가 바뀌었다");
}
