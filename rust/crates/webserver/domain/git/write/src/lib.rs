//! Go 기준선 `dongminal/internal/webserver/domain/git/write` 의 Rust 포팅. RUST_PORT_SRS 참고.
//!
//! 저장소를 변경하는 함수들이다 (FR-GIT-3). git 을 실행하는 경로는 `Service::exec_write` 하나뿐이다.
//! 읽기가 필요한 복합 동작은 query 를 부른다 — 의존은 write → query → core 단방향이다 (FR-GIT-9).
//!
//! Go 가 `(Output, error)` 를 돌려주는 함수는 `Result<Output, Error>` 이고, 오류와 함께 오던
//! Output 은 [`Error::output`] 이다(실행 전 거부는 `exit_code == -1`).

mod branch;
mod commit;
mod error;
mod ignore;
mod operation;
mod patch;
mod remote;
mod replay;
mod resolve;
mod stage;
mod stash;
mod tag;
mod uncommitted;

pub use branch::*;
pub use commit::{
    CommitOpts, PICK_CHERRY, PICK_REVERT, PickOpts, RESET_HARD, RESET_MIXED, RESET_MODES,
    RESET_SOFT, ResetOpts, UNDO_TTL, comment_prefix, commit_spec, drop_args, drop_spec,
    has_signoff, normalize_commit_message, pick_args, reset, reset_args, undo_last,
};
pub use error::{Batch, Error, WriteKind, denied};
pub use ignore::*;
pub use operation::*;
pub use patch::*;
pub use remote::{
    FetchOpts, PULL_DEFAULT, PULL_FF_ONLY, PULL_NO_FF, PULL_REBASE, PUSH_FORCE, PUSH_LEASE,
    PUSH_NO_FORCE, PullOpts, PushOpts, PushPlan, REMOTE_REMOVE_ACTION, check_remote_name,
    check_remote_url, fetch_spec, pull_spec, push_range, push_spec, remote_add, remote_add_args,
    remote_remove, remote_remove_args,
};
pub use replay::replay;
pub use resolve::*;
pub use stage::{MAX_PATHS_PER_CALL, discard, stage, unstage};
pub use stash::*;
pub use tag::{
    TAG_ANNOTATED, TAG_KINDS, TAG_LIGHTWEIGHT, TAG_SIGNED, TagCreateOpts, TagRemoteOpts,
    check_new_tag_name, check_tag_message, tag_create, tag_create_args, tag_delete,
    tag_delete_args, tag_delete_hint, tag_delete_remote_args, tag_delete_remote_hint,
    tag_delete_remote_spec, tag_push_args, tag_push_spec,
};
pub use uncommitted::*;

#[cfg(test)]
mod tests;
