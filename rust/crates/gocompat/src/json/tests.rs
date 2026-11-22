#![allow(clippy::approx_constant)] // Go 기준값과 같은 리터럴(3.14)을 쓴다.

use std::collections::HashMap;

use serde::Serialize;
use serde_json::json;

use super::{Encoder, RawMessage, compact, indent, is_empty, marshal, marshal_indent, valid};
use crate::testutil::{golden, golden_str};

#[derive(Serialize)]
struct Inner {
    x: i64,
    #[serde(skip_serializing_if = "is_empty")]
    y: String,
}

// testdata 생성기의 Go 구조체 Outer 와 같은 모양.
#[derive(Serialize)]
struct Outer {
    name: String,
    #[serde(skip_serializing_if = "is_empty")]
    empty: String,
    #[serde(skip_serializing_if = "is_empty")]
    zero: i64,
    #[serde(rename = "false", skip_serializing_if = "is_empty")]
    false_: bool,
    #[serde(skip_serializing_if = "is_empty")]
    nilp: Option<Inner>,
    #[serde(skip_serializing_if = "is_empty")]
    ptr: Option<Inner>,
    nils: Option<Vec<String>>,
    emptys: Option<Vec<String>>,
    #[serde(skip_serializing_if = "is_empty")]
    omits: Vec<String>,
    #[serde(with = "super::bytes")]
    bytes: Vec<u8>,
    #[serde(with = "super::opt_bytes")]
    nilb: Option<Vec<u8>>,
    map: Option<HashMap<String, i64>>,
    nilmap: Option<HashMap<String, i64>>,
    raw: RawMessage,
    nilraw: RawMessage,
    #[serde(skip_serializing_if = "is_empty")]
    omitraw: RawMessage,
    any: serde_json::Value,
    f32: f32,
    inners: Vec<Inner>,
    intkeys: HashMap<i64, String>,
}

fn sample() -> Outer {
    Outer {
        name: "a<b>&c\u{2028}\u{2029}".to_owned(),
        empty: String::new(),
        zero: 0,
        false_: false,
        nilp: None,
        ptr: Some(Inner {
            x: 0,
            y: String::new(),
        }),
        nils: None,
        emptys: Some(Vec::new()),
        omits: Vec::new(),
        bytes: b"hello\x00\xff".to_vec(),
        nilb: None,
        map: Some(
            [
                ("b", 2),
                ("a", 1),
                ("<", 0),
                ("Z", 3),
                ("é", 4),
                ("10", 5),
                ("9", 6),
            ]
            .into_iter()
            .map(|(k, v)| (k.to_owned(), v))
            .collect(),
        ),
        nilmap: None,
        raw: RawMessage(b" { \"k\" : [1, 2,\n 3], \"h\": \"<&>\" } ".to_vec()),
        nilraw: RawMessage::default(),
        omitraw: RawMessage::default(),
        any: json!({"z": 1.5, "a": [true, null, "s"]}),
        f32: 3.14,
        inners: vec![
            Inner {
                x: 1,
                y: "q".to_owned(),
            },
            Inner {
                x: 2,
                y: String::new(),
            },
        ],
        intkeys: [(1, "a"), (10, "b"), (2, "c"), (-1, "d")]
            .into_iter()
            .map(|(k, v)| (k, v.to_owned()))
            .collect(),
    }
}

fn m<T: Serialize + ?Sized>(v: &T) -> String {
    match marshal(v) {
        Ok(b) => String::from_utf8(b).expect("utf8"),
        Err(e) => format!("ERR {e}"),
    }
}

#[test]
fn strings_escape_like_go() {
    let g = golden("go_encode.txt");
    assert_eq!(
        m("<>&\u{2028}\u{2029}\x00\x1f\x08\x0c\n\r\t\"\\/é한글\x7f😀"),
        golden_str(&g, "str")
    );
    let mut out = Vec::new();
    super::append_string(&mut out, b"a\xffb\xe2\x82c", true);
    assert_eq!(out, g["badutf8"]);
}

#[test]
fn floats_like_go() {
    let g = golden("go_encode.txt");
    let f64s: [f64; 19] = [
        0.0,
        -0.0,
        1.0,
        -1.0,
        0.1,
        1e20,
        1e21,
        1e-6,
        1e-7,
        123456789.123,
        5e-324,
        f64::MAX,
        3.14,
        100.0,
        1e6,
        12345678901234567890.0,
        0.000001234,
        1.5e300,
        -2.5e-10,
    ];
    for (i, f) in f64s.iter().enumerate() {
        assert_eq!(m(f), golden_str(&g, &format!("f64_{i}")), "f64 {f}");
        assert_eq!(
            m(&(*f as f32)),
            golden_str(&g, &format!("f32_{i}")),
            "f32 {f}"
        );
    }
    assert_eq!(m(&f64::NAN), golden_str(&g, "nan"));
    assert_eq!(m(&f64::NEG_INFINITY), golden_str(&g, "inf"));
}

#[test]
fn struct_map_raw_bytes_like_go() {
    let g = golden("go_encode.txt");
    assert_eq!(m(&sample()), golden_str(&g, "outer"));
    let b = marshal_indent(&sample(), "", "  ").expect("indent");
    assert_eq!(
        String::from_utf8(b).expect("utf8"),
        golden_str(&g, "outer_indent")
    );
    let v = json!({"e": [], "o": {}, "n": null, "a": [1, [], {}]});
    let b = marshal_indent(&v, ">", "\t").expect("indent");
    assert_eq!(
        String::from_utf8(b).expect("utf8"),
        golden_str(&g, "indent_prefix")
    );
    assert_eq!(m(&RawMessage(b"{bad".to_vec())), golden_str(&g, "rawbad"));
}

#[test]
fn encoder_like_go() {
    let g = golden("go_encode.txt");
    let mut enc = Encoder::new();
    enc.set_escape_html(false);
    let mut h = HashMap::new();
    h.insert("h", "<a>&\u{2028}");
    assert_eq!(enc.encode(&h).expect("enc"), g["enc_noescape"]);
    let mut enc = Encoder::new();
    enc.set_indent("", "  ");
    assert_eq!(enc.encode(&sample()).expect("enc"), g["enc_indent"]);
    let mut w = Vec::new();
    Encoder::new().encode_to(&mut w, &[1, 2]).expect("enc");
    assert_eq!(w, g["enc_plain"]);
}

#[test]
fn valid_compact_indent_like_go() {
    let g = golden("go_encode.txt");
    let inputs: &[&[u8]] = &[
        br#"{"a":1}"#,
        br#" [1, {"b" : null} ] "#,
        b"{",
        b"[1,]",
        br#"{"a" 1}"#,
        b"tru",
        b"nul",
        b"01",
        b"1.",
        b"1e",
        b"-",
        br#""\x""#,
        b"\"a\x01\"",
        br#""\u12g4""#,
        br#"{"a":1}}"#,
        b"[1] x",
        b"",
        b"   ",
        br#"{"a":1,}"#,
        b"{1:2}",
        b"'a'",
        b"\xe2",
        b"[1 2]",
        b"falsy",
        br#"{"a":1 "b":2}"#,
    ];
    for &s in inputs {
        let q = crate::strconv::quote_bytes(s);
        let want = golden_str(&g, &format!("valid_{q}"));
        assert_eq!(valid(s), want == "ok", "input {q}");
        match g.get(&format!("compact_{q}")) {
            Some(want) => assert_eq!(&compact(s).expect("compact"), want, "compact {q}"),
            None => assert!(compact(s).is_err(), "compact {q}"),
        }
        match g.get(&format!("indentfn_{q}")) {
            Some(want) => assert_eq!(&indent(s, "", " ").expect("indent"), want, "indent {q}"),
            None => assert!(indent(s, "", " ").is_err(), "indent {q}"),
        }
    }
}

#[test]
fn unsupported_map_key_is_error() {
    let mut h = HashMap::new();
    h.insert(true, 1);
    assert!(marshal(&h).is_err());
}

#[test]
fn is_empty_follows_go_omitempty() {
    assert!(is_empty(&0i64));
    assert!(is_empty(&0.0f64));
    assert!(is_empty(&false));
    assert!(is_empty(""));
    assert!(is_empty(&Vec::<u8>::new()));
    assert!(is_empty(&None::<i64>));
    assert!(!is_empty(&Some(0)));
    assert!(is_empty(&serde_json::Value::Null));
    assert!(!is_empty(&json!(0)));
}
