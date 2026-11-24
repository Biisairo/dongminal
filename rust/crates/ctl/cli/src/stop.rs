//! `dongminal stop` (FR-ACT-5..8).

use std::io::Write;

use crate::env::Env;
use crate::options::StopOpts;
use crate::proc::{Procs, daemon_pid, kill_port, stop_daemon};

pub fn run_stop(o: &StopOpts, stdout: &mut dyn Write, stderr: &mut dyn Write) -> i32 {
    run_stop_in(o, &Env::process(), &Procs::platform(), stdout, stderr)
}

pub(crate) fn run_stop_in(
    o: &StopOpts,
    env: &Env<'_>,
    ps: &Procs<'_>,
    stdout: &mut dyn Write,
    stderr: &mut dyn Write,
) -> i32 {
    // 죽이는 대상이 `start` 가 띄운 것과 같아야 한다 (FR-STR-23·25, FR-CFG-13).
    let tgt = match o.common.resolve_target_in(env) {
        Ok(t) => t,
        Err(e) => {
            let _ = writeln!(stderr, "{e}");
            return 1;
        }
    };
    tgt.warn(stderr);
    let (home, port) = (tgt.home.as_str(), tgt.port.as_str());

    let mut ok = true;
    if (ps.pids_on_port)(port).is_empty() {
        let _ = writeln!(stdout, "dongminal 미실행 (포트 {port})");
    } else if kill_port(port, stdout, "dongminal", ps) {
        let _ = writeln!(stdout, "✅ dongminal 정지");
    } else {
        let _ = writeln!(stderr, "❌ dongminal 정지 실패");
        ok = false;
    }

    if o.all {
        if stop_daemon(home, stdout, ps) {
            let _ = writeln!(stdout, "✅ dongminald 정지");
        } else {
            let _ = writeln!(stderr, "❌ dongminald 정지 실패");
            ok = false;
        }
    } else if let (pid, true) = daemon_pid(home, ps.proc) {
        let _ = writeln!(stdout, "dongminald 실행 유지 pid={pid} (세션 보존)");
    }

    if ok { 0 } else { 1 }
}
