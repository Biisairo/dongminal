//! 에이전트 렌더 환경 (Go `agent_render_env_test.go`).

use otter_shared_settingsschema::{self as settingsschema, Spec};
use serde_json::{Value, json};

use crate::agent_render_env::{AGENT_RENDER_ENV_KEY, agent_render_env, fullscreen_default_from};

const FLICKER_ENV: &str = "CLAUDE_CODE_NO_FLICKER=1";
const SPEED_KEY: &str = "CLAUDE_CODE_SCROLL_SPEED=";

#[test]
fn agent_render_env_flicker() {
    let cases = [
        ("blob 이 없다", "", true),
        ("빈 객체", "{}", true),
        ("키가 없다", r#"{"fgTabNames":true}"#, true),
        ("깨진 JSON", "{nope", true),
        ("켬", r#"{"claudeFullscreen":true}"#, true),
        ("끔", r#"{"claudeFullscreen":false}"#, false),
        ("문자열", r#"{"claudeFullscreen":"no"}"#, true),
        ("숫자", r#"{"claudeFullscreen":0}"#, true),
    ];
    for (name, blob, want) in cases {
        let got = agent_render_env(blob.as_bytes());
        assert_eq!(
            got.iter().any(|e| e == FLICKER_ENV),
            want,
            "{name}: {got:?}"
        );
        if !want {
            assert!(
                !got.iter().any(|e| e.starts_with("CLAUDE_CODE_NO_FLICKER")),
                "{name}: {got:?}"
            );
        }
    }
}

fn speed_of(blob: &str) -> String {
    agent_render_env(blob.as_bytes())
        .iter()
        .find_map(|e| e.strip_prefix(SPEED_KEY).map(str::to_owned))
        .unwrap_or_else(|| panic!("{SPEED_KEY} 가 env 에 없다 (blob={blob:?})"))
}

#[test]
fn agent_render_env_scroll_speed() {
    let cases = [
        ("blob 이 없다", "", "3"),
        ("빈 객체", "{}", "3"),
        ("키가 없다", r#"{"fgTabNames":true}"#, "3"),
        ("깨진 JSON", "{nope", "3"),
        ("1", r#"{"claudeScrollSpeed":1}"#, "1"),
        ("7", r#"{"claudeScrollSpeed":7}"#, "7"),
        ("20", r#"{"claudeScrollSpeed":20}"#, "20"),
        ("0", r#"{"claudeScrollSpeed":0}"#, "3"),
        ("음수", r#"{"claudeScrollSpeed":-5}"#, "3"),
        ("상한 초과", r#"{"claudeScrollSpeed":99}"#, "3"),
        ("실수", r#"{"claudeScrollSpeed":1.5}"#, "3"),
        ("문자열", r#"{"claudeScrollSpeed":"7"}"#, "3"),
        ("null", r#"{"claudeScrollSpeed":null}"#, "3"),
        // Go 는 숫자를 float64 로 읽는다 — 정수로 쓴 실수도 받는다.
        ("7.0", r#"{"claudeScrollSpeed":7.0}"#, "7"),
        ("큰 수", r#"{"claudeScrollSpeed":1e30}"#, "3"),
        ("null blob", "null", "3"),
    ];
    for (name, blob, want) in cases {
        assert_eq!(speed_of(blob), want, "{name}");
    }
}

#[test]
fn fullscreen_off_keeps_scroll_speed() {
    let blob = r#"{"claudeFullscreen":false,"claudeScrollSpeed":9}"#;
    let got = agent_render_env(blob.as_bytes());
    assert!(!got.iter().any(|e| e == FLICKER_ENV), "{got:?}");
    assert_eq!(speed_of(blob), "9");
}

#[test]
fn fullscreen_default_from_table() {
    let spec = |def: Value| {
        vec![Spec {
            key: AGENT_RENDER_ENV_KEY.to_owned(),
            def,
            ..Spec::default()
        }]
    };
    let cases: [(&str, Option<Vec<Spec>>, bool); 5] = [
        ("표가 끔", Some(spec(json!(false))), false),
        ("표가 켬", Some(spec(json!(true))), true),
        ("키가 없다", Some(Vec::new()), true),
        ("불리언이 아니다", Some(spec(json!("yes"))), true),
        ("표를 읽지 못했다", None, true),
    ];
    for (name, specs, want) in cases {
        assert_eq!(fullscreen_default_from(specs.as_deref()), want, "{name}");
    }
}

#[test]
fn fullscreen_default_follows_schema() {
    let specs = settingsschema::load().unwrap();
    let def = settingsschema::by_key(&specs)
        .get(AGENT_RENDER_ENV_KEY)
        .and_then(|s| s.def.as_bool())
        .expect("표에 claudeFullscreen 의 불리언 def 가 있어야 한다");
    assert_eq!(agent_render_env(&[]).iter().any(|e| e == FLICKER_ENV), def);
}
