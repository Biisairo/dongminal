//! 파괴적 동작의 이름 (FR-GIT-89).

pub const ACTION_DISCARD: &str = "discard";
pub const ACTION_BRANCH_DELETE: &str = "branch_delete";
pub const ACTION_STASH_DROP: &str = "stash_drop";
pub const ACTION_TAG_DELETE: &str = "tag_delete";
pub const ACTION_RESET_HARD: &str = "reset_hard";
pub const ACTION_FORCE_PUSH: &str = "force_push";
pub const ACTION_REMOTE_REF_DELETE: &str = "remote_ref_delete";
pub const ACTION_RESOLVE_SIDE: &str = "resolve_side";
pub const ACTION_REBASE: &str = "rebase";
pub const ACTION_COMMIT_DROP: &str = "commit_drop";
pub const ACTION_CLEAN_UNTRACKED: &str = "clean_untracked";
pub const ACTION_OPERATION_ABORT: &str = "operation_abort";
pub const ACTION_INDEX_LOCK_REMOVE: &str = "index_lock_remove";

/// 2단계 확인과 recovery hint 를 반드시 거치는 동작이다 (FR-GIT-89). API 로 노출한다.
pub const DESTRUCTIVE_ACTIONS: &[&str] = &[
    ACTION_DISCARD,
    ACTION_BRANCH_DELETE,
    ACTION_STASH_DROP,
    ACTION_TAG_DELETE,
    ACTION_RESET_HARD,
    ACTION_FORCE_PUSH,
    ACTION_REMOTE_REF_DELETE,
    ACTION_RESOLVE_SIDE,
    ACTION_REBASE,
    ACTION_COMMIT_DROP,
    ACTION_CLEAN_UNTRACKED,
    ACTION_OPERATION_ABORT,
    ACTION_INDEX_LOCK_REMOVE,
];
