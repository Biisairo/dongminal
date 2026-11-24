use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{num_at, str_at};

/// 한 보고에 싣는 서브에이전트의 최대 수다 (SUBAGENT_USAGE_SRS FR-SAU-4).
pub const SUBAGENT_MAX_TASKS: usize = 32;

/// subagentStatusLine 입력의 `tasks` 원소에서 내보내도 되는 값 전부다 (FR-SAU-1·2).
/// `label` 과 경로(`cwd`)는 나가지 않는다 (FR-SAU-3). `effort` 는 글자이면 `effort`, 수이면 `effortBudget` 이다.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename = "statusline.Subagent")]
#[serde(rename_all = "camelCase")]
pub struct Subagent {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effort_budget: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window_tokens: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tokens: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_time: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct TasksIn {
    tasks: Option<Vec<Value>>,
}

/// subagentStatusLine 입력의 `tasks` 에서 허용 목록의 값만 꺼낸다. `tasks` 가 배열이 아니면
/// `None` 이다. 빈 배열은 빈 목록이다. id 가 없는 원소는 버리고, 앞에서부터
/// [`SUBAGENT_MAX_TASKS`] 개만 싣는다.
pub fn subagents_from_input(raw: &[u8]) -> Option<Vec<Subagent>> {
    let tasks = otter_gocompat::json::unmarshal::<TasksIn>(raw)
        .ok()?
        .tasks?;
    let mut out = Vec::with_capacity(tasks.len().min(SUBAGENT_MAX_TASKS));
    for t in &tasks {
        if out.len() == SUBAGENT_MAX_TASKS {
            break;
        }
        let Some(m) = t.as_object() else {
            continue;
        };
        let s = Subagent {
            id: str_at(m, "id"),
            agent_type: str_at(m, "agentType"),
            status: str_at(m, "status"),
            model: str_at(m, "model"),
            effort: str_at(m, "effort"),
            effort_budget: num_at(m, "effort"),
            window_tokens: num_at(m, "contextWindowSize"),
            tokens: num_at(m, "tokenCount"),
            start_time: num_at(m, "startTime"),
            description: str_at(m, "description"),
        };
        if s.id.is_some() {
            out.push(s);
        }
    }
    Some(out)
}
