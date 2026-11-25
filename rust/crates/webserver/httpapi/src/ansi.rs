//! 바이트를 JSON 글자로 (Go `string(b)`).

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
