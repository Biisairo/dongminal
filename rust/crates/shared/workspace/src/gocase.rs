//! Go `strings.ToLower`·`ToUpper` 의 문자 단위 단순 대소문자 변환.
//!
//! Rust `str::to_lowercase` 는 문맥 규칙(끝 시그마 → ς)과 여러 문자로 바뀌는 규칙(İ → i̇)을
//! 쓴다. Go 는 문자 하나를 문자 하나로 바꾼다. 탭 uuid 의 소문자 색인이 Go 와 같은 것을
//! 맞추게 한다.

fn one(mut it: impl Iterator<Item = char> + ExactSizeIterator, c: char, multi: char) -> char {
    if it.len() == 1 {
        it.next().unwrap_or(c)
    } else {
        multi
    }
}

pub(crate) fn to_lower(s: &str) -> String {
    // 여러 문자로 바뀌는 소문자는 U+0130 하나다. Go 의 단순 변환은 'i' 다.
    s.chars()
        .map(|c| one(c.to_lowercase(), c, if c == '\u{130}' { 'i' } else { c }))
        .collect()
}

pub(crate) fn to_upper(s: &str) -> String {
    s.chars().map(|c| one(c.to_uppercase(), c, c)).collect()
}
