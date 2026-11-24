//! Go 기준선 `dongminal/internal/shared/runtime` 의 Rust 포팅. RUST_PORT_SRS 참고.
//!
//! dongminal 이 런타임에 배포하는 헬퍼들을 설치한다. helper CLI 는 multi-call 이므로
//! `bin/<name>` 은 실행 파일을 가리키는 symlink(안 되면 복사)다. 셸 훅·에이전트
//! 플러그인·주입 메모리는 임베드된 파일을 그대로 푼다.

mod assets;

use std::collections::HashSet;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use dm_gocompat::filepath;
use dm_gocompat::oserr::{go_error_string, path_error};
use dm_shared_agentadapter::{self as agentadapter, InstallSpec};
use dm_shared_platform::{copy_executable, write_file_if_changed};

const SHELL_HOOK_ROOT: &str = "shellhooks";
const AGENT_PLUGIN_ROOT: &str = "agentplugin";
const AGENT_MEMORY_ROOT: &str = "agentmemory";

/// 덧없는 자기 자신을 붙들어 두는 자리. 헬퍼 이름이 아니어야 한다 (FR-HLI-4).
const SELF_COPY_NAME: &str = "dongminal-self";

/// 우리가 놓은 헬퍼 이름의 기록 (FR-LFT-6).
const HELPER_MANIFEST: &str = ".helpers";
/// 설치 디렉터리의 권한 (Go `os.MkdirAll(..., 0o755)`).
const DIR_PERM: u32 = 0o755;

/// 기록이 생기기 전에 놓았던 이름들 (D-3).
const RETIRED_HELPER_NAMES: &[&str] = &["mdview"];

/// 임베드가 아니라 설치가 만드는 것들. 거울 비교에서 뺀다.
const GENERATED_PLUGIN_PATHS: &[&str] = &["hooks", "hooks/hooks.json"];

/// 아직 설치 전이라는 안내. 고장이 아니다 (FR-HLI-11).
pub const HELPER_NOT_INSTALLED: &str =
    "아직 설치되지 않았습니다 — 서버를 한 번도 띄우지 않은 홈입니다";

/// 깨진 헬퍼를 되돌리는 방법. `health` 와 `doctor` 가 같은 문장을 쓴다 (FR-HLI-10).
pub const HELPER_FIX_HINT: &str = "서버를 다시 띄우면 다시 설치됩니다: dongminal start";

fn exe_suffix() -> &'static str {
    dm_shared_platform::current().paths.exe_suffix()
}

/// Go `filepath.Join(base, name)` (경로를 정리한다).
fn go_join(base: &Path, name: &str) -> PathBuf {
    PathBuf::from(filepath::join(&[&*base.to_string_lossy(), name]))
}

fn wrap(e: io::Error, prefix: &str) -> io::Error {
    io::Error::new(e.kind(), format!("{prefix}: {}", go_error_string(&e)))
}

/// 세션 스코프로 주입되는 Claude Code 플러그인의 경로 (FR-INJ-4).
pub fn agent_plugin_dir(bin_dir: &Path) -> PathBuf {
    go_join(bin_dir, "agent-plugin")
}

/// 주입 메모리(CLAUDE.md) 폴더 (FR-AMI-2).
pub fn agent_memory_dir(bin_dir: &Path) -> PathBuf {
    go_join(bin_dir, "agent-memory")
}

/// 훅이 부를 헬퍼의 실제 파일 경로 (FR-WTP-6).
fn dmctl_path(bin_dir: &Path) -> String {
    filepath::join(&[
        &*bin_dir.to_string_lossy(),
        &format!("dmctl{}", exe_suffix()),
    ])
}

/// 없거나 깨졌을 때만 설치한다 (FR-PRF-78·79).
pub fn ensure_installed(bin_dir: &Path) -> io::Result<()> {
    let st = inspect_helpers(bin_dir);
    if st.installed && st.problems.is_empty() {
        return Ok(());
    }
    install(bin_dir)
}

/// helper symlink·셸 훅·에이전트 자산을 bin_dir 에 설치한다. 자기 경로는 이 실행 파일이다.
pub fn install(bin_dir: &Path) -> io::Result<()> {
    let exe = std::env::current_exe().map_err(|e| wrap(e, "os.Executable"))?;
    let exe = exe.to_string_lossy().into_owned();
    let exe = filepath::eval_symlinks(&exe).unwrap_or(exe);
    install_with(bin_dir, Path::new(&exe))
}

/// [`install`] 의 몸통. 헬퍼가 가리킬 실행 파일을 받는다 (V-HLI-1).
pub fn install_with(bin_dir: &Path, self_exe: &Path) -> io::Result<()> {
    mkdir_all(bin_dir).map_err(|e| wrap(e, &format!("mkdir {}", bin_dir.display())))?;
    install_shell_hooks(bin_dir)?;
    let names = dm_shared_dmenv::helper_names();
    // 자기 복사본도 기록에 넣는다 — 덧없지 않은 다음 설치가 거둔다 (FR-ATF-60).
    let mut placed: Vec<&str> = names.to_vec();
    let mut self_exe = self_exe.to_path_buf();
    if is_ephemeral_exe(&self_exe) {
        let dst = go_join(bin_dir, &format!("{SELF_COPY_NAME}{}", exe_suffix()));
        copy_executable(&self_exe, &dst).map_err(|e| wrap(e, "install self copy"))?;
        self_exe = dst;
        placed.push(SELF_COPY_NAME);
    }
    let shims = dm_shared_dmenv::agent_shims_dir_in(bin_dir);
    mkdir_all(&shims).map_err(|e| wrap(e, "mkdir agent-shims"))?;
    let paths = dm_shared_platform::current().paths;
    for (name, path) in helper_files(bin_dir) {
        paths
            .link_or_copy(&self_exe, &path)
            .map_err(|e| wrap(e, &format!("install helper {name}")))?;
    }
    // FR-LFT-5: 놓기만 하고 거두지 않으면 폐지된 이름이 영원히 남는다.
    reap_retired_helpers(bin_dir, &placed, RETIRED_HELPER_NAMES);
    reap_retired_helpers(&shims, &agentadapter::shim_commands(), &[]);
    // FR-AAC-4: 순서가 요구사항이다 — 전개, 어댑터 훅, 거울.
    let plugin = agent_plugin_dir(bin_dir);
    unpack_embedded(AGENT_PLUGIN_ROOT, &plugin).map_err(|e| wrap(e, "install agent plugin"))?;
    install_agent_assets(bin_dir)?;
    prune_to_embedded(AGENT_PLUGIN_ROOT, &plugin, GENERATED_PLUGIN_PATHS)
        .map_err(|e| wrap(e, "install agent plugin"))?;
    let memory = agent_memory_dir(bin_dir);
    unpack_embedded(AGENT_MEMORY_ROOT, &memory).map_err(|e| wrap(e, "install agent memory"))?;
    prune_to_embedded(AGENT_MEMORY_ROOT, &memory, &[]).map_err(|e| wrap(e, "install agent memory"))
}

/// `go run` 의 임시 산출물인가. 임시 디렉터리 아래이고 `go-build*` 조각이 있을 때만이다 (FR-HLI-2, D-2).
fn is_ephemeral_exe(exe: &Path) -> bool {
    let tmp = resolve_path(&std::env::temp_dir().to_string_lossy());
    let Ok(rel) = filepath::rel(&tmp, &resolve_path(&exe.to_string_lossy())) else {
        return false;
    };
    let sep = filepath::SEPARATOR;
    if rel == ".." || rel.starts_with(&format!("..{sep}")) {
        return false;
    }
    rel.split(sep).any(|seg| seg.starts_with("go-build"))
}

fn resolve_path(p: &str) -> String {
    filepath::eval_symlinks(p).unwrap_or_else(|_| p.to_owned())
}

/// dir 에 우리가 놓았던 것(기록과 legacy) 중 current 에 없는 것을 거두고 기록을 남긴다.
/// 실패는 삼킨다 (FR-LFT-8).
fn reap_retired_helpers(dir: &Path, current: &[&str], legacy: &[&str]) {
    let live: HashSet<&str> = current.iter().copied().collect();
    let suffix = exe_suffix();
    let recorded = read_helper_manifest(dir);
    for n in recorded
        .iter()
        .map(String::as_str)
        .chain(legacy.iter().copied())
    {
        if live.contains(n) || !manifest_name(n) {
            continue;
        }
        let p = dir.join(format!("{n}{suffix}"));
        // Go os.Remove: 파일이 아니면 빈 디렉터리로 지운다.
        if fs::remove_file(&p).is_err() {
            let _ = fs::remove_dir(&p);
        }
    }
    let mut sorted: Vec<&str> = current.to_vec();
    sorted.sort_unstable();
    let blob = format!("{}\n", sorted.join("\n"));
    let _ = write_file_if_changed(&dir.join(HELPER_MANIFEST), blob.as_bytes(), 0o644);
}

/// 기록의 줄이 지워도 되는 이름 꼴인가. 경로 구분자나 `..` 가 든 줄은 지우지 않는다 (FR-ATF-60).
fn manifest_name(n: &str) -> bool {
    !n.is_empty() && n != "." && !n.contains(['/', '\\', ':']) && !n.contains("..")
}

fn read_helper_manifest(dir: &Path) -> Vec<String> {
    let Ok(blob) = fs::read(dir.join(HELPER_MANIFEST)) else {
        return Vec::new();
    };
    String::from_utf8_lossy(&blob)
        .split('\n')
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .map(str::to_owned)
        .collect()
}

/// 설치된 헬퍼 하나가 쓸 수 없는 상태라는 보고 (FR-HLI-7).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HelperProblem {
    pub name: String,
    pub path: PathBuf,
    pub reason: String,
}

/// bin 하나의 상태. 설치된 적 없음과 깨짐은 다른 사건이다 (FR-HLI-11).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HelperStatus {
    /// 헬퍼가 하나라도 그 자리에 있는가.
    pub installed: bool,
    /// 있는 것 중 쓸 수 없는 것. installed 가 거짓이면 비어 있다.
    pub problems: Vec<HelperProblem>,
}

/// 설치된 헬퍼가 실제로 실행 가능한지 본다. 고치지는 않는다 (D-4). 일부만 있으면 고장이다 (D-6).
pub fn inspect_helpers(bin_dir: &Path) -> HelperStatus {
    let mut st = HelperStatus::default();
    let mut bad = Vec::new();
    for (name, p) in helper_files(bin_dir) {
        if fs::symlink_metadata(&p).is_ok() {
            st.installed = true;
        }
        let reason = match fs::metadata(&p) {
            Err(e) if e.kind() == io::ErrorKind::NotFound => Some(match fs::read_link(&p) {
                Ok(target) => format!("가리키는 곳이 없습니다: {}", target.display()),
                Err(_) => "설치되지 않았습니다".to_owned(),
            }),
            Err(e) => Some(go_error_string(&path_error(
                "stat",
                &p.to_string_lossy(),
                e,
            ))),
            Ok(m) if m.is_dir() => Some("파일이 아니라 디렉터리입니다".to_owned()),
            Ok(_) => None,
        };
        if let Some(reason) = reason {
            bad.push(HelperProblem {
                name: name.to_owned(),
                path: p,
                reason,
            });
        }
    }
    if st.installed {
        st.problems = bad;
    }
    st
}

/// 설치가 까는 multi-call 헬퍼의 자리 전부 — bin 의 헬퍼와 `agent-shims/` 의 shim.
fn helper_files(bin_dir: &Path) -> Vec<(&'static str, PathBuf)> {
    let suffix = exe_suffix();
    let shims = dm_shared_dmenv::agent_shims_dir_in(bin_dir);
    let mut out: Vec<_> = dm_shared_dmenv::helper_names()
        .iter()
        .map(|n| (*n, go_join(bin_dir, &format!("{n}{suffix}"))))
        .collect();
    out.extend(
        agentadapter::shim_commands()
            .into_iter()
            .map(|n| (n, go_join(&shims, &format!("{n}{suffix}")))),
    );
    out
}

/// 등록된 어댑터 전부의 설치물을 놓는다 (FR-AAC-4).
fn install_agent_assets(bin_dir: &Path) -> io::Result<()> {
    let dir = dm_shared_dmenv::agent_hooks_dir_in(bin_dir);
    mkdir_all(&dir)?;
    let spec = InstallSpec {
        dir,
        plugin_dir: agent_plugin_dir(bin_dir),
        dmctl: dmctl_path(bin_dir),
    };
    for id in agentadapter::ids() {
        let Ok(a) = agentadapter::get(id) else {
            continue;
        };
        // FR-AAC-1: None 은 "놓을 것이 없다"는 선언이다.
        let Some(f) = a.install_assets else {
            continue;
        };
        f(&spec).map_err(|e| wrap(e, &format!("install {id} assets")))?;
    }
    Ok(())
}

/// 이 OS 의 훅만 푼다 (FR-XSH-4). 푸는 위치는 bin_dir 바로 아래다.
fn install_shell_hooks(bin_dir: &Path) -> io::Result<()> {
    let root = format!(
        "{SHELL_HOOK_ROOT}/{}",
        dm_shared_platform::current().shell.hook_root()
    );
    unpack_embedded(&root, bin_dir)
}

fn join_rel(dst: &Path, rel: &str) -> PathBuf {
    rel.split('/').fold(dst.to_path_buf(), |p, seg| p.join(seg))
}

/// 임베드 서브트리 root 를 dst 아래로 전개한다. 다른 것만 원자적으로 바꾼다 (FR-OPT-5-5).
/// `.sh`·`.py` 만 0755, 나머지는 0644 다 (FR-INJ-3).
fn unpack_embedded(root: &str, dst: &Path) -> io::Result<()> {
    for (rel, data) in assets::under(root) {
        let target = join_rel(dst, rel);
        let mode = match filepath::ext(rel) {
            ".sh" | ".py" => 0o755,
            _ => 0o644,
        };
        if let Some(parent) = target.parent() {
            mkdir_all(parent)?;
        }
        write_file_if_changed(&target, data, mode)?;
    }
    Ok(())
}

/// dst 아래에서 임베드 트리에도 keep 에도 없는 것을 지운다. 범위는 dst 서브트리다.
fn prune_to_embedded(root: &str, dst: &Path, keep: &[&str]) -> io::Result<()> {
    let mut want: HashSet<String> = keep.iter().map(|k| (*k).to_owned()).collect();
    for (rel, _) in assets::under(root) {
        let mut acc = String::new();
        for seg in rel.split('/') {
            if !acc.is_empty() {
                acc.push('/');
            }
            acc.push_str(seg);
            want.insert(acc.clone());
        }
    }
    let meta =
        fs::symlink_metadata(dst).map_err(|e| path_error("lstat", &dst.to_string_lossy(), e))?;
    let mut extra = Vec::new();
    if meta.is_dir() {
        collect_extra(dst, "", &want, &mut extra)?;
    }
    for p in extra {
        let r = if fs::symlink_metadata(&p).is_ok_and(|m| m.is_dir()) {
            fs::remove_dir_all(&p)
        } else {
            fs::remove_file(&p)
        };
        match r {
            Err(e) if e.kind() != io::ErrorKind::NotFound => {
                return Err(wrap(e, &format!("prune {}", p.display())));
            }
            _ => {}
        }
    }
    Ok(())
}

/// Go `filepath.WalkDir` 순서(이름 순, 링크를 따라가지 않음)로 dir 를 훑는다.
fn collect_extra(
    dir: &Path,
    prefix: &str,
    want: &HashSet<String>,
    extra: &mut Vec<PathBuf>,
) -> io::Result<()> {
    let rd = fs::read_dir(dir).map_err(|e| path_error("open", &dir.to_string_lossy(), e))?;
    let mut entries: Vec<_> = rd.filter_map(Result::ok).collect();
    entries.sort_by_key(fs::DirEntry::file_name);
    for e in entries {
        let name = e.file_name().to_string_lossy().into_owned();
        let rel = if prefix.is_empty() {
            name
        } else {
            format!("{prefix}/{name}")
        };
        let is_dir = e.file_type().is_ok_and(|t| t.is_dir());
        if !want.contains(&rel) {
            extra.push(e.path());
        } else if is_dir {
            collect_extra(&e.path(), &rel, want, extra)?;
        }
    }
    Ok(())
}

/// Go `os.MkdirAll(p, 0o755)`.
fn mkdir_all(p: &Path) -> io::Result<()> {
    dm_gocompat::oserr::mkdir_all(&p.to_string_lossy(), DIR_PERM)
}

#[cfg(test)]
mod tests;
