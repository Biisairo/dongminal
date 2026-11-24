//! Go 기준선 `dongminal/internal/webserver/domain/lsp` 의 Rust 포팅. RUST_PORT_SRS 참고.
//!
//! 언어 서버 세션 계층이다. **여기에 서버 목록이 없다** — 무엇을 띄울지는 ext 의 선언이 정한다.
//! 프레이밍·프로세스·세션 상한·유휴 정리·파일 변경 알림을 맡는다.

mod codec;
mod process;
mod service;
mod watch;

pub use codec::{ERR_HEADER_TOO_LARGE, read_frame, write_frame};
pub use process::{Conn, Starter, start_process};
pub use service::{
    IDLE_AFTER, MAX_SESSIONS, MAX_TEXT_BYTES, NowFn, OpenError, PathsError, SWEEP_EVERY, Service,
    Tunnel,
};
pub use watch::{
    DEFAULT_WATCH_MAX, ExistsFn, FileEvent, FileNotifier, NameStatus, RepoSnap, RepoView,
    RepoWatch, WATCH_CHANGED, WATCH_CREATED, WATCH_DELETED,
};

#[cfg(test)]
mod tests;
