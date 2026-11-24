//! 판정 대상 sentinel 의 목록과, 표에 넣지 않은 것의 사유 (Go `inventory.go`).

use otter_webserver_domain_git_core as core;
use otter_webserver_domain_git_jobs::JobsKind;
use otter_webserver_domain_git_query::QueryKind;
use otter_webserver_domain_git_write::WriteKind;
use otter_webserver_domain_worktree as worktree;

use crate::sentinel::{Sentinel, WsentryKind};

/// 표에 넣지 않은 sentinel 과 그 사유.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Exemption {
    pub err: Sentinel,
    pub reason: &'static str,
}

/// 응답 경로에 닿을 수 있는 sentinel 전부.
pub const INVENTORY: &[Sentinel] = &[
    Sentinel::Core(core::Kind::GitMissing),
    Sentinel::Core(core::Kind::NotRepo),
    Sentinel::Core(core::Kind::RepoMissing),
    Sentinel::Core(core::Kind::Timeout),
    Sentinel::Core(core::Kind::Canceled),
    Sentinel::Core(core::Kind::UnsafeArgument),
    Sentinel::Core(core::Kind::WriteCommand),
    Sentinel::Core(core::Kind::RefName),
    Sentinel::Core(core::Kind::IndexLocked),
    Sentinel::Core(core::Kind::ServerShutdown),
    Sentinel::Query(QueryKind::DiffAxis),
    Sentinel::Query(QueryKind::DiffPath),
    Sentinel::Query(QueryKind::DiffBothAbsent),
    Sentinel::Query(QueryKind::DiffTruncated),
    Sentinel::Query(QueryKind::DiffSide),
    Sentinel::Query(QueryKind::DiffTooLarge),
    Sentinel::Query(QueryKind::NoRemote),
    Sentinel::Query(QueryKind::BlameTruncated),
    Sentinel::Query(QueryKind::BlameParse),
    Sentinel::Query(QueryKind::BlamePathNotFound),
    Sentinel::Query(QueryKind::LogOrder),
    Sentinel::Query(QueryKind::UnsafeRev),
    Sentinel::Query(QueryKind::RevNotFound),
    Sentinel::Query(QueryKind::CommitParent),
    Sentinel::Write(WriteKind::BranchExists),
    Sentinel::Write(WriteKind::CheckoutTarget),
    Sentinel::Write(WriteKind::BranchRename),
    Sentinel::Write(WriteKind::BranchDelete),
    Sentinel::Write(WriteKind::MergeMode),
    Sentinel::Write(WriteKind::BranchUpstream),
    Sentinel::Write(WriteKind::Operation),
    Sentinel::Write(WriteKind::PullMode),
    Sentinel::Write(WriteKind::PushForce),
    Sentinel::Write(WriteKind::ForceConfirm),
    Sentinel::Write(WriteKind::PublishRequired),
    Sentinel::Write(WriteKind::DetachedPush),
    Sentinel::Write(WriteKind::UpstreamLocal),
    Sentinel::Write(WriteKind::PushTarget),
    Sentinel::Write(WriteKind::RemoteName),
    Sentinel::Write(WriteKind::RemoteUrl),
    Sentinel::Write(WriteKind::RemoteExists),
    Sentinel::Write(WriteKind::RemoteMissing),
    Sentinel::Write(WriteKind::StashEmpty),
    Sentinel::Write(WriteKind::StashMoved),
    Sentinel::Write(WriteKind::PickVerb),
    Sentinel::Write(WriteKind::MergeParent),
    Sentinel::Write(WriteKind::ResetMode),
    Sentinel::Write(WriteKind::ReplayTarget),
    Sentinel::Write(WriteKind::IgnorePath),
    Sentinel::Write(WriteKind::UncommittedNoHead),
    Sentinel::Write(WriteKind::NothingToClean),
    Sentinel::Write(WriteKind::CleanChanged),
    Sentinel::Write(WriteKind::PatchOp),
    Sentinel::Write(WriteKind::PatchAxis),
    Sentinel::Write(WriteKind::PatchStale),
    Sentinel::Write(WriteKind::PatchRange),
    Sentinel::Write(WriteKind::PatchEmpty),
    Sentinel::Write(WriteKind::TagExists),
    Sentinel::Write(WriteKind::TagNotFound),
    Sentinel::Write(WriteKind::TagKind),
    Sentinel::Write(WriteKind::TagMessage),
    Sentinel::Write(WriteKind::TagPushTarget),
    Sentinel::Jobs(JobsKind::JobBusy),
    Sentinel::Jobs(JobsKind::JobKind),
    Sentinel::Jobs(JobsKind::RepoBusy),
    Sentinel::Worktree(worktree::Kind::GitMissing),
    Sentinel::Worktree(worktree::Kind::NotRepo),
    Sentinel::Worktree(worktree::Kind::UnsafeArgument),
    Sentinel::Worktree(worktree::Kind::UnsafePath),
    Sentinel::Worktree(worktree::Kind::RepoBusy),
    Sentinel::Run(crate::RUN_NOT_RUN_PARTICIPANT),
    Sentinel::Run(crate::RUN_MEMBER_ATTACHED),
    Sentinel::Run(crate::RUN_MEMBER_NOT_ATTACHED),
    Sentinel::Run(crate::RUN_UNKNOWN_RUN),
    Sentinel::Run(crate::RUN_RUN_CLOSED),
    Sentinel::Run(crate::RUN_RUN_OPEN),
    Sentinel::Run(crate::RUN_SENDER_NOT_MEMBER),
    Sentinel::Run(crate::RUN_UNKNOWN_MEMBER),
    Sentinel::Run(crate::RUN_RUN_MEMBER_MISMATCH),
    Sentinel::Run(crate::RUN_ALREADY_REPORTED),
    Sentinel::Run(crate::RUN_TOOL_ALREADY_MEMBER),
    Sentinel::Run(crate::RUN_UNREPORTED_MEMBERS),
    Sentinel::Run(crate::RUN_INVALID_ARGUMENT),
    Sentinel::Run(crate::RUN_TREE_OPEN),
    Sentinel::Run(crate::RUN_TREE_NOT_OPEN),
    Sentinel::Run(crate::RUN_NODE_TAKEN),
    Sentinel::Wsentry(WsentryKind::NotAbsolute),
    Sentinel::Wsentry(WsentryKind::NotFound),
    Sentinel::Wsentry(WsentryKind::NotDir),
    Sentinel::Wsentry(WsentryKind::Unavailable),
    Sentinel::SysstatUnsupported,
];

pub const UNMAPPED: &[Exemption] = &[
    Exemption {
        err: Sentinel::Write(WriteKind::MergeParent),
        reason: "부모 목록을 본문에 함께 실어야 한다 (FR-GIT-263). 무엇을 고를 수 있는지 모르면 화면은 물을 수도 없으므로, 응답이 오류값 밖의 데이터를 요구한다. gitCommitOpError 에 남는다",
    },
    Exemption {
        err: Sentinel::Write(WriteKind::Operation),
        reason: "handlers_git_operation.go 가 write.OperationArgs 의 모든 실패를 실행 전에 bad_request 로 정한다. 오류값을 보지 않는다",
    },
    Exemption {
        err: Sentinel::Write(WriteKind::IgnorePath),
        reason: "handlers_git_ignore.go 가 write.IgnorePattern 의 모든 실패를 실행 전에 unsafe_ignore_path 로 정한다. 오류값을 보지 않는다",
    },
    Exemption {
        err: Sentinel::Write(WriteKind::UncommittedNoHead),
        reason: "resetAnswer 가 status.Initial 로 실행 전에 판정한다 (no_head). domain 의 guard 는 두 번째 방어선이다",
    },
    Exemption {
        err: Sentinel::Write(WriteKind::NothingToClean),
        reason: "cleanAnswer 가 status.Untracked 로 실행 전에 판정한다 (nothing_to_clean). domain 의 guard 는 두 번째 방어선이다",
    },
    Exemption {
        err: Sentinel::Write(WriteKind::ReplayTarget),
        reason: "apiGitReplay 가 record_missing 과 저장소 일치를 실행 전에 확인한다. 여기까지 오면 서버 자신의 기록이 불일치한 것이므로 500 이 옳다",
    },
    Exemption {
        err: Sentinel::Query(QueryKind::BlameParse),
        reason: "git blame porcelain 형식이 어긋난 것이다. 사용자 입력으로 만들 수 없고, 발생하면 우리 파서가 틀린 것이므로 500 이 옳은 신호다",
    },
    Exemption {
        err: Sentinel::Jobs(JobsKind::JobKind),
        reason: "작업의 argv 는 서버가 만든다 (FR-GIT-281 의 정신). 클라이언트가 kind 와 argv 의 불일치를 만들 수 없으므로, 발생하면 서버 결함이다",
    },
    Exemption {
        err: Sentinel::Run(crate::RUN_NOT_RUN_PARTICIPANT),
        reason: "run.AppendMessage 전용이며 이를 호출하는 HTTP 핸들러가 없다. 표면에 나타나면 그때 규칙을 준다",
    },
    Exemption {
        err: Sentinel::Wsentry(WsentryKind::Unavailable),
        reason: "fsEntries 의 nil 검사가 먼저 막는다 (io_failed). sentinel 이 응답 경로에 도달하지 않는다",
    },
    Exemption {
        err: Sentinel::SysstatUnsupported,
        reason: "/api/stats 는 실패를 오류 본문으로 내지 않고 **키를 생략**한다 (FR-STAT-7). 이 표면에는 오류 코드라는 자리 자체가 없다",
    },
];
