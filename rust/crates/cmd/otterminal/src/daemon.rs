//! 데몬(otterminald)에 붙거나 띄운다 (Go `cmd/otterminal/main.go` 의 dialOrStartDaemon·startDaemon).

use std::fmt;
use std::fs::OpenOptions;
use std::io;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::{Arc, mpsc};
use std::thread;
use std::time::{Duration, Instant};

use otter_gocompat::oserr::go_error_string;
use otter_gocompat::time::format_duration;
use otter_shared_otterenv as otterenv;
use otter_shared_otterlog::infof;
use otter_webserver_toolclient::{SpawnDaemon, ToolClient};

/// 첫 dial 이 옛 연결에 막혀 있다고 판정하는 시한이다 (M8 `GO-40`).
pub(crate) const DAEMON_BUSY_WAIT: Duration = Duration::from_secs(3);
/// 새로 띄운 데몬의 소켓이 서기를 기다리는 횟수다.
pub(crate) const DAEMON_READY_TRIES: u32 = 20;
/// 새로 띄운 데몬의 소켓이 서기를 기다리는 간격이다.
pub(crate) const DAEMON_READY_POLL: Duration = Duration::from_millis(100);

/// 데몬 진입점의 인자다 — start_daemon 이 띄우고 main 이 알아본다. 내부 진입점이므로 액션
/// 목록에 없다 (FR-CLI-8).
pub(crate) const DAEMON_SUBCOMMAND: &str = "d";

/// 데몬에 붙지 못했다 (Go `errDaemonUnavailable` 로 감싼 오류). Display 는 Go 문구 전체다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum DaemonUnavailable {
    /// 데몬을 띄우지 못했다. 안의 값은 원인 문구다.
    Spawn(String),
    /// 띄웠지만 준비 시한 안에 소켓이 서지 않았다.
    NotReady,
}

impl fmt::Display for DaemonUnavailable {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Spawn(e) => write!(f, "daemon unavailable: 데몬을 띄우지 못했습니다: {e}"),
            Self::NotReady => write!(
                f,
                "daemon unavailable: 데몬이 {} 안에 준비되지 않았습니다",
                format_duration(ready_window_nanos())
            ),
        }
    }
}

impl std::error::Error for DaemonUnavailable {}

fn ready_window() -> Duration {
    DAEMON_READY_POLL * DAEMON_READY_TRIES
}

fn ready_window_nanos() -> i64 {
    i64::try_from(ready_window().as_nanos()).unwrap_or(i64::MAX)
}

type Spawn = Arc<dyn Fn() -> io::Result<()> + Send + Sync>;

/// 떠 있는 데몬에 붙거나 하나를 띄워 붙는다. tool_home 은 새로 띄우는 데몬의
/// `OTTERMINAL_TOOL_HOME` 이다(비면 넣지 않는다). 재접속 감독도 같은 함수로 데몬을 다시 띄운다
/// (FR-13).
pub(crate) fn dial_or_start_daemon(
    home: &str,
    tool_home: &str,
) -> Result<ToolClient, DaemonUnavailable> {
    let (h, th) = (home.to_owned(), tool_home.to_owned());
    dial_or_start_daemon_with(home, Arc::new(move || start_daemon(&h, &th)))
}

fn spawner(spawn: &Spawn) -> SpawnDaemon {
    let s = Arc::clone(spawn);
    Box::new(move || s())
}

/// dial_or_start_daemon 의 본체다. spawn 이 데몬을 띄운다 — 시험이 실패를 넣는 자리다
/// (DIRECT_MODE_REMOVAL_SRS TC-DMR-1).
pub(crate) fn dial_or_start_daemon_with(
    home: &str,
    spawn: Spawn,
) -> Result<ToolClient, DaemonUnavailable> {
    // 종단 주소는 platform 이 만든다 — 데몬이 listen 하는 주소와 같은 함수다 (FR-XIP-1).
    let endpoint = otter_shared_platform::current()
        .ipc
        .endpoint(Path::new(home));
    let shown = endpoint.to_string_lossy().into_owned();

    // 옛 서버가 아직 내려가는 중이면 dial 이 데몬이 새 연결을 받을 때까지 막힌다.
    let (tx, rx) = mpsc::sync_channel(1);
    {
        let (ep, sp) = (endpoint.clone(), spawner(&spawn));
        thread::spawn(move || {
            let _ = tx.send(ToolClient::dial_with_reconnect(ep, Some(sp)));
        });
    }
    match rx.recv_timeout(DAEMON_BUSY_WAIT) {
        Ok(Ok(pc)) => {
            infof!(None, "connected to otterminald at {shown}");
            return Ok(pc);
        }
        Ok(Err(_)) | Err(mpsc::RecvTimeoutError::Disconnected) => {}
        Err(mpsc::RecvTimeoutError::Timeout) => {
            infof!(
                None,
                "otterminald busy, waiting for old connection to clear..."
            );
            if let Ok(Ok(pc)) = rx.recv() {
                infof!(None, "connected to otterminald (after waiting)");
                return Ok(pc);
            }
        }
    }

    infof!(None, "otterminald not reachable, starting...");
    if let Err(e) = spawn() {
        return Err(DaemonUnavailable::Spawn(go_error_string(&e)));
    }

    // M8 D-A-15 — 상한은 tries×poll 이다. 조건을 먼저 묻고 poll 마다 다시 묻는다(Go pollwait.Until).
    let deadline = Instant::now() + ready_window();
    loop {
        if let Ok(pc) = ToolClient::dial_with_reconnect(&endpoint, Some(spawner(&spawn))) {
            infof!(None, "connected to newly started otterminald");
            return Ok(pc);
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(DaemonUnavailable::NotReady);
        }
        thread::sleep(remaining.min(DAEMON_READY_POLL));
    }
}

/// 데몬 자식 프로세스의 환경이다. Go 는 `os.Environ()` 에 홈을 덧붙였고, 도구 홈은 격리 전경
/// 기동이 `os.Setenv` 로 프로세스 환경에 심어 두었다 — Rust 는 프로세스 환경을 바꾸지 않으므로
/// 여기서 직접 넣는다.
pub(crate) fn daemon_env(home: &str, tool_home: &str) -> Vec<(String, String)> {
    let mut env = vec![(otterenv::ENV_HOME.to_owned(), home.to_owned())];
    if !tool_home.is_empty() {
        env.push((otterenv::ENV_TOOL_HOME.to_owned(), tool_home.to_owned()));
    }
    env
}

/// otterminald 를 완전히 떨어진 자식으로 띄운다. 데몬은 이 프로세스보다 오래 산다.
pub(crate) fn start_daemon(home: &str, tool_home: &str) -> io::Result<()> {
    let exe = std::env::current_exe()?;
    let mut cmd = Command::new(exe);
    cmd.arg(DAEMON_SUBCOMMAND)
        .envs(daemon_env(home, tool_home))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    otter_shared_platform::current().process.detach(&mut cmd);
    // 터미널을 깨끗이 두려고 출력을 로그 파일로 돌린다. 열지 못하면 Go exec 처럼 null 장치다.
    let log_path = otter_gocompat::filepath::join(&[home, otterenv::DAEMON_LOG_FILE]);
    let mut opts = OpenOptions::new();
    opts.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o644);
    }
    if let Ok(f) = opts.open(&log_path) {
        let f2 = f.try_clone()?;
        cmd.stdout(f).stderr(f2);
    }
    let child = cmd.spawn()?;
    infof!(
        None,
        "otterminald started pid={} log={log_path}",
        child.id()
    );
    Ok(())
}

#[cfg(test)]
mod tests;
