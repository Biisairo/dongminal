//! Go 기준선 `otterminal/internal/daemon/ipc` 의 Rust 포팅. RUST_PORT_SRS 참고.
//!
//! 데몬의 paned 소켓 서버(서버 연결 하나의 RPC 와 push)와 보고 소켓(에이전트 보고·데몬 교체 제어)이다.
//! 소켓은 platform 의 동기 API 위에서 연결마다 읽기·쓰기 스레드로 돌고, 느린 요청과 async 연산은
//! 생성 때 잡은 tokio 런타임에서 돈다 (FR-RSP-33·36).

mod conn;
mod handlers;
mod records;
mod report;
mod server;

pub use conn::{PANED_EDGE_SLOW_MAX, PANED_OUT_QUEUE, PANED_SLOW_MAX, SERIAL_QUEUE_MAX};
pub use handlers::{ERR_NO_SERVER, ERR_TOOL_QUEUE_FULL};
pub use records::ERR_RECORD_SHAPE;
pub use report::{ERR_REPORT_OLD_SERVER, ERR_REPORT_STATE, ERR_REPORT_TOOL_ID, RELOAD_WITHIN};
pub use server::{ChatUser, DIAL_PROBE_TIMEOUT, PanedServer, Reloader};

#[cfg(test)]
mod tests;
