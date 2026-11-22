//! 짝(지문)·출발지마다의 요청 상한 (FR-PNW-43).

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use time::OffsetDateTime;

/// 짝 하나가 1분 동안 보낼 수 있는 요청 수다.
pub const PER_KEY_PER_MINUTE: usize = 60;
const RATE_WINDOW: Duration = Duration::from_secs(60);
/// 키가 이만큼 쌓이면 창을 지난 키를 지우는 문턱이다. 키는 상대가 고를 수 있다 — 지우지 않으면
/// 맵이 끝없이 커진다.
const RATE_SWEEP_AT: usize = 1024;

pub type Clock = Box<dyn Fn() -> OffsetDateTime + Send + Sync>;

struct State {
    hits: HashMap<String, Vec<OffsetDateTime>>,
    /// 마지막 정리 시각. 정리는 창마다 한 번이다.
    last_sweep: OffsetDateTime,
    sweeps: usize,
}

/// 키마다 지난 1분의 요청 시각을 센다.
pub struct RateLimiter {
    now: Clock,
    state: Mutex<State>,
}

impl RateLimiter {
    pub fn new(now: Clock) -> Self {
        Self {
            now,
            state: Mutex::new(State { hits: HashMap::new(), last_sweep: OffsetDateTime::UNIX_EPOCH, sweeps: 0 }),
        }
    }

    /// key 의 요청 하나를 세고, 상한 안이면 참이다.
    pub fn allow(&self, key: &str) -> bool {
        let now = (self.now)();
        let cut = now - RATE_WINDOW;
        let mut st = self.state.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if st.hits.len() >= RATE_SWEEP_AT && now >= st.last_sweep + RATE_WINDOW {
            st.last_sweep = now;
            st.sweeps += 1;
            st.hits.retain(|_, ts| ts.last().is_some_and(|t| *t > cut));
        }
        let hits = st.hits.entry(key.to_string()).or_default();
        hits.retain(|t| *t > cut);
        if hits.len() >= PER_KEY_PER_MINUTE {
            return false;
        }
        hits.push(now);
        true
    }

    #[cfg(test)]
    fn size(&self) -> usize {
        self.state.lock().map(|s| s.hits.len()).unwrap_or_default()
    }

    #[cfg(test)]
    fn sweeps(&self) -> usize {
        self.state.lock().map(|s| s.sweeps).unwrap_or_default()
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use std::sync::Arc;

    use time::macros::datetime;

    use super::*;

    /// 시험용 시계. 앞으로만 간다.
    #[derive(Clone)]
    pub(crate) struct FakeClock(pub Arc<Mutex<OffsetDateTime>>);

    impl FakeClock {
        pub fn new() -> Self {
            Self(Arc::new(Mutex::new(datetime!(2026-11-10 09:00:00 UTC))))
        }
        pub fn now(&self) -> OffsetDateTime {
            *self.0.lock().unwrap()
        }
        pub fn advance(&self, d: Duration) {
            *self.0.lock().unwrap() += d;
        }
        pub fn clock(&self) -> Clock {
            let c = self.clone();
            Box::new(move || c.now())
        }
    }

    #[test]
    fn per_key() {
        let clk = FakeClock::new();
        let rl = RateLimiter::new(clk.clock());
        for i in 0..PER_KEY_PER_MINUTE {
            assert!(rl.allow("a"), "{}번째가 막혔다", i + 1);
        }
        assert!(!rl.allow("a"), "61번째가 통과했다");
        assert!(rl.allow("b"));
        clk.advance(Duration::from_secs(60));
        assert!(rl.allow("a"));
    }

    #[test]
    fn sliding_window() {
        let clk = FakeClock::new();
        let rl = RateLimiter::new(clk.clock());
        for _ in 0..PER_KEY_PER_MINUTE {
            rl.allow("a");
        }
        clk.advance(Duration::from_secs(59));
        assert!(!rl.allow("a"));
        clk.advance(Duration::from_secs(2));
        assert!(rl.allow("a"));
    }

    #[test]
    fn forgets_stale_keys() {
        let clk = FakeClock::new();
        let rl = RateLimiter::new(clk.clock());
        for i in 0..RATE_SWEEP_AT {
            rl.allow(&i.to_string());
        }
        clk.advance(Duration::from_secs(61));
        rl.allow("fresh");
        assert_eq!(rl.size(), 1);
    }

    #[test]
    fn sweeps_once_per_window() {
        let clk = FakeClock::new();
        let rl = RateLimiter::new(clk.clock());
        for i in 0..RATE_SWEEP_AT {
            rl.allow(&i.to_string());
        }
        rl.allow("x");
        let first = rl.sweeps();
        for i in 0..10 {
            rl.allow(&format!("y{i}"));
        }
        assert_eq!(rl.sweeps(), first);
        clk.advance(RATE_WINDOW);
        rl.allow("z");
        assert_eq!(rl.sweeps(), first + 1);
    }
}
