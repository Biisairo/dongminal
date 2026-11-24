//! 선언대로 조달한다 (FR-EXT-10~19). 무엇을 어디서 받을지는 매니페스트가 정하고, 여기서는 격리
//! 칸 안에서 수행할 뿐이다 (D-P2). 네트워크와 실행을 주입받는다 (§2.5 ③).

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use otter_gocompat::filepath;
use otter_gocompat::json::is_empty;
use otter_gocompat::time::format_std_duration;
use serde::Serialize;

use crate::ctx::Ctx;
use crate::env::{CACHE_GO_BUILD, isolated_env, isolated_env_with_path};
use crate::fetch::{BoxFuture, Fetch, HttpFetch, Opts, fetch_archive_with};
use crate::goos;
use crate::locate::{
    LookPath, cache_dir, host_look_path, managed_exe_found, plugin_dir, runtime_dir, runtime_exe,
    runtime_ready_in,
};
use crate::manifest::{
    KIND_RUNTIME, KIND_SERVER, Manifest, SOURCE_ARCHIVE, SOURCE_NPM, SOURCE_TOOLCHAIN,
    current_target,
};

/// 조달 하나의 시간 상한 (FR-EXT-18).
pub const INSTALL_TIMEOUT: Duration = Duration::from_secs(10 * 60);

/// 설치 명령이 끝나거나 취소된 뒤 출력 파이프가 닫히기를 기다리는 상한 (FR-ATF-26).
pub const INSTALL_WAIT_DELAY: Duration = Duration::from_secs(5);

/// 도구의 출력을 결과에 실을 때의 바이트 상한 (FR-ATF-28).
pub const OUTPUT_TAIL: usize = 4000;

/// 명령 하나의 결과. Go `([]byte, error)` 이며, `err` 는 Go 의 문구다.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ExecResult {
    /// stdout 과 stderr 를 섞은 출력 (Go `CombinedOutput`).
    pub out: Vec<u8>,
    pub err: Option<String>,
}

/// 명령 하나를 돌린다. name 과 args 가 **분리된 채** 오므로 셸이 끼지 않는다 (FR-EXT-17·38).
/// env 는 호스트 환경 뒤에 붙는다. 비면 호스트 환경 그대로다.
pub trait Exec: Send + Sync {
    fn exec<'a>(
        &'a self,
        ctx: &'a Ctx,
        name: &'a str,
        args: &'a [String],
        env: &'a [String],
        dir: &'a str,
    ) -> BoxFuture<'a, ExecResult>;
}

/// 실제 실행. 취소되면 죽이고, [`INSTALL_WAIT_DELAY`] 뒤에는 파이프를 기다리지 않는다.
pub struct HostExec;

/// Go `ErrWaitDelay`.
const ERR_WAIT_DELAY: &str = "exec: WaitDelay expired before I/O complete";

impl Exec for HostExec {
    fn exec<'a>(
        &'a self,
        ctx: &'a Ctx,
        name: &'a str,
        args: &'a [String],
        env: &'a [String],
        dir: &'a str,
    ) -> BoxFuture<'a, ExecResult> {
        Box::pin(run_host(ctx, name, args, env, dir))
    }
}

/// Go `exec.Command`: 구분자 없는 이름은 PATH 에서 찾는다.
pub(crate) fn host_exe_in(name: &str, path_env: &str) -> Result<String, String> {
    if name.bytes().any(filepath::is_path_separator) {
        return Ok(name.to_owned());
    }
    otter_shared_platform::try_look_path_in(name, path_env)
        .map_err(|e| otter_shared_platform::exec_error(name, e))
}

async fn run_host(ctx: &Ctx, name: &str, args: &[String], env: &[String], dir: &str) -> ExecResult {
    let fail = |e: String| ExecResult {
        out: Vec::new(),
        err: Some(e),
    };
    let key = if cfg!(windows) { "path" } else { "PATH" };
    let path = match host_exe_in(name, &std::env::var(key).unwrap_or_default()) {
        Ok(p) => p,
        Err(e) => return fail(e),
    };
    let (reader, writer) = match std::io::pipe() {
        Ok(p) => p,
        Err(e) => return fail(otter_gocompat::oserr::go_error_string(&e)),
    };
    let writer2 = match writer.try_clone() {
        Ok(w) => w,
        Err(e) => return fail(otter_gocompat::oserr::go_error_string(&e)),
    };
    let mut cmd = tokio::process::Command::new(&path);
    cmd.args(args)
        .current_dir(dir)
        .stdin(Stdio::null())
        .stdout(writer)
        .stderr(writer2)
        .kill_on_drop(true);
    for kv in env {
        if let Some((k, v)) = kv.split_once('=') {
            cmd.env(k, v);
        }
    }
    let spawned = cmd.spawn();
    // 부모가 쥔 쓰기 끝을 닫아야 자식이 끝날 때 읽기가 끝난다.
    drop(cmd);
    let mut child = match spawned {
        Ok(c) => c,
        Err(e) => {
            return fail(format!(
                "fork/exec {path}: {}",
                otter_gocompat::oserr::go_error_string(&e)
            ));
        }
    };

    let out = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&out);
    let mut copier = tokio::task::spawn_blocking(move || {
        let mut reader = reader;
        let mut buf = [0u8; 8192];
        loop {
            match std::io::Read::read(&mut reader, &mut buf) {
                Ok(0) | Err(_) => return,
                Ok(n) => {
                    if let Ok(mut o) = sink.lock() {
                        o.extend_from_slice(&buf[..n]);
                    }
                }
            }
        }
    });

    let mut ctx_err = None;
    let status = tokio::select! {
        s = child.wait() => s,
        e = ctx.done() => {
            ctx_err = Some(e);
            let _ = child.start_kill();
            child.wait().await
        }
    };
    let io_done = tokio::time::timeout(INSTALL_WAIT_DELAY, &mut copier)
        .await
        .is_ok();
    let out = out.lock().map(|o| o.clone()).unwrap_or_default();

    let mut err = match &status {
        Ok(st) if st.success() => None,
        Ok(st) => Some(exit_text(st)),
        Err(e) => Some(otter_gocompat::oserr::go_error_string(e)),
    };
    // Go: 취소로 죽였으면 ctx 의 오류가 앞선다. 끝났는데 파이프가 남았으면 WaitDelay 오류다.
    if let Some(e) = ctx_err
        && status.as_ref().is_ok_and(|s| !s.success())
    {
        err = Some(e.to_string());
    }
    if err.is_none() && !io_done {
        err = Some(ERR_WAIT_DELAY.to_owned());
    }
    ExecResult { out, err }
}

/// Go `ProcessState.String()`.
fn exit_text(st: &std::process::ExitStatus) -> String {
    otter_shared_platform::exit_status_text(st)
}

/// 조달의 결과 (FR-EXT-18). 사유가 있는 것이 규칙이다.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct Outcome {
    pub ok: bool,
    /// 사람의 말로 적은 사유.
    #[serde(skip_serializing_if = "is_empty")]
    pub reason: String,
    /// 도구가 낸 출력의 끝쪽 — 실제 원인이 거기 있다.
    #[serde(skip_serializing_if = "is_empty")]
    pub detail: String,
    /// 성공했을 때 선 실행 파일 하나.
    #[serde(skip_serializing_if = "is_empty")]
    pub exe: String,
}

pub(crate) fn fail(reason: String) -> Outcome {
    Outcome {
        reason,
        ..Outcome::default()
    }
}

fn ok() -> Outcome {
    Outcome {
        ok: true,
        ..Outcome::default()
    }
}

/// 조달기.
#[derive(Clone)]
pub struct Installer {
    /// 격리 칸.
    pub root: String,
    pub fetch: Arc<dyn Fetch>,
    pub exec: Arc<dyn Exec>,
    pub look_path: LookPath,
    /// 0 이면 [`INSTALL_TIMEOUT`].
    pub timeout: Duration,
    pub(crate) opts: Opts,
}

impl Installer {
    /// 실제 네트워크·프로세스를 쓰는 Installer.
    pub fn new(root: &str) -> Self {
        Self {
            root: root.to_owned(),
            fetch: Arc::new(HttpFetch),
            exec: Arc::new(HostExec),
            look_path: host_look_path(),
            timeout: Duration::ZERO,
            opts: Opts::default(),
        }
    }

    /// 팩 하나를 조달한다. 단위가 팩인 것은 조달물이 하나이기 때문이다 (FR-EXT-5).
    pub async fn install(&self, ctx: &Ctx, m: &Manifest, runtimes: &[Manifest]) -> Outcome {
        if self.root.is_empty() {
            return fail("격리 칸이 정해지지 않았습니다".to_owned());
        }
        if m.kind != KIND_SERVER {
            return fail(format!("{} 는 서버를 내는 팩이 아닙니다", m.id));
        }
        let to = if self.timeout.is_zero() {
            INSTALL_TIMEOUT
        } else {
            self.timeout
        };
        let cctx = ctx.with_timeout(to);

        // FR-EXT-7·7b: 런타임이 먼저다. 없을 때만 받는다.
        for need in &m.needs {
            let out = self.ensure_runtime(&cctx, need, runtimes).await;
            if !out.ok {
                return out;
            }
        }

        let mut detail = String::new();
        match m.source.kind.as_str() {
            SOURCE_ARCHIVE => {
                let target = current_target();
                let Some(t) = m.source.targets.get(&target) else {
                    return fail(format!(
                        "{}: 이 플랫폼({target})의 조달처가 선언에 없습니다",
                        m.id
                    ));
                };
                if let Err(e) = fetch_archive_with(
                    &cctx,
                    self.fetch.as_ref(),
                    t,
                    &plugin_dir(&self.root, &m.id),
                    &cache_dir(&self.root),
                    self.opts,
                )
                .await
                {
                    return Outcome {
                        reason: format!("{} 를 받지 못했습니다", m.id),
                        detail: e.to_string(),
                        ..Outcome::default()
                    };
                }
            }
            SOURCE_NPM => {
                let (out, d) = self.install_npm(&cctx, m, runtimes).await;
                detail = d;
                if !out.ok {
                    return out;
                }
            }
            SOURCE_TOOLCHAIN => {
                let (out, d) = self.install_toolchain(&cctx, m).await;
                detail = d;
                if !out.ok {
                    return out;
                }
            }
            other => {
                return fail(format!(
                    "{}: 모르는 조달 방법입니다: {}",
                    m.id,
                    otter_gocompat::strconv::quote(other)
                ));
            }
        }

        if cctx.err() == Some(crate::ctx::CtxError::DeadlineExceeded) {
            return Outcome {
                reason: format!(
                    "{} 조달이 {} 안에 끝나지 않아 중단했습니다",
                    m.id,
                    format_std_duration(to)
                ),
                detail,
                ..Outcome::default()
            };
        }

        // FR-EXT-19: 성공의 판정은 실행 파일의 존재다. 팩의 **모든** 서버를 본다 (FR-EXT-5).
        let mut first = String::new();
        for s in &m.servers {
            let p = managed_exe_found(&self.root, m, s);
            if p.is_empty() {
                return Outcome {
                    reason: format!("{} 는 끝났는데 {} 가 놓이지 않았습니다", m.id, s.exe),
                    detail,
                    ..Outcome::default()
                };
            }
            if first.is_empty() {
                first = p;
            }
        }
        Outcome {
            ok: true,
            exe: first,
            detail,
            ..Outcome::default()
        }
    }

    /// 런타임 하나를 확보한다. 있으면 아무것도 하지 않는다. 같은 런타임의 조달은 직렬이다 (FR-ATF-21).
    pub(crate) async fn ensure_runtime(
        &self,
        ctx: &Ctx,
        id: &str,
        runtimes: &[Manifest],
    ) -> Outcome {
        let target = current_target();
        let ready = || runtime_ready_in(&self.root, Some(&self.look_path), runtimes, id, &target);
        if ready() {
            return ok();
        }
        let lock = runtime_lock(&filepath::join(&[self.root.as_str(), id]));
        let _held = lock.lock().await;
        if ready() {
            return ok();
        }
        let Some(rt) = runtimes
            .iter()
            .find(|c| c.id == id && c.kind == KIND_RUNTIME)
        else {
            return fail(format!("{id} 가 없고 받는 방법도 선언돼 있지 않습니다"));
        };
        let Some(t) = rt.source.targets.get(&target) else {
            return fail(format!(
                "{id}: 이 플랫폼({target})의 조달처가 선언에 없습니다"
            ));
        };
        if let Err(e) = fetch_archive_with(
            ctx,
            self.fetch.as_ref(),
            t,
            &runtime_dir(&self.root, rt),
            &cache_dir(&self.root),
            self.opts,
        )
        .await
        {
            return Outcome {
                reason: format!("{id} 를 받지 못했습니다"),
                detail: e.to_string(),
                ..Outcome::default()
            };
        }
        ok()
    }

    /// **그 런타임의 npm** 으로 받는다 (FR-EXT-12).
    async fn install_npm(
        &self,
        ctx: &Ctx,
        m: &Manifest,
        runtimes: &[Manifest],
    ) -> (Outcome, String) {
        let (name, pre, prepend) = match self.npm_command(runtimes) {
            Some(c) => c,
            None => return (fail("npm 을 찾지 못했습니다".to_owned()), String::new()),
        };
        let dir = plugin_dir(&self.root, &m.id);
        if let Err(e) = goos::mkdir_all(&dir, 0o755) {
            return (
                Outcome {
                    reason: "팩의 자리를 만들지 못했습니다".to_owned(),
                    detail: crate::error::Error::from(e).to_string(),
                    ..Outcome::default()
                },
                String::new(),
            );
        }
        let mut args = pre;
        args.push("install".to_owned());
        args.extend(m.source.packages.iter().cloned());
        args.push("--prefix".to_owned());
        args.push(dir.clone());
        let base_path = std::env::var("PATH").unwrap_or_default();
        let env = isolated_env_with_path(&self.root, m, &prepend, &base_path);
        let r = self.exec.exec(ctx, &name, &args, &env, &dir).await;
        let detail = tail(&r);
        if r.err.is_some() {
            return (
                Outcome {
                    reason: format!("{} 를 받지 못했습니다", m.id),
                    detail: detail.clone(),
                    ..Outcome::default()
                },
                detail,
            );
        }
        (ok(), detail)
    }

    /// npm 을 부를 방법: 우리 런타임이 있으면 `node <npm-cli>` 이고 PATH 앞에 그 bin 을 세운다.
    fn npm_command(&self, runtimes: &[Manifest]) -> Option<(String, Vec<String>, Vec<String>)> {
        let target = current_target();
        for rt in runtimes.iter().filter(|r| r.kind == KIND_RUNTIME) {
            let node = runtime_exe(&self.root, rt, "node", &target);
            let npm = runtime_exe(&self.root, rt, "npm", &target);
            if node.is_empty() || npm.is_empty() {
                continue;
            }
            let bin = filepath::dir(&node);
            return Some((node, vec![npm], vec![bin]));
        }
        // 우리 런타임이 없다 — 호스트의 npm 이 `needs` 를 채운 갈래다.
        (self.look_path)("npm")
            .filter(|p| !p.is_empty())
            .map(|p| (p, Vec::new(), Vec::new()))
    }

    /// 호스트 도구로 만든다 (FR-EXT-14). 없으면 그 이름으로 알린다.
    async fn install_toolchain(&self, ctx: &Ctx, m: &Manifest) -> (Outcome, String) {
        let tool = &m.source.tool;
        if (self.look_path)(tool).is_none() {
            return (
                fail(format!(
                    "{tool} 가 이 기계에 없어 {} 를 받을 수 없습니다 — {tool} 를 먼저 설치하세요",
                    m.id
                )),
                String::new(),
            );
        }
        let dir = plugin_dir(&self.root, &m.id);
        if let Err(e) = goos::mkdir_all(&dir, 0o755) {
            return (
                Outcome {
                    reason: "팩의 자리를 만들지 못했습니다".to_owned(),
                    detail: crate::error::Error::from(e).to_string(),
                    ..Outcome::default()
                },
                String::new(),
            );
        }
        let env = isolated_env(&self.root, m);
        let r = self.exec.exec(ctx, tool, &m.source.args, &env, &dir).await;
        let detail = tail(&r);
        // FR-EXT-23: 부산물은 실패했어도 버린다. 모듈 캐시는 남긴다 (FR-ATF-70).
        self.prune_build_cache();
        if r.err.is_some() {
            return (
                Outcome {
                    reason: format!("{tool} 가 {} 를 만들지 못했습니다", m.id),
                    detail: detail.clone(),
                    ..Outcome::default()
                },
                detail,
            );
        }
        (ok(), detail)
    }

    fn prune_build_cache(&self) {
        goos::remove_all(&filepath::join(&[
            cache_dir(&self.root).as_str(),
            CACHE_GO_BUILD,
        ]));
    }
}

/// 출력의 끝쪽 (FR-ATF-28). 깨진 조각을 버리고, 출력이 비면 오류 문장을 싣는다.
fn tail(r: &ExecResult) -> String {
    let b = otter_shared_diagtail::of(&r.out, r.err.as_deref(), OUTPUT_TAIL);
    String::from_utf8_lossy(&b).into_owned()
}

/// 런타임 조달의 직렬 구간. 열쇠는 격리 칸과 런타임 id 다. 런타임 수만큼이라 지우지 않는다.
fn runtime_lock(key: &str) -> Arc<tokio::sync::Mutex<()>> {
    static LOCKS: LazyLock<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> =
        LazyLock::new(|| Mutex::new(HashMap::new()));
    let mut m = LOCKS.lock().unwrap_or_else(|e| e.into_inner());
    Arc::clone(m.entry(key.to_owned()).or_default())
}
