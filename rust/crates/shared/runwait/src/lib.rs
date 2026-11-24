//! Go 기준선 `otterminal/internal/shared/runwait` 의 Rust 포팅.
//!
//! Run 종단이 요청을 붙잡는 **상한**이다 (M8_UNIFIED_SRS D-A-1). 서버와 `otterctl` 이
//! 같은 수를 읽는다.

use std::time::Duration;

/// `run succeed` 가 인수인계 요약을 기다리는 기본 상한이다 (FR-RUN-3: 180초).
pub const HANDOFF_WAIT_DEFAULT: Duration = Duration::from_secs(180);
/// `GET /api/runs/preamble` 이 늦은 요약을 기다리는 상한이다 (FR-RUN-4).
pub const PREAMBLE_WAIT: Duration = Duration::from_secs(90);
/// `POST /api/runs/close` 가 `/exit` 뒤 셸로 돌아오기를 기다리는 상한이다 (FR-RUN-6).
pub const EXIT_SETTLE: Duration = Duration::from_secs(20);
/// `GET /api/tools/activity/wait` 의 기본 상한이다 (FR-STA-2).
pub const ACTIVITY_WAIT_DEFAULT: Duration = Duration::from_secs(5 * 60);
/// `GET /api/tools/activity/wait` 의 최대 상한이다 (FR-STA-2).
pub const ACTIVITY_WAIT_MAX: Duration = Duration::from_secs(30 * 60);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn values_match_go() {
        assert_eq!(HANDOFF_WAIT_DEFAULT.as_secs(), 180);
        assert_eq!(PREAMBLE_WAIT.as_secs(), 90);
        assert_eq!(EXIT_SETTLE.as_secs(), 20);
        assert_eq!(ACTIVITY_WAIT_DEFAULT.as_millis(), 300_000);
        assert_eq!(ACTIVITY_WAIT_MAX.as_millis(), 1_800_000);
    }
}
