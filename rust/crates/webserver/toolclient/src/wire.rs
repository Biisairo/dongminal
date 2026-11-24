use std::collections::BTreeMap;

use otter_gocompat::json::{self, RawMessage};
use otter_shared_chatwire as chatwire;
use otter_shared_toolhub::AgentState;
use otter_shared_toolipc::{EdgeRef, PanedErrObj};
use serde::{Deserialize, Serialize};

/// 데몬이 보내는 줄 하나의 모든 모양이다 — 응답(id·result·error)과 push(event 와 그 필드).
/// 한 번의 해석으로 끝낸다 (IPC-13).
#[derive(Debug, Default, Deserialize)]
#[serde(default, rename = "toolclient.wireMsg")]
pub(crate) struct WireMsg {
    pub id: Option<i64>,
    pub result: RawMessage,
    pub error: Option<PanedErrObj>,

    pub event: String,
    pub tool: String,
    #[serde(deserialize_with = "json::bytes::deserialize")]
    pub data: Vec<u8>,
    pub end: i64,
    pub code: i64,
    pub cols: u16,
    pub rows: u16,
    pub name: String,
    pub kind: String,
    pub value: RawMessage,
    pub method: String,
    pub body: RawMessage,
    pub reason: String,
    pub agent: AgentState,
    pub paired: Option<EdgeRef>,
    pub removed: Option<EdgeRef>,
    #[serde(rename = "byPeer")]
    pub by_peer: bool,
    pub invited: Option<EdgeRef>,
    #[serde(rename = "chatKind")]
    pub chat_kind: String,
    pub chat: Option<chatwire::Message>,
}

/// 값 오류로 해석하지 못한 줄에서 id 와 event 만 건진다. Go 는 타입 오류가 나도 나머지 필드를
/// 채우므로, 응답이면 그 오류를 호출자에게 돌려주고 push 면 버린다.
pub(crate) fn probe(line: &[u8]) -> (Option<i64>, String) {
    let Ok(m) = json::Decoder::new().decode::<BTreeMap<String, RawMessage>>(line) else {
        return (None, String::new());
    };
    let id = m
        .get("id")
        .and_then(|v| json::unmarshal::<Option<i64>>(&v.0).ok())
        .flatten();
    let event = m
        .get("event")
        .and_then(|v| json::unmarshal::<String>(&v.0).ok())
        .unwrap_or_default();
    (id, event)
}

/// hello 결과를 받는 쪽의 모양이다 — version 이 **없는 것**과 0 인 것을 가르려고 `Option` 이다.
#[derive(Debug, Default, Deserialize)]
#[serde(default, rename = "toolclient.helloReply")]
pub(crate) struct HelloReply {
    pub build: String,
    pub features: Option<Vec<String>>,
    pub version: Option<i64>,
}

#[derive(Serialize)]
pub(crate) struct OutRequest<'a, P: ?Sized> {
    pub id: i64,
    pub method: &'a str,
    pub params: &'a P,
}

/// 응답 없는 알림이다 (FR-OPT-2-2). id 가 없다.
#[derive(Serialize)]
pub(crate) struct NotifyRequest<'a, P: ?Sized> {
    pub method: &'a str,
    pub params: &'a P,
}

/// Go `struct{}{}` — `{}` 로 나간다.
#[derive(Serialize)]
pub(crate) struct Empty {}
