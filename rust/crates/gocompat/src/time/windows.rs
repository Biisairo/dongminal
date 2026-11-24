//! Go `initLocal`(zoneinfo_windows.go) 의 `GetTimeZoneInformation` 호출.

use windows_sys::Win32::System::Time::{GetTimeZoneInformation, TIME_ZONE_INFORMATION};

use super::zone::Zone;
use super::zone::tzi::{Tzi, TziDate, local_from_tzi};

/// `GetTimeZoneInformation` 의 실패 값.
const TIME_ZONE_ID_INVALID: u32 = 0xFFFF_FFFF;

fn date(t: &windows_sys::Win32::Foundation::SYSTEMTIME) -> TziDate {
    TziDate {
        month: t.wMonth,
        day_of_week: t.wDayOfWeek,
        day: t.wDay,
        hour: t.wHour,
        minute: t.wMinute,
        second: t.wSecond,
    }
}

/// Go `syscall.UTF16ToString`: 첫 NUL 앞까지.
fn utf16_to_string(s: &[u16]) -> String {
    let end = s.iter().position(|&c| c == 0).unwrap_or(s.len());
    String::from_utf16_lossy(&s[..end])
}

/// 실패하면 Go 처럼 UTC 다.
pub(super) fn local() -> Zone {
    // SAFETY: TIME_ZONE_INFORMATION 은 정수·배열만 담는 C 구조체라 0 으로 채운 값이 유효하다.
    let mut i: TIME_ZONE_INFORMATION = unsafe { std::mem::zeroed() };
    // SAFETY: i 는 살아 있는 TIME_ZONE_INFORMATION 이고, 함수는 그 크기만큼만 쓴다.
    if unsafe { GetTimeZoneInformation(&mut i) } == TIME_ZONE_ID_INVALID {
        return Zone::utc();
    }
    let tzi = Tzi {
        bias: i.Bias,
        standard_bias: i.StandardBias,
        daylight_bias: i.DaylightBias,
        standard_date: date(&i.StandardDate),
        daylight_date: date(&i.DaylightDate),
        standard_name: utf16_to_string(&i.StandardName),
        daylight_name: utf16_to_string(&i.DaylightName),
    };
    local_from_tzi(&tzi, i64::from(::time::OffsetDateTime::now_utc().year()))
}
