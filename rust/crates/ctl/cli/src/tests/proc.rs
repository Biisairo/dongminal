use std::path::Path;
use std::process::Command;
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

use otter_shared_platform::{Group, Process, ShutdownSignal};

use crate::homelayout::{DAEMON_PID_FILE, DAEMON_SOCK_FILE};
use crate::proc::{Procs, daemon_ours, kill_port, stop_daemon};

/// 종료 요청의 결과를 시험자가 정하는 프로세스 제어다. SIGKILL 을 견디는 프로세스는 실기로
/// 만들 수 없어 "정지 실패" 경로를 이것으로 잰다.
#[derive(Default)]
pub(crate) struct FakeProc {
    state: Mutex<State>,
}

#[derive(Default, Clone, Copy)]
struct State {
    alive: bool,
    die_on_term: bool,
    die_on_kill: bool,
    terms: usize,
    kills: usize,
}

impl FakeProc {
    pub(crate) fn new(alive: bool, die_on_term: bool, die_on_kill: bool) -> Self {
        Self {
            state: Mutex::new(State {
                alive,
                die_on_term,
                die_on_kill,
                ..Default::default()
            }),
        }
    }

    fn st(&self) -> State {
        *self.state.lock().unwrap()
    }

    pub(crate) fn counts(&self) -> (usize, usize) {
        let s = self.st();
        (s.terms, s.kills)
    }
}

impl Process for FakeProc {
    fn alive(&self, _: i32) -> bool {
        self.st().alive
    }
    fn terminate(&self, _: i32) -> std::io::Result<()> {
        let mut s = self.state.lock().unwrap();
        s.terms += 1;
        if s.die_on_term {
            s.alive = false;
        }
        Ok(())
    }
    fn kill(&self, _: i32) -> std::io::Result<()> {
        let mut s = self.state.lock().unwrap();
        s.kills += 1;
        if s.die_on_kill {
            s.alive = false;
        }
        Ok(())
    }
    fn detach(&self, _: &mut Command) {}
    fn shutdown_signals(&self) -> &'static [ShutdownSignal] {
        &[]
    }
    fn new_group(&self, _: &mut Command) -> Box<dyn Group> {
        panic!("프로세스 묶음을 쓰지 않는다")
    }
}

fn no_listener(_: &str) -> Vec<i32> {
    Vec::new()
}

pub(crate) fn write_pid(home: &Path, pid: &str) {
    std::fs::write(home.join(DAEMON_PID_FILE), pid).unwrap();
}

/// pid 가 적힌 pidfile 과 종단 파일을 갖춘 홈이다.
fn stop_home(pid: &str) -> tempfile::TempDir {
    let d = tempfile::tempdir().unwrap();
    write_pid(d.path(), pid);
    std::fs::write(d.path().join(DAEMON_SOCK_FILE), "").unwrap();
    d
}

/// 답하는 소켓을 세운 홈이다. 이것이 없으면 FBE-07 판정 때문에 종료 갈래에 닿지 못한다.
pub(crate) struct LiveSocket {
    _listener: otter_shared_platform::IpcListener,
}

pub(crate) fn live_socket(home: &Path) -> LiveSocket {
    let tr = otter_shared_platform::current().ipc;
    let ep = tr.endpoint(home);
    let _ = tr.remove(&ep);
    let ln = tr.listen(&ep).unwrap();
    LiveSocket { _listener: ln }
}

fn stop_home_live(pid: &str) -> (tempfile::TempDir, LiveSocket) {
    let d = stop_home(pid);
    let s = live_socket(d.path());
    (d, s)
}

fn stop(home: &Path, f: &FakeProc) -> (bool, String) {
    let ps = Procs {
        proc: f,
        pids_on_port: &no_listener,
    };
    let mut out = Vec::new();
    let ok = stop_daemon(home.to_str().unwrap(), &mut out, &ps);
    (ok, String::from_utf8(out).unwrap())
}

// 종료 시도가 먹히지 않으면 false 다. 잔여물은 남긴다 — 다음 stop 이 다시 찾을 수 있게.
#[test]
fn stop_daemon_still_alive_reports_failure() {
    let f = FakeProc::new(true, false, false);
    let (d, _s) = stop_home_live("4242");
    let (ok, out) = stop(d.path(), &f);
    assert!(!ok);
    assert_eq!(f.counts(), (1, 1));
    assert!(d.path().join(DAEMON_PID_FILE).exists());
    assert_eq!(
        out,
        "otterminald 정지 중 pid=4242...\n강제 종료...\notterminald pid=4242 가 아직 살아 있습니다\n"
    );
}

// Terminate 로 죽으면 Kill 까지 가지 않고, 잔여물은 치운다.
#[test]
fn stop_daemon_terminate_succeeds() {
    let f = FakeProc::new(true, true, false);
    let (d, _s) = stop_home_live("4242");
    let (ok, out) = stop(d.path(), &f);
    assert!(ok);
    assert_eq!(f.counts(), (1, 0));
    assert!(!d.path().join(DAEMON_PID_FILE).exists());
    assert!(!d.path().join(DAEMON_SOCK_FILE).exists());
    assert_eq!(out, "otterminald 정지 중 pid=4242...\n");
}

#[test]
fn stop_daemon_kill_succeeds() {
    let f = FakeProc::new(true, false, true);
    let (d, _s) = stop_home_live("4242");
    assert!(stop(d.path(), &f).0);
    assert_eq!(f.counts().1, 1);
}

// 낡은 pidfile 만 남은 홈은 잔여물 정리 후 성공이다.
#[test]
fn stop_daemon_stale_pidfile_is_success() {
    let f = FakeProc::new(false, false, false);
    let d = stop_home("4242");
    let (ok, out) = stop(d.path(), &f);
    assert!(ok);
    assert!(!d.path().join(DAEMON_PID_FILE).exists());
    assert_eq!(out, "otterminald 미실행 (낡은 pidfile 제거)\n");
}

// FBE-07: 살아 있는 pid 라도 소켓이 답하지 않으면 신호를 보내지 않는다.
#[test]
fn stop_daemon_never_signals_unverified_pid() {
    let f = FakeProc::new(true, true, true);
    let d = stop_home("4242");
    let (ok, out) = stop(d.path(), &f);
    assert!(ok);
    assert_eq!(f.counts(), (0, 0));
    assert_eq!(out, "otterminald 미실행 (낡은 pidfile 제거)\n");
}

#[test]
fn stop_daemon_without_pidfile() {
    let f = FakeProc::new(false, false, false);
    let d = tempfile::tempdir().unwrap();
    assert_eq!(
        stop(d.path(), &f),
        (true, "otterminald 미실행\n".to_owned())
    );
}

// ── killPort (TEST-3) ──

fn run_kill_port(f: &FakeProc, lookup: &dyn Fn(&str) -> Vec<i32>) -> (bool, String) {
    let ps = Procs {
        proc: f,
        pids_on_port: lookup,
    };
    let mut out = Vec::new();
    let ok = kill_port("54321", &mut out, "테스트", &ps);
    (ok, String::from_utf8(out).unwrap())
}

#[test]
fn kill_port_table() {
    // (점유, TERM 에 죽음, KILL 에 죽음, 성공, TERM 수, KILL 수)
    let cases = [
        (false, false, false, true, 0, 0),
        (true, true, false, true, 1, 0),
        (true, false, true, true, 1, 1),
        (true, false, false, false, 1, 1),
    ];
    for (occupied, term, kill, want, wt, wk) in cases {
        let f = FakeProc::new(true, term, kill);
        let lookup = |_: &str| {
            if occupied && f.alive(0) {
                vec![111]
            } else {
                Vec::new()
            }
        };
        let (ok, _) = run_kill_port(&f, &lookup);
        assert_eq!(ok, want, "{occupied} {term} {kill}");
        assert_eq!(f.counts(), (wt, wk), "{occupied} {term} {kill}");
    }
}

#[test]
fn kill_port_output() {
    let f = FakeProc::new(true, false, true);
    let lookup = |_: &str| if f.alive(0) { vec![111] } else { Vec::new() };
    let (_, out) = run_kill_port(&f, &lookup);
    assert_eq!(out, "테스트 (포트 54321) 정지 중...\n강제 종료...\n");
}

// FR-RGS-44: 정지 한 번의 포트 관측은 처음·TERM 대기 뒤·끝 3회 이하다.
#[test]
fn kill_port_listener_lookups() {
    let f = FakeProc::new(true, false, true);
    let n = AtomicUsize::new(0);
    let lookup = |_: &str| {
        n.fetch_add(1, Ordering::SeqCst);
        if f.alive(0) { vec![111] } else { Vec::new() }
    };
    assert!(run_kill_port(&f, &lookup).0);
    assert!(
        n.load(Ordering::SeqCst) <= 3,
        "{}",
        n.load(Ordering::SeqCst)
    );
}

// ── daemonOurs (FBE-07) ──

#[test]
fn daemon_ours_when_socket_answers() {
    let d = tempfile::tempdir().unwrap();
    let _s = live_socket(d.path());
    write_pid(d.path(), &format!("{}\n", std::process::id()));
    let p = otter_shared_platform::current().process;
    assert!(daemon_ours(d.path().to_str().unwrap(), p).1);
}

#[test]
fn daemon_not_ours_when_socket_silent() {
    let d = tempfile::tempdir().unwrap();
    write_pid(d.path(), &format!("{}\n", std::process::id()));
    let p = otter_shared_platform::current().process;
    assert!(!daemon_ours(d.path().to_str().unwrap(), p).1);
}

#[test]
fn daemon_not_ours_without_pidfile() {
    let d = tempfile::tempdir().unwrap();
    let p = otter_shared_platform::current().process;
    assert!(!daemon_ours(d.path().to_str().unwrap(), p).1);
}
