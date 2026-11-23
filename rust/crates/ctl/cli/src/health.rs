//! `dongminal health` (FR-ACT-9/10).

use std::io::Write;
use std::path::Path;

use dm_gocompat::filepath;
use dm_shared_dmenv as dmenv;
use dm_shared_platform::Process;
use dm_shared_runtime as runtime;

use crate::env::Env;
use crate::homelayout::DAEMON_SOCK_FILE;
use crate::http::{ALIVE_PROBE_TIMEOUT, ping};
use crate::options::HealthOpts;
use crate::proc::{daemon_pid, socket_exists};
use crate::service::{installed_service_files, service_bind_env_warning};
use crate::staleness::{DAEMON_BUILD, daemon_state_line, inspect_daemon_with};

pub fn run_health(o: &HealthOpts, stdout: &mut dyn Write, stderr: &mut dyn Write) -> i32 {
    let proc = dm_shared_platform::current().process;
    run_health_in(o, &Env::process(), proc, DAEMON_BUILD, stdout, stderr)
}

pub(crate) fn run_health_in(
    o: &HealthOpts,
    env: &Env<'_>,
    proc: &dyn Process,
    daemon_build: &str,
    stdout: &mut dyn Write,
    stderr: &mut dyn Write,
) -> i32 {
    let tgt = match o.common.resolve_target_in(env) {
        Ok(t) => t,
        Err(e) => {
            let _ = writeln!(stderr, "{e}");
            return 1;
        }
    };
    tgt.warn(stderr);
    // FR-HRB-6: 남은 서비스 파일의 바인드 환경변수는 이제 무시된다.
    let w = service_bind_env_warning(&installed_service_files(env));
    if !w.is_empty() {
        let _ = writeln!(stderr, "⚠ {w}");
    }
    let home = tgt.home.as_str();
    let state = || daemon_state_line(inspect_daemon_with(home, daemon_build, proc));
    // FR-DFP-7: 데몬의 낡음만 묻는 갈래. HTTP 도 헬퍼도 보지 않는다.
    if o.daemon_only {
        let _ = writeln!(stdout, "{}", state());
        return 0;
    }
    let port = &tgt.port;

    let mut fail = 0;
    // 호스트는 겨냥 해석이 준 것이다 (FR-STR-22·24).
    if ping(&format!("{}/", tgt.url), ALIVE_PROBE_TIMEOUT) {
        let _ = writeln!(stdout, "✅ dongminal HTTP :{port}");
    } else {
        let _ = writeln!(stdout, "❌ dongminal HTTP :{port} — 응답 없음");
        fail += 1;
    }

    let (pid, alive) = daemon_pid(home, proc);
    if !socket_exists(home) {
        // 소켓 부재는 실패가 아니다 — 아직 기동 전이다.
        let _ = writeln!(stdout, "ℹ️  dongminald 소켓 없음 (미기동)");
    } else if alive {
        let _ = writeln!(
            stdout,
            "✅ dongminald pid={pid} socket={home}/{DAEMON_SOCK_FILE}"
        );
    } else if pid > 0 {
        let _ = writeln!(
            stdout,
            "⚠️  dongminald 소켓은 있으나 pid={pid} 가 죽어 있습니다"
        );
        fail += 1;
    } else {
        let _ = writeln!(stdout, "ℹ️  dongminald 소켓은 있으나 pidfile 이 없습니다");
    }

    // FR-DFP-10: 낡은 데몬은 어긋남이지 고장이 아니다 — fail 에 세지 않는다.
    let _ = writeln!(stdout, "{}", state());

    // FR-HLI-9: 설치된 헬퍼가 죽어 있으면 다시 띄우기 전에 알린다.
    let bin_dir = filepath::join(&[home, dmenv::BIN_DIR]);
    let st = runtime::inspect_helpers(Path::new(&bin_dir));
    if !st.installed {
        let _ = writeln!(
            stdout,
            "ℹ️  헬퍼 {} ({bin_dir})",
            runtime::HELPER_NOT_INSTALLED
        );
    } else if !st.problems.is_empty() {
        for b in &st.problems {
            let _ = writeln!(stdout, "❌ 헬퍼 {} — {}", b.path.display(), b.reason);
        }
        let _ = writeln!(stdout, "   {}", runtime::HELPER_FIX_HINT);
        fail += st.problems.len();
    } else {
        let _ = writeln!(
            stdout,
            "✅ 헬퍼 {}개 실행 가능 ({bin_dir})",
            dmenv::helper_names().len()
        );
    }

    if fail > 0 { 1 } else { 0 }
}
