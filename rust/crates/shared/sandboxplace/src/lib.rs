//! Go 기준선 `otterminal/internal/shared/sandboxplace` 의 Rust 포팅. RUST_PORT_SRS 참고.
//!
//! 샌드박스 창의 도구를 컨테이너 안에 배치한다 (SANDBOX_SRS FR-SBX-10). toolhub 의
//! 배치 함수([`Placer::placer_fn`])로 걸린다.

use std::collections::{HashMap, HashSet};
use std::io;
use std::path::Path;
use std::sync::{Arc, RwLock};

use otter_shared_otterlog::{errorf, infof};
use otter_shared_platform::ProcSpec;
use otter_shared_sandbox::{
    self as sandbox, Config, Error, HelperDeps, Manager, Profile, ProfileInfo, RunSpec, WorkKind,
};
use otter_shared_toolhub::{Placement, PlacerFn};

pub type StatFn = Arc<dyn Fn(&str) -> bool + Send + Sync>;

/// 한 인스턴스의 샌드박스 배치다.
pub struct Placer {
    mgr: Manager,
    docker: String,
    profiles: RwLock<HashMap<String, Profile>>,
    helper: HelperDeps,
    port: String,
    home: String,
    stat: StatFn,
}

/// Go `os.UserHomeDir`.
fn user_home() -> Option<String> {
    std::env::var(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .ok()
        .filter(|h| !h.is_empty())
}

impl Placer {
    pub fn new(
        mgr: Manager,
        docker_path: &str,
        profiles: HashMap<String, Profile>,
        helper: HelperDeps,
        port: &str,
        home: &str,
    ) -> Self {
        Self {
            mgr,
            docker: docker_path.into(),
            profiles: RwLock::new(profiles),
            helper,
            port: port.into(),
            home: home.into(),
            stat: Arc::new(|p| std::fs::metadata(p).is_ok()),
        }
    }

    /// 경로 존재 확인을 갈아 끼운다(검사).
    pub fn set_stat(&mut self, f: StatFn) {
        self.stat = f;
    }

    fn profile_by_name(&self, name: &str) -> Option<Profile> {
        self.profiles
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .get(name)
            .cloned()
    }

    fn config_path(&self) -> String {
        otter_gocompat::filepath::join(&[self.home.as_str(), sandbox::PROFILES_FILE_NAME])
    }

    /// 지금의 sandbox.json 이다. 없으면 빈 설정이다.
    pub fn config(&self) -> Result<Config, Error> {
        let path = self.config_path();
        match std::fs::read(&path) {
            Ok(blob) => sandbox::parse_config(&blob, &user_home),
            Err(e) if e.kind() == io::ErrorKind::NotFound => sandbox::parse_config(b"", &user_home),
            Err(e) => Err(Error::Msg(otter_gocompat::oserr::go_error_string(
                &otter_gocompat::oserr::path_error("open", &path, e),
            ))),
        }
    }

    /// 검증한 뒤 정규화해 저장하고 곧바로 반영한다. 쓰기 실패는 `SaveFailed` 다.
    pub fn save_config(&self, blob: &[u8]) -> Result<(), Error> {
        let cfg = sandbox::parse_config(blob, &user_home)?;
        let out = cfg.encode().map_err(|e| Error::Msg(e.to_string()))?;
        if let Err(e) =
            otter_shared_platform::write_state_file(Path::new(&self.config_path()), &out, 0o644)
        {
            infof!(None, "sandbox SaveConfig: {e}");
            return Err(Error::SaveFailed);
        }
        *self.profiles.write().unwrap_or_else(|e| e.into_inner()) = cfg.profiles();
        Ok(())
    }

    /// 컨테이너를 마련하고 그 안의 셸을 여는 명령을 돌려준다. 실패하면 호스트로 내려가지 않는다 (FR-SBX-21).
    pub fn place(&self, pl: &Placement) -> Result<ProcSpec, Error> {
        let Some(mut prof) = self.profile_by_name(&pl.profile) else {
            return Err(Error::Msg(format!(
                "샌드박스 프로파일 {} 가 정의되지 않았습니다 — {} 에 이미지를 적어 주세요",
                otter_gocompat::strconv::quote(&pl.profile),
                sandbox::PROFILES_FILE_NAME
            )));
        };
        // UX_BATCH6_SRS FR-SBM-3: 창이 고른 작업 방식이 이긴다. 모르는 값은 무시한다.
        if let Some(w) = WorkKind::parse(&pl.work) {
            prof.work = w;
        }
        sandbox::verify_mounts(&prof.base_mounts, &*self.stat)?;
        if prof.work != WorkKind::None && !pl.host_dir.is_empty() && !(self.stat)(&pl.host_dir) {
            return Err(Error::Msg(format!("작업 폴더가 없습니다: {}", pl.host_dir)));
        }
        sandbox::verify_copy_source(
            &prof,
            &pl.host_dir,
            sandbox::COPY_MAX_BYTES,
            sandbox::COPY_MAX_FILES,
        )?;
        let mut rs = RunSpec {
            host_dir: pl.host_dir.clone(),
            ..Default::default()
        };
        if prof.helper {
            rs.helper_path = sandbox::ensure_helper(&self.helper)?;
            let addr = otter_shared_serverconf::addr_path(Path::new(&self.home));
            if let Some(dir) = addr.parent()
                && mkdir_0700(dir).is_ok()
            {
                rs.addr_dir = dir.to_string_lossy().into_owned();
            }
        }
        self.mgr.ensure(&pl.window_uuid, &prof, &rs)?;
        let env = sandbox::ExecEnv {
            tool_id: pl.tool_id.clone(),
            port: self.port.clone(),
        };
        Ok(self
            .mgr
            .exec_spec(&pl.window_uuid, &self.docker, &prof, &rs, &env))
    }

    /// toolhub `ToolManager::set_placer` 에 거는 함수다.
    pub fn placer_fn(self: &Arc<Self>) -> PlacerFn {
        let p = Arc::clone(self);
        Arc::new(move |pl: &Placement| p.place(pl).map_err(|e| io::Error::other(e.to_string())))
    }

    /// 살아 있는 창이 아닌 컨테이너를 회수한다. live 가 `None` 이면(작업 공간을 모른다) 아무것도 하지 않는다.
    pub fn reap(&self, live: Option<&[String]>) {
        let Some(live) = live else {
            return;
        };
        let set: HashSet<String> = live.iter().cloned().collect();
        if let Err(e) = self.mgr.reap_orphans(&set) {
            errorf!(None, "[sandbox] 고아 컨테이너 회수 실패: {e}");
        }
    }

    /// 화면이 보는 프로파일 목록이다. scratch, dev 순이다.
    pub fn profiles(&self) -> Vec<ProfileInfo> {
        [sandbox::PROFILE_SCRATCH, sandbox::PROFILE_DEV]
            .iter()
            .filter_map(|n| self.profile_by_name(n).map(|p| p.info()))
            .collect()
    }

    /// 이 인스턴스의 컨테이너를 멈춘다(서버 종료).
    pub fn shutdown(&self) {
        if let Err(e) = self.mgr.stop_owned() {
            errorf!(None, "[sandbox] 컨테이너 정지 실패: {e}");
        }
    }
}

fn mkdir_0700(dir: &Path) -> io::Result<()> {
    let mut b = std::fs::DirBuilder::new();
    b.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut b, 0o700);
    b.create(dir)
}

/// 기동 배선이다. 런타임이 없으면 `None`(샌드박스 기능 꺼짐)이다.
pub fn wire(home: &str, version: &str, port: &str) -> Option<Arc<Placer>> {
    let docker = sandbox::find_runtime(&sandbox::look_path).ok()?;
    let path = otter_gocompat::filepath::join(&[home, sandbox::PROFILES_FILE_NAME]);
    let profiles =
        sandbox::load_profiles(&path, &|p| std::fs::read(p), &user_home).unwrap_or_else(|e| {
            infof!(None, "[sandbox] {}: {e}", sandbox::PROFILES_FILE_NAME);
            HashMap::from([(sandbox::PROFILE_SCRATCH.to_string(), sandbox::scratch())])
        });
    let helper = sandbox::default_helper_deps(home, version);
    sandbox::prune_helper_cache(&helper);
    let mgr = Manager::new(sandbox::cli_runner(&docker), home);
    Some(Arc::new(Placer::new(
        mgr,
        &docker,
        profiles,
        helper,
        &startup_port(home, port),
        home,
    )))
}

/// 컨테이너 안 otterctl 이 닿을 포트다: 준 값 → 주소 파일 → 설정 해석.
fn startup_port(home: &str, port: &str) -> String {
    if !port.is_empty() {
        return port.into();
    }
    if let Some((_, p)) = otter_shared_serverconf::read_addr(Path::new(home)) {
        return p;
    }
    otter_shared_serverconf::resolve(&otter_shared_serverconf::Inputs {
        home: Path::new(home),
        ..Default::default()
    })
    .port
    .value
}

#[cfg(test)]
mod tests;
