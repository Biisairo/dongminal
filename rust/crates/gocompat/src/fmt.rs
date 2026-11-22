//! Go `fmt` 의 `%v` 중 저장소가 출력에 쓰는 것.
//!
//! 오류의 `%v` 는 오류 문구(`Display`) 그대로, 정수·bool 은 Rust `Display` 와 같다.
//! `time.Duration` 은 [`crate::time::format_duration`], `%q` 는 [`crate::strconv::quote`] 를 쓴다.

use std::fmt::Display;

use crate::strconv::format_float;

/// float64 의 `%v`(= `%g`): 최단 자릿수, 지수가 -4 미만이거나 21 이상이 아니라 6 이상이면 지수 표기.
pub fn v_float(f: f64) -> String {
    format_float(f, b'g', -1, 64)
}

/// float32 의 `%v`.
pub fn v_float32(f: f32) -> String {
    format_float(f64::from(f), b'g', -1, 32)
}

/// slice 의 `%v`: `[a b c]`. nil 과 빈 slice 는 모두 `[]`.
pub fn v_list<T: Display>(items: &[T]) -> String {
    let mut out = String::from("[");
    for (i, item) in items.iter().enumerate() {
        if i > 0 {
            out.push(' ');
        }
        out.push_str(&item.to_string());
    }
    out.push(']');
    out
}

/// JSON 에서 푼 Go `any` 값(`serde_json::Value`) 의 `%v`.
/// 숫자는 float64, `null` 은 `<nil>`, 문자열은 따옴표 없이, 배열은 `[a b]`, 객체는 키 정렬된 `map[k:v]`.
pub fn v_value(v: &serde_json::Value) -> String {
    let mut out = String::new();
    push_value(&mut out, v);
    out
}

fn push_value(out: &mut String, v: &serde_json::Value) {
    use serde_json::Value;
    match v {
        Value::Null => out.push_str("<nil>"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => out.push_str(&v_float(n.as_f64().unwrap_or(0.0))),
        Value::String(s) => out.push_str(s),
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(' ');
                }
                push_value(out, item);
            }
            out.push(']');
        }
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            out.push_str("map[");
            for (i, k) in keys.iter().enumerate() {
                if i > 0 {
                    out.push(' ');
                }
                out.push_str(k);
                out.push(':');
                push_value(out, &map[k.as_str()]);
            }
            out.push(']');
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{v_float, v_list, v_value};

    // testdata/go_fmt_v.txt: go1.27.2 fmt.Sprintf("%v", v) 실측(v 는 json.Unmarshal 로 푼 any).
    // 줄 형식: base64(이름) \t base64(결과).
    #[test]
    fn v_matches_go() {
        use base64::Engine as _;
        let b64 = base64::engine::general_purpose::STANDARD;
        let mut g = std::collections::HashMap::new();
        for line in include_str!("../testdata/go_fmt_v.txt").lines() {
            let (name, want) = line.split_once('\t').expect("tab");
            let name = String::from_utf8(b64.decode(name).expect("b64")).expect("utf8");
            let want = String::from_utf8(b64.decode(want).expect("b64")).expect("utf8");
            g.insert(name, want);
        }
        let mut n = 0;
        for (name, want) in &g {
            let Some(json) = name.strip_prefix("any|") else {
                continue;
            };
            let v: serde_json::Value = crate::json::unmarshal(json.as_bytes()).expect("json");
            assert_eq!(&v_value(&v), want, "{json}");
            n += 1;
        }
        assert_eq!(n, 24);
        assert_eq!(v_list(&["a", "b c", ""]), g["strs|abc"]);
        assert_eq!(v_list::<String>(&[]), g["strs|empty"]);
        assert_eq!(v_list(&[1, -2, 3]), g["ints"]);
        assert_eq!(v_float(1e6), "1e+06");
    }
}
