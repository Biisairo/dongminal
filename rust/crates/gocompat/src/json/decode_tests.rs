use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use super::{Decoder, RawMessage, marshal, opt_bytes, unmarshal};
use crate::testutil::{golden, golden_str};

// testdata 생성기의 Go 타입 In·T 와 같은 모양.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(default, rename = "main.In")]
struct In {
    n: i64,
    s: String,
    b: bool,
    f: f64,
    u8: u8,
    i32: i32,
    l: Option<Vec<i64>>,
    m: Option<HashMap<String, i64>>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(default, rename = "main.T")]
struct T {
    name: String,
    inner: In,
    list: Option<Vec<In>>,
    p: Option<In>,
    raw: RawMessage,
    any: serde_json::Value,
    #[serde(with = "opt_bytes")]
    bytes: Option<Vec<u8>>,
    #[serde(rename = "camelCase")]
    camel_case: String,
    snake_x: String,
}

/// Go 쪽 결과 `err\nmarshal(v)`. 오류가 있으면 Go 는 일부만 채운 값을 남기지만 Rust 는 값을 내지 않으므로 오류만 비교한다.
fn check<T: Serialize>(name: &str, got: Result<T, super::Error>, g: &HashMap<String, Vec<u8>>) {
    let want = golden_str(g, name);
    let (want_err, want_val) = want.split_once('\n').expect("two lines");
    match got {
        Ok(v) => {
            assert_eq!("<nil>", want_err, "{name}");
            let b = String::from_utf8(marshal(&v).expect("marshal")).expect("utf8");
            assert_eq!(b, want_val, "{name}");
        }
        Err(e) => assert_eq!(e.to_string(), want_err, "{name}"),
    }
}

const CASES: &[(&str, &[u8])] = &[
    ("int_str", br#"{"inner":{"n":"x"}}"#),
    ("int_float", br#"{"inner":{"n":1.5}}"#),
    ("int_exp", br#"{"inner":{"n":1e2}}"#),
    ("u8_300", br#"{"inner":{"u8":300}}"#),
    ("u8_neg", br#"{"inner":{"u8":-1}}"#),
    ("i32_big", br#"{"inner":{"i32":3000000000}}"#),
    ("str_num", br#"{"name":5}"#),
    ("str_bool", br#"{"name":true}"#),
    ("str_obj", br#"{"name":{}}"#),
    ("bool_str", br#"{"inner":{"b":"true"}}"#),
    ("float_str", br#"{"inner":{"f":"1"}}"#),
    ("struct_arr", br#"{"inner":[]}"#),
    ("listidx", br#"{"list":[{"n":1},{"n":"x"}]}"#),
    ("slice_elem", br#"{"inner":{"l":[1,"x",3]}}"#),
    ("map_val", br#"{"inner":{"m":{"a":"x"}}}"#),
    ("top_struct", b"5"),
    ("bytes_bad", br#"{"bytes":"!!"}"#),
    ("bytes_bad2", br#"{"bytes":"aGVsbG8=!"}"#),
    ("bytes_num", br#"{"bytes":5}"#),
    ("bytes_ok", b"{\"bytes\":\"aGVs\\nbG8=\"}"),
    (
        "case",
        br#"{"NAME":"a","CamelCASE":"b","snakex":"c","SNAKE_X":"d"}"#,
    ),
    ("dup", br#"{"name":"a","name":"b","NAME":"c"}"#),
    ("dup_nested", br#"{"inner":{"n":1},"inner":{"s":"x"}}"#),
    (
        "dup_replace",
        br#"{"inner":{"n":1},"inner":null,"list":[{"n":1}],"list":[{"n":2}]}"#,
    ),
    (
        "nulls",
        br#"{"name":null,"inner":null,"p":null,"list":null,"any":null,"raw":null,"bytes":null}"#,
    ),
    (
        "null_elem",
        br#"{"list":[null,{"n":1}],"inner":{"l":[1,null,3],"m":{"a":null}}}"#,
    ),
    ("unknown", br#"{"zzz":1,"name":"a"}"#),
    (
        "badutf8",
        b"{\"name\":\"a\xffb\",\"any\":\"\\ud800x\\ud83d\\ude00\"}",
    ),
    ("raw", br#"{"raw": [1, 2 , {"a" :1}] }"#),
    (
        "any_nums",
        br#"{"any":[1,1.5,-0,12345678901234567890,2,9007199254740993,-9007199254740992,1e2,0.0]}"#,
    ),
    ("any_big", br#"{"any":[1,1e400]}"#),
    ("any_obj", br#"{"any":{"b":1,"a":[{"x":null}],"b":2}}"#),
    ("int_overflow", br#"{"inner":{"n":12345678901234567890}}"#),
    ("float_big", br#"{"inner":{"f":1e400}}"#),
    ("type_then_syn", br#"{"name":5,"x":}"#),
    ("two_type", br#"{"name":5,"inner":{"n":"x"}}"#),
    ("p_obj", br#"{"p":{"n":2}}"#),
    ("escapes", br#"{"name":"\u00e9\n\ud83d\ude00\/\u0000"}"#),
];

// testdata/go_decode.txt: go1.27.2 json.Unmarshal·Decoder 의 결과.
#[test]
fn unmarshal_struct_matches_go() {
    let g = golden("go_decode.txt");
    for (name, input) in CASES {
        check(&format!("u_{name}"), unmarshal::<T>(input), &g);
    }
}

#[test]
fn unmarshal_top_level_matches_go() {
    let g = golden("go_decode.txt");
    check("top_int", unmarshal::<i64>(br#""x""#), &g);
    check(
        "map_intkey",
        unmarshal::<HashMap<i64, String>>(br#"{"2":"b","10":"a"}"#),
        &g,
    );
    check(
        "top_slice_null",
        unmarshal::<Option<Vec<String>>>(b"null"),
        &g,
    );
    check(
        "any_top",
        unmarshal::<serde_json::Value>(br#" {"z":[true,null,"s",1.5]} "#),
        &g,
    );
    // 이름을 주지 않은 map 은 Go map[string]any 의 이름이다(dongminal config validate 의 실제 출력).
    let e = unmarshal::<HashMap<String, serde_json::Value>>(b"[1]").expect_err("type");
    assert_eq!(
        e.to_string(),
        "json: cannot unmarshal array into Go value of type map[string]interface {}"
    );
    let e = unmarshal::<Vec<serde_json::Value>>(b"{}").expect_err("type");
    assert_eq!(
        e.to_string(),
        "json: cannot unmarshal object into Go value of type []interface {}"
    );
    // 맨 위 값의 이름은 GoTyped 로 준다(Go 실측: top_map).
    crate::go_type!(MapStringInt = "map[string]int");
    let e =
        unmarshal::<super::GoTyped<MapStringInt, HashMap<String, i64>>>(b"[1]").expect_err("type");
    let want = golden_str(&g, "top_map");
    assert_eq!(e.to_string(), want.split_once('\n').expect("2 lines").0);
}

#[test]
fn decoder_matches_go() {
    let g = golden("go_decode.txt");
    let cases: &[(&str, &[u8])] = &[
        ("empty", b""),
        ("ws", b"  \n"),
        ("trailing", br#"{"name":"a"} xx"#),
        ("two", br#"{"name":"a"}{"name":"b"}"#),
        ("trunc", br#"{"name":"#),
        ("trunc2", br#"{"na"#),
        ("bad", br#"{"name":}"#),
        ("badafter", br#"{"name":"a""#),
        ("lead_ws", b"  {\"name\":\"a\"}"),
    ];
    for (name, input) in cases {
        check(&format!("d_{name}"), Decoder::new().decode::<T>(input), &g);
    }
    for input in [
        r#"{"x":1}"#,
        r#"{"NAME":"a"}"#,
        r#"{"name":"a","inner":{"zz":1}}"#,
        r#"{"x":1,"name":5}"#,
    ] {
        let got = Decoder::new()
            .disallow_unknown_fields()
            .decode::<T>(input.as_bytes());
        check(&format!("dis_{input}"), got, &g);
    }
}

#[test]
fn deep_input_is_error_not_stack_overflow() {
    let deep = format!("{}{}", "[".repeat(10000), "]".repeat(10000));
    let e = unmarshal::<serde_json::Value>(deep.as_bytes()).expect_err("depth");
    assert_eq!(e.to_string(), "exceeded max depth");
    let ok = format!("{}{}", "[".repeat(100), "]".repeat(100));
    assert!(unmarshal::<serde_json::Value>(ok.as_bytes()).is_ok());
}

#[test]
fn many_duplicate_keys_resolve() {
    let mut s = String::from("{");
    for i in 0..20000 {
        s.push_str(&format!("\"k{i}\":1,\"name\":\"v{i}\","));
    }
    s.push_str("\"name\":\"last\"}");
    let t: T = unmarshal(s.as_bytes()).expect("ok");
    assert_eq!(t.name, "last");
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, rename = "main.In")]
struct KIn {
    n: i64,
    l: Option<Vec<i64>>,
    m: Option<HashMap<String, i64>>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, rename = "main.T")]
struct KT {
    name: String,
    inner: KIn,
    list: Option<Vec<KIn>>,
    any: serde_json::Value,
    #[serde(with = "opt_bytes")]
    bytes: Option<Vec<u8>>,
}

// go1.27.2 실측: errors.As(err, &*json.SyntaxError).Offset
#[test]
fn syntax_error_offsets_match_go() {
    use super::ErrorKind;
    let cases: &[(&[u8], i64)] = &[
        (b"", 0),
        (b"  ", 2),
        (b"{", 1),
        (br#"{"a":1"#, 6),
        (b"[1,]", 4),
        (b"  [1,]", 6),
        (br#"{"a" 1}"#, 6),
        (b"tru", 3),
        (b"trux", 4),
        (br#""\x""#, 3),
        (b"\"a\x01\"", 3),
        (b"1 2", 3),
        (br#"{"a":1}}"#, 8),
        (b"[1 2]", 4),
        (br#""\u12g4""#, 7),
        (b"-x", 2),
        (b"[\xff]", 2),
    ];
    for (input, want) in cases {
        let e = unmarshal::<serde_json::Value>(input).expect_err("syntax");
        assert_eq!(
            e.kind(),
            &ErrorKind::Syntax { offset: *want },
            "{:?}",
            String::from_utf8_lossy(input)
        );
    }
    let deep = "[".repeat(10001);
    let e = unmarshal::<serde_json::Value>(deep.as_bytes()).expect_err("depth");
    assert_eq!(e.kind(), &ErrorKind::Syntax { offset: 10001 });
}

// go1.27.2 실측: errors.As(err, &*json.UnmarshalTypeError) 의 Field·Value·Struct·Offset
#[test]
fn type_error_fields_match_go() {
    use super::ErrorKind;
    let cases: &[(&str, &str, &str, &str, i64)] = &[
        (r#"{"inner":{"n":"x"}}"#, "inner.n", "string", "T", 17),
        (r#"{"inner":{"n":1.5}}"#, "inner.n", "number 1.5", "T", 17),
        (r#"{"name":5}"#, "name", "number", "T", 9),
        (r#"{"name":true}"#, "name", "bool", "T", 12),
        (r#"{"name":{}}"#, "name", "object", "T", 9),
        (r#"{"name":[]}"#, "name", "array", "T", 9),
        (
            r#" {"list":[{"n":1},{"n":"x"}]}"#,
            "list.1.n",
            "string",
            "T",
            26,
        ),
        (r#"{"inner":{"l":[1,"x"]}}"#, "inner.l.1", "string", "T", 20),
        (
            r#"{"inner":{"m":{"a":"x"}}}"#,
            "inner.m.a",
            "string",
            "T",
            22,
        ),
        ("5", "", "number", "", 1),
        (r#"{"inner":[]}"#, "inner", "array", "T", 10),
        (r#"{"any":[1,1e400]}"#, "any.1", "number 1e400", "T", 15),
        (r#"{"bytes":"!!"}"#, "bytes", "string", "T", 13),
        (r#"{"bytes":"!!" , "name":"a"}"#, "bytes", "string", "T", 13),
        (r#"{"bytes":"aGVsbG8=!"}"#, "bytes", "string", "T", 20),
        (
            r#"{"inner":{"n":12345678901234567890}}"#,
            "inner.n",
            "number 12345678901234567890",
            "T",
            34,
        ),
        (
            r#"{"x":1, "inner" : { "n" : "long string here" } }"#,
            "inner.n",
            "string",
            "T",
            44,
        ),
    ];
    for &(input, field, value, st, offset) in cases {
        let e = unmarshal::<KT>(input.as_bytes()).expect_err("type");
        match e.kind() {
            ErrorKind::Type {
                value: v,
                field: f,
                struct_name: s,
                offset: o,
                ..
            } => {
                assert_eq!(
                    (f.as_str(), v.as_str(), s.as_str(), *o),
                    (field, value, st, offset),
                    "{input}"
                );
            }
            other => panic!("{input}: {other:?}"),
        }
    }
    let e = unmarshal::<i64>(br#" "x""#).expect_err("type");
    assert!(
        matches!(e.kind(), ErrorKind::Type { offset: 4, .. }),
        "{:?}",
        e.kind()
    );
}

#[test]
fn decoder_error_kinds_match_go() {
    use super::ErrorKind;
    let d = Decoder::new();
    assert_eq!(
        d.decode::<KT>(b"").expect_err("eof").kind(),
        &ErrorKind::Eof
    );
    assert_eq!(
        d.decode::<KT>(b" ").expect_err("eof").kind(),
        &ErrorKind::Eof
    );
    assert_eq!(
        d.decode::<KT>(br#"{"name":"#).expect_err("eof").kind(),
        &ErrorKind::UnexpectedEof
    );
    assert_eq!(
        d.decode::<KT>(br#"{"name":"a""#).expect_err("eof").kind(),
        &ErrorKind::UnexpectedEof
    );
    assert_eq!(
        d.decode::<KT>(br#"{"name":}"#).expect_err("syn").kind(),
        &ErrorKind::Syntax { offset: 9 }
    );
    let mut d = Decoder::new();
    d.disallow_unknown_fields();
    assert_eq!(
        d.decode::<KT>(br#"{"x":1}"#).expect_err("unk").kind(),
        &ErrorKind::Other
    );
}

// go1.27.2 실측: RawMessage 는 원문 바이트를 그대로 담는다(이스케이프·공백 보존). map 의 null 은 키를 남기고 "null".
#[test]
fn raw_message_keeps_source_bytes_like_go() {
    let input = r#"{"n":null,"s":"\u00e9","t":"\/x","u":" x ","o":{ "a" : 1 , "c":"\u00e9\/"},"arr":[ 1 , "\u0041" ],"num":1.50,"bad":"\ud800"}"#;
    let m: std::collections::BTreeMap<String, RawMessage> =
        unmarshal(input.as_bytes()).expect("ok");
    assert_eq!(m.len(), 8);
    assert_eq!(m["n"].0, r#"null"#.as_bytes(), "n");
    assert_eq!(m["s"].0, r#""\u00e9""#.as_bytes(), "s");
    assert_eq!(m["t"].0, r#""\/x""#.as_bytes(), "t");
    assert_eq!(m["u"].0, r#"" x ""#.as_bytes(), "u");
    assert_eq!(m["o"].0, r#"{ "a" : 1 , "c":"\u00e9\/"}"#.as_bytes(), "o");
    assert_eq!(m["arr"].0, r#"[ 1 , "\u0041" ]"#.as_bytes(), "arr");
    assert_eq!(m["num"].0, r#"1.50"#.as_bytes(), "num");
    assert_eq!(m["bad"].0, r#""\ud800""#.as_bytes(), "bad");
}

crate::go_type!(InSlice = "[]main.In");
crate::go_type!(IntSlice = "[]int");

#[derive(Debug, Default, Deserialize)]
#[serde(default, rename = "main.T")]
struct NT {
    #[serde(deserialize_with = "super::with_go_type::<InSlice, _, _>")]
    list: Option<Vec<KIn>>,
    inner: NIn,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, rename = "main.In")]
struct NIn {
    #[serde(deserialize_with = "super::with_go_type::<IntSlice, _, _>")]
    l: Option<Vec<i64>>,
}

// Go 실측: slice<-obj 는 "... of type []int", 원소의 오류는 원소 타입 이름 그대로.
#[test]
fn go_type_names_from_consumer() {
    let e = unmarshal::<NT>(br#"{"inner":{"l":{}}}"#).expect_err("type");
    assert_eq!(
        e.to_string(),
        "json: cannot unmarshal object into Go struct field T.inner.l of type []int"
    );
    let e = unmarshal::<NT>(br#"{"list":{}}"#).expect_err("type");
    assert_eq!(
        e.to_string(),
        "json: cannot unmarshal object into Go struct field T.list of type []main.In"
    );
    let e = unmarshal::<NT>(br#"{"list":[{"n":"x"}]}"#).expect_err("type");
    assert_eq!(
        e.to_string(),
        "json: cannot unmarshal string into Go struct field T.list.0.n of type int"
    );
    let ok = unmarshal::<NT>(br#"{"list":[{"n":3}],"inner":{"l":[1,2]}}"#).expect("ok");
    assert_eq!(ok.list.map(|v| v[0].n), Some(3));
    assert_eq!(ok.inner.l, Some(vec![1, 2]));
    let none = unmarshal::<NT>(br#"{"list":null}"#).expect("ok");
    assert!(none.list.is_none());
}

// go1.27.2 실측: 구조체 필드의 null 은 채워 둔 값을 남긴다(int·string·bool·float·구조체).
// 포인터·slice·map 은 nil 이다 — Rust 는 Option·Vec·map 의 컨테이너 기본값(None·빈 값)이 된다.
#[test]
fn null_field_keeps_container_default() {
    #[derive(serde::Deserialize, Debug, PartialEq, Default)]
    #[serde(default)]
    struct In {
        x: i64,
    }
    #[derive(serde::Deserialize, Debug, PartialEq)]
    #[serde(default)]
    struct C {
        n: i64,
        s: String,
        b: bool,
        p: Option<i64>,
        l: Vec<i64>,
        #[serde(rename = "in")]
        inner: In,
        f: f64,
    }
    impl Default for C {
        fn default() -> Self {
            C {
                n: 5,
                s: "d".into(),
                b: true,
                p: None,
                l: Vec::new(),
                inner: In { x: 7 },
                f: 2.5,
            }
        }
    }
    let got: C =
        unmarshal(br#"{"n":null,"s":null,"b":null,"p":null,"l":null,"in":null,"f":null}"#).unwrap();
    assert_eq!(got, C::default());
    // 앞의 값 뒤에 온 null 은 무시, 대소문자 무시 매칭도 같다.
    let got: C = unmarshal(br#"{"n":3,"n":null,"S":null}"#).unwrap();
    assert_eq!((got.n, got.s.as_str()), (3, "d"));
    let got: C = unmarshal(br#"{"n":null,"n":4,"p":9}"#).unwrap();
    assert_eq!((got.n, got.p), (4, Some(9)));
}
