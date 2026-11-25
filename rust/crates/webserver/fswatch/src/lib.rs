//! Go 기준선 `otterminal/internal/webserver/fswatch` 의 Rust 포팅. RUST_PORT_SRS 참고.
//!
//! 화면에 보이는 디렉터리를 비재귀로 감시해 바뀐 항목을 알린다 (EDITOR_LIVE_RELOAD_SRS 묶음 W).
//! 규칙은 VS Code 의 비재귀 감시자와 병합을 옮긴 것이다 (D-6). API 는 동기다 — 감시와 타이머는
//! 전용 스레드에서 돈다. emit 은 그 스레드에서 불리므로 오래 막지 않는다.

mod backend;
mod coalesce;
mod manager;
mod os;
mod pipeline;
mod tree;

pub use backend::{Backend, BackendError, BackendMsg, NewBackend, new_notify_backend};
pub use coalesce::{Change, Kind, coalesce};
pub use manager::{Dir, MAX_RESTARTS, Manager, ManagerOptions, NotAttached, WatchableFn};
pub use os::{FS_CASE_SENSITIVE, FS_NFC, KQUEUE_ENTRIES_MAX, watchable};
pub use pipeline::{
    CHANGES_DELAY, CHUNK_PAUSE, CHUNK_SIZE, Clock, DELETE_RECHECK_DELAY, ExistsFn, MAX_BUFFERED,
    OP_CHMOD, OP_CREATE, OP_REMOVE, OP_RENAME, OP_WRITE, Op, OutFn, Pipeline, PipelineOptions,
    RawEvent, RealClock, TimerFn,
};
pub use tree::{TreeMsg, TreeSink, TreeWatch, watch_tree};
