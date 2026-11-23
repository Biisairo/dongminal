//! Go 기준선 `dongminal/internal/shared/statusline` 의 Rust 포팅. RUST_PORT_SRS 참고.
//!
//! Claude Code statusLine 입력의 허용 목록이다 (ISSUE_AGENT_TREE_SRS FR-SLP-2·2a · PROD2 §6).
//! 목록은 이 crate 의 타입 **한 벌**이다. 끝 필드는 `Option` 이다 — "관측이 없다" 와 "0 이다" 를 가른다.
//! 값이 null·없음·다른 타입이면 그 필드를 싣지 않는다.

use std::collections::BTreeMap;
use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

mod subagents;

pub use subagents::{SUBAGENT_MAX_TASKS, Subagent, subagents_from_input};

type Obj = Map<String, Value>;

/// `path`(점으로 이은 입력 이름)의 값. 없거나 null 이면 `None`.
fn lookup<'a>(m: &'a Obj, path: &str) -> Option<&'a Value> {
    let mut parts = path.split('.');
    let mut cur = m.get(parts.next()?)?;
    for k in parts {
        cur = cur.as_object()?.get(k)?;
    }
    (!cur.is_null()).then_some(cur)
}

fn str_at(m: &Obj, path: &str) -> Option<String> {
    lookup(m, path)?.as_str().map(str::to_owned)
}

fn num_at(m: &Obj, path: &str) -> Option<f64> {
    lookup(m, path)?.as_f64()
}

fn bool_at(m: &Obj, path: &str) -> Option<bool> {
    lookup(m, path)?.as_bool()
}

fn obj_at<'a>(m: &'a Obj, path: &str) -> Option<&'a Obj> {
    lookup(m, path)?.as_object()
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename = "statusline.Model")]
pub struct Model {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(rename = "displayName", skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename = "statusline.Cost")]
#[serde(rename_all = "camelCase")]
pub struct Cost {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_cost_usd: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_duration_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_api_duration_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_lines_added: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_lines_removed: Option<f64>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename = "statusline.CurrentUsage")]
#[serde(rename_all = "camelCase")]
pub struct CurrentUsage {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_tokens: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_tokens: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_creation_input_tokens: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_read_input_tokens: Option<f64>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename = "statusline.ContextWindow")]
#[serde(rename_all = "camelCase")]
pub struct ContextWindow {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_input_tokens: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_output_tokens: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window_tokens: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub used_pct: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remaining_pct: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_usage: Option<CurrentUsage>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename = "statusline.RateWindow")]
#[serde(rename_all = "camelCase")]
pub struct RateWindow {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub used_pct: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resets_at: Option<f64>,
}

/// statusLine 입력에서 내보내도 되는 값 전부다. 경로·본문(`transcript_path`·`cwd`·`workspace.*`)은
/// 여기 없으므로 나가지 않는다 (FR-SLP-2a). 필드 순서·이름은 Go 와 같다.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename = "statusline.Usage")]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<Model>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fast_mode: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_style: Option<String>,
    #[serde(rename = "exceeds200k", skip_serializing_if = "Option::is_none")]
    pub exceeds_200k: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost: Option<Cost>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_window: Option<ContextWindow>,
    /// 키는 바이트 순으로 나간다(Go map 과 같다).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rate_limits: Option<BTreeMap<String, RateWindow>>,
}

/// 비지 않았으면 `Some`. 하나도 채우지 못한 구조체는 싣지 않는다.
fn some_if<T: Default + PartialEq>(v: T) -> Option<T> {
    (v != T::default()).then_some(v)
}

impl Model {
    fn fill(m: &Obj) -> Option<Self> {
        some_if(Self {
            id: str_at(m, "id"),
            display_name: str_at(m, "display_name"),
        })
    }
}

impl Cost {
    fn fill(m: &Obj) -> Option<Self> {
        some_if(Self {
            total_cost_usd: num_at(m, "total_cost_usd"),
            total_duration_ms: num_at(m, "total_duration_ms"),
            total_api_duration_ms: num_at(m, "total_api_duration_ms"),
            total_lines_added: num_at(m, "total_lines_added"),
            total_lines_removed: num_at(m, "total_lines_removed"),
        })
    }
}

impl CurrentUsage {
    fn fill(m: &Obj) -> Option<Self> {
        some_if(Self {
            input_tokens: num_at(m, "input_tokens"),
            output_tokens: num_at(m, "output_tokens"),
            cache_creation_input_tokens: num_at(m, "cache_creation_input_tokens"),
            cache_read_input_tokens: num_at(m, "cache_read_input_tokens"),
        })
    }
}

impl ContextWindow {
    fn fill(m: &Obj) -> Option<Self> {
        some_if(Self {
            total_input_tokens: num_at(m, "total_input_tokens"),
            total_output_tokens: num_at(m, "total_output_tokens"),
            window_tokens: num_at(m, "context_window_size"),
            used_pct: num_at(m, "used_percentage"),
            remaining_pct: num_at(m, "remaining_percentage"),
            current_usage: obj_at(m, "current_usage").and_then(CurrentUsage::fill),
        })
    }
}

impl RateWindow {
    fn fill(m: &Obj) -> Option<Self> {
        some_if(Self {
            used_pct: num_at(m, "used_percentage"),
            resets_at: num_at(m, "resets_at"),
        })
    }
}

/// 한도 창의 이름은 판마다 늘 수 있다. 이름 모양만 거른다.
static RATE_NAME: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[a-z0-9_]{1,32}$").expect("고정 정규식"));

fn rate_limits(m: &Obj) -> Option<BTreeMap<String, RateWindow>> {
    let out: BTreeMap<String, RateWindow> = obj_at(m, "rate_limits")?
        .iter()
        .filter(|(name, _)| RATE_NAME.is_match(name))
        .filter_map(|(name, w)| Some((name.clone(), RateWindow::fill(w.as_object()?)?)))
        .collect();
    (!out.is_empty()).then_some(out)
}

/// statusLine 입력에서 허용 목록의 값만 꺼낸다. 실을 값이 하나도 없거나 입력이 객체가 아니면 `None`.
pub fn from_input(raw: &[u8]) -> Option<Usage> {
    let v: Value = dm_gocompat::json::unmarshal(raw).ok()?;
    let m = v.as_object()?;
    some_if(Usage {
        session_id: str_at(m, "session_id"),
        version: str_at(m, "version"),
        model: obj_at(m, "model").and_then(Model::fill),
        effort: str_at(m, "effort.level"),
        thinking: bool_at(m, "thinking.enabled"),
        fast_mode: bool_at(m, "fast_mode"),
        output_style: str_at(m, "output_style.name"),
        exceeds_200k: bool_at(m, "exceeds_200k_tokens"),
        cost: obj_at(m, "cost").and_then(Cost::fill),
        context_window: obj_at(m, "context_window").and_then(ContextWindow::fill),
        rate_limits: rate_limits(m),
    })
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod decode_tests {
    use super::*;

    /// 기록을 다시 읽는다 — 데몬·서버가 보고 본문을 해석한다 (agentrec).
    #[test]
    fn usage_round_trips_through_json() {
        let u = Usage {
            session_id: Some("s".into()),
            model: Some(Model {
                id: Some("m".into()),
                display_name: Some("M".into()),
            }),
            exceeds_200k: Some(true),
            context_window: Some(ContextWindow {
                used_pct: Some(12.5),
                current_usage: Some(CurrentUsage {
                    input_tokens: Some(3.0),
                    ..CurrentUsage::default()
                }),
                ..ContextWindow::default()
            }),
            rate_limits: Some(BTreeMap::from([(
                "five_hour".to_owned(),
                RateWindow {
                    used_pct: Some(40.0),
                    resets_at: Some(1.0),
                },
            )])),
            ..Usage::default()
        };
        let raw = dm_gocompat::json::marshal(&u).unwrap();
        assert_eq!(dm_gocompat::json::unmarshal::<Usage>(&raw).unwrap(), u);
        let s: Subagent =
            dm_gocompat::json::unmarshal(br#"{"id":"a","agentType":"Explore","tokens":5}"#)
                .unwrap();
        assert_eq!(
            (s.id.as_deref(), s.agent_type.as_deref(), s.tokens),
            (Some("a"), Some("Explore"), Some(5.0))
        );
        let err = dm_gocompat::json::unmarshal::<Usage>(br#"{"thinking":"x"}"#).unwrap_err();
        assert_eq!(
            err.to_string(),
            "json: cannot unmarshal string into Go struct field Usage.thinking of type bool"
        );
    }
}
