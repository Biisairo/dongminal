//! `otterminal doctor` — 플랫폼 계층을 **실제로 돌려 본다**. 서버가 쓰는 바로 그 코드 경로를 같은
//! 순서로 밟으므로, 통과하면 그 계층은 이 호스트에서 동작하고 실패하면 실패 지점과 OS 오류가
//! 그대로 나온다. "터미널이 안 뜬다" 는 셸 탐색·헬퍼 설치·의사 터미널·IPC 중 어디서든 날 수 있다.

use std::io::{self, Read, Write};
use std::path::Path;
use std::time::{Duration, Instant};

use otter_gocompat::filepath;
use otter_gocompat::fmt::v_list;
use otter_gocompat::oserr::go_error_string;
use otter_gocompat::strconv::{quote, quote_bytes};
use otter_shared_otterenv as otterenv;
use otter_shared_platform::{Platform, ShellSpec, ShutdownSignal};
use otter_shared_runtime as runtime;
use otter_shared_toolhub::{Placement, ToolManager};

use crate::bundle::run_doctor_bundle;
use crate::doctor_probe::{
    DOCTOR_PROBE_COLS, DOCTOR_PROBE_ROWS, DOCTOR_PROBE_TIMEOUT, DOCTOR_READY_WAIT, contains,
    doctor_detached, doctor_probe_plain_command, doctor_probe_terminal, doctor_trim, run_pty_probe,
};
use crate::env::Env;
use crate::options::{DoctorOpts, default_log_file};
use crate::report::CheckReport;
use crate::shellwait::{ChangeTracker, SHELL_QUIET_FOR, wait_quiet};
use crate::start::mkdir_temp;

/// IPC 종단 왕복의 접속·읽기 상한이다.
const DOCTOR_IPC_TIMEOUT: Duration = Duration::from_secs(3);
/// 출력·생존을 다시 보는 간격이다.
const DOCTOR_POLL: Duration = Duration::from_millis(100);

pub fn run_doctor(o: &DoctorOpts, stdout: &mut dyn Write, stderr: &mut dyn Write) -> i32 {
    run_doctor_in(o, &Env::process(), stdout, stderr)
}

pub(crate) fn run_doctor_in(
    o: &DoctorOpts,
    env: &Env<'_>,
    stdout: &mut dyn Write,
    stderr: &mut dyn Write,
) -> i32 {
    let home = match o.common.resolve_home_in(env) {
        Ok(h) => h,
        Err(e) => {
            let _ = writeln!(stderr, "{e}");
            return 1;
        }
    };
    let p = otter_shared_platform::current();

    // G2-3: 번들 모드는 진단을 대체하지 않고 따로 선다.
    if !o.bundle.is_empty() {
        return run_doctor_bundle(o, env, stdout, stderr);
    }
    // 내부 프로브 모드: 부모가 이 프로세스를 콘솔 없이 띄웠다 — 서버가 도구를 만드는 조건이다.
    if !o.probe_pty.is_empty() {
        return run_pty_probe(&o.probe_pty, p, &home);
    }

    let _ = writeln!(stdout, "otterminal doctor — platform={}", p.os);

    // FR-HLI-5: 운영 홈의 bin 에 설치하지 않는다. 임시 bin 을 못 만들면 오류로 끝낸다 — 운영 bin 으로
    // 대신하지 않는다 (FR-ATF-59, D-ATF-7).
    let probe = match doctor_probe_bin(&env.temp_dir()) {
        Ok(b) => b,
        Err(e) => {
            let _ = writeln!(stdout, "검사용 임시 bin 을 만들지 못했습니다: {e}");
            return 1;
        }
    };

    // Go 는 여기서 표준 로거를 가로채 실패 때만 `[서버 로그]` 로 보였다. 그러나 toolhub 는 otterlog 로
    // 찍고, otterlog 는 기동이 세운 자기 핸들러(stderr)로 쓰므로 가로채기에 걸리는 줄이 없다 — 관측
    // 동작대로 가로채지 않는다.
    let mut r = CheckReport::new(stdout);
    for c in doctor_checks(p, &home, &probe.bin) {
        (c.run)(&mut r);
    }
    drop(probe);

    let (fail, bads) = (r.fail, std::mem::take(&mut r.bads));
    drop(r);
    let _ = writeln!(stdout, "\n────────────────────────────────────────");
    if fail == 0 {
        let _ = writeln!(stdout, "전부 통과. 이 호스트에서 플랫폼 계층은 정상입니다.");
        return 0;
    }
    let _ = writeln!(stdout, "실패 {fail}건:");
    for b in &bads {
        let _ = writeln!(stdout, "  ❌ {b}");
    }
    1
}

/// 진단 항목 하나다. name 은 표의 이름이고 run 이 보고서에 적는다.
pub(crate) struct DoctorCheck<'a> {
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "표의 순서 계약을 검사가 읽는다")
    )]
    pub(crate) name: &'static str,
    pub(crate) run: Box<dyn Fn(&mut CheckReport<'_>) + 'a>,
}

/// 진단의 표다 (M8 D-A-11). **순서가 계약이다** — 설치가 헬퍼·셸·터미널의 전제이고, 터미널이 뜨는지를
/// 본 뒤에야 콘솔 없는 자식·IPC 를 묻는다. probe_bin 은 설치 계층을 시험할 임시 자리(FR-HLI-5)이고,
/// 운영 홈의 bin 은 검사만 한다(FR-HLI-8).
pub(crate) fn doctor_checks<'a>(
    p: &'a Platform,
    home: &'a str,
    probe_bin: &'a str,
) -> Vec<DoctorCheck<'a>> {
    fn c<'a>(name: &'static str, f: impl Fn(&mut CheckReport<'_>) + 'a) -> DoctorCheck<'a> {
        DoctorCheck {
            name,
            run: Box::new(f),
        }
    }
    vec![
        c("환경", move |r| doctor_environment(r, p, home)),
        c("설치", move |r| doctor_install(r, p, probe_bin)),
        c("설치된 헬퍼", move |r| {
            doctor_helpers(r, &filepath::join(&[home, otterenv::BIN_DIR]));
        }),
        c("셸", move |r| doctor_shell(r, p, probe_bin)),
        c("터미널", move |r| doctor_terminal(r, p, probe_bin, home)),
        c("도구", move |r| doctor_tool(r, home)),
        c("콘솔 없는 자식", move |r| doctor_detached(r, p, home)),
        c("IPC", move |r| doctor_ipc(r, p, home)),
        c("프로세스", move |r| doctor_process(r, p)),
    ]
}

fn mkdir_all(path: &str) -> io::Result<()> {
    crate::start::mkdir_all(path, 0o755)
}

fn doctor_environment(r: &mut CheckReport<'_>, p: &Platform, home: &str) {
    r.section("환경");
    r.info(format!("OTTERMINAL_HOME = {home}"));
    // 홈을 아는 자리이므로 홈 아래를 답한다 (FR-STR-33).
    r.info(format!("로그 기본 경로  = {}", default_log_file(home)));
    r.info(format!("실행 확장자     = {}", quote(p.paths.exe_suffix())));
    // doctor 는 홈이 없는 상태에서도 돌 수 있어야 하므로 여기서도 만든다 — 없는 것은 실패가 아니다.
    if let Err(e) = mkdir_all(home) {
        r.bad(format!("홈을 만들지 못했습니다: {}", go_error_string(&e)));
        return;
    }
    match std::fs::metadata(home) {
        Err(e) => r.bad(format!(
            "홈을 읽을 수 없습니다: {}",
            go_error_string(&otter_gocompat::oserr::path_error("stat", home, e))
        )),
        Ok(m) if !m.is_dir() => r.bad(format!("홈이 디렉터리가 아닙니다: {home}")),
        Ok(_) => r.ok("홈 존재"),
    }
}

/// 설치 계층을 시험할 임시 자리다. 버리면 지운다 — 진단은 자국을 남기지 않는다 (FR-HLI-5).
pub(crate) struct ProbeBin {
    root: String,
    pub(crate) bin: String,
}

impl Drop for ProbeBin {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

pub(crate) fn doctor_probe_bin(tmp: &str) -> Result<ProbeBin, String> {
    let root = mkdir_temp(tmp, "otterminal-doctor-")?;
    let bin = filepath::join(&[root.as_str(), otterenv::BIN_DIR]);
    Ok(ProbeBin { root, bin })
}

/// **운영 홈**에 설치된 헬퍼가 실제로 실행 가능한지 본다 (FR-HLI-8). 고치지 않는다 — 고치는 것은
/// 기동의 몫이고, 진단이 대상을 바꾸면 원래 상태를 알 수 없게 된다 (D-4).
pub(crate) fn doctor_helpers(r: &mut CheckReport<'_>, bin_dir: &str) {
    r.section(format!("설치된 헬퍼 ({bin_dir})"));
    let st = runtime::inspect_helpers(Path::new(bin_dir));
    // FR-HLI-11: 설치된 적 없는 홈은 고장이 아니다.
    if !st.installed {
        r.info(runtime::HELPER_NOT_INSTALLED);
        return;
    }
    if st.problems.is_empty() {
        r.ok("헬퍼 전부 실행 가능");
        return;
    }
    for b in &st.problems {
        r.bad(format!("{} — {}", b.path.display(), b.reason));
    }
    r.info(runtime::HELPER_FIX_HINT);
}

/// 헬퍼와 셸 훅을 실제로 설치해 본다. 훅이 없으면 셸이 없는 스크립트를 받아 즉시 죽고, 그것이
/// "터미널이 비어 보이는" 증상이 된다.
fn doctor_install(r: &mut CheckReport<'_>, p: &Platform, bin_dir: &str) {
    r.section("헬퍼·셸 훅 설치");
    if let Err(e) = mkdir_all(bin_dir) {
        r.bad(format!(
            "bin 디렉터리를 만들지 못했습니다: {}",
            go_error_string(&e)
        ));
        return;
    }
    if let Err(e) = runtime::install(Path::new(bin_dir)) {
        r.bad(format!("설치 실패: {}", go_error_string(&e)));
        return;
    }
    r.ok(format!("설치 완료: {bin_dir}"));

    let spec = p.shell.shell(Path::new(bin_dir));
    for arg in &spec.args {
        let Some(path) = doctor_hook_path(arg) else {
            continue;
        };
        match std::fs::metadata(&path) {
            Err(e) => r.bad(format!(
                "셸이 참조할 훅이 없습니다: {path} ({})",
                go_error_string(&otter_gocompat::oserr::path_error("stat", &path, e))
            )),
            Ok(_) => r.ok(format!("훅 존재: {path}")),
        }
    }
    // 환경변수로 거는 셸은 zsh 뿐이다. bash 는 인자(`--rcfile`)로 걸린다 (FR-HPR-7).
    for kv in &spec.env {
        let Some((k, v)) = kv.split_once('=') else {
            continue;
        };
        if k != "ZDOTDIR" {
            continue;
        }
        match std::fs::metadata(v) {
            Err(e) => r.bad(format!(
                "{k} 가 가리키는 곳이 없습니다: {v} ({})",
                go_error_string(&otter_gocompat::oserr::path_error("stat", v, e))
            )),
            Ok(_) => r.ok(format!("{k} = {v}")),
        }
    }
}

/// 셸 인자에서 훅 스크립트 경로를 뽑는다. Windows 인자는 `. '<경로>'` 형태의 닷소싱 명령이다.
pub(crate) fn doctor_hook_path(arg: &str) -> Option<String> {
    let mut s = arg.trim().to_owned();
    if let Some(rest) = s.strip_prefix(". '") {
        s = rest.strip_suffix('\'').unwrap_or(rest).replace("''", "'");
    }
    let low = s.to_lowercase();
    if !low.ends_with(".ps1") && !low.ends_with(".sh") {
        return None;
    }
    Some(s)
}

fn doctor_shell(r: &mut CheckReport<'_>, p: &Platform, bin_dir: &str) {
    r.section("셸 선택");
    let spec = p.shell.shell(Path::new(bin_dir));
    if spec.path.is_empty() {
        r.bad("셸을 고르지 못했습니다");
        return;
    }
    r.info(format!("실행 파일 = {}", spec.path));
    r.info(format!("인자      = {}", v_list(&spec.args)));
    r.info(format!("훅 트리   = shellhooks/{}", p.shell.hook_root()));
    if let Err(e) = std::fs::metadata(&spec.path) {
        r.bad(format!(
            "셸이 그 경로에 없습니다: {}",
            go_error_string(&otter_gocompat::oserr::path_error("stat", &spec.path, e))
        ));
        return;
    }
    r.ok("셸 확인");
}

/// 이 검사의 핵심이다. 의사 터미널을 실제로 띄우고 명령 하나를 왕복시킨다. 훅 없는 **맨 셸**과 훅을
/// 얹은 셸로 두 번 한다 — 맨 셸만 되면 범인은 훅이고, 둘 다 안 되면 의사 터미널이다.
fn doctor_terminal(r: &mut CheckReport<'_>, p: &Platform, bin_dir: &str, home: &str) {
    r.section("의사 터미널 (PTY/ConPTY)");
    // 셸을 빼고 배관부터 본다 — 이게 안 되면 셸·입력 타이밍을 아무리 만져도 소용없다.
    doctor_probe_plain_command(r, p, home);

    let spec = p.shell.shell(Path::new(bin_dir));
    let bare_spec = ShellSpec {
        path: spec.path.clone(),
        args: Vec::new(),
        env: Vec::new(),
    };
    let bare = doctor_probe_terminal(r, p, "맨 셸", &bare_spec, home);
    if spec.args.is_empty() && spec.env.is_empty() {
        return; // 훅이 없는 구성이면 같은 것을 두 번 할 이유가 없다
    }
    let hooked = doctor_probe_terminal(r, p, "훅 얹은 셸", &spec, home);
    if bare && !hooked {
        r.bad("맨 셸은 되는데 훅을 얹으면 안 됩니다 — 원인은 셸 훅입니다");
        for a in &spec.args {
            r.info(format!("훅 인자: {a}"));
        }
    }
}

fn doctor_ipc(r: &mut CheckReport<'_>, p: &Platform, home: &str) {
    r.section("로컬 IPC 종단");
    let ep = p
        .ipc
        .endpoint(Path::new(&filepath::join(&[home, "doctor"])));
    let ep_s = ep.to_string_lossy().into_owned();
    let dir = filepath::dir(&ep_s);
    if let Err(e) = mkdir_all(&dir) {
        r.bad(format!(
            "검사용 디렉터리를 만들지 못했습니다: {}",
            go_error_string(&e)
        ));
        return;
    }
    struct RemoveDir(String);
    impl Drop for RemoveDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    let _cleanup = RemoveDir(dir);

    let _ = p.ipc.remove(&ep);
    let ln = match p.ipc.listen(&ep) {
        Ok(l) => l,
        Err(e) => {
            r.bad(format!("종단 개설 실패: {}", go_error_string(&e)));
            r.info(format!("경로: {ep_s}"));
            return;
        }
    };
    r.ok(format!("종단 개설 {ep_s}"));

    if p.ipc.exists(&ep) {
        r.ok("존재 판정");
    } else {
        r.bad("개설한 종단을 존재 판정이 보지 못합니다 — 데몬을 못 찾게 됩니다");
    }

    let (tx, rx) = std::sync::mpsc::channel::<io::Result<()>>();
    let echo = std::thread::spawn(move || {
        let res = (|| {
            let mut c = ln.accept()?;
            let mut buf = [0u8; 8];
            let n = c.read(&mut buf)?;
            c.write_all(&buf[..n])
        })();
        let _ = tx.send(res);
        drop(ln);
    });

    let mut conn = match p.ipc.dial(&ep, DOCTOR_IPC_TIMEOUT) {
        Ok(c) => c,
        Err(e) => {
            r.bad(format!("종단 접속 실패: {}", go_error_string(&e)));
            return;
        }
    };
    if let Err(e) = conn.write_all(b"ping") {
        r.bad(format!("종단 쓰기 실패: {}", go_error_string(&e)));
        return;
    }
    let _ = conn.set_read_timeout(Some(DOCTOR_IPC_TIMEOUT));
    let mut buf = [0u8; 4];
    if let Err(e) = read_some(&mut conn, &mut buf) {
        r.bad(format!("종단 읽기 실패: {}", go_error_string(&e)));
        return;
    }
    if &buf != b"ping" {
        r.bad(format!("왕복 내용이 다릅니다: {}", quote_bytes(&buf)));
        return;
    }
    match rx.recv() {
        Ok(Err(e)) => {
            r.bad(format!("종단 응답 실패: {}", go_error_string(&e)));
            return;
        }
        Err(_) => {
            r.bad("종단 응답 실패: EOF");
            return;
        }
        Ok(Ok(())) => {}
    }
    let _ = echo.join();
    r.ok("접속·왕복");
}

/// Go `conn.Read` — 한 번 읽는다. 0 바이트는 `EOF` 다.
fn read_some(c: &mut impl Read, buf: &mut [u8]) -> io::Result<usize> {
    match c.read(buf)? {
        0 => Err(io::Error::new(io::ErrorKind::UnexpectedEof, "EOF")),
        n => Ok(n),
    }
}

/// Go `os.Signal` 의 `String()` 이다.
fn signal_name(s: ShutdownSignal) -> &'static str {
    match s {
        ShutdownSignal::Interrupt => "interrupt",
        ShutdownSignal::Terminate => "terminated",
        ShutdownSignal::Hangup => "hangup",
    }
}

/// 생존 판정·부모 조회·이름 조회를 확인한다. git 원격 작업의 취소가 이 경로를 딛는다.
fn doctor_process(r: &mut CheckReport<'_>, p: &Platform) {
    r.section("프로세스 제어");
    let me = i32::try_from(std::process::id()).unwrap_or(i32::MAX);
    if p.process.alive(me) {
        r.ok("생존 판정");
    } else {
        r.bad("자기 자신이 살아 있지 않다고 합니다 — 생존 판정이 깨졌습니다");
    }
    let sigs: Vec<&str> = p
        .process
        .shutdown_signals()
        .iter()
        .map(|s| signal_name(*s))
        .collect();
    r.info(format!("종료 신호 = {}", v_list(&sigs)));

    match p.info.parent_pid(me) {
        Some(pid) => r.ok(format!("부모 조회 ppid={pid}")),
        None => r.bad("부모를 조회하지 못했습니다 — otterctl who-am-i 가 도구를 못 찾습니다"),
    }
    match p.info.names(&[me]).get(&me).filter(|n| !n.is_empty()) {
        Some(n) => r.ok(format!("프로세스 이름 조회 = {n}")),
        None => r.bad("프로세스 이름을 조회하지 못했습니다 — 탭 이름이 비게 됩니다"),
    }
}

/// **서버가 도구를 만들 때와 같은 경로**(ToolManager.create)를 밟는다. 생 PTY 위의 환경 조립·훅
/// 주입·출력 스트림에서 깨지면 터미널 검사로는 잡지 못한다.
///
/// Go 는 `os.Setenv(OTTERMINAL_HOME, home)` 로 홈을 넘겼다. Rust 는 프로세스 환경을 바꾸지 않고
/// 도구 등록부의 환경 덮개로 넘긴다.
fn doctor_tool(r: &mut CheckReport<'_>, home: &str) {
    r.section("도구 (toolhub)");

    let data_dir = filepath::join(&[home, "doctor-tools"]);
    if let Err(e) = mkdir_all(&data_dir) {
        r.bad(format!(
            "검사용 디렉터리를 만들지 못했습니다: {}",
            go_error_string(&e)
        ));
        return;
    }
    struct Cleanup(ToolManager, Option<String>, String);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            if let Some(id) = &self.1 {
                let _ = self.0.delete(id);
            }
            // 지운 뒤에 저장 스레드가 그 자리에 쓰지 않게, 진행 중인 저장을 기다린다.
            self.0.stop_saving();
            let _ = std::fs::remove_dir_all(&self.2);
        }
    }
    let m = ToolManager::new(&data_dir, None);
    // StartTool 은 OTTERMINAL_HOME 아래 bin 을 셸 환경에 심는다.
    m.set_env_overlay(vec![(otterenv::ENV_HOME.to_owned(), home.to_owned())]);
    let mut guard = Cleanup(m.clone(), None, data_dir);
    let tool = match m.create(
        home,
        DOCTOR_PROBE_COLS,
        DOCTOR_PROBE_ROWS,
        Placement::default(),
    ) {
        Ok(t) => t,
        Err(e) => {
            r.bad(format!("도구 기동 실패: {e}"));
            return;
        }
    };
    guard.1 = Some(tool.id.clone());
    r.ok(format!("도구 기동 pid={}", tool.cmd_process_pid()));

    let snap = || tool.stream().map(|s| s.snapshot().0).unwrap_or_default();
    const MARKER: &str = "otterminal-tool-ok";
    // 셸이 프롬프트를 그릴 때까지 기다린다. 상한을 넘겨도 입력은 넣어 본다 — 판정은 아래 왕복이 한다.
    let mut screen = ChangeTracker::default();
    let _ = wait_quiet(
        || Ok::<_, String>(screen.observe(&snap())),
        DOCTOR_READY_WAIT,
        SHELL_QUIET_FOR,
    );
    if let Err(e) = tool.write(format!("echo {MARKER}\r").as_bytes()) {
        r.bad(format!("입력 실패: {}", go_error_string(&e)));
        return;
    }

    let deadline = Instant::now() + DOCTOR_PROBE_TIMEOUT;
    while Instant::now() < deadline {
        let blob = snap();
        if contains(&blob, MARKER) {
            r.ok(format!("입출력 왕복 (출력 {}바이트)", blob.len()));
            return;
        }
        if m.get(&tool.id).is_none() {
            r.bad("도구가 곧바로 사라졌습니다 — 셸이 뜨자마자 죽습니다");
            r.info(format!(
                "그때까지 받은 것: {}",
                quote_bytes(&doctor_trim(&blob))
            ));
            return;
        }
        std::thread::sleep(DOCTOR_POLL);
    }
    let blob = snap();
    if blob.is_empty() {
        r.bad("출력이 한 바이트도 오지 않았습니다 — 화면이 비는 증상 그대로입니다");
    } else {
        r.bad(format!("표시를 못 봤습니다 (출력 {}바이트)", blob.len()));
        r.info(format!("받은 것: {}", quote_bytes(&doctor_trim(&blob))));
    }
}
