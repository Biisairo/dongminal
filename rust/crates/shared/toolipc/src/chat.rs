//! 사람 참가자의 채팅 와이어 (PEER_CHAT_SRS §3.11). FEATURE_CHAT 을 양쪽이 말할 때만 쓴다.

use dm_gocompat::json::{self, RawMessage};
use dm_shared_chatwire as chatwire;
use serde::{Deserialize, Serialize};

/// 사람 참가자의 연산 하나다. op 는 chatwire 의 call op 와 state 다.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "toolipc.ChatParams")]
pub struct ChatParams {
    #[serde(skip_serializing_if = "json::is_empty")]
    pub args: RawMessage,
    pub op: String,
}

/// 그 답이다. error 가 있으면 result 가 없다.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "toolipc.ChatResult")]
pub struct ChatResult {
    #[serde(skip_serializing_if = "json::is_empty")]
    pub error: Option<chatwire::Error>,
    #[serde(skip_serializing_if = "json::is_empty")]
    pub result: RawMessage,
}

pub const CHAT_KIND_MSG: &str = "msg";
pub const CHAT_KIND_CHANGED: &str = "changed";

/// chat push 다. msg 는 사람에게 온 글을, changed 는 온라인 목록·방이 바뀌었음을 알린다.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "toolipc.ChatEvent")]
pub struct ChatEvent {
    #[serde(skip_serializing_if = "json::is_empty")]
    pub chat: Option<chatwire::Message>,
    #[serde(rename = "chatKind")]
    pub chat_kind: String,
    pub event: String,
}
