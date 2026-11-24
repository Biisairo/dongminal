//! Go `handlers_git_remote_test.go`·`handlers_git_remote_actions_test.go`·
//! `handlers_git_remote_split_test.go` 의 이식.
//!
//! 옮기지 않은 것:
//! - 없음. `TestGitJobEvents_QueuedLinesOneFlush` 의 flush 수는 응답 본문의 프레임 수로 본다
//!   (Rust 의 `sse::Stream::flush` 한 번이 프레임 하나다).
//! - split 시험은 Go 처럼 실제 git 과 로컬 bare 저장소를 쓴다(네트워크를 타지 않는다).

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use dm_webserver_apierr as apierr;
use dm_webserver_domain_git_core::{self as core, Output, Service};
use dm_webserver_domain_git_jobs::JobRunner;
use dm_webserver_domain_git_store::{Store, StoreOptions};
use http::Method;
use http_body_util::{BodyExt, Full};
use serde_json::{Value, json};
use tempfile::TempDir;

use super::harness::{FakeBroker, FakePaneHub, FakeWorkspace, abs, q, qe, req};
use super::wfake::{job_done, job_id, remote_emit, remote_hold, wait_done};
use crate::GitServer;
use crate::job::job_succeeded;

fn repo() -> String {
    abs(&["work", "repo"])
}

fn repo_body(rest: &str) -> String {
    format!(r#"{{"repo":{}{rest}}}"#, q(&repo()))
}

fn out(s: String) -> Output {
    Output {
        stdout: s.into_bytes(),
        ..Output::default()
    }
}

struct RState {
    branch: String,
    upstream: String,
    config: String,
    refs: String,
    wrote: Vec<Vec<String>>,
}

/// Go `gitRemoteFake`(act=false)·`gitActFake`(act=true). 원격 작업이 딛는 읽기만 답한다.
#[derive(Clone)]
struct RemoteFake {
    st: Arc<Mutex<RState>>,
    git_dir: Arc<TempDir>,
    act: bool,
}

impl RemoteFake {
    fn new(act: bool) -> Self {
        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join("HEAD"), "ref: refs/heads/main\n").unwrap();
        let refs = [
            format!(
                "refs/heads/main\0{}\0origin/main\0\0*\0머리\x001700000000",
                "a".repeat(40)
            ),
            format!(
                "refs/remotes/origin/main\0{}\0\0\0\0머리\x001700000000",
                "b".repeat(40)
            ),
            String::new(),
        ]
        .join("\n");
        RemoteFake {
            st: Arc::new(Mutex::new(RState {
                branch: "main".to_owned(),
                upstream: "origin/main".to_owned(),
                config: "remote.origin.url=/tmp/remote.git\n".to_owned(),
                refs,
                wrote: Vec::new(),
            })),
            git_dir: Arc::new(dir),
            act,
        }
    }

    fn set(&self, f: impl FnOnce(&mut RState)) {
        f(&mut self.st.lock().unwrap());
    }

    fn wrotes(&self) -> Vec<Vec<String>> {
        self.st.lock().unwrap().wrote.clone()
    }

    fn read(&self, dir: &str, args: &[String]) -> Output {
        let st = self.st.lock().unwrap();
        let a1 = args.get(1).map(String::as_str);
        let gd = self.git_dir.path().to_string_lossy().into_owned();
        match args[0].as_str() {
            "rev-parse" if a1 == Some("--show-toplevel") => out(format!("{dir}\n")),
            "rev-parse" => out(format!("{gd}\n{gd}\n")),
            "status" => {
                let mut toks = vec![
                    format!("# branch.oid {}", "a".repeat(40)),
                    format!("# branch.head {}", st.branch),
                ];
                if !st.upstream.is_empty() {
                    toks.push(format!("# branch.upstream {}", st.upstream));
                    toks.push(
                        if self.act {
                            "# branch.ab +2 -0"
                        } else {
                            "# branch.ab +1 -0"
                        }
                        .to_owned(),
                    );
                }
                out(toks.join("\0") + "\0")
            }
            "config" => out(st.config.clone()),
            "for-each-ref" if self.act => out(st.refs.clone()),
            "log" if self.act => out([
                "c".repeat(40),
                "cccccc".to_owned(),
                "d".repeat(40),
                "dm".to_owned(),
                "dm@example.test".to_owned(),
                "1700000000".to_owned(),
                "1700000000".to_owned(),
                String::new(),
                "밀 것".to_owned(),
            ]
            .join("\0")),
            _ => Output::default(),
        }
    }

    fn service(&self) -> Service {
        let (r, w) = (self.clone(), self.clone());
        Service::builder()
            .runner(Arc::new(move |_, dir: String, args: Vec<String>| {
                let r = r.clone();
                Box::pin(async move { Ok::<_, core::Error>(r.read(&dir, &args)) })
            }))
            .write_runner(Arc::new(move |_, _, args: Vec<String>, _| {
                let w = w.clone();
                Box::pin(async move {
                    w.st.lock().unwrap().wrote.push(args);
                    Ok::<_, core::Error>(Output::default())
                })
            }))
            .build()
    }
}

struct REnv {
    s: Arc<GitServer>,
    f: RemoteFake,
    cb: Arc<FakeBroker>,
    /// Go `gitRemoteServer` 는 쓰기 실행기가 불리면 실패한다.
    no_write: bool,
}

impl Drop for REnv {
    fn drop(&mut self) {
        if self.no_write && !std::thread::panicking() {
            assert!(
                self.f.wrotes().is_empty(),
                "원격 작업이 쓰기 경로로 흘렀다: {:?}",
                self.f.wrotes()
            );
        }
    }
}

fn server(f: &RemoteFake, run: Option<JobRunner>, no_write: bool) -> REnv {
    let cb = Arc::new(FakeBroker::default());
    let s = GitServer {
        git: Some(Store::new(Arc::new(f.service()), StoreOptions::default())),
        work: Some(Arc::new(FakeWorkspace::default())),
        commands: Some(cb.clone()),
        tools: Some(Arc::new(FakePaneHub::default())),
        job_runner: run,
        ..GitServer::default()
    };
    REnv {
        s: Arc::new(s),
        f: f.clone(),
        cb,
        no_write,
    }
}

/// Go `gitRemoteServer`.
fn rserver(f: &RemoteFake, run: JobRunner) -> REnv {
    server(f, Some(run), true)
}

/// Go `gitActServer`.
fn aserver(f: &RemoteFake) -> REnv {
    server(f, None, false)
}

type Argv = Arc<Mutex<Option<Vec<String>>>>;

/// argv 를 기록하고 곧 끝나는 실행기다.
fn capture() -> (JobRunner, Argv) {
    let got: Argv = Arc::default();
    let g = got.clone();
    let run: JobRunner = Arc::new(move |_, _, args, _, _| {
        *g.lock().unwrap() = Some(args);
        Box::pin(async { (0, None) })
    });
    (run, got)
}

async fn jreq(s: &Arc<GitServer>, method: &str, target: &str, body: &str) -> (u16, Value) {
    let r = req(s, method, target, body).await;
    (r.code, r.json())
}

fn remote_endpoints() -> Vec<(&'static str, String, String)> {
    vec![
        ("POST", "/api/git/fetch".to_owned(), repo_body("")),
        ("POST", "/api/git/pull".to_owned(), repo_body("")),
        ("POST", "/api/git/push".to_owned(), repo_body("")),
        (
            "POST",
            "/api/git/job/cancel".to_owned(),
            r#"{"id":"x"}"#.to_owned(),
        ),
        ("GET", "/api/git/job/events?id=x".to_owned(), String::new()),
        ("GET", "/api/git/jobs".to_owned(), String::new()),
    ]
}

fn act_endpoints() -> Vec<(&'static str, String, String)> {
    vec![
        (
            "GET",
            format!("/api/git/remotes?repo={}", qe(&repo())),
            String::new(),
        ),
        (
            "POST",
            "/api/git/remote/add".to_owned(),
            repo_body(r#","name":"up","url":"/tmp/u.git""#),
        ),
        (
            "POST",
            "/api/git/remote/remove".to_owned(),
            repo_body(r#","name":"origin""#),
        ),
    ]
}

fn assert_routes(eps: Vec<(&'static str, String, String)>) {
    for (method, path, _) in eps {
        let path = path.split('?').next().unwrap();
        assert!(
            dm_webserver_httproute::dispatch(&crate::routes::ROUTES, method, path).is_some(),
            "{method} {path} 가 gitapi.routes 에 없다"
        );
    }
}

async fn assert_unavailable(eps: Vec<(&'static str, String, String)>) {
    let s = Arc::new(GitServer {
        work: Some(Arc::new(FakeWorkspace::default())),
        tools: Some(Arc::new(FakePaneHub::default())),
        ..GitServer::default()
    });
    for (method, path, body) in eps {
        let (code, out) = jreq(&s, method, &path, &body).await;
        assert_eq!(code, 503, "{method} {path}");
        assert_eq!(out["error"], apierr::CODE_UNAVAILABLE, "{method} {path}");
    }
}

// K1: 6개 라우트가 gitapi.routes 에 등록돼 있다.
#[test]
fn git_remote_routes_registered() {
    assert_routes(remote_endpoints());
}

// K2: git 이 없으면 전부 503 이다 (FR-GIT-60).
#[tokio::test]
async fn git_remote_endpoints_unavailable() {
    assert_unavailable(remote_endpoints()).await;
}

// K3 (FR-GIT-102): fetch/pull/push 는 작업 식별자를 즉시 준다.
#[tokio::test]
async fn git_remote_start_returns_job_immediately() {
    let cases: [(&str, String, &str, &[&str]); 5] = [
        (
            "/api/git/fetch",
            repo_body(""),
            "fetch",
            &["fetch", "--progress"],
        ),
        (
            "/api/git/fetch",
            repo_body(r#","prune":true,"tags":false"#),
            "fetch",
            &["fetch", "--progress", "--prune", "--no-tags"],
        ),
        (
            "/api/git/pull",
            repo_body(""),
            "pull",
            &["pull", "--progress"],
        ),
        (
            "/api/git/pull",
            repo_body(r#","mode":"rebase""#),
            "pull",
            &["pull", "--progress", "--rebase"],
        ),
        (
            "/api/git/push",
            repo_body(""),
            "push",
            &["push", "--progress"],
        ),
    ];
    for (path, body, kind, want) in cases {
        let (run, got) = capture();
        let e = rserver(&RemoteFake::new(false), run);
        let (code, out) = jreq(&e.s, "POST", path, &body).await;
        assert_eq!(code, 200, "{path} {body}: {out}");
        assert_eq!(out["requested"], repo(), "{path} {body}");
        assert_eq!(out["repo"], repo(), "{path} {body}");
        let id = job_id(&out);
        let jb = wait_done(&e.s, &id).await;
        assert_eq!(got.lock().unwrap().clone().unwrap(), want, "{path} {body}");
        assert_eq!(jb.kind, kind, "{path} {body}");
    }
}

// K4 (V40, FR-GIT-101): 같은 리포의 두 번째 원격 작업은 409 job_busy 다.
#[tokio::test]
async fn git_remote_second_job_is_busy() {
    let release = Arc::new(tokio::sync::Semaphore::new(0));
    let e = rserver(&RemoteFake::new(false), remote_hold(release.clone()));
    let (code, first) = jreq(&e.s, "POST", "/api/git/fetch", &repo_body("")).await;
    assert_eq!(code, 200, "첫 요청: {first}");
    let (code, out) = jreq(&e.s, "POST", "/api/git/push", &repo_body("")).await;
    assert_eq!(code, 409, "두 번째: {out}");
    assert_eq!(out["error"], apierr::CODE_JOB_BUSY);
    release.add_permits(1);
    wait_done(&e.s, &job_id(&first)).await;
}

// K5 (V44, FR-GIT-106): confirm 없는 force:"force" 는 400 이다.
#[tokio::test]
async fn git_push_force_needs_confirm() {
    let cases: [(&str, &str, u16, &str, &[&str]); 4] = [
        (
            "확인 없는 force",
            r#","force":"force""#,
            400,
            apierr::CODE_CONFIRM_REQUIRED,
            &[],
        ),
        (
            "확인 있는 force",
            r#","force":"force","confirm":true"#,
            200,
            "",
            &["push", "--progress", "--force"],
        ),
        (
            "lease 는 확인 없이",
            r#","force":"lease""#,
            200,
            "",
            &["push", "--progress", "--force-with-lease"],
        ),
        (
            "모르는 force",
            r#","force":"hard""#,
            400,
            apierr::CODE_BAD_REQUEST,
            &[],
        ),
    ];
    for (name, rest, want_code, err, want) in cases {
        let (run, got) = capture();
        let e = rserver(&RemoteFake::new(false), run);
        let (code, out) = jreq(&e.s, "POST", "/api/git/push", &repo_body(rest)).await;
        assert_eq!(code, want_code, "{name}: {out}");
        if !err.is_empty() {
            assert_eq!(out["error"], err, "{name}");
            continue;
        }
        wait_done(&e.s, &job_id(&out)).await;
        assert_eq!(got.lock().unwrap().clone().unwrap(), want, "{name}");
    }
}

// K6 (V41, FR-GIT-100): upstream 이 없으면 Publish 임을 실행 전에 알린다.
#[tokio::test]
async fn git_push_publish_announced_before_run() {
    let f = RemoteFake::new(false);
    f.set(|st| {
        st.branch = "no-upstream".to_owned();
        st.upstream.clear();
    });
    let (run, got) = capture();
    let e = rserver(&f, run);

    let (code, out) = jreq(&e.s, "POST", "/api/git/push", &repo_body("")).await;
    assert_eq!(code, 409, "{out}");
    assert_eq!(out["error"], apierr::CODE_PUBLISH_REQUIRED);
    let plan = &out["plan"];
    assert!(
        plan["publish"] == true && plan["remote"] == "origin" && plan["branch"] == "no-upstream",
        "plan = {plan}"
    );
    assert!(got.lock().unwrap().is_none(), "확인 전에 실행됐다");

    let (code, out) = jreq(
        &e.s,
        "POST",
        "/api/git/push",
        &repo_body(r#","publish":true"#),
    )
    .await;
    assert_eq!(code, 200, "{out}");
    wait_done(&e.s, &job_id(&out)).await;
    assert_eq!(
        got.lock().unwrap().clone().unwrap(),
        ["push", "--progress", "-u", "origin", "no-upstream"]
    );
}

// 원격이 없으면 Publish 할 곳이 없다 — 사유가 코드로 구분돼야 한다.
#[tokio::test]
async fn git_push_no_remote() {
    let f = RemoteFake::new(false);
    f.set(|st| {
        st.branch = "no-upstream".to_owned();
        st.upstream.clear();
        st.config = "core.bare=false\n".to_owned();
    });
    let e = rserver(&f, remote_emit(&[]));
    let (code, out) = jreq(
        &e.s,
        "POST",
        "/api/git/push",
        &repo_body(r#","publish":true"#),
    )
    .await;
    assert_eq!(
        (code, out["error"].clone()),
        (409, json!(apierr::CODE_NO_REMOTE))
    );
}

/// SSE 응답의 Content-Type 과 프레임들. 끝난 작업의 스트림은 done 뒤에 닫힌다.
async fn sse(s: &Arc<GitServer>, target: &str) -> (String, Vec<String>) {
    let r = http::Request::builder()
        .method(Method::GET)
        .uri(target)
        .body(Full::new(bytes::Bytes::new()))
        .unwrap();
    let res = s.handle(r, None).await.expect("처리되지 않았다");
    let ct = res
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_owned();
    let mut body = res.into_body();
    let mut frames = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        let next = tokio::time::timeout(left, body.frame())
            .await
            .expect("스트림이 닫히지 않았다");
        let Some(fr) = next else { break };
        if let Ok(d) = fr.unwrap().into_data() {
            frames.push(String::from_utf8_lossy(&d).into_owned());
        }
    }
    (ct, frames)
}

/// Go `gitParseSSE`: line 이벤트 목록과 done 이벤트.
fn parse_sse(body: &str) -> (Vec<Value>, Option<Value>) {
    let (mut lines, mut done) = (Vec::new(), None);
    for block in body.split("\n\n") {
        let (mut name, mut payload) = ("", "");
        for l in block.split('\n') {
            if let Some(v) = l.strip_prefix("event: ") {
                name = v;
            } else if let Some(v) = l.strip_prefix("data: ") {
                payload = v;
            }
        }
        if name.is_empty() || payload.is_empty() {
            continue;
        }
        let m: Value = serde_json::from_str(payload)
            .unwrap_or_else(|_| panic!("{name} 이벤트가 JSON 이 아니다: {payload:?}"));
        match name {
            "line" => lines.push(m),
            "done" => done = Some(m),
            _ => {}
        }
    }
    (lines, done)
}

async fn sse_body(s: &Arc<GitServer>, target: &str) -> String {
    let (ct, frames) = sse(s, target).await;
    let body = frames.concat();
    assert_eq!(ct, "text/event-stream", "body = {body:?}");
    body
}

// K7 (V42, FR-GIT-103): SSE 가 줄 이벤트와 종료 이벤트를 준다. after=<seq> 는 재연결 지점이다.
#[tokio::test]
async fn git_job_events_replay_after_seq() {
    let e = rserver(
        &RemoteFake::new(false),
        remote_emit(&["한 줄", "두 줄", "세 줄"]),
    );
    let (_, out) = jreq(&e.s, "POST", "/api/git/fetch", &repo_body("")).await;
    let id = job_id(&out);
    wait_done(&e.s, &id).await;

    let body = sse_body(&e.s, &format!("/api/git/job/events?id={id}&after=1")).await;
    let (lines, done) = parse_sse(&body);
    assert!(
        lines.len() == 2 && lines[0]["text"] == "두 줄" && lines[1]["text"] == "세 줄",
        "line 이벤트 = {lines:?}"
    );
    assert_eq!(lines[0]["stream"], "stderr", "진행은 stderr 로 온다");
    let done = done.expect("done 이벤트가 없다");
    assert!(
        done["done"] == true && done["id"] == id.as_str(),
        "done = {done}"
    );
}

// 처음 연결은 보존된 줄 전부를 받는다.
#[tokio::test]
async fn git_job_events_from_start() {
    let e = rserver(&RemoteFake::new(false), remote_emit(&["가", "나"]));
    let (_, out) = jreq(&e.s, "POST", "/api/git/pull", &repo_body("")).await;
    let id = job_id(&out);
    wait_done(&e.s, &id).await;

    let (lines, done) = parse_sse(&sse_body(&e.s, &format!("/api/git/job/events?id={id}")).await);
    assert!(
        lines.len() == 2 && lines[0]["seq"] == 1,
        "line 이벤트 = {lines:?}"
    );
    assert!(done.is_some(), "done 이벤트가 없다");
}

// 없는 작업의 스트림은 404 다.
#[tokio::test]
async fn git_job_events_unknown_job() {
    let e = rserver(&RemoteFake::new(false), remote_emit(&[]));
    let (code, out) = jreq(
        &e.s,
        "GET",
        &format!("/api/git/job/events?id={}", qe("없는것")),
        "",
    )
    .await;
    assert_eq!(
        (code, out["error"].clone()),
        (404, json!(apierr::CODE_JOB_NOT_FOUND))
    );
    let (code, out) = jreq(&e.s, "GET", "/api/git/job/events", "").await;
    assert_eq!(code, 400, "id 없는 요청: {out}");
}

// K8 (FR-GIT-102): 취소는 작업을 끝내고 부분 적용 가능성을 남긴다.
#[tokio::test]
async fn git_job_cancel() {
    let release = Arc::new(tokio::sync::Semaphore::new(0));
    let e = rserver(&RemoteFake::new(false), remote_hold(release));
    let (_, out) = jreq(&e.s, "POST", "/api/git/fetch", &repo_body("")).await;
    let id = job_id(&out);

    let (code, out) = jreq(
        &e.s,
        "POST",
        "/api/git/job/cancel",
        &format!(r#"{{"id":{}}}"#, q(&id)),
    )
    .await;
    assert!(
        code == 200 && out["ok"] == true && out["canceled"] == true,
        "code = {code}, body = {out}"
    );
    let jb = wait_done(&e.s, &id).await;
    assert!(jb.canceled && !jb.err.is_empty(), "작업 = {jb:?}");

    let (code, out) = jreq(&e.s, "POST", "/api/git/job/cancel", r#"{"id":"없는것"}"#).await;
    assert_eq!(
        (code, out["error"].clone()),
        (404, json!(apierr::CODE_JOB_NOT_FOUND))
    );
}

// K9 (V63, FR-GIT-112): 진행 중 작업은 /api/git/jobs 에 보인다. 끝나면 빠진다.
#[tokio::test]
async fn git_jobs_active_list() {
    let release = Arc::new(tokio::sync::Semaphore::new(0));
    let e = rserver(&RemoteFake::new(false), remote_hold(release.clone()));
    let (_, out) = jreq(&e.s, "POST", "/api/git/push", &repo_body("")).await;
    let id = job_id(&out);

    let (code, out) = jreq(&e.s, "GET", "/api/git/jobs", "").await;
    assert_eq!(code, 200, "{out}");
    let jobs = out["jobs"].as_array().cloned().unwrap_or_default();
    assert_eq!(jobs.len(), 1, "jobs = {}", out["jobs"]);
    let first = &jobs[0];
    assert!(
        first["id"] == id.as_str() && first["kind"] == "push" && first["repo"] == repo().as_str(),
        "작업 = {first}"
    );

    release.add_permits(1);
    wait_done(&e.s, &id).await;
    let (_, out) = jreq(&e.s, "GET", "/api/git/jobs", "").await;
    assert!(
        out["jobs"].as_array().is_none_or(Vec::is_empty),
        "끝난 작업이 목록에 남았다: {}",
        out["jobs"]
    );
}

// K10 (FR-GIT-107): 작업이 끝나면 status 캐시가 만료된다.
#[tokio::test]
async fn git_remote_invalidates_status_cache_on_done() {
    let e = rserver(&RemoteFake::new(false), remote_emit(&["끝"]));
    let status = format!("/api/git/status?repo={}", qe(&repo()));
    let (code, out) = jreq(&e.s, "GET", &status, "").await;
    assert_eq!(code, 200, "status: {out}");
    let (_, out) = jreq(&e.s, "POST", "/api/git/fetch", &repo_body("")).await;
    wait_done(&e.s, &job_id(&out)).await;

    let (code, out) = jreq(&e.s, "GET", &status, "").await;
    assert_eq!(code, 200, "{out}");
    assert_eq!(
        out["cached"], false,
        "작업이 끝났는데 캐시가 그대로다 (FR-GIT-107)"
    );
}

// OPTIMIZE_REFACTOR_SRS FR-OPT-4-4: 작업의 시작·끝을 `git_jobs_changed` 로 민다.
#[tokio::test]
async fn git_jobs_changed_broadcast() {
    let release = Arc::new(tokio::sync::Semaphore::new(0));
    let e = rserver(&RemoteFake::new(false), remote_hold(release.clone()));
    let cb = e.cb.clone();
    let count = move || {
        cb.published
            .lock()
            .unwrap()
            .iter()
            .filter(|p| p.as_slice() == br#"{"action":"git_jobs_changed"}"#)
            .count()
    };
    let (code, out) = jreq(&e.s, "POST", "/api/git/fetch", &repo_body("")).await;
    assert_eq!(code, 200, "{out}");
    assert_eq!(count(), 1, "시작 뒤 방송");
    release.add_permits(1);
    wait_done(&e.s, &job_id(&out)).await;
    let deadline = Instant::now() + Duration::from_secs(3);
    while count() < 2 && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
    assert_eq!(count(), 2, "끝난 뒤 방송");
    assert!(
        e.s.active_jobs().unwrap().is_empty(),
        "ActiveJobs 가 비지 않았다"
    );
}

// FR-OPT-8-1 · HTTP-10: 쌓인 줄과 종료는 flush 한 번으로 나간다.
#[tokio::test]
async fn git_job_events_queued_lines_one_flush() {
    let e = rserver(
        &RemoteFake::new(false),
        remote_emit(&["가", "나", "다", "라"]),
    );
    let (_, out) = jreq(&e.s, "POST", "/api/git/fetch", &repo_body("")).await;
    let id = job_id(&out);
    wait_done(&e.s, &id).await;

    let (_, frames) = sse(&e.s, &format!("/api/git/job/events?id={id}")).await;
    let body = frames.concat();
    let (lines, done) = parse_sse(&body);
    assert!(
        lines.len() == 4 && done.is_some(),
        "line = {lines:?}, done = {done:?}"
    );
    assert!(body.starts_with(": connected\n\n"), "첫 프레임 = {body:?}");
    // 연결 주석 1 + 줄 4·종료 1.
    assert_eq!(frames.len(), 2, "frames = {frames:?}");
}

// ── handlers_git_remote_actions_test.go ──

// E1: 새 표면이 전부 gitapi.routes 에 있다.
#[test]
fn git_remote_action_routes_registered() {
    assert_routes(act_endpoints());
}

// E2: Git 이 없으면 전부 503 이다 (FR-GIT-60).
#[tokio::test]
async fn git_remote_actions_unavailable() {
    assert_unavailable(act_endpoints()).await;
}

// FR-GIT-269 (V196).
#[tokio::test]
async fn git_remotes_list() {
    let f = RemoteFake::new(true);
    f.set(|st| {
        st.config = "remote.origin.url=/tmp/a.git\nremote.up.url=https://u:pw@example.test/b.git\n"
            .to_owned();
    });
    let e = aserver(&f);
    let (code, out) = jreq(
        &e.s,
        "GET",
        &format!("/api/git/remotes?repo={}", qe(&repo())),
        "",
    )
    .await;
    assert_eq!(code, 200, "{out}");
    assert_eq!(
        out["remotes"].as_array().map(Vec::len),
        Some(2),
        "remotes = {}",
        out["remotes"]
    );
    // FR-GIT-104: URL 에 박힌 자격증명은 응답에 나오지 않는다.
    assert!(
        !out["remotes"].to_string().contains("pw"),
        "자격증명이 응답에 나왔다: {}",
        out["remotes"]
    );
}

#[tokio::test]
async fn git_remote_add_runs_and_returns_list() {
    let f = RemoteFake::new(true);
    let e = aserver(&f);
    let (code, out) = jreq(
        &e.s,
        "POST",
        "/api/git/remote/add",
        &repo_body(r#","name":"up","url":"/tmp/u.git""#),
    )
    .await;
    assert!(
        code == 200 && out["ok"] == true,
        "code = {code}, body = {out}"
    );
    assert_eq!(f.wrotes(), [["remote", "add", "up", "/tmp/u.git"]]);
    assert!(out["remotes"].is_array(), "목록이 응답에 없다: {out}");
}

// FR-GIT-269: remove 는 되살릴 `git remote add <name> <url>` 을 hint 로 남긴다.
#[tokio::test]
async fn git_remote_remove_leaves_recovery_hint() {
    let f = RemoteFake::new(true);
    let e = aserver(&f);
    let (code, out) = jreq(
        &e.s,
        "POST",
        "/api/git/remote/remove",
        &repo_body(r#","name":"origin""#),
    )
    .await;
    assert!(
        code == 200 && out["ok"] == true,
        "code = {code}, body = {out}"
    );
    assert_eq!(f.wrotes(), [["remote", "remove", "origin"]]);
    let (_, rec) = jreq(&e.s, "GET", "/api/git/recovery", "").await;
    let hints = rec["hints"].as_array().cloned().unwrap_or_default();
    assert_eq!(hints.len(), 1, "hints = {}", rec["hints"]);
    assert_eq!(
        hints[0]["action"],
        dm_webserver_domain_git_write::REMOTE_REMOVE_ACTION
    );
    let cmd = hints[0]["command"].as_str().unwrap_or_default();
    assert!(
        cmd.contains("git remote add origin /tmp/remote.git"),
        "command = {cmd:?}"
    );
}

// FR-GIT-250.3: 잘못된 이름·URL 은 실행 전에 400 이다. 코드는 사유마다 다르다 (GV-c).
#[tokio::test]
async fn git_remote_add_rejects() {
    let cases = [
        (
            "빈 이름",
            r#","name":"","url":"/tmp/a.git""#,
            apierr::CODE_EMPTY_NAME,
        ),
        (
            "슬래시 이름",
            r#","name":"a/b","url":"/tmp/a.git""#,
            apierr::CODE_REMOTE_NAME_INVALID,
        ),
        (
            "옵션 URL",
            r#","name":"up","url":"--upload-pack=x""#,
            apierr::CODE_REMOTE_URL_INVALID,
        ),
        (
            "이미 있음",
            r#","name":"origin","url":"/tmp/a.git""#,
            apierr::CODE_REMOTE_EXISTS,
        ),
    ];
    for (name, rest, want) in cases {
        let f = RemoteFake::new(true);
        let e = aserver(&f);
        let (code, out) = jreq(&e.s, "POST", "/api/git/remote/add", &repo_body(rest)).await;
        assert!(
            code != 200 && out["error"] == want,
            "{name}: code = {code}, error = {}, want {want}",
            out["error"]
        );
        assert!(
            f.wrotes().is_empty(),
            "{name}: 거부했는데 실행됐다: {:?}",
            f.wrotes()
        );
    }
}

#[tokio::test]
async fn git_remote_remove_missing_is_rejected() {
    let f = RemoteFake::new(true);
    let e = aserver(&f);
    let (code, out) = jreq(
        &e.s,
        "POST",
        "/api/git/remote/remove",
        &repo_body(r#","name":"nope""#),
    )
    .await;
    assert!(
        code == 404 && out["error"] == apierr::CODE_REMOTE_MISSING,
        "code = {code}, body = {out}"
    );
    assert!(
        f.wrotes().is_empty(),
        "거부했는데 실행됐다: {:?}",
        f.wrotes()
    );
}

// ── handlers_git_remote_split_test.go ──
// SERVER_DRIVEN_ACTIONS_SRS GV-g (G-B8 · FR-SDA-42): `origin/x` 를 원격과 브랜치로 가르는
// 일은 서버가 한다.

/// Go `gtBranchRepo`: 실제 저장소와 로컬 bare 원격. git 이 없으면 `None` 이다.
struct BranchRepo {
    s: Arc<GitServer>,
    repo: String,
    bare: std::path::PathBuf,
    _tmp: dm_shared_gittest::TempDir,
}

fn gv_git(dir: &std::path::Path, args: &[&str]) -> String {
    let mut all = vec!["-c", "user.name=t", "-c", "user.email=t@t"];
    all.extend_from_slice(args);
    dm_shared_gittest::run(dir, &all)
}

fn branch_repo() -> Option<BranchRepo> {
    dm_shared_gittest::path()?;
    let tmp = dm_shared_gittest::TempDir::new("dm-gitapi-remote-");
    let root = std::fs::canonicalize(tmp.path()).unwrap();
    let bare = root.join("remote.git");
    let repo = root.join("repo");
    let (b, r) = (bare.to_str().unwrap(), repo.to_str().unwrap());
    gv_git(&root, &["init", "-q", "--bare", b]);
    gv_git(&root, &["init", "-q", "-b", "main", r]);
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
        gv_git(&repo, args);
    }
    let s = Arc::new(GitServer {
        git: Some(Store::new(
            Arc::new(Service::new()),
            StoreOptions::default(),
        )),
        ..GitServer::default()
    });
    Some(BranchRepo {
        s,
        repo: r.to_owned(),
        bare,
        _tmp: tmp,
    })
}

fn gv_body(repo: &str, mut kv: Value) -> String {
    kv["repo"] = json!(repo);
    kv.to_string()
}

// 원격 ref 를 전체 이름으로 보내면 서버가 갈라 원격 브랜치를 지운다.
#[tokio::test]
async fn branch_delete_remote_by_ref() {
    let Some(g) = branch_repo() else { return };
    let (code, out) = jreq(
        &g.s,
        "POST",
        "/api/git/branch/delete-remote",
        &gv_body(
            &g.repo,
            json!({"ref": "refs/remotes/origin/other", "confirm": true}),
        ),
    )
    .await;
    assert!(
        code == 200 && !out["job"].is_null(),
        "= {code} {out}, want 200 {{job}}"
    );
    let jb = job_done(&g.s, &out).await;
    assert!(job_succeeded(&jb), "잡 실패: {jb:?}");
    assert_eq!(
        gv_git(&g.bare, &["branch", "--list", "other"]),
        "",
        "원격의 other 가 남았다"
    );
}

// 원격 ref 가 아니거나 없는 ref 는 400 not_remote_branch 다.
#[tokio::test]
async fn branch_remote_ref_rejects() {
    let Some(g) = branch_repo() else { return };
    let cases = [
        (
            "fetch · 로컬 ref",
            "/api/git/branch/fetch",
            "refs/heads/main",
        ),
        (
            "fetch · 없는 원격",
            "/api/git/branch/fetch",
            "refs/remotes/nowhere/x",
        ),
        (
            "fetch · 없는 원격 브랜치",
            "/api/git/branch/fetch",
            "refs/remotes/origin/nope",
        ),
        (
            "원격 삭제 · 로컬 ref",
            "/api/git/branch/delete-remote",
            "refs/heads/feat",
        ),
    ];
    for (name, path, r) in cases {
        let (code, out) = jreq(
            &g.s,
            "POST",
            path,
            &gv_body(&g.repo, json!({"ref": r, "confirm": true})),
        )
        .await;
        assert!(
            code == 400 && out["error"] == apierr::CODE_NOT_REMOTE_BRANCH,
            "{name}: = {code} {out}, want 400 not_remote_branch"
        );
    }
}

// fetch-into 도 ref 로 받는다.
#[tokio::test]
async fn branch_fetch_into_by_ref() {
    let Some(g) = branch_repo() else { return };
    let (code, out) = jreq(
        &g.s,
        "POST",
        "/api/git/branch/fetch",
        &gv_body(&g.repo, json!({"ref": "refs/remotes/origin/feat"})),
    )
    .await;
    assert!(
        code == 200 && !out["job"].is_null(),
        "= {code} {out}, want 200 {{job}}"
    );
    let jb = job_done(&g.s, &out).await;
    assert!(job_succeeded(&jb), "잡 실패: {jb:?}");
}

// track 만 보내면 서버가 가른 브랜치 이름으로 로컬을 만들고 추적한다.
#[tokio::test]
async fn checkout_track_derives_name() {
    let Some(g) = branch_repo() else { return };
    let (code, out) = jreq(
        &g.s,
        "POST",
        "/api/git/checkout",
        &gv_body(&g.repo, json!({"track": "origin/other"})),
    )
    .await;
    assert!(
        code == 200 && !out["job"].is_null(),
        "= {code} {out}, want 200 {{job}}"
    );
    let jb = job_done(&g.s, &out).await;
    assert!(job_succeeded(&jb), "잡 실패: {jb:?}");
    let repo = std::path::Path::new(&g.repo);
    assert_eq!(
        gv_git(repo, &["rev-parse", "--abbrev-ref", "HEAD"]),
        "other"
    );
    assert_eq!(
        gv_git(
            repo,
            &[
                "for-each-ref",
                "--format=%(upstream:short)",
                "refs/heads/other"
            ]
        ),
        "origin/other"
    );
}

// 목록의 원격 ref 는 원격 이름을 싣는다 — 화면은 이름을 가르지 않는다.
#[tokio::test]
async fn refs_carry_remote_name() {
    let Some(g) = branch_repo() else { return };
    let (code, out) = jreq(
        &g.s,
        "GET",
        &format!("/api/git/refs?repo={}", qe(&g.repo)),
        "",
    )
    .await;
    assert_eq!(code, 200, "{out}");
    let refs = out["refs"].as_array().cloned().unwrap_or_default();
    let mut seen = 0;
    for r in &refs {
        match r["kind"].as_str() {
            Some("remote") => {
                seen += 1;
                assert_eq!(r["remote"], "origin", "{} 의 remote", r["short"]);
            }
            Some("local") => {
                assert!(
                    r.get("remote").is_none(),
                    "로컬 ref 에 remote 가 실렸다: {r}"
                );
            }
            _ => {}
        }
    }
    assert!(seen > 0, "원격 ref 가 없다");
}

/// FR-RDF-4 (Go `apiGitJobEvents` 의 `r.Context().Done()`): 클라이언트가 끊으면 다음 줄이나
/// keep-alive(15초)를 기다리지 않고 루프를 끝내고 구독을 놓는다.
#[tokio::test]
async fn job_events_close_releases_subscription_without_waiting() {
    let e = rserver(&RemoteFake::new(false), remote_emit(&[]));
    let hub = e.s.jobs_hub(e.s.git.as_ref().unwrap());
    let (res, st) = dm_webserver_sse::start(Duration::ZERO);
    let (tx, rx) = tokio::sync::mpsc::channel(1);
    let h = tokio::spawn(crate::remote::job_event_loop(
        st,
        rx,
        hub,
        "x".to_owned(),
        core::Ctx::background(),
    ));
    tokio::task::yield_now().await;
    assert!(!h.is_finished(), "클라이언트가 있는 동안은 기다린다");
    drop(res);
    tokio::time::timeout(Duration::from_secs(1), h)
        .await
        .expect("끊긴 구독이 남았다")
        .unwrap();
    assert!(tx.is_closed(), "구독 채널을 놓지 않았다");
}
