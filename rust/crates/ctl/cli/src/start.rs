//! `dongminal start` (FR-ACT-1..4, FR-ISO-*, FR-FG-*). 창을 여는 일은 `window` 가 한다.

use std::fs::{File, OpenOptions};
use std::hash::{BuildHasher, Hasher};
use std::io::{self, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::Duration;

use dm_gocompat::filepath;
use dm_gocompat::oserr::{go_error_string, path_error};
use dm_shared_apipath as apipath;
use dm_shared_dmenv as dmenv;
use dm_shared_serverconf as serverconf;

use crate::actions::{Serve, ServeTarget};
use crate::env::Env;
use crate::handoff::hand_off_restart;
use crate::health_wait::wait_daemon_connected;
use crate::homelayout::{DAEMON_SOCK_FILE, TOOL_HOME_DIR};
use crate::http::ping;
use crate::options::{
    DEFAULT_HOST, ENV_HOME, ENV_HOST, ENV_LOG, ENV_PORT, ENV_RESTART_RUNNER, ENV_TOOL_ID,
    EXPOSE_HOST, StartOpts, default_log_file,
};
use crate::proc::{Procs, free_port, kill_port, socket_exists, tail};
use crate::service::{installed_service_files, service_bind_env_warning};
use crate::session_keep::{RealDaemonOps, prepare_daemon};
use crate::staleness::DAEMON_BUILD;
use crate::update_notice::announce_update_check;
use crate::wait::poll_until;

const READY_TRIES: u32 = 10;
const READY_INTERVAL: Duration = Duration::from_millis(500);
/// 데몬 연결을 기다리는 덤의 횟수다 (FR-VHL-20a).
const DAEMON_READY_TRIES: u32 = 10;
/// 되풀이하는 준비 대기에서 한 번의 상한이다.
const ALIVE_POLL_TIMEOUT: Duration = Duration::from_secs(1);

/// 격리 홈의 표지다. verify 의 가드가 같은 접두사로 격리를 확인한다 (FR-E2G-1).
pub(crate) const ISOLATED_HOME_PREFIX: &str = "dongminal-iso-";

pub fn run_start(
    o: &StartOpts,
    serve: &Serve<'_>,
    stdout: &mut dyn Write,
    stderr: &mut dyn Write,
) -> i32 {
    run_start_in(
        o,
        &Env::process(),
        &Procs::platform(),
        serve,
        stdout,
        stderr,
    )
}

pub(crate) fn run_start_in(
    o: &StartOpts,
    env: &Env<'_>,
    procs: &Procs<'_>,
    serve: &Serve<'_>,
    stdout: &mut dyn Write,
    stderr: &mut dyn Write,
) -> i32 {
    let (home, port) = match resolve_start_target(o, env) {
        Ok(t) => t,
        Err(e) => {
            let _ = writeln!(stderr, "{e}");
            return 1;
        }
    };
    let home_path = Path::new(&home);

    // FR-HRB-3·4: 기동 플래그는 server.json 에 쓴 뒤 그 값으로 뜬다.
    let flag_host = start_flag_host(o);
    if let Err(e) = serverconf::set_bind(home_path, flag_host, &port) {
        let _ = writeln!(
            stderr,
            "{} 에 바인드를 쓰지 못했습니다: {e}",
            serverconf::FILE_NAME
        );
        return 1;
    }
    let getenv = |k: &str| env.get(k);
    let log = default_log_file(&home);
    let conf = serverconf::resolve(&serverconf::Inputs {
        home: home_path,
        flag_host,
        flag_port: &port,
        getenv: Some(&getenv),
        default_log_file: &log,
        ..Default::default()
    });
    // FR-CFG-15: 막지 않는다.
    for w in &conf.warnings {
        let _ = writeln!(stderr, "⚠ {w}");
    }
    let w = conf.bind_env_warning();
    if !w.is_empty() {
        let _ = writeln!(stderr, "⚠ {w}");
    }
    if !o.isolated {
        let w = service_bind_env_warning(&installed_service_files(env));
        if !w.is_empty() {
            let _ = writeln!(stderr, "⚠ {w}");
        }
    }
    // FR-CFG-19: 포트는 listen 전에 본다.
    if let Some(e) = conf.err() {
        let _ = writeln!(stderr, "{e}");
        return 1;
    }
    let host = conf.host.value.as_str();
    let port = conf.port.value.as_str();

    // 04-secops P1-6: 홈은 0700 이다.
    if let Err(e) = mkdir_all(&home, 0o700) {
        let _ = writeln!(stderr, "DONGMINAL_HOME 생성 실패: {}", go_error_string(&e));
        return 1;
    }

    // 도구 안에서 데몬을 내리면 이 프로세스도 PTY 와 함께 죽는다 — 대리에게 넘긴다 (FR-ACT-3a).
    if let Some(code) = hand_off_restart(o, &home, env, stdout, stderr) {
        return code;
    }

    // 데몬을 먼저 정리한다 (FR-DSK-2). 교체에 실패하면 서버도 끄지 않는다 (D-DSK-4).
    let mut ops = RealDaemonOps::new(&home, procs, DAEMON_BUILD);
    if let Err(code) = prepare_daemon(o, &mut ops, stdout, stderr) {
        return code;
    }
    // 격리 실행은 기존 서버를 건드리지 않는다 (FR-ISO-2).
    if !o.isolated && !kill_port(port, stdout, "기존 dongminal", procs) {
        let _ = writeln!(stderr, "❌ 포트 {port} 를 비우지 못했습니다");
        return 1;
    }

    // FR-UPD-10: 전경·분리 두 갈래가 갈리기 전에 둔다.
    announce_update_check(&home, &getenv, stdout);

    if o.foreground {
        // D-A-9: 격리 기동은 전경에서도 어디에 떴는지 말하고, 도구 셸의 홈도 격리한다.
        let mut tool_home = String::new();
        if o.isolated {
            tool_home = ensure_isolated_tool_home(&home);
            announce_isolated(stdout, &home, port, true);
        }
        return serve(&ServeTarget {
            home: &home,
            host,
            port,
            tool_home: &tool_home,
        });
    }
    start_detached(o, &home, host, port, env, stdout, stderr)
}

/// 기동 옵션을 호스트의 플래그 계층으로 옮긴다 (FR-CFG-13). 격리도 값을 낸다 — 물려받은 노출
/// 호스트로 검사용 인스턴스가 열리지 않게 한다 (FR-M9-2 / D-M9-2). 빈 문자열은 정하지 않음이다.
pub(crate) fn start_flag_host(o: &StartOpts) -> &'static str {
    if o.expose {
        EXPOSE_HOST
    } else if o.isolated {
        DEFAULT_HOST
    } else {
        ""
    }
}

/// 격리 기동의 자리 — 임시 홈, 도구 셸의 홈, 그리고 내리는 법.
fn announce_isolated(stdout: &mut dyn Write, home: &str, port: &str, foreground: bool) {
    let _ = writeln!(stdout, "격리 홈: {home} (자동으로 지우지 않습니다)");
    let th = isolated_tool_home(home);
    if !th.is_empty() {
        let _ = writeln!(
            stdout,
            "도구 셸의 홈: {th} — 사용자 rc·git config·자격증명이 없는 빈 홈입니다"
        );
    }
    if foreground {
        let _ = writeln!(stdout, "정지: ^C");
        return;
    }
    let _ = writeln!(
        stdout,
        "정지: dongminal stop --all --port {port} --home {home}"
    );
}

/// 격리 홈 아래 도구 셸의 홈을 만들어 그 경로를 준다. 격리가 아니거나 만들지 못하면 빈 문자열이다.
fn ensure_isolated_tool_home(home: &str) -> String {
    let th = isolated_tool_home(home);
    if th.is_empty() || mkdir_all(&th, 0o755).is_err() {
        return String::new();
    }
    th
}

/// 격리 홈으로 뜨는 인스턴스면 그 홈 아래의 별도 칸이고, 아니면 빈 문자열이다.
pub(crate) fn isolated_tool_home(home: &str) -> String {
    if filepath::base(home).starts_with(ISOLATED_HOME_PREFIX) {
        return filepath::join(&[home, TOOL_HOME_DIR]);
    }
    String::new()
}

/// 홈과 포트의 플래그 계층을 정한다. --isolated 는 명시되지 않은 쪽만 격리 값으로 채운다
/// (FR-ISO-1/3). 포트는 빈 문자열일 수 있다 — 나머지 계층은 serverconf 가 지난다 (FR-CFG-13).
pub(crate) fn resolve_start_target(
    o: &StartOpts,
    env: &Env<'_>,
) -> Result<(String, String), String> {
    let home = if o.isolated && o.common.home.is_empty() {
        mkdir_temp(ISOLATED_HOME_PREFIX).map_err(|e| format!("격리 홈 생성 실패: {e}"))?
    } else {
        o.common.resolve_home_in(env)?
    };
    let port = if o.isolated && o.common.port.is_empty() {
        free_port().map_err(|e| format!("빈 포트 확보 실패: {e}"))?
    } else {
        o.common.port.clone()
    };
    Ok((home, port))
}

/// Go `os.MkdirTemp("", prefix)` — 임시 디렉터리 아래 prefix+난수 이름의 0700 디렉터리다.
fn mkdir_temp(prefix: &str) -> Result<String, String> {
    let dir = std::env::temp_dir().to_string_lossy().into_owned();
    for _ in 0..10000 {
        let n = std::collections::hash_map::RandomState::new()
            .build_hasher()
            .finish() as u32;
        let p = filepath::join(&[dir.as_str(), &format!("{prefix}{n}")]);
        let mut b = std::fs::DirBuilder::new();
        #[cfg(unix)]
        std::os::unix::fs::DirBuilderExt::mode(&mut b, 0o700);
        match b.create(&p) {
            Ok(()) => return Ok(p),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => {
                let pattern = filepath::join(&[dir.as_str(), &format!("{prefix}*")]);
                return Err(go_error_string(&path_error("mkdirtemp", &pattern, e)));
            }
        }
    }
    let pattern = filepath::join(&[dir.as_str(), &format!("{prefix}*")]);
    Err(go_error_string(&path_error(
        "mkdirtemp",
        &pattern,
        io::Error::from(io::ErrorKind::AlreadyExists),
    )))
}

fn mkdir_all(path: &str, mode: u32) -> io::Result<()> {
    let mut b = std::fs::DirBuilder::new();
    b.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut b, mode);
    #[cfg(not(unix))]
    let _ = mode;
    b.create(path).map_err(|e| path_error("mkdir", path, e))
}

/// 끊어 띄울 서버 명령과 그 출력이 갈 로그다. spawn 은 부르는 쪽이 한다.
pub(crate) struct ServerCmd {
    pub cmd: Command,
    pub log_path: String,
}

/// 자기 자신을 `start --foreground` 로 끊어 띄울 명령을 만든다 (FR-E2C-7). log_path 가 비면
/// $DONGMINAL_LOG, 그것도 비면 홈 아래 기본 자리다 (P1-6).
pub(crate) fn prepare_server_cmd(
    home: &str,
    log_path: &str,
    env: &Env<'_>,
) -> Result<ServerCmd, String> {
    let exe = std::env::current_exe()
        .map_err(|e| format!("실행 파일 경로 확인 실패: {}", go_error_string(&e)))?;
    let mut log_path = log_path.to_owned();
    if log_path.is_empty() {
        log_path = env.get(ENV_LOG);
        if log_path.is_empty() {
            log_path = default_log_file(home);
        }
    }
    // 로그의 상위 디렉터리는 없을 수 있다 (FR-XPA-2).
    mkdir_all(&filepath::dir(&log_path), 0o700)
        .map_err(|e| format!("로그 디렉터리 생성 실패: {}", go_error_string(&e)))?;
    // 0600: 로그에 접속 주소·작업 폴더·실행 명령이 남는다 (P1-6).
    let log = open_log(&log_path).map_err(|e| {
        format!(
            "로그 파일 열기 실패: {}",
            go_error_string(&path_error("open", &log_path, e))
        )
    })?;
    let stdio = |f: &File| {
        f.try_clone()
            .map(Stdio::from)
            .map_err(|e| format!("로그 파일 열기 실패: {}", go_error_string(&e)))
    };
    let mut cmd = Command::new(exe);
    cmd.args(["start", "--foreground"])
        // 바인드는 넘기지 않는다 — 자식은 server.json 을 읽는다 (FR-HRB-5).
        .env(ENV_HOME, home)
        .stdin(Stdio::null())
        .stdout(stdio(&log)?)
        .stderr(stdio(&log)?);
    let th = ensure_isolated_tool_home(home);
    if !th.is_empty() {
        cmd.env(dmenv::ENV_TOOL_HOME, th);
    }
    // 대리 표식·도구 식별자가 사슬을 타고 도구 셸까지 흘러가면 다음 재시작이 위임을 건너뛴다
    // (FR-ACT-3a/3b). 바인드 환경변수도 끊는다 (FR-HRB-8).
    for k in [
        ENV_RESTART_RUNNER,
        ENV_TOOL_ID,
        ENV_PORT,
        dmenv::ENV_PORT,
        ENV_HOST,
    ] {
        cmd.env_remove(k);
    }
    dm_shared_platform::current().process.detach(&mut cmd);
    Ok(ServerCmd { cmd, log_path })
}

pub(crate) fn open_log(path: &str) -> io::Result<File> {
    let mut o = OpenOptions::new();
    o.create(true).append(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut o, 0o600);
    o.open(path)
}

/// 자기 자신을 `start --foreground` 로 재실행해 detach 하고, 준비를 확인한 뒤 알린다
/// (FR-FG-2/3/4).
fn start_detached(
    o: &StartOpts,
    home: &str,
    host: &str,
    port: &str,
    env: &Env<'_>,
    stdout: &mut dyn Write,
    stderr: &mut dyn Write,
) -> i32 {
    let ServerCmd { mut cmd, log_path } = match prepare_server_cmd(home, "", env) {
        Ok(c) => c,
        Err(e) => {
            let _ = writeln!(stderr, "{e}");
            return 1;
        }
    };
    let _ = writeln!(stdout, "dongminal 기동 중 {host}:{port}...");
    let child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            let _ = writeln!(
                stderr,
                "기동 실패: fork/exec {}: {}",
                cmd.get_program().to_string_lossy(),
                go_error_string(&e)
            );
            return 1;
        }
    };
    let _ = writeln!(stdout, "dongminal PID: {}", child.id());

    let url = dmenv::base_url(host, port);
    if !wait_ready(&url) {
        let _ = writeln!(stderr, "❌ 기동 실패. 로그: {log_path}");
        let t = tail(&log_path, 20);
        if !t.is_empty() {
            let _ = writeln!(stderr, "{t}");
        }
        return 1;
    }

    // 표시도 같은 판정을 딛는다 (TLS-2).
    let exposure = if dmenv::is_exposed_host(host) {
        "LAN 노출"
    } else {
        "local-only"
    };
    let _ = writeln!(stdout, "✅ dongminal running on {url} ({exposure})");
    // FR-VHL-20: 데몬 연결까지 잠시 더 기다린다. 붙지 않아도 기동을 막지 않는다.
    let (st, connected) = wait_daemon_connected(&url, DAEMON_READY_TRIES, READY_INTERVAL);
    if connected {
        let _ = writeln!(
            stdout,
            "✅ dongminald connected at {home}/{DAEMON_SOCK_FILE}"
        );
    } else if socket_exists(home) {
        let _ = writeln!(
            stdout,
            "ℹ️  dongminald 소켓은 있으나 아직 연결되지 않았습니다"
        );
    }
    // FR-VHL-21: 빌드 판이 어긋나면 알린다. 자동으로 재시작하지 않는다.
    if st.mismatch {
        let _ = writeln!(
            stdout,
            "⚠️  데몬이 이전 판으로 돌고 있습니다 (데몬 {} / 서버 {}).",
            st.daemon_build, st.server_version
        );
        let _ = writeln!(
            stdout,
            "    반영하려면 데몬을 재시작해야 하며 **실행 중인 세션이 사라집니다**."
        );
    }
    if o.isolated {
        announce_isolated(stdout, home, port, false);
    }
    0
}

/// /api/ping 이 응답할 때까지 기다린다. READY_TRIES×READY_INTERVAL 이 상한이다 (M8 D-A-15).
fn wait_ready(url: &str) -> bool {
    let ping_url = format!("{url}{}", apipath::PING);
    poll_until(READY_INTERVAL * READY_TRIES, READY_INTERVAL, || {
        ping(&ping_url, ALIVE_POLL_TIMEOUT)
    })
}
