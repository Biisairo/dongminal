//! Go 기준선 `otterminal/internal/shared/toolhub` 의 Rust 포팅. RUST_PORT_SRS 참고.
//!
//! 2.2.1: 와이어 타입·순수 판정, 2.2.2: Tool(PTY 소유 도구). 2.2.3: ToolManager.

mod agentturn;
mod attention;
mod conn;
mod env;
mod hub;
mod manager;
mod records;
mod shellprobe;
mod termmodes;
mod tool;

pub use agentturn::{AgentTurn, TurnState};
pub use attention::{
    ATTENTION_SWEEP_INTERVAL, ATTN_MAX_CARRY, ATTN_WORKING_STALE, ActivitySnap, ActivityState,
    EscClass, activity_still_working, attention_allow_bell, attention_idle_threshold, classify_esc,
    detect_attention_signal, detect_cwd_report,
};
pub use conn::{
    OP_ERROR, OP_EXIT, OP_INPUT, OP_OUTPUT, OP_REPLY_SEAT, OP_RESIZE, OP_SEQ, OP_SIZE, OP_TOOL_ID,
    WRITE_WAIT, size_payload,
};
pub use hub::{
    BackgroundEntry, DaemonInfo, OutChunk, TermSize, ToolInfo, ToolScreen, ToolSnapshot,
};
pub use manager::{
    DEFAULT_COLS, DEFAULT_ROWS, FOREGROUND_REFRESH_INTERVAL, ForegroundFn, ForegroundProbeFn,
    HandoverTool, InvalidatorFn, MAX_TERMINAL_DIM, ManagerError, OwnedFn, PASTE_SUBMIT_DELAY,
    Placement, PlacerFn, StartFn, StartReq, TOOL_CAP, ToolManager, ToolState, parse_size,
    wrap_paste,
};
pub use records::{AgentState, ExitInfo};
pub use shellprobe::{ShellState, judge_shell};
pub use termmodes::{MODE_MAX_CARRY, ModeObserver, TermModes, alt_screen_at_head, scan_modes};
pub use tool::{
    ActivityFn, AttentionFn, BUF_MAX, BusyProbeFn, ClearFn, ExitFn, OutputFn, Restore, SizeFn,
    TERMINATE_GRACE, Tool, ToolHooks, busy_of, set_attn_busy_probe, set_attn_now,
};
