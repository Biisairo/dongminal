//! Go 기준선 `dongminal/internal/shared/platform` 의 Rust 포팅. RUST_PORT_SRS 참고.
//!
//! 운영체제마다 갈리는 능력을 trait 뒤로 보낸다. 호출부에 OS 이름이 나타나면 그것은
//! 이 crate 의 실패다 (CROSS_PLATFORM_SRS FR-XPL-5).
//!
//! - 모든 어댑터의 판단 로직은 cfg 없이 컴파일되어 어느 호스트에서도 검증된다 (§4.2).
//!   cfg 가 붙는 것은 번들 조립과 실제 시스템 호출뿐이다.
//! - API 는 동기(std)다 (RUST_PORT D-1). 비동기 소비자는 `spawn_blocking` 이나 전용
//!   스레드로 감싼다.
//!
//! 모듈 소유: oskind·paths·atomic·statefile·filelock·lastexit·junction 은 1.4.2,
//! shell·browser·secrets 는 1.4.3, process·procinfo 는 1.4.4, ipc 는 1.4.5,
//! pty·handover 는 1.4.6 이다. 각 모듈의 `current()` 가 이 빌드의 구현을 낸다.

mod anon_file;
mod atomic;
mod browser;
mod envset;
mod filelock;
mod goerr;
mod handover;
mod hostname;
mod ifaddrs;
mod ipc;
mod junction;
mod lastexit;
mod oskind;
mod paths;
mod process;
mod procinfo;
mod pty;
mod secrets;
mod shell;
mod statefile;
mod tcp_listen;

pub use anon_file::anon_file;
pub use atomic::{copy_executable, write_file_atomic, write_file_if_changed};
pub use browser::{Browser, Opener};
pub use envset::{ThreadsRunning, set_env_before_threads, thread_count};
pub use filelock::{FileLock, LockError, lock_file};
pub use handover::*;
pub use hostname::hostname;
pub use ifaddrs::interface_addrs;
pub use ipc::*;
pub use junction::junction;
pub use lastexit::{LAST_EXIT_FILE, LastExit, mark_clean_exit, mark_running, read_last_exit};
pub use oskind::{OsKind, build_target};
pub use paths::Paths;
pub use process::{Group, Process, ShutdownSignal};
pub use procinfo::{ProcInfo, command_lines};
pub use pty::{ProcSpec, Pty, Terminal};
pub use secrets::{Secrets, SecretsError};
pub use shell::lookpath::{look_path, look_path_in};
pub use shell::{
    BASH_HOOK_FILE, POSIX_HOOK_ROOT, POWERSHELL_HOOK_FILE, ShellProvider, ShellSpec,
    WINDOWS_HOOK_ROOT,
};
pub use statefile::{RETAIN_QUARANTINED, STATE_FILE_GENERATIONS, write_state_file};
pub use tcp_listen::{canonical_addr, listen_tcp};

use std::sync::OnceLock;

/// 이 빌드가 제공하는 OS 능력의 묶음 (FR-XPL-2). 소비자는 자기가 쓰는 필드 하나만 받는다.
pub struct Platform {
    /// 표시·기록용 값이다. 분기의 근거가 아니다.
    pub os: OsKind,
    pub process: &'static dyn Process,
    pub info: &'static dyn ProcInfo,
    pub pty: &'static dyn Pty,
    pub shell: &'static dyn ShellProvider,
    pub ipc: &'static dyn Ipc,
    pub paths: &'static dyn Paths,
    pub browser: &'static dyn Browser,
    pub opener: &'static dyn Opener,
    /// OS 비밀 저장소 (CLAUDE_ACCOUNTS_SRS FR-CAC-4).
    pub secrets: &'static dyn Secrets,
}

/// 이 빌드의 구현. 값은 프로세스 수명 동안 같다 — WSL 판정이 /proc 을 읽으므로
/// 매 호출마다 다시 하지 않는다 (FR-XWS-1).
pub fn current() -> &'static Platform {
    static CURRENT: OnceLock<Platform> = OnceLock::new();
    CURRENT.get_or_init(|| Platform {
        os: oskind::current(),
        process: process::current(),
        info: procinfo::current(),
        pty: pty::current(),
        shell: shell::current(),
        ipc: ipc::current(),
        paths: paths::current(),
        browser: browser::current_browser(),
        opener: browser::current_opener(),
        secrets: secrets::current(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn current_is_stable() {
        let a = current();
        let b = current();
        assert!(std::ptr::eq(a, b));
        assert_eq!(a.os, b.os);
    }

    #[test]
    fn exe_suffix_matches_build() {
        let want = if current().os == OsKind::Windows {
            ".exe"
        } else {
            ""
        };
        assert_eq!(current().paths.exe_suffix(), want);
    }
}
