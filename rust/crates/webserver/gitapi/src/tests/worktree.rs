//! Go `handlers_git_worktree_test.go`·`handlers_git_worktree_excl_test.go` 의 이식
//! (GIT_REVIEW4_SRS §3.6.5 · REPO_FIX 01 §5.6). Go 처럼 실제 git 을 임시 저장소에 쓰고, git 이 없으면
//! 그 검사를 건너뛴다.
//!
//! 옮기지 않았거나 모양을 바꾼 것:
//! - TestGitWorktreeRoutes_RegisteredAndUnavailable 의 routes 표 순회: 표는 crate 비공개다. 등록되지
//!   않은 경로는 `req` 가 404 로 답하므로 503 git_unavailable 확인이 등록 확인을 겸한다.
//! - TestGitWorktreeOwner_ClassifiesByPath: `worktree_owner` 는 `crate::worktree` 의 비공개 함수라
//!   `crate::tests` 에서 부를 수 없다. 같은 표를 실제 worktree 를 그 자리에 만들어 목록 응답의
//!   `owner` 로 본다(`owner_classifies_by_path`). 목록에 없는 경로(absOtherRepo)는 임시 디렉터리의
//!   worktree 로 바꿨다.
//! - TestSubmoduleSync_IndexLockedCarriesLockAndRootCtx·TestSubmoduleSync_ShutdownIs503 는
//!   `tests/submodule.rs` 로 옮겼다.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use dm_shared_gittest::{Repo, TempDir};
use dm_webserver_action as action;
use dm_webserver_apierr as apierr;
use dm_webserver_domain_git_core::{self as core, Ctx, Service};
use dm_webserver_domain_git_jobs::{Exclusion, Job, JobRunner, Keys, LINE_STDERR, StartOptions};
use dm_webserver_domain_git_store::{Store, StoreOptions};
use dm_webserver_domain_git_write as write;
use dm_webserver_domain_worktree::{self as worktree, Manager};
use http::Method;
use serde_json::{Value, json};

use super::harness::{abs, q, qe, req};
use super::wfake::{job_done, remote_hold};
use crate::GitServer;
use crate::job::job_succeeded;
use crate::req::Req;

/// Go `wtExclWait`.
const WAIT: Duration = Duration::from_millis(80);

/// Go `worktreeTestServer`·`wtExclServer` 가 세운 것.
struct Wt {
    s: Arc<GitServer>,
    repo: String,
    /// 사용자 영역의 root (Manager 가 푼 값).
    user_root: String,
    run_root: String,
    home: PathBuf,
    release: Arc<tokio::sync::Semaphore>,
    _home: TempDir,
    _repo: Repo,
}

impl Drop for Wt {
    fn drop(&mut self) {
        self.release.close();
    }
}

fn wt_git(dir: &str, args: &[&str]) -> String {
    dm_shared_gittest::run(Path::new(dir), args)
}

/// Go `worktreeTestServer`: 실제 git 을 쓰는 GitServer. RunWorktreeRoot 는 만들지 않는다.
fn wt_server() -> Option<Wt> {
    wt_server_with(false, |_, _| {})
}

/// Go `wtExclServer`: 짧은 잠금 대기와, 사용자 영역의 `worktree add` 만 실제 git 으로 돌리고 나머지
/// 잡은 붙잡는 실행기다. `edit` 는 Arc 로 감싸기 전에 서버를 고친다(home 을 받는다).
fn wt_excl_server(edit: impl FnOnce(&mut GitServer, &Path)) -> Option<Wt> {
    wt_server_with(true, edit)
}

fn wt_server_with(excl: bool, edit: impl FnOnce(&mut GitServer, &Path)) -> Option<Wt> {
    let repo = dm_shared_gittest::repo()?;
    let tmp = TempDir::new("dm-gitapi-wt-");
    let home = std::fs::canonicalize(tmp.path()).unwrap();
    let mgr = Manager::new(home.join("git-worktrees").to_str().unwrap());
    let user_root = mgr.root().to_owned();
    let run_root = home.join("worktrees").to_string_lossy().into_owned();
    let release = Arc::new(tokio::sync::Semaphore::new(0));
    let mut s = GitServer {
        git: Some(Store::new(
            Arc::new(Service::new()),
            StoreOptions::default(),
        )),
        user_worktrees: Some(Arc::new(mgr)),
        run_worktree_root: run_root.clone(),
        ..GitServer::default()
    };
    if excl {
        s.exclusion = Some(Exclusion::new());
        s.lock_wait = WAIT;
        s.job_runner = Some(excl_runner(user_root.clone(), release.clone()));
    }
    edit(&mut s, &home);
    Some(Wt {
        s: Arc::new(s),
        repo: repo.path().to_string_lossy().into_owned(),
        user_root,
        run_root,
        home,
        release,
        _home: tmp,
        _repo: repo,
    })
}

fn excl_runner(root: String, release: Arc<tokio::sync::Semaphore>) -> JobRunner {
    let hold = remote_hold(release);
    Arc::new(
        move |ctx: Ctx, dir: String, args: Vec<String>, stdin, emit| {
            let n = args.len();
            if n > 2 && args[0] == "worktree" && args[1] == "add" && args[n - 2].starts_with(&root)
            {
                return Box::pin(async move {
                    let a: Vec<&str> = args.iter().map(String::as_str).collect();
                    match dm_webserver_domain_submodule::exec_git(&ctx, &dir, &a).await {
                        Ok(_) => (0, None),
                        Err(f) => {
                            emit(LINE_STDERR, &f.text);
                            (1, None)
                        }
                    }
                });
            }
            hold(ctx, dir, args, stdin, emit)
        },
    )
}

/// Go `wtReq`.
async fn wt_req(s: &Arc<GitServer>, method: &str, target: &str, body: &str) -> (u16, Value) {
    let r = req(s, method, target, body).await;
    (r.code, r.json())
}

/// Go `wtCreateAwait`: 생성 잡을 끝까지 기다려 동기 모양 {ok, path, branch} 로 편다.
async fn wt_create_await(s: &Arc<GitServer>, body: &str) -> (u16, Value) {
    let (code, mut out) = wt_req(s, "POST", "/api/git/worktrees/create", body).await;
    if code != 200 || out.get("job").is_none_or(Value::is_null) {
        return (code, out);
    }
    let jb = job_done(s, &out).await;
    out["ok"] = json!(job_succeeded(&jb));
    if let Some(r) = &jb.result {
        out["path"] = json!(r.path);
        out["branch"] = json!(r.branch);
    }
    (code, out)
}

/// Go `wantNoOK`: 실패 응답에는 "ok" 가 아예 없다 (V164).
fn want_no_ok(out: &Value) {
    assert!(
        out.get("ok").is_none(),
        "실패 응답에 ok 가 있으면 안 된다: {out}"
    );
}

fn create_body(repo: &str, name: &str, r: &str, new_branch: bool) -> String {
    let nb = if new_branch {
        r#","newBranch":true"#
    } else {
        ""
    };
    format!(
        r#"{{"repo":{},"name":{},"ref":{}{nb}}}"#,
        q(repo),
        q(name),
        q(r)
    )
}

fn list_target(repo: &str) -> String {
    format!("/api/git/worktrees?repo={}", qe(repo))
}

fn exists(p: &str) -> bool {
    std::fs::symlink_metadata(p).is_ok()
}

fn entries(out: &Value) -> Vec<Value> {
    out["worktrees"].as_array().cloned().unwrap_or_default()
}

// 라우팅 등록 + UserWorktrees 없으면 503.
#[tokio::test]
async fn worktree_routes_registered_and_unavailable() {
    let s = Arc::new(GitServer::default());
    for (method, path, body) in [
        (
            "GET",
            format!("/api/git/worktrees?repo={}", qe(&abs(&["x"]))),
            "",
        ),
        ("POST", "/api/git/worktrees/create".to_owned(), "{}"),
        ("POST", "/api/git/worktrees/remove".to_owned(), "{}"),
    ] {
        let (code, out) = wt_req(&s, method, &path, body).await;
        assert!(
            code == 503 && out["error"] == apierr::CODE_UNAVAILABLE,
            "{method} {path} → {code} {out}, want 503 git_unavailable"
        );
        want_no_ok(&out);
    }
}

// V145 (FR-GIT-240): 소유는 경로로만 판정한다 — root 자신과 이름만 닮은 형제는 outside 다.
#[tokio::test]
async fn owner_classifies_by_path() {
    let Some(w) = wt_server() else { return };
    let user = w.user_root.clone();
    let run = w.run_root.clone();
    let other = w.home.join("other").to_string_lossy().into_owned();
    // root 자신을 먼저 만든다 — 그 안의 worktree 는 뒤에 만들어야 git 이 받는다.
    let cases = [
        (user.clone(), "outside"),
        (run.clone(), "outside"),
        (format!("{user}/app-abc12345/feature"), "user"),
        (format!("{run}/run1/mem1"), "run"),
        (other, "outside"),
        (format!("{user}-decoy/x"), "outside"),
    ];
    for (i, (p, _)) in cases.iter().enumerate() {
        wt_git(
            &w.repo,
            &["worktree", "add", "--no-track", "-b", &format!("b{i}"), p],
        );
    }
    let (code, out) = wt_req(&w.s, "GET", &list_target(&w.repo), "").await;
    assert_eq!(code, 200, "{out}");
    let rows = entries(&out);
    for (p, want) in &cases {
        let e = rows
            .iter()
            .find(|e| e["path"] == p.as_str())
            .unwrap_or_else(|| panic!("{p} 가 목록에 없다: {out}"));
        assert_eq!(e["owner"], *want, "{p}");
    }
}

// V148 (FR-GIT-242, FR-WKT-6): 이름이 - 로 시작하면 거부한다.
#[tokio::test]
async fn create_rejects_dash_leading_name() {
    let Some(w) = wt_server() else { return };
    let (code, out) = wt_create_await(&w.s, &create_body(&w.repo, "-x", "main", false)).await;
    assert!(
        code == 400 && out["error"] == apierr::CODE_REF_NAME,
        "want 400 ref_name_invalid, got {code} {out}"
    );
    want_no_ok(&out);
}

// V148: 이미 있는 이름(경로)을 거부한다 — 조용히 다른 경로를 고르지 않는다.
#[tokio::test]
async fn create_rejects_existing_name() {
    let Some(w) = wt_server() else { return };
    wt_git(&w.repo, &["branch", "other"]);
    let body = create_body(&w.repo, "feature", "other", false);
    let (code, out) = wt_create_await(&w.s, &body).await;
    assert_eq!(code, 200, "첫 생성: {out}");
    assert_eq!(out["ok"], true, "성공 응답에 ok:true 가 없다: {out}");
    let path = out["path"].as_str().unwrap_or_default();
    assert!(
        path.starts_with(&format!("{}{}", w.user_root, std::path::MAIN_SEPARATOR)),
        "경로가 사용자 영역 밖이다: {out}"
    );
    let (code, out) = wt_create_await(&w.s, &body).await;
    assert!(
        code == 409 && out["error"] == apierr::CODE_WORKTREE_EXISTS,
        "같은 이름 재생성이 거부되지 않았다: {code} {out}"
    );
    want_no_ok(&out);
}

// V148: 새 브랜치를 요청했는데 그 이름의 로컬 브랜치가 이미 있으면 거부한다.
#[tokio::test]
async fn create_rejects_existing_branch() {
    let Some(w) = wt_server() else { return };
    wt_git(&w.repo, &["branch", "taken"]);
    let (code, out) = wt_create_await(&w.s, &create_body(&w.repo, "taken", "main", true)).await;
    assert!(
        code == 409 && out["error"] == apierr::CODE_BRANCH_EXISTS,
        "want 409 branch_exists, got {code} {out}"
    );
    want_no_ok(&out);
}

/// 새 브랜치 feature 의 worktree 를 만들고 경로를 준다.
async fn create_feature(w: &Wt) -> String {
    let (_, out) = wt_create_await(&w.s, &create_body(&w.repo, "feature", "main", true)).await;
    let path = out["path"].as_str().unwrap_or_default().to_owned();
    assert!(!path.is_empty(), "생성 실패: {out}");
    path
}

fn remove_body(repo: &str, path: &str, extra: &str) -> String {
    format!(r#"{{"repo":{},"path":{}{extra}}}"#, q(repo), q(path))
}

// FR-GIT-240/242: 생성 → 목록(소유·main 표식) → 확인 없는 제거 거부 → 제거.
#[tokio::test]
async fn create_list_remove() {
    let Some(w) = wt_server() else { return };
    let (code, out) = wt_create_await(&w.s, &create_body(&w.repo, "feature", "main", true)).await;
    assert_eq!(code, 200, "create: {out}");
    assert_eq!(out["ok"], true, "create 성공 응답에 ok:true 가 없다: {out}");
    assert_eq!(out["branch"], "feature", "branch 가 응답에 없다: {out}");
    let path = out["path"].as_str().unwrap_or_default().to_owned();

    let (code, out) = wt_req(&w.s, "GET", &list_target(&w.repo), "").await;
    assert_eq!(code, 200, "list: {out}");
    let rows = entries(&out);
    let new = rows.iter().find(|e| e["path"] == path.as_str());
    let new = new.unwrap_or_else(|| panic!("새 worktree 가 목록에 없다: {out}"));
    assert!(
        new["owner"] == "user" && new["branch"] == "feature",
        "새 worktree 항목이 어긋난다: {new}"
    );
    let main = rows.iter().find(|e| e["path"] == w.repo.as_str());
    let main = main.unwrap_or_else(|| panic!("main worktree 가 목록에 없다: {out}"));
    assert_eq!(main["main"], true, "main worktree 표식이 없다: {main}");

    let target = "/api/git/worktrees/remove";
    let (code, out) = wt_req(&w.s, "POST", target, &remove_body(&w.repo, &path, "")).await;
    assert!(
        code == 400 && out["error"] == apierr::CODE_CONFIRM_REQUIRED,
        "확인 없는 제거가 통과했다: {code} {out}"
    );
    want_no_ok(&out);
    assert!(exists(&path), "확인 없이 제거됐다");

    let body = remove_body(&w.repo, &path, r#","confirm":true"#);
    let (code, out) = wt_req(&w.s, "POST", target, &body).await;
    assert!(
        code == 200 && out["removed"] == true,
        "제거 실패: {code} {out}"
    );
    assert_eq!(out["ok"], true, "remove 성공 응답에 ok:true 가 없다: {out}");
    assert!(!exists(&path), "경로가 남았다");
}

// V164: dirty 거부는 처리 성공(ok:true)이면서 removed:false 다.
#[tokio::test]
async fn remove_dirty_is_ok_but_not_removed() {
    let Some(w) = wt_server() else { return };
    let path = create_feature(&w).await;
    let work = Path::new(&path).join("작업물.txt");
    std::fs::write(&work, "지우면 안 된다\n").unwrap();
    let body = remove_body(&w.repo, &path, r#","confirm":true"#);
    let (code, out) = wt_req(&w.s, "POST", "/api/git/worktrees/remove", &body).await;
    assert_eq!(code, 200, "dirty 거부도 200 이어야 한다: {out}");
    assert_eq!(out["ok"], true, "dirty 거부 응답에 ok:true 가 없다: {out}");
    assert!(
        out["removed"] == false && out["residue"] == "dirty",
        "removed/residue 가 어긋난다: {out}"
    );
    assert!(exists(&path), "dirty worktree 가 지워졌다");
    assert!(work.exists(), "사용자 작업이 사라졌다");
}

// V162: 링크드 worktree 로 조회해도 main 배지는 원래 저장소에 남는다.
#[tokio::test]
async fn main_stays_on_origin_when_queried_from_linked_worktree() {
    let Some(w) = wt_server() else { return };
    let path = create_feature(&w).await;
    let (code, out) = wt_req(&w.s, "GET", &list_target(&path), "").await;
    assert_eq!(code, 200, "list: {out}");
    for e in entries(&out) {
        if e["path"] == w.repo.as_str() {
            assert_eq!(
                e["main"], true,
                "main worktree(repo) 의 main 표식이 사라졌다: {e}"
            );
        }
        if e["path"] == path.as_str() {
            assert_ne!(
                e["main"], true,
                "조회에 쓴 링크드 worktree 에 main 이 잘못 섰다: {e}"
            );
        }
    }
}

// W6 (FR-WRA-5): 사용자 영역 밖의 worktree 도 등록돼 있으면 지워진다. 브랜치는 남는다.
#[tokio::test]
async fn remove_removes_outside_user_area() {
    let Some(w) = wt_server() else { return };
    let parent = TempDir::new("dm-gitapi-wt-out-");
    let outside = std::fs::canonicalize(parent.path())
        .unwrap()
        .join("outside");
    let outside = outside.to_string_lossy().into_owned();
    wt_git(
        &w.repo,
        &[
            "worktree",
            "add",
            "--no-track",
            "-b",
            "outside-branch",
            &outside,
        ],
    );
    let body = remove_body(&w.repo, &outside, r#","confirm":true"#);
    let (code, out) = wt_req(&w.s, "POST", "/api/git/worktrees/remove", &body).await;
    assert!(
        code == 200 && out["ok"] == true && out["removed"] == true,
        "사용자 영역 밖 worktree 가 지워지지 않았다: {code} {out}"
    );
    assert!(!exists(&outside), "경로가 남았다");
    assert_ne!(
        wt_git(&w.repo, &["branch", "--list", "outside-branch"]),
        "",
        "브랜치가 사라졌다"
    );
}

// W6 (FR-WRA-5): main worktree 는 제거 요청이 와도 지우지 않는다.
#[tokio::test]
async fn remove_rejects_main() {
    let Some(w) = wt_server() else { return };
    let body = remove_body(&w.repo, &w.repo, r#","confirm":true"#);
    let (code, out) = wt_req(&w.s, "POST", "/api/git/worktrees/remove", &body).await;
    assert!(
        code == 200 && out["removed"] == false && out["residue"] == "unsafe-path",
        "main worktree 가 거부되지 않았다: {code} {out}"
    );
    assert!(exists(&w.repo), "저장소가 지워졌다");
}

// W6 (FR-WRA-5): force:true 면 dirty worktree 도 지워진다.
#[tokio::test]
async fn remove_force_removes_dirty() {
    let Some(w) = wt_server() else { return };
    let path = create_feature(&w).await;
    std::fs::write(Path::new(&path).join("작업물.txt"), "x\n").unwrap();
    let body = remove_body(&w.repo, &path, r#","confirm":true,"force":true"#);
    let (code, out) = wt_req(&w.s, "POST", "/api/git/worktrees/remove", &body).await;
    assert!(
        code == 200 && out["removed"] == true,
        "force 제거 실패: {code} {out}"
    );
    assert!(!exists(&path), "경로가 남았다");
}

// FR-GIT-243: 이 저장소의 worktree 가 아닌 경로는 404 다.
#[tokio::test]
async fn remove_rejects_unknown_path() {
    let Some(w) = wt_server() else { return };
    let body = remove_body(&w.repo, &abs(&["nope", "nope"]), r#","confirm":true"#);
    let (code, out) = wt_req(&w.s, "POST", "/api/git/worktrees/remove", &body).await;
    assert!(
        code == 404 && out["error"] == apierr::CODE_NOT_FOUND,
        "want 404 not_found, got {code} {out}"
    );
    want_no_ok(&out);
}

// ── handlers_git_worktree_excl_test.go ──
// REPO_FIX 01 §5.6 — worktree add 는 잡(common 칸 + repoLock), remove 는 대상 worktree 의 칸·뮤텍스만
// 본다.

/// Go `wtCommonKey`.
async fn common_key(repo: &str) -> String {
    core::common_dir_key(None, &Ctx::background(), repo)
        .await
        .unwrap()
}

/// 잡 허브다.
fn hub(w: &Wt) -> dm_webserver_domain_git_jobs::Jobs {
    w.s.jobs_hub(w.s.git.as_ref().unwrap())
}

/// Go `wtCreate`: 생성 잡을 끝까지 기다려 결과를 준다.
async fn wt_create(w: &Wt, name: &str) -> Job {
    let body = create_body(&w.repo, name, "main", true);
    let (code, out) = wt_req(&w.s, "POST", "/api/git/worktrees/create", &body).await;
    assert!(
        code == 200 && !out["job"].is_null(),
        "create = {code} {out}, want 200 {{job}}"
    );
    let jb = job_done(&w.s, &out).await;
    assert!(
        job_succeeded(&jb) && jb.result.as_ref().is_some_and(|r| !r.path.is_empty()),
        "생성 잡 실패: {jb:?}"
    );
    jb
}

async fn created_path(w: &Wt, name: &str) -> String {
    wt_create(w, name).await.result.unwrap().path
}

/// Go `wtRemove`.
async fn wt_remove(w: &Wt, repo: &str, path: &str) -> (u16, Value) {
    let body = remove_body(repo, path, r#","confirm":true"#);
    wt_req(&w.s, "POST", "/api/git/worktrees/remove", &body).await
}

async fn top_common_keys(w: &Wt, top: &str) -> Keys {
    Keys {
        top: core::exclusion_key(top),
        common: common_key(&w.repo).await,
    }
}

fn commit_x() -> core::WriteSpec {
    write::commit_spec(&write::CommitOpts {
        message: "x".to_owned(),
        ..write::CommitOpts::default()
    })
}

// 생성은 잡이다 — common 칸, 결과에 path·branch, 완료 처리가 config 두 건을 쓰고 repoLock 을 반납한다.
#[tokio::test]
async fn create_is_a_common_job() {
    let Some(w) = wt_excl_server(|_, _| {}) else {
        return;
    };
    let body = create_body(&w.repo, "feat", "main", true);
    let (code, out) = wt_req(&w.s, "POST", "/api/git/worktrees/create", &body).await;
    assert_eq!(code, 200, "{out}");
    assert_eq!(out["job"]["kind"], "worktree", "{out}");
    assert_eq!(out["job"]["slots"], json!(["common"]), "{out}");
    let jb = job_done(&w.s, &out).await;
    assert!(job_succeeded(&jb), "잡 = {jb:?}");
    let r = jb.result.clone().unwrap();
    assert!(
        r.path
            .starts_with(&format!("{}{}", w.user_root, std::path::MAIN_SEPARATOR))
            && r.branch == "feat",
        "result = {r:?}"
    );
    assert_eq!(wt_git(&r.path, &["config", "push.autoSetupRemote"]), "true");
    assert_eq!(wt_git(&w.repo, &["config", "branch.feat.base"]), "main");
    let lock = worktree::lock_repo(&Ctx::background(), &common_key(&w.repo).await, WAIT).await;
    assert!(lock.is_ok(), "완료 뒤 repoLock 이 남았다: {:?}", lock.err());
}

// 같은 common dir 의 common 칸이 차 있으면 409 job_busy — 아무것도 만들지 않는다.
#[tokio::test]
async fn create_common_slot_busy() {
    let Some(w) = wt_excl_server(|_, _| {}) else {
        return;
    };
    let keys = top_common_keys(&w, &w.repo).await;
    let argv = vec!["submodule".to_owned(), "update".to_owned()];
    hub(&w)
        .start_unguarded(
            &w.repo,
            keys,
            "submodule",
            argv,
            "test",
            StartOptions::default(),
        )
        .unwrap();
    let body = create_body(&w.repo, "feat", "main", false);
    let (code, out) = wt_req(&w.s, "POST", "/api/git/worktrees/create", &body).await;
    assert!(
        code == 409 && out["error"] == apierr::CODE_JOB_BUSY,
        "= {code} {out}, want 409 job_busy"
    );
    assert!(!exists(&w.user_root), "거부됐는데 디렉터리가 생겼다");
}

// repoLock 을 제한 안에 얻지 못하면 409 repo_busy.
#[tokio::test]
async fn create_repo_lock_busy() {
    let Some(w) = wt_excl_server(|_, _| {}) else {
        return;
    };
    let key = common_key(&w.repo).await;
    let _lock = worktree::lock_repo(&Ctx::background(), &key, Duration::from_secs(1))
        .await
        .unwrap();
    let body = create_body(&w.repo, "feat", "main", false);
    let (code, out) = wt_req(&w.s, "POST", "/api/git/worktrees/create", &body).await;
    assert!(
        code == 409 && out["error"] == apierr::CODE_REPO_BUSY,
        "= {code} {out}, want 409 repo_busy"
    );
}

// 등록 직전에 요청이 떠나면 등록하지 않고, repoLock 을 반납하고, 이번에 만든 빈 부모 디렉터리를 지운다.
#[tokio::test]
async fn create_canceled_before_register_cleans_up() {
    let slot: Arc<std::sync::Mutex<Option<Ctx>>> = Arc::default();
    let sc = slot.clone();
    let Some(w) = wt_excl_server(move |s, home| {
        // BranchExists(rev-parse --verify) 에서 요청이 떠난다 — 부모 디렉터리 생성 뒤의 ④ 확인에서 걸린다.
        let runner: worktree::Runner = Arc::new(move |ctx: Ctx, dir: String, args: Vec<String>| {
            if args.len() > 1
                && args[0] == "rev-parse"
                && args[1] == "--verify"
                && let Some(c) = sc.lock().unwrap().as_ref()
            {
                c.cancel();
            }
            Box::pin(async move {
                let a: Vec<&str> = args.iter().map(String::as_str).collect();
                worktree::exec_git(&ctx, &dir, &a).await
            })
        });
        let mgr = Manager::new(home.join("git-worktrees").to_str().unwrap()).with_runner(runner);
        s.user_worktrees = Some(Arc::new(mgr));
    }) else {
        return;
    };
    let body = create_body(&w.repo, "feat", "main", true);
    let mut r = Req::for_test(Method::POST, "/api/git/worktrees/create", &body);
    *slot.lock().unwrap() = Some(r.ctx.clone());
    let res = w.s.api_git_worktree_create(&mut r).await;
    assert_eq!(res.status().as_u16(), apierr::STATUS_CLIENT_CLOSED);
    assert_eq!(res.headers()["x-error-code"], apierr::CODE_CANCELED);
    assert!(
        !exists(&w.user_root),
        "이번에 만든 빈 부모 디렉터리가 남았다"
    );
    let lock = worktree::lock_repo(&Ctx::background(), &common_key(&w.repo).await, WAIT).await;
    assert!(
        lock.is_ok(),
        "등록 실패 뒤 repoLock 이 남았다: {:?}",
        lock.err()
    );
}

// worktree 잡이 도는 동안 remove 는 409 job_busy.
#[tokio::test]
async fn remove_worktree_job_busy() {
    let Some(w) = wt_excl_server(|_, _| {}) else {
        return;
    };
    let path = created_path(&w, "feat").await;
    let keys = top_common_keys(&w, &w.repo).await;
    let argv = ["worktree", "add", "x"].map(str::to_owned).to_vec();
    hub(&w)
        .start_unguarded(
            &w.repo,
            keys,
            "worktree",
            argv,
            "test",
            StartOptions::default(),
        )
        .unwrap();
    let (code, out) = wt_remove(&w, &w.repo, &path).await;
    assert!(
        code == 409 && out["error"] == apierr::CODE_JOB_BUSY,
        "= {code} {out}, want 409 job_busy"
    );
    assert!(exists(&path), "거부됐는데 지워졌다");
}

// 원격 잡(push·fetch)은 common 칸이지만 worktree 잡이 아니다 — remove 는 막히지 않는다.
#[tokio::test]
async fn remove_remote_job_does_not_block() {
    let Some(w) = wt_excl_server(|_, _| {}) else {
        return;
    };
    let path = created_path(&w, "feat").await;
    let keys = top_common_keys(&w, &w.repo).await;
    let spec = write::fetch_spec(&write::FetchOpts::default());
    hub(&w)
        .start(&w.repo, keys, "fetch", spec, StartOptions::default())
        .unwrap();
    let (code, out) = wt_remove(&w, &w.repo, &path).await;
    assert!(
        code == 200 && out["removed"] == true,
        "= {code} {out}, want 200 removed"
    );
}

// 대상 worktree 의 index 칸이 차 있으면 409 job_busy, 요청 worktree 의 index 칸은 보지 않는다.
#[tokio::test]
async fn remove_target_index_slot_only() {
    let Some(w) = wt_excl_server(|_, _| {}) else {
        return;
    };
    let a = created_path(&w, "a").await;
    let b = created_path(&w, "b").await;
    let h = hub(&w);
    h.start(
        &a,
        top_common_keys(&w, &a).await,
        "commit",
        commit_x(),
        StartOptions::default(),
    )
    .unwrap();
    let keys = top_common_keys(&w, &w.repo).await;
    h.start(&w.repo, keys, "commit", commit_x(), StartOptions::default())
        .unwrap();
    let (code, out) = wt_remove(&w, &w.repo, &a).await;
    assert!(
        code == 409 && out["error"] == apierr::CODE_JOB_BUSY,
        "대상 index 잡 중 = {code} {out}, want 409 job_busy"
    );
    let (code, out) = wt_remove(&w, &w.repo, &b).await;
    assert!(
        code == 200 && out["removed"] == true,
        "요청 worktree 의 index 잡 중 = {code} {out}, want 200 removed"
    );
}

// 대상 toplevel 뮤텍스를 얻지 못하면 409 repo_busy. common-dir 잠금(stash)은 보지 않는다.
#[tokio::test]
async fn remove_target_mutex_not_stash_lock() {
    let Some(w) = wt_excl_server(|_, _| {}) else {
        return;
    };
    let path = created_path(&w, "feat").await;
    let x = w.s.exclusion();
    let bg = Ctx::background();
    let _common = x
        .lock_common(&bg, &common_key(&w.repo).await, Duration::from_secs(1))
        .await
        .unwrap();
    let top = x
        .lock_top(&bg, &core::exclusion_key(&path), Duration::from_secs(1))
        .await
        .unwrap();
    let (code, out) = wt_remove(&w, &w.repo, &path).await;
    assert!(
        code == 409 && out["error"] == apierr::CODE_REPO_BUSY,
        "대상 뮤텍스 중 = {code} {out}, want 409 repo_busy"
    );
    top.release();
    let (code, out) = wt_remove(&w, &w.repo, &path).await;
    assert!(
        code == 200 && out["removed"] == true,
        "stash 잠금 중 = {code} {out}, want 200 removed"
    );
}

// repoLock 대기가 쓰기 단계 마감에 걸리면 504 git_timeout — 삭제는 일어나지 않는다.
#[tokio::test]
async fn remove_repo_lock_deadline_is_504() {
    let Some(w) = wt_excl_server(|s, _| s.manager_write = WAIT) else {
        return;
    };
    let path = created_path(&w, "feat").await;
    let key = common_key(&w.repo).await;
    let _lock = worktree::lock_repo(&Ctx::background(), &key, Duration::from_secs(1))
        .await
        .unwrap();
    let (code, out) = wt_remove(&w, &w.repo, &path).await;
    assert!(
        code == 504 && out["error"] == apierr::CODE_TIMEOUT,
        "= {code} {out}, want 504 git_timeout"
    );
    assert!(exists(&path), "시한에 걸렸는데 지워졌다");
}

// 요청 = 대상이면 Manager 가 unsafe-path 잔여물로 끝낸다.
#[tokio::test]
async fn remove_self_is_unsafe_path() {
    let Some(w) = wt_excl_server(|_, _| {}) else {
        return;
    };
    let path = created_path(&w, "feat").await;
    let (code, out) = wt_remove(&w, &path, &path).await;
    assert!(
        code == 200 && out["removed"] == false && out["residue"] == worktree::RESIDUE_UNSAFE_PATH,
        "= {code} {out}, want 200 unsafe-path"
    );
}

// 밖에서 지운 worktree 도 순서가 그대로 돌고 제거(prune)에 성공한다. 연달아 지워도 차례로 성공한다.
#[tokio::test]
async fn remove_gone_outside_and_consecutive() {
    let Some(w) = wt_excl_server(|_, _| {}) else {
        return;
    };
    let a = created_path(&w, "a").await;
    let b = created_path(&w, "b").await;
    std::fs::remove_dir_all(&a).unwrap();
    let (ra, rb) = tokio::join!(wt_remove(&w, &w.repo, &a), wt_remove(&w, &w.repo, &b));
    for (i, (code, out)) in [ra, rb].into_iter().enumerate() {
        assert!(
            code == 200 && out["removed"] == true,
            "[{i}] = {code} {out}, want 200 removed"
        );
    }
}

// Git 이 없는 배선에서도 잡 키의 common 은 common-dir 이다 (FR-GXU-4).
#[tokio::test]
async fn job_keys_without_git_uses_common_dir() {
    let Some(repo) = dm_shared_gittest::repo() else {
        return;
    };
    let root = repo.path().to_string_lossy().into_owned();
    let s = GitServer::default();
    let Ok(k) = s.job_keys(&Ctx::background(), &root).await else {
        panic!("job_keys 실패");
    };
    let git_dir = repo.path().join(".git");
    assert_eq!(k.common, core::exclusion_key(git_dir.to_str().unwrap()));
}

// GR-1h (TC-SDA-1): 목록의 행 답은 지우기의 거절과 같은 판정이다.
#[tokio::test]
async fn worktree_rows_remove_answer_matches_rejection() {
    let Some(w) = wt_excl_server(|_, _| {}) else {
        return;
    };
    let a = created_path(&w, "a").await;
    let b = created_path(&w, "b").await;
    hub(&w)
        .start(
            &a,
            top_common_keys(&w, &a).await,
            "commit",
            commit_x(),
            StartOptions::default(),
        )
        .unwrap();
    let (code, out) = wt_req(&w.s, "GET", &list_target(&w.repo), "").await;
    assert_eq!(code, 200, "목록 = {out}");
    let answer = |p: &str| {
        entries(&out)
            .into_iter()
            .find(|e| e["path"] == p)
            .map(|e| e["actions"][action::GIT_WORKTREE_REMOVE].clone())
            .unwrap_or(Value::Null)
    };
    let (aa, ab) = (answer(&a), answer(&b));
    assert!(
        aa["ok"] == false && aa["why"] == apierr::CODE_JOB_BUSY,
        "잡이 도는 행 = {aa}, want job_busy"
    );
    assert_eq!(ab["ok"], true, "한가한 행 = {ab}, want ok");
    let (code, out) = wt_remove(&w, &w.repo, &a).await;
    assert!(
        code == 409 && out["error"] == aa["why"],
        "실행 = {code} {out}, 답과 같은 코드로 거절돼야 한다"
    );
}
