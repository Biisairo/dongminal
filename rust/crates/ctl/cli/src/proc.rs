//! 포트·데몬 프로세스의 관측과 종료.

use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;
use std::time::Duration;

use dm_gocompat::filepath;
use dm_gocompat::oserr::go_error_string;
use dm_shared_platform::Process;

use crate::homelayout::{DAEMON_PID_FILE, DAEMON_SOCK_FILE};
use crate::http::ALIVE_PROBE_TIMEOUT;
use crate::wait::poll_until;

/// 신호 뒤 사라짐을 기다리는 상한과 간격이다 (M8 D-A-15).
const STOP_GRACE: Duration = Duration::from_secs(1);
const STOP_POLL: Duration = Duration::from_millis(50);

/// 프로세스 제어와 포트 관측의 이음매다. "TERM 에는 죽지 않고 KILL 에는 죽는다" 는 실기로
/// 만들 수 없어 검사가 둘을 함께 갈아 끼운다 (TEST-3).
pub(crate) struct Procs<'a> {
    pub proc: &'a dyn Process,
    /// 포트를 LISTEN 으로 점유한 pid 다. 접속만 한 클라이언트는 들지 않는다 (FR-XPI-1).
    pub pids_on_port: &'a dyn Fn(&str) -> Vec<i32>,
}

fn listener_pids(port: &str) -> Vec<i32> {
    dm_shared_platform::current().info.listener_pids(port)
}

impl Procs<'static> {
    pub(crate) fn platform() -> Self {
        Self {
            proc: dm_shared_platform::current().process,
            pids_on_port: &listener_pids,
        }
    }
}

/// pids 가 모두 사라지기를 STOP_GRACE 까지 기다린다. 대상 pid 의 생존만 본다 (FR-RGS-44).
fn pids_gone(proc: &dyn Process, pids: &[i32]) -> bool {
    poll_until(STOP_GRACE, STOP_POLL, || {
        pids.iter().all(|p| !proc.alive(*p))
    })
}

/// 포트를 점유한 프로세스를 TERM → (최대 1초) → KILL 로 종료한다. 포트가 비었는지를 돌려준다.
pub(crate) fn kill_port(port: &str, w: &mut dyn Write, label: &str, ps: &Procs<'_>) -> bool {
    let pids = (ps.pids_on_port)(port);
    if pids.is_empty() {
        return true;
    }
    let _ = writeln!(w, "{label} (포트 {port}) 정지 중...");
    for p in &pids {
        let _ = ps.proc.terminate(*p);
    }
    pids_gone(ps.proc, &pids);
    let left = (ps.pids_on_port)(port);
    if left.is_empty() {
        return true;
    }
    let _ = writeln!(w, "강제 종료...");
    for p in &left {
        let _ = ps.proc.kill(*p);
    }
    pids_gone(ps.proc, &left);
    (ps.pids_on_port)(port).is_empty()
}

/// pidfile 이 가리키는 pid 와 그것이 살아 있는지다. 읽지 못하거나 양수가 아니면 (0, false).
pub(crate) fn daemon_pid(home: &str, proc: &dyn Process) -> (i32, bool) {
    let Ok(blob) = std::fs::read_to_string(filepath::join(&[home, DAEMON_PID_FILE])) else {
        return (0, false);
    };
    match blob.trim().parse::<i32>() {
        Ok(pid) if pid > 0 => (pid, proc.alive(pid)),
        _ => (0, false),
    }
}

/// pidfile 이 가리키는 것이 정말 우리 데몬인지다 (FBE-07). 그 홈의 소켓이 답해야 우리 것이다 —
/// 번호가 재사용된 무관한 프로세스에 신호를 보내지 않는다.
pub(crate) fn daemon_ours(home: &str, proc: &dyn Process) -> (i32, bool) {
    let (pid, alive) = daemon_pid(home, proc);
    if !alive {
        return (pid, false);
    }
    let ipc = dm_shared_platform::current().ipc;
    let ok = ipc
        .dial(&ipc.endpoint(Path::new(home)), ALIVE_PROBE_TIMEOUT)
        .is_ok();
    (pid, ok)
}

/// dongminald 를 TERM → 1초 → KILL 로 종료하고 pidfile·소켓을 지운다. "정지 상태로 끝났는가" 를
/// 돌려준다. 아직 살아 있으면 잔여물을 남긴 채 false 다 — 다음 호출이 다시 찾을 수 있게.
pub(crate) fn stop_daemon(home: &str, w: &mut dyn Write, ps: &Procs<'_>) -> bool {
    let proc = ps.proc;
    let (pid, ours) = daemon_ours(home, proc);
    if ours {
        let _ = writeln!(w, "dongminald 정지 중 pid={pid}...");
        let gone = || poll_until(STOP_GRACE, STOP_POLL, || !proc.alive(pid));
        let _ = proc.terminate(pid);
        if !gone() {
            let _ = writeln!(w, "강제 종료...");
            let _ = proc.kill(pid);
            gone();
        }
        if proc.alive(pid) {
            let _ = writeln!(w, "dongminald pid={pid} 가 아직 살아 있습니다");
            return false;
        }
    } else if pid > 0 {
        // 우리 것이 아니거나 멎은 것이며 가릴 수 없다 — 신호를 보내지 않는다 (FBE-07).
        let _ = writeln!(w, "dongminald 미실행 (낡은 pidfile 제거)");
    } else {
        let _ = writeln!(w, "dongminald 미실행");
    }
    let _ = std::fs::remove_file(filepath::join(&[home, DAEMON_PID_FILE]));
    let _ = std::fs::remove_file(filepath::join(&[home, DAEMON_SOCK_FILE]));
    true
}

/// 종단 파일이 놓여 있는지다. 살아 있는지는 묻지 않는다 (FR-XIP-2/3).
pub(crate) fn socket_exists(home: &str) -> bool {
    let ipc = dm_shared_platform::current().ipc;
    ipc.exists(&ipc.endpoint(Path::new(home)))
}

/// 커널이 내주는 빈 TCP 포트다 (FR-ISO-1). listener 를 곧 닫으므로 경합의 여지는 남는다.
pub(crate) fn free_port() -> Result<String, String> {
    std::net::TcpListener::bind("127.0.0.1:0")
        .and_then(|l| l.local_addr())
        .map(|a| a.port().to_string())
        .map_err(|e| format!("listen tcp 127.0.0.1:0: {}", go_error_string(&e)))
}

/// tail 이 끝에서 읽는 양이다.
const TAIL_WINDOW: u64 = 64 << 10;

/// 로그 파일의 마지막 n 줄이다. 끝의 TAIL_WINDOW 만 읽고, 창 앞에서 잘린 첫 조각은 버린다.
pub(crate) fn tail(path: &str, n: usize) -> String {
    let Ok(mut f) = std::fs::File::open(path) else {
        return String::new();
    };
    let Ok(size) = f.metadata().map(|m| m.len()) else {
        return String::new();
    };
    let off = size.saturating_sub(TAIL_WINDOW);
    let mut blob = Vec::new();
    if f.seek(SeekFrom::Start(off)).is_err() || f.read_to_end(&mut blob).is_err() {
        return String::new();
    }
    if off > 0
        && let Some(i) = blob.iter().position(|b| *b == b'\n')
    {
        blob.drain(..=i);
    }
    let s = String::from_utf8_lossy(&blob);
    let lines: Vec<&str> = s.trim_end_matches('\n').split('\n').collect();
    lines[lines.len().saturating_sub(n)..].join("\n")
}
