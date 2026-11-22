//! 사용자 정의 테마의 값 검증 (QUALITY_GO_SRS FR-QG-10). 키 이름은 묻지 않는다 (D-QG-5).

use std::sync::LazyLock;

use regex::Regex;
use serde_json::Value;

use crate::Problem;

/// 사용자 정의 테마의 블롭 키다.
pub const CUSTOM_THEME_KEY: &str = "customTheme";

/// 클라이언트 `THEME_COLOR_RE`(`web/js/core/theme-vars.js`)와 같은 규칙이다.
static THEME_COLOR: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$").expect("고정 정규식"));

/// 색 표를 담는 칸이다. 클라이언트 `sanitizeCustomTheme` 이 읽는 둘이다.
const THEME_SECTIONS: [&str; 2] = ["ui", "terminal"];

/// `customTheme` 값 하나를 본다. `None` 이면 통과다.
pub(crate) fn check_custom_theme(v: &Value) -> Option<Problem> {
    if v.is_null() {
        return None;
    }
    let Some(t) = v.as_object() else {
        return Some(Problem::new(CUSTOM_THEME_KEY, "object 여야 합니다", v));
    };
    if let Some(m) = t.get("mode")
        && !matches!(m.as_str(), Some("dark" | "light"))
    {
        return Some(Problem::new(
            format!("{CUSTOM_THEME_KEY}.mode"),
            r#""dark" 또는 "light" 여야 합니다"#,
            m,
        ));
    }
    for sec in THEME_SECTIONS {
        let Some(raw) = t.get(sec) else {
            continue;
        };
        let Some(colors) = raw.as_object() else {
            return Some(Problem::new(
                format!("{CUSTOM_THEME_KEY}.{sec}"),
                "object 여야 합니다",
                raw,
            ));
        };
        let mut keys: Vec<&String> = colors.keys().collect();
        keys.sort();
        for k in keys {
            let c = &colors[k];
            if !c.as_str().is_some_and(|s| THEME_COLOR.is_match(s)) {
                return Some(Problem::new(
                    format!("{CUSTOM_THEME_KEY}.{sec}.{k}"),
                    "#rrggbb 또는 #rrggbbaa 색이어야 합니다",
                    c,
                ));
            }
        }
    }
    None
}
