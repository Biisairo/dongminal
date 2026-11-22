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
    // Go 는 타입 이름을 map[string]int 로 쓴다. Rust 는 map 원소 타입을 알 수 없어 "map" 이다.
    let e = unmarshal::<HashMap<String, i64>>(b"[1]").expect_err("type");
    assert_eq!(
        e.to_string(),
        "json: cannot unmarshal array into Go value of type map"
    );
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
