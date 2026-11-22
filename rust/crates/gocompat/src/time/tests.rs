use super::{
    Zone, format_log_std, format_rfc3339, format_rfc3339_millis, format_rfc3339_nano,
    resolve_local, to_zone,
};
use ::time::{OffsetDateTime, UtcOffset};
use std::path::PathBuf;

fn testdata(rel: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("testdata")
        .join(rel)
}

// testdata/go_time_format.txt: go1.27.2 의 t.In(FixedZone).Format(RFC3339 | ".000" | RFC3339Nano).
#[test]
fn formats_match_go() {
    let data = std::fs::read_to_string(testdata("go_time_format.txt")).expect("golden");
    let mut n = 0;
    for line in data.lines() {
        let cols: Vec<&str> = line.split('\t').collect();
        let nums: Vec<i64> = cols[0]
            .split(' ')
            .map(|v| v.parse().expect("num"))
            .collect();
        let (sec, nsec, off) = (nums[0], nums[1], nums[2]);
        let t = OffsetDateTime::from_unix_timestamp_nanos(
            i128::from(sec) * 1_000_000_000 + i128::from(nsec),
        )
        .expect("in range");
        let Ok(offset) = UtcOffset::from_whole_seconds(i32::try_from(off).expect("i32")) else {
            // time crate 의 범위(±25:59:59)를 넘는 오프셋은 이 crate 가 다룰 수 없다.
            continue;
        };
        let Some(t) = t.checked_to_offset(offset) else {
            continue;
        };
        assert_eq!(format_rfc3339(t), cols[1], "{line}");
        assert_eq!(format_rfc3339_millis(t), cols[2], "{line}");
        assert_eq!(format_rfc3339_nano(t), cols[3], "{line}");
        n += 1;
    }
    assert!(n > 400, "checked {n}");
}

// testdata/go_zone_lookup.txt: go1.27.2 의 LoadLocationFromTZData + time.Unix(s).In(loc).Zone()/IsDST().
#[test]
fn zone_lookup_matches_go() {
    let data = std::fs::read_to_string(testdata("go_zone_lookup.txt")).expect("golden");
    let mut n = 0;
    for line in data.lines() {
        let cols: Vec<&str> = line.split(' ').collect();
        let file = cols[0];
        let raw = std::fs::read(testdata(&format!("zoneinfo/{file}"))).expect("tzif");
        let zone = Zone::from_tzif(file, &raw).expect("parse");
        let sec: i64 = cols[1].parse().expect("sec");
        let info = zone.lookup(sec);
        assert_eq!(info.name, cols[2], "{line}");
        assert_eq!(info.offset.to_string(), cols[3], "{line}");
        assert_eq!(info.is_dst.to_string(), cols[4], "{line}");
        n += 1;
    }
    assert!(n > 150, "checked {n}");
}

#[test]
fn from_tzif_rejects_bad_data() {
    assert!(Zone::from_tzif("x", b"").is_none());
    assert!(Zone::from_tzif("x", b"TZif").is_none());
    assert!(Zone::from_tzif("x", b"TZifX000000000000000").is_none());
    let raw = std::fs::read(testdata("zoneinfo/Asia_Seoul")).expect("tzif");
    assert!(Zone::from_tzif("x", &raw[..raw.len() / 2]).is_none());
}

#[test]
fn utc_and_fixed() {
    let utc = Zone::utc();
    assert_eq!(utc.name(), "UTC");
    assert_eq!(utc.lookup(1_700_000_000).name, "UTC");
    assert_eq!(utc.offset_at(1_700_000_000), 0);
    let kst = Zone::fixed("KST", 9 * 3600);
    assert_eq!(kst.offset_at(-5_000_000_000), 9 * 3600);
    let t = OffsetDateTime::from_unix_timestamp(1_700_000_000).expect("t");
    assert_eq!(
        format_rfc3339_millis(to_zone(t, &kst)),
        "2023-11-15T07:13:20.000+09:00"
    );
    assert_eq!(format_log_std(to_zone(t, &kst)), "2023/11/15 07:13:20");
    let early = OffsetDateTime::from_unix_timestamp(-62_135_596_800).expect("t");
    assert_eq!(format_log_std(early), "0001/01/01 00:00:00");
}

fn reader(files: &[(&str, &str)]) -> impl Fn(&str) -> Option<Vec<u8>> {
    let map: Vec<(String, Vec<u8>)> = files
        .iter()
        .map(|(path, fixture)| {
            (
                (*path).to_owned(),
                std::fs::read(testdata(&format!("zoneinfo/{fixture}"))).expect("tzif"),
            )
        })
        .collect();
    move |p: &str| map.iter().find(|(k, _)| k == p).map(|(_, v)| v.clone())
}

// Go initLocal(zoneinfo_unix.go) 의 TZ 규칙.
#[test]
fn resolve_local_follows_go_tz_rules() {
    let read = reader(&[
        ("/etc/localtime", "Asia_Seoul"),
        ("/usr/share/zoneinfo//America/New_York", "America_New_York"),
        ("/etc/zoneinfo/Europe/Dublin", "Europe_Dublin"),
        ("/opt/tz/lh", "Australia_Lord_Howe"),
    ]);
    let sec = 1_700_000_000;

    let z = resolve_local(None, &read);
    assert_eq!((z.name(), z.offset_at(sec)), ("Local", 9 * 3600));

    let z = resolve_local(Some(""), &read);
    assert_eq!((z.name(), z.offset_at(sec)), ("UTC", 0));

    let z = resolve_local(Some("UTC"), &read);
    assert_eq!((z.name(), z.offset_at(sec)), ("UTC", 0));

    let z = resolve_local(Some(":"), &read);
    assert_eq!((z.name(), z.offset_at(sec)), ("UTC", 0));

    let z = resolve_local(Some("America/New_York"), &read);
    assert_eq!(
        (z.name(), z.offset_at(sec)),
        ("America/New_York", -5 * 3600)
    );

    let z = resolve_local(Some(":America/New_York"), &read);
    assert_eq!(z.name(), "America/New_York");

    let z = resolve_local(Some("Europe/Dublin"), &read);
    assert_eq!(z.name(), "Europe/Dublin");

    let z = resolve_local(Some("/etc/localtime"), &read);
    assert_eq!(z.name(), "Local");

    let z = resolve_local(Some(":/opt/tz/lh"), &read);
    assert_eq!((z.name(), z.offset_at(sec)), ("/opt/tz/lh", 11 * 3600));

    let z = resolve_local(Some("No/Such_Zone"), &read);
    assert_eq!((z.name(), z.offset_at(sec)), ("UTC", 0));

    let empty = |_: &str| None;
    let z = resolve_local(None, empty);
    assert_eq!((z.name(), z.offset_at(sec)), ("UTC", 0));
}

#[test]
fn duration_string_matches_go() {
    let g = crate::testutil::golden("go_encode.txt");
    let durs: [i64; 18] = [
        0,
        1,
        999,
        1000,
        1500,
        1_000_000,
        1_500_000,
        1_000_000_000,
        1_500_000_000,
        90_000_000_000,
        3_600_000_000_000,
        26 * 3_600_000_000_000 + 3 * 60_000_000_000 + 4_000_000_000 + 5,
        -1_000_000_000,
        -1,
        i64::MAX,
        i64::MIN,
        100_000_000,
        120_000_000_000,
    ];
    for d in durs {
        let want = crate::testutil::golden_str(&g, &format!("dur_{d}"));
        assert_eq!(super::format_duration(d), want, "{d}");
    }
    assert_eq!(
        super::format_std_duration(std::time::Duration::from_millis(1500)),
        "1.5s"
    );
}
