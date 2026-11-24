//! Go `net/netip`·`net/url` 규칙의 표. 기대값은 go1.27.2 로 뽑았다.

use crate::netx::{parse_addr, parse_prefix};
use crate::reqgate::{normalize_host, same_authority};

#[test]
fn normalize_host_matches_go() {
    let cases: &[(&str, &str)] = &[
        ("localhost", "localhost"),
        ("localhost:58146", "localhost"),
        ("[::1]:58146", "::1"),
        ("[::1]", "::1"),
        ("::1", "::1"),
        ("127.0.0.1:9999", "127.0.0.1"),
        ("MACMINI-OFFICE.", "macmini-office"),
        ("macmini-office:9999", "macmini-office"),
        ("http://localhost:3000", "localhost"),
        ("https://x.tail.ts.net", "x.tail.ts.net"),
        ("null", "null"),
        ("file://", ""),
        ("chrome-extension://abc", "abc"),
        ("http://%zz", ""),
        ("http://[::1]:58146", "::1"),
        ("http://user@host:1", "host"),
        ("http://host:abc", ""),
        ("http://[fe80::1%25en0]:80", "fe80::1%en0"),
        ("http://a b", ""),
        ("  http://Foo.Example.  ", "foo.example"),
        ("http://[1.2.3.4]:80", ""),
        ("http://[::1", ""),
        ("ftp://h:21", "h"),
        ("http://h:", "h"),
        ("http://h/p?x#f", "h"),
        ("http://h#%zz", ""),
        ("1.2.3.4:5:6", "1.2.3.4:5:6"),
        ("[::1]:x", "::1"),
        ("http://é.com", "é.com"),
        ("http://h_x", "h_x"),
        ("http://h%41", ""),
    ];
    for (raw, want) in cases {
        assert_eq!(normalize_host(raw), *want, "normalize_host({raw:?})");
    }
}

#[test]
fn same_authority_matches_go() {
    let cases: &[(&str, &str, bool)] = &[
        ("http://localhost:58146", "localhost:58146", true),
        ("http://localhost:3000", "localhost:58146", false),
        ("http://localhost", "localhost:58146", false),
        ("http://[::1]:58146", "[::1]:58146", true),
        ("http://localhost:58146", "LOCALHOST:58146", true),
        ("http://localhost:58146", "localhost.:58146", true),
        ("https://x.tail.ts.net", "x.tail.ts.net", true),
        ("http://127.0.0.1:58146", "localhost:58146", false),
        ("http://localhost:58146", "", false),
        ("ws://localhost:58146", "localhost:58146", false),
        ("http://h:", "h:", true),
        ("http://h", "h:", true),
        ("HTTP://h:1", "h:1", true),
        ("http://[::1]", "::1", true),
    ];
    for (origin, host, want) in cases {
        assert_eq!(
            same_authority(origin, host),
            *want,
            "same_authority({origin:?}, {host:?})"
        );
    }
}

#[test]
fn parse_addr_matches_go() {
    let cases: &[(&str, &str)] = &[
        ("1.2.3.4", "1.2.3.4|1.2.3.4"),
        ("01.2.3.4", ""),
        ("1.2.3", ""),
        ("::1", "::1|::1"),
        ("::ffff:1.2.3.4", "::ffff:1.2.3.4|1.2.3.4"),
        ("fe80::1%en0", "fe80::1%en0|fe80::1%en0"),
        ("fe80::1%", ""),
        ("1.2.3.4%en0", ""),
        ("%en0", ""),
        ("abc", ""),
        ("256.1.1.1", ""),
        ("::ffff:01.2.3.4", ""),
        ("1:2:3:4:5:6:7:8:9", ""),
        ("2001:db8::", "2001:db8::|2001:db8::"),
        ("::1.2.3.4", "::102:304|::102:304"),
    ];
    for (raw, want) in cases {
        let got = parse_addr(raw)
            .map(|a| format!("{a}|{}", a.unmap()))
            .unwrap_or_default();
        assert_eq!(got, *want, "parse_addr({raw:?})");
    }
}

#[test]
fn parse_prefix_matches_go() {
    let cases: &[(&str, bool)] = &[
        ("10.0.0.0/8", true),
        ("10.0.0.1/8", true),
        ("10.0.0.0/08", false),
        ("10.0.0.0/33", false),
        ("10.0.0.0/", false),
        ("10.0.0.0/+8", false),
        ("fd00::/8", true),
        ("fe80::1%en0/64", false),
        ("::ffff:10.0.0.0/104", true),
        ("10.0.0.0/0", true),
        ("1.2.3.4/32", true),
        ("x/8", false),
        ("10.0.0.0/-1", false),
    ];
    for (raw, want) in cases {
        assert_eq!(parse_prefix(raw).is_some(), *want, "parse_prefix({raw:?})");
    }
}

#[test]
fn prefix_contains_follows_family_and_zone() {
    let p = parse_prefix("10.0.0.0/8").unwrap();
    assert!(p.contains(&parse_addr("10.200.0.1").unwrap()));
    assert!(!p.contains(&parse_addr("11.0.0.1").unwrap()));
    assert!(!p.contains(&parse_addr("::ffff:10.0.0.1").unwrap()));
    let v6 = parse_prefix("fd00::/8").unwrap();
    assert!(v6.contains(&parse_addr("fd00::42").unwrap()));
    assert!(!v6.contains(&parse_addr("fd00::42%en0").unwrap()));
    assert!(
        parse_prefix("0.0.0.0/0")
            .unwrap()
            .contains(&parse_addr("1.2.3.4").unwrap())
    );
}
