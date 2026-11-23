//! RFC 6238 TOTP: HMAC-SHA1, 30초, 6자리 (PEER_CHAT_SRS §3.12, NFR-PCH-4).

use std::time::{SystemTime, UNIX_EPOCH};

use hmac::{Hmac, KeyInit, Mac};
use sha1::Sha1;

pub(crate) const PERIOD: i64 = 30;
pub(crate) const DIGITS: usize = 6;
/// 앞뒤로 받는 칸 수다. 휴대폰과 PC 의 시계 어긋남을 덮는다.
pub(crate) const SKEW: i64 = 1;

/// Go `t.Unix()`.
pub(crate) fn unix_secs(t: SystemTime) -> i64 {
    match t.duration_since(UNIX_EPOCH) {
        Ok(d) => d.as_secs() as i64,
        Err(e) => -(e.duration().as_secs_f64().ceil() as i64),
    }
}

/// Go `t.UnixMilli()`.
pub(crate) fn unix_millis(t: SystemTime) -> i64 {
    match t.duration_since(UNIX_EPOCH) {
        Ok(d) => d.as_millis() as i64,
        Err(e) => -(e.duration().as_millis() as i64),
    }
}

/// t 의 시간 칸이다.
pub(crate) fn step_of(t: SystemTime) -> i64 {
    unix_secs(t) / PERIOD
}

/// RFC 4226 의 코드다.
pub(crate) fn hotp(secret: &[u8], counter: u64, n: usize) -> String {
    let Ok(mut m) = <Hmac<Sha1> as KeyInit>::new_from_slice(secret) else {
        return String::new();
    };
    m.update(&counter.to_be_bytes());
    let sum = m.finalize().into_bytes();
    let off = (sum[sum.len() - 1] & 0x0f) as usize;
    let v = u32::from_be_bytes([sum[off], sum[off + 1], sum[off + 2], sum[off + 3]]) & 0x7fff_ffff;
    let modulus = 10u32.pow(n as u32);
    format!("{:0width$}", v % modulus, width = n)
}
