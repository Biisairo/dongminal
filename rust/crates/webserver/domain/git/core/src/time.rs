//! 커밋 시각 변환.

const UNIX_SEC_TO_MILLI: i64 = 1000;

/// %at·%ct 의 초를 ms 로 옮긴다. 읽지 못하면 0 이다 (Go `strconv.ParseInt(.., 10, 64)`).
pub fn unix_sec_to_milli(s: &str) -> i64 {
    parse_int(s.trim()).map_or(0, |n| n.wrapping_mul(UNIX_SEC_TO_MILLI))
}

/// Go ParseInt 는 앞의 `+`·`-` 하나와 10진 숫자만 받는다. Rust `parse` 도 같다.
fn parse_int(s: &str) -> Option<i64> {
    s.parse::<i64>().ok()
}
