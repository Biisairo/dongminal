//! 도구 안 재시작의 위임 (FR-ACT-3a/3b/3c).

use std::fs::OpenOptions;
use std::io::Write;
use std::process::{Command, Stdio};

use dm_gocompat::filepath;
use dm_gocompat::oserr::{go_error_string, path_error};

use crate::env::Env;
use crate::homelayout::RESTART_LOG_FILE;
use crate::options::{ENV_RESTART_RUNNER, ENV_TOOL_ID, StartOpts};

/// 재시작을 대리 프로세스에 넘겨야 하는지다. 도구 안에서 데몬을 내리는 실행만 자기 목숨줄을
/// 끊는다. 대리 자신은 다시 넘기지 않는다.
pub(crate) fn should_hand_off_restart(refresh_daemon: bool, runner: &str, tool_id: &str) -> bool {
    refresh_daemon && runner.is_empty() && !tool_id.is_empty()
}

/// 재시작을 새 세션의 대리 프로세스에 위임한다. 위임 대상이 아니면 None 이다. Some(code) 면
/// 호출자는 아무것도 더 하지 않고 그 코드로 끝낸다.
pub(crate) fn hand_off_restart(
    o: &StartOpts,
    home: &str,
    env: &Env<'_>,
    stdout: &mut dyn Write,
    stderr: &mut dyn Write,
) -> Option<i32> {
    if !should_hand_off_restart(
        o.refresh_daemon,
        &env.get(ENV_RESTART_RUNNER),
        &env.get(ENV_TOOL_ID),
    ) {
        return None;
    }
    let exe = match std::env::current_exe() {
        Ok(p) => p,
        Err(e) => {
            let _ = writeln!(stderr, "실행 파일 경로 확인 실패: {}", go_error_string(&e));
            return Some(1);
        }
    };
    let log_path = filepath::join(&[home, RESTART_LOG_FILE]);
    let mut opts = OpenOptions::new();
    opts.create(true).append(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut opts, 0o644);
    let log = match opts.open(&log_path) {
        Ok(f) => f,
        Err(e) => {
            let _ = writeln!(
                stderr,
                "재시작 로그 열기 실패: {}",
                go_error_string(&path_error("open", &log_path, e))
            );
            return Some(1);
        }
    };
    let (out, err) = match (log.try_clone(), log.try_clone()) {
        (Ok(a), Ok(b)) => (Stdio::from(a), Stdio::from(b)),
        (Err(e), _) | (_, Err(e)) => {
            let _ = writeln!(stderr, "재시작 대리 기동 실패: {}", go_error_string(&e));
            return Some(1);
        }
    };
    // 인자는 재구성하지 않고 그대로 물려준다 — 옮기다 빠뜨리면 대리가 다른 인스턴스를 재시작한다.
    let mut cmd = Command::new(&exe);
    cmd.args(std::env::args_os().skip(1))
        .env(ENV_RESTART_RUNNER, "1")
        .stdin(Stdio::null())
        .stdout(out)
        .stderr(err);
    dm_shared_platform::current().process.detach(&mut cmd);
    match cmd.spawn() {
        Ok(child) => {
            let _ = writeln!(
                stdout,
                "dongminald 재시작을 대리 프로세스에 넘겼습니다 pid={}",
                child.id()
            );
            let _ = writeln!(
                stdout,
                "이 터미널은 곧 끊깁니다 — 브라우저를 새로고침하세요. 로그: {log_path}"
            );
            Some(0)
        }
        Err(e) => {
            // 데몬은 아직 살아 있다. 대리 없이 데몬을 내리면 복구 수단까지 사라진다 (FR-ACT-3c).
            let _ = writeln!(
                stderr,
                "재시작 대리 기동 실패: fork/exec {}: {}",
                exe.display(),
                go_error_string(&e)
            );
            Some(1)
        }
    }
}
