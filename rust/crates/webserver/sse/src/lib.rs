//! 방송 본문의 봉투다 (OPTIMIZE_REFACTOR_SRS FR-OPT-8-1).

mod payload;

pub use payload::{payload, workspace_changed};

#[cfg(test)]
mod tests;
