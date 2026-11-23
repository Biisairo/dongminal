//! Go 기준선 `dongminal/cmd/dongminal` 의 Rust 포팅. RUST_PORT_SRS 참고.
//!
//! 한 실행 파일이 세 역할을 한다 — argv[0] 이 헬퍼 이름이면 헬퍼, `d`·dongminald 면 데몬,
//! 나머지는 제어 CLI(그 `start --foreground` 가 서버)다.

mod daemon;
mod serve;

use std::ffi::OsString;
use std::io::Write;

use dm_gocompat::oserr::go_error_string;
use dm_shared_dmenv as dmenv;
use dm_shared_dmlog::{self as dmlog, errorf};

use crate::daemon::DAEMON_SUBCOMMAND;

/// 인스턴스 홈의 권한 (04-secops P1-6, Go `os.MkdirAll(home, 0o700)`).
const HOME_DIR_PERM: u32 = 0o700;

fn main() {
    let argv: Vec<OsString> = std::env::args_os().collect();
    if let Some(code) = dm_helper_runtimebin::dispatch(argv.clone()) {
        exit(code);
    }

    // OBSERVABILITY_SRS FR-OBS-1·2: 로그 계층을 가장 먼저 세운다. 파일 계층(`server.json`)은 홈이
    // 정해진 뒤에야 읽을 수 있으므로 serve 가 한 번 더 세운다.
    dmlog::init(dmlog::Options {
        level: std::env::var(dmenv::ENV_LOG_LEVEL).unwrap_or_default(),
        out: None,
    });

    let args: Vec<String> = argv
        .into_iter()
        .map(|a| {
            a.into_string()
                .unwrap_or_else(|a| a.to_string_lossy().into_owned())
        })
        .collect();

    if let Some(rest) = daemon_args(&args) {
        exit(run_daemon(rest));
    }

    let (mut out, mut err) = (std::io::stdout(), std::io::stderr());
    let code = dm_ctl_cli::dispatch(
        args.get(1..).unwrap_or_default(),
        &|t| serve::serve(t),
        &mut out,
        &mut err,
    );
    exit(code);
}

/// 데몬 진입점이면 handover 인자를 돌려준다. `dongminal d …` 이거나 argv[0] 의 이름이
/// dongminald 인 경우다 — 확장자는 떼고 본다(Windows 의 `dongminald.exe`). argv[0] 으로 들어온
/// 데몬은 인자를 handover 로 읽지 않는다 (FR-CLI-8).
fn daemon_args(args: &[String]) -> Option<&[String]> {
    if args.get(1).map(String::as_str) == Some(DAEMON_SUBCOMMAND) {
        return Some(&args[2..]);
    }
    let arg0 = args.first().map_or("", String::as_str);
    (dm_helper_runtimebin::helper_name(arg0) == "dongminald").then_some(&[])
}

fn run_daemon(rest: &[String]) -> i32 {
    let dargs = match dm_shared_handover::parse_daemon_args(rest) {
        Ok(d) => d,
        Err(e) => {
            errorf!(None, "{e}");
            return 2;
        }
    };
    // DAEMON_SESSION_KEEP_SRS FR-DSK-12: 사전 확인은 인계 판만 묻는다. 홈도 소켓도 건드리지 않는다.
    if dargs.version_query {
        println!("{}", dm_shared_handover::VERSION);
        return 0;
    }
    let home = match resolve_home() {
        Ok(h) => h,
        Err(e) => {
            errorf!(None, "{e}");
            return 1;
        }
    };
    dm_daemon_boot::run(
        &home,
        dm_ctl_cli::VERSION,
        dm_ctl_cli::DAEMON_BUILD,
        dargs.handover_fd,
    );
    0
}

/// 데몬 경로의 홈 해석이다. 액션 경로는 ctl/cli 가 플래그까지 반영해 해석한 값을 serve 에 넘긴다.
///
/// Go 는 끝에 `os.Setenv(DONGMINAL_HOME, home)` 했다. Rust 는 프로세스 환경을 바꾸지 않는다 —
/// 그 값을 읽는 도구 셸에는 boot 가 toolhub 환경 덮개로 넘긴다.
fn resolve_home() -> Result<String, String> {
    let mut home = std::env::var(dmenv::ENV_HOME).unwrap_or_default();
    if home.is_empty() {
        let user = user_home_dir().map_err(|e| format!("홈 디렉터리 확인 실패: {e}"))?;
        home = dm_gocompat::filepath::join(&[user.as_str(), dmenv::DEFAULT_HOME_DIR]);
    }
    // 04-secops P1-6: 홈은 0700 이다. 그 안의 소켓에 다른 UID 가 붙으면 데몬 프로토콜로 사용자의
    // PTY 전부에 입출력 접근이 가능하다 (데몬 IPC 에는 인증이 없다).
    mkdir_all_0700(&home)
        .map_err(|e| format!("DONGMINAL_HOME 생성 실패: {}", go_error_string(&e)))?;
    Ok(home)
}

/// Go `os.UserHomeDir` 다. 문구도 같다.
fn user_home_dir() -> Result<String, String> {
    let (key, missing) = if cfg!(windows) {
        ("USERPROFILE", "%userprofile% is not defined")
    } else {
        ("HOME", "$HOME is not defined")
    };
    match std::env::var(key) {
        Ok(v) if !v.is_empty() => Ok(v),
        _ => Err(missing.to_owned()),
    }
}

/// Go `os.MkdirAll(path, 0o700)`.
fn mkdir_all_0700(path: &str) -> std::io::Result<()> {
    dm_gocompat::oserr::mkdir_all(path, HOME_DIR_PERM)
}

/// 버퍼에 남은 출력을 내보내고 끝낸다 — `process::exit` 는 stdout 을 비우지 않는다.
fn exit(code: i32) -> ! {
    let _ = std::io::stdout().flush();
    std::process::exit(code)
}

#[cfg(test)]
mod tests {
    use super::*;

    // FR-RDF-9: 홈을 만들 수 없으면 Go os.MkdirAll 처럼 막힌 그 칸의 경로로 낸다.
    #[test]
    fn home_mkdir_error_matches_go() {
        let d = tempfile::tempdir().unwrap();
        let blocker = d.path().join("f");
        std::fs::write(&blocker, "x").unwrap();
        let home = blocker.join("home").to_string_lossy().into_owned();
        let e = mkdir_all_0700(&home).unwrap_err();
        assert_eq!(
            go_error_string(&e),
            format!("mkdir {}: not a directory", blocker.display())
        );
    }
}
