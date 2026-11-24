//! Go 기준선 `otterminal/internal/shared/sandbox` 의 Rust 포팅. RUST_PORT_SRS 참고.
//!
//! 창 단위 샌드박스 컨테이너의 수명(SANDBOX_SRS)이다. 컨테이너 런타임은 `docker` CLI 로만 다루며,
//! 실행 함수([`RunFn`])를 주입받으므로 검사는 가짜 런타임으로 돈다.

mod config;
mod copy;
mod exec;
mod helper;
mod mounts;
mod profiles;
mod runtime;

use std::collections::HashSet;
use std::fmt;
use std::sync::Arc;

use otter_shared_otterenv as otterenv;
use otter_shared_platform::ProcSpec;

pub use config::{Config, DevConfig, parse_config};
pub use copy::{COPY_MAX_BYTES, COPY_MAX_FILES, WorkKind, human_bytes, verify_copy_source};
pub use exec::{RunOutput, combined_output, exit_text};
pub use helper::{
    HELPER_MOUNT_PATH, HELPER_NAME, HelperDeps, default_helper_deps, ensure_helper,
    helper_cache_path, prune_helper_cache,
};
pub use mounts::{Mount, parse_mount, verify_mounts};
pub use profiles::{
    CONTAINER_WORKDIR, PICKABLE_WORKS, PROFILES_FILE_NAME, ProfileInfo, WorkPick, load_profiles,
    only_default, work_picks_of,
};
pub use runtime::{
    RUNTIME_MISSING, RUNTIME_OK, RUNTIME_STOPPED, RuntimeStatus, StartResult, cli_exec,
    install_command, probe, start_command, start_exec, start_runtime,
};

/// 런타임 CLI 한 번(인자 → 합친 출력·오류)이다.
pub type RunFn = Arc<dyn Fn(&[String]) -> RunOutput + Send + Sync>;
/// 실행 파일 한 번(경로, 인자 → 합친 출력·오류)이다.
pub type ExecFn<'a> = dyn Fn(&str, &[String]) -> RunOutput + 'a;
/// 사용자 홈이다. 모르면 `None` (Go `os.UserHomeDir` 의 오류).
pub type HomeFn<'a> = dyn Fn() -> Option<String> + 'a;

const NAME_PREFIX: &str = "otterminal-sbx-";
/// 컨테이너가 어느 인스턴스·창의 것인지 다는 라벨이다.
pub const LABEL_HOME: &str = "otterminal.home";
pub const LABEL_WINDOW: &str = "otterminal.window";
pub const PROFILE_SCRATCH: &str = "scratch";
pub const PROFILE_DEV: &str = "dev";
pub const SCRATCH_IMAGE: &str = "debian:stable-slim";
/// 컨테이너 안에서 호스트를 부르는 이름이다.
pub const HOST_GATEWAY: &str = otterenv::CONTAINER_HOST;
/// 컨테이너 자원 상한이다 (FR-SBX-7).
pub const LIMIT_CPUS: &str = "2";
pub const LIMIT_MEMORY: &str = "2g";
pub const LIMIT_PIDS: &str = "512";
const KEEP_ALIVE: [&str; 2] = ["sleep", "infinity"];

/// 샌드박스의 실패다. 문구는 Go 의 오류와 같다.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Error {
    /// `ErrSaveFailed`.
    SaveFailed,
    Msg(String),
}

impl Error {
    pub(crate) fn msg(s: impl Into<String>) -> Self {
        Self::Msg(s.into())
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::SaveFailed => f.write_str("샌드박스 정의를 저장하지 못했습니다"),
            Self::Msg(s) => f.write_str(s),
        }
    }
}

impl std::error::Error for Error {}

/// 컨테이너 한 종류의 정의다.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Profile {
    pub name: String,
    pub image: String,
    /// `none` | `bridge`.
    pub network: String,
    pub ports: Vec<String>,
    pub work: WorkKind,
    pub base_mounts: Vec<Mount>,
    /// 컨테이너 안에 otterctl 을 넣고 호스트 서버에 닿게 한다.
    pub helper: bool,
}

/// 격리 프로파일이다: 네트워크 없음, 작업 폴더는 복사.
pub fn scratch() -> Profile {
    Profile {
        name: PROFILE_SCRATCH.into(),
        image: SCRATCH_IMAGE.into(),
        network: "none".into(),
        work: WorkKind::Copy,
        ..Default::default()
    }
}

/// 컨테이너를 만들 때의 호스트 쪽 자리다.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RunSpec {
    pub host_dir: String,
    pub helper_path: String,
    pub addr_dir: String,
}

/// exec 에 싣는 도구 정체다.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ExecEnv {
    pub tool_id: String,
    pub port: String,
}

/// 한 인스턴스(home)의 샌드박스 컨테이너들이다.
pub struct Manager {
    run: RunFn,
    home: String,
}

fn s(v: &str) -> String {
    v.to_string()
}

fn trim(v: &str) -> &str {
    v.trim()
}

impl Manager {
    pub fn new(run: RunFn, home: &str) -> Self {
        Self {
            run,
            home: home.into(),
        }
    }

    pub(crate) fn run(&self, args: &[String]) -> RunOutput {
        (self.run)(args)
    }

    pub fn container_name(&self, window_uuid: &str) -> String {
        format!("{NAME_PREFIX}{window_uuid}")
    }

    /// 창의 컨테이너가 돌게 한다: 없으면 만들고, 멈췄으면 시작한다.
    pub fn ensure(&self, window_uuid: &str, p: &Profile, rs: &RunSpec) -> Result<(), Error> {
        let name = self.container_name(window_uuid);
        let r = self.run(&[s("inspect"), s("-f"), s("{{.State.Status}}"), name.clone()]);
        if r.err.is_some() {
            if runtime_down(&r.out) {
                return Err(Error::msg(format!(
                    "컨테이너 런타임에 연결할 수 없습니다(실행 중인지 확인하세요): {}",
                    trim(&r.out)
                )));
            }
            return self.create(&name, window_uuid, p, rs);
        }
        if trim(&r.out) == "running" {
            return Ok(());
        }
        let r = self.run(&[s("start"), name]);
        if let Some(e) = r.err {
            return Err(Error::msg(format!(
                "샌드박스 컨테이너를 시작하지 못했습니다: {e}: {}",
                trim(&r.out)
            )));
        }
        Ok(())
    }

    fn create(
        &self,
        name: &str,
        window_uuid: &str,
        p: &Profile,
        rs: &RunSpec,
    ) -> Result<(), Error> {
        if p.image.is_empty() {
            return Err(Error::msg(format!(
                "샌드박스 프로파일 {} 에 이미지가 지정되지 않았습니다",
                otter_gocompat::strconv::quote(&p.name)
            )));
        }
        let mut args = vec![
            s("run"),
            s("-d"),
            s("--init"),
            s("--name"),
            s(name),
            s("--label"),
            format!("{LABEL_HOME}={}", self.home),
            s("--label"),
            format!("{LABEL_WINDOW}={window_uuid}"),
            s("--cpus"),
            s(LIMIT_CPUS),
            s("--memory"),
            s(LIMIT_MEMORY),
            s("--pids-limit"),
            s(LIMIT_PIDS),
        ];
        if !p.network.is_empty() {
            args.extend([s("--network"), p.network.clone()]);
        }
        if p.work == WorkKind::Mount && !rs.host_dir.is_empty() {
            args.extend([s("-v"), format!("{}:{CONTAINER_WORKDIR}", rs.host_dir)]);
        }
        for mt in &p.base_mounts {
            args.extend([s("-v"), mt.arg()]);
        }
        if p.helper && !rs.helper_path.is_empty() {
            args.extend([
                s("-v"),
                format!("{}:{HELPER_MOUNT_PATH}:ro", rs.helper_path),
            ]);
            if !rs.addr_dir.is_empty() {
                args.extend([
                    s("-v"),
                    format!("{}:{}:ro", rs.addr_dir, otterenv::CONTAINER_ADDR_DIR),
                ]);
            }
            args.extend([s("--add-host"), format!("{HOST_GATEWAY}:host-gateway")]);
        }
        for port in &p.ports {
            args.extend([s("-p"), format!("{port}:{port}")]);
        }
        args.push(p.image.clone());
        args.extend(KEEP_ALIVE.iter().map(|a| s(a)));
        let r = self.run(&args);
        if let Some(e) = r.err {
            if name_taken(&r.out) {
                return Ok(());
            }
            return Err(Error::msg(format!(
                "샌드박스 컨테이너를 만들지 못했습니다(이미지 {}): {e}: {}",
                p.image,
                trim(&r.out)
            )));
        }
        if let Err(e) = self.copy_work(name, p, rs) {
            let _ = self.run(&[s("rm"), s("-f"), s(name)]);
            return Err(e);
        }
        Ok(())
    }

    /// 창의 컨테이너에서 로그인 셸을 여는 명령이다.
    pub fn exec_spec(
        &self,
        window_uuid: &str,
        docker_path: &str,
        p: &Profile,
        rs: &RunSpec,
        env: &ExecEnv,
    ) -> ProcSpec {
        let name = self.container_name(window_uuid);
        let mut args = vec![
            s(docker_path),
            s("exec"),
            s("-it"),
            s("-e"),
            s("TERM=xterm-256color"),
        ];
        if p.helper {
            args.extend([
                s("-e"),
                format!("{}={HOST_GATEWAY}", otterenv::ENV_HOST),
                s("-e"),
                format!("{}={}", otterenv::ENV_PORT, env.port),
                s("-e"),
                format!("{}={}", otterenv::ENV_TOOL_ID, env.tool_id),
            ]);
        }
        if p.work != WorkKind::None && !rs.host_dir.is_empty() {
            args.extend([s("-w"), s(CONTAINER_WORKDIR)]);
        }
        args.extend([name, s("bash"), s("-l")]);
        ProcSpec {
            path: s(docker_path),
            args,
            env: vec![],
            dir: String::new(),
        }
    }

    /// 창의 컨테이너를 지운다. 실패는 무시한다.
    pub fn remove(&self, window_uuid: &str) {
        let _ = self.run(&[s("rm"), s("-f"), self.container_name(window_uuid)]);
    }

    /// 이 인스턴스의 컨테이너 중 live 에 없는 창의 것을 지운다.
    pub fn reap_orphans(&self, live: &HashSet<String>) -> Result<(), Error> {
        let r = self.run(&[
            s("ps"),
            s("-a"),
            s("--filter"),
            format!("label={LABEL_HOME}={}", self.home),
            s("--format"),
            format!("{{{{.Names}}}} {{{{.Label \"{LABEL_WINDOW}\"}}}}"),
        ]);
        if let Some(e) = r.err {
            return Err(Error::msg(format!(
                "샌드박스 컨테이너를 조회하지 못했습니다: {e}"
            )));
        }
        for line in r.out.split('\n') {
            let Some((name, window)) = line.trim().split_once(' ') else {
                continue;
            };
            if name.is_empty() || window.is_empty() || live.contains(window) {
                continue;
            }
            let _ = self.run(&[s("rm"), s("-f"), s(name)]);
        }
        Ok(())
    }

    /// 이 인스턴스의 컨테이너를 모두 멈춘다(지우지 않는다).
    pub fn stop_owned(&self) -> Result<(), Error> {
        for name in self.owned_names()? {
            let _ = self.run(&[s("stop"), name]);
        }
        Ok(())
    }

    fn owned_names(&self) -> Result<Vec<String>, Error> {
        let r = self.run(&[
            s("ps"),
            s("-a"),
            s("--filter"),
            format!("label={LABEL_HOME}={}", self.home),
            s("--format"),
            s("{{.Names}}"),
        ]);
        if let Some(e) = r.err {
            return Err(Error::msg(format!(
                "샌드박스 컨테이너를 조회하지 못했습니다: {e}"
            )));
        }
        Ok(r.out
            .split('\n')
            .map(str::trim)
            .filter(|n| !n.is_empty())
            .map(s)
            .collect())
    }
}

fn name_taken(out: &str) -> bool {
    out.to_lowercase().contains("is already in use")
}

fn runtime_down(out: &str) -> bool {
    let low = out.to_lowercase();
    low.contains("cannot connect")
        || low.contains("is the docker daemon running")
        || low.contains("docker daemon is not running")
}

/// 컨테이너 런타임(docker)의 경로다.
pub fn find_runtime(look: &dyn Fn(&str) -> Result<String, String>) -> Result<String, Error> {
    look("docker")
        .map_err(|e| Error::msg(format!("컨테이너 런타임(docker)을 찾을 수 없습니다: {e}")))
}

/// Go `exec.LookPath`. 실패 문구도 Go 와 같다.
pub fn look_path(name: &str) -> Result<String, String> {
    let key = if cfg!(windows) { "path" } else { "PATH" };
    look_path_in(name, &std::env::var(key).unwrap_or_default())
}

fn look_path_in(name: &str, path_env: &str) -> Result<String, String> {
    otter_shared_platform::try_look_path_in(name, path_env)
        .map_err(|e| otter_shared_platform::exec_error(name, e))
}

/// docker CLI 를 실행하는 [`RunFn`] 이다.
pub fn cli_runner(docker_path: &str) -> RunFn {
    let path = docker_path.to_string();
    Arc::new(move |args: &[String]| combined_output(&path, args, None))
}

#[cfg(test)]
mod tests;
