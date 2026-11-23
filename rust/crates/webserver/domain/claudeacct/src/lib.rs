//! Go 기준선 `dongminal/internal/webserver/domain/claudeacct` 의 Rust 포팅. RUST_PORT_SRS 참고.
//!
//! Claude 다중 계정의 도메인이다 (CLAUDE_ACCOUNTS_SRS). 계정마다 자격증명을 백업하고, Claude Code
//! 가 읽는 활성 저장소를 바꿔 끼워 계정을 전환한다. 토큰 값은 이 crate 밖으로 나가지 않는다
//! (FR-CAC-9).

// 내부 API 일부는 4.5.2~4.5.4(Service·Engine·Auto)가 쓴다. 4.5.4 에서 지운다.
#![allow(dead_code)]

mod backup;
mod claudecfg;
mod client;
mod creds;
mod dirlock;
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
mod store;
mod unclaimed;
mod usage;
mod waker;

#[cfg(test)]
mod tests;

pub use backup::BackupStore;
pub use claudecfg::{OAuthAccount, read_oauth_account, splice_oauth_account};
pub use client::{
    Client, DEFAULT_API_BASE, DEFAULT_TOKEN_BASE, Identity, ProfileLookup, TokenResult,
};
pub use creds::Credential;
pub use dirlock::DEFAULT_LOCK_WAIT;
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
pub use store::{ACCOUNT_RANGES, Account, AutoRange, Patch, State, Store};
pub use unclaimed::UnclaimedEntry;
pub use usage::{Models, ScopedWindow, Spend, Usage, Window, parse_usage};

pub(crate) const FILE_MODE: u32 = 0o600;
pub(crate) const DIR_MODE: u32 = 0o700;
