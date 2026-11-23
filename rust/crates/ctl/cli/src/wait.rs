//! 동기 폴링. `dm_shared_pollwait::until` 과 같은 의미다(먼저 묻고, `every` 마다, 남은 시간이
//! 짧으면 그만큼만 잔다) — CLI 는 비동기 런타임 없이 돈다.

use std::time::{Duration, Instant};

/// `cond` 가 `max` 안에 참이 되면 true 다.
pub(crate) fn poll_until(max: Duration, every: Duration, mut cond: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + max;
    loop {
        if cond() {
            return true;
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return false;
        }
        std::thread::sleep(remaining.min(every));
    }
}
