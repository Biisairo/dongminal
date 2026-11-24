//! Go 기준선 `otterminal/internal/shared/diagtail` 의 Rust 포팅.
//!
//! 실행 진단 문자열을 사람이 읽을 만큼만 남긴다 (FR-DRC-9).
//!
//! Go 문자열은 잘못된 UTF-8 을 담을 수 있고, 자르지 않은 진단은 바이트 그대로
//! 나간다. 그 바이트를 Go JSON 인코더처럼 바꾸는 일은 받는 쪽 몫이므로, 이 crate 는
//! 바이트판(`cut`·`of`)을 기본으로 둔다.

/// **뒤쪽을** `max` 바이트까지 남긴다 — 실패의 이유는 stderr 끝에 있다.
///
/// 자르면 잘못된 UTF-8(자른 자리의 조각 포함)을 지운다 (Go `strings.ToValidUTF8(…, "")`).
/// 자르지 않으면 원문 그대로다.
pub fn cut(msg: &[u8], max: usize) -> Vec<u8> {
    if msg.len() <= max {
        return msg.to_vec();
    }
    to_valid_utf8_dropping(&msg[msg.len() - max..]).into_bytes()
}

/// [`cut`] 의 문자열판이다.
pub fn cut_str(msg: &str, max: usize) -> String {
    if msg.len() <= max {
        return msg.to_owned();
    }
    to_valid_utf8_dropping(&msg.as_bytes()[msg.len() - max..])
}

/// 실행 결과 하나의 진단이다. 출력(앞뒤 공백 제외)이 비었으면 오류 문구를 쓴다.
pub fn of(out: &[u8], err: Option<&str>, max: usize) -> Vec<u8> {
    let mut s = trim_space(out);
    if s.is_empty()
        && let Some(e) = err
    {
        s = e.as_bytes();
    }
    cut(s, max)
}

/// [`of`] 의 문자열판이다.
pub fn of_str(out: &str, err: Option<&str>, max: usize) -> String {
    let mut s = out.trim();
    if s.is_empty()
        && let Some(e) = err
    {
        s = e;
    }
    cut_str(s, max)
}

/// Go `strings.ToValidUTF8(s, "")`: 잘못된 바이트를 지운다.
fn to_valid_utf8_dropping(mut b: &[u8]) -> String {
    let mut out = String::with_capacity(b.len());
    loop {
        match std::str::from_utf8(b) {
            Ok(s) => {
                out.push_str(s);
                return out;
            }
            Err(e) => {
                let (good, rest) = b.split_at(e.valid_up_to());
                if let Ok(s) = std::str::from_utf8(good) {
                    out.push_str(s);
                }
                let skip = e.error_len().unwrap_or(rest.len());
                b = &rest[skip..];
            }
        }
    }
}

/// Go `strings.TrimSpace` 의 바이트판이다. 앞뒤의 유니코드 공백 글자를 걷는다.
/// 잘못된 바이트를 만나면 그 자리에서 멈춘다 (Go 는 U+FFFD 로 읽고, 그것은 공백이 아니다).
fn trim_space(mut b: &[u8]) -> &[u8] {
    while let Some((c, n)) = first_char(b) {
        if !c.is_whitespace() {
            break;
        }
        b = &b[n..];
    }
    while let Some((c, n)) = last_char(b) {
        if !c.is_whitespace() {
            break;
        }
        b = &b[..b.len() - n];
    }
    b
}

fn first_char(b: &[u8]) -> Option<(char, usize)> {
    (1..=b.len().min(4)).find_map(|n| {
        std::str::from_utf8(&b[..n])
            .ok()
            .and_then(|s| s.chars().next().map(|c| (c, n)))
    })
}

fn last_char(b: &[u8]) -> Option<(char, usize)> {
    (1..=b.len().min(4)).find_map(|n| {
        std::str::from_utf8(&b[b.len() - n..])
            .ok()
            .and_then(|s| s.chars().next().map(|c| (c, n)))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cut_keeps_tail() {
        assert_eq!(cut_str("abcdef", 10), "abcdef");
        assert_eq!(cut_str("abcdef", 3), "def");
    }

    #[test]
    fn cut_drops_split_rune() {
        // "가나" = EA B0 80 EB 82 98. 끝 4바이트는 B0 80 + "나" — 앞 조각을 버린다.
        assert_eq!(cut_str("가나", 4), "나");
        assert_eq!(cut_str("가나", 2), "");
    }

    #[test]
    fn uncut_bytes_kept_verbatim() {
        assert_eq!(cut(b"x\xffab", 10), b"x\xffab");
        assert_eq!(cut(b"x\xffabc", 4), b"abc");
        assert_eq!(cut(b"\xff\xfeab", 3), b"ab");
    }

    #[test]
    fn of_falls_back_to_error() {
        assert_eq!(of_str("  \n", Some("exit status 1"), 100), "exit status 1");
        assert_eq!(of_str(" out \n", Some("e"), 100), "out");
        assert_eq!(of_str("", None, 100), "");
        assert_eq!(of(" \u{3000}\n".as_bytes(), Some("boom"), 100), b"boom");
        assert_eq!(of(b"\n err\xff \t", None, 100), b"err\xff");
    }
}
