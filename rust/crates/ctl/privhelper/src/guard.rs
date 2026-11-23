//! 코드 확인과 잠금이다 (FR-PCH-75, D-PCH-34).

use std::sync::Mutex;
use std::time::{Duration, SystemTime};

use dm_shared_humancmd::{CODE_BAD_CODE, CODE_LOCKED, CODE_UNAVAILABLE, Error as HError};
use subtle::ConstantTimeEq;

use crate::secret::{Secret, base32_nopad, hash_recovery};
use crate::totp::{DIGITS, SKEW, hotp, step_of, unix_millis};

pub(crate) const MAX_FAILS: u32 = 5;
pub(crate) const LOCK_FOR: Duration = Duration::from_secs(5 * 60);

pub(crate) type Clock = std::sync::Arc<dyn Fn() -> SystemTime + Send + Sync>;
pub(crate) type Save = Box<dyn Fn(&Secret) -> std::io::Result<()> + Send + Sync>;

struct State {
    sec: Secret,
    fails: u32,
    until: Option<SystemTime>,
    last_step: i64,
}

/// 잠금·마지막 칸은 메모리에만 둔다. 쓴 복구 코드는 save 로 남긴다.
pub(crate) struct Guard {
    st: Mutex<State>,
    totp: Vec<u8>,
    now: Clock,
    save: Save,
}

enum Recovery {
    No,
    Ok,
    Unsaved,
}

fn herr(code: &str, until: i64) -> HError {
    HError {
        code: code.to_owned(),
        until,
    }
}

impl Guard {
    pub(crate) fn new(sec: Secret, now: Clock, save: Save) -> Option<Self> {
        let totp = base32_nopad().decode(sec.totp.as_bytes()).ok()?;
        Some(Self {
            st: Mutex::new(State {
                sec,
                fails: 0,
                until: None,
                last_step: -1,
            }),
            totp,
            now,
            save,
        })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.st
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// 잠겼으면 풀리는 시각이다. 잠금이 지났으면 횟수를 0 부터 센다.
    pub(crate) fn locked_until(&self) -> Option<SystemTime> {
        let now = (self.now)();
        lock_state(&mut self.lock(), now)
    }

    /// 코드 하나를 확인한다. 맞으면 Ok, 아니면 bad_code·locked·unavailable 이다.
    pub(crate) fn check(&self, code: &str) -> Result<(), HError> {
        let mut st = self.lock();
        let now = (self.now)();
        if let Some(u) = lock_state(&mut st, now) {
            return Err(herr(CODE_LOCKED, unix_millis(u)));
        }
        if self.totp_ok(&mut st, code, now) {
            st.fails = 0;
            return Ok(());
        }
        match self.recovery(&mut st, code) {
            Recovery::Ok => {
                st.fails = 0;
                return Ok(());
            }
            // 코드는 맞았다 — 틀린 횟수에 넣지 않는다 (§3.12a R-5).
            Recovery::Unsaved => return Err(herr(CODE_UNAVAILABLE, 0)),
            Recovery::No => {}
        }
        st.fails += 1;
        if st.fails >= MAX_FAILS {
            let u = now + LOCK_FOR;
            st.until = Some(u);
            return Err(herr(CODE_LOCKED, unix_millis(u)));
        }
        Err(herr(CODE_BAD_CODE, 0))
    }

    /// 앞뒤 한 칸 안의 코드인지 본다. 이미 쓴 칸과 그 앞 칸은 받지 않는다.
    fn totp_ok(&self, st: &mut State, code: &str, now: SystemTime) -> bool {
        if code.len() != DIGITS {
            return false;
        }
        let step = step_of(now);
        for d in -SKEW..=SKEW {
            let s = step + d;
            if s <= st.last_step || s < 0 {
                continue;
            }
            if bool::from(
                hotp(&self.totp, s as u64, DIGITS)
                    .as_bytes()
                    .ct_eq(code.as_bytes()),
            ) {
                st.last_step = s;
                return true;
            }
        }
        false
    }

    /// 쓰지 않은 복구 코드인지 본다. 맞으면 쓴 것으로 저장한다. 저장하지 못하면 쓴 것으로
    /// 치지 않는다.
    fn recovery(&self, st: &mut State, code: &str) -> Recovery {
        let c = normalize_recovery(code);
        if c.is_empty() {
            return Recovery::No;
        }
        let h = hash_recovery(&c);
        if st.sec.used.contains(&h) {
            return Recovery::No;
        }
        let hit = st
            .sec
            .recovery
            .iter()
            .flatten()
            .any(|r| bool::from(r.as_bytes().ct_eq(h.as_bytes())));
        if !hit {
            return Recovery::No;
        }
        let mut next = st.sec.clone();
        next.used.push(h);
        if (self.save)(&next).is_err() {
            return Recovery::Unsaved;
        }
        st.sec = next;
        Recovery::Ok
    }
}

fn lock_state(st: &mut State, now: SystemTime) -> Option<SystemTime> {
    let u = st.until?;
    if now < u {
        return Some(u);
    }
    st.until = None;
    st.fails = 0;
    None
}

/// 복구 코드 모양(`xxxxx-xxxxx`, 소문자 base32)이면 그 값을, 아니면 빈 값이다.
pub(crate) fn normalize_recovery(code: &str) -> String {
    let c = code.trim().to_lowercase();
    let b = c.as_bytes();
    if b.len() != 11 || b[5] != b'-' {
        return String::new();
    }
    let ok = c
        .chars()
        .enumerate()
        .all(|(i, r)| i == 5 || r.is_ascii_lowercase() || ('2'..='7').contains(&r));
    if ok { c } else { String::new() }
}
