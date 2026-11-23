use std::fmt;

use dm_gocompat::json::RawMessage;
use serde::{Deserialize, Serialize};

/// 데몬 IPC 의 문법 판이다 (VERSION_HEALTH_SRS FR-VHL-1). 빌드 판과 다르다.
pub const PROTOCOL_VERSION: i64 = 1;

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "toolipc.PanedRequest")]
pub struct PanedRequest {
    pub id: i64,
    pub method: String,
    pub params: RawMessage,
}

/// 성공 응답이다. Go 의 `Result any` 는 보내는 쪽이 정한 값이고, 받는 쪽은 보통 `RawMessage` 로 푼다.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "toolipc.PanedResponse")]
pub struct PanedResponse<T = RawMessage> {
    pub id: i64,
    pub result: T,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "toolipc.PanedError")]
pub struct PanedError {
    pub id: i64,
    pub error: PanedErrObj,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "toolipc.PanedErrObj")]
pub struct PanedErrObj {
    pub code: i64,
    pub message: String,
}

/// JSON-RPC 오류 코드 (M8 D-A-16). 앞의 넷은 JSON-RPC 2.0 예약 코드다.
pub const CODE_METHOD_NOT_FOUND: i64 = -32601;
pub const CODE_INVALID_PARAMS: i64 = -32602;
pub const CODE_INTERNAL: i64 = -32603;
pub const CODE_SERVER: i64 = -32000;
/// 도구 수 상한(toolhub ErrToolCap)이 프로세스 경계를 코드로 건넌다.
pub const CODE_TOOL_CAP: i64 = -32010;
/// 요청한 도구가 없다 (FR-OPT-2-5). 내부 오류와 가른다.
pub const CODE_NOT_FOUND: i64 = -32011;

/// 클라이언트가 받은 오류 응답이다.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
}

impl fmt::Display for RpcError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "paned error: {}", self.message)
    }
}

impl std::error::Error for RpcError {}
