//! 주간 창의 사용 속도 예측 (FR-CAC-57, cswap `pace.py`).

use otter_gocompat::json::is_empty;
use serde::{Deserialize, Serialize};

pub(crate) const WEEK_SECONDS: i64 = 7 * 86400;
const PACE_MIN_ELAPSED: i64 = 86400;
const PACE_AHEAD_MARGIN: f64 = 15.0;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename = "claudeacct.Pace")]
pub struct Pace {
    #[serde(rename = "expectedPct")]
    pub expected_pct: f64,
    #[serde(rename = "aheadOfPace")]
    pub ahead_of_pace: bool,
    #[serde(rename = "projectedExhaustionAt", skip_serializing_if = "is_empty")]
    pub projected_exhaustion_at: Option<i64>,
    #[serde(rename = "willLastToReset")]
    pub will_last_to_reset: bool,
}

/// 주간 창 하나의 예측이다. 지난 시간이 하루 미만이면 `None` 이다.
pub fn compute_pace(pct: f64, resets_at: i64, fetched_at: i64) -> Option<Pace> {
    if resets_at == 0 {
        return None;
    }
    let remaining = ((resets_at - fetched_at) % WEEK_SECONDS + WEEK_SECONDS) % WEEK_SECONDS;
    let elapsed = if remaining != 0 {
        WEEK_SECONDS - remaining
    } else {
        0
    };
    if elapsed < PACE_MIN_ELAPSED {
        return None;
    }
    let expected = (elapsed as f64 / WEEK_SECONDS as f64 * 100.0).min(100.0);
    let mut p = Pace {
        expected_pct: (expected * 10.0).round() / 10.0,
        ahead_of_pace: pct - expected >= PACE_AHEAD_MARGIN,
        ..Pace::default()
    };
    if pct <= 0.0 {
        p.will_last_to_reset = true;
        return Some(p);
    }
    let rate = pct / elapsed as f64;
    let ex = if pct < 100.0 {
        fetched_at + ((100.0 - pct) / rate).round() as i64
    } else {
        fetched_at
    };
    p.projected_exhaustion_at = Some(ex);
    p.will_last_to_reset = pct + rate * (WEEK_SECONDS - elapsed) as f64 <= 100.0;
    Some(p)
}
