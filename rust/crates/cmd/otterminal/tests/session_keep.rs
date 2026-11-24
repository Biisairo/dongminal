//! DAEMON_SESSION_KEEP_SRS TC-DSK-9: 이 실행 파일로 띄운 데몬을 실제로 교체한다. 데몬 pid 와 셸 pid
//! 가 그대로이고, 교체 뒤의 입력이 같은 셸에 닿는다. 임시 홈에서만 돈다.
#![cfg(unix)]

use std::fs::File;
use std::path::Path;
use std::process::{Child, Command};
use std::time::{Duration, Instant};

use otter_shared_handover as handover;
use otter_shared_toolhub::Placement;
use otter_webserver_toolclient::ToolClient;

const BIN: &str = env!("CARGO_BIN_EXE_otterminal");

fn eventually(what: &str, mut cond: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(20);
    while !cond() {
        assert!(
            Instant::now() < deadline,
            "{what} 을(를) 기다리다 시한을 넘겼다"
        );
        std::thread::sleep(Duration::from_millis(100));
    }
}

fn read_pid(path: &Path) -> i32 {
    let mut pid = 0;
    eventually(&path.display().to_string(), || {
        pid = std::fs::read_to_string(path)
            .ok()
            .and_then(|s| s.trim().parse().ok())
            .unwrap_or(0);
        pid > 0
    });
    pid
}

fn pid_file(home: &Path) -> u32 {
    std::fs::read_to_string(home.join(otter_shared_otterenv::PANED_PID_FILE))
        .ok()
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(0)
}

struct Cleanup {
    daemon: Child,
    shell: i32,
    home: std::path::PathBuf,
}

impl Drop for Cleanup {
    fn drop(&mut self) {
        let p = otter_shared_platform::current().process;
        if self.shell > 0 {
            let _ = p.kill(self.shell);
        }
        let pid = i32::try_from(self.daemon.id()).unwrap_or(0);
        let _ = p.terminate(pid);
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if let Ok(Some(_)) = self.daemon.try_wait() {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let _ = self.daemon.kill();
        let _ = self.daemon.wait();
        if std::thread::panicking() {
            let log = std::fs::read_to_string(self.home.join("daemon.log")).unwrap_or_default();
            eprintln!("daemon.log:\n{log}");
        }
    }
}

#[test]
fn real_reload_keeps_daemon_and_shell() {
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().to_path_buf();
    let logf = File::create(home.join("daemon.log")).unwrap();
    let mut cmd = Command::new(BIN);
    cmd.arg("d");
    for (k, _) in std::env::vars_os() {
        if k.to_string_lossy().starts_with("OTTERMINAL_") {
            cmd.env_remove(k);
        }
    }
    cmd.env("OTTERMINAL_HOME", &home)
        .env("OTTERMINAL_TOOL_HOME", home.join("tool-home"))
        .stdout(logf.try_clone().unwrap())
        .stderr(logf);
    let mut g = Cleanup {
        daemon: cmd.spawn().unwrap(),
        shell: 0,
        home: home.clone(),
    };
    eventually("데몬 기동", || {
        handover::hello(&home, Duration::from_millis(200))
    });

    let sock = otter_shared_platform::current().ipc.endpoint(&home);
    let pc = ToolClient::dial(&sock).unwrap();
    let tool = pc
        .create(home.to_str().unwrap(), 80, 24, &Placement::default())
        .unwrap();
    let p1 = home.join("p1");
    pc.write(&tool.id, format!("echo $$ > {}\n", p1.display()).as_bytes())
        .unwrap();
    g.shell = read_pid(&p1);
    drop(pc);

    let out = handover::reload(&home, BIN, Duration::from_secs(15));
    assert_eq!(out.kind, handover::Kind::Swapped, "{out:?}");
    // 데몬은 교체 답을 쓴 뒤에 새 판으로 exec 한다(pid 는 같다). 새 판의 기동 줄을 함께 기다린다.
    let daemon_pid = g.daemon.id();
    eventually("교체 뒤 hello", || {
        let log = std::fs::read_to_string(home.join("daemon.log")).unwrap_or_default();
        log.contains("handover=true")
            && handover::hello(&home, Duration::from_millis(200))
            && pid_file(&home) == daemon_pid
    });

    let pc2 = ToolClient::dial(&sock).unwrap();
    let info = pc2
        .list()
        .into_iter()
        .find(|i| i.id == tool.id)
        .unwrap_or_else(|| panic!("교체 뒤 도구 {} 가 없다", tool.id));
    assert_eq!(info.pid, i64::from(g.shell), "셸 pid 가 바뀌었다");
    let p2 = home.join("p2");
    pc2.write(&tool.id, format!("echo $$ > {}\n", p2.display()).as_bytes())
        .unwrap();
    assert_eq!(read_pid(&p2), g.shell, "교체 뒤 입력이 다른 셸에 닿았다");
}
