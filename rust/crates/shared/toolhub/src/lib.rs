//! Go 기준선 `dongminal/internal/shared/toolhub` 의 Rust 포팅. RUST_PORT_SRS 참고.
//!
//! 이슈 2.2.1 범위: 와이어 타입과 PTY 없이 판정되는 순수 함수. Tool·ToolManager 는 2.2.2·2.2.3.

mod agentturn;
mod attention;
mod conn;
mod hub;
mod records;
mod shellprobe;
mod termmodes;

pub use agentturn::{AgentTurn, TurnState};
pub use attention::{
    ATTENTION_SWEEP_INTERVAL, ATTN_MAX_CARRY, ATTN_WORKING_STALE, ActivitySnap, ActivityState,
    EscClass, activity_still_working, attention_allow_bell, attention_idle_threshold, classify_esc,
    detect_attention_signal, detect_cwd_report,
};
pub use conn::{
    OP_ERROR, OP_EXIT, OP_INPUT, OP_OUTPUT, OP_REPLY_SEAT, OP_RESIZE, OP_SEQ, OP_SIZE, OP_TOOL_ID,
    PING_PERIOD, PONG_WAIT, size_payload,
};
pub use hub::{BackgroundEntry, DaemonInfo, OutChunk, TermSize, ToolInfo, ToolSnapshot};
pub use records::{AgentState, ExitInfo};
pub use shellprobe::{ShellState, judge_shell};
pub use termmodes::{MODE_MAX_CARRY, ModeObserver, TermModes, alt_screen_at_head, scan_modes};
