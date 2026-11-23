//! 실제 프로세스로 띄운 데몬의 시험이다. 이 시험 바이너리는 `<bin> d [인자]` 로 불리면 Go 의
//! `dongminal d` 처럼 데몬이 된다 — 세션 유지 교체가 자기 실행 파일을 `d --handover-fd N` 으로
//! exec 하므로, 시험이 직접 main 을 가진다(harness = false).
//!
//! 임시 홈에서만 돈다. 사용 중인 데몬·서버의 소켓·포트에는 닿지 않는다.

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use dm_shared_dmenv as dmenv;
use dm_shared_handover as handover;
use dm_shared_toolhub::Placement;
use dm_webserver_toolclient::ToolClient;

const TEST_VERSION: &str = "boot-test";
const TEST_BUILD: &str = "boot-test-build";
/// Go 기준선을 각인 없이 빌드했을 때의 판(`cli.Version`)이다.
const GO_VERSION: &str = "dev";
const WAIT: Duration = Duration::from_secs(20);

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("d") {
        daemon_main(&args[2..]);
        return;
    }
    let filter: Vec<&String> = args[1..].iter().filter(|a| !a.starts_with('-')).collect();
    let cases: [(&str, fn()); 4] = [
        (
            "boot_listens_and_saves_on_signal",
            boot_listens_and_saves_on_signal,
        ),
        ("rust_reload_keeps_session", rust_reload_keeps_session),
        (
            "go_to_rust_reload_keeps_session",
            go_to_rust_reload_keeps_session,
        ),
        (
            "rust_to_go_reload_keeps_session",
            rust_to_go_reload_keeps_session,
        ),
    ];
    let mut failed = 0;
    for (name, f) in cases {
        if !filter.is_empty() && !filter.iter().any(|p| name.contains(p.as_str())) {
            continue;
        }
        let r = std::panic::catch_unwind(f);
        println!(
            "test {name} ... {}",
            if r.is_ok() { "ok" } else { "FAILED" }
        );
        failed += usize::from(r.is_err());
    }
    if failed > 0 {
        std::process::exit(1);
    }
}

/// Go `cmd/dongminal` 의 데몬 분기와 같다.
fn daemon_main(rest: &[String]) {
    dm_shared_dmlog::init(dm_shared_dmlog::Options {
        level: std::env::var(dmenv::ENV_LOG_LEVEL).unwrap_or_default(),
        out: None,
    });
    let dargs = match handover::parse_daemon_args(rest) {
        Ok(a) => a,
        Err(e) => {
            dm_shared_dmlog::errorf!(None, "{e}");
            std::process::exit(2);
        }
    };
    if dargs.version_query {
        println!("{}", handover::VERSION);
        return;
    }
    let home = std::env::var(dmenv::ENV_HOME).expect("DONGMINAL_HOME");
    dm_daemon_boot::run(&home, TEST_VERSION, TEST_BUILD, dargs.handover_fd);
}

// ── 도우미 ─────────────────────────────────────────────────────────────────

struct Daemon {
    home: tempfile::TempDir,
    child: Child,
    shell: i32,
}

impl Daemon {
    fn home(&self) -> &Path {
        self.home.path()
    }

    fn log(&self) -> String {
        std::fs::read_to_string(self.home().join("daemon.log")).unwrap_or_default()
    }

    fn bin(&self) -> PathBuf {
        self.home().join("dongminal")
    }
}

impl Drop for Daemon {
    fn drop(&mut self) {
        let p = dm_shared_platform::current().process;
        if self.shell > 0 {
            let _ = p.kill(self.shell);
        }
        let _ = p.terminate(self.child.id() as i32);
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if matches!(self.child.try_wait(), Ok(Some(_))) {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
        if std::thread::panicking() {
            eprintln!("daemon.log:\n{}", self.log());
        }
    }
}

/// 짧은 임시 홈이다(유닉스 소켓 경로 길이 상한). 운영 홈 아래면 멈춘다.
fn temp_home() -> tempfile::TempDir {
    let home = tempfile::Builder::new()
        .prefix("dmb")
        .tempdir_in("/tmp")
        .unwrap();
    let prod = std::env::var("HOME").map(|h| PathBuf::from(h).join(".dongminal"));
    if let Ok(prod) = prod {
        assert!(!home.path().starts_with(&prod), "운영 홈 아래다");
    }
    home
}

/// bin 을 홈 안 `dongminal` 로 복사해 `d` 로 띄운다.
fn spawn(bin: &Path) -> Daemon {
    let home = temp_home();
    let exe = home.path().join("dongminal");
    std::fs::copy(bin, &exe).unwrap();
    let log = std::fs::File::create(home.path().join("daemon.log")).unwrap();
    let mut cmd = Command::new(&exe);
    cmd.arg("d")
        .stdin(Stdio::null())
        .stdout(log.try_clone().unwrap())
        .stderr(log);
    for (k, _) in std::env::vars() {
        if k.starts_with("DONGMINAL_") {
            cmd.env_remove(k);
        }
    }
    cmd.env(dmenv::ENV_HOME, home.path())
        .env(dmenv::ENV_TOOL_HOME, home.path().join("tool-home"))
        .env("DONGMINAL_NO_UPDATE_CHECK", "1");
    let child = cmd.spawn().unwrap();
    let d = Daemon {
        home,
        child,
        shell: 0,
    };
    eventually("데몬 기동", || {
        handover::hello(d.home(), Duration::from_millis(200))
    });
    d
}

fn eventually(what: &str, mut cond: impl FnMut() -> bool) {
    let deadline = Instant::now() + WAIT;
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
    std::fs::read_to_string(home.join(dmenv::PANED_PID_FILE))
        .ok()
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(0)
}

fn dial(home: &Path) -> ToolClient {
    ToolClient::dial(dm_shared_platform::current().ipc.endpoint(home)).unwrap()
}

/// 셸 하나를 띄우고 그 셸의 pid 를 적어 둔다.
fn open_shell(d: &mut Daemon) -> String {
    let pc = dial(d.home());
    let cwd = d.home().to_string_lossy().into_owned();
    let tool = pc.create(&cwd, 80, 24, &Placement::default()).unwrap();
    let p1 = d.home().join("p1");
    pc.write(&tool.id, format!("echo $$ > {}\n", p1.display()).as_bytes())
        .unwrap();
    d.shell = read_pid(&p1);
    pc.close();
    tool.id
}

/// 교체를 걸고, 같은 pid 의 새 판이 같은 셸을 이어받았는지 본다 (TC-DSK-9, FR-RSP-22).
fn reload_and_check(d: &Daemon, tool: &str, new_build: &str) {
    let out = handover::reload(
        d.home(),
        &d.bin().to_string_lossy(),
        Duration::from_secs(15),
    );
    assert_eq!(out.kind, handover::Kind::Swapped, "reload = {out:?}");
    // 데몬은 교체 답을 쓴 뒤에 exec 한다(pid 는 같다). 새 판이 남기는 기동 줄을 함께 기다린다.
    let pid = d.child.id();
    eventually("교체 뒤 hello", || {
        d.log().contains("handover=true")
            && handover::hello(d.home(), Duration::from_millis(200))
            && pid_file(d.home()) == pid
    });
    let pc = dial(d.home());
    assert_eq!(pc.daemon_info().build, new_build, "교체 뒤의 판이 다르다");
    let info = pc.list().into_iter().find(|i| i.id == tool);
    let info = info.unwrap_or_else(|| panic!("교체 뒤 도구 {tool} 가 없다"));
    assert_eq!(info.pid, i64::from(d.shell), "셸 pid 가 바뀌었다");
    let p2 = d.home().join("p2");
    pc.write(tool, format!("echo $$ > {}\n", p2.display()).as_bytes())
        .unwrap();
    assert_eq!(read_pid(&p2), d.shell, "교체 뒤 입력이 다른 셸에 닿았다");
    pc.close();
}

fn self_bin() -> PathBuf {
    std::env::current_exe().unwrap()
}

/// Go 참조 바이너리(go1.27.2 로 기준선을 빌드한 것)다. 없으면 그 시험을 건너뛴다.
/// 만드는 법: `DM_GO_REF_SRC=<main 의 worktree> rust/scripts/go-ref.sh <bin> ./cmd/dongminal`.
fn go_bin() -> Option<PathBuf> {
    let p = std::env::var_os("DM_GO_DONGMINAL")?;
    Some(PathBuf::from(p))
}

/// 실행 중인 바이너리 자리를 다른 바이너리로 바꾼다. 지우고 새로 쓰므로 도는 프로세스는 옛
/// 파일을 그대로 쥔다(빌드가 같은 자리를 덮어쓰는 것과 같다).
fn replace_bin(at: &Path, with: &Path) {
    std::fs::remove_file(at).unwrap();
    std::fs::copy(with, at).unwrap();
}

// ── 시험 ───────────────────────────────────────────────────────────────────

/// 기동은 소켓·pid·지문을 남기고, 종료 신호를 받으면 도구를 저장하고 0 으로 끝난다.
fn boot_listens_and_saves_on_signal() {
    let mut d = spawn(&self_bin());
    let home = d.home().to_path_buf();
    assert_eq!(pid_file(&home), d.child.id());
    assert_eq!(
        std::fs::read_to_string(home.join(dm_shared_toolipc::DAEMON_BUILD_FILE)).unwrap(),
        format!("{TEST_BUILD}\n")
    );
    let pc = dial(&home);
    assert_eq!(pc.daemon_info().build, TEST_VERSION);
    pc.close();
    let log = d.log();
    assert!(
        log.contains(&format!(
            "dongminald starting home={} handover=false",
            home.display()
        )),
        "{log}"
    );
    let sock = dm_shared_platform::current().ipc.endpoint(&home);
    assert!(
        log.contains(&format!(
            "dongminald listening on {} (platform={})",
            sock.display(),
            dm_shared_platform::current().os
        )),
        "{log}"
    );
    let tool = open_shell(&mut d);

    dm_shared_platform::current()
        .process
        .terminate(d.child.id() as i32)
        .unwrap();
    let deadline = Instant::now() + WAIT;
    let status = loop {
        if let Some(s) = d.child.try_wait().unwrap() {
            break s;
        }
        assert!(Instant::now() < deadline, "종료 신호에 끝나지 않는다");
        std::thread::sleep(Duration::from_millis(50));
    };
    assert!(status.success(), "{status:?}");
    let log = d.log();
    assert!(
        log.contains("dongminald shutting down, saving 1 tools..."),
        "{log}"
    );
    let saved = std::fs::read_to_string(home.join("tools.json")).unwrap();
    assert!(saved.contains(&tool), "{saved}");
}

/// TC-DSK-9: 이 판에서 같은 판으로 실제로 교체한다.
fn rust_reload_keeps_session() {
    let mut d = spawn(&self_bin());
    let tool = open_shell(&mut d);
    reload_and_check(&d, &tool, TEST_VERSION);
}

/// FR-RSP-22: Go 데몬이 Rust 데몬에게 세션을 넘긴다.
fn go_to_rust_reload_keeps_session() {
    let Some(go) = go_bin() else {
        println!("ignored: DM_GO_DONGMINAL 없음");
        return;
    };
    let mut d = spawn(&go);
    let tool = open_shell(&mut d);
    assert_eq!(dial(d.home()).daemon_info().build, GO_VERSION);
    replace_bin(&d.bin(), &self_bin());
    reload_and_check(&d, &tool, TEST_VERSION);
}

/// FR-RSP-20 의 거꾸로 방향: Rust 데몬이 Go 데몬에게 세션을 넘긴다(되돌리기).
fn rust_to_go_reload_keeps_session() {
    let Some(go) = go_bin() else {
        println!("ignored: DM_GO_DONGMINAL 없음");
        return;
    };
    let mut d = spawn(&self_bin());
    let tool = open_shell(&mut d);
    replace_bin(&d.bin(), &go);
    reload_and_check(&d, &tool, GO_VERSION);
}
