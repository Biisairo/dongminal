//! Go 기준선 `otterminal/internal/webserver/toolclient` 의 Rust 포팅. RUST_PORT_SRS 참고.
//!
//! 웹 서버가 데몬(otterminald) 소켓에 붙는 클라이언트다. 줄 단위 JSON RPC, push 배달, 재접속
//! 감독(지수 백오프·데몬 재기동·생존 확인)과 재접속 뒤의 재동기를 맡는다.

mod client;
mod error;
mod ext;
mod hub;
mod push;
mod wire;

pub use client::{
    AttnCallback, ChatCallback, EdgesCallback, ExitCallback, ForegroundCallback, OutputCallback,
    ReportCallback, ResyncCallback, SpawnDaemon, TOOL_CALL_TIMEOUT, TOOL_CREATE_TIMEOUT,
    TOOL_DIAL_TIMEOUT, TOOL_HEARTBEAT_EVERY, TOOL_MAX_BACKOFF, TOOL_RECONNECT_BACKOFF,
    TOOL_RESPAWN_EVERY, ToolClient,
};
pub use error::Error;
pub use ext::EDGE_CALL_WITHIN;
pub use hub::{LIST_CACHE_TTL, ToolIdentity};
pub use push::Unsubscribe;

#[cfg(test)]
mod tests;
