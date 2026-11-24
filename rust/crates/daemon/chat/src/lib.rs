//! Go 기준선 `otterminal/internal/daemon/chat` 의 Rust 포팅. RUST_PORT_SRS 참고.
//!
//! 데몬의 채팅 핵심이다 (PEER_CHAT_SRS §3.9). 간선 상대마다 채팅 연결을 하나 열어 두고, 노드 상태
//! 알림과 글을 서명해 망에 퍼뜨린다. 노드는 자기 참가자에 대해서만 말하고, 글은 그 순간 방에 있는
//! 참가자에게 넘긴 뒤 버린다. 디스크에 아무것도 쓰지 않는다 (NFR-PCH-1).

mod error;
mod frame;
mod human;
mod limit;
mod service;
mod upper;
mod view;

pub use error::{
    CODE_BAD_REQUEST, CODE_NO_SUCH_PARTICIPANT, CODE_NO_SUCH_ROOM, CODE_NOT_IN_ROOM,
    CODE_RATE_LIMITED, CODE_TOO_LARGE, Error,
};
pub use service::{
    DeliverFn, KIND_AGENT, KIND_DIRECT, KIND_GROUP, KIND_USER, MAX_PARTICIPANTS, MAX_TEXT, Member,
    Message, NodeInfo, NowFn, OnlineView, Options, PER_MINUTE, Participant, PinFn, RoomInfo,
    Service,
};

#[cfg(test)]
mod tests;
#[cfg(test)]
mod tests_human;
