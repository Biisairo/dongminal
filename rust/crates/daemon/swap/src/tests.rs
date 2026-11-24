//! Go 시험(validate_test·reload_posix_test·recover_posix_test)과 같은 입력·기대값이다. JSON 골든은
//! go1.27.2 `json.Marshal(swap.State{…})` 의 실측 바이트다 (FR-RSP-22).

use std::collections::{BTreeMap, HashSet};
use std::fs::File;
use std::os::fd::{AsRawFd, BorrowedFd, OwnedFd};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use nix::fcntl::{FcntlArg, FdFlag, fcntl};
use otter_daemon_ipc::PanedServer;
use otter_gocompat::json::{self, RawMessage};
use otter_shared_handover::{self as handover, ReloadRequest};
use otter_shared_platform::{ProcSpec, Terminal};
use otter_shared_toolhub::{HandoverTool, Placement, Tool, ToolManager, ToolState};
use tempfile::TempDir;

use crate::*;

/// 시험에서 다른 이가 소유한 fd 를 잠시 빌린다.
fn borrow(fd: i32) -> BorrowedFd<'static> {
    // SAFETY: 시험이 살아 있는 동안 열려 있는 fd 만 넘긴다(도구 마스터·인계 상태 fd).
    unsafe { BorrowedFd::borrow_raw(fd) }
}

fn cloexec(fd: u64) -> bool {
    let v = fcntl(borrow(i32::try_from(fd).unwrap()), FcntlArg::F_GETFD).unwrap();
    FdFlag::from_bits_truncate(v).contains(FdFlag::FD_CLOEXEC)
}

fn euid() -> u32 {
    nix::unistd::geteuid().as_raw()
}

fn write_exe(dir: &Path, name: &str, script: &str, mode: u32) -> String {
    use std::os::unix::fs::PermissionsExt;
    let p = dir.join(name);
    std::fs::write(&p, format!("#!/bin/sh\n{script}\n")).unwrap();
    std::fs::set_permissions(&p, std::fs::Permissions::from_mode(mode)).unwrap();
    p.to_str().unwrap().to_owned()
}

fn reason_of(r: Result<(), String>) -> String {
    match r {
        Ok(()) => String::new(),
        Err(e) => e.split_once(": ").map_or(e.clone(), |(r, _)| r.to_owned()),
    }
}

fn env(euid: u32, goos: &str, self_exe: &str) -> Env {
    Env {
        euid,
        goos: goos.to_owned(),
        self_exe: self_exe.to_owned(),
    }
}

// TC-DSK-5 (FR-DSK-11): 요청 검사의 거절이 각 사유 코드로 나온다.
#[test]
fn validate_refusals() {
    let d = TempDir::new().unwrap();
    let dir = d.path();
    let good = write_exe(dir, "good", "exit 0", 0o755);
    let other = write_exe(dir, "other", "exit 0", 0o755);
    let noexec = write_exe(dir, "noexec", "exit 0", 0o644);
    let link = dir.join("link");
    std::os::unix::fs::symlink(&good, &link).unwrap();
    let link = link.to_str().unwrap().to_owned();
    let me = euid();
    let slf = otter_gocompat::filepath::eval_symlinks(&good).unwrap();
    let none = dir.join("none").to_str().unwrap().to_owned();
    let dirs = dir.to_str().unwrap().to_owned();
    let v = handover::VERSION;
    let rq = |exe: &str, h: i64| ReloadRequest {
        exe: exe.to_owned(),
        handover: h,
    };
    let cases: Vec<(&str, ReloadRequest, Env, &str)> = vec![
        ("정상", rq(&good, v), env(me, "darwin", &slf), ""),
        (
            "상대경로",
            rq("bin/otterminal", v),
            env(me, "darwin", &slf),
            handover::REASON_EXE,
        ),
        (
            "없는 파일",
            rq(&none, v),
            env(me, "darwin", &slf),
            handover::REASON_EXE,
        ),
        (
            "디렉터리",
            rq(&dirs, v),
            env(me, "darwin", &slf),
            handover::REASON_EXE,
        ),
        (
            "링크로 가리킨 자기 경로",
            rq(&link, v),
            env(me, "darwin", &slf),
            "",
        ),
        (
            "다른 바이너리",
            rq(&other, v),
            env(me, "darwin", &slf),
            handover::REASON_EXE,
        ),
        (
            "자기 경로 모름",
            rq(&good, v),
            env(me, "darwin", ""),
            handover::REASON_EXE,
        ),
        (
            "실행 불가",
            rq(&noexec, v),
            env(me, "darwin", &slf),
            handover::REASON_EXE,
        ),
        (
            "소유자 다름",
            rq(&good, v),
            env(me + 1, "darwin", &slf),
            handover::REASON_EXE,
        ),
        (
            "판 다름",
            rq(&good, v + 1),
            env(me, "darwin", &slf),
            handover::REASON_VERSION,
        ),
        (
            "Windows",
            rq(&good, v),
            env(me, "windows", &slf),
            handover::REASON_UNSUPPORTED,
        ),
    ];
    for (name, req, e, want) in cases {
        assert_eq!(reason_of(validate(&req, &e)), want, "{name}");
    }
}

/// 거절 문구는 보고 소켓이 그대로 답하므로 Go 와 바이트가 같다.
#[test]
fn validate_messages() {
    let d = TempDir::new().unwrap();
    let dir = d.path();
    let good = write_exe(dir, "good", "exit 0", 0o755);
    let noexec = write_exe(dir, "noexec", "exit 0", 0o644);
    let slf = otter_gocompat::filepath::eval_symlinks(&good).unwrap();
    let none = dir.join("none").to_str().unwrap().to_owned();
    let dirs = dir.to_str().unwrap().to_owned();
    let me = euid();
    let msg = |exe: &str, h: i64, e: Env| {
        validate(
            &ReloadRequest {
                exe: exe.to_owned(),
                handover: h,
            },
            &e,
        )
        .unwrap_err()
    };
    let e = || env(me, "darwin", &slf);
    assert_eq!(
        msg(&good, 1, env(me, "windows", &slf)),
        "reload_unsupported: 이 OS 는 세션 유지 교체를 지원하지 않습니다"
    );
    assert_eq!(
        msg(&good, 2, e()),
        "reload_version: 인계 판이 다릅니다 (요청 2, 데몬 1)"
    );
    assert_eq!(
        msg("bin/d\"x", 1, e()),
        r#"reload_exe: 절대경로가 아닙니다: "bin/d\"x""#
    );
    assert_eq!(
        msg(&none, 1, e()),
        format!("reload_exe: stat {none}: no such file or directory")
    );
    assert_eq!(
        msg(&dirs, 1, e()),
        format!("reload_exe: 일반 파일이 아닙니다: {dirs}")
    );
    assert_eq!(
        msg(&noexec, 1, e()),
        format!("reload_exe: 실행할 수 없습니다: {noexec}")
    );
    assert_eq!(
        msg(&good, 1, env(me + 1, "darwin", &slf)),
        format!("reload_exe: 파일 소유자가 데몬 사용자가 아닙니다: {good}")
    );
    assert_eq!(
        msg(&good, 1, env(me, "darwin", "/x/self")),
        format!(
            "reload_exe: 데몬 자신의 실행 파일이 아닙니다: {good} (데몬 /x/self) — otterminal start --refresh-daemon 을 쓰세요"
        )
    );
}

// TC-DSK-6 (FR-DSK-12): 새 바이너리가 같은 인계 판을 말해야 통과한다.
#[test]
fn preflight_versions() {
    let d = TempDir::new().unwrap();
    let dir = d.path();
    let v = handover::VERSION;
    let same = write_exe(
        dir,
        "same",
        &format!(r#"[ "$1 $2" = "d --handover-version" ] && echo {v}"#),
        0o755,
    );
    let other = write_exe(dir, "other", &format!("echo {}", v + 1), 0o755);
    let fails = write_exe(dir, "fails", &format!("echo {v}; exit 3"), 0o755);
    let slow = write_exe(dir, "slow", "sleep 5", 0o755);
    let junk = write_exe(dir, "junk", "echo hello", 0o755);
    let sec = Duration::from_secs(1);

    preflight(&same, sec).unwrap();
    assert_eq!(
        preflight(&other, sec).unwrap_err(),
        "reload_preflight: 새 바이너리의 인계 판이 다릅니다 (2, 데몬 1)"
    );
    assert_eq!(
        preflight(&fails, sec).unwrap_err(),
        "reload_preflight: 새 바이너리 실행 실패: exit status 3"
    );
    assert_eq!(
        preflight(&junk, sec).unwrap_err(),
        r#"reload_preflight: 새 바이너리가 인계 판을 말하지 않았습니다: "hello\n""#
    );
    let start = Instant::now();
    assert_eq!(
        preflight(&slow, Duration::from_millis(200)).unwrap_err(),
        "reload_preflight: 새 바이너리가 200ms 안에 답하지 않았습니다"
    );
    assert!(
        start.elapsed() < Duration::from_secs(2),
        "{:?}",
        start.elapsed()
    );
}

// FR-DSK-11: 진행 중인 교체가 있으면 다음 요청은 reload_busy 다.
#[test]
fn gate_busy() {
    let g = Gate::default();
    assert!(g.enter());
    assert!(!g.enter());
    g.leave();
    assert!(g.enter());
}

// FR-DSK-14·20: 인계 상태는 fd 로 읽힌다. 디스크에 이름이 없다 (D-DSK-12).
#[test]
fn state_write_read_anonymous() {
    let d = TempDir::new().unwrap();
    let st = State {
        version: handover::VERSION,
        tools: Some(vec![HandoverTool {
            id: "t1".into(),
            screen: b"hi".to_vec(),
            offset: 9,
            ..HandoverTool::default()
        }]),
        paned_fd: 7,
        report_fd: 8,
        ..State::default()
    };
    let f = write_state(d.path(), &st).unwrap();
    assert_eq!(std::fs::read_dir(d.path()).unwrap().count(), 0);
    assert_eq!(read_state(f).unwrap(), st);
}

const GO_EMPTY: &str = r#"{"version":1,"tools":null,"panedFd":0,"reportFd":0}"#;
const GO_FULL: &str = r#"{"version":1,"tools":[{"id":"t1","name":"sh","fd":12,"pid":345,"cols":80,"rows":24,"background":true,"screen":"aGkbWzBt","offset":9,"modes":3,"cwd":"/tmp/x","agent":{"agentSeen":false,"armed":false,"attention":false,"lastOutputAt":0,"rearmLocked":false,"turn":{"inProgress":false,"waitingSignaled":false,"turnRan":false}},"records":{"k":{"a":1}}}],"global":{"g":[1,2]},"panedFd":7,"reportFd":8}"#;

fn full_state() -> State {
    State {
        version: 1,
        tools: Some(vec![HandoverTool {
            id: "t1".into(),
            name: "sh".into(),
            fd: 12,
            pid: 345,
            cols: 80,
            rows: 24,
            background: true,
            screen: b"hi\x1b[0m".to_vec(),
            offset: 9,
            modes: 3,
            cwd: "/tmp/x".into(),
            records: BTreeMap::from([("k".into(), RawMessage(br#"{"a":1}"#.to_vec()))]),
            ..HandoverTool::default()
        }]),
        global: BTreeMap::from([("g".into(), RawMessage(b"[1,2]".to_vec()))]),
        paned_fd: 7,
        report_fd: 8,
    }
}

/// FR-RSP-22: Rust 가 쓴 인계 상태는 Go 와 바이트가 같고, Go 가 쓴 인계 상태를 Rust 가 읽는다.
#[test]
fn state_json_matches_go() {
    assert_eq!(
        String::from_utf8(
            json::marshal(&State {
                version: 1,
                ..State::default()
            })
            .unwrap()
        )
        .unwrap(),
        GO_EMPTY
    );
    assert_eq!(
        String::from_utf8(json::marshal(&full_state()).unwrap()).unwrap(),
        GO_FULL
    );
    let d = TempDir::new().unwrap();
    let p = d.path().join("go-state");
    std::fs::write(&p, GO_FULL).unwrap();
    assert_eq!(read_state(File::open(&p).unwrap()).unwrap(), full_state());
}

#[test]
fn read_state_errors_match_go() {
    let d = TempDir::new().unwrap();
    let p = d.path().join("empty");
    std::fs::write(&p, "").unwrap();
    assert_eq!(
        read_state(File::open(&p).unwrap()).unwrap_err().to_string(),
        "인계 상태 읽기: EOF"
    );
    std::fs::write(&p, r#"{"version":"x"}"#).unwrap();
    assert_eq!(
        read_state(File::open(&p).unwrap()).unwrap_err().to_string(),
        "인계 상태 읽기: json: cannot unmarshal string into Go struct field State.version of type int"
    );
}

/// 임시 홈에 소켓 둘과 cat 도구 하나를 세운다. 사용 중인 데몬에는 닿지 않는다.
struct Rig {
    self_exe: String,
    home: TempDir,
    pm: Arc<ToolManager>,
    ps: PanedServer,
    tool: Arc<Tool>,
}

impl Drop for Rig {
    fn drop(&mut self) {
        // 비동기 저장이 지운 임시 홈에 쓰지 않게 한다.
        self.pm.stop_saving();
        let _ = self.pm.delete(&self.tool.id);
        self.ps.close();
    }
}

fn self_exe() -> String {
    let exe = std::env::current_exe().unwrap();
    otter_gocompat::filepath::eval_symlinks(exe.to_str().unwrap()).unwrap()
}

fn rig() -> Rig {
    let home = tempfile::Builder::new().prefix("dsk").tempdir().unwrap();
    let h = home.path();
    let pm = Arc::new(ToolManager::new(h.to_str().unwrap(), None));
    let ps = PanedServer::new(Arc::clone(&pm), &h.join("s"), None);
    ps.listen().unwrap();
    ps.listen_reports(&h.join(otter_shared_agentrec::SOCKET_FILE))
        .unwrap();
    let tool = pm
        .create(
            h.to_str().unwrap(),
            80,
            24,
            Placement {
                command: "cat".into(),
                ..Placement::default()
            },
        )
        .unwrap();
    Rig {
        self_exe: self_exe(),
        home,
        pm,
        ps,
        tool,
    }
}

impl Rig {
    fn reloader(&self, exec: ExecFn) -> Arc<Reloader> {
        Reloader::new(Deps {
            home: self.home.path().to_path_buf(),
            tools: Arc::clone(&self.pm),
            server: self.ps.clone(),
            env: env(euid(), "darwin", &self.self_exe),
            preflight: Some(Arc::new(|_: &str| Ok(()))),
            exec,
        })
    }
}

fn req() -> ReloadRequest {
    ReloadRequest {
        exe: std::env::current_exe()
            .unwrap()
            .to_str()
            .unwrap()
            .to_owned(),
        handover: handover::VERSION,
    }
}

/// reload 는 런타임 작업 스레드 밖에서 부른다(보고 소켓의 연결 스레드와 같다).
async fn reload(
    rl: &Arc<Reloader>,
    req: ReloadRequest,
) -> Result<Box<dyn FnOnce() + Send>, String> {
    let rl = Arc::clone(rl);
    tokio::task::spawn_blocking(move || rl.reload(&req))
        .await
        .unwrap()
}

fn wait_output(t: &Tool, want: &str) {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let s = t.stream().unwrap().snapshot().0;
        if String::from_utf8_lossy(&s).contains(want) {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "[{}] {want:?} 가 나오지 않는다",
            t.id
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[derive(Default)]
struct Seen {
    argv: Vec<String>,
    master: u64,
    master_cloexec: bool,
    state_cloexec: bool,
    state: Option<State>,
}

// TC-DSK-7 (FR-DSK-13·14): commit 은 넘길 fd 의 close-on-exec 를 지우고, 인계 상태 fd 를
// 인자로 실어 exec 한다. 그 fd 를 읽으면 도구가 담겨 있다.
#[tokio::test(flavor = "multi_thread")]
async fn reload_commit_execs_with_state() {
    let r = rig();
    let seen = Arc::new(Mutex::new(Seen::default()));
    let s2 = Arc::clone(&seen);
    let rl = r.reloader(Arc::new(move |_: &str, argv: &[String], _: &[String]| {
        let mut s = s2.lock().unwrap();
        s.argv = argv.to_vec();
        let fd: i32 = argv[argv.len() - 1].parse().unwrap();
        s.state_cloexec = cloexec(u64::try_from(fd).unwrap());
        let dup: OwnedFd = nix::unistd::dup(borrow(fd)).unwrap();
        let st = read_state(File::from(dup)).unwrap();
        s.master = st.tools.as_ref().unwrap()[0].fd;
        s.master_cloexec = cloexec(s.master);
        s.state = Some(st);
        std::io::Error::other("시험: exec 하지 않는다")
    }));
    let commit = reload(&rl, req()).await.unwrap();
    tokio::task::spawn_blocking(commit).await.unwrap();
    let s = std::mem::take(&mut *seen.lock().unwrap());
    assert_eq!(s.argv.len(), 4, "{:?}", s.argv);
    assert_eq!(s.argv[0], r.self_exe);
    assert_eq!(&s.argv[1..3], ["d", handover::ARG_FD]);
    let st = s.state.as_ref().unwrap();
    let tools = st.tools.as_ref().unwrap();
    assert_eq!((tools.len(), tools[0].id.as_str()), (1, r.tool.id.as_str()));
    assert!(
        !s.master_cloexec && !s.state_cloexec,
        "exec 순간에 close-on-exec 였다"
    );
    // exec 가 실패했으므로 모두 되돌린다.
    assert!(
        cloexec(s.master),
        "되돌린 뒤에도 도구 fd 의 close-on-exec 가 지워져 있다"
    );
    r.tool.write(b"after\n").unwrap();
    wait_output(&r.tool, "after");
    assert!(
        reload(&rl, req()).await.is_ok(),
        "되돌린 뒤 다시 교체할 수 없다"
    );
}

// FR-DSK-11: 진행 중이면 reload_busy, 검사 거절이면 아무것도 멈추지 않는다.
#[tokio::test(flavor = "multi_thread")]
async fn reload_busy_and_refusal_leave_tools_running() {
    let r = rig();
    let rl = r.reloader(Arc::new(|_: &str, _: &[String], _: &[String]| {
        std::io::Error::other("x")
    }));
    let _held = reload(&rl, req()).await.unwrap();
    let e = reload(&rl, req()).await.err().unwrap();
    assert_eq!(e, "reload_busy: 다른 교체가 진행 중입니다");

    let r2 = rig();
    let rl2 = r2.reloader(Arc::new(|_: &str, _: &[String], _: &[String]| {
        std::io::Error::other("x")
    }));
    let mut bad = req();
    bad.handover += 1;
    let e = reload(&rl2, bad).await.err().unwrap();
    assert!(e.starts_with("reload_version: "), "{e}");
    let p = r2
        .pm
        .create(
            r2.home.path().to_str().unwrap(),
            80,
            24,
            Placement {
                command: "cat".into(),
                ..Placement::default()
            },
        )
        .expect("거절 뒤 도구 생성이 막혀 있다");
    let _ = r2.pm.delete(&p.id);
    // 멈춘 채 남은 첫 rig 의 도구를 풀어 정리가 막히지 않게 한다.
    r.pm.thaw_all();
}

/// FR-RSP-22: 한 데몬이 담은 인계 상태와 fd 로 다른 데몬(새 ToolManager·PanedServer)이 도구를
/// 되살린다 — exec 를 뺀 handover 왕복이다. 되살린 도구는 같은 셸이고 입력이 닿는다.
#[tokio::test(flavor = "multi_thread")]
async fn handover_roundtrip_restores_tool() {
    let r = rig();
    r.tool.write(b"before\n").unwrap();
    wait_output(&r.tool, "before");
    let pid = r.tool.cmd_process_pid();
    let got: Arc<Mutex<Option<State>>> = Arc::default();
    let g2 = Arc::clone(&got);
    let rl = r.reloader(Arc::new(move |_: &str, argv: &[String], _: &[String]| {
        let fd: i32 = argv[argv.len() - 1].parse().unwrap();
        let mut st = read_state(File::from(nix::unistd::dup(borrow(fd)).unwrap())).unwrap();
        // 새 이미지가 물려받는 fd 를 흉내 낸다: 도구·리스너 fd 를 복제해 넘긴다.
        for t in st.tools.as_mut().unwrap() {
            t.fd = dup_raw(t.fd);
        }
        st.paned_fd = dup_raw(st.paned_fd);
        st.report_fd = dup_raw(st.report_fd);
        *g2.lock().unwrap() = Some(st);
        std::io::Error::other("시험: exec 하지 않는다")
    }));
    // 옛 데몬의 데몬 전체 기록 하나.
    r.ps.import_global(&BTreeMap::from([(
        "k".to_owned(),
        RawMessage(b"\"v\"".to_vec()),
    )]));
    let commit = reload(&rl, req()).await.unwrap();
    tokio::task::spawn_blocking(commit).await.unwrap();
    // exec 가 성공했다면 옛 이미지는 사라진다. 시험의 exec 는 실패해 되돌렸으므로 옛 관리자를
    // 다시 멈춰 같은 PTY 를 나눠 읽지 않게 한다.
    assert!(r.pm.freeze_all().await);
    let st = got.lock().unwrap().take().unwrap();
    assert_eq!(st.global.get("k").unwrap().0, b"\"v\"");
    let screen = st.tools.as_ref().unwrap()[0].screen.clone();
    assert!(String::from_utf8_lossy(&screen).contains("before"));

    let h2 = tempfile::Builder::new().prefix("dsk").tempdir().unwrap();
    let pm2 = Arc::new(ToolManager::new(h2.path().to_str().unwrap(), None));
    let ps2 = PanedServer::new(Arc::clone(&pm2), &h2.path().join("s"), None);
    let (paned, report) = inherit_listeners(&st).unwrap();
    ps2.listen_inherited(paned, report, &h2.path().join("r"));
    assert!(restore(&pm2, &ps2, &st).is_empty());
    assert_eq!(ps2.export_global(), st.global);
    let t2 = pm2.get(&r.tool.id).expect("되살린 도구가 없다");
    assert_eq!(t2.cmd_process_pid(), pid);
    t2.write(b"again\n").unwrap();
    wait_output(&t2, "again");
    // 두 관리자가 같은 셸의 마스터를 쥐고 있어 한쪽을 지워도 hangup 이 가지 않고, 대화형 셸은
    // SIGTERM 을 무시한다. 시험이 띄운 셸을 직접 끈다.
    kill(pid);
    pm2.stop_saving();
    ps2.close();
    r.pm.thaw_all();
}

fn dup_raw(fd: u64) -> u64 {
    let d = nix::unistd::dup(borrow(i32::try_from(fd).unwrap())).unwrap();
    let raw = d.as_raw_fd();
    // 소유권은 받는 쪽(inherit_listeners·adopt_handover)이 가져간다.
    std::mem::forget(d);
    u64::try_from(raw).unwrap()
}

/// 이 시험 프로세스의 자식으로 PTY 셸(cat)을 띄우고, 원래 핸들은 닫은 채 복제한 마스터 fd 만
/// 남긴다 — exec 뒤에 누구 것인지 모르는 fd 만 쥔 상태와 같다.
fn orphan_shell() -> (OwnedFd, i32) {
    let term: Box<dyn Terminal> = otter_shared_platform::current()
        .pty
        .start(
            ProcSpec {
                path: "/bin/cat".into(),
                args: vec!["cat".into()],
                env: std::env::vars().map(|(k, v)| format!("{k}={v}")).collect(),
                ..ProcSpec::default()
            },
            80,
            24,
        )
        .unwrap();
    let master = term.handover().unwrap().master_fd();
    let dup = nix::unistd::dup(borrow(i32::try_from(master).unwrap())).unwrap();
    let pid = term.pid();
    let _ = term.close();
    (dup, pid)
}

fn kill(pid: i32) {
    let _ = otter_shared_platform::current().process.kill(pid);
}

// TC-DSK-14 (FR-DSK-27): 인계 상태 없이 열린 PTY fd 와 자식 셸을 짝짓는다.
#[test]
fn find_orphans_matches_child_shells() {
    let (fa, pa) = orphan_shell();
    let (fb, pb) = orphan_shell();
    let orphans = find_orphans(&HashSet::new()).unwrap();
    let fd_of = |pid: i32| orphans.iter().find(|o| o.pid == pid).map(|o| o.fd);
    assert_eq!(fd_of(pa), Some(fa.as_raw_fd() as usize), "{orphans:?}");
    assert_eq!(fd_of(pb), Some(fb.as_raw_fd() as usize), "{orphans:?}");
    // 이미 쥔 fd 는 다시 찾지 않는다.
    let claimed = HashSet::from([fa.as_raw_fd() as usize, fb.as_raw_fd() as usize]);
    let again = find_orphans(&claimed).unwrap();
    assert!(
        again.iter().all(|o| o.pid != pa && o.pid != pb),
        "이미 쥔 셸을 다시 찾았다: {again:?}"
    );
    kill(pa);
    kill(pb);
}

// TC-DSK-14·15 (FR-DSK-27·28): tools.json 에 pid 가 적힌 셸은 같은 id·이름으로 되찾고,
// 적히지 않은 셸은 새 id 의 백그라운드 도구로 입양한다. 둘 다 살아 있고 입력이 닿는다.
#[tokio::test(flavor = "multi_thread")]
async fn recover_recovers_and_adopts() {
    let home = TempDir::new().unwrap();
    let (fa, pa) = orphan_shell();
    let (fb, pb) = orphan_shell();
    let states = vec![ToolState {
        id: "tool-a".into(),
        name: "alpha".into(),
        cwd: home.path().to_str().unwrap().into(),
        pid: i64::from(pa),
    }];
    std::fs::write(
        home.path().join(otter_shared_otterenv::TOOLS_FILE),
        json::marshal(&states).unwrap(),
    )
    .unwrap();
    let pm = ToolManager::new(home.path().to_str().unwrap(), None);
    // FindOrphans 는 이 시험 프로세스 전체를 훑는다. 이 시험이 띄운 둘만 넘긴다.
    let orphans: Vec<Orphan> = find_orphans(&HashSet::new())
        .unwrap()
        .into_iter()
        .filter(|o| o.pid == pa || o.pid == pb)
        .collect();
    assert_eq!(orphans.len(), 2, "{orphans:?}");
    // 도구가 fd 를 넘겨받는다.
    std::mem::forget(fa);
    std::mem::forget(fb);
    let refs = HashSet::from(["tool-a".to_owned()]);
    assert_eq!(recover(&pm, home.path(), &refs, &orphans), (1, 1));
    let a = pm.get("tool-a").unwrap();
    assert_eq!((a.name.as_str(), a.cmd_process_pid()), ("alpha", pa));
    assert!(!pm.is_background("tool-a"));
    let b = pm
        .snapshot()
        .into_iter()
        .find(|p| p.cmd_process_pid() == pb)
        .expect("B 를 입양하지 않았다");
    assert!(!b.id.is_empty() && pm.is_background(&b.id));
    for p in [&a, &b] {
        p.write(b"ping\n").unwrap();
    }
    for p in [&a, &b] {
        wait_output(p, "ping");
    }
    pm.stop_saving();
    for p in pm.snapshot() {
        let _ = pm.delete(&p.id);
    }
}

// FR-DSK-26: 인계 상태를 잃은 새 데몬은 우리 소켓 경로에 묶인 물려받은 리스너를 닫는다.
#[test]
fn close_inherited_sockets_closes_only_ours() {
    let d = tempfile::Builder::new().prefix("dsk").tempdir().unwrap();
    let ipc = &otter_shared_platform::current().ipc;
    let ours = d.path().join("s");
    let other = d.path().join("other");
    let l1 = ipc.listen(&ours).unwrap();
    let _l2 = ipc.listen(&other).unwrap();
    assert!(close_inherited_sockets(&[ours.to_str().unwrap()]) >= 1);
    // 그 fd 는 이미 닫혔다. 리스너가 다시 닫지 않게 버린다.
    std::mem::forget(l1);
    // 같은 프로세스의 다른 시험이 fork 하면 exec 전까지 자식이 리스너 fd 를 잠시 쥔다.
    let deadline = Instant::now() + Duration::from_secs(2);
    while ipc.dial(&ours, Duration::from_secs(1)).is_ok() {
        assert!(Instant::now() < deadline, "우리 소켓이 아직 연결을 받는다");
        std::thread::sleep(Duration::from_millis(20));
    }
    ipc.dial(&other, Duration::from_secs(1))
        .expect("다른 소켓까지 닫았다");
}
