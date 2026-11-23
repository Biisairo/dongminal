//! 격리 칸의 배치와 실행 파일 탐색 (FR-EXT-20·27·28·29).

use std::collections::HashMap;
use std::sync::Arc;

use dm_gocompat::filepath;
use dm_gocompat::json::is_empty;
use serde::Serialize;

use crate::env::managed_bin_dir;
use crate::manifest::{
    KIND_RUNTIME, Manifest, SOURCE_ARCHIVE, SOURCE_NPM, SOURCE_TOOLCHAIN, Server, current_target,
};

// 격리 칸의 배치다 (FR-EXT-20). 이 셋 밖에는 아무것도 쓰지 않는다 (FR-EXT-22).
const PLUGINS_SUB: &str = "plugins";
const RUNTIMES_SUB: &str = "runtimes";
const CACHE_SUB: &str = "cache";

/// 데이터 디렉터리 아래 격리 칸의 이름.
pub const DIR_NAME: &str = dm_shared_dmenv::EXT_DIR;

/// 실행 파일 이름으로 찾는다. Go `exec.LookPath` 이며, 찾지 못하면 `None` 이다. 검사가 바꿔 끼운다.
pub type LookPath = Arc<dyn Fn(&str) -> Option<String> + Send + Sync>;

/// 실제 PATH 를 쓰는 [`LookPath`].
pub fn host_look_path() -> LookPath {
    Arc::new(dm_shared_platform::look_path)
}

/// 데이터 디렉터리 아래 격리 칸.
pub fn root_in(data_dir: &str) -> String {
    filepath::join(&[data_dir, DIR_NAME])
}

/// 팩들이 사는 자리.
pub fn plugins_dir(root: &str) -> String {
    filepath::join(&[root, PLUGINS_SUB])
}

/// 팩 하나의 자리. id 가 디렉터리 이름이 된다 (FR-EXT-39).
pub fn plugin_dir(root: &str, id: &str) -> String {
    filepath::join(&[plugins_dir(root).as_str(), id])
}

/// 런타임들이 사는 자리.
pub fn runtimes_dir(root: &str) -> String {
    filepath::join(&[root, RUNTIMES_SUB])
}

/// 런타임 하나의 자리. 판과 **이 빌드의** 타깃이 이름에 박힌다 (FR-EXT-24).
pub fn runtime_dir(root: &str, m: &Manifest) -> String {
    let name = format!("{}-{}-{}", m.id, m.version, current_target());
    filepath::join(&[runtimes_dir(root).as_str(), &name])
}

/// 조달·실행이 쓰는 캐시의 자리 (FR-EXT-21).
pub fn cache_dir(root: &str) -> String {
    filepath::join(&[root, CACHE_SUB])
}

/// 사용자가 설정에 적은 절대경로 (①).
pub const ORIGIN_CONFIG: &str = "config";
/// PATH (②). 격리되지 않은 갈래다.
pub const ORIGIN_PATH: &str = "path";
/// 격리 칸의 조달물 (③).
pub const ORIGIN_MANAGED: &str = "managed";

/// `needs` 의 런타임이 없다.
pub const MISSING_RUNTIME: &str = "runtime";
/// toolchain 조달의 호스트 도구가 없다.
pub const MISSING_TOOL: &str = "tool";
/// 이 플랫폼의 조달처가 선언에 없다.
pub const MISSING_TARGET: &str = "target";
/// 아무것도 막지 않는데 아직 받지 않았다.
pub const MISSING_NOT_FETCHED: &str = "not-fetched";

/// 없는 것을 이름과 함께 말한다 (FR-EXT-29).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct Missing {
    pub kind: String,
    #[serde(skip_serializing_if = "is_empty")]
    pub name: String,
}

/// 서버 하나에 대한 **관측** (FR-EXT-33). JSON 은 Go 와 같은 키·순서·생략 규칙이다.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub pack: String,
    pub id: String,
    #[serde(skip_serializing_if = "is_empty")]
    pub langs: Vec<String>,
    #[serde(skip_serializing_if = "is_empty")]
    pub exts: Vec<String>,
    pub found: bool,
    #[serde(skip_serializing_if = "is_empty")]
    pub exe: String,
    #[serde(skip_serializing_if = "is_empty")]
    pub origin: String,
    /// 우리 칸 안의 것인가 (FR-EXT-28).
    pub isolated: bool,
    #[serde(skip_serializing_if = "is_empty")]
    pub needs: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub missing: Option<Missing>,
    /// Missing 을 사람의 말로 옮긴 것 (FR-EXT-29).
    #[serde(skip_serializing_if = "is_empty")]
    pub note: String,
    pub can_install: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub installing: bool,
}

/// 실행 파일을 찾는다. PATH 와 파일시스템을 주입받는다.
#[derive(Clone)]
pub struct Locator {
    /// 격리 칸 (`<데이터>/ext`).
    pub root: String,
    pub look_path: LookPath,
    /// 사용자가 설정에 적은 절대경로 (팩/서버 → 경로, FR-LSP-4b).
    pub overrides: HashMap<String, String>,
    /// 이 기계가 아는 런타임 팩들.
    pub runtimes: Vec<Manifest>,
    /// 비면 이 빌드의 타깃이다. 검사가 다른 플랫폼을 재는 자리다.
    pub target: String,
}

impl Locator {
    /// 실제 PATH 를 쓰는 Locator.
    pub fn new(root: &str, overrides: HashMap<String, String>, runtimes: Vec<Manifest>) -> Self {
        Self {
            root: root.to_owned(),
            look_path: host_look_path(),
            overrides,
            runtimes,
            target: String::new(),
        }
    }

    fn target(&self) -> String {
        if self.target.is_empty() {
            current_target()
        } else {
            self.target.clone()
        }
    }

    /// FR-EXT-27 의 순서(①설정 ②PATH ③격리 칸)로 찾고 조달 판정을 얹는다.
    pub fn locate(&self, m: &Manifest, s: &Server) -> Status {
        let mut st = self.find(m, s);
        let (can, missing) = self.readiness(m);
        with_readiness(&mut st, can, missing);
        st
    }

    /// 실행 파일만 찾는다 — 찾으면 멈추고 조달 가능성은 따지지 않는다 (FR-OPT-6-4).
    pub(crate) fn find(&self, m: &Manifest, s: &Server) -> Status {
        let mut st = Status {
            pack: m.id.clone(),
            id: s.id.clone(),
            langs: s.langs.clone(),
            exts: s.exts.clone(),
            needs: m.needs.clone(),
            ..Status::default()
        };
        // ① 키는 팩/서버다 — 서버 id 만으로는 다른 팩의 같은 id 에 번진다.
        if let Some(p) = self.overrides.get(&format!("{}/{}", m.id, s.id))
            && !p.is_empty()
            && is_executable(p)
        {
            (st.found, st.exe, st.origin) = (true, p.clone(), ORIGIN_CONFIG.to_owned());
        }
        if !st.found
            && let Some(p) = (self.look_path)(&s.exe)
            && !p.is_empty()
        {
            (st.found, st.exe, st.origin) = (true, p, ORIGIN_PATH.to_owned());
        }
        if !st.found {
            let p = managed_exe_found(&self.root, m, s);
            if !p.is_empty() {
                (st.found, st.exe, st.origin) = (true, p, ORIGIN_MANAGED.to_owned());
            }
        }
        st.isolated = st.origin == ORIGIN_MANAGED;
        st
    }

    /// 지금 조달할 수 있는가와, 없다면 무엇이 없는가. 팩 단위다 (FR-EXT-5).
    pub(crate) fn readiness(&self, m: &Manifest) -> (bool, Missing) {
        for need in &m.needs {
            if !self.runtime_ready(need) {
                return (false, missing(MISSING_RUNTIME, need));
            }
        }
        match m.source.kind.as_str() {
            SOURCE_TOOLCHAIN if (self.look_path)(&m.source.tool).is_none() => {
                return (false, missing(MISSING_TOOL, &m.source.tool));
            }
            SOURCE_ARCHIVE => {
                let t = self.target();
                if !m.source.targets.contains_key(&t) {
                    return (false, missing(MISSING_TARGET, &t));
                }
            }
            _ => {}
        }
        (true, missing(MISSING_NOT_FETCHED, ""))
    }

    fn runtime_ready(&self, id: &str) -> bool {
        runtime_ready_in(
            &self.root,
            Some(&self.look_path),
            &self.runtimes,
            id,
            &self.target(),
        )
    }

    /// 격리 칸에 받아 둔 런타임이 내는 것 하나의 자리.
    pub fn runtime_exe(&self, rt: &Manifest, name: &str) -> String {
        runtime_exe(&self.root, rt, name, &self.target())
    }
}

fn missing(kind: &str, name: &str) -> Missing {
    Missing {
        kind: kind.to_owned(),
        name: name.to_owned(),
    }
}

/// 팩의 조달 판정을 관측에 얹는다. 찾았으면 "없는 것" 을 말하지 않는다.
pub(crate) fn with_readiness(st: &mut Status, can_install: bool, missing: Missing) {
    st.can_install = can_install;
    if !st.found {
        st.missing = Some(missing);
    }
}

/// 탐색과 조달이 **함께 쓰는** 런타임 판정. 호스트의 것을 먼저 본다.
pub(crate) fn runtime_ready_in(
    root: &str,
    look: Option<&LookPath>,
    rts: &[Manifest],
    id: &str,
    target: &str,
) -> bool {
    if let Some(look) = look
        && look(id).is_some()
    {
        return true;
    }
    rts.iter()
        .filter(|rt| rt.id == id && rt.kind == KIND_RUNTIME)
        .any(|rt| {
            let p = runtime_exe(root, rt, id, target);
            !p.is_empty() && is_executable(&p)
        })
}

/// 격리 칸에 받아 둔 런타임이 내는 것 하나의 자리. 실행 비트는 보지 않는다 — npm 은 `npm-cli.js` 다.
pub fn runtime_exe(root: &str, rt: &Manifest, name: &str, target: &str) -> String {
    let Some(t) = rt.source.targets.get(target) else {
        return String::new();
    };
    let Some(rel) = t.provides.get(name) else {
        return String::new();
    };
    let p = filepath::join(&[
        runtime_dir(root, rt).as_str(),
        filepath::from_slash(rel).as_str(),
    ]);
    if !crate::goos::exists(&p) {
        return String::new();
    }
    p
}

/// 격리 칸에서 이 서버의 실행 파일이 놓일 자리. 조달의 성공 판정과 탐색이 이 하나를 쓴다 (FR-EXT-19).
pub fn managed_exe(root: &str, m: &Manifest, s: &Server) -> String {
    managed_exe_candidates(root, m, s)
        .into_iter()
        .next()
        .unwrap_or_default()
}

/// 후보 중 실제로 있고 실행할 수 있는 것 (FR-LWP-7).
pub fn managed_exe_found(root: &str, m: &Manifest, s: &Server) -> String {
    managed_exe_candidates(root, m, s)
        .into_iter()
        .find(|p| is_executable(p))
        .unwrap_or_default()
}

fn exe_suffix() -> &'static str {
    dm_shared_platform::current().paths.exe_suffix()
}

fn managed_exe_candidates(root: &str, m: &Manifest, s: &Server) -> Vec<String> {
    if root.is_empty() {
        return Vec::new();
    }
    let dir = plugin_dir(root, &m.id);
    let suffix = exe_suffix();
    match m.source.kind.as_str() {
        SOURCE_NPM => {
            let bin = filepath::join(&[dir.as_str(), "node_modules", ".bin"]);
            if suffix.is_empty() {
                return vec![filepath::join(&[bin.as_str(), &s.exe])];
            }
            // Windows: `.cmd` 가 셸 없이 실행되는 shim 이다.
            vec![filepath::join(&[bin.as_str(), &format!("{}.cmd", s.exe)])]
        }
        SOURCE_TOOLCHAIN => vec![filepath::join(&[
            managed_bin_dir(root, m).as_str(),
            &format!("{}{suffix}", s.exe),
        ])],
        SOURCE_ARCHIVE => {
            let p = archive_exe(root, m, s, &current_target());
            if p.is_empty() { Vec::new() } else { vec![p] }
        }
        _ => Vec::new(),
    }
}

/// archive 팩에서 이 서버의 실행 파일 자리. `bin` 이 파일이면 그것, 디렉터리면 그 아래의 `exe` 다.
fn archive_exe(root: &str, m: &Manifest, s: &Server, target: &str) -> String {
    let Some(t) = m.source.targets.get(target) else {
        return String::new();
    };
    if t.bin.is_empty() {
        return String::new();
    }
    let suffix = exe_suffix();
    let p = filepath::join(&[
        plugin_dir(root, &m.id).as_str(),
        filepath::from_slash(&t.bin).as_str(),
    ]);
    let base = filepath::base(&p);
    if base == s.exe || base == format!("{}{suffix}", s.exe) {
        return p;
    }
    filepath::join(&[p.as_str(), &format!("{}{suffix}", s.exe)])
}

/// 실행할 수 있는 보통 파일인가. 판정은 platform 이 갖는다 (FR-EXT-41 / FR-LWP-1).
pub(crate) fn is_executable(p: &str) -> bool {
    dm_shared_platform::current()
        .paths
        .is_executable(std::path::Path::new(p))
}
