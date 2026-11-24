//! 짝맞춤 코드 (FR-TGB-10·10a·11).

use std::sync::{Arc, Mutex};
use std::time::Duration;

use subtle::ConstantTimeEq;
use time::OffsetDateTime;

/// 짝맞춤 코드의 수명 (FR-TGB-10).
pub const PAIR_TTL: Duration = Duration::from_secs(10 * 60);
/// 코드를 폐기하는 틀린 시도 수 (FR-TGB-10a). 6자리는 대입에 약하다.
pub const PAIR_MAX_FAILS: u32 = 5;
const CODE_SPACE: u32 = 1_000_000;

/// 지금 시각. Go `time.Now` 자리다.
pub type NowFn = Arc<dyn Fn() -> OffsetDateTime + Send + Sync>;

struct State {
    code: String,
    exp: OffsetDateTime,
    fails: u32,
}

/// 짝맞춤 코드 하나. 새 코드를 내면 이전 코드는 죽고, 한 번 쓰면 죽는다.
pub struct Pairing {
    st: Mutex<State>,
    now: NowFn,
}

impl Pairing {
    pub fn new(now: NowFn) -> Self {
        Pairing {
            st: Mutex::new(State {
                code: String::new(),
                exp: OffsetDateTime::UNIX_EPOCH,
                fails: 0,
            }),
            now,
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.st.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn live(&self, s: &State) -> bool {
        !s.code.is_empty() && (self.now)() < s.exp
    }

    /// 6자리 코드와 만료를 낸다.
    pub fn issue(&self) -> (String, OffsetDateTime) {
        let n: u32 = rand::random_range(0..CODE_SPACE);
        let mut s = self.lock();
        s.code = format!("{n:06}");
        s.exp = (self.now)() + PAIR_TTL;
        s.fails = 0;
        (s.code.clone(), s.exp)
    }

    /// 코드가 맞고 살아 있으면 참이고, 그 코드를 죽인다.
    pub fn redeem(&self, code: &str) -> bool {
        let mut s = self.lock();
        if !self.live(&s) {
            return false;
        }
        if !bool::from(code.as_bytes().ct_eq(s.code.as_bytes())) {
            s.fails += 1;
            if s.fails >= PAIR_MAX_FAILS {
                s.code.clear();
            }
            return false;
        }
        s.code.clear();
        true
    }

    /// 살아 있는 코드의 만료. 코드는 내주지 않는다.
    pub fn pending(&self) -> Option<OffsetDateTime> {
        let s = self.lock();
        self.live(&s).then_some(s.exp)
    }

    /// 살아 있는 코드를 죽인다.
    pub fn cancel(&self) {
        self.lock().code.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(secs: i64) -> (NowFn, Arc<Mutex<OffsetDateTime>>) {
        let t = Arc::new(Mutex::new(
            OffsetDateTime::from_unix_timestamp(secs).unwrap(),
        ));
        let t2 = Arc::clone(&t);
        (Arc::new(move || *t2.lock().unwrap()), t)
    }

    #[test]
    fn code_shape_and_single_use() {
        let (now, t) = at(1000);
        let p = Pairing::new(now);
        let (code, exp) = p.issue();
        assert!(
            code.len() == 6 && code.bytes().all(|b| b.is_ascii_digit()),
            "{code}"
        );
        assert_eq!(exp, *t.lock().unwrap() + PAIR_TTL);
        assert!(!p.redeem("000000x"));
        assert!(p.redeem(&code));
        assert!(!p.redeem(&code));
    }

    #[test]
    fn code_expires() {
        let (now, t) = at(1000);
        let p = Pairing::new(now);
        let (code, _) = p.issue();
        *t.lock().unwrap() += PAIR_TTL + Duration::from_secs(1);
        assert!(!p.redeem(&code));
    }

    #[test]
    fn reissue_kills_old() {
        let (now, _) = at(1000);
        let p = Pairing::new(now);
        let (old, _) = p.issue();
        let (fresh, _) = p.issue();
        if old != fresh {
            assert!(!p.redeem(&old));
        }
        assert!(p.redeem(&fresh));
    }

    #[test]
    fn no_code_rejects() {
        let (now, _) = at(1000);
        let p = Pairing::new(now);
        assert!(!p.redeem(""));
        assert!(!p.redeem("123456"));
    }

    #[test]
    fn kills_code_after_failures() {
        let (now, _) = at(1000);
        let p = Pairing::new(now);
        let (code, _) = p.issue();
        for _ in 0..PAIR_MAX_FAILS {
            assert!(!p.redeem("x"));
        }
        assert!(!p.redeem(&code));
    }

    #[test]
    fn pending_and_cancel() {
        let (now, t) = at(1000);
        let p = Pairing::new(now);
        assert_eq!(p.pending(), None);
        let (code, exp) = p.issue();
        assert_eq!(p.pending(), Some(exp));
        p.redeem(&code);
        assert_eq!(p.pending(), None);
        p.issue();
        *t.lock().unwrap() += PAIR_TTL;
        assert_eq!(p.pending(), None);
        let (code, _) = p.issue();
        p.cancel();
        assert_eq!(p.pending(), None);
        assert!(!p.redeem(&code));
    }
}
