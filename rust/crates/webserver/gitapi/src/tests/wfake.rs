//! Go `handlers_git_write_test.go` 의 `gitWriteFake`·`gitWriteServer` 와 잡 도우미
//! (`fakeJobRunner`·`gitJobDone`·`gitReqAwait`·`gitRemoteHold`·`gitRemoteEmit`·`gitRemoteWaitDone`).

use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime};

use otter_webserver_domain_git_core::{self as core, Ctx, Output, Service};
use otter_webserver_domain_git_jobs::{Job, JobRunner, LINE_STDERR};
use otter_webserver_domain_git_store::{Store, StoreOptions};
use tempfile::TempDir;

use super::harness::{FakeBroker, FakePaneHub, FakeWorkspace, Resp, req};
use crate::GitServer;

/// staged 1개인 porcelain v2 출력이다 (Go `gitWriteStatus`).
pub(crate) fn write_status(path: &str, xy: &str) -> String {
    let rec = format!(
        "1 {xy} N... 100644 100644 100644 {} {} {path}",
        "1".repeat(40),
        "2".repeat(40)
    );
    [
        format!("# branch.oid {}", "a".repeat(40)),
        "# branch.head main".to_owned(),
        rec,
    ]
    .join("\0")
        + "\0"
}

pub(crate) type WriteErrFn = Arc<dyn Fn(&[String]) -> Result<Output, core::Error> + Send + Sync>;
pub(crate) type OnWriteFn = Arc<dyn Fn(&mut WState, &[String]) + Send + Sync>;
pub(crate) type WriteCtxFn = Arc<dyn Fn(&Ctx) + Send + Sync>;

/// fake 의 바꿀 수 있는 상태다.
pub(crate) struct WState {
    pub(crate) status: String,
    /// false 면 preflight 가 identity_missing 으로 막는다.
    pub(crate) identity: bool,
    pub(crate) message: String,
    pub(crate) head_oid: String,
    /// 있으면 log 읽기가 실패한다 (FR-ATF-2).
    pub(crate) log_err: Option<core::Error>,
    pub(crate) writes: Vec<Vec<String>>,
    pub(crate) stdins: Vec<String>,
    pub(crate) write_err: Option<WriteErrFn>,
    /// 쓰기 성공 직후에 불린다.
    pub(crate) on_write: Option<OnWriteFn>,
    /// 쓰기가 받은 ctx 를 본다 (§5.5).
    pub(crate) write_ctx: Option<WriteCtxFn>,
    /// status 조회마다 불린다(잠금 밖에서 부른다).
    pub(crate) on_status: Option<Arc<dyn Fn() + Send + Sync>>,
    /// 있으면 status 조회가 실패한다 (FR-ATF-74).
    pub(crate) status_err: Option<core::Error>,
}

/// 읽기와 쓰기를 함께 격리한다 (Go `gitWriteFake`).
#[derive(Clone)]
pub(crate) struct WriteFake {
    st: Arc<Mutex<WState>>,
    git_dir: Arc<TempDir>,
}

impl WriteFake {
    pub(crate) fn new() -> Self {
        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join("HEAD"), "ref: refs/heads/main\n").unwrap();
        WriteFake {
            st: Arc::new(Mutex::new(WState {
                status: write_status("a.txt", "M."),
                identity: true,
                message: "직전 커밋 제목\n\n본문".to_owned(),
                head_oid: "a".repeat(40),
                log_err: None,
                writes: Vec::new(),
                stdins: Vec::new(),
                write_err: None,
                on_write: None,
                write_ctx: None,
                on_status: None,
                status_err: None,
            })),
            git_dir: Arc::new(dir),
        }
    }

    pub(crate) fn lock(&self) -> MutexGuard<'_, WState> {
        self.st.lock().unwrap()
    }

    pub(crate) fn git_dir(&self) -> String {
        self.git_dir.path().to_string_lossy().into_owned()
    }

    pub(crate) fn wrote(&self) -> Vec<Vec<String>> {
        self.lock().writes.clone()
    }

    /// 쓰기 기록을 비운다.
    pub(crate) fn reset_writes(&self) {
        let mut st = self.lock();
        st.writes.clear();
        st.stdins.clear();
    }

    fn config_value(st: &WState, args: &[String]) -> String {
        let key = args.last().map(String::as_str).unwrap_or_default();
        if !st.identity {
            return String::new();
        }
        match key {
            "--list" => "user.name\ntester\0user.email\nt@example.com\0".to_owned(),
            "user.name" => "tester\n".to_owned(),
            "user.email" => "t@example.com\n".to_owned(),
            _ => String::new(),
        }
    }

    pub(crate) fn read(&self, dir: &str, args: &[String]) -> Result<Output, core::Error> {
        let a = |i: usize| args.get(i).map(String::as_str).unwrap_or_default();
        let ok = |s: String| Ok(out(s));
        if a(0) == "status" {
            let hook = self.lock().on_status.clone();
            if let Some(h) = hook {
                h();
            }
        }
        let st = self.lock();
        match a(0) {
            "rev-parse" if a(1) == "--show-toplevel" => ok(format!("{dir}\n")),
            "rev-parse" if a(1) == "--verify" => ok(format!("{}\n", "a".repeat(40))),
            "rev-parse" if a(1) == "--git-path" => ok(format!(
                "{}\n",
                self.git_dir.path().join(a(2)).to_string_lossy()
            )),
            "rev-parse" => ok(format!("{0}\n{0}\n", self.git_dir())),
            "status" => match &st.status_err {
                Some(e) => Err(e.clone()),
                None => ok(st.status.clone()),
            },
            "log" => {
                if let Some(e) = &st.log_err {
                    return Err(e.clone());
                }
                if a(args.len() - 1).starts_with("--pretty=%H") {
                    return ok(format!("{}\0{}\n", st.head_oid, st.message));
                }
                ok(format!("{}\n", st.message))
            }
            "config" => ok(Self::config_value(&st, args)),
            _ => Ok(Output::default()),
        }
    }

    pub(crate) fn write(
        &self,
        ctx: &Ctx,
        args: &[String],
        stdin: &str,
    ) -> Result<Output, core::Error> {
        let wc = self.lock().write_ctx.clone();
        if let Some(f) = wc {
            f(ctx);
        }
        let mut st = self.lock();
        st.writes.push(args.to_vec());
        st.stdins.push(stdin.to_owned());
        if let Some(f) = st.write_err.clone() {
            return f(args);
        }
        if let Some(f) = st.on_write.clone() {
            f(&mut st, args);
        }
        Ok(Output::default())
    }

    pub(crate) fn service(&self) -> Service {
        let (r, w) = (self.clone(), self.clone());
        Service::builder()
            .runner(Arc::new(move |_, dir: String, args: Vec<String>| {
                let r = r.clone();
                Box::pin(async move { r.read(&dir, &args) })
            }))
            .write_runner(Arc::new(
                move |ctx, _dir, args: Vec<String>, stdin: String| {
                    let w = w.clone();
                    Box::pin(async move { w.write(&ctx, &args, &stdin) })
                },
            ))
            .build()
    }
}

pub(crate) fn out(stdout: String) -> Output {
    Output {
        stdout: stdout.into_bytes(),
        ..Output::default()
    }
}

/// 잡 실행을 fake 쓰기 실행기로 넘긴다. stderr 는 한 줄로 흘린다 (Go `fakeJobRunner`).
pub(crate) fn fake_job_runner(f: &WriteFake) -> JobRunner {
    let f = f.clone();
    Arc::new(move |ctx, _dir, args, stdin, emit| {
        let f = f.clone();
        Box::pin(async move {
            match f.write(&ctx, &args, &stdin) {
                Ok(o) => {
                    if !o.stderr.is_empty() {
                        emit(LINE_STDERR, &o.stderr);
                    }
                    (o.exit_code, None)
                }
                Err(e) => (e.output().map_or(0, |o| o.exit_code), Some(e)),
            }
        })
    })
}

/// 취소되거나 풀릴 때까지 매달리는 실행기다 (Go `gitRemoteHold`).
pub(crate) fn remote_hold(release: Arc<tokio::sync::Semaphore>) -> JobRunner {
    Arc::new(move |ctx: Ctx, _, _, _, emit| {
        let release = release.clone();
        Box::pin(async move {
            emit("stderr", "remote: 세는 중");
            tokio::select! {
                _ = release.acquire() => (0, None),
                () = ctx.done() => (-1, ctx.err().map(core::Error::from_ctx)),
            }
        })
    })
}

/// 준 줄을 내고 곧 끝나는 실행기다 (Go `gitRemoteEmit`).
pub(crate) fn remote_emit(lines: &[&str]) -> JobRunner {
    let lines: Vec<String> = lines.iter().map(|s| (*s).to_owned()).collect();
    Arc::new(move |_, _, _, _, emit| {
        let lines = lines.clone();
        Box::pin(async move {
            for l in &lines {
                emit("stderr", l);
            }
            (0, None)
        })
    })
}

/// 세운 서버와 그 fake 들.
pub(crate) struct WEnv {
    pub(crate) s: Arc<GitServer>,
    pub(crate) f: WriteFake,
    /// undo 토큰의 시계다. 앞으로 돌리면 만료를 볼 수 있다.
    pub(crate) undo_now: Arc<Mutex<Instant>>,
}

impl WEnv {
    pub(crate) fn advance_undo(&self, d: Duration) {
        *self.undo_now.lock().unwrap() += d;
    }
}

/// 읽기·쓰기 둘 다 격리된 GitServer 를 세운다 (Go `gitWriteServer`). 잡 실행기도 같은 fake 다.
pub(crate) fn wserver_with(f: &WriteFake, edit: impl FnOnce(&mut GitServer)) -> WEnv {
    let at = SystemTime::now();
    let store = Store::new(
        Arc::new(f.service()),
        StoreOptions::default().clock(Arc::new(move || at)),
    );
    let mut s = GitServer {
        git: Some(store),
        work: Some(Arc::new(FakeWorkspace::default())),
        commands: Some(Arc::new(FakeBroker::default())),
        tools: Some(Arc::new(FakePaneHub::default())),
        job_runner: Some(fake_job_runner(f)),
        ..GitServer::default()
    };
    let undo_now = Arc::new(Mutex::new(Instant::now()));
    let un = undo_now.clone();
    s.undo.set_clock(Arc::new(move || *un.lock().unwrap()));
    edit(&mut s);
    WEnv {
        s: Arc::new(s),
        f: f.clone(),
        undo_now,
    }
}

pub(crate) fn wserver(f: &WriteFake) -> WEnv {
    wserver_with(f, |_| {})
}

/// 잡이 끝나기를 기다려 최종 모습을 준다 (Go `gitRemoteWaitDone`).
pub(crate) async fn wait_done(s: &Arc<GitServer>, id: &str) -> Job {
    let hub = s.jobs_hub(s.git.as_ref().unwrap());
    let deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < deadline {
        if let Some(jb) = hub.get(id)
            && jb.done
        {
            return jb;
        }
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
    panic!("작업 {id} 가 끝나지 않았다");
}

/// 응답의 잡 식별자다 (Go `gitRemoteJobID`).
pub(crate) fn job_id(out: &serde_json::Value) -> String {
    let id = out["job"]["id"].as_str().unwrap_or_default().to_owned();
    assert!(!id.is_empty(), "응답에 잡이 없다: {out}");
    id
}

/// `{job}` 응답의 잡이 끝나기를 기다린다 (Go `gitJobDone`).
pub(crate) async fn job_done(s: &Arc<GitServer>, out: &serde_json::Value) -> Job {
    wait_done(s, &job_id(out)).await
}

/// 잡을 여는 종단을 부르고 잡이 끝나기를 기다려, 응답을 동기 모양 `{ok, status, …}` 으로 편다
/// (Go `gitReqAwait`).
pub(crate) async fn req_await(
    s: &Arc<GitServer>,
    method: &str,
    target: &str,
    body: &str,
) -> (u16, serde_json::Value) {
    let res: Resp = req(s, method, target, body).await;
    let mut out = res.json();
    if res.code != 200 || out.get("job").is_none_or(serde_json::Value::is_null) {
        return (res.code, out);
    }
    let jb = job_done(s, &out).await;
    out["ok"] = serde_json::Value::Bool(crate::job::job_succeeded(&jb));
    if let Some(st) = jb.result.as_ref().and_then(|r| r.status.as_ref()) {
        let raw = otter_gocompat::json::marshal(st).unwrap();
        out["status"] = serde_json::from_slice(&raw).unwrap();
    }
    (res.code, out)
}

/// 하네스 자체의 시험: commit → 잡 → undo 토큰 발급이 돈다.
#[tokio::test]
async fn harness_commit_job_issues_undo() {
    let f = WriteFake::new();
    let e = wserver(&f);
    let repo = super::harness::abs(&["work", "repo"]);
    let body = format!(r#"{{"repo":{},"message":"m"}}"#, super::harness::q(&repo));
    let res = req(&e.s, "POST", "/api/git/commit", &body).await;
    assert_eq!(res.code, 200, "{}", res.text());
    let jb = job_done(&e.s, &res.json()).await;
    let r = jb.result.unwrap();
    assert!(!r.undo_token.is_empty() && !r.oid.is_empty());
    assert_eq!(
        f.wrote(),
        vec![vec!["commit", "--file=-", "--cleanup=strip"]]
    );
}
