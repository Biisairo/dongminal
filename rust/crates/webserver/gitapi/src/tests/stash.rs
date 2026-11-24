//! Go `handlers_git_stash_test.go` 의 이식. 이 파일의 `StashFake`(Go `gitM5Fake` 중 stash·브랜치
//! 갈래)는 `ignore.rs` 도 쓴다.
//!
//! 옮기지 않은 Go 테스트: 없다 (11개 전부 옮겼다).

use std::collections::HashSet;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::SystemTime;

use otter_webserver_apierr as apierr;
use otter_webserver_domain_git_core::{self as core, Output, Service};
use otter_webserver_domain_git_jobs::{JobRunner, LINE_STDERR};
use otter_webserver_domain_git_store::{Store, StoreOptions};
use serde_json::Value;
use tempfile::TempDir;

use super::harness::{FakeBroker, FakePaneHub, FakeWorkspace, abs, q, qe, req};
use super::wfake::write_status;
use crate::GitServer;

pub(super) fn repo() -> String {
    abs(&["work", "repo"])
}

pub(super) fn qrepo() -> String {
    q(&repo())
}

pub(super) fn stash_a() -> String {
    "a".repeat(40)
}

pub(super) fn stash_b() -> String {
    "b".repeat(40)
}

/// Go `gitStashOut`: 꼬리 NUL + 개행까지 실제 출력과 같게 만든다.
pub(super) fn stash_out(recs: &[[&str; 4]]) -> String {
    recs.iter().map(|r| r.join("\0") + "\0\n").collect()
}

/// Go `gitStashTwo`.
pub(super) fn stash_two() -> String {
    let (a, b) = (stash_a(), stash_b());
    stash_out(&[
        ["stash@{0}", &a, "On main: 나중 것", "1700000060"],
        ["stash@{1}", &b, "WIP on main: abc123 첫 것", "1700000000"],
    ])
}

/// Go `gitCleanStatus`.
pub(super) fn clean_status() -> String {
    [
        format!("# branch.oid {}", "a".repeat(40)),
        "# branch.head main".to_owned(),
    ]
    .join("\0")
        + "\0"
}

/// Go `gitUntrackedStatus`.
fn untracked_status() -> String {
    clean_status() + "? n.txt\0"
}

pub(super) type OnWrite = Arc<dyn Fn(&mut StashState, &[String]) + Send + Sync>;
pub(super) type WriteErr = Arc<dyn Fn(&[String]) -> Output + Send + Sync>;

/// Go `gitM5Fake` 의 바꿀 수 있는 상태 중 이 표면이 딛는 것이다.
pub(super) struct StashState {
    pub(super) status: String,
    pub(super) branches: HashSet<String>,
    pub(super) stashes: String,
    pub(super) show: String,
    writes: Vec<Vec<String>>,
    pub(super) write_err: Option<WriteErr>,
    pub(super) on_write: Option<OnWrite>,
}

/// Go `gitM5Fake`: 읽기·쓰기를 함께 격리한다. stash 의 `list`·`show` 는 쓰기 실행기로 오므로
/// (FR-GIT-95) 여기서 답하고 기록하지 않는다.
#[derive(Clone)]
pub(super) struct StashFake {
    st: Arc<Mutex<StashState>>,
    git_dir: Arc<TempDir>,
}

fn o(stdout: String) -> Output {
    Output {
        stdout: stdout.into_bytes(),
        ..Output::default()
    }
}

pub(super) fn exit(code: i32, stderr: &str) -> Output {
    Output {
        exit_code: code,
        stderr: stderr.to_owned(),
        ..Output::default()
    }
}

/// Go `fakeCheckRefFormat`.
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

impl StashFake {
    pub(super) fn new() -> Self {
        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join("HEAD"), "ref: refs/heads/main\n").unwrap();
        StashFake {
            st: Arc::new(Mutex::new(StashState {
                status: write_status("a.txt", "M."),
                branches: HashSet::from(["main".to_owned()]),
                stashes: String::new(),
                show: String::new(),
                writes: Vec::new(),
                write_err: None,
                on_write: None,
            })),
            git_dir: Arc::new(dir),
        }
    }

    pub(super) fn lock(&self) -> MutexGuard<'_, StashState> {
        self.st.lock().unwrap()
    }

    pub(super) fn wrote(&self) -> Vec<Vec<String>> {
        self.lock().writes.clone()
    }

    fn read(&self, dir: &str, args: &[String]) -> Output {
        let st = self.lock();
        let a = |i: usize| args.get(i).map(String::as_str).unwrap_or_default();
        match a(0) {
            "rev-parse" if a(1) == "--show-toplevel" => o(format!("{dir}\n")),
            "rev-parse" if a(1) == "--verify" => {
                let name = a(2).strip_prefix("refs/heads/").unwrap_or(a(2));
                if st.branches.contains(name) {
                    o(format!("{}\n", "a".repeat(40)))
                } else {
                    exit(128, "fatal: Needed a single revision\n")
                }
            }
            "rev-parse" => o(format!("{0}\n{0}\n", self.git_dir.path().to_string_lossy())),
            "status" => o(st.status.clone()),
            "check-ref-format" => fake_check_ref_format(a(2)),
            "config" => o("remote.origin.url=/tmp/remote.git\n".to_owned()),
            _ => Output::default(),
        }
    }

    fn write(&self, args: &[String]) -> Output {
        let mut st = self.lock();
        if args.first().map(String::as_str) == Some("stash") {
            match args.get(1).map(String::as_str) {
                Some("list") => return o(st.stashes.clone()),
                Some("show") => return o(st.show.clone()),
                _ => {}
            }
        }
        st.writes.push(args.to_vec());
        if let Some(f) = st.write_err.clone() {
            return f(args);
        }
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

    /// Go `fakeJobRunner(f.write)`.
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
pub(super) fn stash_server(f: &StashFake) -> Arc<GitServer> {
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

pub(super) async fn call(s: &Arc<GitServer>, method: &str, path: &str, body: &str) -> (u16, Value) {
    let r = req(s, method, path, body).await;
    (r.code, r.json())
}

pub(super) fn argv(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| (*s).to_owned()).collect()
}

fn list_len(v: &Value) -> usize {
    v.as_array().map_or(0, Vec::len)
}

fn with_stashes() -> StashFake {
    let f = StashFake::new();
    f.lock().stashes = stash_two();
    f
}

// N1 (V56, FR-GIT-161): 목록은 인덱스·oid·메시지·기준·시각을 준다.
#[tokio::test]
async fn api_git_stash_list() {
    let f = with_stashes();
    let s = stash_server(&f);
    let (code, out) = call(
        &s,
        "GET",
        &format!("/api/git/stash?repo={}", qe(&repo())),
        "",
    )
    .await;
    assert_eq!(code, 200, "{out}");
    assert_eq!(list_len(&out["stashes"]), 2, "{out}");
    let first = &out["stashes"][0];
    assert_eq!(first["index"], 0, "{first}");
    assert_eq!(first["message"], "나중 것", "{first}");
    assert_eq!(first["base"], "main", "{first}");
    assert_eq!(first["atUnixMs"], 1_700_000_060_000_i64, "{first}");
    assert_eq!(out["requested"]["repo"], repo().as_str(), "{out}");
}

// N2 (V58, FR-GIT-166·170): 생성 옵션이 argv 로 가고, 응답에 조작 후 목록과 상태가 함께 온다.
#[tokio::test]
async fn api_git_stash_push() {
    let f = StashFake::new();
    f.lock().on_write = Some(Arc::new(|st, _| {
        st.status = write_status("b.txt", ".M");
        st.stashes = stash_two();
    }));
    let s = stash_server(&f);
    let body = format!(
        r#"{{"repo":{},"message":"작업 중","includeUntracked":true,"keepIndex":true}}"#,
        qrepo()
    );
    let (code, out) = call(&s, "POST", "/api/git/stash/push", &body).await;
    assert_eq!(code, 200, "{out}");
    assert_eq!(
        f.wrote(),
        vec![argv(&[
            "stash",
            "push",
            "--include-untracked",
            "--keep-index",
            "--message=작업 중"
        ])]
    );
    assert_eq!(list_len(&out["stashes"]), 2, "조작 후 목록이 없다: {out}");
    assert!(out["status"].is_object(), "조작 후 상태가 없다: {out}");
}

// N3 (V58, FR-GIT-167): 담을 것이 없으면 실행하지 않고 사유를 준다. untracked 만 있고 `-u` 가
// 없으면 `untracked_only` 다 (FR-SDA-24).
#[tokio::test]
async fn api_git_stash_push_nothing_to_stash() {
    let cases = [
        ("변경 없음", clean_status(), apierr::CODE_NOTHING_TO_STASH),
        (
            "untracked 만 + -u 없음",
            untracked_status(),
            apierr::CODE_UNTRACKED_ONLY,
        ),
    ];
    for (name, status, why) in cases {
        let f = StashFake::new();
        f.lock().status = status;
        let s = stash_server(&f);
        let (code, out) = call(
            &s,
            "POST",
            "/api/git/stash/push",
            &format!(r#"{{"repo":{}}}"#, qrepo()),
        )
        .await;
        assert_eq!(
            (code, out["error"].as_str()),
            (409, Some(why)),
            "{name}: {out}"
        );
        assert!(
            f.wrote().is_empty(),
            "{name}: 거부됐는데 실행됐다: {:?}",
            f.wrote()
        );
    }

    // `-u` 를 켜면 untracked 만 있어도 담긴다.
    let f = StashFake::new();
    f.lock().status = untracked_status();
    let s = stash_server(&f);
    let (code, out) = call(
        &s,
        "POST",
        "/api/git/stash/push",
        &format!(r#"{{"repo":{},"includeUntracked":true}}"#, qrepo()),
    )
    .await;
    assert_eq!(code, 200, "{out}");
}

// N4 (V56, FR-GIT-163·164): apply/pop 의 argv. `--index` 는 요청이 고를 때만 붙는다.
#[tokio::test]
async fn api_git_stash_apply_pop_args() {
    let (a, b) = (stash_a(), stash_b());
    let cases = [
        (
            "/api/git/stash/apply",
            format!(r#"{{"repo":{},"oid":"{b}"}}"#, qrepo()),
            argv(&["stash", "apply", &b]),
        ),
        (
            "/api/git/stash/apply",
            format!(r#"{{"repo":{},"oid":"{a}","withIndex":true}}"#, qrepo()),
            argv(&["stash", "apply", "--index", &a]),
        ),
        (
            "/api/git/stash/pop",
            format!(r#"{{"repo":{},"oid":"{b}"}}"#, qrepo()),
            argv(&["stash", "pop", "stash@{1}"]),
        ),
    ];
    for (path, body, want) in cases {
        let f = with_stashes();
        // pop 이 성공한 것으로 만든다 — 목록에서 그 인덱스가 사라진다.
        f.lock().on_write = Some(Arc::new(|st, av| {
            if av.get(1).map(String::as_str) == Some("pop") {
                st.stashes = stash_out(&[[
                    "stash@{0}",
                    &"a".repeat(40),
                    "On main: 나중 것",
                    "1700000060",
                ]]);
            }
        }));
        let s = stash_server(&f);
        let (code, out) = call(&s, "POST", path, &body).await;
        assert_eq!(code, 200, "{want:?}: {out}");
        assert_eq!(f.wrote(), vec![want.clone()]);
        if want[1] == "pop" {
            assert_eq!(out["stashKept"], false, "{out}");
        }
    }
}

// N5 (V57, FR-GIT-165): pop 이 충돌로 끝나면 stash 가 남고, 그 사실과 남은 목록이 응답에 있다.
#[tokio::test]
async fn api_git_stash_pop_conflict_keeps_stash() {
    let f = with_stashes();
    f.lock().write_err = Some(Arc::new(|av| {
        if av.get(1).map(String::as_str) == Some("pop") {
            return exit(1, "CONFLICT (content): Merge conflict in a.txt\n");
        }
        Output::default()
    }));
    let s = stash_server(&f);
    let (code, out) = call(
        &s,
        "POST",
        "/api/git/stash/pop",
        &format!(r#"{{"repo":{},"oid":"{}"}}"#, qrepo(), stash_b()),
    )
    .await;
    assert_eq!(
        (code, out["error"].as_str()),
        (409, Some(apierr::CODE_STASH_KEPT)),
        "{out}"
    );
    assert_eq!(out["stashKept"], true, "{out}");
    assert_eq!(out["stashKeptOid"], stash_b().as_str(), "{out}");
    assert!(
        !out["stashKeptReason"]
            .as_str()
            .unwrap_or_default()
            .is_empty(),
        "사유가 비었다: {out}"
    );
    assert_eq!(list_len(&out["stashes"]), 2, "{out}");
}

// N6 (V58, FR-GIT-168): drop 은 `confirm:true` 없이 400 이며 실행되지 않는다.
#[tokio::test]
async fn api_git_stash_drop_requires_confirm() {
    let f = with_stashes();
    let s = stash_server(&f);
    let (code, out) = call(
        &s,
        "POST",
        "/api/git/stash/drop",
        &format!(r#"{{"repo":{},"oid":"{}"}}"#, qrepo(), stash_a()),
    )
    .await;
    assert_eq!(
        (code, out["error"].as_str()),
        (400, Some(apierr::CODE_CONFIRM_REQUIRED)),
        "{out}"
    );
    assert!(f.wrote().is_empty(), "거부됐는데 실행됐다: {:?}", f.wrote());
}

// N7 (V58, FR-GIT-168·92): drop 은 실행 전에 sha·메시지·시각을 recovery hint 에 남긴다.
#[tokio::test]
async fn api_git_stash_drop_records_hint() {
    let f = with_stashes();
    let s = stash_server(&f);
    let (code, out) = call(
        &s,
        "POST",
        "/api/git/stash/drop",
        &format!(
            r#"{{"repo":{},"oid":"{}","confirm":true}}"#,
            qrepo(),
            stash_b()
        ),
    )
    .await;
    assert_eq!(code, 200, "{out}");
    assert_eq!(f.wrote(), vec![argv(&["stash", "drop", "stash@{1}"])]);

    let (_, rec) = call(&s, "GET", "/api/git/recovery", "").await;
    let hints = rec["hints"].as_array().cloned().unwrap_or_default();
    assert_eq!(hints.len(), 1, "{rec}");
    let h = &hints[0];
    assert_eq!(h["action"], core::ACTION_STASH_DROP, "{h}");
    assert_eq!(h["values"], serde_json::json!([stash_b()]), "{h}");
    let cmd = h["command"].as_str().unwrap_or_default();
    assert!(
        cmd.starts_with("git stash store ") && cmd.contains(&stash_b()),
        "command = {cmd:?}"
    );
}

// N8 (FR-GIT-169): 미리보기는 변경 파일 목록이다. rename 은 `-z` 에서 세 조각이다.
#[tokio::test]
async fn api_git_stash_show() {
    let f = with_stashes();
    f.lock().show = "R094\0old.txt\0new.txt\0".to_owned();
    let s = stash_server(&f);
    let (code, out) = call(
        &s,
        "GET",
        &format!("/api/git/stash/show?repo={}&oid={}", qe(&repo()), stash_b()),
        "",
    )
    .await;
    assert_eq!(code, 200, "{out}");
    assert_eq!(list_len(&out["files"]), 1, "{out}");
    let fl = &out["files"][0];
    assert_eq!(
        (&fl["status"], &fl["origPath"], &fl["path"]),
        (
            &Value::from("R"),
            &Value::from("old.txt"),
            &Value::from("new.txt")
        ),
        "{fl}"
    );
    assert_eq!(out["requested"]["repo"], repo().as_str(), "{out}");
    assert_eq!(out["requested"]["oid"], stash_b().as_str(), "{out}");
    assert!(
        f.wrote().is_empty(),
        "미리보기가 쓰기로 기록됐다: {:?}",
        f.wrote()
    );
}

// §5.3: index 는 더 이상 받지 않는다(400, 실행 없음). oid 형식이 아니면 400.
#[tokio::test]
async fn api_git_stash_index_and_bad_oid_rejected() {
    let a = stash_a();
    let bodies = [
        format!(r#"{{"repo":{},"index":0}}"#, qrepo()),
        format!(r#"{{"repo":{},"oid":"{a}","index":0}}"#, qrepo()),
        format!(r#"{{"repo":{},"oid":"stash@{{0}}"}}"#, qrepo()),
        format!(r#"{{"repo":{}}}"#, qrepo()),
    ];
    for path in ["/api/git/stash/apply", "/api/git/stash/pop"] {
        for body in &bodies {
            let f = with_stashes();
            let s = stash_server(&f);
            let (code, out) = call(&s, "POST", path, body).await;
            assert_eq!(
                (code, out["error"].as_str()),
                (400, Some(apierr::CODE_BAD_REQUEST)),
                "{path} {body}: {out}"
            );
            assert!(
                f.wrote().is_empty(),
                "{path}: 거부됐는데 실행됐다: {:?}",
                f.wrote()
            );
        }
    }
    let f = StashFake::new();
    let s = stash_server(&f);
    for qs in ["&index=0", "&oid=bad"] {
        let (code, out) = call(
            &s,
            "GET",
            &format!("/api/git/stash/show?repo={}{qs}", qe(&repo())),
            "",
        )
        .await;
        assert_eq!(code, 400, "show {qs}: {out}");
    }
}

// §5.3: 목록에 없는 oid 는 409 stash_moved 이며 실행되지 않는다. 본문에 현재 목록이 실린다.
#[tokio::test]
async fn api_git_stash_drop_moved_oid() {
    let f = with_stashes();
    let s = stash_server(&f);
    let (code, out) = call(
        &s,
        "POST",
        "/api/git/stash/drop",
        &format!(
            r#"{{"repo":{},"oid":"{}","confirm":true}}"#,
            qrepo(),
            "d".repeat(40)
        ),
    )
    .await;
    assert_eq!(
        (code, out["error"].as_str()),
        (409, Some(apierr::CODE_STASH_MOVED)),
        "{out}"
    );
    assert_eq!(list_len(&out["stashes"]), 2, "{out}");
    assert!(f.wrote().is_empty(), "거부됐는데 실행됐다: {:?}", f.wrote());
}

// §5.3: 미리보기에서도 사라진 oid 는 409 stash_moved + 현재 목록이다.
#[tokio::test]
async fn api_git_stash_show_moved_oid() {
    let f = with_stashes();
    let s = stash_server(&f);
    let (code, out) = call(
        &s,
        "GET",
        &format!(
            "/api/git/stash/show?repo={}&oid={}",
            qe(&repo()),
            "d".repeat(40)
        ),
        "",
    )
    .await;
    assert_eq!(
        (code, out["error"].as_str()),
        (409, Some(apierr::CODE_STASH_MOVED)),
        "{out}"
    );
    assert_eq!(list_len(&out["stashes"]), 2, "{out}");
}
