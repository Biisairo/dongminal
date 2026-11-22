//! 1.1(dm-gocompat)의 인용·로컬 시각이 공개되기 전까지 쓰는 임시 구현.
//! 1.4.1 review 전에 gocompat 으로 바꾼다 (이슈 1.4.1 진행 기록).

/// 줄에 찍는 시각. 오프셋은 UTC 기준 초다.
#[derive(Clone, Copy, Debug)]
pub(crate) struct LocalTime {
    pub year: i32,
    pub month: u8,
    pub day: u8,
    pub hour: u8,
    pub minute: u8,
    pub second: u8,
    pub nanos: u32,
    pub offset_secs: i32,
}

impl LocalTime {
    /// Go `2006-01-02T15:04:05.000Z07:00` (밀리초에서 자른다).
    pub fn rfc3339_millis(&self) -> String {
        let zone = if self.offset_secs == 0 {
            "Z".to_owned()
        } else {
            let sign = if self.offset_secs < 0 { '-' } else { '+' };
            let m = self.offset_secs.unsigned_abs() / 60;
            format!("{sign}{:02}:{:02}", m / 60, m % 60)
        };
        format!(
            "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}{zone}",
            self.year,
            self.month,
            self.day,
            self.hour,
            self.minute,
            self.second,
            self.nanos / 1_000_000
        )
    }

    /// Go 표준 `log` 의 LstdFlags 머리 `2006/01/02 15:04:05`.
    pub fn std_log_stamp(&self) -> String {
        format!(
            "{:04}/{:02}/{:02} {:02}:{:02}:{:02}",
            self.year, self.month, self.day, self.hour, self.minute, self.second
        )
    }
}

pub(crate) fn now() -> LocalTime {
    let t = time::OffsetDateTime::now_utc();
    LocalTime {
        year: t.year(),
        month: t.month().into(),
        day: t.day(),
        hour: t.hour(),
        minute: t.minute(),
        second: t.second(),
        nanos: t.nanosecond(),
        offset_secs: 0,
    }
}

pub(crate) fn is_print(c: char) -> bool {
    !c.is_control()
}

pub(crate) fn quote(s: &str) -> String {
    format!("{s:?}")
}
