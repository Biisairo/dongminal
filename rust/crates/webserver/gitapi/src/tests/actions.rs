//! Go `handlers_git_actions_input_test.go`·`handlers_git_actions_branch_test.go`·
//! `handlers_git_actions_target_test.go` 와 `handlers_git_actions_test.go`·
//! `handlers_git_actions_facts_test.go`·`handlers_git_actions_slots_test.go` 중 답 종단
//! GET /api/git/actions 갈래의 이식 (SERVER_DRIVEN_ACTIONS_SRS GV·GT). Go 처럼 `gtBranchRepo` 는
//! 실제 git 과 로컬 bare 원격이다(네트워크를 타지 않는다). git 이 없으면 그 시험은 일찍 끝난다.
//!
//! 옮기지 않은 것:
//! - TestStashCreateAnswer·TestErrAnswer·TestFactAnswers·TestSlotsAnswer·TestUpstreamInputAnswer·
//!   TestRemoteAddInputAnswer 의 판정 함수 절반: answers.rs 가 옮겼다. Upstream·RemoteAdd 는 여기서
//!   답 종단으로 다시 잰다(Go `runInputCases` 그대로).
//! - TestStatusActions_*(FollowSlots·PullHoldsBoth·InUnchanged·MatchRejection·Facts)·
//!   TestFactAnswers_SlotFirst: exclusion.rs·answers.rs 가 옮겼다.
//! - TestStashCreateAnswerMatchesRejection·TestGitActionsUnknownAction·TestFactAnswers_MatchRejection:
//!   5.4.1·5.4.2 가 5.4.3 으로 미룬 목록이라 carryover.rs 에 있다.
//! - `split_verdict_test.go`: 시험 대상(`git_status_unchanged`·`git_status_unchanged_body`·
//!   `git_status_body`·`git_status_not_repo_body`·`log_rejected`·`listed_worktree_branch`·
//!   `worktree_remove_body`, Go 의 stop+skip 판정)이 모두 모듈 비공개 함수라 tests 모듈에서 부를 수
//!   없다. 관측 동작(본문의 키·unchanged·not-repo·log 400)은 handlers_git.rs·observe.rs·history.rs 가
//!   종단으로 잰다. worktree 제거 본문은 worktree 종단 시험의 몫이다.

use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};

use dm_webserver_action as action;
use dm_webserver_apierr as apierr;
use dm_webserver_domain_git_core::{self as core, Ctx, Output, Service};
use dm_webserver_domain_git_jobs::StartOptions;
use dm_webserver_domain_git_query::{Operation, Status};
use dm_webserver_domain_git_store::{Store, StoreOptions};
use dm_webserver_domain_git_write as write;
use dm_webserver_domain_worktree::{self as worktree, Manager};
use serde_json::{Value, json};

use super::answers::repo as work_repo;
use super::harness::{q, qe, req};
use super::wfake::{WriteFake, fake_job_runner, job_done, wserver_with};
use crate::GitServer;
use crate::commit_ops::{CommitFacts, commit_op_answer};
use crate::job::job_succeeded;

pub(super) fn gives(id: &str, why: &str) -> bool {
    action::may_give(&action::catalog(), id, why)
}

/// Go `mapsEqualJSON`: 없음과 빈 객체는 같다.
pub(super) fn args_eq(a: &Value, b: &Value) -> bool {
    let empty = serde_json::Map::new();
    a.as_object().unwrap_or(&empty) == b.as_object().unwrap_or(&empty)
}

pub(super) async fn jreq(s: &Arc<GitServer>, method: &str, path: &str, body: &str) -> (u16, Value) {
    let r = req(s, method, path, body).await;
    (r.code, r.json())
}

/// Go `gtBranchRepo`: GT-2 의 판정 재료를 모두 가진 실제 저장소다.
///
/// main 은 현재 브랜치로 origin/main 을, feat 는 origin/feat 를 추적한다. lone 은 upstream 이
/// 없다. origin/other 를 추적하는 로컬은 없고, origin/dup 은 dupA·dupB 둘이 추적한다.
pub(super) struct BranchRepo {
    pub(super) s: Arc<GitServer>,
    pub(super) repo: String,
    pub(super) bare: std::path::PathBuf,
    pub(super) _tmp: dm_shared_gittest::TempDir,
}

pub(super) fn gt_git(dir: &Path, args: &[&str]) -> String {
    let mut all = vec!["-c", "user.name=t", "-c", "user.email=t@t"];
    all.extend_from_slice(args);
    dm_shared_gittest::run(dir, &all)
}

pub(super) fn gt_branch_repo() -> Option<BranchRepo> {
    dm_shared_gittest::path()?;
    let tmp = dm_shared_gittest::TempDir::new("dm-gitapi-actions-");
    let root = std::fs::canonicalize(tmp.path()).unwrap();
    let bare = root.join("remote.git");
    let repo = root.join("repo");
    let (b, r) = (bare.to_str().unwrap(), repo.to_str().unwrap());
    gt_git(&root, &["init", "-q", "--bare", b]);
    gt_git(&root, &["init", "-q", "-b", "main", r]);
    for args in [
        &["commit", "-q", "--allow-empty", "-m", "c1"][..],
        &["remote", "add", "origin", b],
        &["push", "-q", "-u", "origin", "main"],
        &["branch", "feat"],
        &["push", "-q", "-u", "origin", "feat"],
        &["branch", "lone"],
        &["push", "-q", "origin", "main:other"],
        &["push", "-q", "origin", "main:dup"],
        &["fetch", "-q", "origin"],
        &["branch", "dupA"],
        &["branch", "dupB"],
        &["branch", "-q", "--set-upstream-to=origin/dup", "dupA"],
        &["branch", "-q", "--set-upstream-to=origin/dup", "dupB"],
    ] {
        gt_git(&repo, args);
    }
    Some(BranchRepo {
        s: Arc::new(real_server(Service::new())),
        repo: r.to_owned(),
        bare,
        _tmp: tmp,
    })
}

fn real_server(svc: Service) -> GitServer {
    GitServer {
        git: Some(Store::new(Arc::new(svc), StoreOptions::default())),
        ..GitServer::default()
    }
}

/// 입력 답의 한 줄 (GV-c). 답 종단과 실행 종단에 같은 입력을 보낸다.
struct InputCase {
    name: &'static str,
    id: &'static str,
    query: Vec<(&'static str, String)>,
    exec_path: &'static str,
    exec_body: Value,
    why: &'static str,
}

fn input_case(
    name: &'static str,
    id: &'static str,
    query: &[(&'static str, &str)],
    exec_path: &'static str,
    exec_body: Value,
    why: &'static str,
) -> InputCase {
    InputCase {
        name,
        id,
        query: query.iter().map(|(k, v)| (*k, (*v).to_owned())).collect(),
        exec_path,
        exec_body,
        why,
    }
}

/// Go `inputAnswer`.
async fn input_answer(
    s: &Arc<GitServer>,
    repo: &str,
    id: &str,
    query: &[(&str, String)],
) -> (u16, Value) {
    let mut path = format!("/api/git/actions?action={}", qe(id));
    if !repo.is_empty() {
        path.push_str(&format!("&repo={}", qe(repo)));
    }
    for (k, v) in query {
        path.push_str(&format!("&{k}={}", qe(v)));
    }
    let (code, out) = jreq(s, "GET", &path, "").await;
    (code, out["actions"][id].clone())
}

/// Go `runInputCases` (TC-SDA-1 · GV-b): 답이 거짓이면 실행이 같은 코드·같은 args 로, 문구 없이
/// 거절된다. 답이 참이면 실행이 그 판정으로 거절되지 않는다.
async fn run_input_cases(s: &Arc<GitServer>, repo: &str, cases: Vec<InputCase>) {
    for c in cases {
        let name = c.name;
        let (code, ans) = input_answer(s, repo, c.id, &c.query).await;
        assert!(
            code == 200 && ans.is_object(),
            "{name}: 답 종단 = {code} {ans}"
        );
        let want_ok = c.why.is_empty();
        assert!(
            ans["ok"] == want_ok && (want_ok || ans["why"] == c.why),
            "{name}: 답 = {ans}, want ok={want_ok} why={:?}",
            c.why
        );
        if !want_ok {
            assert!(
                gives(c.id, c.why),
                "{name}: {} 의 목록에 {} 가 없다 (M-3)",
                c.id,
                c.why
            );
        }
        let mut body = c.exec_body;
        body["repo"] = json!(repo);
        let (code, out) = jreq(s, "POST", c.exec_path, &body.to_string()).await;
        if want_ok {
            assert!(
                code < 400,
                "{name}: 답은 참인데 실행이 거절됐다: {code} {out}"
            );
            // 잡을 여는 종단은 잡이 끝날 때까지 기다린다 (FR-FLK-11).
            if out.get("job").is_some_and(|j| !j.is_null()) {
                job_done(s, &out).await;
            }
            continue;
        }
        assert!(
            code >= 400 && out["error"] == c.why,
            "{name}: 실행 = {code} {}, want error {}",
            out["error"],
            c.why
        );
        assert!(
            args_eq(&out["args"], &ans["args"]),
            "{name}: 실행 args = {}, 답 args = {}",
            out["args"],
            ans["args"]
        );
        assert!(
            out.get("message").is_none(),
            "{name}: 서버가 문구를 실었다 (D-SDA-5): {}",
            out["message"]
        );
    }
}

// GV-e (G-B1): annotated·signed 는 메시지가 있어야 한다.
#[tokio::test]
async fn tag_create_input_answer() {
    let Some(g) = gt_branch_repo() else { return };
    // annotated 태그는 서버가 직접 만든다 — 신원이 없는 곳에서 실패하지 않게 저장소에 둔다.
    let rp = Path::new(&g.repo);
    dm_shared_gittest::run(rp, &["config", "user.name", "t"]);
    dm_shared_gittest::run(rp, &["config", "user.email", "t@t"]);
    let b = |name: &str, kind: &str, msg: &str| json!({"name": name, "kind": kind, "message": msg});
    let id = action::GIT_TAG_CREATE;
    let p = "/api/git/tag";
    run_input_cases(
        &g.s,
        &g.repo,
        vec![
            input_case(
                "annotated · 메시지 없음",
                id,
                &[("tagKind", "annotated"), ("message", "")],
                p,
                b("v1", "annotated", ""),
                apierr::CODE_TAG_MESSAGE_REQUIRED,
            ),
            input_case(
                "signed · 공백 메시지",
                id,
                &[("tagKind", "signed"), ("message", "  ")],
                p,
                b("v1", "signed", "  "),
                apierr::CODE_TAG_MESSAGE_REQUIRED,
            ),
            input_case(
                "모르는 종류",
                id,
                &[("tagKind", "heavy"), ("message", "m")],
                p,
                b("v1", "heavy", "m"),
                apierr::CODE_TAG_KIND_INVALID,
            ),
            input_case(
                "lightweight · 메시지 없음",
                id,
                &[("tagKind", ""), ("message", "")],
                p,
                b("v1", "", ""),
                "",
            ),
            input_case(
                "annotated · 메시지 있음",
                id,
                &[("tagKind", "annotated"), ("message", "rel")],
                p,
                b("v2", "annotated", "rel"),
                "",
            ),
        ],
    )
    .await;
}

// GV-f (G-B2 · FR-SDA-41): upstream 은 알려진 원격 ref 여야 한다 — 답 종단으로.
#[tokio::test]
async fn upstream_input_answer_endpoint() {
    let Some(g) = gt_branch_repo() else { return };
    let c = |name, branch: &str, up: &str, why| {
        input_case(
            name,
            action::GIT_BRANCH_UPSTREAM_SET,
            &[("branch", branch), ("upstream", up)],
            "/api/git/branch/upstream",
            json!({"branch": branch, "upstream": up}),
            why,
        )
    };
    run_input_cases(
        &g.s,
        &g.repo,
        vec![
            c(
                "원격 ref 에 설정",
                "origin/feat",
                "origin/main",
                apierr::CODE_NOT_LOCAL_BRANCH,
            ),
            c("빈 upstream", "lone", " ", apierr::CODE_EMPTY_REF),
            c(
                "모르는 원격 ref",
                "lone",
                "origin/nope",
                apierr::CODE_UPSTREAM_UNKNOWN,
            ),
            c(
                "로컬 브랜치를 upstream 으로",
                "lone",
                "main",
                apierr::CODE_UPSTREAM_UNKNOWN,
            ),
            c("알려진 원격 ref", "lone", "origin/other", ""),
        ],
    )
    .await;
}

// GV-c (G-B5): stash 에서 만들 브랜치의 이름.
#[tokio::test]
async fn stash_branch_input_answer() {
    let Some(g) = gt_branch_repo() else { return };
    let rp = Path::new(&g.repo);
    std::fs::write(rp.join("w.txt"), "x\n").unwrap();
    gt_git(rp, &["stash", "push", "-q", "-u"]);
    let oid = gt_git(rp, &["rev-parse", "stash@{0}"]);
    let c = |name, n: &str, why| {
        input_case(
            name,
            action::GIT_STASH_BRANCH,
            &[("name", n)],
            "/api/git/stash/branch",
            json!({"oid": oid, "name": n}),
            why,
        )
    };
    run_input_cases(
        &g.s,
        &g.repo,
        vec![
            c("빈 이름", "  ", apierr::CODE_EMPTY_NAME),
            c("규칙 위반", "a..b", apierr::CODE_REF_NAME),
            c("있는 이름", "main", apierr::CODE_BRANCH_EXISTS),
            c("새 이름", "from-stash", ""),
        ],
    )
    .await;
}

// GV-c (G-B3): worktree 의 이름·대상 ref·새 브랜치·이미 있는 자리.
#[tokio::test]
async fn worktree_create_input_answer() {
    let Some(r) = dm_shared_gittest::repo() else {
        return;
    };
    let repo = r.path().to_string_lossy().into_owned();
    let home = dm_shared_gittest::TempDir::new("dm-gitapi-wt-home-");
    let home_path = std::fs::canonicalize(home.path()).unwrap();
    let mgr = Arc::new(Manager::new(
        home_path.join("git-worktrees").to_str().unwrap(),
    ));
    let mut s = real_server(Service::new());
    s.user_worktrees = Some(mgr.clone());
    s.run_worktree_root = home_path.join("worktrees").to_string_lossy().into_owned();
    let s = Arc::new(s);
    dm_shared_gittest::run(r.path(), &["branch", "other"]);
    dm_shared_gittest::run(r.path(), &["branch", "taken"]);
    let bucket = worktree::repo_bucket(&repo);
    std::fs::create_dir_all(mgr.path(&bucket, "dup")).unwrap();
    let c = |name, n: &str, rf: &str, nb: bool, why| {
        input_case(
            name,
            action::GIT_WORKTREE_CREATE,
            &[
                ("name", n),
                ("ref", rf),
                ("newBranch", if nb { "1" } else { "0" }),
            ],
            "/api/git/worktrees/create",
            json!({"name": n, "ref": rf, "newBranch": nb}),
            why,
        )
    };
    run_input_cases(
        &s,
        &repo,
        vec![
            c("빈 이름", " ", "other", false, apierr::CODE_EMPTY_NAME),
            c(
                "- 로 시작하는 이름",
                "-x",
                "other",
                false,
                apierr::CODE_REF_NAME,
            ),
            c("빈 ref", "wt", "", false, apierr::CODE_EMPTY_REF),
            c(
                "이미 있는 자리",
                "dup",
                "other",
                false,
                apierr::CODE_WORKTREE_EXISTS,
            ),
            c(
                "새 브랜치가 이미 있음",
                "taken",
                "main",
                true,
                apierr::CODE_BRANCH_EXISTS,
            ),
            c("만들 수 있음", "wt", "other", false, ""),
        ],
    )
    .await;
    // 「만들 수 있음」 의 생성 잡이 끝난 뒤에 돌아온다 (FR-FLK-11).
    let made = Path::new(&mgr.path(&bucket, "wt")).join(".git");
    assert!(
        made.exists(),
        "생성 잡이 끝나지 않은 채 돌아왔다: {}",
        made.display()
    );
}

// GV-c (G-B4): 원격 추가의 이름·URL·이미 있는 이름 — 답 종단으로.
#[tokio::test]
async fn remote_add_input_answer_endpoint() {
    let Some(g) = gt_branch_repo() else { return };
    let c = |name, n: &str, u: &str, why| {
        input_case(
            name,
            action::GIT_REMOTE_ADD,
            &[("name", n), ("url", u)],
            "/api/git/remote/add",
            json!({"name": n, "url": u}),
            why,
        )
    };
    run_input_cases(
        &g.s,
        &g.repo,
        vec![
            c("빈 이름", "", "/tmp/x.git", apierr::CODE_EMPTY_NAME),
            c(
                "쓸 수 없는 글자",
                "a/b",
                "/tmp/x.git",
                apierr::CODE_REMOTE_NAME_INVALID,
            ),
            c("빈 URL", "up", " ", apierr::CODE_EMPTY_URL),
            c(
                "옵션 같은 URL",
                "up",
                "--upload-pack=x",
                apierr::CODE_REMOTE_URL_INVALID,
            ),
            c(
                "이미 있는 이름",
                "origin",
                "/tmp/x.git",
                apierr::CODE_REMOTE_EXISTS,
            ),
            c("더할 수 있음", "up", "/tmp/x.git", ""),
        ],
    )
    .await;
}

// GV-c (G-B6): 비교는 서버 실행 종단이 없다 — 답만 잰다.
#[tokio::test]
async fn compare_input_answer() {
    let Some(g) = gt_branch_repo() else { return };
    for (rev, path, why) in [
        (" ", "a.txt", apierr::CODE_EMPTY_REV),
        ("main", "", apierr::CODE_EMPTY_PATH),
        ("main..feat", "a.txt", ""),
    ] {
        let (code, ans) = input_answer(
            &g.s,
            &g.repo,
            action::GIT_COMPARE,
            &[("rev", rev.to_owned()), ("path", path.to_owned())],
        )
        .await;
        assert!(
            code == 200 && ans.is_object(),
            "{rev:?} {path:?}: 답 종단 = {code} {ans}"
        );
        assert!(
            ans["ok"] == why.is_empty() && (why.is_empty() || ans["why"] == why),
            "{rev:?} {path:?}: 답 = {ans}, want {why:?}"
        );
        if !why.is_empty() {
            assert!(gives(action::GIT_COMPARE, why), "목록에 {why} 가 없다");
        }
    }
}

// GV-c (G-B7): 저장소 추가는 repo 없이 묻는다. 실행(pin)도 같은 판정으로 거절된다.
#[tokio::test]
async fn repo_add_input_answer() {
    let Some(g) = gt_branch_repo() else { return };
    let plain = dm_shared_gittest::TempDir::new("dm-gitapi-plain-");
    let plain = std::fs::canonicalize(plain.path())
        .unwrap()
        .to_string_lossy()
        .into_owned();
    for (name, path, why) in [
        ("빈 경로", " ", apierr::CODE_EMPTY_PATH),
        ("상대 경로", "repo", apierr::CODE_ABS_PATH_NEEDED),
        ("저장소가 아님", plain.as_str(), apierr::CODE_NOT_REPO),
        ("저장소", g.repo.as_str(), ""),
    ] {
        let (code, ans) =
            input_answer(&g.s, "", action::GIT_REPO_ADD, &[("path", path.to_owned())]).await;
        assert!(
            code == 200 && ans.is_object(),
            "{name}: 답 종단 = {code} {ans}"
        );
        assert!(
            ans["ok"] == why.is_empty() && (why.is_empty() || ans["why"] == why),
            "{name}: 답 = {ans}, want {why:?}"
        );
        if why.is_empty() {
            continue;
        }
        assert!(
            gives(action::GIT_REPO_ADD, why),
            "{name}: 목록에 {why} 가 없다"
        );
        let (code, out) = jreq(
            &g.s,
            "POST",
            "/api/git/repos/pin",
            &json!({"path": path}).to_string(),
        )
        .await;
        assert!(
            code >= 400 && out["error"] == why,
            "{name}: 실행 = {code} {}, want {why}",
            out["error"]
        );
        assert!(
            out.get("message").is_none(),
            "{name}: 서버가 문구를 실었다 (D-SDA-5): {}",
            out["message"]
        );
    }
}

// ── handlers_git_actions_branch_test.go

async fn branch_menu_answers(s: &Arc<GitServer>, repo: &str, r: &str) -> (u16, Value) {
    let (code, out) = jreq(
        s,
        "GET",
        &format!(
            "/api/git/actions?repo={}&kind=branch&ref={}",
            qe(repo),
            qe(r)
        ),
        "",
    )
    .await;
    (code, out["actions"].clone())
}

// TC-SDA-1·6 (GT-d·e): 브랜치 메뉴의 답.
#[tokio::test]
async fn branch_menu_answers_table() {
    use action::*;
    let Some(g) = gt_branch_repo() else { return };
    let cases: [(&str, Vec<(&str, &str)>); 5] = [
        (
            "refs/heads/main",
            vec![
                (GIT_BRANCH_CHECKOUT, apierr::CODE_BRANCH_CURRENT),
                (GIT_BRANCH_MERGE, apierr::CODE_TARGET_IS_HEAD),
                (GIT_BRANCH_REBASE, apierr::CODE_TARGET_IS_HEAD),
                (GIT_BRANCH_DELETE, apierr::CODE_BRANCH_CURRENT),
                (GIT_BRANCH_RENAME, ""),
                (GIT_BRANCH_PUSH, ""),
                (GIT_BRANCH_UPSTREAM_UNSET, ""),
                (GIT_BRANCH_CHECKOUT_LOCAL, apierr::CODE_NOT_REMOTE_BRANCH),
                (GIT_BRANCH_FETCH, apierr::CODE_NOT_REMOTE_BRANCH),
                (GIT_BRANCH_DELETE_BOTH, apierr::CODE_BRANCH_CURRENT),
            ],
        ),
        (
            "refs/heads/lone",
            vec![
                (GIT_BRANCH_CHECKOUT, ""),
                (GIT_BRANCH_UPSTREAM_UNSET, apierr::CODE_NO_UPSTREAM),
                (GIT_BRANCH_DELETE_BOTH, apierr::CODE_NO_UPSTREAM),
                (GIT_BRANCH_MERGE, ""),
            ],
        ),
        (
            "refs/remotes/origin/feat",
            vec![
                (GIT_BRANCH_CHECKOUT, apierr::CODE_NOT_LOCAL_BRANCH),
                (GIT_BRANCH_RENAME, apierr::CODE_NOT_LOCAL_BRANCH),
                (GIT_BRANCH_PUSH, apierr::CODE_NOT_LOCAL_BRANCH),
                (GIT_BRANCH_UPSTREAM_SET, apierr::CODE_NOT_LOCAL_BRANCH),
                (GIT_BRANCH_CHECKOUT_LOCAL, ""),
                (GIT_BRANCH_FETCH, ""),
                (GIT_BRANCH_DELETE_REMOTE, ""),
                (GIT_BRANCH_DELETE_BOTH, ""),
            ],
        ),
        (
            "refs/remotes/origin/other",
            vec![(GIT_BRANCH_DELETE_BOTH, apierr::CODE_NO_TRACKING_BRANCH)],
        ),
        (
            "refs/remotes/origin/dup",
            vec![(GIT_BRANCH_DELETE_BOTH, apierr::CODE_MANY_TRACKING_BRANCH)],
        ),
    ];
    for (r, want) in cases {
        let (code, acts) = branch_menu_answers(&g.s, &g.repo, r).await;
        assert_eq!(code, 200, "{r}: 답 종단");
        for (id, why) in want {
            let a = &acts[id];
            assert!(a.is_object(), "{r}: {id} 의 답이 없다");
            assert!(
                a["ok"] == why.is_empty() && (why.is_empty() || a["why"] == why),
                "{r}: {id} = {a}, want why={why:?}"
            );
            if !why.is_empty() {
                assert!(
                    gives(id, why),
                    "{r}: {id} 가 동작 목록에 {why} 를 갖지 않는다"
                );
            }
        }
    }
    let (code, _) = branch_menu_answers(&g.s, &g.repo, "refs/heads/nope").await;
    assert_eq!(code, 404, "없는 ref");
}

// TC-SDA-1 (D-SDA-6 · D-SDA-3): 화면만 막던 것을 서버도 같은 코드로 거절한다.
#[tokio::test]
async fn branch_rejections() {
    let Some(g) = gt_branch_repo() else { return };
    let rq = q(&g.repo);
    let b = |rest: &str| format!(r#"{{"repo":{rq},{rest}}}"#);
    let cases = [
        (
            "현재 브랜치 checkout",
            "/api/git/checkout",
            b(r#""ref":"main""#),
            apierr::CODE_BRANCH_CURRENT,
        ),
        (
            "원격 ref checkout",
            "/api/git/checkout",
            b(r#""ref":"origin/feat""#),
            apierr::CODE_NOT_LOCAL_BRANCH,
        ),
        (
            "없는 원격을 track",
            "/api/git/checkout",
            b(r#""create":"x","track":"origin/nope""#),
            apierr::CODE_NOT_REMOTE_BRANCH,
        ),
        (
            "원격 rename",
            "/api/git/branch/rename",
            b(r#""from":"origin/feat","to":"x""#),
            apierr::CODE_NOT_LOCAL_BRANCH,
        ),
        (
            "upstream 없는데 해제",
            "/api/git/branch/upstream",
            b(r#""branch":"lone","unset":true"#),
            apierr::CODE_NO_UPSTREAM,
        ),
        (
            "원격 push",
            "/api/git/branch/push",
            b(r#""branch":"origin/feat""#),
            apierr::CODE_NOT_LOCAL_BRANCH,
        ),
        (
            "자기 자신 merge",
            "/api/git/branch/merge",
            b(r#""ref":"main""#),
            apierr::CODE_TARGET_IS_HEAD,
        ),
        (
            "없는 원격 fetch",
            "/api/git/branch/fetch",
            b(r#""remote":"origin","branch":"nope""#),
            apierr::CODE_NOT_REMOTE_BRANCH,
        ),
        (
            "짝이 여럿",
            "/api/git/branch/delete-both",
            b(r#""ref":"refs/remotes/origin/dup","confirm":true"#),
            apierr::CODE_MANY_TRACKING_BRANCH,
        ),
        (
            "짝 없음",
            "/api/git/branch/delete-both",
            b(r#""ref":"refs/heads/lone","confirm":true"#),
            apierr::CODE_NO_UPSTREAM,
        ),
    ];
    for (name, path, body, why) in cases {
        let (code, out) = jreq(&g.s, "POST", path, &body).await;
        assert!(
            out["error"] == why && code != 200,
            "{name}: = {code} {}, want {why}",
            out["error"]
        );
    }
}

fn branch_listed(dir: &Path, name: &str) -> bool {
    !gt_git(dir, &["branch", "--list", name]).trim().is_empty()
}

// GT-e: 양쪽 삭제는 확인을 요구하고, 로컬을 지운 뒤 원격 삭제 잡을 띄운다.
#[tokio::test]
async fn branch_delete_both() {
    let Some(g) = gt_branch_repo() else { return };
    let body = |extra: &str| {
        format!(
            r#"{{"repo":{},"ref":"refs/remotes/origin/feat"{extra}}}"#,
            q(&g.repo)
        )
    };
    let (code, out) = jreq(&g.s, "POST", "/api/git/branch/delete-both", &body("")).await;
    assert!(
        code == 400 && out["error"] == apierr::CODE_CONFIRM_REQUIRED,
        "확인 없이 = {code} {}, want 400 confirmation_required",
        out["error"]
    );
    let (code, out) = jreq(
        &g.s,
        "POST",
        "/api/git/branch/delete-both",
        &body(r#","confirm":true"#),
    )
    .await;
    assert!(
        code == 200 && !out["job"].is_null(),
        "= {code} {out}, want 200 {{job}}"
    );
    let jb = job_done(&g.s, &out).await;
    assert!(job_succeeded(&jb), "원격 삭제 잡이 실패했다: {jb:?}");
    for dir in [Path::new(&g.repo), g.bare.as_path()] {
        assert!(
            !branch_listed(dir, "feat"),
            "{} 에 feat 가 남았다",
            dir.display()
        );
    }
}

/// 실제 git 으로 쓰는 실행기다. 실패는 exit 1 의 출력으로 돌려준다 (Go 의 `ExecGit` 감싸기).
fn real_write(dir: &str, args: &[String]) -> Output {
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    match dm_shared_gittest::try_run(std::path::Path::new(dir), &args) {
        Ok(text) => Output {
            stdout: text.into_bytes(),
            ..Output::default()
        },
        Err(text) => Output {
            exit_code: 1,
            stderr: text,
            ..Output::default()
        },
    }
}

// TC-ATF-75 (AT-GAPI-5): 로컬을 지운 뒤 원격 잡 등록이 job_busy 로 거절되면, 그 거절 응답에 이미
// 적용된 로컬 삭제 결과(`deleted`)를 성공 응답과 같은 모양으로 싣는다.
#[tokio::test]
async fn branch_delete_both_job_busy_carries_local_deletion() {
    let Some(g) = gt_branch_repo() else { return };
    let release = Arc::new(tokio::sync::Semaphore::new(0));
    let me: Arc<OnceLock<Arc<GitServer>>> = Arc::default();
    let occupied = Arc::new(Mutex::new(false));
    let (me_w, occ) = (me.clone(), occupied.clone());
    let svc = Service::builder()
        .write_runner(Arc::new(
            move |_ctx, dir: String, args: Vec<String>, _stdin| {
                let (me, occ) = (me_w.clone(), occ.clone());
                Box::pin(async move {
                    let out = real_write(&dir, &args);
                    if out.exit_code == 0 && args.first().map(String::as_str) == Some("branch") {
                        // 로컬 삭제가 끝난 직후 common 칸을 다른 잡이 차지한다 — 앞선 칸 판정과 등록 사이의 끼어듦.
                        let first = !std::mem::replace(&mut *occ.lock().unwrap(), true);
                        if first {
                            let s = me.get().unwrap();
                            let git = s.git.clone().unwrap();
                            let keys = s.git_keys(&git, &Ctx::background(), &dir).await.unwrap();
                            s.jobs_hub(&git)
                                .start(
                                    &dir,
                                    keys,
                                    "fetch",
                                    write::fetch_spec(&write::FetchOpts::default()),
                                    StartOptions::default(),
                                )
                                .expect("칸 차지");
                        }
                    }
                    Ok::<_, core::Error>(out)
                })
            },
        ))
        .build();
    let mut s = real_server(svc);
    s.job_runner = Some(super::wfake::remote_hold(release.clone()));
    let s = Arc::new(s);
    me.set(s.clone()).ok().unwrap();
    let (code, out) = jreq(
        &s,
        "POST",
        "/api/git/branch/delete-both",
        &format!(
            r#"{{"repo":{},"ref":"refs/remotes/origin/feat","confirm":true}}"#,
            q(&g.repo)
        ),
    )
    .await;
    release.close();
    assert!(
        code == 409 && out["error"] == apierr::CODE_JOB_BUSY,
        "= {code} {out}, want 409 job_busy"
    );
    let names = out["deleted"]["names"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let oids = out["deleted"]["oids"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    assert!(
        names == [json!("feat")] && oids.len() == 1,
        "deleted = {}, want 로컬 삭제 계획 {{names:[feat], oids:[…]}}",
        out["deleted"]
    );
    assert!(
        !branch_listed(Path::new(&g.repo), "feat"),
        "로컬 feat 가 남았다"
    );
    assert!(
        branch_listed(&g.bare, "feat"),
        "거절된 원격 삭제가 실행됐다"
    );
}

// ── handlers_git_actions_target_test.go

// TC-SDA-1 (GT-c): 커밋 대상 판정의 표 시험.
#[test]
fn commit_target_answers() {
    use action::*;
    let head = "a".repeat(40);
    let b40 = "b".repeat(40);
    let st = Status {
        oid: head.clone(),
        ..Status::default()
    };
    let busy = Status {
        oid: head.clone(),
        operation: Operation {
            kind: "merge".to_owned(),
            ..Operation::default()
        },
        ..Status::default()
    };
    let facts = |oid: &str, parents: &[&str]| CommitFacts {
        oid: oid.to_owned(),
        parents: parents.iter().map(|p| (*p).to_owned()).collect(),
    };
    let one = facts(&b40, &["p"]);
    let at_head = facts(&head, &["p"]);
    let root = facts(&b40, &[]);
    let merge = facts(&b40, &["p", "q"]);
    let cases = [
        ("cherry-pick 보통", GIT_COMMIT_CHERRY_PICK, &st, &one, ""),
        (
            "cherry-pick HEAD",
            GIT_COMMIT_CHERRY_PICK,
            &st,
            &at_head,
            apierr::CODE_TARGET_IS_HEAD,
        ),
        (
            "reset HEAD",
            GIT_COMMIT_RESET,
            &st,
            &at_head,
            apierr::CODE_TARGET_IS_HEAD,
        ),
        ("revert HEAD 는 된다", GIT_COMMIT_REVERT, &st, &at_head, ""),
        (
            "drop 루트",
            GIT_COMMIT_DROP,
            &st,
            &root,
            apierr::CODE_ROOT_COMMIT,
        ),
        (
            "drop 머지",
            GIT_COMMIT_DROP,
            &st,
            &merge,
            apierr::CODE_MERGE_COMMIT,
        ),
        ("drop 보통", GIT_COMMIT_DROP, &st, &one, ""),
        (
            "진행 중이면 넷 다",
            GIT_COMMIT_REVERT,
            &busy,
            &one,
            apierr::CODE_OPERATION_IN_PROGRESS,
        ),
        (
            "진행 중이 대상보다 먼저",
            GIT_COMMIT_DROP,
            &busy,
            &root,
            apierr::CODE_OPERATION_IN_PROGRESS,
        ),
    ];
    for (name, id, st, c, why) in cases {
        let a = commit_op_answer(id, st, c);
        assert!(
            a.ok == why.is_empty() && a.why == why,
            "{name}: answer = {a:?}, want why={why:?}"
        );
        if !a.ok {
            assert!(
                gives(id, &a.why),
                "{name}: 사유 {:?} 가 {id} 의 목록에 없다",
                a.why
            );
        }
        if a.why == apierr::CODE_OPERATION_IN_PROGRESS {
            assert_eq!(
                a.args.as_ref().and_then(|m| m.get("kind")).cloned(),
                Some(json!("merge")),
                "{name}: args"
            );
        }
    }
}

/// Go `gitCoFake`: log 의 `%H %P` 와 rev-list 의 수를 답하고, 나머지는 `WriteFake` 로 넘긴다.
fn co_server(f: &WriteFake, oid: &str, parents: &str) -> Arc<GitServer> {
    let line = format!("{}\n", format!("{oid} {parents}").trim());
    let r = f.clone();
    let svc = Service::builder()
        .runner(Arc::new(move |_, dir: String, args: Vec<String>| {
            let (r, line) = (r.clone(), line.clone());
            Box::pin(async move {
                match args.first().map(String::as_str) {
                    Some("log") => Ok(super::wfake::out(line)),
                    Some("rev-list") => Ok(super::wfake::out("3\n".to_owned())),
                    _ => r.read(&dir, &args),
                }
            })
        }))
        .write_runner({
            let w = f.clone();
            Arc::new(move |ctx, _dir, args: Vec<String>, stdin: String| {
                let w = w.clone();
                Box::pin(async move { w.write(&ctx, &args, &stdin) })
            })
        })
        .build();
    let store = Store::new(Arc::new(svc), StoreOptions::default());
    wserver_with(f, |s| {
        s.git = Some(store);
        s.job_runner = Some(fake_job_runner(f));
    })
    .s
}

async fn commit_menu_answers(s: &Arc<GitServer>, oid: &str) -> Value {
    let (code, out) = jreq(
        s,
        "GET",
        &format!(
            "/api/git/actions?repo={}&kind=commit&oid={oid}",
            qe(&work_repo())
        ),
        "",
    )
    .await;
    assert_eq!(code, 200, "답 종단 = {out}");
    let acts = out["actions"].clone();
    for id in [
        action::GIT_COMMIT_CHERRY_PICK,
        action::GIT_COMMIT_REVERT,
        action::GIT_COMMIT_RESET,
        action::GIT_COMMIT_DROP,
    ] {
        assert!(acts[id].is_object(), "{id} 의 답이 없다: {acts}");
    }
    acts
}

// TC-SDA-1·6 (GT-a·c): 메뉴의 답과 실행 거절이 같다.
#[tokio::test]
async fn commit_menu_answer_matches_rejection() {
    let head = "a".repeat(40);
    let b40 = "b".repeat(40);
    let rq = q(&work_repo());
    let cases = [
        (
            "HEAD cherry-pick",
            head.clone(),
            "p1",
            "/api/git/cherry-pick",
            format!(r#"{{"repo":{rq},"oid":"{head}"}}"#),
            action::GIT_COMMIT_CHERRY_PICK,
            apierr::CODE_TARGET_IS_HEAD,
            false,
        ),
        (
            "HEAD reset",
            head.clone(),
            "p1",
            "/api/git/reset",
            format!(r#"{{"repo":{rq},"oid":"{head}"}}"#),
            action::GIT_COMMIT_RESET,
            apierr::CODE_TARGET_IS_HEAD,
            false,
        ),
        (
            "루트 drop",
            b40.clone(),
            "",
            "/api/git/drop",
            format!(r#"{{"repo":{rq},"oid":"bbb","confirm":true}}"#),
            action::GIT_COMMIT_DROP,
            apierr::CODE_ROOT_COMMIT,
            false,
        ),
        (
            "merge 중 revert",
            b40.clone(),
            "p1",
            "/api/git/revert",
            format!(r#"{{"repo":{rq},"oid":"bbb"}}"#),
            action::GIT_COMMIT_REVERT,
            apierr::CODE_OPERATION_IN_PROGRESS,
            true,
        ),
    ];
    for (name, oid, parents, path, body, id, why, merging) in cases {
        let f = WriteFake::new();
        if merging {
            std::fs::write(
                Path::new(&f.git_dir()).join("MERGE_HEAD"),
                format!("{head}\n"),
            )
            .unwrap();
        }
        let s = co_server(&f, &oid, parents);
        let acts = commit_menu_answers(&s, &oid).await;
        let a = &acts[id];
        assert!(
            a["ok"] == false && a["why"] == why,
            "{name}: 답 = {a}, want {why}"
        );
        let (code, out) = jreq(&s, "POST", path, &body).await;
        assert!(
            out["error"] == why && code != 200,
            "{name}: 실행 = {code} {}, want {why}",
            out["error"]
        );
        assert!(
            out.get("message").is_none(),
            "{name}: 서버가 문구를 실었다: {}",
            out["message"]
        );
        assert!(
            f.wrote().is_empty(),
            "{name}: 거절됐는데 실행됐다: {:?}",
            f.wrote()
        );
    }
}

// GT-a: 모르는 kind 는 400 이다.
#[tokio::test]
async fn target_actions_unknown_kind() {
    let f = WriteFake::new();
    let s = co_server(&f, &"b".repeat(40), "p1");
    let (code, out) = jreq(
        &s,
        "GET",
        &format!("/api/git/actions?repo={}&kind=nope", qe(&work_repo())),
        "",
    )
    .await;
    assert!(
        code == 400 && out["error"] == apierr::CODE_BAD_REQUEST,
        "= {code} {out}, want 400 bad_request"
    );
}
