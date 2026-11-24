//! Go 기준선 `dongminal/internal/shared/toolipc` 의 Rust 포팅. RUST_PORT_SRS 참고.
//!
//! dongminal(웹 서버)과 dongminald(데몬) 사이 IPC RPC 의 와이어 포맷만 담는다. 서버측 구현은
//! daemon ipc, 클라측 구현은 webserver toolclient 이며 둘은 이 crate 의 타입만 공유한다.
//!
//! 구조체 필드는 JSON 키의 사전순이다(종전 와이어가 map 이었다, FR-OPT-0-3). `[]byte` 필드는
//! 언제나 base64 문자열로 나간다(빈 것은 `""`).

mod attention;
mod chat;
mod edge;
mod protocol;
mod wire;

pub use attention::*;
pub use chat::*;
pub use edge::*;
pub use protocol::*;
pub use wire::*;

/// 도는 데몬이 자기 지문을 남기는 자리다 (DAEMON_STALENESS_SRS FR-DFP-4). `paned.pid` 의 옆이다.
pub const DAEMON_BUILD_FILE: &str = "paned.build";

#[cfg(test)]
mod tests;
