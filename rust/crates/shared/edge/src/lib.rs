//! Go 기준선 `dongminal/internal/shared/edge` 의 Rust 포팅. RUST_PORT_SRS 참고.

mod addr;
pub mod codes;
mod config;
mod error;
mod limit;
mod pairing;
mod profile;

pub use addr::{addr_rate_key, valid_addr, valid_port};
pub use codes::*;
pub use config::{
    Config, DEFAULT_BIND, DEFAULT_PORT, DISPLAY_NAME_MAX, Edge, MAX_EDGES, MIN_PREFIX,
    NAME_MAX_BYTES, NAME_MAX_LEN, Store, default_name, display_name, migrate_legacy_files,
    valid_display_name, valid_name,
};
pub use error::Error;
pub use limit::{Clock, PER_KEY_PER_MINUTE, RateLimiter};
pub use pairing::{INVITE_PREFIX, INVITE_TTL, InviteCode, Pairing, decode_invite, encode_invite};
pub use profile::{handle, tag};
