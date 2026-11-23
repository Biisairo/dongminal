//! Go `time.Location` 의 관측 동작: TZif 파일 해석, 시각별 오프셋 조회, `Local` 결정 규칙.

use std::sync::OnceLock;

const SECONDS_PER_MINUTE: i64 = 60;
const SECONDS_PER_HOUR: i64 = 60 * SECONDS_PER_MINUTE;
const SECONDS_PER_DAY: i64 = 24 * SECONDS_PER_HOUR;
const ALPHA: i64 = i64::MIN;

/// Go `platformZoneSources` (zoneinfo_unix.go).
pub const PLATFORM_ZONE_SOURCES: &[&str] = &[
    "/usr/share/zoneinfo/",
    "/usr/share/lib/zoneinfo/",
    "/usr/lib/locale/TZ/",
    "/etc/zoneinfo",
];

#[derive(Debug, Clone, PartialEq, Eq)]
struct ZoneEntry {
    name: String,
    offset: i32,
    is_dst: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Trans {
    when: i64,
    index: u8,
}

/// 한 시각에서의 시간대 정보.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ZoneInfo {
    pub name: String,
    /// UTC 동쪽으로의 초.
    pub offset: i32,
    pub is_dst: bool,
}

/// Go `*time.Location`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Zone {
    name: String,
    zones: Vec<ZoneEntry>,
    tx: Vec<Trans>,
    extend: String,
}

impl Zone {
    /// Go `time.UTC`.
    pub fn utc() -> Self {
        Self {
            name: "UTC".to_owned(),
            zones: Vec::new(),
            tx: Vec::new(),
            extend: String::new(),
        }
    }

    /// Go `time.FixedZone`.
    pub fn fixed(name: &str, offset: i32) -> Self {
        Self {
            name: name.to_owned(),
            zones: vec![ZoneEntry {
                name: name.to_owned(),
                offset,
                is_dst: false,
            }],
            tx: vec![Trans {
                when: ALPHA,
                index: 0,
            }],
            extend: String::new(),
        }
    }

    /// Go `Location.String()`.
    pub fn name(&self) -> &str {
        &self.name
    }

    /// Go `time.LoadLocationFromTZData`. 형식이 틀리면 `None`.
    pub fn from_tzif(name: &str, data: &[u8]) -> Option<Self> {
        parse_tzif(name, data)
    }

    /// Go `Location.lookup`: 유닉스 초 `sec` 에서의 이름·오프셋·DST 여부.
    pub fn lookup(&self, sec: i64) -> ZoneInfo {
        if self.zones.is_empty() {
            return ZoneInfo {
                name: "UTC".to_owned(),
                offset: 0,
                is_dst: false,
            };
        }
        if self.tx.is_empty() || sec < self.tx[0].when {
            return self.zones[self.lookup_first_zone()].info();
        }
        let lo = self.tx.partition_point(|t| t.when <= sec) - 1;
        let zone = &self.zones[usize::from(self.tx[lo].index)];
        if lo == self.tx.len() - 1
            && !self.extend.is_empty()
            && let Some(info) = tzset(&self.extend, sec)
        {
            return info;
        }
        zone.info()
    }

    /// `sec` 에서의 오프셋(초).
    pub fn offset_at(&self, sec: i64) -> i32 {
        self.lookup(sec).offset
    }

    fn lookup_first_zone(&self) -> usize {
        if !self.tx.iter().any(|t| t.index == 0) {
            return 0;
        }
        if let Some(first) = self.tx.first() {
            let fi = usize::from(first.index);
            if self.zones[fi].is_dst
                && let Some(zi) = (0..fi).rev().find(|&zi| !self.zones[zi].is_dst)
            {
                return zi;
            }
        }
        self.zones.iter().position(|z| !z.is_dst).unwrap_or(0)
    }
}

impl ZoneEntry {
    fn info(&self) -> ZoneInfo {
        ZoneInfo {
            name: self.name.clone(),
            offset: self.offset,
            is_dst: self.is_dst,
        }
    }
}

struct Reader<'a> {
    data: &'a [u8],
    failed: bool,
}

impl<'a> Reader<'a> {
    fn read(&mut self, n: usize) -> &'a [u8] {
        if self.data.len() < n {
            self.data = &[];
            self.failed = true;
            return &[];
        }
        let (head, tail) = self.data.split_at(n);
        self.data = tail;
        head
    }

    fn big4(&mut self) -> Option<u32> {
        let p = self.read(4);
        <[u8; 4]>::try_from(p).ok().map(u32::from_be_bytes)
    }

    fn big8(&mut self) -> Option<u64> {
        let p = self.read(8);
        <[u8; 8]>::try_from(p).ok().map(u64::from_be_bytes)
    }

    fn byte(&mut self) -> Option<u8> {
        self.read(1).first().copied()
    }
}

fn parse_tzif(name: &str, data: &[u8]) -> Option<Zone> {
    const N_UTC_LOCAL: usize = 0;
    const N_STD_WALL: usize = 1;
    const N_LEAP: usize = 2;
    const N_TIME: usize = 3;
    const N_ZONE: usize = 4;
    const N_CHAR: usize = 5;

    let mut d = Reader {
        data,
        failed: false,
    };
    if d.read(4) != b"TZif" {
        return None;
    }
    let p = d.read(16);
    let version = match p.first()? {
        0 => 1,
        b'2' => 2,
        b'3' => 3,
        _ => return None,
    };
    let mut n = [0usize; 6];
    for v in &mut n {
        *v = usize::try_from(d.big4()?).ok()?;
    }
    let mut is64 = false;
    if version > 1 {
        let skip = n[N_TIME] * 4
            + n[N_TIME]
            + n[N_ZONE] * 6
            + n[N_CHAR]
            + n[N_LEAP] * 8
            + n[N_STD_WALL]
            + n[N_UTC_LOCAL]
            + 4
            + 16;
        d.read(skip);
        is64 = true;
        for v in &mut n {
            *v = usize::try_from(d.big4()?).ok()?;
        }
    }
    let size = if is64 { 8 } else { 4 };
    let mut txtimes = Reader {
        data: d.read(n[N_TIME] * size),
        failed: false,
    };
    let txzones = d.read(n[N_TIME]);
    let mut zonedata = Reader {
        data: d.read(n[N_ZONE] * 6),
        failed: false,
    };
    let abbrev = d.read(n[N_CHAR]);
    d.read(n[N_LEAP] * (size + 4));
    d.read(n[N_STD_WALL]);
    d.read(n[N_UTC_LOCAL]);
    if d.failed {
        return None;
    }
    let rest = d.data;
    let extend = if rest.len() > 2 && rest[0] == b'\n' && rest[rest.len() - 1] == b'\n' {
        String::from_utf8_lossy(&rest[1..rest.len() - 1]).into_owned()
    } else {
        String::new()
    };

    if n[N_ZONE] == 0 {
        return None;
    }
    let mut zones = Vec::with_capacity(n[N_ZONE]);
    for _ in 0..n[N_ZONE] {
        let off = zonedata.big4()?;
        let is_dst = zonedata.byte()? != 0;
        let b = usize::from(zonedata.byte()?);
        if b >= abbrev.len() {
            return None;
        }
        let tail = &abbrev[b..];
        let end = tail.iter().position(|&c| c == 0).unwrap_or(tail.len());
        zones.push(ZoneEntry {
            name: String::from_utf8_lossy(&tail[..end]).into_owned(),
            // Go: int(int32(n)) — 비트를 그대로 부호 있는 값으로 읽는다.
            offset: off as i32,
            is_dst,
        });
    }

    let mut tx = Vec::with_capacity(n[N_TIME]);
    for &index in txzones {
        let when = if is64 {
            txtimes.big8()? as i64
        } else {
            i64::from(txtimes.big4()? as i32)
        };
        if usize::from(index) >= zones.len() {
            return None;
        }
        tx.push(Trans { when, index });
    }
    if tx.is_empty() {
        tx.push(Trans {
            when: ALPHA,
            index: 0,
        });
    }
    Some(Zone {
        name: name.to_owned(),
        zones,
        tx,
        extend,
    })
}

#[derive(Debug, Clone, Copy)]
enum RuleKind {
    Julian,
    Doy,
    MonthWeekDay,
}

#[derive(Debug, Clone, Copy)]
struct Rule {
    kind: RuleKind,
    day: i64,
    week: i64,
    mon: i64,
    time: i64,
}

/// Go `tzset`: POSIX TZ 문자열로 `sec` 의 시간대를 구한다. 해석할 수 없으면 `None`.
fn tzset(s: &str, sec: i64) -> Option<ZoneInfo> {
    let (mut std_name, s) = tzset_name(s)?;
    let (std_off, s) = tzset_offset(s)?;
    let mut std_offset = -std_off;
    if s.is_empty() || s.starts_with(',') {
        return Some(ZoneInfo {
            name: std_name.to_owned(),
            offset: i32::try_from(std_offset).ok()?,
            is_dst: false,
        });
    }
    let (mut dst_name, mut s) = tzset_name(s)?;
    let mut dst_offset;
    if s.is_empty() || s.starts_with(',') {
        dst_offset = std_offset + SECONDS_PER_HOUR;
    } else {
        let (off, rest) = tzset_offset(s)?;
        dst_offset = -off;
        s = rest;
    }
    if s.is_empty() {
        s = ",M3.2.0,M11.1.0";
    }
    if !s.starts_with(',') && !s.starts_with(';') {
        return None;
    }
    let (start_rule, s) = tzset_rule(&s[1..])?;
    let s = s.strip_prefix(',')?;
    let (end_rule, s) = tzset_rule(s)?;
    if !s.is_empty() {
        return None;
    }

    let utc = ::time::OffsetDateTime::from_unix_timestamp(sec).ok()?;
    let year = i64::from(utc.year());
    let yday = i64::from(utc.ordinal());
    let ysec = (yday - 1) * SECONDS_PER_DAY + sec % SECONDS_PER_DAY;

    let mut start_sec = tzrule_time(year, start_rule, std_offset);
    let mut end_sec = tzrule_time(year, end_rule, dst_offset);
    let (mut dst_is_dst, mut std_is_dst) = (true, false);
    if end_sec < start_sec {
        std::mem::swap(&mut start_sec, &mut end_sec);
        std::mem::swap(&mut std_name, &mut dst_name);
        std::mem::swap(&mut std_offset, &mut dst_offset);
        std::mem::swap(&mut std_is_dst, &mut dst_is_dst);
    }
    let (name, offset, is_dst) = if ysec < start_sec || ysec >= end_sec {
        (std_name, std_offset, std_is_dst)
    } else {
        (dst_name, dst_offset, dst_is_dst)
    };
    Some(ZoneInfo {
        name: name.to_owned(),
        offset: i32::try_from(offset).ok()?,
        is_dst,
    })
}

fn tzset_name(s: &str) -> Option<(&str, &str)> {
    if s.is_empty() {
        return None;
    }
    if let Some(quoted) = s.strip_prefix('<') {
        let i = quoted.find('>')?;
        return Some((&quoted[..i], &quoted[i + 1..]));
    }
    for (i, c) in s.char_indices() {
        if c.is_ascii_digit() || matches!(c, ',' | '-' | '+') {
            if i < 3 {
                return None;
            }
            return Some((&s[..i], &s[i..]));
        }
    }
    if s.len() < 3 {
        return None;
    }
    Some((s, ""))
}

fn tzset_offset(s: &str) -> Option<(i64, &str)> {
    if s.is_empty() {
        return None;
    }
    let (neg, s) = if let Some(r) = s.strip_prefix('+') {
        (false, r)
    } else if let Some(r) = s.strip_prefix('-') {
        (true, r)
    } else {
        (false, s)
    };
    let sign = if neg { -1 } else { 1 };
    let (hours, s) = tzset_num(s, 0, 24 * 7)?;
    let mut off = hours * SECONDS_PER_HOUR;
    let Some(s) = s.strip_prefix(':') else {
        return Some((sign * off, s));
    };
    let (mins, s) = tzset_num(s, 0, 59)?;
    off += mins * SECONDS_PER_MINUTE;
    let Some(s) = s.strip_prefix(':') else {
        return Some((sign * off, s));
    };
    let (secs, s) = tzset_num(s, 0, 59)?;
    off += secs;
    Some((sign * off, s))
}

fn tzset_rule(s: &str) -> Option<(Rule, &str)> {
    let mut r = Rule {
        kind: RuleKind::Doy,
        day: 0,
        week: 0,
        mon: 0,
        time: 0,
    };
    let s = if let Some(rest) = s.strip_prefix('J') {
        let (jday, rest) = tzset_num(rest, 1, 365)?;
        r.kind = RuleKind::Julian;
        r.day = jday;
        rest
    } else if let Some(rest) = s.strip_prefix('M') {
        let (mon, rest) = tzset_num(rest, 1, 12)?;
        let rest = rest.strip_prefix('.')?;
        let (week, rest) = tzset_num(rest, 1, 5)?;
        let rest = rest.strip_prefix('.')?;
        let (day, rest) = tzset_num(rest, 0, 6)?;
        r.kind = RuleKind::MonthWeekDay;
        r.day = day;
        r.week = week;
        r.mon = mon;
        rest
    } else {
        let (day, rest) = tzset_num(s, 0, 365)?;
        r.day = day;
        rest
    };
    let Some(rest) = s.strip_prefix('/') else {
        r.time = 2 * SECONDS_PER_HOUR;
        return Some((r, s));
    };
    let (offset, rest) = tzset_offset(rest)?;
    r.time = offset;
    Some((r, rest))
}

fn tzset_num(s: &str, min: i64, max: i64) -> Option<(i64, &str)> {
    if s.is_empty() {
        return None;
    }
    let mut num = 0i64;
    for (i, c) in s.char_indices() {
        let Some(d) = c.to_digit(10) else {
            if i == 0 || num < min {
                return None;
            }
            return Some((num, &s[i..]));
        };
        num = num * 10 + i64::from(d);
        if num > max {
            return None;
        }
    }
    if num < min {
        return None;
    }
    Some((num, ""))
}

fn is_leap(year: i64) -> bool {
    year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)
}

const DAYS_BEFORE: [i64; 13] = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334, 365];

fn days_in(mon: i64, year: i64) -> i64 {
    if mon == 2 && is_leap(year) {
        return 29;
    }
    // mon 은 tzset_num 이 1..=12 로 막았다.
    let m = mon as usize;
    DAYS_BEFORE[m] - DAYS_BEFORE[m - 1]
}

fn tzrule_time(year: i64, r: Rule, off: i64) -> i64 {
    let s = match r.kind {
        RuleKind::Julian => {
            let mut s = (r.day - 1) * SECONDS_PER_DAY;
            if is_leap(year) && r.day >= 60 {
                s += SECONDS_PER_DAY;
            }
            s
        }
        RuleKind::Doy => r.day * SECONDS_PER_DAY,
        RuleKind::MonthWeekDay => {
            let m1 = (r.mon + 9) % 12 + 1;
            let mut yy0 = year;
            if r.mon <= 2 {
                yy0 -= 1;
            }
            let yy1 = yy0 / 100;
            let yy2 = yy0 % 100;
            let mut dow = ((26 * m1 - 2) / 10 + 1 + yy2 + yy2 / 4 + yy1 / 4 - 2 * yy1) % 7;
            if dow < 0 {
                dow += 7;
            }
            let mut d = r.day - dow;
            if d < 0 {
                d += 7;
            }
            for _ in 1..r.week {
                if d + 7 >= days_in(r.mon, year) {
                    break;
                }
                d += 7;
            }
            // r.mon 은 1..=12 다.
            d += DAYS_BEFORE[(r.mon - 1) as usize];
            if is_leap(year) && r.mon > 2 {
                d += 1;
            }
            d * SECONDS_PER_DAY
        }
    };
    s + r.time - off
}

/// Go `initLocal`(zoneinfo_unix.go) 의 결정 규칙. `tz` 는 `TZ` 환경변수(없으면 `None`),
/// `read` 는 파일을 읽는 함수다.
pub fn resolve_local(tz: Option<&str>, read: impl Fn(&str) -> Option<Vec<u8>>) -> Zone {
    let load = |name: &str, sources: &[&str]| -> Option<Zone> {
        sources.iter().find_map(|dir| {
            let path = if dir.is_empty() {
                name.to_owned()
            } else {
                format!("{dir}/{name}")
            };
            read(&path).and_then(|data| Zone::from_tzif(name, &data))
        })
    };
    match tz {
        None => {
            if let Some(mut z) = load("localtime", &["/etc"]) {
                z.name = "Local".to_owned();
                return z;
            }
        }
        Some(tz) if !tz.is_empty() => {
            let tz = tz.strip_prefix(':').unwrap_or(tz);
            if tz.starts_with('/') {
                if let Some(mut z) = load(tz, &[""]) {
                    z.name = if tz == "/etc/localtime" {
                        "Local".to_owned()
                    } else {
                        tz.to_owned()
                    };
                    return z;
                }
            } else if !tz.is_empty()
                && tz != "UTC"
                && let Some(z) = load(tz, PLATFORM_ZONE_SOURCES)
            {
                return z;
            }
        }
        Some(_) => {}
    }
    Zone::utc()
}

#[cfg(any(windows, test))]
#[path = "tzi.rs"]
pub(crate) mod tzi;

static LOCAL: OnceLock<Zone> = OnceLock::new();

/// Go `time.Local`. 처음 부를 때 한 번 정한다. unix 는 Go 와 같은 규칙으로 `TZ` 와
/// zoneinfo 파일을 읽는다. Windows 는 Go 와 같이
/// `GetTimeZoneInformation` 의 규칙으로 만든다(zoneinfo_windows.go).
pub fn local() -> &'static Zone {
    LOCAL.get_or_init(|| {
        #[cfg(unix)]
        {
            let tz = std::env::var("TZ").ok();
            resolve_local(tz.as_deref(), |p| std::fs::read(p).ok())
        }
        #[cfg(windows)]
        {
            super::windows::local()
        }
        #[cfg(not(any(unix, windows)))]
        {
            Zone::utc()
        }
    })
}
