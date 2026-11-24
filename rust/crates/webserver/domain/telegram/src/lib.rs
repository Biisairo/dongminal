//! Go 기준선 `dongminal/internal/webserver/domain/telegram` 의 Rust 포팅. RUST_PORT_SRS 참고.
//!
//! Telegram 브리지의 도메인이다 (TELEGRAM_BRIDGE_SRS). 설정은 전용 파일(권한 600)에 두고
//! (FR-TGB-2), Bot API 는 tokio 위의 reqwest 로 부른다. 비동기 소비자는 [`Bridge::run`] 을
//! task 로 띄운다.

mod bridge;
mod client;
mod config;
mod pair;
mod render;
mod transcript;

#[cfg(test)]
mod testsrv;

pub use bridge::{Bridge, Event, Host, Location};
pub use client::{
    ApiError, CallbackQuery, Chat, Client, DEFAULT_BASE_URL, Error, Message, Update, User,
};
pub use config::{Config, DEFAULT_SILENCE_MIN, MAX_SILENCE_MIN, Store, StoreError, View};
pub use dm_shared_fanout::CancellationToken;
pub use pair::{NowFn, PAIR_MAX_FAILS, PAIR_TTL, Pairing};
pub use transcript::last_reply;
