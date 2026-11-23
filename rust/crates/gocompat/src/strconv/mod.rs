//! Go `strconv` 의 관측 규칙. `fmt` 의 `%q` 도 문자열에서는 [`quote`] 와 같다.

mod float;
mod isprint;
mod parse;

pub use float::format_float;
pub use parse::{NumError, NumErrorKind, parse_bool, parse_uint10};

use isprint::{IS_NOT_PRINT16, IS_NOT_PRINT32, IS_PRINT16, IS_PRINT32};

const LOWER_HEX: &[u8; 16] = b"0123456789abcdef";

/// Go `strconv.Quote`. 큰따옴표로 감싼 Go 문자열 리터럴을 돌려준다.
pub fn quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    append_quote(&mut out, s);
    out
}

/// Go `strconv.AppendQuote`.
pub fn append_quote(dst: &mut String, s: &str) {
    dst.push('"');
    for c in s.chars() {
        append_escaped_char(dst, c);
    }
    dst.push('"');
}

/// 잘못된 UTF-8 을 담을 수 있는 Go 문자열(바이트열)의 `strconv.Quote`. 잘못된 바이트는 `\xNN` 이 된다.
pub fn quote_bytes(s: &[u8]) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for chunk in s.utf8_chunks() {
        for c in chunk.valid().chars() {
            append_escaped_char(&mut out, c);
        }
        for &b in chunk.invalid() {
            push_hex_byte(&mut out, b);
        }
    }
    out.push('"');
    out
}

fn push_hex_byte(dst: &mut String, b: u8) {
    dst.push_str("\\x");
    dst.push(char::from(LOWER_HEX[usize::from(b >> 4)]));
    dst.push(char::from(LOWER_HEX[usize::from(b & 0xf)]));
}

/// Go `strconv.QuoteRune`. 작은따옴표로 감싼 Go 룬 리터럴.
pub fn quote_rune(c: char) -> String {
    let mut out = String::with_capacity(4);
    out.push('\'');
    append_escaped(&mut out, c, '\'');
    out.push('\'');
    out
}

fn append_escaped_char(dst: &mut String, c: char) {
    append_escaped(dst, c, '"');
}

fn append_escaped(dst: &mut String, c: char, quote: char) {
    if c == quote || c == '\\' {
        dst.push('\\');
        dst.push(c);
        return;
    }
    if is_print(c) {
        dst.push(c);
        return;
    }
    match c {
        '\u{07}' => dst.push_str("\\a"),
        '\u{08}' => dst.push_str("\\b"),
        '\u{0c}' => dst.push_str("\\f"),
        '\n' => dst.push_str("\\n"),
        '\r' => dst.push_str("\\r"),
        '\t' => dst.push_str("\\t"),
        '\u{0b}' => dst.push_str("\\v"),
        _ => {
            let r = u32::from(c);
            if r < 0x20 || r == 0x7f {
                // r < 0x80 이므로 u8 로 줄여도 값이 같다.
                push_hex_byte(dst, r as u8);
            } else if r < 0x10000 {
                dst.push_str("\\u");
                push_hex_digits(dst, r, 4);
            } else {
                dst.push_str("\\U");
                push_hex_digits(dst, r, 8);
            }
        }
    }
}

fn push_hex_digits(dst: &mut String, r: u32, n: u32) {
    for i in (0..n).rev() {
        dst.push(char::from(LOWER_HEX[((r >> (i * 4)) & 0xf) as usize]));
    }
}

/// Go `strconv.IsPrint` (= `unicode.IsPrint`): 문자·숫자·구두점·기호와 ASCII 공백.
pub fn is_print(c: char) -> bool {
    let r = u32::from(c);
    if r <= 0xff {
        if (0x20..=0x7e).contains(&r) {
            return true;
        }
        if (0xa1..=0xff).contains(&r) {
            return r != 0xad;
        }
        return false;
    }
    if r < 0x10000 {
        // r < 0x10000 이므로 u16 로 줄여도 값이 같다.
        let rr = r as u16;
        if !in_ranges(IS_PRINT16, rr) {
            return false;
        }
        return IS_NOT_PRINT16.binary_search(&rr).is_err();
    }
    if !in_ranges(IS_PRINT32, r) {
        return false;
    }
    if r >= 0x20000 {
        return true;
    }
    // 0x10000 <= r < 0x20000 이므로 차이는 u16 에 들어간다.
    IS_NOT_PRINT32
        .binary_search(&((r - 0x10000) as u16))
        .is_err()
}

/// `table` 은 [시작, 끝] 쌍을 이어 붙인 정렬된 목록이다. Go `IsPrint` 의 탐색과 같다.
fn in_ranges<T: Ord + Copy>(table: &[T], v: T) -> bool {
    let i = table.partition_point(|&x| x < v);
    i < table.len() && table[i & !1] <= v && v <= table[i | 1]
}

#[cfg(test)]
mod tests;
