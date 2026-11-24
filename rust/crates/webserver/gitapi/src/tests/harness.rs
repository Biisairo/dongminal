//! Go `fakes_test.go`·`handlers_git_test.go` 의 하네스.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use bytes::Bytes;
use http::{HeaderMap, Method};
use http_body_util::{BodyExt, Full};
use otter_webserver_domain_git_core::{self as core, Output, Runner, Service};
use otter_webserver_domain_git_store::{Store, StoreOptions};
use tempfile::TempDir;

use crate::{Broadcaster, GitServer, ToolLocator, WorkspaceStore};

pub(crate) fn abs(seg: &[&str]) -> String {
    otter_shared_testpath::abs(seg)
        .to_string_lossy()
        .into_owned()
}

pub(crate) fn q(s: &str) -> String {
    otter_shared_testpath::json_quote(s)
}

/// Go `url.QueryEscape`.
pub(crate) fn qe(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

pub(crate) const STATUS_FIXTURE: &str =
    "# branch.oid 1111111111111111111111111111111111111111\0# branch.head main\0? a.txt\0";

pub(crate) fn out(stdout: &str) -> Output {
    Output {
        stdout: stdout.as_bytes().to_vec(),
        ..Output::default()
    }
}

pub(crate) fn not_repo_out() -> Output {
    Output {
        exit_code: 128,
        stderr: "fatal: not a git repository".to_owned(),
        ..Output::default()
    }
}

type RootFn = Arc<dyn Fn(&str) -> Result<Output, core::Error> + Send + Sync>;
type ExtraFn = Arc<dyn Fn(&str, &[String]) -> Option<Output> + Send + Sync>;

/// server 계층용 Runner. 호출 argv 를 전부 기록한다 (FR-GIT-24).
#[derive(Clone)]
pub(crate) struct GitFake {
    pub(crate) argvs: Arc<Mutex<Vec<Vec<String>>>>,
    git_dir: Arc<TempDir>,
    /// 없으면 요청 dir 를 그대로 루트로 답한다.
    pub(crate) root: Arc<Mutex<Option<RootFn>>>,
    /// 위 규칙보다 먼저 보는 응답. `None` 이면 기본 규칙으로 간다.
    pub(crate) extra: Arc<Mutex<Option<ExtraFn>>>,
    pub(crate) status_truncated: Arc<AtomicBool>,
    pub(crate) status_not_repo: Arc<AtomicBool>,
    pub(crate) status_calls: Arc<AtomicUsize>,
    /// 있으면 status 가 이 세마포어를 얻을 때까지 멈춘다 — single-flight 를 볼 지점이다.
    pub(crate) status_hold: Arc<Mutex<Option<Arc<tokio::sync::Semaphore>>>>,
    pub(crate) status_entered: Arc<tokio::sync::Notify>,
}

impl GitFake {
    /// HEAD 만 있는 gitdir 을 만든다 — 관측이 signature 도 채우므로 HEAD 가 있어야 한다.
    pub(crate) fn new() -> Self {
        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join("HEAD"), "ref: refs/heads/main\n").unwrap();
        GitFake {
            argvs: Arc::default(),
            git_dir: Arc::new(dir),
            root: Arc::default(),
            extra: Arc::default(),
            status_truncated: Arc::default(),
            status_not_repo: Arc::default(),
            status_calls: Arc::default(),
            status_hold: Arc::default(),
            status_entered: Arc::default(),
        }
    }

    pub(crate) fn git_dir(&self) -> String {
        self.git_dir.path().to_string_lossy().into_owned()
    }

    pub(crate) fn set_root(&self, f: impl Fn(&str) -> Output + Send + Sync + 'static) {
        *self.root.lock().unwrap() = Some(Arc::new(move |d| Ok(f(d))));
    }

    pub(crate) fn set_root_result(
        &self,
        f: impl Fn(&str) -> Result<Output, core::Error> + Send + Sync + 'static,
    ) {
        *self.root.lock().unwrap() = Some(Arc::new(f));
    }

    /// 루트를 늘 이 경로로 답한다.
    pub(crate) fn root_at(&self, root: &str) {
        let line = format!("{root}\n");
        self.set_root(move |_| out(&line));
    }

    pub(crate) fn set_extra(
        &self,
        f: impl Fn(&str, &[String]) -> Option<Output> + Send + Sync + 'static,
    ) {
        *self.extra.lock().unwrap() = Some(Arc::new(f));
    }

    pub(crate) fn count(&self, sub: &str) -> usize {
        self.argvs
            .lock()
            .unwrap()
            .iter()
            .filter(|a| a.first().map(String::as_str) == Some(sub))
            .count()
    }

    /// rev-parse 를 뺀 호출들("argv 를 공백으로 이은 것").
    pub(crate) fn calls(&self) -> Vec<String> {
        self.argvs
            .lock()
            .unwrap()
            .iter()
            .filter(|a| a.first().map(String::as_str) != Some("rev-parse"))
            .map(|a| a.join(" "))
            .collect()
    }

    fn answer(&self, dir: &str, args: &[String]) -> Result<Output, core::Error> {
        self.argvs.lock().unwrap().push(args.to_vec());
        let extra = self.extra.lock().unwrap().clone();
        if let Some(f) = extra
            && let Some(o) = f(dir, args)
        {
            return Ok(o);
        }
        let a1 = args.get(1).map(String::as_str);
        match args[0].as_str() {
            "rev-parse" if a1 == Some("--show-toplevel") => {
                let root = self.root.lock().unwrap().clone();
                match root {
                    Some(f) => f(dir),
                    None => Ok(out(&format!("{dir}\n"))),
                }
            }
            "rev-parse" => Ok(out(&format!("{0}\n{0}\n", self.git_dir()))),
            "status" => {
                self.status_calls.fetch_add(1, Ordering::SeqCst);
                if self.status_not_repo.load(Ordering::SeqCst) {
                    return Ok(not_repo_out());
                }
                let mut o = out(STATUS_FIXTURE);
                o.stdout_truncated = self.status_truncated.load(Ordering::SeqCst);
                Ok(o)
            }
            _ => Ok(Output::default()),
        }
    }

    pub(crate) fn runner(&self) -> Runner {
        let me = self.clone();
        Arc::new(move |_, dir: String, args: Vec<String>| {
            let me = me.clone();
            Box::pin(async move {
                if args.first().map(String::as_str) == Some("status") {
                    let hold = me.status_hold.lock().unwrap().clone();
                    if let Some(sem) = hold {
                        me.status_entered.notify_one();
                        let _ = sem.acquire().await;
                    }
                }
                me.answer(&dir, &args)
            })
        })
    }

    pub(crate) fn service(&self) -> Service {
        let run = self.runner();
        let write: otter_webserver_domain_git_core::WriteRunner =
            Arc::new(move |ctx, dir, args, _stdin| run(ctx, dir, args));
        Service::builder()
            .runner(self.runner())
            .write_runner(write)
            .build()
    }
}

/// Go `fakeWorkspaceStore`.
#[derive(Default)]
pub(crate) struct FakeWorkspace {
    pub(crate) raw: Mutex<Vec<u8>>,
    rev: Mutex<u64>,
    pub(crate) saves: AtomicUsize,
    pub(crate) reads: AtomicUsize,
    pub(crate) stale: AtomicBool,
}

impl FakeWorkspace {
    pub(crate) fn set(&self, raw: &str) {
        *self.raw.lock().unwrap() = raw.as_bytes().to_vec();
    }
    pub(crate) fn raw(&self) -> String {
        String::from_utf8_lossy(&self.raw.lock().unwrap()).into_owned()
    }
    pub(crate) fn saves(&self) -> usize {
        self.saves.load(Ordering::SeqCst)
    }
}

impl WorkspaceStore for FakeWorkspace {
    fn snapshot(&self) -> (Arc<Vec<u8>>, u64) {
        self.reads.fetch_add(1, Ordering::SeqCst);
        (
            Arc::new(self.raw.lock().unwrap().clone()),
            *self.rev.lock().unwrap(),
        )
    }
    fn save(&self, blob: &[u8], _if_match: &str) -> Result<u64, otter_shared_workspace::Error> {
        if self.stale.load(Ordering::SeqCst) {
            return Err(otter_shared_workspace::Error::Stale);
        }
        *self.raw.lock().unwrap() = blob.to_vec();
        let mut rev = self.rev.lock().unwrap();
        *rev += 1;
        self.saves.fetch_add(1, Ordering::SeqCst);
        Ok(*rev)
    }
}

/// Go `fakeCommandBroker`.
#[derive(Default)]
pub(crate) struct FakeBroker {
    pub(crate) published: Mutex<Vec<Vec<u8>>>,
}

impl Broadcaster for FakeBroker {
    fn broadcast(&self, payload: &[u8]) -> usize {
        self.published.lock().unwrap().push(payload.to_vec());
        1
    }
}

/// Go `fakePaneHub`.
#[derive(Default)]
pub(crate) struct FakePaneHub {
    cwds: Mutex<std::collections::HashMap<String, String>>,
}

impl FakePaneHub {
    pub(crate) fn set_cwd(&self, id: &str, cwd: &str) {
        self.cwds
            .lock()
            .unwrap()
            .insert(id.to_owned(), cwd.to_owned());
    }
}

impl ToolLocator for FakePaneHub {
    fn cwd(&self, id: &str) -> String {
        self.cwds
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .unwrap_or_default()
    }
}

pub(crate) struct Env {
    pub(crate) s: Arc<GitServer>,
    pub(crate) g: GitFake,
    pub(crate) ws: Arc<FakeWorkspace>,
    pub(crate) cb: Arc<FakeBroker>,
    pub(crate) hub: Arc<FakePaneHub>,
}

/// Go `gitTestServer`: 주입 Runner 의 Store 로 세운다. 시계를 고정해 TTL 이 만료되지 않는다.
pub(crate) fn env_with(g: GitFake, edit: impl FnOnce(&mut GitServer)) -> Env {
    let at = SystemTime::now();
    let store = Store::new(
        Arc::new(g.service()),
        StoreOptions::default().clock(Arc::new(move || at)),
    );
    let (ws, cb, hub) = (
        Arc::new(FakeWorkspace::default()),
        Arc::new(FakeBroker::default()),
        Arc::new(FakePaneHub::default()),
    );
    let mut s = GitServer {
        git: Some(store),
        work: Some(ws.clone()),
        commands: Some(cb.clone()),
        tools: Some(hub.clone()),
        ..GitServer::default()
    };
    edit(&mut s);
    Env {
        s: Arc::new(s),
        g,
        ws,
        cb,
        hub,
    }
}

pub(crate) fn env() -> Env {
    env_with(GitFake::new(), |_| {})
}

/// 응답 하나.
pub(crate) struct Resp {
    pub(crate) code: u16,
    pub(crate) headers: HeaderMap,
    pub(crate) body: Vec<u8>,
}

impl Resp {
    pub(crate) fn json(&self) -> serde_json::Value {
        serde_json::from_slice(&self.body).unwrap_or(serde_json::Value::Null)
    }
    pub(crate) fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
}

/// Go `gitReq`: handle 이 처리하지 않으면 404 "not found" 다.
pub(crate) async fn req(s: &Arc<GitServer>, method: &str, target: &str, body: &str) -> Resp {
    let r = http::Request::builder()
        .method(Method::from_bytes(method.as_bytes()).unwrap())
        .uri(target)
        .body(Full::new(Bytes::from(body.to_owned())))
        .unwrap();
    let Some(res) = s.handle(r, None).await else {
        return Resp {
            code: 404,
            headers: HeaderMap::new(),
            body: b"not found\n".to_vec(),
        };
    };
    let (parts, body) = res.into_parts();
    Resp {
        code: parts.status.as_u16(),
        headers: parts.headers,
        body: body.collect().await.unwrap().to_bytes().to_vec(),
    }
}
