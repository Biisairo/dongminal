//! 프로세스 환경 쓰기다. Go 의 `os.Setenv` 자리 — Rust 2024 의 `std::env::set_var` 는 다른 스레드가
//! 환경을 읽는 동안 부르면 정의되지 않은 동작이라 unsafe 다. 이 crate 가 그 unsafe 를 맡고, 다른
//! 스레드가 없음을 확인한 뒤에만 쓴다.

use std::fmt;

/// 다른 스레드가 이미 있어 환경을 바꾸지 않았다. 안의 값은 센 스레드 수다.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ThreadsRunning(pub usize);

impl fmt::Display for ThreadsRunning {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "다른 스레드가 있어 환경을 바꾸지 않았다 (스레드 {}개)",
            self.0
        )
    }
}

impl std::error::Error for ThreadsRunning {}

/// 이 프로세스의 스레드 수다. 셀 수 없는 OS 면 `None` 이다.
pub fn thread_count() -> Option<usize> {
    os::thread_count()
}

/// 프로세스 환경에 `key=value` 를 넣는다. 이 뒤에 띄우는 자식 프로세스가 물려받는다.
///
/// **호출 조건**: 프로세스에 이 스레드 하나만 있을 때만 부른다 — tokio 런타임·작업 스레드·
/// 로그 스레드 등 어떤 스레드도 세우기 전이다. 스레드를 셀 수 있는 OS(macOS·Linux)에서는
/// 둘 이상이면 쓰지 않고 [`ThreadsRunning`] 을 돌려준다. 셀 수 없는 OS 에서는 호출 조건을 믿는다.
///
/// Windows 는 세지 않고 쓴다. 프로세스가 뜰 때 로더가 작업 스레드를 미리 세우므로 `main` 첫 줄에서도
/// 스레드가 여럿이고, 환경 쓰기(`SetEnvironmentVariableW`)는 OS 가 잠그므로 여러 스레드에서도
/// 안전하다(`std::env::set_var` 문서).
pub fn set_env_before_threads(key: &str, value: &str) -> Result<(), ThreadsRunning> {
    if !cfg!(windows)
        && let Some(n) = thread_count()
        && n > 1
    {
        return Err(ThreadsRunning(n));
    }
    // SAFETY: Unix 는 다른 스레드가 없을 때만 부른다(위에서 센 수가 1 이거나, 셀 수 없으면 호출
    // 조건) — 환경을 동시에 읽거나 쓸 스레드가 없으므로 경쟁이 없다. Windows 는 OS 가 환경 접근을
    // 잠그므로 스레드가 있어도 안전하다.
    unsafe { std::env::set_var(key, value) };
    Ok(())
}

#[cfg(target_os = "linux")]
mod os {
    /// `/proc/self/status` 의 `Threads:` 줄이다.
    pub(super) fn thread_count() -> Option<usize> {
        let s = std::fs::read_to_string("/proc/self/status").ok()?;
        s.lines()
            .find_map(|l| l.strip_prefix("Threads:"))
            .and_then(|v| v.trim().parse().ok())
    }
}

#[cfg(target_os = "macos")]
mod os {
    /// `proc_pidinfo(PROC_PIDTASKINFO)` 의 `pti_threadnum` 이다.
    pub(super) fn thread_count() -> Option<usize> {
        let mut info = std::mem::MaybeUninit::<libc::proc_taskinfo>::zeroed();
        let size = libc::c_int::try_from(std::mem::size_of::<libc::proc_taskinfo>()).ok()?;
        // SAFETY: info 는 proc_taskinfo 크기의 쓰기 가능한 버퍼이고, 그 크기를 함께 넘긴다. 커널은
        // 최대 size 바이트를 쓰고 쓴 바이트 수를 돌려준다.
        let n = unsafe {
            libc::proc_pidinfo(
                libc::getpid(),
                libc::PROC_PIDTASKINFO,
                0,
                info.as_mut_ptr().cast(),
                size,
            )
        };
        if n != size {
            return None;
        }
        // SAFETY: 커널이 구조체 전체(size 바이트)를 채웠다. zeroed 로 시작했으므로 모든 필드가 초기화돼 있다.
        let info = unsafe { info.assume_init() };
        usize::try_from(info.pti_threadnum).ok()
    }
}

#[cfg(windows)]
mod os {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, TH32CS_SNAPTHREAD, THREADENTRY32, Thread32First, Thread32Next,
    };
    use windows_sys::Win32::System::Threading::GetCurrentProcessId;

    /// 스레드 스냅숏에서 이 프로세스의 것만 센다.
    pub(super) fn thread_count() -> Option<usize> {
        // SAFETY: 인자는 상수이고, 돌려받은 핸들은 아래에서 닫는다.
        let snap = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
        if snap == INVALID_HANDLE_VALUE {
            return None;
        }
        // SAFETY: 인자가 없는 조회다.
        let pid = unsafe { GetCurrentProcessId() };
        // SAFETY: THREADENTRY32 는 정수 필드뿐이라 0 이 올바른 값이다.
        let mut e: THREADENTRY32 = unsafe { std::mem::zeroed() };
        e.dwSize = u32::try_from(std::mem::size_of::<THREADENTRY32>()).unwrap_or(0);
        let mut n = 0usize;
        // SAFETY: snap 은 열린 스냅숏이고 e 는 dwSize 를 채운 쓰기 가능한 구조체다.
        let mut ok = unsafe { Thread32First(snap, &mut e) };
        while ok != 0 {
            if e.th32OwnerProcessID == pid {
                n += 1;
            }
            // SAFETY: 위와 같다.
            ok = unsafe { Thread32Next(snap, &mut e) };
        }
        // SAFETY: 이 함수가 연 핸들을 한 번 닫는다.
        unsafe { CloseHandle(snap) };
        (n > 0).then_some(n)
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
mod os {
    pub(super) fn thread_count() -> Option<usize> {
        None
    }
}

#[cfg(test)]
mod tests;
