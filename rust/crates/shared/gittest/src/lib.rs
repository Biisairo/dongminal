//! Go 기준선 `dongminal/internal/shared/gittest` 의 Rust 포팅. RUST_PORT_SRS 참고.
//!
//! 테스트의 git 저장소 픽스처 한 벌이다 (M8 D-A-20, TEST-23). 전역·시스템 gitconfig 를
//! 차단해 호스트의 `commit.gpgsign`·`init.templateDir` 이 새어 들어오지 않게 한다. 제품 코드는
//! 쓰지 않는다. dev-dependencies 로만 넣는다.
//!
//! Go 판은 `testing.TB` 로 건너뛰기·실패를 냈다. 여기서는 git 이 없으면 `None` 을 돌려주고
//! (부르는 쪽이 그 검사를 일찍 끝낸다), 준비 단계의 실패는 패닉이다.

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use dm_shared_platform::OsKind;

/// 계수 스크립트가 줄을 적을 파일의 환경 변수다 — 시험마다 다르다.
const COUNT_LOG_ENV: &str = "DM_GITTEST_LOG";

#[cfg(windows)]
const NULL_DEVICE: &str = "NUL";
#[cfg(not(windows))]
const NULL_DEVICE: &str = "/dev/null";

/// 놓으면 지워지는 임시 디렉터리다.
#[derive(Debug)]
pub struct TempDir {
    path: PathBuf,
}

impl TempDir {
    /// 임시 디렉터리를 만든다. 만들지 못하면 패닉이다.
    pub fn new(prefix: &str) -> Self {
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default();
        let path = std::env::temp_dir().join(format!(
            "{prefix}{}-{nanos}-{}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        if let Err(e) = std::fs::create_dir_all(&path) {
            panic!("임시 디렉터리 {}: {e}", path.display());
        }
        Self { path }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

/// git 실행 파일이다. 없으면 `None` — 없는 git 은 결함이 아니라 환경이다.
pub fn path() -> Option<PathBuf> {
    let exe = format!("git{}", std::env::consts::EXE_SUFFIX);
    std::env::split_paths(&std::env::var_os("PATH")?)
        .map(|d| d.join(&exe))
        .find(|p| p.is_file())
}

/// 준비 단계의 git 이다 — 전역·시스템 gitconfig 를 차단하고, 실패는 패닉이다.
/// 다듬은 stdout+stderr 를 돌려준다.
pub fn run(dir: &Path, args: &[&str]) -> String {
    run_env(dir, args, std::iter::empty::<(OsString, OsString)>())
}

/// [`run`] 에 환경 변수를 더한다. [`Counter::envs`] 를 넘기면 이 호출도 세어진다.
pub fn run_env<K, V>(dir: &Path, args: &[&str], envs: impl IntoIterator<Item = (K, V)>) -> String
where
    K: AsRef<OsStr>,
    V: AsRef<OsStr>,
{
    // 이름으로 띄운다. envs 의 PATH 가 있으면 그것으로 찾으므로 계수 스크립트를 지난다.
    let mut cmd = Command::new("git");
    cmd.args(args)
        .current_dir(dir)
        .env("GIT_CONFIG_GLOBAL", NULL_DEVICE)
        .env("GIT_CONFIG_SYSTEM", NULL_DEVICE)
        .envs(envs);
    let out = match cmd.output() {
        Ok(o) => o,
        Err(e) => panic!("git {}: {e}", args.join(" ")),
    };
    let mut text = out.stdout;
    text.extend_from_slice(&out.stderr);
    let text = String::from_utf8_lossy(&text).trim().to_owned();
    if !out.status.success() {
        panic!("git {}: {}\n{text}", args.join(" "), out.status);
    }
    text
}

/// [`run`] 과 같되 실패를 패닉하지 않고 `Err` 로 돌려준다. 실패해야 맞는 확인에 쓴다.
pub fn try_run(dir: &Path, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_CONFIG_GLOBAL", NULL_DEVICE)
        .env("GIT_CONFIG_SYSTEM", NULL_DEVICE)
        .output()
        .map_err(|e| format!("git {}: {e}", args.join(" ")))?;
    let mut text = out.stdout;
    text.extend_from_slice(&out.stderr);
    let text = String::from_utf8_lossy(&text).trim().to_owned();
    if out.status.success() {
        Ok(text)
    } else {
        Err(text)
    }
}

/// 임시 저장소다. 놓으면 지워진다.
#[derive(Debug)]
pub struct Repo {
    _tmp: TempDir,
    dir: PathBuf,
}

impl Repo {
    /// 저장소의 물리 경로다(심볼릭 링크를 푼 값). git 이 toplevel 을 이 형태로 답한다.
    pub fn path(&self) -> &Path {
        &self.dir
    }
}

/// `main` 브랜치의 빈 저장소다. git 이 없으면 `None` 이다.
pub fn init() -> Option<Repo> {
    path()?;
    let tmp = TempDir::new("dm-gittest-repo-");
    let dir = physical(tmp.path());
    run(&dir, &["init", "-b", "main"]);
    run(&dir, &["config", "user.email", "t@example.com"]);
    run(&dir, &["config", "user.name", "tester"]);
    Some(Repo { _tmp: tmp, dir })
}

/// 커밋 하나(README.md)를 가진 임시 저장소다. git 이 없으면 `None` 이다.
pub fn repo() -> Option<Repo> {
    let r = init()?;
    if let Err(e) = std::fs::write(r.path().join("README.md"), "x\n") {
        panic!("README.md: {e}");
    }
    run(r.path(), &["add", "."]);
    run(r.path(), &["commit", "-m", "init"]);
    Some(r)
}

/// 심볼릭 링크를 푼다 (macOS 의 /var → /private/var). Windows 는 `\\?\` 형태를 피하려고
/// 그대로 둔다.
fn physical(p: &Path) -> PathBuf {
    if cfg!(windows) {
        return p.to_path_buf();
    }
    match std::fs::canonicalize(p) {
        Ok(r) => r,
        Err(e) => panic!("EvalSymlinks {}: {e}", p.display()),
    }
}

/// PATH 로 뜬 git 프로세스를 센다 (OPTIMIZE_REFACTOR_SRS FR-OPT-7-3).
///
/// PATH 맨 앞에 진짜 git 을 부르는 얇은 스크립트를 두고, 스크립트가 argv 를 한 줄씩 기록한다.
/// 프로세스 환경을 바꾸지 않는다 — 셀 git 을 띄우는 `Command` 에 [`Counter::envs`] 를 심는다.
#[derive(Debug)]
pub struct Counter {
    _tmp: TempDir,
    log: PathBuf,
    path_env: OsString,
}

impl Counter {
    /// 계수기를 만든다. git 이 없거나 셸 스크립트를 못 쓰는 OS(Windows)면 `None` 이다.
    pub fn install() -> Option<Self> {
        if dm_shared_platform::current().os == OsKind::Windows {
            return None;
        }
        let shim = count_shim(&path()?)?;
        let tmp = TempDir::new("dm-gittest-log-");
        let log = tmp.path().join("calls.log");
        let mut dirs = vec![shim.to_path_buf()];
        if let Some(p) = std::env::var_os("PATH") {
            dirs.extend(std::env::split_paths(&p));
        }
        let path_env = std::env::join_paths(dirs).ok()?;
        Some(Self {
            _tmp: tmp,
            log,
            path_env,
        })
    }

    /// 셀 git 을 띄우는 `Command` 에 심을 환경 변수다 (`PATH`, 기록 파일).
    pub fn envs(&self) -> [(OsString, OsString); 2] {
        [
            ("PATH".into(), self.path_env.clone()),
            (COUNT_LOG_ENV.into(), self.log.clone().into_os_string()),
        ]
    }

    /// 지금까지 뜬 git 의 argv 다 (공백으로 이은 한 줄씩).
    pub fn calls(&self) -> Vec<String> {
        let Ok(b) = std::fs::read(&self.log) else {
            return Vec::new();
        };
        let s = String::from_utf8_lossy(&b);
        let s = s.trim_end_matches('\n');
        if s.is_empty() {
            return Vec::new();
        }
        s.split('\n').map(str::to_owned).collect()
    }

    /// 지금까지 뜬 git 프로세스 수다.
    pub fn n(&self) -> usize {
        self.calls().len()
    }

    /// 셈을 0 으로 되돌린다.
    pub fn reset(&self) {
        let _ = std::fs::remove_file(&self.log);
    }
}

/// 계수 스크립트는 프로세스마다 한 번만 만든다 — macOS 는 처음 보는 실행 파일을 띄울 때
/// 보안 검사를 해 수 초가 걸린다. 기록 파일만 시험마다 환경 변수로 넘긴다.
fn count_shim(real: &Path) -> Option<&'static Path> {
    static SHIM: OnceLock<Option<PathBuf>> = OnceLock::new();
    SHIM.get_or_init(|| write_shim(real)).as_deref()
}

#[cfg(unix)]
fn write_shim(real: &Path) -> Option<PathBuf> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;

    let tmp = TempDir::new("dm-gittest-");
    // 프로세스가 끝날 때까지 쓰므로 지우지 않는다.
    let dir = tmp.path().to_path_buf();
    std::mem::forget(tmp);
    let script = format!(
        "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"${COUNT_LOG_ENV}\"\nexec '{}' \"$@\"\n",
        real.display()
    );
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o755)
        .open(dir.join("git"))
        .ok()?;
    f.write_all(script.as_bytes()).ok()?;
    Some(dir)
}

#[cfg(not(unix))]
fn write_shim(_: &Path) -> Option<PathBuf> {
    None
}

#[cfg(test)]
mod tests;
