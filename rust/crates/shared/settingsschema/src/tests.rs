use super::*;
use serde_json::json;

fn spec(key: &str, kind: &str) -> Spec {
    Spec {
        key: key.into(),
        kind: kind.into(),
        where_: "w".into(),
        ..Spec::default()
    }
}

fn int(key: &str, min: i64, max: i64, off: bool) -> Spec {
    Spec {
        min: Some(min),
        max: Some(max),
        off,
        ..spec(key, "int")
    }
}

fn obj(v: Value) -> serde_json::Map<String, Value> {
    v.as_object().unwrap().clone()
}

// TC-CFG-3: 임베드된 원천에서 형태 계약대로 배열을 잘라낸다.
#[test]
fn extract_from_embedded_source() {
    let src = raw().unwrap();
    let body = extract(&src).unwrap();
    assert_eq!(body.first(), Some(&b'['));
    assert_eq!(body.last(), Some(&b']'));
    let s = std::str::from_utf8(body).unwrap();
    for k in ["\"tabWidthPx\"", "\"themeName\"", "\"customTheme\""] {
        assert!(s.contains(k), "{k} 가 없다");
    }
}

#[test]
fn extract_errors() {
    assert_eq!(
        extract(b"const X = [1];").unwrap_err().to_string(),
        "`const SETTINGS_SCHEMA = [` 를 찾지 못했습니다"
    );
    assert_eq!(
        extract(b"const SETTINGS_SCHEMA = [1];")
            .unwrap_err()
            .to_string(),
        "표의 끝(`\\n];`)을 찾지 못했습니다"
    );
    assert_eq!(
        extract(b"x\nconst SETTINGS_SCHEMA = [\n {}\n];\nmore").unwrap(),
        b"[\n {}\n]"
    );
}

#[test]
fn check_specs_shape() {
    assert_eq!(
        check_specs(&[]).unwrap_err().to_string(),
        "서술자 표가 비었습니다"
    );
    assert_eq!(
        check_specs(&[spec("", "int")]).unwrap_err().to_string(),
        "key 가 빈 서술자가 있습니다"
    );
    assert_eq!(
        check_specs(&[spec("a", "int"), spec("a", "int")])
            .unwrap_err()
            .to_string(),
        "키가 두 번 나옵니다: a"
    );
    assert_eq!(
        check_specs(&[spec("a", "float")]).unwrap_err().to_string(),
        "a: 알 수 없는 type \"float\""
    );
    let mut s = spec("a", "any");
    s.where_.clear();
    assert_eq!(
        check_specs(&[s]).unwrap_err().to_string(),
        "a: where 가 비었습니다"
    );
    assert!(check_specs(&[spec("a", "bool"), spec("b", "object")]).is_ok());
}

#[test]
fn keys_sorted_and_by_key() {
    let specs = [spec("b", "int"), spec("a", "int"), spec("C", "int")];
    assert_eq!(keys(&specs), ["C", "a", "b"]);
    assert_eq!(by_key(&specs)["a"].key, "a");
}

// TC-CFG-12·14: 검증은 첫 오류에서 멈추지 않는다.
#[test]
fn validate_reports_all_problems() {
    let specs = [
        int("tabWidthPx", 40, 480, false),
        int("focusEdgeLevel", 0, 3, false),
        int("attnEdgeLevel", 0, 3, false),
        spec("themeName", "string"),
    ];
    let blob =
        obj(json!({"tabWidthPx":9999,"focusEdgeLevel":-3,"attnEdgeLevel":77,"themeName":"ok"}));
    let (probs, unknown) = validate_object(&specs, &blob);
    assert_eq!(probs.len(), 3, "{probs:?}");
    assert!(unknown.is_empty());
    assert_eq!(probs[0].key, "attnEdgeLevel");
    assert_eq!(probs[0].reason, "최댓값 3 보다 큽니다");
    assert_eq!(probs[1].reason, "최솟값 0 보다 작습니다");
    assert_eq!(probs[2].key, "tabWidthPx");
}

// V-FSS-3: 글자 크기 경계.
#[test]
fn font_size_bounds() {
    let specs = [int("uiFontSize", 8, 32, false)];
    for n in [8, 14, 32] {
        let (p, _) = validate_object(&specs, &obj(json!({ "uiFontSize": n })));
        assert!(p.is_empty(), "{n}");
    }
    for n in [7, 33] {
        let (p, _) = validate_object(&specs, &obj(json!({ "uiFontSize": n })));
        assert_eq!(p.len(), 1, "{n}");
    }
}

// TC-CFG-13: 알 수 없는 키는 경고이며 실패가 아니다.
#[test]
fn unknown_key_is_warning_only() {
    let specs = [spec("themeName", "string")];
    let (probs, unknown) = validate_object(&specs, &obj(json!({"futureKey":1,"themeName":"x"})));
    assert!(probs.is_empty());
    assert_eq!(unknown, ["futureKey"]);
}

#[test]
fn check_types() {
    let cases = [
        ("bool", json!(1), Some("bool 이어야 합니다")),
        ("bool", json!(true), None),
        ("string", json!(1), Some("string 이어야 합니다")),
        ("array", json!({}), Some("array 여야 합니다")),
        ("object", json!([]), Some("object 여야 합니다")),
        ("int", json!("1"), Some("정수여야 합니다")),
        ("int", json!(1.5), Some("정수여야 합니다")),
        ("int", json!(2.0), None),
        ("any", json!({"x":1}), None),
        ("string", Value::Null, None),
    ];
    for (kind, v, want) in cases {
        let got = check(&spec("k", kind), &v).map(|p| p.reason);
        assert_eq!(got.as_deref(), want, "{kind} {v}");
    }
}

// FR-PIS-9: off 인 키만 0 을 통과시킨다.
#[test]
fn zero_is_off_only_when_flagged() {
    assert!(check(&int("gitStatusInterval", 5, 60, true), &json!(0)).is_none());
    assert_eq!(
        check(&int("x", 5, 60, false), &json!(0)).unwrap().reason,
        "최솟값 5 보다 작습니다"
    );
}

// TC-QG-10: customTheme 은 키별로 본다.
#[test]
fn custom_theme_cases() {
    let cases = [
        (
            json!({"mode":"dark","ui":{"bg":"#1a1b26","accent":"#7AA2F7cc"},"terminal":{"red":"#f7768e"}}),
            "",
        ),
        (json!(null), ""),
        (json!({"name":"x","ui":{}}), ""),
        (
            json!({"ui":{"bg":"red\"><img src=x onerror=alert(1)>"}}),
            "customTheme.ui.bg",
        ),
        (
            json!({"terminal":{"background":"url(https://x/y)"}}),
            "customTheme.terminal.background",
        ),
        (json!({"ui":{"bg":"#fff"}}), "customTheme.ui.bg"),
        (json!({"ui":{"bg":1}}), "customTheme.ui.bg"),
        (json!({"ui":"nope"}), "customTheme.ui"),
        (json!({"mode":"<b>"}), "customTheme.mode"),
        (json!({"mode":null}), "customTheme.mode"),
        (json!("x"), "customTheme"),
        (json!({"ui":{"z":"bad","a":"bad"}}), "customTheme.ui.a"),
        (json!({"ui":{"bg":"#1a1b26\n"}}), "customTheme.ui.bg"),
    ];
    for (v, bad) in cases {
        let p = check(&spec(CUSTOM_THEME_KEY, "object"), &v);
        match p {
            None => assert_eq!(bad, "", "{v} 는 걸려야 한다"),
            Some(p) => assert_eq!(p.key, bad, "{v}"),
        }
    }
    let p = check(&spec(CUSTOM_THEME_KEY, "object"), &json!({"mode":"<b>"})).unwrap();
    assert_eq!(p.reason, "\"dark\" 또는 \"light\" 여야 합니다");
    assert_eq!(p.got, json!("<b>"));
}

// Go 구조체와 같은 와이어: 필드 순서, omitempty.
#[test]
fn spec_and_problem_wire() {
    let mut s = int("a", 1, 2, false);
    s.def = json!(3);
    assert_eq!(
        dm_gocompat::json::marshal(&s).unwrap(),
        br#"{"key":"a","type":"int","def":3,"min":1,"max":2,"where":"w"}"#
    );
    let s = Spec {
        off: true,
        ..spec("b", "string")
    };
    assert_eq!(
        dm_gocompat::json::marshal(&s).unwrap(),
        br#"{"key":"b","type":"string","def":null,"off":true,"where":"w"}"#
    );
    let p = Problem::new("k", "r", &json!(1.5));
    assert_eq!(
        dm_gocompat::json::marshal(&p).unwrap(),
        br#"{"key":"k","reason":"r","got":1.5}"#
    );
}
