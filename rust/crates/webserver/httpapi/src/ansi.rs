//! 터미널 제어열 걷어내기 (Go `ansi.go`).

use std::sync::LazyLock;

use regex::bytes::Regex;

static ANSI_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?-u)\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]|\x1b\][\x20-\x7e]*(?:\x07|\x1b\\)|\x1b[\x40-\x5f]")
        .unwrap_or_else(|e| unreachable!("ansi 정규식: {e}"))
});

/// Go `stripANSI`: 제어열을 지우고, `\n`·`\t` 를 뺀 제어 문자와 `\r`·DEL 을 버린다.
pub(crate) fn strip_ansi(b: &[u8]) -> String {
    let s = ANSI_RE.replace_all(b, &b""[..]);
    let out: Vec<u8> = s
        .iter()
        .copied()
        .filter(|&c| !(c == b'\r' || (c < 0x20 && c != b'\n' && c != b'\t') || c == 0x7f))
        .collect();
    go_string(&out)
}

/// Go `string(b)` 를 JSON 으로 낼 때와 같게 한다. 유효한 문자에 속하지 않는 바이트는 하나마다
/// U+FFFD 하나다(Go `utf8.DecodeRune` 이 폭 1 로 건너뛴다).
pub(crate) fn go_string(b: &[u8]) -> String {
    let mut out = String::with_capacity(b.len());
    let mut rest = b;
    loop {
        match std::str::from_utf8(rest) {
            Ok(s) => {
                out.push_str(s);
                return out;
            }
            Err(e) => {
                let (ok, bad) = rest.split_at(e.valid_up_to());
                out.push_str(std::str::from_utf8(ok).unwrap_or_default());
                let n = e.error_len().unwrap_or(bad.len());
                out.extend(std::iter::repeat_n('\u{FFFD}', n));
                rest = &bad[n..];
            }
        }
    }
}
