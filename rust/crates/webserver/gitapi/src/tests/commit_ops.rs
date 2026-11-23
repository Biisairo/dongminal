//! Go `handlers_git_commit_ops_test.go` 의 이식과, `handlers_git_actions_facts_test.go` 중
//! /api/git/uncommitted/{reset,clean} 실행 종단 갈래.
//!
//! 옮기지 않은 것:
//! - `handlers_git_actions_facts_test.go` 의 `TestFactAnswers`·`TestStatusActions_Facts`·
//!   `TestFactAnswers_SlotFirst`: 판정 함수·status actions 답 쪽이다(answers.rs·exclusion.rs 몫).
//! - `TestFactAnswers_MatchRejection` 의 stash 갈래: 실행 종단이 /api/git/stash/push 다(stash.rs 몫).
//!   clean·reset 갈래만 옮긴다.

use std::sync::{Arc, Mutex, MutexGuard};
use std::time::SystemTime;

use dm_webserver_action as action;
use dm_webserver_apierr as apierr;
use dm_webserver_domain_git_core::{Output, Service};
use dm_webserver_domain_git_jobs::JobRunner;
use dm_webserver_domain_git_store::{Store, StoreOptions};
use serde_json::{Value, json};
use tempfile::TempDir;

use super::answers::status_actions;
use super::harness::{FakeBroker, FakePaneHub, FakeWorkspace, abs, q, qe, req};
use super::wfake::{WriteFake, req_await, write_status, wserver};
use crate::GitServer;

fn repo() -> String {
    abs(&["work", "repo"])
}

fn body(rest: &str) -> String {
    format!(r#"{{"repo":{}{rest}}}"#, q(&repo()))
}

fn o(stdout: String) -> Output {
    Output {
        stdout: stdout.into_bytes(),
        ..Output::default()
    }
}

struct CoState {
    /// log --format=%H %P 의 첫 칸 — 대상의 전체 oid.
    oid: String,
    /// 그 뒤 칸들 (공백으로 나뉜 부모 oid).
    parents: String,
    /// rev-list --count 의 stdout.
    count: String,
    writes: Vec<Vec<String>>,
}

/// Go `gitCoFake`: 커밋 동작이 딛는 읽기·쓰기를 함께 격리한다. 머지 여부 판정이
/// `log --format=%H %P` 를 보므로 부모를 심을 수 있어야 한다.
#[derive(Clone)]
struct CoFake {
    st: Arc<Mutex<CoState>>,
    git_dir: Arc<TempDir>,
}

impl CoFake {
    /// 기본은 부모 하나인 보통 커밋이다.
    fn new() -> Self {
        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join("HEAD"), "ref: refs/heads/main\n").unwrap();
        CoFake {
            st: Arc::new(Mutex::new(CoState {
                oid: "b".repeat(40),
                parents: "p1".to_owned(),
                count: "3\n".to_owned(),
                writes: Vec::new(),
            })),
            git_dir: Arc::new(dir),
        }
    }

    fn lock(&self) -> MutexGuard<'_, CoState> {
        self.st.lock().unwrap()
    }

    fn merge(self) -> Self {
        self.lock().parents = "p1 p2".to_owned();
        self
    }

    fn wrote(&self) -> Vec<Vec<String>> {
        self.lock().writes.clone()
    }

    fn read(&self, dir: &str, args: &[String]) -> Output {
        let st = self.lock();
        let a = |i: usize| args.get(i).map(String::as_str).unwrap_or_default();
        let gd = self.git_dir.path().to_string_lossy().into_owned();
        match a(0) {
            "rev-parse" if a(1) == "--show-toplevel" => o(format!("{dir}\n")),
            // git rev-parse A...B → A, B, ^merge-base
            "rev-parse" if args.len() > 1 && a(args.len() - 1).contains("...") => {
                o("aaa\nbbb\n^base0\n".to_owned())
            }
            "rev-parse" if a(1) == "--verify" => o(format!("{}\n", "c".repeat(40))),
            "rev-parse" => o(format!("{gd}\n{gd}\n")),
            "status" => o(write_status("a.txt", "M.")),
            "log" => o(format!("{}\n", format!("{} {}", st.oid, st.parents).trim())),
            "rev-list" => o(st.count.clone()),
            _ => Output::default(),
        }
    }

    fn write(&self, args: &[String]) -> Output {
        self.lock().writes.push(args.to_vec());
        Output::default()
    }

    fn service(&self) -> Service {
        let (r, w) = (self.clone(), self.clone());
        Service::builder()
            .runner(Arc::new(move |_, dir: String, args: Vec<String>| {
                let r = r.clone();
                Box::pin(async move { Ok(r.read(&dir, &args)) })
            }))
            .write_runner(Arc::new(move |_, _, args: Vec<String>, _| {
                let w = w.clone();
                Box::pin(async move { Ok(w.write(&args)) })
            }))
            .build()
    }

    /// Go `fakeJobRunner(f.write)`.
    fn job_runner(&self) -> JobRunner {
        let f = self.clone();
        Arc::new(move |_, _, args, _, _| {
            let f = f.clone();
            Box::pin(async move { (f.write(&args).exit_code, None) })
        })
    }
}

/// Go `gitCoServer`.
fn co_server(f: &CoFake) -> Arc<GitServer> {
    let at = SystemTime::now();
    let store = Store::new(
        Arc::new(f.service()),
        StoreOptions::default().clock(Arc::new(move || at)),
    );
    Arc::new(GitServer {
        git: Some(store),
        work: Some(Arc::new(FakeWorkspace::default())),
        commands: Some(Arc::new(FakeBroker::default())),
        tools: Some(Arc::new(FakePaneHub::default())),
        job_runner: Some(f.job_runner()),
        ..GitServer::default()
    })
}

async fn call(s: &Arc<GitServer>, method: &str, path: &str, b: &str) -> (u16, Value) {
    let r = req(s, method, path, b).await;
    (r.code, r.json())
}

fn joined(w: &[Vec<String>]) -> Vec<String> {
    w.iter().map(|a| a.join(" ")).collect()
}

fn range_url(rest: &str) -> String {
    format!("/api/git/commit-range?repo={}{rest}", qe(&repo()))
}

// D-API1: 5개 라우트가 gitapi.routes 에 등록돼 있고, Git 이 없으면 전부 503 이다.
#[tokio::test]
async fn git_commit_ops_routes_registered_and_unavailable() {
    let s = Arc::new(GitServer {
        tools: Some(Arc::new(FakePaneHub::default())),
        work: Some(Arc::new(FakeWorkspace::default())),
        ..GitServer::default()
    });
    let eps = [
        (
            "POST",
            "/api/git/cherry-pick".to_owned(),
            body(r#","oid":"abc123""#),
        ),
        (
            "POST",
            "/api/git/revert".to_owned(),
            body(r#","oid":"abc123""#),
        ),
        (
            "POST",
            "/api/git/reset".to_owned(),
            body(r#","oid":"abc123""#),
        ),
        (
            "POST",
            "/api/git/drop".to_owned(),
            body(r#","oid":"abc123","confirm":true"#),
        ),
        ("GET", range_url("&from=abc123&to=HEAD"), String::new()),
    ];
    for (method, path, b) in eps {
        let p = path.split('?').next().unwrap();
        assert!(
            dm_webserver_httproute::dispatch(&crate::routes::ROUTES, method, p).is_some(),
            "{method} {p} 가 gitapi.routes 에 없다"
        );
        let (code, out) = call(&s, method, &path, &b).await;
        assert_eq!(
            (code, out["error"].clone()),
            (503, json!(apierr::CODE_UNAVAILABLE)),
            "{method} {path}"
        );
    }
}

// D-API2 (V191, FR-GIT-263·264): 머지 커밋의 cherry-pick·revert 는 부모 번호 없이 실행되지 않는다.
#[tokio::test]
async fn api_git_pick_merge_requires_mainline() {
    for path in ["/api/git/cherry-pick", "/api/git/revert"] {
        let f = CoFake::new().merge();
        let s = co_server(&f);
        let (code, out) = call(&s, "POST", path, &body(r#","oid":"abc123""#)).await;
        assert_eq!(
            (code, out["error"].clone()),
            (400, json!(apierr::CODE_MERGE_PARENT)),
            "{path}: {out}"
        );
        assert!(
            f.wrote().is_empty(),
            "{path}: 부모 없이 실행됐다: {:?}",
            f.wrote()
        );
        // 400 은 부모를 고를 수 있게 부모 목록을 함께 준다.
        assert_eq!(
            out["parents"].as_array().map_or(0, Vec::len),
            2,
            "{path}: 부모 목록이 응답에 없다: {out}"
        );
    }
}

// D-API3 (V191): 부모 번호를 주면 그대로 argv 에 실려 실행된다.
#[tokio::test]
async fn api_git_pick_mainline_reaches_argv() {
    let f = CoFake::new().merge();
    let s = co_server(&f);
    let (code, out) = req_await(
        &s,
        "POST",
        "/api/git/cherry-pick",
        &body(r#","oid":"abc123","mainline":2"#),
    )
    .await;
    assert_eq!(code, 200, "{out}");
    assert_eq!(joined(&f.wrote()), vec!["cherry-pick -m 2 abc123"]);
}

// D-API4 (FR-GIT-264): `--no-commit` 은 revert 의 옵션이고 cherry-pick 에는 없다.
#[tokio::test]
async fn api_git_revert_no_commit_option() {
    let f = CoFake::new();
    let s = co_server(&f);
    let b = body(r#","oid":"abc123","noCommit":true"#);
    let (code, out) = req_await(&s, "POST", "/api/git/revert", &b).await;
    assert_eq!(code, 200, "{out}");
    assert_eq!(joined(&f.wrote()), vec!["revert --no-commit abc123"]);

    let f2 = CoFake::new();
    let s2 = co_server(&f2);
    let (code, out) = req_await(&s2, "POST", "/api/git/cherry-pick", &b).await;
    assert_eq!(code, 400, "cherry-pick 의 --no-commit: {out}");
    assert!(
        f2.wrote().is_empty(),
        "거부해야 하는데 실행됐다: {:?}",
        f2.wrote()
    );
}

// D-API5 (V192, FR-GIT-89·265): `--hard` 는 `confirm:true` 없이 400 이고 실행되지 않는다.
// soft·mixed 는 확인을 요구하지 않는다.
#[tokio::test]
async fn api_git_reset_hard_requires_confirm() {
    let f = CoFake::new();
    let s = co_server(&f);
    let (code, out) = call(
        &s,
        "POST",
        "/api/git/reset",
        &body(r#","oid":"abc123","mode":"hard""#),
    )
    .await;
    assert_eq!(
        (code, out["error"].clone()),
        (400, json!(apierr::CODE_CONFIRM_REQUIRED)),
        "{out}"
    );
    assert!(f.wrote().is_empty(), "확인 없이 실행됐다: {:?}", f.wrote());

    for mode in ["", "mixed", "soft"] {
        let f2 = CoFake::new();
        let s2 = co_server(&f2);
        let (code, out) = call(
            &s2,
            "POST",
            "/api/git/reset",
            &body(&format!(r#","oid":"abc123","mode":{}"#, q(mode))),
        )
        .await;
        assert_eq!(code, 200, "mode={mode:?}: {out}");
        assert_eq!(f2.wrote().len(), 1, "mode={mode:?}: 실행되지 않았다");
    }
}

// D-API6 (V192): 확인을 거친 `--hard` 는 argv 에 그대로 실린다.
#[tokio::test]
async fn api_git_reset_hard_argv() {
    let f = CoFake::new();
    let s = co_server(&f);
    let (code, out) = call(
        &s,
        "POST",
        "/api/git/reset",
        &body(r#","oid":"abc123","mode":"hard","confirm":true"#),
    )
    .await;
    assert_eq!(code, 200, "{out}");
    assert_eq!(joined(&f.wrote()), vec!["reset --hard abc123"]);
}

// D-API7 (FR-GIT-265): 모르는 모드는 실행 전에 400 이다.
#[tokio::test]
async fn api_git_reset_unknown_mode_rejected() {
    let f = CoFake::new();
    let s = co_server(&f);
    let (code, out) = call(
        &s,
        "POST",
        "/api/git/reset",
        &body(r#","oid":"abc123","mode":"keep","confirm":true"#),
    )
    .await;
    assert_eq!(code, 400, "{out}");
    assert!(
        f.wrote().is_empty(),
        "거부해야 하는데 실행됐다: {:?}",
        f.wrote()
    );
}

// D-API8 (V193, FR-GIT-266): drop 은 `confirm:true` 없이 실행되지 않고, argv 는
// `rebase --onto <oid>^ <oid>` 다.
#[tokio::test]
async fn api_git_drop_confirm_and_argv() {
    let f = CoFake::new();
    let s = co_server(&f);
    let (code, out) = req_await(&s, "POST", "/api/git/drop", &body(r#","oid":"abc123""#)).await;
    assert_eq!(
        (code, out["error"].clone()),
        (400, json!(apierr::CODE_CONFIRM_REQUIRED)),
        "{out}"
    );
    assert!(f.wrote().is_empty(), "확인 없이 실행됐다: {:?}", f.wrote());

    let f2 = CoFake::new();
    let s2 = co_server(&f2);
    let (code, out) = req_await(
        &s2,
        "POST",
        "/api/git/drop",
        &body(r#","oid":"abc123","confirm":true"#),
    )
    .await;
    assert_eq!(code, 200, "{out}");
    assert_eq!(joined(&f2.wrote()), vec!["rebase --onto abc123^ abc123"]);
}

// D-API9 (FR-GIT-266): 머지 커밋은 `<oid>^` 로 뺄 수 없다. 실행 전에 거부한다.
#[tokio::test]
async fn api_git_drop_merge_refused() {
    let f = CoFake::new().merge();
    let s = co_server(&f);
    let (code, out) = call(
        &s,
        "POST",
        "/api/git/drop",
        &body(r#","oid":"abc123","confirm":true"#),
    )
    .await;
    assert_eq!(code, 400, "{out}");
    assert!(
        f.wrote().is_empty(),
        "거부해야 하는데 실행됐다: {:?}",
        f.wrote()
    );
}

// D-API10 (V192, FR-GIT-265): 다이얼로그가 보일 영향 커밋 수를 준다.
#[tokio::test]
async fn api_git_commit_range_count() {
    let f = CoFake::new();
    f.lock().count = "7\n".to_owned();
    let s = co_server(&f);
    let (code, out) = call(&s, "GET", &range_url("&from=abc123&to=HEAD"), "").await;
    assert_eq!(code, 200, "{out}");
    assert_eq!(out["count"], json!(7), "{out}");
}

// D-API11 (V194, FR-GIT-267): `A...B` 는 merge-base 를 왼쪽으로 잡는다.
#[tokio::test]
async fn api_git_commit_range_symmetric_uses_merge_base() {
    let f = CoFake::new();
    let s = co_server(&f);
    let (code, out) = call(&s, "GET", &range_url("&from=aaa&to=bbb&symmetric=1"), "").await;
    assert_eq!(code, 200, "{out}");
    assert_eq!(out["from"], json!("base0"), "{out}");
}

// D-API12 (FR-GIT-250.3): 옵션처럼 생긴 리비전은 실행 전에 거부된다.
#[tokio::test]
async fn api_git_commit_range_rejects_unsafe_rev() {
    let f = CoFake::new();
    let s = co_server(&f);
    let (code, out) = call(&s, "GET", &range_url("&from=--all&to=HEAD"), "").await;
    assert_eq!(code, 400, "{out}");
}

// TC-SDA-1 (D-SDA-6): 답이 거짓이면 실행이 같은 코드로, 문구 없이 거절된다
// (Go `TestFactAnswers_MatchRejection` 의 clean·reset 갈래).
#[tokio::test]
async fn fact_answers_match_rejection() {
    let clean = format!("# branch.oid {}\0# branch.head main\0", "a".repeat(40));
    let initial = "# branch.oid (initial)\0# branch.head main\0".to_owned();
    let cases = [
        (
            "clean",
            clean,
            action::GIT_UNCOMMITTED_CLEAN,
            "/api/git/uncommitted/clean",
            body(r#","confirm":true,"paths":["u.txt"]"#),
        ),
        (
            "reset",
            initial,
            action::GIT_UNCOMMITTED_RESET,
            "/api/git/uncommitted/reset",
            body(""),
        ),
    ];
    for (name, status, id, path, b) in cases {
        let f = WriteFake::new();
        f.lock().status = status;
        let e = wserver(&f);
        let (_, acts) = status_actions(&e.s, "").await;
        let a = acts[id].clone();
        let (code, out) = call(&e.s, "POST", path, &b).await;
        assert!(
            a["ok"] == json!(false) && code == 409 && out["error"] == a["why"],
            "{name}: 답 {a} · 실행 {code} {out} — 같은 코드로 거절돼야 한다"
        );
        assert!(
            out.get("message").is_none(),
            "{name}: 서버가 문구를 실었다 (D-SDA-5): {out}"
        );
        assert!(f.wrote().is_empty(), "{name}: 실행됐다: {:?}", f.wrote());
    }
}
