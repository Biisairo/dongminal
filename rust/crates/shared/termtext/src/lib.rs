//! Go 기준선 `dongminal/internal/shared/termtext` 의 Rust 포팅.
//!
//! 화면·터미널에 찍을 글자의 규칙 한 벌이다 — 숨은 글자의 판정과 정화, 줄이기
//! (FR-RDG-43·44).

/// 사람이 간선을 가려 보는 화면의 지문 길이다 (FR-PNW-80, `dmctl edges`).
pub const FP_SHOWN: usize = 16;
/// 로그와 채팅 온라인 목록의 짧은 지문 길이다. 채팅 소켓의 온라인 목록은 와이어다.
pub const FP_SHORT: usize = 12;

/// 유니코드 서식 문자(Cf)의 구간이다. Go 기준선 바이너리(go1.27.2)의 `unicode.Cf`
/// (Unicode 17.0.0)를 그대로 옮겼다 — Rust 표준 라이브러리에는 이 범주가 없다.
const CF: &[(u32, u32)] = &[
    (0x00AD, 0x00AD),
    (0x0600, 0x0605),
    (0x061C, 0x061C),
    (0x06DD, 0x06DD),
    (0x070F, 0x070F),
    (0x0890, 0x0891),
    (0x08E2, 0x08E2),
    (0x180E, 0x180E),
    (0x200B, 0x200F),
    (0x202A, 0x202E),
    (0x2060, 0x2064),
    (0x2066, 0x206F),
    (0xFEFF, 0xFEFF),
    (0xFFF9, 0xFFFB),
    (0x110BD, 0x110BD),
    (0x110CD, 0x110CD),
    (0x13430, 0x1343F),
    (0x1BCA0, 0x1BCA3),
    (0x1D173, 0x1D17A),
    (0xE0001, 0xE0001),
    (0xE0020, 0xE007F),
];

fn is_cf(c: char) -> bool {
    let c = c as u32;
    CF.binary_search_by(|&(lo, hi)| {
        if hi < c {
            std::cmp::Ordering::Less
        } else if lo > c {
            std::cmp::Ordering::Greater
        } else {
            std::cmp::Ordering::Equal
        }
    })
    .is_ok()
}

/// 찍으면 보이지 않거나 화면을 흔드는 글자인가다: 제어 문자(Cc)와 서식 문자(Cf).
pub fn hidden(c: char) -> bool {
    c.is_control() || is_cf(c)
}

/// [`hidden`] 글자를 지운다.
pub fn strip(s: &str) -> String {
    s.chars().filter(|&c| !hidden(c)).collect()
}

/// [`strip`] 의 바이트판이다. 잘못된 UTF-8 바이트는 하나마다 U+FFFD 가 된다
/// (Go `strings.Map`).
pub fn strip_bytes(b: &[u8]) -> String {
    let mut out = String::with_capacity(b.len());
    for chunk in b.utf8_chunks() {
        out.extend(chunk.valid().chars().filter(|&c| !hidden(c)));
        for _ in chunk.invalid() {
            out.push(char::REPLACEMENT_CHARACTER);
        }
    }
    out
}

/// 화면·터미널에 찍을 한 줄 문자열인가다: `max` 바이트 안의 올바른 UTF-8 이고
/// [`hidden`] 글자가 없다.
pub fn line(s: impl AsRef<[u8]>, max: usize) -> bool {
    let b = s.as_ref();
    if b.len() > max {
        return false;
    }
    match std::str::from_utf8(b) {
        Ok(s) => !s.chars().any(hidden),
        Err(_) => false,
    }
}

/// `s` 를 `n` 바이트 안으로 줄인다. 글자 하나를 가르지 않는다.
pub fn cut(s: &str, n: usize) -> &str {
    if s.len() <= n {
        return s;
    }
    let mut at = n;
    while at > 0 && !s.is_char_boundary(at) {
        at -= 1;
    }
    &s[..at]
}

#[cfg(test)]
mod tests {
    use super::*;

    // TC-RDG-41
    #[test]
    fn strip_removes_control_and_cf() {
        let input = "a\x07b\u{202e}c\u{200b}d\x7fe\u{0085}f 가\t\n한";
        assert_eq!(strip(input), "abcdef 가한");
        assert_eq!(strip("동민#0427 ok"), "동민#0427 ok");
        assert_eq!(strip_bytes(b"a\xffb\xe2\x80\xae"), "a\u{fffd}b");
        assert_eq!(strip_bytes(b"\xf0\x90\x80"), "\u{fffd}\u{fffd}\u{fffd}");
    }

    #[test]
    fn hidden_cases() {
        for c in ['\x00', '\n', '\x1b', '\u{202e}', '\u{200b}', '\u{feff}'] {
            assert!(hidden(c), "hidden({c:?})");
        }
        for c in ['a', ' ', '가', '\u{fffd}', '#'] {
            assert!(!hidden(c), "hidden({c:?})");
        }
    }

    #[test]
    fn cf_table_edges() {
        for c in [
            '\u{ad}',
            '\u{600}',
            '\u{605}',
            '\u{6dd}',
            '\u{8e2}',
            '\u{180e}',
            '\u{fff9}',
            '\u{fffb}',
            '\u{110cd}',
            '\u{1343f}',
            '\u{e0001}',
            '\u{e007f}',
        ] {
            assert!(hidden(c), "hidden({c:?})");
        }
        for c in [
            '\u{ac}',
            '\u{ae}',
            '\u{606}',
            '\u{2065}',
            '\u{fffc}',
            '\u{e0000}',
            '\u{e0080}',
        ] {
            assert!(!hidden(c), "hidden({c:?})");
        }
    }

    #[test]
    fn line_cases() {
        let cases: [(&[u8], usize, bool); 6] = [
            ("동민".as_bytes(), 64, true),
            (b"", 64, true),
            (b"abcd", 3, false),
            (b"a\nb", 64, false),
            ("a\u{202e}b".as_bytes(), 64, false),
            (b"a\xffb", 64, false),
        ];
        for (s, max, want) in cases {
            assert_eq!(line(s, max), want, "line({s:?}, {max})");
        }
    }

    #[test]
    fn cut_cases() {
        let cases = [
            ("0123456789abcdef0123", FP_SHORT, "0123456789ab"),
            ("0123456789abcdef0123", FP_SHOWN, "0123456789abcdef"),
            ("abc", FP_SHORT, "abc"),
            ("가나다", 4, "가"),
            ("가나다", 6, "가나"),
            ("가", 2, ""),
        ];
        for (s, n, want) in cases {
            assert_eq!(cut(s, n), want, "cut({s:?}, {n})");
        }
    }
}
