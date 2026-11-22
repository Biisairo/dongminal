use super::{append_quote, is_print, quote, quote_bytes};

// Go strconv/quote_test.go 의 quotetests (Quote 열).
#[test]
fn quote_matches_go_quotetests() {
    let cases: &[(&[u8], &str)] = &[
        (b"\x07\x08\x0c\r\n\t\x0b", r#""\a\b\f\r\n\t\v""#),
        (b"\\", r#""\\""#),
        (b"abc\xffdef", r#""abc\xffdef""#),
        ("\u{263a}".as_bytes(), "\"\u{263a}\""),
        ("\u{10ffff}".as_bytes(), r#""\U0010ffff""#),
        (b"\x04", r#""\x04""#),
        (
            "!\u{a0}!\u{2000}!\u{3000}!".as_bytes(),
            "\"!\\u00a0!\\u2000!\\u3000!\"",
        ),
        (b"\x7f", r#""\x7f""#),
    ];
    for &(input, want) in cases {
        assert_eq!(quote_bytes(input), want, "input {input:?}");
        if let Ok(s) = std::str::from_utf8(input) {
            assert_eq!(quote(s), want);
            let mut dst = String::from("abc");
            append_quote(&mut dst, s);
            assert_eq!(dst, format!("abc{want}"));
        }
    }
}

#[test]
fn quote_edge_cases() {
    assert_eq!(quote(""), r#""""#);
    assert_eq!(quote("\""), r#""\"""#);
    assert_eq!(quote("'"), r#""'""#);
    assert_eq!(quote("한글 경로/a b"), "\"한글 경로/a b\"");
    assert_eq!(quote("\u{ad}"), "\"\\u00ad\"");
    assert_eq!(quote("\u{80}"), r#""\u0080""#);
    assert_eq!(quote("\u{feff}"), "\"\\ufeff\"");
    assert_eq!(quote("\u{e0001}"), r#""\U000e0001""#);
    assert_eq!(quote("\u{fffd}"), "\"\u{fffd}\"");
}

#[test]
fn quote_bytes_invalid_utf8_is_per_byte() {
    assert_eq!(quote_bytes(b"\xe2\x82"), r#""\xe2\x82""#);
    assert_eq!(quote_bytes(b"\xed\xa0\x80"), r#""\xed\xa0\x80""#);
    assert_eq!(quote_bytes(b"a\xc0\xafb"), r#""a\xc0\xafb""#);
}

// testdata/go_isprint_ranges.txt 는 go1.27.2 의 unicode.IsPrint 가 참인 구간 전부다.
#[test]
fn is_print_matches_go_for_every_rune() {
    let data = include_str!("../../testdata/go_isprint_ranges.txt");
    let mut ranges = Vec::new();
    for line in data.lines() {
        let (a, b) = line.split_once(' ').expect("range line");
        let a = u32::from_str_radix(a, 16).expect("hex");
        let b = u32::from_str_radix(b, 16).expect("hex");
        ranges.push((a, b));
    }
    let mut next = 0;
    for r in 0..=0x10ffffu32 {
        let Some(c) = char::from_u32(r) else { continue };
        while next < ranges.len() && ranges[next].1 < r {
            next += 1;
        }
        let want = next < ranges.len() && ranges[next].0 <= r;
        assert_eq!(is_print(c), want, "U+{r:04X}");
    }
}
