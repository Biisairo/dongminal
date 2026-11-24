//! 알람 판정의 와이어 (AGENT_RECORD_DAEMON_SRS §3.3a).

use otter_gocompat::json::{self, RawMessage};
use otter_shared_toolhub::AgentState;
use serde::{Deserialize, Serialize};

pub const ATTN_KIND_ATTENTION: &str = "attention";
pub const ATTN_KIND_CLEAR: &str = "clear";
pub const ATTN_KIND_ACTIVITY: &str = "activity";

/// 판정 설정이다 (FR-ARD-31). idle_ms 가 0 이면 유휴 판정을 끈다.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "toolipc.AttnConfigParams")]
pub struct AttnConfigParams {
    #[serde(rename = "idleMs")]
    pub idle_ms: i64,
    #[serde(rename = "allowBell")]
    pub allow_bell: bool,
}

/// 도구 하나의 알람 해제다 (FR-ARD-32). typed 는 키를 눌렀는가다.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "toolipc.AttendParams")]
pub struct AttendParams {
    pub tool: String,
    #[serde(skip_serializing_if = "json::is_empty")]
    pub typed: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "toolipc.AttendAllResult")]
pub struct AttendAllResult {
    pub cleared: i64,
}

/// 서버 HTTP 로 온 보고다. 보고 소켓의 요청과 같은 모양이다.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "toolipc.ReportParams")]
pub struct ReportParams {
    pub method: String,
    pub body: RawMessage,
}

/// attn push 다. agent 는 알린 뒤의 상태다.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "toolipc.AttnEvent")]
pub struct AttnEvent {
    pub event: String,
    pub tool: String,
    pub kind: String,
    #[serde(skip_serializing_if = "json::is_empty")]
    pub reason: String,
    pub agent: AgentState,
}
