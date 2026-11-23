//! Go `handlers_git_branch_test.go`·`handlers_git_validate_test.go`(branch 갈래) 의 이식.
//!
//! 옮기지 않은 것:
//! - `TestGitM5Routes_RegisteredAndUnavailable` 의 stash 갈래와 `TestAPIGitNameValidate_BodiesByteCompatible`
//!   의 tag 갈래 — `carryover.rs` 에 있다.
//! - gitM5Fake 의 stash list/show 응답·writeErr — 이 파일의 테스트가 쓰지 않는다(`stash.rs` 의 StashFake).

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::SystemTime;

use dm_webserver_apierr as apierr;
use dm_webserver_domain_git_core::{Output, Service};
use dm_webserver_domain_git_jobs::{JobRunner, LINE_STDERR};
use dm_webserver_domain_git_store::{Store, StoreOptions};
use dm_webserver_domain_git_write as write;
use serde_json::{Value, json};
use tempfile::TempDir;

use super::harness::{FakeBroker, FakePaneHub, FakeWorkspace, abs, q, qe, req};
use super::wfake::{req_await, write_status};
use crate::GitServer;

fn repo() -> String {
    abs(&["work", "repo"])
}

fn qrepo() -> String {
    q(&repo())
}

type OnWrite = Arc<dyn Fn(&mut M5State, &[String]) + Send + Sync>;

/// Go `gitM5Fake` 의 바꿀 수 있는 상태다.
struct M5State {
    status: String,
    branches: HashMap<String, bool>,
    remote_refs: HashMap<String, bool>,
    upstreams: HashMap<String, String>,
    unmerged: HashMap<String, bool>,
    config: String,
    rev_counts: HashMap<String, i64>,
    ref_checks: usize,
    writes: Vec<Vec<String>>,
    on_write: Option<OnWrite>,
}

/// Go `gitM5Fake`: 브랜치 표면이 딛는 읽기·쓰기를 함께 격리한다.
#[derive(Clone)]
struct M5Fake {
    st: Arc<Mutex<M5State>>,
    git_dir: Arc<TempDir>,
}

fn o(stdout: String) -> Output {
    Output {
        stdout: stdout.into_bytes(),
        ..Output::default()
    }
}

fn exit(code: i32, stderr: &str) -> Output {
    Output {
        exit_code: code,
        stderr: stderr.to_owned(),
        ..Output::default()
    }
}

/// Go `fakeCheckRefFormat`: 규칙 전체가 아니라 응답의 형태를 흉내 낸다.
fn fake_check_ref_format(name: &str) -> Output {
    if name.contains([' ', '~', '^', ':', '?', '*', '[', '\\'])
        || name.contains("..")
        || name.ends_with(".lock")
    {
        return exit(
            128,
            &format!("fatal: '{name}' is not a valid branch name\n"),
        );
    }
    o(format!("{name}\n"))
}

impl M5Fake {
    fn new() -> Self {
        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join("HEAD"), "ref: refs/heads/main\n").unwrap();
        M5Fake {
            st: Arc::new(Mutex::new(M5State {
                status: write_status("a.txt", "M."),
                branches: HashMap::from([("main".to_owned(), true)]),
                remote_refs: HashMap::new(),
                upstreams: HashMap::new(),
                unmerged: HashMap::new(),
                config: "remote.origin.url=/tmp/remote.git\n".to_owned(),
                rev_counts: HashMap::new(),
                ref_checks: 0,
                writes: Vec::new(),
                on_write: None,
            })),
            git_dir: Arc::new(dir),
        }
    }

    fn lock(&self) -> MutexGuard<'_, M5State> {
        self.st.lock().unwrap()
    }

    fn branch(&self, n: &str) {
        self.lock().branches.insert(n.to_owned(), true);
    }

    fn remote_ref(&self, n: &str) {
        self.lock().remote_refs.insert(n.to_owned(), true);
    }

    fn unmerged(&self, n: &str) {
        self.lock().unmerged.insert(n.to_owned(), true);
    }

    fn status_after_write(&self) {
        self.lock().on_write = Some(Arc::new(|st, _| st.status = write_status("b.txt", ".M")));
    }

    fn wrote(&self) -> Vec<Vec<String>> {
        self.lock().writes.clone()
    }

    fn ref_list(st: &M5State) -> String {
        let mut b = String::new();
        let mut line = |name: &str, up: &str, head: &str| {
            b.push_str(&format!(
                "{name}\0{}\0{up}\0\0{head}\0s\x000\n",
                "a".repeat(40)
            ));
        };
        let mut names: Vec<&String> = st.branches.keys().filter(|n| *n != "HEAD").collect();
        names.sort();
        for n in names {
            let head = if n == "main" { "*" } else { " " };
            let up = st.upstreams.get(n).cloned().unwrap_or_default();
            line(&format!("refs/heads/{n}"), &up, head);
        }
        let mut rs: Vec<&String> = st.remote_refs.keys().collect();
        rs.sort();
        for n in rs {
            line(&format!("refs/remotes/{n}"), "", " ");
        }
        b
    }

    fn read(&self, dir: &str, args: &[String]) -> Output {
        let a = |i: usize| args.get(i).map(String::as_str).unwrap_or_default();
        let mut st = self.lock();
        let not_found = || exit(128, "fatal: Needed a single revision\n");
        match a(0) {
            "rev-parse" if a(1) == "--show-toplevel" => o(format!("{dir}\n")),
            "rev-parse" if a(1) == "--verify" && a(2).starts_with("refs/remotes/") => {
                let short = a(2).trim_start_matches("refs/remotes/");
                if st.remote_refs.get(short).copied().unwrap_or(false) {
                    o(format!("{}\n", "b".repeat(40)))
                } else {
                    not_found()
                }
            }
            "rev-parse" if a(1) == "--verify" => {
                let name = a(2).trim_start_matches("refs/heads/");
                if st.branches.get(name).copied().unwrap_or(false) {
                    o(format!("{}\n", "a".repeat(40)))
                } else {
                    not_found()
                }
            }
            "rev-parse" => {
                let d = self.git_dir.path().to_string_lossy();
                o(format!("{d}\n{d}\n"))
            }
            "status" => o(st.status.clone()),
            "check-ref-format" => {
                st.ref_checks += 1;
                fake_check_ref_format(a(2))
            }
            "for-each-ref" if a(1).starts_with("--format=%(refname)") => o(Self::ref_list(&st)),
            "for-each-ref" => {
                let b = args.last().unwrap().trim_start_matches("refs/heads/");
                o(format!(
                    "{}\n",
                    st.upstreams.get(b).cloned().unwrap_or_default()
                ))
            }
            // exit 1 은 실패가 아니라 "조상이 아니다" 라는 답이다.
            "merge-base" if st.unmerged.get(a(2)).copied().unwrap_or(false) => exit(1, ""),
            "merge-base" => Output::default(),
            "rev-list" => o(format!(
                "{}\n",
                st.rev_counts
                    .get(args.last().unwrap())
                    .copied()
                    .unwrap_or(0)
            )),
            "config" => o(st.config.clone()),
            _ => Output::default(),
        }
    }

    fn write(&self, args: &[String]) -> Output {
        let mut st = self.lock();
        st.writes.push(args.to_vec());
        if let Some(f) = st.on_write.clone() {
            f(&mut st, args);
        }
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

    /// 잡 실행을 fake 쓰기로 넘긴다 (Go `fakeJobRunner(f.write)`).
    fn job_runner(&self) -> JobRunner {
        let f = self.clone();
        Arc::new(move |_, _, args, _, emit| {
            let f = f.clone();
            Box::pin(async move {
                let o = f.write(&args);
                if !o.stderr.is_empty() {
                    emit(LINE_STDERR, &o.stderr);
                }
                (o.exit_code, None)
            })
        })
    }
}

/// Go `gitM5Server`.
fn m5_server(f: &M5Fake) -> Arc<GitServer> {
    server_with(f, f.job_runner())
}

/// Go `gitBranchJobServer`: 잡 경로가 네트워크로 나가지 않게 실행기를 격리한다.
fn branch_job_server(f: &M5Fake) -> Arc<GitServer> {
    server_with(f, Arc::new(|_, _, _, _, _| Box::pin(async { (0, None) })))
}

fn server_with(f: &M5Fake, run: JobRunner) -> Arc<GitServer> {
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
        job_runner: Some(run),
        ..GitServer::default()
    })
}

/// Go `gitBranchJobArgv`: 즉시 응답에 실린 작업의 argv 다.
fn job_argv(out: &Value) -> String {
    let argv = out["job"]["argv"]
        .as_array()
        .unwrap_or_else(|| panic!("job 이 없다: {out}"));
    argv.iter()
        .map(|a| a.as_str().unwrap_or_default())
        .collect::<Vec<_>>()
        .join(" ")
}

fn hint_commands(s: &GitServer) -> Vec<String> {
    s.git
        .as_ref()
        .unwrap()
        .service()
        .hints(0)
        .into_iter()
        .map(|h| h.command)
        .collect()
}

async fn call(s: &Arc<GitServer>, method: &str, path: &str, body: &str) -> (u16, Value) {
    let r = req(s, method, path, body).await;
    (r.code, r.json())
}

fn argv(v: &[&str]) -> Vec<Vec<String>> {
    vec![v.iter().map(|s| (*s).to_owned()).collect()]
}

fn changes_len(out: &Value) -> usize {
    out["status"]["changes"].as_array().map_or(0, Vec::len)
}

async fn assert_registered_and_unavailable(eps: &[(&str, String, String)]) {
    let s = Arc::new(GitServer {
        tools: Some(Arc::new(FakePaneHub::default())),
        work: Some(Arc::new(FakeWorkspace::default())),
        ..GitServer::default()
    });
    for (method, path, body) in eps {
        let p = path.split('?').next().unwrap();
        assert!(
            dm_webserver_httproute::dispatch(&crate::routes::ROUTES, method, p).is_some(),
            "{method} {p} 가 gitapi.routes 에 없다"
        );
        let (code, out) = call(&s, method, path, body).await;
        assert_eq!(
            (code, out["error"].clone()),
            (503, json!(apierr::CODE_UNAVAILABLE)),
            "{method} {path}"
        );
    }
}

// M1: 라우트가 등록돼 있고, Git 이 없으면 전부 503 이다.
#[tokio::test]
async fn git_m5_routes_registered_and_unavailable() {
    let r = qrepo();
    assert_registered_and_unavailable(&[
        (
            "POST",
            "/api/git/checkout".to_owned(),
            format!(r#"{{"repo":{r},"ref":"main"}}"#),
        ),
        (
            "POST",
            "/api/git/branch".to_owned(),
            format!(r#"{{"repo":{r},"name":"feat"}}"#),
        ),
        (
            "GET",
            format!("/api/git/branch/validate?repo={}&name=feat", qe(&repo())),
            String::new(),
        ),
    ])
    .await;
}

// M2 (V55, FR-GIT-97·157, O14): force:true 는 confirm:true 없이 400 이고 실행되지 않는다.
#[tokio::test]
async fn api_git_checkout_force_requires_confirm() {
    let f = M5Fake::new();
    let s = m5_server(&f);
    let (code, out) = call(
        &s,
        "POST",
        "/api/git/checkout",
        &format!(r#"{{"repo":{},"ref":"main","force":true}}"#, qrepo()),
    )
    .await;
    assert_eq!(
        (code, out["error"].clone()),
        (400, json!(apierr::CODE_CONFIRM_REQUIRED))
    );
    assert!(f.wrote().is_empty(), "거부됐는데 실행됐다: {:?}", f.wrote());
}

// M3 (V55, FR-GIT-157): confirm 이 있으면 --force 가 붙는다.
#[tokio::test]
async fn api_git_checkout_force_with_confirm() {
    let f = M5Fake::new();
    f.status_after_write();
    let s = m5_server(&f);
    let (code, out) = req_await(
        &s,
        "POST",
        "/api/git/checkout",
        &format!(
            r#"{{"repo":{},"ref":"main","force":true,"confirm":true}}"#,
            qrepo()
        ),
    )
    .await;
    assert_eq!(code, 200, "{out}");
    assert_eq!(f.wrote(), argv(&["checkout", "--force", "main", "--"]));
    // 조작 후 상태가 응답에 있어야 한다 (FR-GIT-160).
    assert_eq!(changes_len(&out), 1, "실행 후 status 가 아니다: {out}");
}

// M4 (V54, FR-GIT-156): 원격 브랜치 checkout 이 같은 이름의 로컬과 부딪히면 409 + 선택지.
#[tokio::test]
async fn api_git_checkout_remote_branch_name_conflict() {
    let f = M5Fake::new();
    f.branch("feat");
    f.remote_ref("origin/feat");
    let s = m5_server(&f);
    let (code, out) = call(
        &s,
        "POST",
        "/api/git/checkout",
        &format!(
            r#"{{"repo":{},"create":"feat","track":"origin/feat"}}"#,
            qrepo()
        ),
    )
    .await;
    assert_eq!(
        (code, out["error"].clone()),
        (409, json!(apierr::CODE_BRANCH_EXISTS)),
        "{out}"
    );
    assert_eq!(
        (out["branch"].clone(), out["track"].clone()),
        (json!("feat"), json!("origin/feat"))
    );
    assert_eq!(
        out["options"].as_array().map_or(0, Vec::len),
        write::BRANCH_CONFLICT_OPTIONS.len(),
        "{out}"
    );
    assert!(f.wrote().is_empty(), "거부됐는데 실행됐다: {:?}", f.wrote());
}

// M5 (V54, FR-GIT-156): 부딪히지 않으면 로컬을 만들며 추적을 설정한다.
#[tokio::test]
async fn api_git_checkout_remote_branch_tracks() {
    let f = M5Fake::new();
    f.remote_ref("origin/feat");
    let s = m5_server(&f);
    let (code, out) = req_await(
        &s,
        "POST",
        "/api/git/checkout",
        &format!(
            r#"{{"repo":{},"create":"feat","track":"origin/feat"}}"#,
            qrepo()
        ),
    )
    .await;
    assert_eq!(code, 200, "{out}");
    assert_eq!(
        f.wrote(),
        argv(&["checkout", "-b", "feat", "--track", "origin/feat", "--"])
    );
}

// M6 (FR-GIT-159): 이름 규칙 위반과 잘못된 조합은 400 이며 실행되지 않는다.
#[tokio::test]
async fn api_git_branch_routes_reject_bad_requests() {
    let r = qrepo();
    let cases = [
        (
            "이름 규칙 위반 (생성)",
            "/api/git/branch",
            format!(r#"{{"repo":{r},"name":"bad name"}}"#),
            apierr::CODE_REF_NAME,
        ),
        (
            "이름 규칙 위반 (checkout)",
            "/api/git/checkout",
            format!(r#"{{"repo":{r},"create":"a..b"}}"#),
            apierr::CODE_REF_NAME,
        ),
        (
            "- 로 시작하는 ref",
            "/api/git/checkout",
            format!(r#"{{"repo":{r},"ref":"-x"}}"#),
            apierr::CODE_REF_NAME,
        ),
        (
            "대상 없음",
            "/api/git/checkout",
            format!(r#"{{"repo":{r}}}"#),
            apierr::CODE_BAD_REQUEST,
        ),
    ];
    for (name, path, body, want) in cases {
        let f = M5Fake::new();
        let s = m5_server(&f);
        let (code, out) = call(&s, "POST", path, &body).await;
        assert_eq!(
            (code, out["error"].clone()),
            (400, json!(want)),
            "{name}: {out}"
        );
        assert!(f.wrote().is_empty(), "{name}: 거부됐는데 실행됐다");
    }
}

// M7 (V68, FR-GIT-158·160): 생성은 checkout 여부로 명령이 갈리고, 응답에 조작 후 상태가 온다.
#[tokio::test]
async fn api_git_branch_create() {
    let r = qrepo();
    let cases: [(String, &[&str]); 3] = [
        (
            format!(r#"{{"repo":{r},"name":"feat"}}"#),
            &["branch", "feat"],
        ),
        (
            format!(r#"{{"repo":{r},"name":"feat","checkout":true}}"#),
            &["checkout", "-b", "feat"],
        ),
        (
            format!(r#"{{"repo":{r},"name":"feat","startRef":"abc123"}}"#),
            &["branch", "feat", "abc123"],
        ),
    ];
    for (body, want) in cases {
        let f = M5Fake::new();
        f.status_after_write();
        let s = m5_server(&f);
        let (code, out) = req_await(&s, "POST", "/api/git/branch", &body).await;
        assert_eq!(code, 200, "{want:?}: {out}");
        assert_eq!(f.wrote(), argv(want), "{want:?}");
        assert_eq!(
            changes_len(&out),
            1,
            "{want:?}: 실행 후 status 가 아니다: {out}"
        );
    }
}

// TC-ATF-3 (FR-ATF-3, AT-GAPI-6): 동기 생성·이름 변경의 이름 검증은 한 번만 돈다.
#[tokio::test]
async fn api_git_branch_name_checked_once() {
    let r = qrepo();
    for (path, body) in [
        (
            "/api/git/branch",
            format!(r#"{{"repo":{r},"name":"feat"}}"#),
        ),
        (
            "/api/git/branch/rename",
            format!(r#"{{"repo":{r},"from":"main","to":"feat"}}"#),
        ),
    ] {
        let f = M5Fake::new();
        let s = m5_server(&f);
        let (code, out) = call(&s, "POST", path, &body).await;
        assert_eq!(code, 200, "{path}: {out}");
        assert_eq!(f.lock().ref_checks, 1, "{path}: check-ref-format 횟수");
    }
    for (path, body) in [
        (
            "/api/git/branch",
            format!(r#"{{"repo":{r},"name":"main"}}"#),
        ),
        (
            "/api/git/branch/rename",
            format!(r#"{{"repo":{r},"from":"feat","to":"main"}}"#),
        ),
    ] {
        let f = M5Fake::new();
        f.branch("feat");
        let s = m5_server(&f);
        let (code, out) = call(&s, "POST", path, &body).await;
        assert_eq!(
            (code, out["error"].clone(), out["branch"].clone()),
            (409, json!(apierr::CODE_BRANCH_EXISTS), json!("main")),
            "{path} 충돌: {out}"
        );
        assert_eq!(
            out["options"].as_array().map_or(0, Vec::len),
            write::BRANCH_CONFLICT_OPTIONS.len(),
            "{path} 충돌: {out}"
        );
        assert!(f.wrote().is_empty(), "{path}: 충돌인데 실행됐다");
    }
}

fn validate_path(name: &str) -> String {
    format!(
        "/api/git/branch/validate?repo={}&name={}",
        qe(&repo()),
        name.replace(' ', "%20")
    )
}

// M8 (V68, FR-GIT-159): 이름 검사는 200 으로 판정만 돌려준다.
#[tokio::test]
async fn api_git_branch_validate() {
    let f = M5Fake::new();
    f.branch("taken");
    let s = m5_server(&f);
    for (name, ok) in [
        ("feat/a", true),
        ("bad name", false),
        ("x..y", false),
        ("-lead", false),
        ("", false),
    ] {
        let (code, out) = call(&s, "GET", &validate_path(name), "").await;
        assert_eq!(code, 200, "{name}: {out}");
        assert_eq!(out["ok"], json!(ok), "{name}: {out}");
        if !ok {
            assert_ne!(out["reason"], json!(""), "{name}: 사유가 비었다");
        }
    }
    // 이름이 이미 있는 것은 규칙 위반이 아니다 (FR-GIT-156).
    let (code, out) = call(&s, "GET", &validate_path("taken"), "").await;
    assert_eq!(
        (code, out["ok"].clone(), out["exists"].clone()),
        (200, json!(true), json!(true)),
        "{out}"
    );
}

// BA1: 묶음 B 라우트가 등록돼 있고, Git 이 없으면 전부 503 이다.
#[tokio::test]
async fn git_branch_action_routes_registered_and_unavailable() {
    let r = qrepo();
    let p = |s: &str| s.to_owned();
    assert_registered_and_unavailable(&[
        (
            "POST",
            p("/api/git/branch/rename"),
            format!(r#"{{"repo":{r},"from":"a","to":"b"}}"#),
        ),
        (
            "POST",
            p("/api/git/branch/delete"),
            format!(r#"{{"repo":{r},"names":["a"],"confirm":true}}"#),
        ),
        (
            "POST",
            p("/api/git/branch/merge"),
            format!(r#"{{"repo":{r},"ref":"side"}}"#),
        ),
        (
            "POST",
            p("/api/git/branch/rebase"),
            format!(r#"{{"repo":{r},"ref":"main","confirm":true}}"#),
        ),
        (
            "POST",
            p("/api/git/branch/upstream"),
            format!(r#"{{"repo":{r},"branch":"a","upstream":"origin/a"}}"#),
        ),
        (
            "GET",
            format!(
                "/api/git/branch/merge-preview?repo={}&ref=side",
                qe(&repo())
            ),
            String::new(),
        ),
        (
            "POST",
            p("/api/git/branch/push"),
            format!(r#"{{"repo":{r},"branch":"a"}}"#),
        ),
        (
            "POST",
            p("/api/git/branch/fetch"),
            format!(r#"{{"repo":{r},"remote":"origin","branch":"a"}}"#),
        ),
        (
            "POST",
            p("/api/git/branch/delete-remote"),
            format!(r#"{{"repo":{r},"remote":"origin","branch":"a","confirm":true}}"#),
        ),
    ])
    .await;
}

// BA2 (FR-GIT-89·254): 삭제는 confirm:true 없이 400 이고 실행되지 않는다.
#[tokio::test]
async fn api_git_branch_delete_requires_confirm() {
    let r = qrepo();
    for body in [
        format!(r#"{{"repo":{r},"names":["feat"]}}"#),
        format!(r#"{{"repo":{r},"names":["feat"],"force":true}}"#),
    ] {
        let f = M5Fake::new();
        f.branch("feat");
        let s = m5_server(&f);
        let (code, out) = call(&s, "POST", "/api/git/branch/delete", &body).await;
        assert_eq!(
            (code, out["error"].clone()),
            (400, json!(apierr::CODE_CONFIRM_REQUIRED)),
            "{body}"
        );
        assert!(f.wrote().is_empty(), "{body}: 확인 없이 실행됐다");
    }
}

// BA3 (FR-GIT-254): 현재 브랜치는 지울 수 없다 — 실행 전에 사유가 있는 409 로 답한다.
#[tokio::test]
async fn api_git_branch_delete_refuses_current_branch() {
    let f = M5Fake::new();
    let s = m5_server(&f);
    let (code, out) = call(
        &s,
        "POST",
        "/api/git/branch/delete",
        &format!(r#"{{"repo":{},"names":["main"],"confirm":true}}"#, qrepo()),
    )
    .await;
    assert_eq!(
        (code, out["error"].clone()),
        (409, json!(apierr::CODE_BRANCH_CURRENT)),
        "{out}"
    );
    assert!(f.wrote().is_empty(), "현재 브랜치인데 실행됐다");
}

// BA4 (FR-GIT-254 / V180): 미머지 브랜치의 -d 는 실패가 아니라 선택지다.
#[tokio::test]
async fn api_git_branch_delete_unmerged_offers_force() {
    let f = M5Fake::new();
    f.branch("feat");
    f.unmerged("feat");
    let s = m5_server(&f);
    let (code, out) = call(
        &s,
        "POST",
        "/api/git/branch/delete",
        &format!(r#"{{"repo":{},"names":["feat"],"confirm":true}}"#, qrepo()),
    )
    .await;
    assert_eq!(
        (code, out["error"].clone()),
        (409, json!(apierr::CODE_BRANCH_NOT_MERGED)),
        "{out}"
    );
    assert_eq!(
        (out["branch"].clone(), out["oid"].clone()),
        (json!("feat"), json!("a".repeat(40)))
    );
    let opts = out["options"].as_array().cloned().unwrap_or_default();
    assert!(
        opts.len() == write::BRANCH_DELETE_OPTIONS.len()
            && opts[0] == json!(write::BRANCH_DELETE_FORCE),
        "options = {opts:?}"
    );
    assert!(f.wrote().is_empty(), "선택지를 줘야 하는데 실행됐다");

    // -D 로 올리면 실행된다.
    let f2 = M5Fake::new();
    f2.branch("feat");
    f2.unmerged("feat");
    let s2 = m5_server(&f2);
    let (code, out) = call(
        &s2,
        "POST",
        "/api/git/branch/delete",
        &format!(
            r#"{{"repo":{},"names":["feat"],"force":true,"confirm":true}}"#,
            qrepo()
        ),
    )
    .await;
    assert_eq!((code, out["ok"].clone()), (200, json!(true)), "{out}");
    assert_eq!(f2.wrote(), argv(&["branch", "-D", "feat"]));
}

// BA5 (FR-GIT-254 / V181): 다중 삭제는 -D 를 제공하지 않는다.
#[tokio::test]
async fn api_git_branch_delete_bulk_is_soft_only() {
    let f = M5Fake::new();
    f.branch("a");
    f.branch("b");
    let s = m5_server(&f);
    let (code, out) = call(
        &s,
        "POST",
        "/api/git/branch/delete",
        &format!(
            r#"{{"repo":{},"names":["a","b"],"force":true,"confirm":true}}"#,
            qrepo()
        ),
    )
    .await;
    assert_eq!(
        (code, out["error"].clone()),
        (400, json!(apierr::CODE_BAD_REQUEST)),
        "{out}"
    );
    assert!(f.wrote().is_empty(), "일괄 강제 삭제가 실행됐다");

    // 미머지가 섞인 일괄 삭제의 선택지에도 -D 가 없다.
    let f2 = M5Fake::new();
    f2.branch("a");
    f2.branch("b");
    f2.unmerged("b");
    let s2 = m5_server(&f2);
    let (code, out) = call(
        &s2,
        "POST",
        "/api/git/branch/delete",
        &format!(r#"{{"repo":{},"names":["a","b"],"confirm":true}}"#, qrepo()),
    )
    .await;
    assert_eq!(
        (code, out["error"].clone()),
        (409, json!(apierr::CODE_BRANCH_NOT_MERGED)),
        "{out}"
    );
    let opts = out["options"].as_array().cloned().unwrap_or_default();
    assert!(
        !opts.contains(&json!(write::BRANCH_DELETE_FORCE)),
        "다중 삭제에 -D 선택지가 있다: {opts:?}"
    );
}

// BA6 (FR-GIT-250.2 / V179): 성공한 삭제는 지우기 전 oid 를 응답에 싣는다.
#[tokio::test]
async fn api_git_branch_delete_returns_pre_delete_oids() {
    let f = M5Fake::new();
    f.branch("feat");
    let s = m5_server(&f);
    let (code, out) = call(
        &s,
        "POST",
        "/api/git/branch/delete",
        &format!(r#"{{"repo":{},"names":["feat"],"confirm":true}}"#, qrepo()),
    )
    .await;
    assert_eq!((code, out["ok"].clone()), (200, json!(true)), "{out}");
    assert_eq!(f.wrote(), argv(&["branch", "-d", "feat"]));
    assert_eq!(
        out["deleted"]["oids"],
        json!(["a".repeat(40)]),
        "지우기 전 oid 가 없으면 되살릴 수 없다: {out}"
    );
    // hint 도 같은 값으로 남는다 (FR-GIT-92·93).
    assert_eq!(
        hint_commands(&s),
        vec![format!("git branch feat {}", "a".repeat(40))]
    );
}

// BA7 (FR-GIT-253 / V178): rename 은 -m 하나이고, 이미 있는 이름은 409 로 막힌다.
#[tokio::test]
async fn api_git_branch_rename() {
    let r = qrepo();
    let f = M5Fake::new();
    f.branch("feat");
    f.status_after_write();
    let s = m5_server(&f);
    let (code, out) = call(
        &s,
        "POST",
        "/api/git/branch/rename",
        &format!(r#"{{"repo":{r},"from":"feat","to":"feature"}}"#),
    )
    .await;
    assert_eq!((code, out["ok"].clone()), (200, json!(true)), "{out}");
    assert_eq!(f.wrote(), argv(&["branch", "-m", "feat", "feature"]));

    let f2 = M5Fake::new();
    f2.branch("feat");
    let s2 = m5_server(&f2);
    let (code, out) = call(
        &s2,
        "POST",
        "/api/git/branch/rename",
        &format!(r#"{{"repo":{r},"from":"feat","to":"main"}}"#),
    )
    .await;
    assert_eq!(
        (code, out["error"].clone()),
        (409, json!(apierr::CODE_BRANCH_EXISTS)),
        "{out}"
    );
    assert!(f2.wrote().is_empty(), "중복 이름인데 실행됐다");

    // 이름 규칙 위반과 같은 이름으로의 변경은 400 이며 실행되지 않는다.
    for body in [
        format!(r#"{{"repo":{r},"from":"feat","to":"bad name"}}"#),
        format!(r#"{{"repo":{r},"from":"feat","to":"feat"}}"#),
        format!(r#"{{"repo":{r},"from":"","to":"x"}}"#),
    ] {
        let f3 = M5Fake::new();
        f3.branch("feat");
        let s3 = m5_server(&f3);
        let (code, out) = call(&s3, "POST", "/api/git/branch/rename", &body).await;
        assert_eq!(code, 400, "{body}: {out}");
        assert!(f3.wrote().is_empty(), "{body}: 거부해야 하는데 실행됐다");
    }
}

// BA8 (FR-GIT-255): merge 의 방식이 argv 를 가른다. 모르는 방식은 실행 전에 400 이다.
#[tokio::test]
async fn api_git_branch_merge() {
    let r = qrepo();
    let cases: [(String, &[&str]); 4] = [
        (
            format!(r#"{{"repo":{r},"ref":"side"}}"#),
            &["merge", "side"],
        ),
        (
            format!(r#"{{"repo":{r},"ref":"side","mode":"ff-only"}}"#),
            &["merge", "--ff-only", "side"],
        ),
        (
            format!(r#"{{"repo":{r},"ref":"side","mode":"no-ff"}}"#),
            &["merge", "--no-ff", "side"],
        ),
        (
            format!(r#"{{"repo":{r},"ref":"side","mode":"squash"}}"#),
            &["merge", "--squash", "side"],
        ),
    ];
    for (body, want) in cases {
        let f = M5Fake::new();
        let s = m5_server(&f);
        let (code, out) = req_await(&s, "POST", "/api/git/branch/merge", &body).await;
        assert_eq!(
            (code, out["ok"].clone()),
            (200, json!(true)),
            "{body}: {out}"
        );
        assert_eq!(f.wrote(), argv(want), "{body}");
    }
    let f = M5Fake::new();
    let s = m5_server(&f);
    let (code, _) = req_await(
        &s,
        "POST",
        "/api/git/branch/merge",
        &format!(r#"{{"repo":{r},"ref":"side","mode":"octopus"}}"#),
    )
    .await;
    assert_eq!(code, 400);
    assert!(f.wrote().is_empty(), "모르는 방식인데 실행됐다");
}

// BA9 (FR-GIT-89·256 / V184): rebase 는 파괴적이므로 confirm 없이 실행되지 않는다.
#[tokio::test]
async fn api_git_branch_rebase_requires_confirm() {
    let r = qrepo();
    let f = M5Fake::new();
    let s = m5_server(&f);
    let (code, out) = req_await(
        &s,
        "POST",
        "/api/git/branch/rebase",
        &format!(r#"{{"repo":{r},"ref":"main"}}"#),
    )
    .await;
    assert_eq!(
        (code, out["error"].clone()),
        (400, json!(apierr::CODE_CONFIRM_REQUIRED)),
        "{out}"
    );
    assert!(f.wrote().is_empty(), "확인 없이 실행됐다");

    let f2 = M5Fake::new();
    let s2 = m5_server(&f2);
    let (code, out) = req_await(
        &s2,
        "POST",
        "/api/git/branch/rebase",
        &format!(r#"{{"repo":{r},"ref":"main","onto":"v1","confirm":true}}"#),
    )
    .await;
    assert_eq!((code, out["ok"].clone()), (200, json!(true)), "{out}");
    assert_eq!(f2.wrote(), argv(&["rebase", "--onto", "v1", "main"]));
    // hint 는 rebase 전 HEAD 로 되돌리는 명령이다 (FR-GIT-250.2).
    assert_eq!(
        hint_commands(&s2),
        vec![format!("git reset --hard {}", "a".repeat(40))]
    );
}

// BA10 (FR-GIT-257 / V185): set 과 unset 은 다른 argv 이며 대상 브랜치를 반드시 받는다.
#[tokio::test]
async fn api_git_branch_upstream() {
    let r = qrepo();
    let cases: [(String, &[&str]); 2] = [
        (
            format!(r#"{{"repo":{r},"branch":"feat","upstream":"origin/feat"}}"#),
            &["branch", "--set-upstream-to=origin/feat", "feat"],
        ),
        (
            format!(r#"{{"repo":{r},"branch":"feat","unset":true}}"#),
            &["branch", "--unset-upstream", "feat"],
        ),
    ];
    for (body, want) in cases {
        let f = M5Fake::new();
        f.branch("feat");
        // 해제는 upstream 이 있어야(GT-d), 설정은 알려진 원격 ref 여야(GV-f) 뜻이 있다.
        f.lock()
            .upstreams
            .insert("feat".to_owned(), "origin/feat".to_owned());
        f.remote_ref("origin/feat");
        let s = m5_server(&f);
        let (code, out) = call(&s, "POST", "/api/git/branch/upstream", &body).await;
        assert_eq!(
            (code, out["ok"].clone()),
            (200, json!(true)),
            "{body}: {out}"
        );
        assert_eq!(f.wrote(), argv(want), "{body}");
    }
    let f = M5Fake::new();
    let s = m5_server(&f);
    let (code, _) = call(
        &s,
        "POST",
        "/api/git/branch/upstream",
        &format!(r#"{{"repo":{r},"branch":"feat"}}"#),
    )
    .await;
    assert_eq!(code, 400, "set 인지 unset 인지 가릴 수 없다");
    assert!(f.wrote().is_empty(), "가릴 수 없는데 실행됐다");
}

// BA11 (FR-GIT-255 / V182): 영향 범위는 실행 전에 200 으로 답한다.
#[tokio::test]
async fn api_git_branch_merge_preview() {
    let path = |rf: &str| {
        format!(
            "/api/git/branch/merge-preview?repo={}&ref={rf}",
            qe(&repo())
        )
    };
    let f = M5Fake::new();
    f.lock().rev_counts.insert("HEAD..side".to_owned(), 3);
    f.lock().rev_counts.insert("side..HEAD".to_owned(), 0);
    let s = m5_server(&f);
    let (code, out) = call(&s, "GET", &path("side"), "").await;
    assert_eq!(code, 200, "{out}");
    let pv = &out["preview"];
    assert_eq!(
        (
            pv["ff"].clone(),
            pv["incoming"].clone(),
            pv["diverged"].clone()
        ),
        (json!(true), json!(3), json!(0)),
        "{pv}"
    );
    assert!(f.wrote().is_empty(), "조회가 쓰기 경로로 흘렀다");

    // 갈라져 있으면 ff 가 아니다.
    let f2 = M5Fake::new();
    f2.lock().rev_counts.insert("HEAD..side".to_owned(), 2);
    f2.lock().rev_counts.insert("side..HEAD".to_owned(), 1);
    f2.unmerged("HEAD");
    let s2 = m5_server(&f2);
    let (code, out) = call(&s2, "GET", &path("side"), "").await;
    assert_eq!(code, 200, "{out}");
    let pv = &out["preview"];
    assert_eq!(
        (pv["ff"].clone(), pv["diverged"].clone()),
        (json!(false), json!(1)),
        "{pv}"
    );

    // 옵션처럼 생긴 ref 는 400 이다.
    let (code, _) = call(&s, "GET", &path("-x"), "").await;
    assert_eq!(code, 400);
}

// BA12 (FR-GIT-258 / V186): upstream 이 없으면 publish 임을 실행 전에 알린다 — 계획을 함께 준다.
#[tokio::test]
async fn api_git_branch_push_publish_required() {
    let f = M5Fake::new();
    f.branch("feat");
    let s = branch_job_server(&f);
    let (code, out) = call(
        &s,
        "POST",
        "/api/git/branch/push",
        &format!(r#"{{"repo":{},"branch":"feat"}}"#, qrepo()),
    )
    .await;
    assert_eq!(
        (code, out["error"].clone()),
        (409, json!(apierr::CODE_PUBLISH_REQUIRED)),
        "{out}"
    );
    let plan = &out["plan"];
    assert_eq!(
        (
            plan["publish"].clone(),
            plan["remote"].clone(),
            plan["branch"].clone()
        ),
        (json!(true), json!("origin"), json!("feat")),
        "{plan}"
    );

    // 확인이 오면 job 이 뜬다.
    let (code, out) = call(
        &s,
        "POST",
        "/api/git/branch/push",
        &format!(r#"{{"repo":{},"branch":"feat","publish":true}}"#, qrepo()),
    )
    .await;
    assert_eq!(code, 200, "{out}");
    assert_eq!(job_argv(&out), "push --progress -u origin feat");
}

// BA13 (FR-GIT-268 / V195): 원격 브랜치 fetch·삭제. 삭제는 confirm 없이 실행되지 않고, hint 는 되살리는 push 다.
#[tokio::test]
async fn api_git_remote_branch_fetch_and_delete() {
    let r = qrepo();
    let f = M5Fake::new();
    f.remote_ref("origin/feat");
    let s = branch_job_server(&f);
    let (code, out) = call(
        &s,
        "POST",
        "/api/git/branch/fetch",
        &format!(r#"{{"repo":{r},"remote":"origin","branch":"feat"}}"#),
    )
    .await;
    assert_eq!(code, 200, "fetch: {out}");
    assert_eq!(job_argv(&out), "fetch --progress origin feat:feat");

    // 확인 없는 원격 ref 삭제는 400 이고 hint 도 남지 않는다.
    let f2 = M5Fake::new();
    f2.remote_ref("origin/feat");
    let s2 = branch_job_server(&f2);
    let (code, out) = call(
        &s2,
        "POST",
        "/api/git/branch/delete-remote",
        &format!(r#"{{"repo":{r},"remote":"origin","branch":"feat"}}"#),
    )
    .await;
    assert_eq!(
        (code, out["error"].clone()),
        (400, json!(apierr::CODE_CONFIRM_REQUIRED)),
        "{out}"
    );
    assert!(
        hint_commands(&s2).is_empty(),
        "실행하지 않았는데 hint 가 남았다"
    );

    let (code, out) = call(
        &s2,
        "POST",
        "/api/git/branch/delete-remote",
        &format!(r#"{{"repo":{r},"remote":"origin","branch":"feat","confirm":true}}"#),
    )
    .await;
    assert_eq!(code, 200, "{out}");
    assert_eq!(
        job_argv(&out),
        "push --progress origin --delete refs/heads/feat"
    );
    assert_eq!(
        hint_commands(&s2),
        vec![format!(
            "git push origin {}:refs/heads/feat",
            "b".repeat(40)
        )],
        "되살리는 push 가 없으면 지운 ref 를 돌려놓을 수 없다"
    );
}

// FR-OPT-7-5 (HTTP-12)·FR-OPT-0-3: branch 이름 검사 응답은 바이트 그대로다.
#[tokio::test]
async fn api_git_name_validate_bodies_byte_compatible() {
    let f = M5Fake::new();
    f.branch("taken");
    let s = m5_server(&f);
    let rj = qrepo();
    let cases = [
        (
            "feat/a",
            r#"{"exists":false,"ok":true,"reason":"","repo":R,"requested":{"name":"feat/a","repo":R}}"#,
        ),
        (
            "bad name",
            r#"{"exists":false,"ok":false,"reason":"ref_name_invalid: \"bad name\" 는 git 의 브랜치 이름 규칙을 어긴다","repo":R,"requested":{"name":"bad name","repo":R}}"#,
        ),
        (
            "-lead",
            r#"{"exists":false,"ok":false,"reason":"ref_name_invalid: name 는 - 로 시작할 수 없다: \"-lead\"","repo":R,"requested":{"name":"-lead","repo":R}}"#,
        ),
        (
            "taken",
            r#"{"exists":true,"ok":true,"reason":"","repo":R,"requested":{"name":"taken","repo":R}}"#,
        ),
    ];
    for (name, want) in cases {
        let path = format!(
            "/api/git/branch/validate?repo={}&name={}",
            qe(&repo()),
            qe(name)
        );
        let res = req(&s, "GET", &path, "").await;
        let want = want.replace('R', &rj);
        assert_eq!(res.code, 200, "branch/{name}");
        assert_eq!(res.text().trim_end_matches('\n'), want, "branch/{name}");
    }
}
