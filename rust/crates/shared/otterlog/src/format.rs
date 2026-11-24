//! slog 의 줄 조립.

use otter_gocompat::strconv::{is_print, quote};
use otter_gocompat::time::{format_log_std, format_rfc3339_millis};
use time::OffsetDateTime;

use crate::{Level, Value};

/// slog `needsQuoting`. ASCII 는 JSON 의 safeSet 기준(제어 문자·`"` 는 인용, `\` 와 DEL 은
/// 그대로)에 공백·`=` 를 더한다. 비 ASCII 는 U+FFFD·공백·인쇄 불가 문자면 인용한다.
fn needs_quoting(s: &str) -> bool {
    if s.is_empty() {
        return true;
    }
    s.chars().any(|c| {
        if c.is_ascii() {
            let b = c as u8;
            b != b'\\' && (b == b' ' || b == b'=' || b == b'"' || b < 0x20)
        } else {
            c == char::REPLACEMENT_CHARACTER || c.is_whitespace() || !is_print(c)
        }
    })
}

fn push_string(buf: &mut String, s: &str) {
    if needs_quoting(s) {
        buf.push_str(&quote(s));
    } else {
        buf.push_str(s);
    }
}

fn push_value(buf: &mut String, v: &Value) {
    match v {
        Value::Str(s) => push_string(buf, s),
        Value::Int(n) => buf.push_str(&n.to_string()),
        Value::Uint(n) => buf.push_str(&n.to_string()),
        Value::Bool(b) => buf.push_str(if *b { "true" } else { "false" }),
    }
}

/// `With("reqId", id)` 로 미리 붙은 속성이 먼저, 호출 속성이 뒤에 온다.
fn push_attrs(buf: &mut String, req_id: Option<&str>, attrs: &[(&str, Value)]) {
    if let Some(id) = req_id {
        buf.push(' ');
        push_string(buf, "reqId");
        buf.push('=');
        push_string(buf, id);
    }
    for (k, v) in attrs {
        buf.push(' ');
        push_string(buf, k);
        buf.push('=');
        push_value(buf, v);
    }
}

/// slog `TextHandler` 의 한 줄.
pub(crate) fn text_line(
    t: OffsetDateTime,
    level: Level,
    msg: &str,
    req_id: Option<&str>,
    attrs: &[(&str, Value)],
) -> String {
    let mut buf = String::with_capacity(64 + msg.len());
    buf.push_str("time=");
    buf.push_str(&format_rfc3339_millis(t));
    buf.push_str(" level=");
    buf.push_str(level.go_name());
    buf.push_str(" msg=");
    push_string(&mut buf, msg);
    push_attrs(&mut buf, req_id, attrs);
    buf.push('\n');
    buf
}

/// slog 기본 핸들러가 표준 `log`(LstdFlags)로 내는 한 줄. msg 는 인용하지 않는다.
pub(crate) fn default_line(
    t: OffsetDateTime,
    level: Level,
    msg: &str,
    req_id: Option<&str>,
    attrs: &[(&str, Value)],
) -> String {
    let mut buf = String::with_capacity(32 + msg.len());
    buf.push_str(&format_log_std(t));
    buf.push(' ');
    buf.push_str(level.go_name());
    buf.push(' ');
    buf.push_str(msg);
    push_attrs(&mut buf, req_id, attrs);
    if !buf.ends_with('\n') {
        buf.push('\n');
    }
    buf
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(offset_secs: i32) -> OffsetDateTime {
        let off = time::UtcOffset::from_whole_seconds(offset_secs).unwrap();
        time::macros::datetime!(2026-11-23 07:05:03.120_999_999).assume_offset(off)
    }

    #[test]
    fn quoting_rules() {
        for (s, want) in [
            ("", true),
            ("plain", false),
            ("a b", true),
            ("a=b", true),
            ("a\"b", true),
            ("a\\b", false),
            ("a\nb", true),
            ("a\u{7f}b", false),
            ("한글", false),
            ("a\u{a0}b", true),
            ("a\u{fffd}b", true),
            ("<&>", false),
        ] {
            assert_eq!(needs_quoting(s), want, "{s:?}");
        }
    }

    #[test]
    fn text_line_shape() {
        let got = text_line(
            t(9 * 3600),
            Level::Info,
            "열었다",
            Some("r1"),
            &[
                ("tool", "t-9".into()),
                ("gen", 3i64.into()),
                ("ok", true.into()),
            ],
        );
        assert_eq!(
            got,
            "time=2026-11-23T07:05:03.120+09:00 level=INFO msg=열었다 reqId=r1 tool=t-9 gen=3 ok=true\n"
        );
    }

    #[test]
    fn text_line_quotes_msg_and_utc_is_z() {
        let got = text_line(t(0), Level::Warn, "무언가 7", None, &[]);
        assert_eq!(
            got,
            "time=2026-11-23T07:05:03.120Z level=WARN msg=\"무언가 7\"\n"
        );
    }

    // Go 1.27 slog 실제 출력에서 옮긴 기대값.
    #[test]
    fn text_line_matches_go_quoting() {
        let got = text_line(
            t(0),
            Level::Info,
            "x",
            None,
            &[
                ("a\\b", "a\u{7f}b".into()),
                ("nb", "a\u{a0}b".into()),
                ("q", "a\"b".into()),
                ("", "e".into()),
            ],
        );
        assert_eq!(
            got,
            "time=2026-11-23T07:05:03.120Z level=INFO msg=x a\\b=a\u{7f}b nb=\"a\\u00a0b\" q=\"a\\\"b\" \"\"=e\n"
        );
    }

    #[test]
    fn default_line_shape() {
        let got = default_line(
            t(-4 * 3600),
            Level::Error,
            "a b",
            Some("x"),
            &[("k", "v w".into())],
        );
        assert_eq!(got, "2026/11/23 07:05:03 ERROR a b reqId=x k=\"v w\"\n");
    }
}
