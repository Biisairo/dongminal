//! 열린 파일 수 상한(RLIMIT_NOFILE)이다. Go 런타임처럼 시작할 때 soft 를 올리고, 자식에게는
//! 원래 soft 를 돌려준다 (Go `syscall/rlimit.go`·`rlimit_darwin.go`·`exec_libc2.go`).
//!
//! launchd 의 기본 soft 는 256 이다. 파일 감시(kqueue 는 항목마다 fd)만으로 넘는다. 낮은 soft 는
//! fd_set 크기에 묶인 select 를 쓰는 옛 프로그램을 위한 것이므로 자식에게는 원래 값을 준다.

use std::io;
use std::process::Command;

/// 시작 때 바꾼 soft 값이다.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct NofileRaise {
    pub from: u64,
    pub to: u64,
}

/// 올리기 전의 상한이다. 올렸을 때만 채운다. 자식의 pre_exec 가 읽는다.
#[cfg(unix)]
static ORIGINAL: std::sync::OnceLock<libc::rlimit> = std::sync::OnceLock::new();

/// 올릴 soft 값이다. 올릴 필요가 없으면 `None` 이다. hard 까지 올리되 cap(darwin 의
/// `kern.maxfilesperproc`)이 있으면 그 값에서 자른다 — 옛 macOS 는 soft 무한을 거절한다.
#[cfg_attr(windows, allow(dead_code))]
fn raised_soft(cur: u64, max: u64, cap: Option<u64>) -> Option<u64> {
    let target = cap.map_or(max, |c| max.min(c));
    (target > cur).then_some(target)
}

/// soft 를 올린다. 프로세스 시작 때 다른 자식을 띄우기 전에 한 번 부른다. 올리지 못하면 그대로
/// 두고 오류를 낸다 — 호출자가 로그만 남긴다. hard 는 건드리지 않는다.
pub fn raise_nofile_limit() -> io::Result<Option<NofileRaise>> {
    #[cfg(unix)]
    {
        let mut lim = libc::rlimit {
            rlim_cur: 0,
            rlim_max: 0,
        };
        // SAFETY: lim 은 유효한 rlimit 이다.
        if unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut lim) } != 0 {
            return Err(io::Error::last_os_error());
        }
        let (from, max) = (lim.rlim_cur, lim.rlim_max);
        let Some(to) = raised_soft(from, max, max_files_per_proc()) else {
            return Ok(None);
        };
        let new = libc::rlimit {
            rlim_cur: to,
            rlim_max: lim.rlim_max,
        };
        // SAFETY: new 는 유효한 rlimit 이다.
        if unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &new) } != 0 {
            return Err(io::Error::last_os_error());
        }
        let _ = ORIGINAL.set(lim);
        Ok(Some(NofileRaise { from, to }))
    }
    #[cfg(not(unix))]
    {
        Ok(None)
    }
}

/// darwin 의 프로세스당 파일 수 상한이다. 읽지 못하면 `None` 이다.
#[cfg(target_os = "macos")]
fn max_files_per_proc() -> Option<u64> {
    let mut n: libc::c_int = 0;
    let mut len = std::mem::size_of::<libc::c_int>();
    // SAFETY: 이름은 NUL 로 끝나고, n 과 len 은 c_int 하나를 담는다.
    let rc = unsafe {
        libc::sysctlbyname(
            c"kern.maxfilesperproc".as_ptr(),
            (&raw mut n).cast(),
            &mut len,
            std::ptr::null_mut(),
            0,
        )
    };
    (rc == 0 && n > 0).then_some(n as u64)
}

#[cfg(all(unix, not(target_os = "macos")))]
fn max_files_per_proc() -> Option<u64> {
    None
}

/// fork 뒤 exec 전에 부른다. setrlimit(2) 는 할당·잠금을 하지 않고, ORIGINAL 은 읽기만 한다.
/// 실패는 무시한다 — Go 와 같다.
#[cfg(unix)]
pub(crate) fn restore_in_child() {
    if let Some(lim) = ORIGINAL.get() {
        // SAFETY: lim 은 유효한 rlimit 이다.
        unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, lim) };
    }
}

/// cmd 가 exec 하기 직전에 soft 를 시작 때의 값으로 되돌리게 한다. soft 를 올리지 않았으면
/// 아무것도 하지 않는다. Go `os/exec`·`syscall.Exec` 와 같다.
pub fn restore_nofile_on_exec(cmd: &mut Command) {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // SAFETY: restore_in_child 는 async-signal-safe 다.
        unsafe {
            cmd.pre_exec(|| {
                restore_in_child();
                Ok(())
            });
        }
    }
    #[cfg(not(unix))]
    {
        let _ = cmd;
    }
}

#[cfg(test)]
mod tests;
