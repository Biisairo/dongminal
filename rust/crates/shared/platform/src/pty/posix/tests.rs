use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use super::*;
use crate::handover::is_frozen;

fn err_of(r: io::Result<Box<dyn Terminal>>) -> io::Error {
    match r {
        Err(e) => e,
        Ok(_) => panic!("성공하면 안 된다"),
    }
}

fn environ() -> Vec<String> {
    std::env::vars().map(|(k, v)| format!("{k}={v}")).collect()
}

fn spec(path: &str, args: &[&str], env: Vec<String>, dir: &str) -> ProcSpec {
    ProcSpec {
        path: path.into(),
        args: args.iter().map(|a| (*a).to_owned()).collect(),
        env,
        dir: dir.into(),
    }
}

/// 테스트가 끝나면 셸을 끈다.
struct Guard(Arc<dyn Terminal>);

impl Drop for Guard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn start(s: ProcSpec) -> (Arc<dyn Terminal>, Guard) {
    let t: Arc<dyn Terminal> = Arc::from(PosixPty.start(s, 80, 24).unwrap());
    (t.clone(), Guard(t))
}

fn start_sleep() -> (Arc<dyn Terminal>, Guard, tempfile::TempDir) {
    let d = tempfile::tempdir().unwrap();
    let (t, g) = start(spec(
        "/bin/sh",
        &["sh", "-c", "sleep 30"],
        environ(),
        d.path().to_str().unwrap(),
    ));
    (t, g, d)
}

#[derive(Clone, Default)]
struct Collector(Arc<Mutex<Vec<u8>>>);

impl Collector {
    fn text(&self) -> String {
        String::from_utf8_lossy(&self.0.lock().unwrap()).into_owned()
    }
}

fn pump(t: Arc<dyn Terminal>, c: Collector) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let mut b = [0u8; 4096];
        loop {
            match t.read(&mut b) {
                Ok(0) => return,
                Ok(n) => c.0.lock().unwrap().extend_from_slice(&b[..n]),
                Err(e) if is_frozen(&e) => std::thread::sleep(Duration::from_millis(10)),
                Err(_) => return,
            }
        }
    })
}

fn wait_for(what: &str, mut cond: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !cond() {
        assert!(
            Instant::now() < deadline,
            "{what} 을(를) 기다리다 시한을 넘겼다"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn read_all(t: &Arc<dyn Terminal>) -> String {
    let c = Collector::default();
    pump(t.clone(), c.clone()).join().unwrap();
    c.text()
}

#[test]
fn size_follows_resize() {
    let (t, _g, _d) = start_sleep();
    assert_eq!(t.size().unwrap(), (80, 24));
    t.resize(132, 43).unwrap();
    assert_eq!(t.size().unwrap(), (132, 43));
}

#[test]
fn zero_size_is_clamped() {
    let d = tempfile::tempdir().unwrap();
    let t = PosixPty
        .start(
            spec(
                "/bin/sh",
                &["sh", "-c", "sleep 30"],
                environ(),
                d.path().to_str().unwrap(),
            ),
            0,
            0,
        )
        .unwrap();
    assert_eq!(t.size().unwrap(), (80, 24));
    let _ = t.kill();
    let _ = t.wait();
}

#[test]
fn size_after_close_errors() {
    let (t, _g, _d) = start_sleep();
    t.close().unwrap();
    assert!(t.size().is_err());
    assert!(t.resize(100, 40).is_err());
    assert!(t.write(b"x").is_err());
    assert_eq!(
        t.read(&mut [0u8; 8]).unwrap_err().to_string(),
        "file already closed"
    );
}

#[test]
fn size_races_close() {
    let (t, _g, _d) = start_sleep();
    let reader = pump(t.clone(), Collector::default());
    let sizer = {
        let t = t.clone();
        std::thread::spawn(move || {
            for _ in 0..2000 {
                if t.size().is_err() {
                    return;
                }
                let _ = t.resize(80, 24);
            }
        })
    };
    t.close().unwrap();
    reader.join().unwrap();
    sizer.join().unwrap();
}

#[test]
fn freeze_holds_output_in_kernel() {
    let (t, _g) = start(spec("/bin/cat", &["cat"], environ(), ""));
    let h = t
        .handover()
        .expect("POSIX 터미널이 Handover 를 갖지 않는다");
    let c = Collector::default();
    let done = pump(t.clone(), c.clone());
    t.write(b"before\n").unwrap();
    wait_for("before", || c.text().matches("before").count() >= 2);
    h.freeze();
    let seen = c.text();
    t.write(b"during\n").unwrap();
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(c.text(), seen, "멈춘 동안 읽었다");
    h.thaw();
    wait_for("during", || c.text().matches("during").count() >= 2);
    t.kill().unwrap();
    t.close().unwrap();
    done.join().unwrap();
}

#[test]
fn adopt_same_shell() {
    let (orig, _g) = start(spec("/bin/cat", &["cat"], environ(), ""));
    let pid = orig.pid();
    let master = orig.handover().unwrap().master_fd();
    // SAFETY: dup 는 정수만 다룬다.
    let fd = unsafe { libc::dup(i32::try_from(master).unwrap()) };
    assert!(fd >= 0);
    let adopted: Arc<dyn Terminal> =
        Arc::from(adopt_terminal(fd.unsigned_abs() as usize, pid).unwrap());
    assert_eq!(adopted.pid(), pid);
    adopted.resize(100, 30).unwrap();
    assert_eq!(adopted.size().unwrap(), (100, 30));
    let c = Collector::default();
    let done = pump(adopted.clone(), c.clone());
    adopted.write(b"adopted\n").unwrap();
    wait_for("adopted", || c.text().contains("adopted"));
    orig.close().unwrap();
    adopted.kill().unwrap();
    let (tx, rx) = std::sync::mpsc::channel();
    let a2 = adopted.clone();
    std::thread::spawn(move || {
        let _ = tx.send(a2.wait());
    });
    let st = rx
        .recv_timeout(Duration::from_secs(5))
        .expect("wait 가 셸을 거두지 못했다")
        .unwrap();
    assert_eq!(
        std::os::unix::process::ExitStatusExt::signal(&st),
        Some(libc::SIGKILL)
    );
    adopted.close().unwrap();
    done.join().unwrap();
}

#[test]
fn adopt_rejects_bad_fd_and_pid() {
    let e = err_of(adopt_terminal(
        9999,
        i32::try_from(std::process::id()).unwrap(),
    ));
    assert_eq!(
        e.to_string(),
        "fd 9999 는 의사 터미널이 아닙니다: bad file descriptor"
    );
    assert_eq!(
        err_of(adopt_terminal(0, 0)).to_string(),
        "셸 pid 가 아닙니다: 0"
    );
}

#[test]
fn env_order_and_argv_reach_child() {
    let env = vec![
        "ZZ=1".to_owned(),
        "AA=2".to_owned(),
        "ZZ=3".to_owned(),
        "PATH=/usr/bin:/bin".to_owned(),
    ];
    let (t, _g) = start(spec("env", &["env"], env, ""));
    let out = read_all(&t);
    let lines: Vec<&str> = out.lines().map(str::trim_end).collect();
    assert_eq!(
        lines,
        ["ZZ=3", "AA=2", "PATH=/usr/bin:/bin"],
        "Go 와 같이 중복 정리 뒤 원래 순서여야 한다"
    );
    let st = t.wait().unwrap();
    assert!(st.success());
}

#[test]
fn child_has_controlling_tty_and_own_session() {
    let (t, _g) = start(spec(
        "/bin/sh",
        &["sh", "-c", "tty; ps -o sess= -o pgid= -p $$"],
        environ(),
        "",
    ));
    let pid = t.pid();
    let out = read_all(&t);
    assert!(
        out.contains("/dev/tty") || out.contains("/dev/pts/"),
        "{out}"
    );
    let nums: Vec<i32> = out
        .split_whitespace()
        .filter_map(|s| s.parse().ok())
        .collect();
    // macOS ps 의 sess 는 세션 주소라 비교하지 않는다. pgid 는 셸 자신이다.
    assert_eq!(nums.last().copied(), Some(pid), "{out}");
}

#[test]
fn foreground_pgid_none_at_shell() {
    let (t, _g, _d) = start_sleep();
    // sleep 은 sh -c 가 exec 하므로 전경 그룹은 셸 자신의 그룹이다.
    std::thread::sleep(Duration::from_millis(100));
    assert_eq!(t.foreground_pgid(), None);
}

#[test]
fn eof_when_shell_exits() {
    let (t, _g) = start(spec("/bin/sh", &["sh", "-c", "printf done"], environ(), ""));
    assert_eq!(read_all(&t), "done");
    assert!(t.wait().unwrap().success());
    assert_eq!(
        t.wait().unwrap_err().to_string(),
        "exec: Wait was already called"
    );
    assert_eq!(
        t.kill().unwrap_err().to_string(),
        "os: process already finished"
    );
}

#[test]
fn start_errors_are_go_shaped() {
    let e = err_of(PosixPty.start(
        spec("dm-no-such-shell-7f3c", &["x"], vec![], "/tmp/w"),
        80,
        24,
    ));
    assert_eq!(
        e.to_string(),
        "pty start dm-no-such-shell-7f3c (cwd=/tmp/w): exec: \"dm-no-such-shell-7f3c\": executable file not found in $PATH"
    );
    let e = err_of(PosixPty.start(spec("/bin/sh", &["sh"], vec![], "/nonexistent-dm"), 80, 24));
    assert_eq!(
        e.to_string(),
        "pty start /bin/sh (cwd=/nonexistent-dm): chdir /nonexistent-dm: no such file or directory"
    );
    let e = err_of(PosixPty.start(spec("/nonexistent-dm/sh", &["sh"], vec![], ""), 80, 24));
    assert_eq!(
        e.to_string(),
        "pty start /nonexistent-dm/sh (cwd=): fork/exec /nonexistent-dm/sh: no such file or directory"
    );
}

#[test]
fn bare_name_resolves_via_parent_path() {
    // 자식 환경에 PATH 가 없어도 이 프로세스의 PATH 로 찾는다 (Go exec.Command).
    let (t, _g) = start(spec("sh", &["sh", "-c", "printf ok"], vec![], ""));
    assert_eq!(read_all(&t), "ok");
}
