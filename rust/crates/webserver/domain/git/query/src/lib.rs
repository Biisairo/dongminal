//! Go 기준선 `otterminal/internal/webserver/domain/git/query` 의 Rust 포팅. RUST_PORT_SRS 참고.
//!
//! 저장소를 읽는 함수들이다 (FR-GIT-2). git 실행은 전부 `core::Service::exec` 를 지난다.
//! 함수는 `&Service` 를 첫 인자로 받는다 (FR-GIT-4).

#![forbid(unsafe_code)]

mod blame;
mod branch;
mod commit;
mod diff;
mod diff_hunks;
mod diff_image;
mod error;
mod log;
mod operation;
mod preflight;
mod refs;
mod remote;
mod signature;
mod status;

pub use blame::*;
pub use branch::*;
pub use commit::*;
pub use diff::*;
pub use diff_hunks::*;
pub use diff_image::*;
pub use error::{Error, QueryKind};
pub use log::*;
pub use operation::*;
pub use preflight::*;
pub use refs::*;
pub use remote::*;
pub use signature::*;
pub use status::*;

#[cfg(test)]
mod tests;
