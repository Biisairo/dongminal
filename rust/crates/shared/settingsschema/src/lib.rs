//! Go 기준선 `dongminal/internal/shared/settingsschema` 의 Rust 포팅. RUST_PORT_SRS 참고.
//!
//! 브라우저 설정 블롭의 서술자 표를 읽는다 (CONFIG_MANAGEMENT_SRS 묶음 S·C). **표는 여기 없다.**
//! 원천은 `web/js/core/settings-schema.js` 이고, 이 crate 는 임베드된 그 **같은 바이트**를 읽는다
//! (FR-CFG-10).

use std::collections::{BTreeMap, HashMap};
use std::fmt;

use serde::{Deserialize, Serialize};
use serde_json::Value;

mod theme;

pub use theme::CUSTOM_THEME_KEY;

/// 원천 파일의 임베드 안 경로다.
pub const SCHEMA_PATH: &str = "js/core/settings-schema.js";

// 형태 계약 (FR-CFG-2): 파일 어딘가에 `const SETTINGS_SCHEMA = [ ... ];` 가 있고 대괄호 안이 순수 JSON 이다.
const SCHEMA_OPEN: &[u8] = b"const SETTINGS_SCHEMA = [";
const SCHEMA_CLOSE: &[u8] = b"\n];";

/// 블롭 키 하나의 서술자다. 필드 이름과 순서는 Go 구조체와 같다.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename = "settingsschema.Spec")]
pub struct Spec {
    pub key: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub def: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max: Option<i64>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub off: bool,
    #[serde(rename = "where")]
    pub where_: String,
}

/// 값 하나가 서술자를 벗어난 사실이다.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Problem {
    pub key: String,
    pub reason: String,
    pub got: Value,
}

impl Problem {
    fn new(key: impl Into<String>, reason: impl Into<String>, got: &Value) -> Self {
        Self {
            key: key.into(),
            reason: reason.into(),
            got: got.clone(),
        }
    }
}

/// 표 읽기·검증의 오류. `Display` 는 Go `err.Error()` 와 같은 문구다.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Error(String);

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Error {}

/// 원천 파일의 바이트다.
pub fn raw() -> Result<std::borrow::Cow<'static, [u8]>, Error> {
    dm_web_assets::get(SCHEMA_PATH).ok_or_else(|| {
        Error(format!(
            "서술자 표를 열지 못했습니다 ({SCHEMA_PATH}): open {SCHEMA_PATH}: file does not exist"
        ))
    })
}

/// 형태 계약에 따라 JSON 배열 부분(`[` … `]`)만 잘라낸다.
pub fn extract(src: &[u8]) -> Result<&[u8], Error> {
    let i = find(src, SCHEMA_OPEN)
        .ok_or_else(|| Error("`const SETTINGS_SCHEMA = [` 를 찾지 못했습니다".into()))?;
    let start = i + SCHEMA_OPEN.len() - 1;
    let j = find(&src[start..], SCHEMA_CLOSE)
        .ok_or_else(|| Error("표의 끝(`\\n];`)을 찾지 못했습니다".into()))?;
    Ok(&src[start..start + j + 2])
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

/// 원천 표를 읽어 서술자를 돌려준다. 표에 모르는 필드가 있으면 오류다 (FR-CFG-2).
pub fn load() -> Result<Vec<Spec>, Error> {
    let src = raw()?;
    let body = extract(&src)?;
    dm_gocompat::json::Decoder::new()
        .disallow_unknown_fields()
        .decode::<Option<Vec<Spec>>>(body)
        .map(Option::unwrap_or_default)
        .map_err(|e| Error(format!("서술자 표가 순수 JSON 이 아닙니다 (FR-CFG-2): {e}")))
}

/// 형태 계약만 확인한다 — 검사와 게이트가 부른다.
pub fn check_shape() -> Result<(), Error> {
    check_specs(&load()?)
}

/// 블롭을 서술자에 대조한다 (FR-CFG-8·9). 첫 오류에서 멈추지 않는다. 알 수 없는 키는
/// 둘째 반환값(경고)이다. 블롭이 JSON 객체(또는 null)가 아니면 오류다.
pub fn validate(specs: &[Spec], blob: &[u8]) -> Result<(Vec<Problem>, Vec<String>), Error> {
    let m = dm_gocompat::json::unmarshal::<Option<serde_json::Map<String, Value>>>(blob)
        .map_err(|e| Error(format!("JSON 이 아닙니다: {e}")))?;
    Ok(validate_object(specs, &m.unwrap_or_default()))
}

/// 설정 블롭의 `customTheme` 만 본다 — `PUT /api/settings` 가 부른다 (FR-QG-11). 블롭이
/// 객체가 아니거나 키가 없으면 통과다. 블롭이 JSON 인지는 부르는 쪽이 본다.
pub fn check_theme_blob(blob: &[u8]) -> Option<Problem> {
    use dm_gocompat::json::{RawMessage, unmarshal};
    let m = unmarshal::<Option<BTreeMap<String, RawMessage>>>(blob).ok()??;
    let raw = m.get(CUSTOM_THEME_KEY)?;
    let v = unmarshal::<Value>(&raw.0).ok()?;
    theme::check_custom_theme(&v)
}

/// 서술자 목록의 형태를 확인한다 — Go `CheckShape` 에서 표를 읽은 뒤의 검사다.
pub fn check_specs(specs: &[Spec]) -> Result<(), Error> {
    if specs.is_empty() {
        return Err(Error("서술자 표가 비었습니다".into()));
    }
    let mut seen = std::collections::HashSet::new();
    for s in specs {
        if s.key.is_empty() {
            return Err(Error("key 가 빈 서술자가 있습니다".into()));
        }
        if !seen.insert(s.key.as_str()) {
            return Err(Error(format!("키가 두 번 나옵니다: {}", s.key)));
        }
        match s.kind.as_str() {
            "string" | "bool" | "int" | "object" | "array" | "any" => {}
            _ => {
                return Err(Error(format!(
                    "{}: 알 수 없는 type {}",
                    s.key,
                    dm_gocompat::strconv::quote(&s.kind)
                )));
            }
        }
        if s.where_.is_empty() {
            return Err(Error(format!("{}: where 가 비었습니다", s.key)));
        }
    }
    Ok(())
}

/// 키로 찾을 수 있게 묶는다. 같은 키가 두 번이면 뒤의 것이 남는다.
pub fn by_key(specs: &[Spec]) -> HashMap<String, Spec> {
    specs.iter().map(|s| (s.key.clone(), s.clone())).collect()
}

/// 정렬된 키 목록이다.
pub fn keys(specs: &[Spec]) -> Vec<String> {
    let mut out: Vec<String> = specs.iter().map(|s| s.key.clone()).collect();
    out.sort();
    out
}

/// 디코드한 블롭(객체)을 서술자에 대조한다 (FR-CFG-8·9). 첫 오류에서 멈추지 않는다.
/// 알 수 없는 키는 둘째 반환값(경고)이다. 키는 바이트 순으로 돈다.
pub fn validate_object(
    specs: &[Spec],
    blob: &serde_json::Map<String, Value>,
) -> (Vec<Problem>, Vec<String>) {
    let by = by_key(specs);
    let sorted: BTreeMap<&str, &Value> = blob.iter().map(|(k, v)| (k.as_str(), v)).collect();
    let mut probs = Vec::new();
    let mut unknown = Vec::new();
    for (k, v) in sorted {
        match by.get(k) {
            None => unknown.push(k.to_string()),
            Some(spec) => {
                if let Some(p) = check(spec, v) {
                    probs.push(p);
                }
            }
        }
    }
    (probs, unknown)
}

/// 값 하나를 서술자에 댄다. `None` 이면 통과.
pub fn check(s: &Spec, v: &Value) -> Option<Problem> {
    // null 은 "정한 적 없음" 이다.
    if v.is_null() {
        return None;
    }
    // QUALITY_GO_SRS FR-QG-10: 값이 화면의 스타일에 닿는 키다.
    if s.key == CUSTOM_THEME_KEY {
        return theme::check_custom_theme(v);
    }
    let bad = |reason: &str| Some(Problem::new(&s.key, reason, v));
    match s.kind.as_str() {
        "bool" if !v.is_boolean() => bad("bool 이어야 합니다"),
        "string" if !v.is_string() => bad("string 이어야 합니다"),
        "array" if !v.is_array() => bad("array 여야 합니다"),
        "object" if !v.is_object() => bad("object 여야 합니다"),
        "int" => {
            let Some(f) = v.as_f64() else {
                return bad("정수여야 합니다");
            };
            let n = f as i64;
            if n as f64 != f {
                return bad("정수여야 합니다");
            }
            // FR-PIS-9: `0` 이 "그 계층을 걸지 않는다" 를 뜻하는 키만 0 을 통과시킨다.
            if n == 0 && s.off {
                return None;
            }
            if let Some(min) = s.min.filter(|&m| n < m) {
                return bad(&format!("최솟값 {min} 보다 작습니다"));
            }
            if let Some(max) = s.max.filter(|&m| n > m) {
                return bad(&format!("최댓값 {max} 보다 큽니다"));
            }
            None
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests;
