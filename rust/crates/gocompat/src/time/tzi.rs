//! Go `initLocalFromTZI`(zoneinfo_windows.go): Windows `TIME_ZONE_INFORMATION` 으로 `Local` 을 만든다.

use super::{
    ALPHA, SECONDS_PER_DAY, SECONDS_PER_HOUR, SECONDS_PER_MINUTE, Trans, Zone, ZoneEntry, days_in,
};

/// Windows `SYSTEMTIME` 가운데 시간대 규칙에 쓰는 칸.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct TziDate {
    pub(crate) month: u16,
    pub(crate) day_of_week: u16,
    pub(crate) day: u16,
    pub(crate) hour: u16,
    pub(crate) minute: u16,
    pub(crate) second: u16,
}

/// Windows `TIME_ZONE_INFORMATION`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct Tzi {
    pub(crate) bias: i32,
    pub(crate) standard_bias: i32,
    pub(crate) daylight_bias: i32,
    pub(crate) standard_date: TziDate,
    pub(crate) daylight_date: TziDate,
    pub(crate) standard_name: String,
    pub(crate) daylight_name: String,
}

/// 해마다 두 번, 올해 앞뒤로 100년.
const TZI_YEARS_EACH_SIDE: i64 = 100;

/// Go `initLocalFromTZI`(zoneinfo_windows.go). `year` 는 지금의 UTC 연도다. 약어는 Go 의
/// 마지막 갈래(`extractCAPS`)로 만든다 — 약어는 이 저장소의 어떤 출력에도 나가지 않는다.
pub(crate) fn local_from_tzi(i: &Tzi, year: i64) -> Zone {
    let mut std = ZoneEntry {
        name: extract_caps(&i.standard_name),
        offset: 0,
        is_dst: false,
    };
    if i.standard_date.month == 0 {
        std.offset = bias_offset(i.bias, 0);
        return Zone {
            name: "Local".to_owned(),
            zones: vec![std],
            tx: vec![Trans {
                when: ALPHA,
                index: 0,
            }],
            extend: String::new(),
        };
    }
    std.offset = bias_offset(i.bias, i.standard_bias);
    let dst = ZoneEntry {
        name: extract_caps(&i.daylight_name),
        offset: bias_offset(i.bias, i.daylight_bias),
        is_dst: true,
    };
    let (mut d0, mut d1, mut i0, mut i1) = (&i.standard_date, &i.daylight_date, 0u8, 1u8);
    if d0.month > d1.month {
        (d0, d1, i0, i1) = (d1, d0, i1, i0);
    }
    let zones = [std, dst];
    let offset = |idx: u8| i64::from(zones[usize::from(idx)].offset);
    let mut tx = Vec::with_capacity(4 * TZI_YEARS_EACH_SIDE as usize);
    for y in year - TZI_YEARS_EACH_SIDE..year + TZI_YEARS_EACH_SIDE {
        tx.push(Trans {
            when: pseudo_unix(y, d0) - offset(i1),
            index: i0,
        });
        tx.push(Trans {
            when: pseudo_unix(y, d1) - offset(i0),
            index: i1,
        });
    }
    Zone {
        name: "Local".to_owned(),
        zones: zones.into(),
        tx,
        extend: String::new(),
    }
}

/// Go `-int(bias+extra) * 60`. 분 단위 편차를 UTC 동쪽 초로 바꾼다.
fn bias_offset(bias: i32, extra: i32) -> i32 {
    let secs = -(i64::from(bias) + i64::from(extra)) * SECONDS_PER_MINUTE;
    i32::try_from(secs).unwrap_or(0)
}

fn extract_caps(desc: &str) -> String {
    desc.chars().filter(char::is_ascii_uppercase).collect()
}

/// Go `pseudoUnix`: `d.Month` 달의 `d.Day` 번째(5 는 마지막) `d.DayOfWeek` 요일, `d` 의 시각을 UTC 로 본 초.
fn pseudo_unix(year: i64, d: &TziDate) -> i64 {
    // Go `Date` 처럼 1..=12 밖의 달을 연도로 넘긴다.
    let m0 = i64::from(d.month) - 1;
    let (year, mon) = (year + m0.div_euclid(12), m0.rem_euclid(12) + 1);
    let first = days_from_civil(year, mon, 1);
    // 1970-01-01 은 목요일(4)이다.
    let weekday = (first + 4).rem_euclid(7);
    let mut day = 1 + (i64::from(d.day_of_week) - weekday).rem_euclid(7);
    let week = i64::from(d.day) - 1;
    if week < 4 {
        day += week * 7;
    } else {
        day += 4 * 7;
        if day > days_in(mon, year) {
            day -= 7;
        }
    }
    (first + day - 1) * SECONDS_PER_DAY
        + i64::from(d.hour) * SECONDS_PER_HOUR
        + i64::from(d.minute) * SECONDS_PER_MINUTE
        + i64::from(d.second)
}

/// 1970-01-01 부터의 날 수 (proleptic Gregorian). `mon` 은 1..=12.
fn days_from_civil(year: i64, mon: i64, day: i64) -> i64 {
    let y = if mon <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (mon + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}
