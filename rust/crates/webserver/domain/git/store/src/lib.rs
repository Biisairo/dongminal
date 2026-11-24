//! Go 기준선 `dongminal/internal/webserver/domain/git/store` 의 Rust 포팅. RUST_PORT_SRS 참고.
//!
//! git 조회 결과의 캐시다. 같은 리포의 동시 status 는 한 번만 실행하고(single-flight),
//! 짧은 TTL 안에서는 마지막 관측값을 준다 (FR-GIT-23·24, O3).

#![forbid(unsafe_code)]

mod mark;
mod store;

pub use mark::mark;
pub use store::*;

#[cfg(test)]
mod tests;
