//! Go `time` 의 관측 규칙: RFC 3339 계열 형식과 `Local` 시간대.

mod zone;

pub use zone::{PLATFORM_ZONE_SOURCES, Zone, ZoneInfo, local, resolve_local};

use ::time::{OffsetDateTime, UtcOffset};

/// Go `time.Now()` 를 `Local` 시간대로 본 값.
pub fn now_local() -> OffsetDateTime {
    to_zone(OffsetDateTime::now_utc(), local())
}

/// Go `t.In(zone)`. 오프셋이나 결과 연도가 `time` crate 의 범위(±25:59:59, ±9999년)를 넘으면 UTC 로 둔다.
pub fn to_zone(t: OffsetDateTime, zone: &Zone) -> OffsetDateTime {
    UtcOffset::from_whole_seconds(zone.offset_at(t.unix_timestamp()))
        .ok()
        .and_then(|offset| t.checked_to_offset(offset))
        .unwrap_or_else(|| t.to_offset(UtcOffset::UTC))
}

/// Go `t.Format(time.RFC3339)` — `2006-01-02T15:04:05Z07:00`.
pub fn format_rfc3339(t: OffsetDateTime) -> String {
    format_with_fraction(t, Fraction::None)
}

/// Go `t.Format("2006-01-02T15:04:05.000Z07:00")`. 밀리초 세 자리를 늘 쓴다(반올림하지 않고 자른다).
pub fn format_rfc3339_millis(t: OffsetDateTime) -> String {
    format_with_fraction(t, Fraction::Millis)
}

/// Go `t.Format(time.RFC3339Nano)` — `2006-01-02T15:04:05.999999999Z07:00`. 끝의 0 은 지우고, 모두 0 이면 점도 쓰지 않는다.
pub fn format_rfc3339_nano(t: OffsetDateTime) -> String {
    format_with_fraction(t, Fraction::NanoTrimmed)
}

/// Go `log` 기본 플래그(`LstdFlags`)의 시각 형식 `2006/01/02 15:04:05`. 뒤의 공백은 붙이지 않는다.
pub fn format_log_std(t: OffsetDateTime) -> String {
    let mut out = String::with_capacity(19);
    push_padded(&mut out, t.year().unsigned_abs(), 4);
    out.push('/');
    push_padded(&mut out, u32::from(u8::from(t.month())), 2);
    out.push('/');
    push_padded(&mut out, u32::from(t.day()), 2);
    out.push(' ');
    push_padded(&mut out, u32::from(t.hour()), 2);
    out.push(':');
    push_padded(&mut out, u32::from(t.minute()), 2);
    out.push(':');
    push_padded(&mut out, u32::from(t.second()), 2);
    out
}

#[derive(Clone, Copy)]
enum Fraction {
    None,
    Millis,
    NanoTrimmed,
}

fn format_with_fraction(t: OffsetDateTime, frac: Fraction) -> String {
    let mut out = String::with_capacity(35);
    let year = t.year();
    if year < 0 {
        out.push('-');
    }
    push_padded(&mut out, year.unsigned_abs(), 4);
    out.push('-');
    push_padded(&mut out, u32::from(u8::from(t.month())), 2);
    out.push('-');
    push_padded(&mut out, u32::from(t.day()), 2);
    out.push('T');
    push_padded(&mut out, u32::from(t.hour()), 2);
    out.push(':');
    push_padded(&mut out, u32::from(t.minute()), 2);
    out.push(':');
    push_padded(&mut out, u32::from(t.second()), 2);
    let nanos = t.nanosecond();
    match frac {
        Fraction::None => {}
        Fraction::Millis => {
            out.push('.');
            push_padded(&mut out, nanos / 1_000_000, 3);
        }
        Fraction::NanoTrimmed => {
            if nanos != 0 {
                let digits = format!("{nanos:09}");
                out.push('.');
                out.push_str(digits.trim_end_matches('0'));
            }
        }
    }
    push_iso8601_colon_tz(&mut out, t.offset().whole_seconds());
    out
}

/// Go `stdISO8601ColonTZ`(`Z07:00`). 0 이면 `Z`, 아니면 `±hh:mm` (초는 버린다).
fn push_iso8601_colon_tz(out: &mut String, offset_secs: i32) {
    if offset_secs == 0 {
        out.push('Z');
        return;
    }
    let mut zone = offset_secs / 60;
    if zone < 0 {
        out.push('-');
        zone = -zone;
    } else {
        out.push('+');
    }
    // zone 은 음수가 아니다.
    let zone = zone as u32;
    push_padded(out, zone / 60, 2);
    out.push(':');
    push_padded(out, zone % 60, 2);
}

fn push_padded(out: &mut String, v: u32, width: usize) {
    out.push_str(&format!("{v:0width$}"));
}

#[cfg(test)]
mod tests;
