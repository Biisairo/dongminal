//! 세션을 유지하는 데몬 교체 (DAEMON_SESSION_KEEP_SRS FR-DSK-1~17).

use std::io::Write;
use std::path::Path;
use std::time::Duration;

use dm_shared_handover::{self as handover, Kind, Outcome};
use dm_shared_platform::Process;

use crate::options::StartOpts;
use crate::proc::{Procs, daemon_pid, socket_exists, stop_daemon};
use crate::staleness::{recorded_daemon_build, running_daemon_notice};
use crate::wait::poll_until;

/// 교체 요청과 확인의 시한 (FR-DSK-12·17).
const RELOAD_REQUEST_WITHIN: Duration = Duration::from_secs(15);
const SWAP_CONFIRM_WITHIN: Duration = Duration::from_secs(10);
const SWAP_CONFIRM_POLL: Duration = Duration::from_millis(100);
const SWAP_HELLO_WITHIN: Duration = Duration::from_millis(500);

/// `start` 가 데몬에 하는 일이다. 검사가 가짜로 갈아 끼워 순서를 잰다.
pub(crate) trait DaemonOps {
    fn running(&mut self) -> bool;
    fn reload(&mut self) -> Outcome;
    fn confirm(&mut self) -> Result<(), String>;
    fn stop(&mut self, stdout: &mut dyn Write) -> bool;
    fn notice(&mut self) -> String;
}

/// 서버를 끄기 전에 데몬을 정리한다. Err(code) 면 호출자는 아무것도 끄지 않고 그 코드로 끝낸다
/// (D-DSK-4).
pub(crate) fn prepare_daemon(
    o: &StartOpts,
    ops: &mut dyn DaemonOps,
    stdout: &mut dyn Write,
    stderr: &mut dyn Write,
) -> Result<(), i32> {
    if o.server_only {
        let _ = writeln!(stdout, "{}", ops.notice());
        return Ok(());
    }
    if o.refresh_daemon {
        let _ = writeln!(
            stdout,
            "dongminald 를 새로 띄웁니다 (터미널 세션을 잃습니다)..."
        );
        ops.stop(stdout);
        return Ok(());
    }
    if !ops.running() {
        let _ = writeln!(stdout, "dongminald 미실행 — dongminal 이 자동 기동합니다");
        return Ok(());
    }

    let _ = writeln!(stdout, "dongminald 를 세션을 유지하며 교체합니다...");
    let out = ops.reload();
    match out.kind {
        Kind::Unsupported => {
            let _ = writeln!(
                stdout,
                "⚠ 도는 dongminald 는 세션 유지 교체를 모르는 옛 판입니다 — 서버만 다시 띄웠습니다."
            );
            let _ = writeln!(
                stdout,
                "  한 번은 `dongminal start --refresh-daemon` 이 필요합니다 (세션을 잃습니다)."
            );
            return Ok(());
        }
        Kind::Refused => {
            let _ = writeln!(
                stderr,
                "❌ dongminald 교체 실패 ({}): {}",
                out.reason, out.detail
            );
            let _ = writeln!(stderr, "  서버·데몬·세션은 그대로입니다.");
            let _ = writeln!(
                stderr,
                "  세션을 버리고 새로 띄우려면: dongminal start --refresh-daemon"
            );
            return Err(1);
        }
        Kind::Swapped => {}
    }
    if let Err(e) = ops.confirm() {
        let _ = writeln!(stderr, "❌ 교체한 dongminald 를 확인하지 못했습니다: {e}");
        let _ = writeln!(
            stderr,
            "  서버는 끄지 않았습니다. `dongminal health --daemon` 으로 상태를 보세요."
        );
        return Err(1);
    }
    let _ = writeln!(stdout, "✅ dongminald 교체 완료 (세션 유지)");
    Ok(())
}

/// home 의 실제 데몬에 하는 일이다.
pub(crate) struct RealDaemonOps<'a> {
    pub home: &'a str,
    pub procs: &'a Procs<'a>,
    pub daemon_build: &'a str,
    pid_before: i32,
}

impl<'a> RealDaemonOps<'a> {
    pub(crate) fn new(home: &'a str, procs: &'a Procs<'a>, daemon_build: &'a str) -> Self {
        Self {
            home,
            procs,
            daemon_build,
            pid_before: 0,
        }
    }
}

impl DaemonOps for RealDaemonOps<'_> {
    fn running(&mut self) -> bool {
        socket_exists(self.home)
    }

    fn reload(&mut self) -> Outcome {
        self.pid_before = daemon_pid(self.home, self.procs.proc).0;
        match start_executable() {
            Ok(exe) => handover::reload(Path::new(self.home), &exe, RELOAD_REQUEST_WITHIN),
            Err(e) => Outcome {
                kind: Kind::Refused,
                reason: handover::REASON_EXE.to_owned(),
                detail: e,
            },
        }
    }

    fn confirm(&mut self) -> Result<(), String> {
        confirm_swap(
            self.home,
            self.pid_before,
            self.daemon_build,
            self.procs.proc,
        )
    }

    fn stop(&mut self, stdout: &mut dyn Write) -> bool {
        stop_daemon(self.home, stdout, self.procs)
    }

    fn notice(&mut self) -> String {
        running_daemon_notice(
            self.home,
            socket_exists(self.home),
            self.daemon_build,
            self.procs.proc,
        )
    }
}

/// 데몬이 exec 할 바이너리 — 이 `start` 를 실행한 파일이다 (FR-DSK-10).
fn start_executable() -> Result<String, String> {
    let exe = std::env::current_exe().map_err(|e| dm_gocompat::oserr::go_error_string(&e))?;
    dm_gocompat::filepath::eval_symlinks(&exe.to_string_lossy())
        .map_err(|e| dm_gocompat::oserr::go_error_string(&e))
}

/// 새 데몬이 같은 pid 로 떴는지 본다 (FR-DSK-17).
fn confirm_swap(
    home: &str,
    pid_before: i32,
    daemon_build: &str,
    proc: &dyn Process,
) -> Result<(), String> {
    let mut last = String::new();
    let ok = poll_until(SWAP_CONFIRM_WITHIN, SWAP_CONFIRM_POLL, || {
        let (pid, alive) = daemon_pid(home, proc);
        if !alive || pid != pid_before {
            last = format!("데몬 pid 가 {pid_before} 에서 {pid} 로 바뀌었거나 죽었습니다");
            false
        } else if !daemon_build.is_empty() && recorded_daemon_build(home) != daemon_build {
            last = "paned.build 가 새 지문이 아닙니다".to_owned();
            false
        } else if !handover::hello(Path::new(home), SWAP_HELLO_WITHIN) {
            last = "보고 소켓이 hello 에 답하지 않습니다".to_owned();
            false
        } else {
            true
        }
    });
    if ok {
        Ok(())
    } else {
        Err(format!("{last} (pid {pid_before})"))
    }
}
