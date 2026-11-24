//! 부팅이 기대는 OS 이음매다: 종료 신호, exec, 자기 실행 파일, 인계 fd.

use std::fs::File;
use std::future::Future;
use std::io;
use std::pin::Pin;

use otter_shared_otterlog::errorf;
use otter_shared_platform::ShutdownSignal;

/// sigs 중 하나가 오면 끝나는 future 다. 지금 등록하므로 돌려준 뒤에 온 신호를 놓치지 않는다.
/// tokio 런타임 안에서 부른다.
pub(crate) fn shutdown_signals(
    sigs: &[ShutdownSignal],
) -> Pin<Box<dyn Future<Output = ()> + Send>> {
    let mut waits: Vec<Pin<Box<dyn Future<Output = ()> + Send>>> = Vec::new();
    for &s in sigs {
        match listen_signal(s) {
            Ok(w) => waits.push(w),
            Err(e) => errorf!(None, "signal {s:?}: {e}"),
        }
    }
    if waits.is_empty() {
        return Box::pin(std::future::pending());
    }
    Box::pin(std::future::poll_fn(move |cx| {
        if waits.iter_mut().any(|w| w.as_mut().poll(cx).is_ready()) {
            std::task::Poll::Ready(())
        } else {
            std::task::Poll::Pending
        }
    }))
}

#[cfg(unix)]
fn listen_signal(s: ShutdownSignal) -> io::Result<Pin<Box<dyn Future<Output = ()> + Send>>> {
    use tokio::signal::unix::{SignalKind, signal};
    let kind = match s {
        ShutdownSignal::Interrupt => SignalKind::interrupt(),
        ShutdownSignal::Terminate => SignalKind::terminate(),
        ShutdownSignal::Hangup => SignalKind::hangup(),
    };
    let mut sig = signal(kind)?;
    Ok(Box::pin(async move {
        sig.recv().await;
    }))
}

#[cfg(windows)]
fn listen_signal(s: ShutdownSignal) -> io::Result<Pin<Box<dyn Future<Output = ()> + Send>>> {
    use tokio::signal::windows::{ctrl_break, ctrl_c};
    match s {
        ShutdownSignal::Interrupt => {
            let mut c = ctrl_c()?;
            let mut b = ctrl_break()?;
            Ok(Box::pin(async move {
                tokio::select! {
                    _ = c.recv() => {}
                    _ = b.recv() => {}
                }
            }))
        }
        ShutdownSignal::Terminate | ShutdownSignal::Hangup => Ok(Box::pin(std::future::pending())),
    }
}

/// 이 데몬의 실행 파일(심볼릭 링크를 푼 경로)이다. 모르면 빈 값이고, 그때 교체기는 모든 요청을
/// 거절한다 (FR-DSK-11).
pub(crate) fn self_exe() -> String {
    let Ok(exe) = std::env::current_exe() else {
        return String::new();
    };
    otter_gocompat::filepath::eval_symlinks(&exe.to_string_lossy()).unwrap_or_default()
}

/// 유효 사용자 id 다. Windows 는 교체기가 먼저 거절하므로 쓰이지 않는다.
pub(crate) fn euid() -> u32 {
    #[cfg(unix)]
    {
        nix::unistd::geteuid().as_raw()
    }
    #[cfg(not(unix))]
    {
        u32::MAX
    }
}

/// 프로세스를 exe 로 갈아 끼운다(Go `syscall.Exec`). 돌아오면 실패다.
#[cfg(unix)]
pub(crate) fn exec(exe: &str, argv: &[String], env: &[String]) -> io::Error {
    use std::ffi::CString;
    let cstr = |s: &str| CString::new(s).map_err(|_| io::Error::from_raw_os_error(libc::EINVAL));
    let path = match cstr(exe) {
        Ok(p) => p,
        Err(e) => return e,
    };
    let argv: Result<Vec<CString>, io::Error> = argv.iter().map(|s| cstr(s)).collect();
    let env: Result<Vec<CString>, io::Error> = env.iter().map(|s| cstr(s)).collect();
    let (argv, env) = match (argv, env) {
        (Ok(a), Ok(e)) => (a, e),
        (Err(e), _) | (_, Err(e)) => return e,
    };
    match nix::unistd::execve(&path, &argv, &env) {
        Err(errno) => io::Error::from_raw_os_error(errno as i32),
        Ok(never) => match never {},
    }
}

#[cfg(not(unix))]
pub(crate) fn exec(_: &str, _: &[String], _: &[String]) -> io::Error {
    io::Error::from(io::ErrorKind::Unsupported)
}

/// 인계 상태가 담긴 fd 를 파일로 연다(Go `os.NewFile`). 열려 있지 않은 fd 면 Go 가 읽을 때 내는
/// 오류와 같은 문구다.
#[cfg(unix)]
pub(crate) fn handover_file(fd: i64) -> io::Result<File> {
    use std::os::fd::FromRawFd;
    let bad = || {
        io::Error::other(format!(
            "인계 상태 읽기: {}",
            otter_gocompat::oserr::go_error_string(&otter_gocompat::oserr::path_error(
                "read",
                "handover",
                io::Error::from_raw_os_error(libc::EBADF),
            ))
        ))
    };
    let Ok(raw) = i32::try_from(fd) else {
        return Err(bad());
    };
    // SAFETY: fcntl(F_GETFD) 는 fd 의 상태만 묻는다. 열려 있음을 확인한 fd 는 exec 전의 데몬이
    // 이 프로세스에 넘긴 인계 파일이고, 이 프로세스의 다른 곳은 그 fd 를 쥐지 않으므로 소유권을
    // File 로 가져온다.
    unsafe {
        if libc::fcntl(raw, libc::F_GETFD) == -1 {
            return Err(bad());
        }
        Ok(File::from_raw_fd(raw))
    }
}

#[cfg(not(unix))]
pub(crate) fn handover_file(_: i64) -> io::Result<File> {
    Err(io::Error::from(io::ErrorKind::Unsupported))
}
