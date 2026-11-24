//! Go 기준선 `otterminal/internal/webserver/domain/claudeacct` 의 Rust 포팅. RUST_PORT_SRS 참고.
//!
//! Claude 다중 계정의 도메인이다 (CLAUDE_ACCOUNTS_SRS). 계정마다 자격증명을 백업하고, Claude Code
//! 가 읽는 활성 저장소를 바꿔 끼워 계정을 전환한다. 토큰 값은 이 crate 밖으로 나가지 않는다
//! (FR-CAC-9).

mod alerts;
mod auto;
mod backup;
mod claudecfg;
mod client;
mod creds;
mod dirlock;
mod engine;
mod error;
mod fsutil;
mod history;
mod live;
mod mappings;
mod pace;
mod paths;
mod policy;
mod profile;
mod resets;
mod service;
mod smart;
mod store;
mod unclaimed;
mod usage;
mod view;
mod waker;

#[cfg(test)]
mod tests;

pub use alerts::{
    ALERT_ALL_EXHAUSTED, ALERT_AUTOSWITCH, ALERT_AUTOSWITCH_STOPPED, ALERT_LOGIN_EXPIRING,
    ALERT_NEAR_LIMIT, ALERT_RELOGIN, Alert,
};
pub use auto::{
    AUTO_EXHAUSTED, AUTO_OFF, AUTO_ON, AUTO_RANGES, AUTO_STRATEGY_BEST,
    AUTO_STRATEGY_CONSUME_FIRST, AUTO_STRATEGY_PRIORITY_CONSUME_FIRST, AUTO_UNMANAGED, Auto,
    AutoSettings, AutoState, AutoStateView, AutoView, LastSwitch, NotifyFn, ProcsFn,
    cswap_auto_running,
};
pub use backup::BackupStore;
pub use claudecfg::{OAuthAccount, read_oauth_account, splice_oauth_account};
pub use client::{
    Client, DEFAULT_API_BASE, DEFAULT_TOKEN_BASE, Identity, ProfileLookup, TokenResult,
};
pub use creds::Credential;
pub use dirlock::DEFAULT_LOCK_WAIT;
pub use engine::{
    ClaimBody, Engine, JitterFn, LineForFn, ModelsFn, OnChangeFn, Row, STATUS_KEYCHAIN_UNAVAILABLE,
    STATUS_NO_CREDENTIALS, STATUS_OK, STATUS_RATE_LIMITED, STATUS_RELOGIN_REQUIRED,
    STATUS_TOKEN_EXPIRED, STATUS_UNAVAILABLE, StatusLineFn, UsageApi,
};
pub use error::{Error, HttpStatusError, Sentinel};
pub use history::*;
pub use live::LiveStore;
pub use mappings::{
    Mapping, Mappings, Resolution, SOURCE_FOLDER, SOURCE_NONE, SOURCE_TAB, normalize_folder,
};
pub use pace::{Pace, compute_pace};
pub use paths::ClaudePaths;
pub use resets::{
    CedarGrant, CedarStatus, ClaimResult, JuniperStatus, PROGRAM_CEDAR, PROGRAM_JUNIPER, Resets,
    parse_cedar, parse_juniper,
};
pub use service::{
    AliveFn, Clock, IdGen, LinkFn, OUTGOING_EMPTY, OUTGOING_FOREIGN, OUTGOING_KNOWN,
    OUTGOING_ROTATED, OUTGOING_SAME, OUTGOING_UNRESOLVED, Service, SwitchResult,
};
pub use smart::{
    MODELS_ALL, REASON_CURRENT_UNAVAILABLE, REASON_EXHAUSTED, REASON_NO_COMPARISON, REASON_NONE,
    REASON_STAY, STRATEGY_BEST, STRATEGY_NEXT, STRATEGY_NEXT_AVAILABLE, SwitchRequest,
};
pub use store::{ACCOUNT_RANGES, Account, AutoRange, Patch, State, Store};
pub use unclaimed::UnclaimedEntry;
pub use usage::{Models, ScopedWindow, Spend, Usage, Window, parse_usage};
pub use view::{
    AccountView, PaceView, ScopedWindowView, StatusLineView, StatusLineWindows, UsageView,
    WindowView, WindowsView, build_views, masked_name, status_line_view_of, usage_level,
};

pub(crate) const FILE_MODE: u32 = 0o600;
pub(crate) const DIR_MODE: u32 = 0o700;
