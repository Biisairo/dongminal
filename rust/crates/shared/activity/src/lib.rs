//! Go 기준선 `dongminal/internal/shared/activity` 의 Rust 포팅.
//!
//! 에이전트 활동 상태의 어휘다 (FR-OPT-10-1). 값은 와이어 그대로다 — 훅 표면·SSE
//! `tool_activity`·`/api/tools/activity` 가 이 문자열을 싣는다.

pub const WORKING: &str = "working";
pub const WAITING: &str = "waiting";
pub const DONE: &str = "done";
pub const IDLE: &str = "idle";
/// 세션 종료 신호다 — 상태로 저장하지 않고 카드를 거둔다.
pub const ENDED: &str = "ended";

/// 어휘 전부다. 부를 때마다 새 목록이다.
pub fn states() -> Vec<&'static str> {
    vec![WORKING, WAITING, DONE, IDLE, ENDED]
}

/// `s` 가 어휘 안의 낱말인가다.
pub fn valid(s: &str) -> bool {
    matches!(s, WORKING | WAITING | DONE | IDLE | ENDED)
}

/// 이 상태의 보고가 알람을 파생하는가다 (FR-AEV-10). done·waiting 이다.
pub fn alarms(s: &str) -> bool {
    s == DONE || s == WAITING
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn states_and_valid() {
        let want = vec!["working", "waiting", "done", "idle", "ended"];
        assert_eq!(states(), want);
        for s in &want {
            assert!(valid(s), "valid({s:?})");
        }
        for s in ["", "Working", "busy", "ready"] {
            assert!(!valid(s), "valid({s:?})");
        }
    }

    #[test]
    fn states_copy() {
        let mut s = states();
        s[0] = "x";
        assert_eq!(states()[0], WORKING);
    }

    #[test]
    fn alarms_done_waiting() {
        assert!(alarms(DONE) && alarms(WAITING));
        assert!(!alarms(WORKING) && !alarms(IDLE) && !alarms(ENDED));
    }
}
