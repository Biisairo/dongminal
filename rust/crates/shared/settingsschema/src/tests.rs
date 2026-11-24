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
/// PERF M1 C6·1.9·1.15: 거둔 키(`agentsPollInterval`·`gitConsoleInterval`·`gitStatusInterval`·`gitReposInterval`)는 저장된 블롭에 남아 있어도 문제도 경고도 아니다.
#[test]
fn retired_key_is_ignored() {
    let specs = load().unwrap();
    let (probs, unknown) = validate_object(
        &specs,
        &obj(
            json!({"agentsPollInterval":5000,"gitConsoleInterval":2000,"gitStatusInterval":0,"gitReposInterval":3000,"themeName":"x"}),
        ),
    );
    assert!(
        probs.is_empty() && unknown.is_empty(),
        "{probs:?} {unknown:?}"
    );
}

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
    assert!(check(&int("k", 5, 60, true), &json!(0)).is_none());
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
        otter_gocompat::json::marshal(&s).unwrap(),
        br#"{"key":"a","type":"int","def":3,"min":1,"max":2,"where":"w"}"#
    );
    let s = Spec {
        off: true,
        ..spec("b", "string")
    };
    assert_eq!(
        otter_gocompat::json::marshal(&s).unwrap(),
        br#"{"key":"b","type":"string","def":null,"off":true,"where":"w"}"#
    );
    let p = Problem::new("k", "r", &json!(1.5));
    assert_eq!(
        otter_gocompat::json::marshal(&p).unwrap(),
        br#"{"key":"k","reason":"r","got":1.5}"#
    );
}

// TC-CFG-4: 임베드된 같은 바이트를 읽어 서술자를 얻는다 (FR-CFG-10).
#[test]
fn load_reads_embedded_table() {
    let specs = load().unwrap();
    assert_eq!(specs.len(), 33, "서술자 {}개, 기대 33개", specs.len());
    let by = by_key(&specs);
    for k in [
        "themeName",
        "tabWidthPx",
        "attnEdgeLevel",
        "statsInterval",
        "uiFontSize",
        "termFontSize",
        "termHistoryLines",
        "termScrollback",
    ] {
        assert!(by.contains_key(k), "{k} 가 표에 없다");
    }
    let s = &by["tabWidthPx"];
    assert_eq!(
        (s.kind.as_str(), s.min, s.max),
        ("int", Some(40), Some(480))
    );
    for k in ["gitStatusInterval", "gitReposInterval"] {
        assert!(!by.contains_key(k), "{k} 는 거둔 키다 (PERF 1.15)");
    }
}

// TC-CFG-3: 파일 형태가 계약이다 (FR-CFG-2).
#[test]
fn schema_file_is_plain_json() {
    check_shape().unwrap();
}

#[test]
fn validate_real_table() {
    let specs = load().unwrap();
    let (probs, unknown) = validate(
        &specs,
        br#"{"tabWidthPx":9999,"focusEdgeLevel":-3,"attnEdgeLevel":77,"themeName":"ok"}"#,
    )
    .unwrap();
    assert_eq!(probs.len(), 3, "{probs:?}");
    assert!(unknown.is_empty());
    for blob in [r#"{"uiFontSize":8}"#, r#"{"termFontSize":32}"#] {
        assert!(
            validate(&specs, blob.as_bytes()).unwrap().0.is_empty(),
            "{blob}"
        );
    }
    for blob in [r#"{"uiFontSize":7}"#, r#"{"termFontSize":33}"#] {
        assert_eq!(
            validate(&specs, blob.as_bytes()).unwrap().0.len(),
            1,
            "{blob}"
        );
    }
    let (probs, unknown) = validate(&specs, br#"{"futureKey":1,"themeName":"x"}"#).unwrap();
    assert!(probs.is_empty());
    assert_eq!(unknown, ["futureKey"]);
    let (probs, _) = validate(&specs, br#"{"customTheme":{"ui":{"bg":"red"}}}"#).unwrap();
    assert_eq!(probs.len(), 1);
    assert_eq!(probs[0].key, "customTheme.ui.bg");
    // null 블롭은 빈 객체다 (Go map 이 nil 로 남는다).
    assert_eq!(validate(&specs, b"null").unwrap(), (vec![], vec![]));
}

// 깨진 블롭은 불일치가 아니라 오류다.
#[test]
fn validate_corrupt_blob() {
    let specs = load().unwrap();
    assert_eq!(
        validate(&specs, b"{nope").unwrap_err().to_string(),
        "JSON 이 아닙니다: invalid character 'n' looking for beginning of object key string"
    );
}

// `otterminal config validate` 가 이 문구를 그대로 낸다. go1.27.2 실측 문구다.
#[test]
fn validate_non_object_blob_type_name() {
    let specs = load().unwrap();
    assert_eq!(
        validate(&specs, b"[1]").unwrap_err().to_string(),
        "JSON 이 아닙니다: json: cannot unmarshal array into Go value of type map[string]interface {}"
    );
}

// TC-QG-10: 블롭 단위 검사.
#[test]
fn check_theme_blob_cases() {
    let cases = [
        (
            r##"{"customTheme":{"mode":"dark","ui":{"bg":"#1a1b26","accent":"#7AA2F7cc"},"terminal":{"red":"#f7768e"}}}"##,
            "",
        ),
        (r#"{"customTheme":null}"#, ""),
        (r#"{"themeName":"Dracula"}"#, ""),
        ("[1]", ""),
        ("{bad", ""),
        (r#"{"customTheme":{"name":"x","ui":{}}}"#, ""),
        (
            r##"{"customTheme":{"ui":{"bg":"#fff"}}}"##,
            "customTheme.ui.bg",
        ),
        (r#"{"customTheme":{"ui":"nope"}}"#, "customTheme.ui"),
        (r#"{"customTheme":"x"}"#, "customTheme"),
        (
            r#"{"customTheme":"x","customTheme":{"mode":"<b>"}}"#,
            "customTheme.mode",
        ),
    ];
    for (blob, bad) in cases {
        let p = check_theme_blob(blob.as_bytes());
        assert_eq!(p.map(|p| p.key).unwrap_or_default(), bad, "{blob}");
    }
}

// TC-QG-10 · FR-QG-13: 내장 테마 54종의 값은 모두 통과한다. 원천은 임베드된 `js/ui/themes.js` 다.
#[test]
fn builtin_themes_pass() {
    let src = otter_web_assets::get("js/ui/themes.js").unwrap();
    let src = std::str::from_utf8(&src).unwrap();
    let section = regex::Regex::new(r"(?m)^\s+(ui|terminal):\{([^}]*)\}").unwrap();
    let pair = regex::Regex::new(r"(\w+):'([^']*)'").unwrap();
    let mode = regex::Regex::new(r"mode:'(\w+)'").unwrap();
    let modes: Vec<_> = mode.captures_iter(src).collect();
    let secs: Vec<_> = section.captures_iter(src).collect();
    assert_eq!((modes.len(), secs.len()), (54, 108));
    for (i, m) in modes.iter().enumerate() {
        let mut b = format!(r#"{{"customTheme":{{"mode":"{}""#, &m[1]);
        for s in &secs[2 * i..2 * i + 2] {
            let pairs: Vec<String> = pair
                .captures_iter(&s[2])
                .map(|p| format!(r#""{}":"{}""#, &p[1], &p[2]))
                .collect();
            b.push_str(&format!(r#","{}":{{{}}}"#, &s[1], pairs.join(",")));
        }
        b.push_str("}}");
        assert!(
            check_theme_blob(b.as_bytes()).is_none(),
            "내장 테마 {i}: {b}"
        );
    }
}

fn web_src(rel: &str) -> String {
    let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../../web")
        .join(rel);
    std::fs::read_to_string(p).unwrap().replace("\r\n", "\n")
}

fn between<'a>(s: &'a str, open: &str, close: &str) -> &'a str {
    let Some(i) = s.find(open) else { return "" };
    let rest = &s[i + open.len()..];
    rest.find(close).map(|j| &rest[..j]).unwrap_or("")
}

// TC-CFG-1: 세 표의 키 집합이 같다 (FR-CFG-4·5).
#[test]
fn schema_and_access_keys_match() {
    let schema_keys = keys(&load().unwrap());
    let src = web_src("js/core/settings-table.js");
    let body = between(&src, "const SETTINGS_ACCESS={", "\n};");
    assert!(!body.is_empty(), "SETTINGS_ACCESS 를 찾지 못했다");
    let re = regex::Regex::new(r"(?m)^  ([A-Za-z_$][\w$]*):\{").unwrap();
    let mut access: Vec<String> = re.captures_iter(body).map(|c| c[1].to_string()).collect();
    access.sort();
    assert_eq!(schema_keys, access, "키 집합이 갈렸다");
}

// saveSettings 가 표를 돌아야 한다 — 인라인 나열로 되돌아가면 여기서 잡힌다.
#[test]
fn save_settings_derives_from_table() {
    let sync = web_src("js/core/settings-sync.js");
    assert!(
        between(&sync, "saveSettings(){", "\n  },")
            .contains("this.app.settings.apply._settingsBody()"),
        "saveSettings 가 _settingsBody 로 본문을 짓지 않는다"
    );
    let apply = web_src("js/core/settings-apply.js");
    let body = between(&apply, "_settingsBody(){", "\n  }\n");
    assert!(!body.is_empty(), "_settingsBody 를 찾지 못했다");
    assert!(body.contains("for(const spec of SETTINGS_SCHEMA)"));
    for k in ["statsInterval,", "focusEdgeLevel,attnEdgeLevel"] {
        assert!(!body.contains(k), "키를 인라인으로 나열하고 있다: {k:?}");
    }
}

// Go `Problem.String()` — `otterminal config validate` 가 이 줄을 낸다.
#[test]
fn problem_display() {
    let specs = load().unwrap();
    let (probs, _) = validate(
        &specs,
        br#"{"tabWidthPx":9999,"themeName":1.5,"customTheme":{"ui":{"bg":[1,"x"]}},"keybar":{"b":null,"a":true}}"#,
    )
    .unwrap();
    let lines: Vec<String> = probs.iter().map(|p| p.to_string()).collect();
    assert!(
        lines.contains(&"tabWidthPx: 최댓값 480 보다 큽니다 (값 9999)".to_string()),
        "{lines:?}"
    );
    assert!(
        lines.contains(&"themeName: string 이어야 합니다 (값 1.5)".to_string()),
        "{lines:?}"
    );
    assert!(
        lines.contains(
            &"customTheme.ui.bg: #rrggbb 또는 #rrggbbaa 색이어야 합니다 (값 [1 x])".to_string()
        ),
        "{lines:?}"
    );
    let p = Problem::new("k", "r", &serde_json::json!({"b": null, "a": true}));
    assert_eq!(p.to_string(), "k: r (값 map[a:true b:<nil>])");
    let p = Problem::new("k", "r", &serde_json::json!(1e21));
    assert_eq!(p.to_string(), "k: r (값 1e+21)");
}
