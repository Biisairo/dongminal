//! 5.4.1·5.4.2 가 5.4.3 종단(/api/git/actions·stash·tag·uncommitted·file-head)이 없어 미룬 갈래의
//! 이식이다. 출처:
//! - `handlers_git_actions_commit_test.go` TestCommitAnswerMatchesRejection 의 답 종단 절반
//! - `handlers_git_actions_test.go` TestStashCreateAnswerMatchesRejection·TestGitActionsUnknownAction
//! - `handlers_git_actions_facts_test.go` TestFactAnswers_MatchRejection
//! - `handlers_git_exclusion_test.go` TestExclusion_StashTakesCommonDirLock·
//!   TestIndexLocked_StashCarriesLock·TestRemoteRefDelete_NoHintWhenJobBusy 의 tag 갈래
//! - `handlers_git_branch_test.go` TestGitM5Routes_RegisteredAndUnavailable 의 stash 다섯 갈래
//! - `handlers_git_validate_test.go` TestAPIGitNameValidate_BodiesByteCompatible 의 tag 네 갈래
//! - `handlers_git_diff_limit_test.go` TestAPIGitFileHead_OverGitOutputCap (실제 git)
//! - `gitwrite_test.go` TestNilGitNeverPanics (종단 전부)
//!
//! Go 의 `gitM5Fake`·`gitTagFake` 대신 `WriteFake` 에 같은 응답을 얹어 쓴다.
//!
//! 옮기지 않은 것:
//! - `handlers_git_branch_test.go`·`handlers_git_remote_actions_test.go` 에 delete-both 시험은 없다.
//!   delete-both 는 `handlers_git_actions_branch_test.go` 의 것이라 actions.rs 에 있다.
//! - TestWriteLocks_CoverAllPostRoutes 의 반대 방향: write.rs 의 `write_locks_cover_post_routes` 가
//!   이미 두 방향을 다 본다.

use std::sync::Arc;
use std::time::Duration;

use dm_webserver_action as action;
use dm_webserver_apierr as apierr;
use dm_webserver_domain_git_core::{self as core, Ctx, Output, Service};
use dm_webserver_domain_git_jobs::Exclusion;
use dm_webserver_domain_git_store::{Store, StoreOptions};
use dm_webserver_domain_worktree::Manager;
use serde_json::{Value, json};

use super::actions::{args_eq, jreq};
use super::answers::repo;
use super::harness::{FakePaneHub, FakeWorkspace, q, qe, req};
use super::wfake::{WEnv, WriteFake, job_done, remote_hold, write_status, wserver, wserver_with};
use crate::GitServer;

fn rbody(rest: &str) -> String {
    format!(r#"{{"repo":{}{rest}}}"#, q(&repo()))
}

/// Go `gitCleanStatus`.
fn clean_status() -> String {
    format!("# branch.oid {}\0# branch.head main\0", "a".repeat(40))
}

/// Go `gitUntrackedStatus`: untracked 하나만 있다.
fn untracked_status() -> String {
    clean_status() + "? n.txt\0"
}

/// Go `gitInitialStatus`.
fn initial_status() -> String {
    "# branch.oid (initial)\0# branch.head main\0".to_owned()
}

fn status_env(status: String) -> WEnv {
    let f = WriteFake::new();
    f.lock().status = status;
    wserver(&f)
}

// TC-SDA-1 (D-SDA-6 · FR-SDA-23): 같은 입력에서 답이 거짓이면 실행이 같은 코드로 거절된다 — 답 종단.
#[tokio::test]
async fn commit_answer_matches_rejection_endpoint() {
    let cases = [
        (
            "빈 메시지",
            write_status("a.txt", "M."),
            " ",
            "",
            r#","message":" ""#,
            apierr::CODE_EMPTY_MESSAGE,
        ),
        (
            "staged 없음",
            write_status("a.txt", ".M"),
            "m",
            "",
            r#","message":"m""#,
            apierr::CODE_NOTHING_STAGED,
        ),
        (
            "staged 있음",
            write_status("a.txt", "M."),
            "m",
            "",
            r#","message":"m""#,
            "",
        ),
        (
            "all",
            write_status("a.txt", ".M"),
            "m",
            "&all=1",
            r#","message":"m","all":true"#,
            "",
        ),
    ];
    for (name, status, msg, flags, rest, why) in cases {
        let e = status_env(status);
        let path = format!(
            "/api/git/actions?repo={}&action={}&message={}{flags}",
            qe(&repo()),
            action::GIT_COMMIT,
            qe(msg)
        );
        let (code, out) = jreq(&e.s, "GET", &path, "").await;
        assert_eq!(code, 200, "{name}: 답 종단 = {out}");
        let a = &out["actions"][action::GIT_COMMIT];
        assert!(
            a.is_object() && a["ok"] == why.is_empty() && (why.is_empty() || a["why"] == why),
            "{name}: 답 = {a}, want why={why:?}"
        );
        let (code, out) = jreq(&e.s, "POST", "/api/git/commit", &rbody(rest)).await;
        if why.is_empty() {
            assert_eq!(code, 200, "{name}: 답은 참인데 실행이 거절됐다: {out}");
            job_done(&e.s, &out).await;
            continue;
        }
        assert_eq!(out["error"], why, "{name}: 실행 = {code} {out}");
        assert!(
            out.get("message").is_none(),
            "{name}: 서버가 문구를 실었다 (D-SDA-5): {out}"
        );
    }
}

// TC-SDA-1 (FR-SDA-3 · D-SDA-6): 같은 입력에서 답이 거짓이면 실행이 같은 코드로 거절된다. 답이
// 참이면 실행이 거절되지 않는다.
#[tokio::test]
async fn stash_create_answer_matches_rejection() {
    let cases = [
        (
            "변경 없음",
            clean_status(),
            false,
            apierr::CODE_NOTHING_TO_STASH,
        ),
        (
            "untracked 만 · -u 끔",
            untracked_status(),
            false,
            apierr::CODE_UNTRACKED_ONLY,
        ),
        ("untracked 만 · -u 켬", untracked_status(), true, ""),
    ];
    for (name, status, untracked, why) in cases {
        let e = status_env(status);
        let (flag, body) = if untracked {
            ("1", rbody(r#","includeUntracked":true"#))
        } else {
            ("0", rbody(""))
        };
        let path = format!(
            "/api/git/actions?repo={}&action={}&includeUntracked={flag}",
            qe(&repo()),
            action::GIT_STASH_CREATE
        );
        let (code, out) = jreq(&e.s, "GET", &path, "").await;
        assert_eq!(code, 200, "{name}: 답 종단 = {out}");
        let ans = out["actions"][action::GIT_STASH_CREATE].clone();
        assert!(ans.is_object(), "{name}: 답이 없다: {out}");
        let want_ok = why.is_empty();
        assert!(
            ans["ok"] == want_ok && (want_ok || ans["why"] == why),
            "{name}: 답 = {ans}, want ok={want_ok} why={why:?}"
        );
        let (code, out) = jreq(&e.s, "POST", "/api/git/stash/push", &body).await;
        if want_ok {
            assert_ne!(code, 409, "{name}: 답은 참인데 실행이 거절됐다: {out}");
            continue;
        }
        assert!(
            code == 409 && out["error"] == why,
            "{name}: 실행 = {code} {}, want 409 {why}",
            out["error"]
        );
        assert!(
            args_eq(&out["args"], &ans["args"]),
            "{name}: 실행 args = {}, 답 args = {} — 같아야 한다",
            out["args"],
            ans["args"]
        );
        assert!(
            out.get("message").is_none(),
            "{name}: 서버가 문구를 실었다 (D-SDA-5): {out}"
        );
        assert!(
            e.f.wrote().is_empty(),
            "{name}: 거부됐는데 실행됐다: {:?}",
            e.f.wrote()
        );
    }
}

// M-5: 모르는 동작은 400 이다 — 답 없음을 "허용" 으로 읽게 두지 않는다.
#[tokio::test]
async fn git_actions_unknown_action() {
    let e = wserver(&WriteFake::new());
    let (code, out) = jreq(
        &e.s,
        "GET",
        &format!("/api/git/actions?repo={}&action=git.no_such", qe(&repo())),
        "",
    )
    .await;
    assert!(
        code == 400 && out["error"] == apierr::CODE_BAD_REQUEST,
        "code = {code}, error = {}, want 400 bad_request",
        out["error"]
    );
}

// TC-SDA-1 (D-SDA-6): 1층 답이 거짓이면 실행이 같은 코드로, 문구 없이 거절된다.
#[tokio::test]
async fn fact_answers_match_rejection() {
    let cases = [
        (
            "clean",
            clean_status(),
            action::GIT_UNCOMMITTED_CLEAN,
            "/api/git/uncommitted/clean",
            rbody(r#","confirm":true,"paths":["u.txt"]"#),
        ),
        (
            "reset",
            initial_status(),
            action::GIT_UNCOMMITTED_RESET,
            "/api/git/uncommitted/reset",
            rbody(""),
        ),
        (
            "stash",
            clean_status(),
            action::GIT_STASH_NEW,
            "/api/git/stash/push",
            rbody(r#","includeUntracked":true"#),
        ),
    ];
    for (name, status, id, path, body) in cases {
        let e = status_env(status);
        let (_, acts) = super::answers::status_actions(&e.s, "").await;
        let a = &acts[id];
        let (code, out) = jreq(&e.s, "POST", path, &body).await;
        assert!(
            a["ok"] == false && code == 409 && out["error"] == a["why"],
            "{name}: 답 {a} · 실행 {code} {} — 같은 코드로 거절돼야 한다",
            out["error"]
        );
        assert!(
            out.get("message").is_none(),
            "{name}: 서버가 문구를 실었다 (D-SDA-5): {out}"
        );
        assert!(
            e.f.wrote().is_empty(),
            "{name}: 실행됐다: {:?}",
            e.f.wrote()
        );
    }
}

// ── handlers_git_exclusion_test.go

const WAIT: Duration = Duration::from_millis(80);

struct XEnv {
    e: WEnv,
    x: Exclusion,
    release: Arc<tokio::sync::Semaphore>,
}

impl Drop for XEnv {
    fn drop(&mut self) {
        self.release.close();
    }
}

/// Go `exclServer`.
fn excl_server(f: &WriteFake) -> XEnv {
    let x = Exclusion::new();
    let release = Arc::new(tokio::sync::Semaphore::new(0));
    let (xc, rc) = (x.clone(), release.clone());
    let e = wserver_with(f, move |s| {
        s.exclusion = Some(xc);
        s.lock_wait = WAIT;
        s.job_runner = Some(remote_hold(rc));
    });
    XEnv { e, x, release }
}

// §5.3·5.4: stash 는 common-dir 잠금을 먼저 쥔다 — 같은 common dir 의 다른 worktree 가 stash
// 중이면 repo_busy.
#[tokio::test]
async fn exclusion_stash_takes_common_dir_lock() {
    let f = WriteFake::new();
    let x = excl_server(&f);
    let rel =
        x.x.lock_common(
            &Ctx::background(),
            &core::exclusion_key(&f.git_dir()),
            Duration::from_secs(1),
        )
        .await
        .unwrap();
    let (code, out) = jreq(&x.e.s, "POST", "/api/git/stash/push", &rbody("")).await;
    assert!(
        code == 409 && out["error"] == apierr::CODE_REPO_BUSY,
        "stash push = {code} {out}, want 409 repo_busy"
    );
    // 동기 쓰기(stage)는 common-dir 잠금을 보지 않는다.
    let (code, out) = jreq(
        &x.e.s,
        "POST",
        "/api/git/stage",
        &rbody(r#","paths":["a.txt"]"#),
    )
    .await;
    assert_eq!(code, 200, "stage = {out}");
    rel.release();
}

// §7.2: stash 실패도 index.lock 판정을 거친다.
#[tokio::test]
async fn index_locked_stash_carries_lock() {
    let f = WriteFake::new();
    let lock = std::path::Path::new(&f.git_dir()).join("index.lock");
    let stderr = format!(
        "fatal: Unable to create '{}': File exists.\n",
        lock.display()
    );
    f.lock().write_err = Some(Arc::new(move |_| {
        Ok(Output {
            exit_code: 128,
            stderr: stderr.clone(),
            ..Output::default()
        })
    }));
    let x = excl_server(&f);
    let (code, out) = jreq(&x.e.s, "POST", "/api/git/stash/push", &rbody("")).await;
    assert!(
        code == 409 && out["error"] == apierr::CODE_INDEX_LOCKED && out["lock"].is_object(),
        "= {code} {out}, want 409 index_locked + lock"
    );
}

/// Go `fakeCheckRefFormatNormalize`: 규칙 전체가 아니라 응답의 형태를 흉내 낸다. 실측대로 exit 1 +
/// 출력 없음이다.
fn check_ref_format_normalize(full: &str) -> Output {
    let bad = full.contains([' ', '~', '^', ':', '?', '*', '[', '\\'])
        || full.contains("..")
        || full.ends_with(".lock");
    if bad {
        return Output {
            exit_code: 1,
            ..Output::default()
        };
    }
    Output {
        stdout: format!("{}\n", full.replace("//", "/")).into_bytes(),
        ..Output::default()
    }
}

/// Go `gitTagFake`·`gitTagServer`: 태그 v1.0 하나와 origin 원격을 답하고, 나머지는 `WriteFake` 다.
fn tag_server(f: &WriteFake, edit: impl FnOnce(&mut GitServer)) -> Arc<GitServer> {
    let r = f.clone();
    let w = f.clone();
    let svc = Service::builder()
        .runner(Arc::new(move |_, dir: String, args: Vec<String>| {
            let r = r.clone();
            Box::pin(async move {
                let a = |i: usize| args.get(i).map(String::as_str).unwrap_or_default();
                match a(0) {
                    "rev-parse" if args.len() > 2 && a(1) == "--verify" => {
                        let name = a(2).strip_prefix("refs/tags/").unwrap_or(a(2));
                        if name == "v1.0" {
                            return Ok(super::wfake::out(format!("{}\n", "b".repeat(40))));
                        }
                        Ok(Output {
                            exit_code: 128,
                            stderr: "fatal: Needed a single revision\n".to_owned(),
                            ..Output::default()
                        })
                    }
                    "config" => Ok(super::wfake::out(
                        "remote.origin.url=/tmp/remote.git\n".to_owned(),
                    )),
                    "check-ref-format" => Ok(check_ref_format_normalize(a(2))),
                    _ => r.read(&dir, &args),
                }
            })
        }))
        .write_runner(Arc::new(
            move |ctx, _dir, args: Vec<String>, stdin: String| {
                let w = w.clone();
                Box::pin(async move { w.write(&ctx, &args, &stdin) })
            },
        ))
        .build();
    let store = Store::new(Arc::new(svc), StoreOptions::default());
    wserver_with(f, |s| {
        s.git = Some(store);
        edit(s);
    })
    .s
}

// FR-OPT-1-3 (DOM-6): 잡 등록이 실패하면(job_busy) 원격 태그 삭제의 hint 를 남기지 않는다. branch
// 갈래는 exclusion.rs 에 있다.
#[tokio::test]
async fn remote_ref_delete_no_hint_when_job_busy_tag() {
    let release = Arc::new(tokio::sync::Semaphore::new(0));
    let rc = release.clone();
    let s = tag_server(&WriteFake::new(), move |s| {
        s.job_runner = Some(remote_hold(rc))
    });
    let body = rbody(r#","name":"v1.0","confirm":true"#);
    let (code, out) = jreq(&s, "POST", "/api/git/tag/delete-remote", &body).await;
    assert_eq!(code, 200, "첫 삭제: {out}");
    let (code, out) = jreq(&s, "POST", "/api/git/tag/delete-remote", &body).await;
    assert!(
        code == 409 && out["error"] == apierr::CODE_JOB_BUSY,
        "둘째 삭제 = {code} {out}, want 409 job_busy"
    );
    let hints = s.git.as_ref().unwrap().service().hints(0);
    assert_eq!(
        hints.len(),
        1,
        "등록되지 않은 잡의 hint 가 남았다: {hints:?}"
    );
    release.close();
}

// ── handlers_git_validate_test.go (FR-OPT-7-5 · FR-OPT-0-3): tag 이름 검사의 본문은 바이트 그대로다.
#[tokio::test]
async fn tag_name_validate_bodies_byte_compatible() {
    let s = tag_server(&WriteFake::new(), |_| {});
    let rq = q(&repo());
    let kinds = r#""kinds":["","annotated","signed"],"#;
    let cases = [
        (
            "v9.0",
            format!(
                r#"{{"exists":false,{kinds}"ok":true,"reason":"","repo":R,"requested":{{"name":"v9.0","repo":R}}}}"#
            ),
        ),
        (
            "v1.0",
            format!(
                r#"{{"exists":true,{kinds}"ok":true,"reason":"","repo":R,"requested":{{"name":"v1.0","repo":R}}}}"#
            ),
        ),
        (
            "bad name",
            format!(
                r#"{{"exists":false,{kinds}"ok":false,"reason":"ref_name_invalid: \"bad name\" 는 git 의 태그 이름 규칙을 어긴다","repo":R,"requested":{{"name":"bad name","repo":R}}}}"#
            ),
        ),
        (
            "-x",
            format!(
                r#"{{"exists":false,{kinds}"ok":false,"reason":"ref_name_invalid: name 는 - 로 시작할 수 없다: \"-x\"","repo":R,"requested":{{"name":"-x","repo":R}}}}"#
            ),
        ),
    ];
    for (name, want) in cases {
        let r = req(
            &s,
            "GET",
            &format!(
                "/api/git/tag/validate?repo={}&name={}",
                qe(&repo()),
                qe(name)
            ),
            "",
        )
        .await;
        let want = want.replace('R', &rq);
        let got = r.text();
        assert!(
            r.code == 200 && got.trim_end_matches('\n') == want,
            "{name}: code={}\n got {got}\nwant {want}",
            r.code
        );
    }
}

// ── handlers_git_branch_test.go M1: stash 라우트가 등록돼 있고, Git 이 없으면 전부 503 이다.
#[tokio::test]
async fn git_m5_stash_routes_registered_and_unavailable() {
    let s = Arc::new(GitServer {
        tools: Some(Arc::new(FakePaneHub::default())),
        work: Some(Arc::new(FakeWorkspace::default())),
        ..GitServer::default()
    });
    let rq = qe(&repo());
    let eps = [
        ("GET", format!("/api/git/stash?repo={rq}"), String::new()),
        (
            "GET",
            format!("/api/git/stash/show?repo={rq}&index=0"),
            String::new(),
        ),
        ("POST", "/api/git/stash/push".to_owned(), rbody("")),
        (
            "POST",
            "/api/git/stash/apply".to_owned(),
            rbody(r#","index":0"#),
        ),
        (
            "POST",
            "/api/git/stash/pop".to_owned(),
            rbody(r#","index":0"#),
        ),
        (
            "POST",
            "/api/git/stash/drop".to_owned(),
            rbody(r#","index":0,"confirm":true"#),
        ),
    ];
    for (method, path, body) in eps {
        let p = path.split('?').next().unwrap();
        assert!(
            dm_webserver_httproute::dispatch(&crate::routes::ROUTES, method, p).is_some(),
            "{method} {p} 가 gitapi.routes 에 없다"
        );
        let (code, out) = jreq(&s, method, &path, &body).await;
        assert_eq!(
            (code, out["error"].clone()),
            (503, json!(apierr::CODE_UNAVAILABLE)),
            "{method} {path}"
        );
    }
}

// ── handlers_git_diff_limit_test.go (FR-OPT-15-1): HEAD 판을 편집기로 여는 경로(FR-GIT-274)도 편집기
// 상한이다. 공용 Service 의 출력 상한(1 MiB)을 넘는 파일로 본다. 실제 git 을 쓴다.
#[tokio::test]
async fn file_head_over_git_output_cap() {
    let Some(r) = dm_shared_gittest::repo() else {
        return;
    };
    let p = r.path();
    let size = core::DEFAULT_MAX_OUTPUT + 1;
    std::fs::write(p.join("mid.txt"), "m".repeat(size)).unwrap();
    dm_shared_gittest::run(p, &["add", "mid.txt"]);
    dm_shared_gittest::run(p, &["commit", "-qm", "mid.txt"]);
    let s = Arc::new(GitServer {
        git: Some(Store::new(
            Arc::new(Service::new()),
            StoreOptions::default(),
        )),
        ..GitServer::default()
    });
    let (code, out) = jreq(
        &s,
        "GET",
        &format!(
            "/api/git/file-head?repo={}&path=mid.txt",
            qe(&p.to_string_lossy())
        ),
        "",
    )
    .await;
    assert_eq!(code, 200, "{out}");
    let open = out["openPath"].as_str().unwrap_or_default();
    let got = std::fs::metadata(open).map(|m| m.len());
    assert_eq!(got.ok(), Some(size as u64), "열 사본 = {open:?}");
}

// ── gitwrite_test.go: Git 이 없는 배선에서 모든 git 종단이 503 이다 — 어느 것도 패닉하지 않고, 응답은
// 정확히 하나다 (FR-DPN-24).
#[tokio::test]
async fn nil_git_never_panics() {
    let home = dm_shared_gittest::TempDir::new("dm-gitapi-nilgit-");
    // worktree 관리자만 있고 Git 이 없는 조합이 문제였던 자리다.
    let s = Arc::new(GitServer {
        user_worktrees: Some(Arc::new(Manager::new(home.path().to_str().unwrap()))),
        ..GitServer::default()
    });
    let probes = [
        ("GET", "/api/git/worktrees?repo=/tmp/x", ""),
        ("GET", "/api/git/status?repo=/tmp/x", ""),
        ("GET", "/api/git/log?repo=/tmp/x", ""),
        ("GET", "/api/git/refs?repo=/tmp/x", ""),
        ("GET", "/api/git/blame?repo=/tmp/x&path=a", ""),
        ("GET", "/api/git/stash?repo=/tmp/x", ""),
        ("GET", "/api/git/policy?repo=/tmp/x", ""),
        ("GET", "/api/git/records?repo=/tmp/x", ""),
        ("GET", "/api/git/preflight?repo=/tmp/x", ""),
        ("GET", "/api/git/signature?repo=/tmp/x", ""),
        ("GET", "/api/git/remotes?repo=/tmp/x", ""),
        ("GET", "/api/git/hunks?repo=/tmp/x&path=a", ""),
        ("GET", "/api/git/repos", ""),
        (
            "POST",
            "/api/git/commit",
            r#"{"repo":"/tmp/x","message":"m"}"#,
        ),
        (
            "POST",
            "/api/git/stage",
            r#"{"repo":"/tmp/x","paths":["a"]}"#,
        ),
        (
            "POST",
            "/api/git/discard",
            r#"{"repo":"/tmp/x","confirm":true}"#,
        ),
        ("POST", "/api/git/branch", r#"{"repo":"/tmp/x","name":"b"}"#),
        ("POST", "/api/git/tag", r#"{"repo":"/tmp/x","name":"v1"}"#),
        (
            "POST",
            "/api/git/checkout",
            r#"{"repo":"/tmp/x","ref":"main"}"#,
        ),
        ("POST", "/api/git/fetch", r#"{"repo":"/tmp/x"}"#),
        (
            "POST",
            "/api/git/reset",
            r#"{"repo":"/tmp/x","oid":"abc","mode":"soft"}"#,
        ),
        (
            "POST",
            "/api/git/worktrees/create",
            r#"{"repo":"/tmp/x","name":"wt","ref":"main"}"#,
        ),
        (
            "POST",
            "/api/git/worktrees/remove",
            r#"{"repo":"/tmp/x","path":"/tmp/wt","confirm":true}"#,
        ),
    ];
    for (method, path, body) in probes {
        let r = req(&s, method, path, body).await;
        let text = r.text();
        assert_eq!(
            text.matches(r#""error""#).count(),
            1,
            "{method} {path}: 응답이 정확히 1개여야 한다: {text}"
        );
        let out: Value = r.json();
        assert_eq!(r.code, 503, "{method} {path}: 본문 {text}");
        let code = out["error"].as_str().unwrap_or_default();
        // worktree 표면은 자기 사유를 낸다.
        assert!(
            code == apierr::CODE_UNAVAILABLE || code.contains("worktree"),
            "{method} {path}: 코드 {code:?} — git_unavailable 도 worktree 사유도 아니다"
        );
    }
}
