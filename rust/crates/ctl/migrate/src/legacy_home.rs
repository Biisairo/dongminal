//! 옛 기본 홈을 새 기본 홈으로 옮긴다 (OTTERMINAL_RENAME_SRS §3.2).
//!
//! 옮기기는 rename 한 번이고, 옛 자리에는 새 홈을 가리키는 링크를 남긴다(D-5). git worktree 등
//! 옛 절대 경로를 가진 기록이 링크를 통해 계속 통한다.

use std::fs;
use std::io;
use std::path::Path;

pub use otter_shared_otterenv::legacy::LEGACY_HOME_DIR;
use otter_shared_otterenv::{DEFAULT_HOME_DIR, PANED_PID_FILE};

/// 이전 시도의 결과.
#[derive(Debug, PartialEq, Eq)]
pub enum LegacyHome {
    /// 옮기고 링크를 남겼다.
    Migrated,
    /// 옮겼지만 링크를 남기지 못했다 (FR-MIG-6). 값은 그 이유다.
    MigratedNoLink(String),
    /// 옛 홈이 없다.
    NoLegacy,
    /// 새 홈이 이미 있다 (FR-MIG-4).
    NewExists,
    /// 옛 홈이 이미 링크다 (FR-MIG-5).
    LegacyIsLink,
}

impl LegacyHome {
    /// 사용자에게 알릴 한 줄 (FR-MIG-7). 바뀐 것이 없으면 없다.
    pub fn notice(&self, user_home: &Path) -> Option<String> {
        let old = user_home.join(LEGACY_HOME_DIR);
        let new = user_home.join(DEFAULT_HOME_DIR);
        match self {
            Self::Migrated => Some(format!(
                "홈을 옮겼습니다: {} → {} (옛 자리는 링크입니다)",
                old.display(),
                new.display()
            )),
            Self::MigratedNoLink(why) => Some(format!(
                "홈을 옮겼습니다: {} → {} — 옛 자리에 링크를 만들지 못했습니다: {why}",
                old.display(),
                new.display()
            )),
            Self::NoLegacy | Self::NewExists | Self::LegacyIsLink => None,
        }
    }
}

/// 사용자 홈 아래의 옛 기본 홈을 새 기본 홈으로 옮긴다.
pub fn migrate_legacy_home(user_home: &Path) -> Result<LegacyHome, String> {
    let process = otter_shared_platform::current().process;
    migrate_with(user_home, &|pid| process.alive(pid), &link_dir)
}

pub(crate) fn migrate_with(
    user_home: &Path,
    alive: &dyn Fn(i32) -> bool,
    link: &dyn Fn(&Path, &Path) -> io::Result<()>,
) -> Result<LegacyHome, String> {
    let old = user_home.join(LEGACY_HOME_DIR);
    let new = user_home.join(DEFAULT_HOME_DIR);
    if fs::symlink_metadata(&new).is_ok() {
        return Ok(LegacyHome::NewExists);
    }
    let Ok(meta) = fs::symlink_metadata(&old) else {
        return Ok(LegacyHome::NoLegacy);
    };
    if meta.file_type().is_symlink() {
        return Ok(LegacyHome::LegacyIsLink);
    }
    if !meta.is_dir() {
        return Ok(LegacyHome::NoLegacy);
    }
    if let Some(pid) = legacy_daemon_pid(&old, alive) {
        return Err(format!(
            "옛 홈 {} 을 쓰는 이전 판이 실행 중입니다 (pid {pid}) — 이전 판을 멈춘 뒤 다시 실행하세요",
            old.display()
        ));
    }
    fs::rename(&old, &new).map_err(|e| {
        format!(
            "옛 홈 {} 을 {} 로 옮기지 못했습니다: {e}",
            old.display(),
            new.display()
        )
    })?;
    Ok(match link(&new, &old) {
        Ok(()) => LegacyHome::Migrated,
        Err(e) => LegacyHome::MigratedNoLink(e.to_string()),
    })
}

/// 옛 홈의 paned.pid 가 가리키는 프로세스가 살아 있으면 그 pid (FR-MIG-3).
fn legacy_daemon_pid(old: &Path, alive: &dyn Fn(i32) -> bool) -> Option<i32> {
    let b = fs::read_to_string(old.join(PANED_PID_FILE)).ok()?;
    let pid: i32 = b.trim().parse().ok()?;
    (pid > 0 && alive(pid)).then_some(pid)
}

#[cfg(unix)]
fn link_dir(target: &Path, link: &Path) -> io::Result<()> {
    std::os::unix::fs::symlink(target, link)
}

/// Windows 는 권한 없이 만들 수 있는 디렉터리 정션을 쓴다 (FR-MIG-8).
#[cfg(windows)]
fn link_dir(target: &Path, link: &Path) -> io::Result<()> {
    let cmd = otter_shared_platform::command_path("cmd").map_err(io::Error::other)?;
    let out = std::process::Command::new(cmd)
        .arg("/C")
        .arg("mklink")
        .arg("/J")
        .arg(link)
        .arg(target)
        .output()?;
    if out.status.success() {
        return Ok(());
    }
    Err(io::Error::other(
        String::from_utf8_lossy(&out.stderr).trim().to_owned(),
    ))
}

#[cfg(all(test, unix))]
mod tests;
