//! 간선(노드)의 와이어 (PEER_DAEMON_SRS §3.5a). FEATURE_EDGE 를 양쪽이 말할 때만 쓴다.

use otter_gocompat::json::{self, RawMessage};
use serde::{Deserialize, Serialize};

/// 로컬 API 연산 하나다 (FR-PDM-30). args 는 HTTP 요청 본문 그대로다.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "toolipc.EdgeParams")]
pub struct EdgeParams {
    #[serde(skip_serializing_if = "json::is_empty")]
    pub args: RawMessage,
    #[serde(rename = "ifMatch", skip_serializing_if = "json::is_empty")]
    pub if_match: String,
    pub op: String,
}

/// 그 답이다. code 가 비지 않으면 오류이고 body 가 없다.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "toolipc.EdgeResult")]
pub struct EdgeResult {
    #[serde(skip_serializing_if = "json::is_empty")]
    pub body: RawMessage,
    #[serde(skip_serializing_if = "json::is_empty")]
    pub code: String,
    #[serde(skip_serializing_if = "json::is_empty")]
    pub etag: String,
    #[serde(skip_serializing_if = "json::is_empty")]
    pub message: String,
    pub status: i64,
}

/// 서버가 연 노드 포트의 상태다 (FR-PDM-14).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "toolipc.EdgePortParams")]
pub struct EdgePortParams {
    #[serde(skip_serializing_if = "json::is_empty")]
    pub addr: String,
    #[serde(skip_serializing_if = "json::is_empty")]
    pub error: String,
    #[serde(skip_serializing_if = "json::is_empty")]
    pub listening: bool,
}

/// 맺거나 지운 간선 하나다 (EDGE_PAIRING_SRS FR-EPR-5·23).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "toolipc.EdgeRef")]
pub struct EdgeRef {
    pub fp: String,
    pub name: String,
}

/// edges push 다 (FR-PDM-27). 이 구조체만 필드가 사전순이 아니다(Go 선언 순서).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "toolipc.EdgesEvent")]
pub struct EdgesEvent {
    pub event: String,
    #[serde(skip_serializing_if = "json::is_empty")]
    pub paired: Option<EdgeRef>,
    #[serde(skip_serializing_if = "json::is_empty")]
    pub removed: Option<EdgeRef>,
    /// removed 를 상대가 지웠다 (FR-EPR-23).
    #[serde(rename = "byPeer", skip_serializing_if = "json::is_empty")]
    pub by_peer: bool,
    /// 망 이웃이 보낸 간선 초대를 받았다 (EDGE_MESH_SRS FR-EGM-64).
    #[serde(skip_serializing_if = "json::is_empty")]
    pub invited: Option<EdgeRef>,
}
