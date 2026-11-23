//! 조회 주기와 물러나기 (FR-CAC-53·54, cswap `poll_policy.py`·`usage_store.py`).

use crate::usage::Usage;

pub(crate) const MIN_INTERVAL_S: i64 = 180;
pub(crate) const URGENT_INTERVAL_S: i64 = 60;
pub(crate) const ACTIVE_MAX_S: i64 = 300;
pub(crate) const CANDIDATE_DEFAULT_S: i64 = 300;
pub(crate) const CANDIDATE_MAX_S: i64 = 600;
pub(crate) const EXHAUSTED_S: i64 = 600;
const MOVEMENT_DELTA: f64 = 1.0;
pub(crate) const JITTER_FRAC: f64 = 0.10;
pub(crate) const ESCALATION_MARGIN: f64 = 15.0;
pub(crate) const RESET_SLACK_S: i64 = 60;
const RECENT_429_WINDOW_S: i64 = 3600;
const POST_429_MIN_S: i64 = 360;
const POST_429_MULT: f64 = 1.5;
const POST_429_MAX_S: i64 = 1800;

const BACKOFF_BASE_S: i64 = 30;
const BACKOFF_MAX_S: i64 = 600;
const BACKOFF_429_FLOOR: i64 = 300;
const BACKOFF_RA_LONG_S: i64 = 600;
const BACKOFF_RA_PAD_S: i64 = 900;
const BACKOFF_CAP_429_S: i64 = 4500;
/// D-CAC-36: cswap SERVE_TTL_S
pub(crate) const FETCH_NOW_MIN_GAP_S: i64 = 180;
pub(crate) const DEFAULT_LINE_PCT: f64 = 90.0;
pub(crate) const FRESH_FOR_DECISION_S: i64 = 300;

#[derive(Debug, Clone, Default)]
pub(crate) struct PlanInput<'a> {
    pub(crate) now: i64,
    pub(crate) prev_interval: i64,
    pub(crate) prev: Option<&'a Usage>,
    pub(crate) next: Option<&'a Usage>,
    pub(crate) active: bool,
    pub(crate) line: f64,
    pub(crate) last429: i64,
}

pub(crate) fn moved(prev: &Usage, next: &Usage) -> bool {
    let (a, b) = (prev.windows(&None), next.windows(&None));
    if a.len() != b.len() {
        return true;
    }
    a.iter()
        .zip(&b)
        .any(|(x, y)| (x.pct - y.pct).abs() >= MOVEMENT_DELTA)
}

/// 성공한 조회 뒤의 간격(초)이다. jitter 는 [-1, 1] 이다.
pub(crate) fn plan_interval(inp: &PlanInput<'_>, jitter: f64) -> i64 {
    let ceiling = if inp.active {
        ACTIVE_MAX_S
    } else {
        CANDIDATE_MAX_S
    };
    let mut iv = match (inp.prev, inp.next) {
        (Some(prev), Some(next)) if moved(prev, next) => {
            let mut iv = MIN_INTERVAL_S.max(inp.prev_interval / 2);
            if inp.active
                && next
                    .windows(&None)
                    .iter()
                    .any(|w| w.pct >= inp.line - ESCALATION_MARGIN)
            {
                iv = URGENT_INTERVAL_S;
            }
            iv
        }
        (Some(_), Some(_)) => {
            ceiling.min(MIN_INTERVAL_S.max((inp.prev_interval as f64 * 1.5) as i64))
        }
        _ if inp.active => MIN_INTERVAL_S,
        _ => CANDIDATE_DEFAULT_S,
    };
    if inp.last429 > 0 && inp.now - inp.last429 < RECENT_429_WINDOW_S {
        iv = POST_429_MAX_S
            .min(iv.max(((inp.prev_interval as f64 * POST_429_MULT) as i64).max(POST_429_MIN_S)));
    }
    if inp.next.is_some_and(|n| n.headroom(&None) <= 0.0) {
        iv = iv.max(EXHAUSTED_S);
    }
    (iv as f64 * (1.0 + JITTER_FRAC * jitter)).round() as i64
}

/// 다음 조회 시각이다. 가장 가까운 창 초기화 + 60초를 넘지 않는다.
pub(crate) fn plan_next(inp: &PlanInput<'_>, jitter: f64) -> i64 {
    let mut next = inp.now + plan_interval(inp, jitter);
    if let Some(n) = inp.next {
        for w in n.windows(&None) {
            if w.resets_at > inp.now && w.resets_at + RESET_SLACK_S < next {
                next = w.resets_at + RESET_SLACK_S;
            }
        }
    }
    next
}

/// 연속 실패 fails 번째 뒤 기다릴 시간이다 (FR-CAC-54).
pub(crate) fn backoff_seconds(fails: i64, status: u16, retry_after: &str) -> i64 {
    let computed = if fails <= 5 {
        (BACKOFF_BASE_S << (fails - 1).max(0)).min(BACKOFF_MAX_S)
    } else {
        BACKOFF_MAX_S
    };
    if status != 429 {
        return computed;
    }
    let ra = match go_parse_int(retry_after.trim()) {
        Some(ra) if ra >= 0 => ra,
        _ => return computed,
    };
    if ra == 0 {
        return computed.clamp(BACKOFF_429_FLOOR, BACKOFF_MAX_S);
    }
    let asked = if ra > BACKOFF_RA_LONG_S {
        ra + BACKOFF_RA_PAD_S
    } else {
        ra
    };
    asked.min(BACKOFF_CAP_429_S).max(computed)
}

/// Go `strconv.ParseInt(s, 10, 64)` 의 성공 여부와 값.
fn go_parse_int(s: &str) -> Option<i64> {
    let digits = s.strip_prefix(['+', '-']).unwrap_or(s);
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    s.parse().ok()
}
