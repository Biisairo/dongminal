//! 데몬 낡음 판정 (DAEMON_STALENESS_SRS).

use dm_gocompat::filepath;
use dm_shared_platform::Process;

use crate::proc::daemon_pid;

/// 이 바이너리 안 데몬 코드의 지문이다 (FR-DFP-1). 빌드 때 `DONGMINAL_BUILD_DAEMON` 으로 새긴다.
/// 새기지 않으면 빈 값이다 — 모른다이며 불일치가 아니다 (FR-DFP-3).
pub const DAEMON_BUILD: &str = match option_env!("DONGMINAL_BUILD_DAEMON") {
    Some(v) => v,
    None => "",
};

/// 지금 도는 데몬이 이 바이너리의 코드인가의 답이다 (FR-DFP-8).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum DaemonState {
    /// 지문이 한쪽이라도 비어 판정할 수 없다. 일치로 접지 않는다.
    Unknown,
    NotRunning,
    Fresh,
    Stale,
}

pub(crate) fn classify_daemon(alive: bool, recorded: &str, current: &str) -> DaemonState {
    if !alive {
        return DaemonState::NotRunning;
    }
    if recorded.is_empty() || current.is_empty() {
        return DaemonState::Unknown;
    }
    if recorded == current {
        DaemonState::Fresh
    } else {
        DaemonState::Stale
    }
}

/// 파일 둘만 읽는다 — 소켓에 붙지 않는다 (NFR-DFP-2).
pub(crate) fn inspect_daemon_with(home: &str, current: &str, proc: &dyn Process) -> DaemonState {
    let (_, alive) = daemon_pid(home, proc);
    classify_daemon(alive, &recorded_daemon_build(home), current)
}

/// 도는 데몬이 남긴 지문이다. 없으면 빈 값이다.
pub(crate) fn recorded_daemon_build(home: &str) -> String {
    std::fs::read_to_string(filepath::join(&[
        home,
        dm_shared_toolipc::DAEMON_BUILD_FILE,
    ]))
    .map(|s| s.trim().to_owned())
    .unwrap_or_default()
}

/// 그 상태를 사람에게 말하는 유일한 자리다 (FR-DFP-11).
pub(crate) fn daemon_state_line(s: DaemonState) -> &'static str {
    match s {
        DaemonState::NotRunning => {
            "ℹ️  dongminald 미실행 — dongminal start 가 새 바이너리로 기동합니다"
        }
        DaemonState::Fresh => "✅ 데몬 코드 그대로 — dongminal start 는 세션을 유지합니다",
        DaemonState::Stale => {
            "⚠️  데몬 코드가 바뀌었습니다 — dongminal start 가 세션을 유지하며 교체합니다"
        }
        DaemonState::Unknown => {
            "ℹ️  데몬 판을 모릅니다 — dongminal start 가 세션을 유지하며 교체합니다"
        }
    }
}

/// 기동이 데몬에 대해 말하는 것이다 (FR-DFP-9). 낡음만 덧댄다.
pub(crate) fn running_daemon_notice(
    home: &str,
    running: bool,
    current: &str,
    proc: &dyn Process,
) -> String {
    if !running {
        return "dongminald 미실행 — dongminal 이 자동 기동합니다".to_owned();
    }
    let mut line = "dongminald 실행 중 (세션 보존)".to_owned();
    if inspect_daemon_with(home, current, proc) == DaemonState::Stale {
        line.push('\n');
        line.push_str(daemon_state_line(DaemonState::Stale));
    }
    line
}
