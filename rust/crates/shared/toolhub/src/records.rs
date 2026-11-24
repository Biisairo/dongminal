use std::fmt;

use otter_gocompat::json;
use serde::{Deserialize, Serialize};

use crate::{ActivityState, TurnState};

/// 도구 하나의 활동·알람 상태를 옮기는 모양이다. 서버의 거울과 데몬의 Tool 이 같이 쓴다 (D-ARD-8).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "toolhub.AgentState")]
pub struct AgentState {
    #[serde(skip_serializing_if = "json::is_empty")]
    pub activity: Option<ActivityState>,
    #[serde(rename = "agentSeen")]
    pub agent_seen: bool,
    pub armed: bool,
    pub attention: bool,
    #[serde(rename = "lastOutputAt")]
    pub last_output_at: i64,
    #[serde(rename = "rearmLocked")]
    pub rearm_locked: bool,
    pub turn: TurnState,
}

/// 도구 프로세스가 끝난 사정이다. 신호로 죽었으면 -1, 모르면 0.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "toolhub.ExitInfo")]
pub struct ExitInfo {
    pub code: i64,
}

/// 사람이 읽을 한 줄이다. 코드가 0 이면 "".
impl fmt::Display for ExitInfo {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.code == 0 {
            return Ok(());
        }
        write!(f, "exit {}", self.code)
    }
}
