//! Go 기준선 `dongminal/internal/webserver/domain/worktree` 의 Rust 포팅. RUST_PORT_SRS 참고.
//!
//! Run 격리의 파일시스템 절반이다 (RUN_ORCHESTRATION_SRS 묶음 W). 저장소에서 파일시스템을 파괴할
//! 수 있는 유일한 경로다 — dirty 트리를 지우지 않고 (FR-WKT-8), 등록 범위 밖을 건드리지 않으며
//! (FR-WKT-9/10), 지우지 못한 것을 조용히 넘기지 않는다 (FR-WKT-12). Run 을 모른다.

#![forbid(unsafe_code)]

mod error;
mod lock;
mod manager;
mod naming;
mod parse;
mod remove;
mod service;

pub use error::{Error, Failure, Kind};
pub use lock::{RepoLock, lock_repo};
pub use manager::{ExecSpec, Manager, Repo, Runner, Spec, UNGUARDED_REASON, exec_git, git_runner};
pub use naming::{branch, check_name, repo_bucket};
pub use parse::Entry;
pub use remove::{
    RESIDUE_BRANCH_RETAINED, RESIDUE_DIRTY, RESIDUE_KEPT, RESIDUE_REMOVE_FAILED, RESIDUE_UNMERGED,
    RESIDUE_UNSAFE_PATH, RemoveResult, RemoveSpec,
};
pub use service::{Fut, Service};

#[cfg(test)]
mod tests;
