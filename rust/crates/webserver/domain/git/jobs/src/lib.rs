//! Go 기준선 `otterminal/internal/webserver/domain/git/jobs` 의 Rust 포팅. RUST_PORT_SRS 참고.
//!
//! 오래 걸리는 쓰기를 잡으로 돌리고(줄 흘림·취소·상한·보존), 저장소 단위 상호 배제를 맡는다.

mod error;
mod exclusion;
mod exec;
mod job;
mod kinds;
mod result;

pub use error::{Error, JobsKind};
pub use exclusion::{
    Exclusion, Keys, Release, SLOT_COMMON, SLOT_INDEX, SLOT_ORDER, SlotInfo, slots_of,
};
pub use exec::{Emit, exec_stream_git};
pub use job::*;
pub use kinds::indicator_kinds;
pub use result::JobResult;

#[cfg(test)]
mod tests;
