//! Go `time.Parse(time.RFC3339 | time.RFC3339Nano, s)` 와 `time.Time` 의 JSON 형식.

use std::fmt;

use ::time::{Date, Month, OffsetDateTime, PrimitiveDateTime, Time, UtcOffset};

use super::format_rfc3339_nano;

/// Go `time.RFC3339`.
pub const RFC3339: &str = "2006-01-02T15:04:05Z07:00";
/// Go `time.RFC3339Nano`.
pub const RFC3339_NANO: &str = "2006-01-02T15:04:05.999999999Z07:00";

/// Go `*time.ParseError`. `Display` 가 Go 문구와 같다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParseError {
    layout: &'static str,
    value: String,
    layout_elem: String,
    value_elem: String,
    message: String,
}

/// Go `time` 패키지의 `quote`: ASCII 출력 가능 문자 밖은 바이트마다 `\xNN`.
fn quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        if !(' '..'\u{80}').contains(&c) {
            let mut buf = [0u8; 4];
            for b in c.encode_utf8(&mut buf).bytes() {
                out.push_str(&format!("\\x{b:02x}"));
            }
        } else {
            if c == '"' || c == '\\' {
                out.push('\\');
            }
            out.push(c);
        }
    }
    out.push('"');
    out
}

impl fmt::Display for ParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.message.is_empty() {
            write!(
                f,
                "parsing time {} as {}: cannot parse {} as {}",
                quote(&self.value),
                quote(self.layout),
                quote(&self.value_elem),
                quote(&self.layout_elem)
            )
        } else {
            write!(f, "parsing time {}{}", quote(&self.value), self.message)
        }
    }
}

impl std::error::Error for ParseError {}

/// Go `time.Parse(time.RFC3339, s)`.
pub fn parse_rfc3339(s: &str) -> Result<OffsetDateTime, ParseError> {
    parse(RFC3339, s)
}

/// Go `time.Parse(time.RFC3339Nano, s)`. 받아들이는 입력은 [`parse_rfc3339`] 와 같고 오류 문구의 레이아웃만 다르다.
pub fn parse_rfc3339_nano(s: &str) -> Result<OffsetDateTime, ParseError> {
    parse(RFC3339_NANO, s)
}

#[derive(Clone, Copy)]
enum Elem {
    Lit(&'static str),
    Year,
    Month,
    Day,
    Hour,
    Minute,
    Second,
    Frac9,
    Tz,
}

impl Elem {
    fn std_str(self) -> &'static str {
        match self {
            Elem::Lit(s) => s,
            Elem::Year => "2006",
            Elem::Month => "01",
            Elem::Day => "02",
            Elem::Hour => "15",
            Elem::Minute => "04",
            Elem::Second => "05",
            Elem::Frac9 => ".999999999",
            Elem::Tz => "Z07:00",
        }
    }
}

fn is_digit(s: &[u8], i: usize) -> bool {
    s.get(i).is_some_and(u8::is_ascii_digit)
}

/// Go `getnum`.
fn getnum(s: &[u8], fixed: bool) -> Option<(i64, &[u8])> {
    if !is_digit(s, 0) {
        return None;
    }
    if !is_digit(s, 1) {
        if fixed {
            return None;
        }
        return Some((i64::from(s[0] - b'0'), &s[1..]));
    }
    Some((
        i64::from(s[0] - b'0') * 10 + i64::from(s[1] - b'0'),
        &s[2..],
    ))
}

/// Go `parseNanoseconds`. `value[0]` 은 `.` 이나 `,` 다.
fn parse_nanoseconds(value: &[u8], nbytes: usize) -> Option<i64> {
    let nbytes = nbytes.min(10);
    let digits = std::str::from_utf8(&value[1..nbytes]).ok()?;
    let mut ns: i64 = digits.parse().ok()?;
    for _ in 0..(10 - nbytes) {
        ns *= 10;
    }
    Some(ns)
}

fn days_in(month: i64, year: i64) -> i64 {
    match month {
        2 if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

fn parse(layout: &'static str, input: &str) -> Result<OffsetDateTime, ParseError> {
    let elems: &[Elem] = if layout == RFC3339_NANO {
        &[
            Elem::Year,
            Elem::Lit("-"),
            Elem::Month,
            Elem::Lit("-"),
            Elem::Day,
            Elem::Lit("T"),
            Elem::Hour,
            Elem::Lit(":"),
            Elem::Minute,
            Elem::Lit(":"),
            Elem::Second,
            Elem::Frac9,
            Elem::Tz,
        ]
    } else {
        &[
            Elem::Year,
            Elem::Lit("-"),
            Elem::Month,
            Elem::Lit("-"),
            Elem::Day,
            Elem::Lit("T"),
            Elem::Hour,
            Elem::Lit(":"),
            Elem::Minute,
            Elem::Lit(":"),
            Elem::Second,
            Elem::Tz,
        ]
    };
    let err = |layout_elem: &str, value_elem: &[u8], message: &str| ParseError {
        layout,
        value: input.to_owned(),
        layout_elem: layout_elem.to_owned(),
        value_elem: String::from_utf8_lossy(value_elem).into_owned(),
        message: message.to_owned(),
    };
    let (mut year, mut month, mut day) = (0i64, 0i64, 0i64);
    let (mut hour, mut min, mut sec, mut nsec) = (0i64, 0i64, 0i64, 0i64);
    let mut offset: Option<i64> = None;
    let mut value = input.as_bytes();

    for (k, &elem) in elems.iter().enumerate() {
        let hold = value;
        let mut range = "";
        let ok: Option<&[u8]> = match elem {
            Elem::Lit(lit) => {
                let mut v = value;
                for &c in lit.as_bytes() {
                    if v.first() != Some(&c) {
                        return Err(err(lit, v, ""));
                    }
                    v = &v[1..];
                }
                value = v;
                continue;
            }
            Elem::Year => {
                if value.len() < 4 || !is_digit(value, 0) {
                    None
                } else {
                    let p = std::str::from_utf8(&value[..4]).ok();
                    match p.and_then(|p| p.parse::<i64>().ok()) {
                        Some(y) if value[..4].iter().all(u8::is_ascii_digit) => {
                            year = y;
                            Some(&value[4..])
                        }
                        _ => None,
                    }
                }
            }
            Elem::Month => getnum(value, true).map(|(n, rest)| {
                month = n;
                if !(1..=12).contains(&n) {
                    range = "month";
                }
                rest
            }),
            Elem::Day => getnum(value, true).map(|(n, rest)| {
                day = n;
                rest
            }),
            Elem::Hour => getnum(value, false).map(|(n, rest)| {
                hour = n;
                if !(0..24).contains(&n) {
                    range = "hour";
                }
                rest
            }),
            Elem::Minute => getnum(value, true).map(|(n, rest)| {
                min = n;
                if !(0..60).contains(&n) {
                    range = "minute";
                }
                rest
            }),
            Elem::Second => match getnum(value, true) {
                None => None,
                Some((n, mut rest)) => {
                    sec = n;
                    if !(0..60).contains(&n) {
                        range = "second";
                    }
                    // 레이아웃에 소수 초가 없어도 `.ddd`·`,ddd` 를 받는다.
                    let next_is_frac = matches!(elems.get(k + 1), Some(Elem::Frac9));
                    if range.is_empty()
                        && !next_is_frac
                        && rest.len() >= 2
                        && (rest[0] == b'.' || rest[0] == b',')
                        && is_digit(rest, 1)
                    {
                        let mut n = 2;
                        while n < rest.len() && is_digit(rest, n) {
                            n += 1;
                        }
                        match parse_nanoseconds(rest, n) {
                            Some(ns) => {
                                nsec = ns;
                                rest = &rest[n..];
                                Some(rest)
                            }
                            None => None,
                        }
                    } else {
                        Some(rest)
                    }
                }
            },
            Elem::Frac9 => {
                if value.len() < 2 || !(value[0] == b'.' || value[0] == b',') || !is_digit(value, 1)
                {
                    Some(value)
                } else {
                    let mut i = 0;
                    while i + 1 < value.len() && is_digit(value, i + 1) {
                        i += 1;
                    }
                    parse_nanoseconds(value, 1 + i).map(|ns| {
                        nsec = ns;
                        &value[1 + i..]
                    })
                }
            }
            Elem::Tz => {
                if value.first() == Some(&b'Z') {
                    offset = Some(0);
                    Some(&value[1..])
                } else if value.len() < 6 || value[3] != b':' {
                    None
                } else {
                    let hr = getnum(&value[1..3], true).map(|(n, _)| n);
                    let mm = getnum(&value[4..6], true).map(|(n, _)| n);
                    match (hr, mm) {
                        (Some(hr), Some(mm)) => {
                            // Go: 범위 오류를 부호 오류보다 먼저 본다.
                            if hr > 24 {
                                range = "time zone offset hour";
                            }
                            if mm > 60 {
                                range = "time zone offset minute";
                            }
                            let off = (hr * 60 + mm) * 60;
                            match value[0] {
                                b'+' => offset = Some(off),
                                b'-' => offset = Some(-off),
                                _ if range.is_empty() => return Err(err(elem.std_str(), hold, "")),
                                _ => {}
                            }
                            Some(&value[6..])
                        }
                        _ => None,
                    }
                }
            }
        };
        let Some(rest) = ok else {
            return Err(err(elem.std_str(), hold, ""));
        };
        value = rest;
        if !range.is_empty() {
            return Err(err(
                elem.std_str(),
                value,
                &format!(": {range} out of range"),
            ));
        }
    }
    if !value.is_empty() {
        let extra = String::from_utf8_lossy(value).into_owned();
        return Err(err("", value, &format!(": extra text: {}", quote(&extra))));
    }
    if day < 1 || day > days_in(month, year) {
        return Err(err("", value, ": day out of range"));
    }
    build(year, month, day, hour, min, sec, nsec, offset.unwrap_or(0))
        .ok_or_else(|| err("", value, ": out of range"))
}

#[allow(clippy::too_many_arguments)]
fn build(
    year: i64,
    month: i64,
    day: i64,
    hour: i64,
    min: i64,
    sec: i64,
    nsec: i64,
    offset: i64,
) -> Option<OffsetDateTime> {
    let month = Month::try_from(u8::try_from(month).ok()?).ok()?;
    let date =
        Date::from_calendar_date(i32::try_from(year).ok()?, month, u8::try_from(day).ok()?).ok()?;
    let time = Time::from_hms_nano(
        u8::try_from(hour).ok()?,
        u8::try_from(min).ok()?,
        u8::try_from(sec).ok()?,
        u32::try_from(nsec).ok()?,
    )
    .ok()?;
    let offset = UtcOffset::from_whole_seconds(i32::try_from(offset).ok()?).ok()?;
    Some(PrimitiveDateTime::new(date, time).assume_offset(offset))
}

/// Go `time.Time{}`(0001-01-01T00:00:00Z).
pub fn zero_time() -> OffsetDateTime {
    ::time::macros::datetime!(0001-01-01 0:00 UTC)
}

/// Go `Time.MarshalJSON` 의 범위 검사. 맞으면 RFC3339Nano 문자열.
fn marshal_text(t: OffsetDateTime) -> Result<String, String> {
    if !(0..=9999).contains(&t.year()) {
        return Err("year outside of range [0,9999]".to_owned());
    }
    if t.offset().whole_seconds().unsigned_abs() / 3600 >= 24 {
        return Err("timezone hour outside of range [0,23]".to_owned());
    }
    Ok(format_rfc3339_nano(t))
}

crate::go_type!(GoTimeType = "time.Time");

/// Go `time.Time` 필드: `#[serde(with = "otter_gocompat::time::json_time")]`.
/// 인코딩은 RFC3339Nano(값의 오프셋 그대로), 디코딩은 `time.Parse(RFC3339)` 와 같고 `null` 은 0 시각이다.
/// Go 는 `omitempty` 로 `time.Time` 을 빼지 않으므로 `skip_serializing_if` 를 달지 않는다.
pub mod json_time {
    use ::time::OffsetDateTime;
    use serde::{Deserializer, Serializer};

    pub fn serialize<S: Serializer>(t: &OffsetDateTime, s: S) -> Result<S::Ok, S::Error> {
        match super::marshal_text(*t) {
            Ok(text) => s.serialize_str(&text),
            Err(e) => Err(serde::ser::Error::custom(format!(
                "json: error calling MarshalJSON for type *time.Time: {e}"
            ))),
        }
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<OffsetDateTime, D::Error> {
        let text: Option<String> =
            crate::json::with_go_type::<super::GoTimeType, Option<String>, D>(d)?;
        match text {
            None => Ok(super::zero_time()),
            Some(s) => super::parse_rfc3339(&s).map_err(serde::de::Error::custom),
        }
    }
}

/// Go `*time.Time` 필드: `Option<OffsetDateTime>` 에 `#[serde(with = "otter_gocompat::time::json_time_opt")]`.
/// `None` 은 `null`(빼려면 `skip_serializing_if = "Option::is_none"`).
pub mod json_time_opt {
    use ::time::OffsetDateTime;
    use serde::{Deserializer, Serializer};

    pub fn serialize<S: Serializer>(t: &Option<OffsetDateTime>, s: S) -> Result<S::Ok, S::Error> {
        match t {
            Some(t) => super::json_time::serialize(t, s),
            None => s.serialize_none(),
        }
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(
        d: D,
    ) -> Result<Option<OffsetDateTime>, D::Error> {
        let text: Option<String> =
            crate::json::with_go_type::<super::GoTimeType, Option<String>, D>(d)?;
        match text {
            None => Ok(None),
            Some(s) => super::parse_rfc3339(&s)
                .map(Some)
                .map_err(serde::de::Error::custom),
        }
    }
}

/// Go `time.Time` 값. 기본값이 Go 의 0 시각이라 `#[serde(default)]` 구조체에 그대로 쓸 수 있다.
/// JSON 형식은 [`json_time`] 과 같다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct GoTime(pub OffsetDateTime);

impl Default for GoTime {
    fn default() -> Self {
        Self(zero_time())
    }
}

impl GoTime {
    /// Go `t.IsZero()`.
    pub fn is_zero(&self) -> bool {
        self.0 == zero_time()
    }
}

impl serde::Serialize for GoTime {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        json_time::serialize(&self.0, s)
    }
}

impl<'de> serde::Deserialize<'de> for GoTime {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        json_time::deserialize(d).map(Self)
    }
}
