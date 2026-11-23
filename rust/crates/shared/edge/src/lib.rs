//! Go 기준선 `dongminal/internal/shared/edge` 의 Rust 포팅. RUST_PORT_SRS 참고.

mod addr;
mod client;
pub mod codes;
mod config;
mod error;
mod identity;
mod limit;
mod listener;
#[cfg(test)]
mod net_tests;
mod pairing;
mod profile;
mod tls;
mod upgrade;

pub use addr::{addr_rate_key, valid_addr, valid_port};
pub use client::{
    BoxStream, CallError, Client, DIAL_TIMEOUT, Dial, DialFuture, REMOTE_MESSAGE_MAX,
    REQUEST_TIMEOUT, RemoteError, Stream, Target,
};
pub use codes::*;
pub use config::{
    Config, DEFAULT_BIND, DEFAULT_PORT, DISPLAY_NAME_MAX, Edge, MAX_EDGES, MIN_PREFIX,
    NAME_MAX_BYTES, NAME_MAX_LEN, Store, default_name, display_name, migrate_legacy_files,
    valid_display_name, valid_name,
};
pub use error::Error;
pub use identity::{
    CERT_VALIDITY, Identity, IdentityError, fingerprint_of, load_or_create_identity,
};
pub use limit::{Clock, PER_KEY_PER_MINUTE, RateLimiter};
pub use listener::{
    Acceptor, Admission, BoxFuture, Handler, ListenFn, Listener, RequestAdmit, Status,
    client_fingerprint, edges_only,
};
pub use pairing::{INVITE_PREFIX, INVITE_TTL, InviteCode, Pairing, decode_invite, encode_invite};
pub use profile::{handle, tag};
pub use tls::{TlsAdmit, client_config, server_config};
pub use upgrade::{PendingUpgrade, Upgraded, accept_upgrade};
