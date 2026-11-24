//! Go 기준선 `otterminal/internal/webserver/apierr` 의 Rust 포팅. RUST_PORT_SRS 참고.
//!
//! 오류값 → (HTTP 상태, 와이어 코드) 판정표와 코드 목록·안내다. 코드는 `X-Error-Code` 헤더로 실린다.

use std::io;

use otter_webserver_domain_git_core as core;
use otter_webserver_domain_git_jobs::JobsKind;
use otter_webserver_domain_git_query::QueryKind;
use otter_webserver_domain_git_write::WriteKind;
use otter_webserver_domain_worktree as worktree;

mod codes;
mod inventory;
mod sentinel;

pub use codes::*;
pub use inventory::{Exemption, INVENTORY, UNMAPPED};
pub use sentinel::{Classify, Sentinel, WsentryKind};

/// 클라이언트가 응답 전에 연결을 닫았다 (nginx 관례).
pub const STATUS_CLIENT_CLOSED: u16 = 499;

/// 오류 하나의 판정이다.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rule {
    pub err: Sentinel,
    pub status: u16,
    pub code: &'static str,
}

const fn rule(err: Sentinel, status: u16, code: &'static str) -> Rule {
    Rule { err, status, code }
}

/// 위에서부터 첫 일치가 이긴다. 더 구체적인 사유가 먼저 온다.
#[derive(Clone, Copy, Debug)]
pub struct Table(pub &'static [Rule]);

impl Table {
    /// Go `Table.Lookup`: 감싼 사유까지 보아 첫 일치의 (상태, 코드).
    pub fn lookup<E: Classify + ?Sized>(&self, err: &E) -> Option<(u16, &'static str)> {
        self.0
            .iter()
            .find(|r| err.is(&r.err))
            .map(|r| (r.status, r.code))
    }

    pub fn codes(&self) -> Vec<&'static str> {
        self.0.iter().map(|r| r.code).collect()
    }

    pub fn sentinels(&self) -> Vec<Sentinel> {
        self.0.iter().map(|r| r.err).collect()
    }

    pub fn rules(&self) -> &'static [Rule] {
        self.0
    }
}

const fn run(code: &'static str) -> Sentinel {
    Sentinel::Run(code)
}

pub const RUN_UNKNOWN_RUN: &str = "unknown_run";
pub const RUN_RUN_CLOSED: &str = "run_closed";
pub const RUN_RUN_OPEN: &str = "run_open";
pub const RUN_SENDER_NOT_MEMBER: &str = "sender_not_member";
pub const RUN_UNKNOWN_MEMBER: &str = "unknown_member";
pub const RUN_RUN_MEMBER_MISMATCH: &str = "run_member_mismatch";
pub const RUN_ALREADY_REPORTED: &str = "member_already_reported";
pub const RUN_TOOL_ALREADY_MEMBER: &str = "tool_already_member";
pub const RUN_TREE_OPEN: &str = "tree_open";
pub const RUN_TREE_NOT_OPEN: &str = "tree_not_open";
pub const RUN_NODE_TAKEN: &str = "node_taken";
pub const RUN_MEMBER_ATTACHED: &str = "member_attached";
pub const RUN_MEMBER_NOT_ATTACHED: &str = "member_not_attached";
pub const RUN_UNREPORTED_MEMBERS: &str = "unreported_members";
pub const RUN_INVALID_ARGUMENT: &str = "invalid_argument";
pub const RUN_NOT_RUN_PARTICIPANT: &str = "not_run_participant";

/// Go `apierr.Git`.
pub static GIT: Table = Table(&[
    rule(
        Sentinel::Core(core::Kind::ServerShutdown),
        503,
        CODE_SERVER_SHUTDOWN,
    ),
    rule(
        Sentinel::Core(core::Kind::IndexLocked),
        409,
        CODE_INDEX_LOCKED,
    ),
    rule(
        Sentinel::Write(WriteKind::PatchStale),
        409,
        CODE_STALE_OBSERVATION,
    ),
    rule(
        Sentinel::Write(WriteKind::CleanChanged),
        409,
        CODE_STALE_OBSERVATION,
    ),
    rule(
        Sentinel::Write(WriteKind::PatchEmpty),
        400,
        CODE_PATCH_EMPTY,
    ),
    rule(Sentinel::Write(WriteKind::PatchOp), 400, CODE_BAD_REQUEST),
    rule(Sentinel::Write(WriteKind::PatchAxis), 400, CODE_BAD_REQUEST),
    rule(
        Sentinel::Write(WriteKind::PatchRange),
        400,
        CODE_BAD_REQUEST,
    ),
    rule(
        Sentinel::Query(QueryKind::DiffTruncated),
        400,
        CODE_BAD_REQUEST,
    ),
    rule(
        Sentinel::Write(WriteKind::RemoteExists),
        409,
        CODE_REMOTE_EXISTS,
    ),
    rule(
        Sentinel::Write(WriteKind::RemoteMissing),
        404,
        CODE_REMOTE_MISSING,
    ),
    rule(
        Sentinel::Write(WriteKind::RemoteName),
        400,
        CODE_REMOTE_NAME_INVALID,
    ),
    rule(
        Sentinel::Write(WriteKind::RemoteUrl),
        400,
        CODE_REMOTE_URL_INVALID,
    ),
    rule(
        Sentinel::Write(WriteKind::PushTarget),
        400,
        CODE_BAD_REQUEST,
    ),
    rule(
        Sentinel::Write(WriteKind::StashEmpty),
        409,
        CODE_NOTHING_TO_STASH,
    ),
    rule(
        Sentinel::Write(WriteKind::StashMoved),
        409,
        CODE_STASH_MOVED,
    ),
    rule(
        Sentinel::Write(WriteKind::PublishRequired),
        409,
        CODE_PUBLISH_REQUIRED,
    ),
    rule(
        Sentinel::Write(WriteKind::ForceConfirm),
        400,
        CODE_CONFIRM_REQUIRED,
    ),
    rule(Sentinel::Write(WriteKind::PullMode), 400, CODE_BAD_REQUEST),
    rule(Sentinel::Write(WriteKind::PushForce), 400, CODE_BAD_REQUEST),
    rule(
        Sentinel::Write(WriteKind::DetachedPush),
        400,
        CODE_BAD_REQUEST,
    ),
    rule(
        Sentinel::Write(WriteKind::UpstreamLocal),
        400,
        CODE_BAD_REQUEST,
    ),
    rule(Sentinel::Query(QueryKind::NoRemote), 409, CODE_NO_REMOTE),
    rule(Sentinel::Jobs(JobsKind::JobBusy), 409, CODE_JOB_BUSY),
    rule(Sentinel::Jobs(JobsKind::RepoBusy), 409, CODE_REPO_BUSY),
    rule(
        Sentinel::Write(WriteKind::BranchExists),
        409,
        CODE_BRANCH_EXISTS,
    ),
    rule(
        Sentinel::Write(WriteKind::CheckoutTarget),
        400,
        CODE_BAD_REQUEST,
    ),
    rule(
        Sentinel::Write(WriteKind::BranchRename),
        400,
        CODE_BAD_REQUEST,
    ),
    rule(
        Sentinel::Write(WriteKind::BranchDelete),
        400,
        CODE_BAD_REQUEST,
    ),
    rule(Sentinel::Write(WriteKind::MergeMode), 400, CODE_BAD_REQUEST),
    rule(
        Sentinel::Write(WriteKind::BranchUpstream),
        400,
        CODE_BAD_REQUEST,
    ),
    rule(Sentinel::Write(WriteKind::TagExists), 409, CODE_TAG_EXISTS),
    rule(Sentinel::Write(WriteKind::TagNotFound), 404, CODE_NOT_FOUND),
    rule(
        Sentinel::Write(WriteKind::TagKind),
        400,
        CODE_TAG_KIND_INVALID,
    ),
    rule(
        Sentinel::Write(WriteKind::TagMessage),
        400,
        CODE_TAG_MESSAGE_REQUIRED,
    ),
    rule(
        Sentinel::Write(WriteKind::TagPushTarget),
        400,
        CODE_BAD_REQUEST,
    ),
    rule(Sentinel::Write(WriteKind::ResetMode), 400, CODE_RESET_MODE),
    rule(Sentinel::Write(WriteKind::PickVerb), 400, CODE_BAD_REQUEST),
    rule(Sentinel::Query(QueryKind::BlameTruncated), 413, CODE_FAILED),
    rule(
        Sentinel::Query(QueryKind::BlamePathNotFound),
        404,
        CODE_NOT_FOUND,
    ),
    rule(Sentinel::Query(QueryKind::RevNotFound), 404, CODE_NOT_FOUND),
    rule(
        Sentinel::Query(QueryKind::DiffBothAbsent),
        404,
        CODE_NOT_FOUND,
    ),
    rule(Sentinel::Query(QueryKind::DiffAxis), 400, CODE_BAD_REQUEST),
    rule(Sentinel::Query(QueryKind::DiffSide), 400, CODE_BAD_REQUEST),
    rule(
        Sentinel::Query(QueryKind::DiffTooLarge),
        413,
        CODE_TOO_LARGE,
    ),
    rule(Sentinel::Query(QueryKind::DiffPath), 400, CODE_BAD_REQUEST),
    rule(Sentinel::Query(QueryKind::UnsafeRev), 400, CODE_BAD_REQUEST),
    rule(Sentinel::Query(QueryKind::LogOrder), 400, CODE_BAD_REQUEST),
    rule(
        Sentinel::Query(QueryKind::CommitParent),
        400,
        CODE_BAD_REQUEST,
    ),
    rule(
        Sentinel::Worktree(worktree::Kind::UnsafeArgument),
        400,
        CODE_REF_NAME,
    ),
    rule(
        Sentinel::Worktree(worktree::Kind::UnsafePath),
        400,
        CODE_BAD_REQUEST,
    ),
    rule(
        Sentinel::Worktree(worktree::Kind::NotRepo),
        404,
        CODE_NOT_REPO,
    ),
    rule(
        Sentinel::Worktree(worktree::Kind::GitMissing),
        503,
        CODE_GIT_MISSING,
    ),
    rule(
        Sentinel::Worktree(worktree::Kind::RepoBusy),
        409,
        CODE_REPO_BUSY,
    ),
    rule(Sentinel::Core(core::Kind::RefName), 400, CODE_REF_NAME),
    rule(
        Sentinel::Core(core::Kind::UnsafeArgument),
        400,
        CODE_BAD_REQUEST,
    ),
    rule(
        Sentinel::Core(core::Kind::WriteCommand),
        400,
        CODE_BAD_REQUEST,
    ),
    rule(Sentinel::Core(core::Kind::NotRepo), 404, CODE_NOT_REPO),
    rule(
        Sentinel::Core(core::Kind::RepoMissing),
        404,
        CODE_REPO_MISSING,
    ),
    rule(
        Sentinel::Core(core::Kind::GitMissing),
        503,
        CODE_GIT_MISSING,
    ),
    rule(Sentinel::Core(core::Kind::Timeout), 504, CODE_TIMEOUT),
    rule(
        Sentinel::Core(core::Kind::Canceled),
        STATUS_CLIENT_CLOSED,
        CODE_CANCELED,
    ),
]);

/// Go `apierr.Runs`.
pub static RUNS: Table = Table(&[
    rule(run(RUN_UNKNOWN_RUN), 404, RUN_UNKNOWN_RUN),
    rule(run(RUN_SENDER_NOT_MEMBER), 403, RUN_SENDER_NOT_MEMBER),
    rule(run(RUN_UNKNOWN_MEMBER), 404, RUN_UNKNOWN_MEMBER),
    rule(run(RUN_RUN_MEMBER_MISMATCH), 403, RUN_RUN_MEMBER_MISMATCH),
    rule(run(RUN_RUN_CLOSED), 409, RUN_RUN_CLOSED),
    rule(run(RUN_RUN_OPEN), 409, RUN_RUN_OPEN),
    rule(run(RUN_ALREADY_REPORTED), 409, RUN_ALREADY_REPORTED),
    rule(run(RUN_TOOL_ALREADY_MEMBER), 409, RUN_TOOL_ALREADY_MEMBER),
    rule(run(RUN_TREE_OPEN), 409, RUN_TREE_OPEN),
    rule(run(RUN_TREE_NOT_OPEN), 409, RUN_TREE_NOT_OPEN),
    rule(run(RUN_NODE_TAKEN), 409, RUN_NODE_TAKEN),
    rule(run(RUN_MEMBER_ATTACHED), 409, RUN_MEMBER_ATTACHED),
    rule(run(RUN_MEMBER_NOT_ATTACHED), 409, RUN_MEMBER_NOT_ATTACHED),
    rule(run(RUN_UNREPORTED_MEMBERS), 409, RUN_UNREPORTED_MEMBERS),
    rule(run(RUN_INVALID_ARGUMENT), 400, RUN_INVALID_ARGUMENT),
    rule(
        Sentinel::Worktree(worktree::Kind::NotRepo),
        400,
        "not_a_git_repo",
    ),
    rule(
        Sentinel::Worktree(worktree::Kind::GitMissing),
        400,
        "git_missing",
    ),
    rule(
        Sentinel::Worktree(worktree::Kind::UnsafeArgument),
        400,
        "unsafe_argument",
    ),
    rule(
        Sentinel::Worktree(worktree::Kind::UnsafePath),
        400,
        "unsafe_path",
    ),
    rule(
        Sentinel::Worktree(worktree::Kind::RepoBusy),
        409,
        CODE_REPO_BUSY,
    ),
]);

/// Go `apierr.FS`.
pub static FS: Table = Table(&[
    rule(Sentinel::Fs(io::ErrorKind::NotFound), 404, CODE_NOT_FOUND),
    rule(Sentinel::Fs(io::ErrorKind::AlreadyExists), 409, CODE_EXISTS),
    rule(
        Sentinel::Fs(io::ErrorKind::PermissionDenied),
        403,
        CODE_PERMISSION,
    ),
    rule(
        Sentinel::Wsentry(WsentryKind::NotAbsolute),
        400,
        CODE_BAD_REQUEST,
    ),
    rule(
        Sentinel::Wsentry(WsentryKind::NotDir),
        400,
        CODE_BAD_REQUEST,
    ),
    rule(
        Sentinel::Wsentry(WsentryKind::NotFound),
        404,
        CODE_NOT_FOUND,
    ),
]);
/// 본문 읽기 실패의 코드다. 상한 초과만 `body_too_large` 다.
pub fn body_read_code(err: &otter_shared_httpreq::ReadError) -> &'static str {
    match err {
        otter_shared_httpreq::ReadError::TooLarge => CODE_BODY_TOO_BIG,
        _ => CODE_BAD_REQUEST,
    }
}

/// fs 방언의 코드 → 상태.
pub fn fs_status(code: &str) -> u16 {
    match code {
        CODE_BAD_REQUEST
        | CODE_EDITOR_ROOT_PROTECTED
        | CODE_HOME_PROTECTED
        | CODE_FILESYSTEM_ROOT_PROTECTED
        | CODE_TOO_MANY_ENTRIES
        | CODE_INTO_SELF
        | CODE_NAME_HAS_SEPARATOR
        | CODE_NAME_RESERVED
        | CODE_EMPTY_NAME
        | CODE_EMPTY_PATH
        | CODE_ABS_PATH_NEEDED
        | CODE_NOT_A_DIRECTORY => 400,
        CODE_NOT_FOUND => 404,
        CODE_EXISTS => 409,
        CODE_OUTSIDE_ROOT | CODE_PERMISSION => 403,
        CODE_TOO_LARGE | CODE_BODY_TOO_BIG => 413,
        CODE_BUSY => 429,
        CODE_FS_NOT_REPO => 404,
        _ => 500,
    }
}

/// 상태만 아는 자리의 기본 코드.
pub fn code_for_status(status: u16) -> &'static str {
    match status {
        400 => CODE_BAD_REQUEST,
        403 => CODE_FORBIDDEN,
        404 => CODE_NOT_FOUND,
        405 => CODE_NOT_ALLOWED,
        409 => CODE_CONFLICT,
        413 => CODE_TOO_LARGE,
        428 => CODE_IF_MATCH_REQUIRED,
        421 => CODE_HOST_REJECTED,
        503 => CODE_UNAVAILABLE,
        s if s >= 500 => CODE_INTERNAL,
        _ => CODE_BAD_REQUEST,
    }
}

/// 이 서버가 낼 수 있는 코드 전부 (git → core → edge → chat → telegram → claude → bind 순).
pub fn all_codes() -> Vec<&'static str> {
    let mut out = Vec::new();
    out.extend_from_slice(GIT_CODES);
    out.extend_from_slice(CORE_CODES);
    out.extend_from_slice(otter_shared_edge::CODES);
    out.extend_from_slice(CHAT_CODES);
    out.extend_from_slice(TELEGRAM_CODES);
    out.extend_from_slice(CLAUDE_CODES);
    out.extend_from_slice(BIND_CODES);
    out
}

/// Go `CodeDoc[code]`.
pub fn code_doc(code: &str) -> Option<Doc> {
    CODE_DOC
        .binary_search_by(|(c, _)| (*c).cmp(code))
        .ok()
        .map(|i| CODE_DOC[i].1)
}

#[cfg(test)]
mod tests;
