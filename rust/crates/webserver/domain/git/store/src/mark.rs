//! 관측값의 짧은 지문.

use crate::store::Observation;

/// 관측의 지문이다 — signature 값과 status JSON(Go `json.Encoder`, 끝 개행 포함)의
/// FNV-1a 64 를 36진수로 쓴다.
pub fn mark(o: &Observation) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    let mut write = |b: &[u8]| {
        for &c in b {
            h ^= u64::from(c);
            h = h.wrapping_mul(0x0000_0100_0000_01b3);
        }
    };
    write(o.signature.value.as_bytes());
    write(b"|");
    if let Ok(j) = otter_gocompat::json::Encoder::new().encode(&o.status) {
        write(&j);
    }
    base36(h)
}

/// Go `strconv.FormatUint(n, 36)`.
fn base36(mut n: u64) -> String {
    const DIGITS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if n == 0 {
        return "0".into();
    }
    let mut out = Vec::new();
    while n > 0 {
        out.push(DIGITS[(n % 36) as usize]);
        n /= 36;
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_default()
}
