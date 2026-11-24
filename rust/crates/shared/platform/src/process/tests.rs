use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use super::posix::PosixProcess;
use super::*;

fn wait_until(d: Duration, mut cond: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + d;
    while Instant::now() < deadline {
        if cond() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    cond()
}

fn sh(script: &str) -> Command {
    let mut c = Command::new("/bin/sh");
    c.args(["-c", script]).stdin(Stdio::null());
    c
}

fn pid_of(child: &std::process::Child) -> i32 {
    i32::try_from(child.id()).unwrap()
}

#[test]
fn alive_self() {
    assert!(PosixProcess.alive(i32::try_from(std::process::id()).unwrap()));
}

#[test]
fn alive_rejects_non_positive() {
    for pid in [0, -1] {
        assert!(!PosixProcess.alive(pid), "pid {pid}");
    }
}

#[test]
fn non_positive_signals_are_noop() {
    assert!(PosixProcess.terminate(0).is_ok());
    assert!(PosixProcess.kill(-1).is_ok());
}

#[test]
fn terminate_and_alive() {
    let mut child = sh("sleep 60").spawn().unwrap();
    let pid = pid_of(&child);
    assert!(PosixProcess.alive(pid), "방금 띄운 프로세스가 죽어 있다");
    PosixProcess.terminate(pid).unwrap();
    let _ = child.wait(); // 수확하지 않으면 좀비가 남아 alive 가 계속 참이다
    assert!(!PosixProcess.alive(pid), "terminate 후에도 살아 있다");
}

#[test]
fn kill_ignores_trap() {
    let mut child = sh("trap '' TERM; sleep 60").spawn().unwrap();
    let pid = pid_of(&child);
    PosixProcess.kill(pid).unwrap();
    let _ = child.wait();
    assert!(!PosixProcess.alive(pid));
}

#[test]
fn kill_missing_pid_is_raw_errno() {
    let mut child = sh("true").spawn().unwrap();
    let pid = pid_of(&child);
    child.wait().unwrap();
    let e = PosixProcess.kill(pid).unwrap_err();
    assert_eq!(e.raw_os_error(), Some(libc::ESRCH));
    assert_eq!(
        otter_gocompat::oserr::go_error_string(&e),
        "no such process"
    );
}

#[test]
fn detach_starts_new_session() {
    let mut cmd = sh("sleep 60");
    PosixProcess.detach(&mut cmd);
    let mut child = cmd.spawn().expect("detach 한 명령이 시작되지 않는다");
    let pid = pid_of(&child);
    // SAFETY: getsid 는 메모리를 건드리지 않는다.
    let sid = unsafe { libc::getsid(pid) };
    let _ = PosixProcess.kill(pid);
    let _ = child.wait();
    assert_eq!(sid, pid, "새 세션이 아니다");
}

#[test]
fn new_group_starts_new_session() {
    let mut cmd = sh("sleep 60");
    let g = PosixProcess.new_group(&mut cmd);
    let mut child = cmd.spawn().unwrap();
    g.bind(&child).unwrap();
    let pid = pid_of(&child);
    // SAFETY: getpgid·getsid 는 메모리를 건드리지 않는다.
    let (pgid, sid) = unsafe { (libc::getpgid(pid), libc::getsid(pid)) };
    let _ = g.kill();
    let _ = child.wait();
    assert_eq!((pgid, sid), (pid, pid), "새 세션이 아니다");
}

#[test]
fn group_kills_descendants() {
    let d = tempfile::tempdir().unwrap();
    let pid_file = d.path().join("grandchild.pid");
    let script = format!("sleep 60 & echo $! > {}; sleep 60", pid_file.display());
    let mut cmd = sh(&script);
    let g = PosixProcess.new_group(&mut cmd);
    let mut child = cmd.spawn().unwrap();
    g.bind(&child).unwrap();
    let mut grandchild = 0;
    assert!(
        wait_until(Duration::from_secs(3), || {
            grandchild = std::fs::read_to_string(&pid_file)
                .ok()
                .and_then(|s| s.trim().parse().ok())
                .unwrap_or(0);
            grandchild > 0
        }),
        "손자 pid 를 얻지 못했다"
    );
    assert!(PosixProcess.alive(grandchild), "손자가 뜨지 않았다");
    g.kill().unwrap();
    let _ = child.wait();
    assert!(
        wait_until(Duration::from_secs(3), || !PosixProcess.alive(grandchild)),
        "그룹을 죽였는데 손자가 살아 있다"
    );
    g.close().unwrap();
    g.close().unwrap();
}

#[test]
fn group_signal_before_bind_is_noop() {
    let g = PosixProcess.new_group(&mut sh("true"));
    g.terminate().unwrap();
    g.kill().unwrap();
}

#[test]
fn shutdown_signals() {
    assert_eq!(
        PosixProcess.shutdown_signals(),
        [
            ShutdownSignal::Interrupt,
            ShutdownSignal::Terminate,
            ShutdownSignal::Hangup
        ]
    );
}
