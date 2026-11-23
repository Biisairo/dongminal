//! Go 기준선 `dongminal/internal/webserver/hub` 의 Rust 포팅. RUST_PORT_SRS 참고.
//!
//! 커맨드 브로드캐스트(SSE)·포커스·응답 좌석·주의 추적기·git 관측 허브다.
//!
//! Go 와 다른 내부 결정: Go `toolhub.ToolHub` 중 이 crate 가 부르는 부분은 소비자 쪽
//! trait([`ForegroundSource`])로 둔다. 틱·정지는 `mpsc::Receiver<()>`·`CancellationToken` 이다.
//! 동기 RPC(busy·live 확인, list)는 `spawn_blocking` 안에서 부른다.

mod attn;
mod commands;
mod focus;
mod foreground;
mod gitwatch;
mod payloads;
mod replyseat;

use std::sync::{Mutex, MutexGuard};

pub use attn::{
    AttnTracker, BusyManyProbe, Clock, LiveProbe, OnChange, SWEEPER_INTERVAL, default_idle_ms,
};
pub use commands::{
    CMD_SUB_QUEUE, CmdPosition, CmdResult, CmdSub, CommandBroker, CommandHub, SUB_CAP, TabRef,
    allowed_cmd_action_names, awaits_result, command_result_timeout, is_allowed_cmd_action,
    is_creating_action, is_single_executor_action, new_req_id,
};
pub use focus::FocusRegistry;
pub use foreground::{
    FOREGROUND_INTERVAL, ForegroundSource, broadcast_foreground, start_foreground_poll, ticker,
};
pub use gitwatch::{
    AfterFn, GIT_KICK_COOLDOWN, GIT_KICK_DEBOUNCE, GIT_WATCH_BACKOFF_MAX, GIT_WATCH_CAP,
    GIT_WATCH_INTERVAL, GIT_WATCH_PARALLEL, GIT_WATCH_ROUND_TIMEOUT, GIT_WATCH_TTL,
    GIT_WATCH_WORKTREE_EVERY, GitObserver, GitWatcher, RepoHook, WallClock, start_git_watch,
};
pub use payloads::{
    background_changed_payload, claude_account_alert_payload, claude_accounts_changed_payload,
    foreground_snapshot, update_changed_payload, valid_activity_state,
};
pub use replyseat::{ReplySeats, SeatConn};

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

#[cfg(test)]
mod tests;
