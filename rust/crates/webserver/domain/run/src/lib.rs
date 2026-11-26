//! Go 기준선 `otterminal/internal/webserver/domain/run` 의 Rust 포팅. RUST_PORT_SRS 참고.
//!
//! Run(runs.json, 멤버, 프리앰블, 컨텍스트)의 기록과 규칙이다.

mod assign;
mod context;
mod preamble;
mod store;

use std::fmt;

use otter_gocompat::json::is_empty;
use otter_shared_activity as activity;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

pub use assign::{AssignPatch, Assignment};
pub use context::{
    ContextObservation, ContextPolicy, DEFAULT_WINDOW_TOKENS, LEVEL_CRITICAL, LEVEL_OK, LEVEL_WARN,
    SucceedSpec, handoff_clause, widen_window, window_for_model,
};
pub use preamble::{TreeContext, preamble, tree_preamble};
pub use store::{
    COORDINATOR_PARTY, MAX_MESSAGES, MSG_KIND_AGENT, MemberSpec, ReportSpec, StartOptions, Store,
    WorktreeMark, check_close, headless_tool_ids, path_slug, short,
};

// ── Projection (FR-RUN-3) ──
pub const DEDICATED_WINDOW: &str = "dedicated-window";
pub const BACKGROUND: &str = "background";
pub const INLINE: &str = "inline";

pub fn valid_projection(p: &str) -> bool {
    matches!(p, DEDICATED_WINDOW | BACKGROUND | INLINE)
}

// ── Run 상태 ──
pub const OPEN: &str = "open";
pub const CLOSED: &str = "closed";
pub const ABORTED: &str = "aborted";
/// 데몬 재시작으로 끊긴 Run 의 사유.
pub const ABORT_DAEMON_RESTART: &str = "daemon-restart";

// ── 격리 ──
pub const ISOLATION_NONE: &str = "none";
pub const ISOLATION_PER_RUN: &str = "per-run";
pub const ISOLATION_PER_MEMBER: &str = "per-member";

pub fn valid_isolation(i: &str) -> bool {
    matches!(i, ISOLATION_NONE | ISOLATION_PER_RUN | ISOLATION_PER_MEMBER)
}

// ── 멤버 상태 ──
pub const STARTING: &str = "starting";
pub const READY: &str = "ready";
pub const WORKING: &str = activity::WORKING;
pub const WAITING: &str = activity::WAITING;
pub const DONE: &str = activity::DONE;
pub const FAILED: &str = "failed";
pub const LOST: &str = "lost";
pub const RELEASED: &str = "released";
pub const SUCCEEDED: &str = "succeeded";
pub const WAITING_CHILDREN: &str = "waiting-children";

// ── 결과 ──
pub const OUTCOME_SUCCEEDED: &str = "succeeded";
pub const OUTCOME_FAILED: &str = "failed";

/// 저장소 오류. `Display` 는 Go 의 오류 문구와 같다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    UnknownRun,
    RunClosed,
    RunOpen,
    SenderNotMember,
    UnknownMember,
    RunMemberMismatch,
    AlreadyReported,
    ToolAlreadyMember,
    /// 같은 트리의 열린 Run 이 있다. 그 Run 의 id 를 싣는다.
    TreeOpen {
        run_id: String,
    },
    TreeNotOpen,
    /// 같은 노드(사슬 이름)를 보고하지 않은 멤버가 쥐고 있다.
    NodeTaken {
        member_id: String,
    },
    UnreportedMembers,
    /// `invalid_argument` 와 설명. 설명이 비면 코드만 낸다.
    InvalidArgument(String),
    NotRunParticipant,
    MemberAttached,
    MemberNotAttached,
    /// runs.json 을 쓰지 못했다. Go 오류 문구 그대로다.
    Write(String),
}

impl Error {
    /// 열거된 사유 코드 (Go 의 sentinel 오류 문구).
    pub fn code(&self) -> &str {
        match self {
            Self::UnknownRun => "unknown_run",
            Self::RunClosed => "run_closed",
            Self::RunOpen => "run_open",
            Self::SenderNotMember => "sender_not_member",
            Self::UnknownMember => "unknown_member",
            Self::RunMemberMismatch => "run_member_mismatch",
            Self::AlreadyReported => "member_already_reported",
            Self::ToolAlreadyMember => "tool_already_member",
            Self::TreeOpen { .. } => "tree_open",
            Self::TreeNotOpen => "tree_not_open",
            Self::NodeTaken { .. } => "node_taken",
            Self::UnreportedMembers => "unreported_members",
            Self::InvalidArgument(_) => "invalid_argument",
            Self::NotRunParticipant => "not_run_participant",
            Self::MemberAttached => "member_attached",
            Self::MemberNotAttached => "member_not_attached",
            Self::Write(e) => e,
        }
    }

    pub(crate) fn invalid(detail: impl Into<String>) -> Self {
        Self::InvalidArgument(detail.into())
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidArgument(d) if !d.is_empty() => write!(f, "invalid_argument: {d}"),
            e => f.write_str(e.code()),
        }
    }
}

impl std::error::Error for Error {}

/// 격리된 작업 트리 (FR-RUN-5).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "run.Worktree")]
pub struct Worktree {
    pub path: String,
    pub branch: String,
    #[serde(skip_serializing_if = "is_empty")]
    pub base: String,
    #[serde(skip_serializing_if = "is_empty")]
    pub removed: bool,
    #[serde(skip_serializing_if = "is_empty")]
    pub residue: String,
    #[serde(skip_serializing_if = "is_empty")]
    pub detail: String,
}

/// 한 에이전트의 컨텍스트 관측 (FR-RCX-8). 멤버와 조정자가 같은 어휘를 쓴다.
/// `context_level` 이 비면 "모른다"다 (FR-CBG-5).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename = "run.ContextState", rename_all = "camelCase")]
pub struct ContextState {
    #[serde(skip_serializing_if = "is_empty")]
    pub context_bytes: i64,
    #[serde(skip_serializing_if = "is_empty")]
    pub context_ratio: f64,
    #[serde(skip_serializing_if = "is_empty")]
    pub context_tokens: i64,
    #[serde(skip_serializing_if = "is_empty")]
    pub context_limit: f64,
    #[serde(skip_serializing_if = "is_empty")]
    pub context_level: String,
    #[serde(skip_serializing_if = "is_empty")]
    pub context_at: i64,
    #[serde(skip_serializing_if = "is_empty")]
    pub compact_count: i64,
    #[serde(rename = "sessionId", skip_serializing_if = "is_empty")]
    pub session_id: String,
    #[serde(skip_serializing_if = "is_empty")]
    pub window_official: bool,
}

/// Run 의 멤버 하나. JSON 은 Go 의 임베드처럼 `headless` 뒤에 ContextState 의 필드가 온다.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Member {
    pub id: String,
    pub run_id: String,
    pub role: String,
    pub agent: String,
    pub brief: String,
    pub tool_id: String,
    pub tab_id: String,
    pub worktree: Option<Worktree>,
    pub state: String,
    pub outcome: String,
    pub summary: String,
    pub files_modified: Vec<String>,
    pub reported_at: i64,
    pub created_at: i64,
    pub headless: bool,
    pub context: ContextState,
    pub succeeded_by: String,
    pub succeeded_from: String,
    pub handoff_summary: String,
    pub handoff_pending: bool,
    pub assign: Option<Assignment>,
}

#[derive(Serialize, Deserialize, Default)]
#[serde(default, rename = "run.Member", rename_all = "camelCase")]
struct MemberWire {
    id: String,
    #[serde(skip_serializing_if = "is_empty")]
    run_id: String,
    role: String,
    agent: String,
    #[serde(skip_serializing_if = "is_empty")]
    brief: String,
    tool_id: String,
    #[serde(skip_serializing_if = "is_empty")]
    tab_id: String,
    #[serde(skip_serializing_if = "is_empty")]
    worktree: Option<Worktree>,
    state: String,
    #[serde(skip_serializing_if = "is_empty")]
    outcome: String,
    #[serde(skip_serializing_if = "is_empty")]
    summary: String,
    #[serde(skip_serializing_if = "is_empty")]
    files_modified: Vec<String>,
    #[serde(skip_serializing_if = "is_empty")]
    reported_at: i64,
    created_at: i64,
    #[serde(skip_serializing_if = "is_empty")]
    headless: bool,
    #[serde(skip_serializing_if = "is_empty")]
    context_bytes: i64,
    #[serde(skip_serializing_if = "is_empty")]
    context_ratio: f64,
    #[serde(skip_serializing_if = "is_empty")]
    context_tokens: i64,
    #[serde(skip_serializing_if = "is_empty")]
    context_limit: f64,
    #[serde(skip_serializing_if = "is_empty")]
    context_level: String,
    #[serde(skip_serializing_if = "is_empty")]
    context_at: i64,
    #[serde(skip_serializing_if = "is_empty")]
    compact_count: i64,
    #[serde(rename = "sessionId", skip_serializing_if = "is_empty")]
    session_id: String,
    #[serde(skip_serializing_if = "is_empty")]
    window_official: bool,
    #[serde(skip_serializing_if = "is_empty")]
    succeeded_by: String,
    #[serde(skip_serializing_if = "is_empty")]
    succeeded_from: String,
    #[serde(skip_serializing_if = "is_empty")]
    handoff_summary: String,
    #[serde(skip_serializing_if = "is_empty")]
    handoff_pending: bool,
    #[serde(skip_serializing_if = "is_empty")]
    assign: Option<Assignment>,
}

impl Serialize for Member {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let m = self.clone();
        let c = m.context;
        MemberWire {
            id: m.id,
            run_id: m.run_id,
            role: m.role,
            agent: m.agent,
            brief: m.brief,
            tool_id: m.tool_id,
            tab_id: m.tab_id,
            worktree: m.worktree,
            state: m.state,
            outcome: m.outcome,
            summary: m.summary,
            files_modified: m.files_modified,
            reported_at: m.reported_at,
            created_at: m.created_at,
            headless: m.headless,
            context_bytes: c.context_bytes,
            context_ratio: c.context_ratio,
            context_tokens: c.context_tokens,
            context_limit: c.context_limit,
            context_level: c.context_level,
            context_at: c.context_at,
            compact_count: c.compact_count,
            session_id: c.session_id,
            window_official: c.window_official,
            succeeded_by: m.succeeded_by,
            succeeded_from: m.succeeded_from,
            handoff_summary: m.handoff_summary,
            handoff_pending: m.handoff_pending,
            assign: m.assign,
        }
        .serialize(s)
    }
}

impl<'de> Deserialize<'de> for Member {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let m = MemberWire::deserialize(d)?;
        Ok(Self {
            id: m.id,
            run_id: m.run_id,
            role: m.role,
            agent: m.agent,
            brief: m.brief,
            tool_id: m.tool_id,
            tab_id: m.tab_id,
            worktree: m.worktree,
            state: m.state,
            outcome: m.outcome,
            summary: m.summary,
            files_modified: m.files_modified,
            reported_at: m.reported_at,
            created_at: m.created_at,
            headless: m.headless,
            context: ContextState {
                context_bytes: m.context_bytes,
                context_ratio: m.context_ratio,
                context_tokens: m.context_tokens,
                context_limit: m.context_limit,
                context_level: m.context_level,
                context_at: m.context_at,
                compact_count: m.compact_count,
                session_id: m.session_id,
                window_official: m.window_official,
            },
            succeeded_by: m.succeeded_by,
            succeeded_from: m.succeeded_from,
            handoff_summary: m.handoff_summary,
            handoff_pending: m.handoff_pending,
            assign: m.assign,
        })
    }
}

impl Member {
    /// 보고했는가 (FR-RUN-6).
    pub fn reported(&self) -> bool {
        self.reported_at != 0
    }

    /// 닫기를 막지 않는 상태인가 — 보고했거나, 풀려났거나, 승계됐다.
    pub(crate) fn settled(&self) -> bool {
        self.reported() || self.state == RELEASED || self.state == SUCCEEDED
    }

    /// 탭 없이 도는 headless 도구인가.
    pub fn headless_tool(&self) -> bool {
        self.headless && self.tab_id.is_empty() && !self.tool_id.is_empty()
    }
}

/// Run 하나의 기록 (runs.json 의 원소).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename = "run.Record", rename_all = "camelCase")]
pub struct Record {
    pub id: String,
    pub short: String,
    pub objective: String,
    pub projection: String,
    pub isolation: String,
    pub state: String,
    /// 옛 펜싱의 기동 식별자. 읽기만 한다 (FR-ARD-7).
    #[serde(skip_serializing_if = "is_empty")]
    pub epoch: String,
    #[serde(skip_serializing_if = "is_empty")]
    pub coordinator_tool_id: String,
    /// 조정자의 컨텍스트 관측 (FR-RCX-6·7). 없으면 관측이 없다.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub coordinator: Option<ContextState>,
    #[serde(skip_serializing_if = "is_empty")]
    pub coordinator_agent: String,
    #[serde(skip_serializing_if = "is_empty")]
    pub window_id: String,
    #[serde(skip_serializing_if = "is_empty")]
    pub tree: String,
    #[serde(skip_serializing_if = "is_empty")]
    pub tree_branch: bool,
    /// 로컬 이슈 트리의 원본 이슈 폴더(절대 경로). 비면 GitHub 트리다 (ISSUE_TREE_CHAT_SRS FR-LIS-7).
    #[serde(skip_serializing_if = "is_empty")]
    pub issue_dir: String,
    #[serde(skip_serializing_if = "is_empty")]
    pub members: Vec<Member>,
    #[serde(skip_serializing_if = "is_empty")]
    pub repo: String,
    #[serde(skip_serializing_if = "is_empty")]
    pub base: String,
    #[serde(skip_serializing_if = "is_empty")]
    pub merge_into: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree: Option<Worktree>,
    pub created_at: i64,
    #[serde(skip_serializing_if = "is_empty")]
    pub closed_at: i64,
    #[serde(skip_serializing_if = "is_empty")]
    pub abort_reason: String,
    #[serde(skip_serializing_if = "is_empty")]
    pub messages: Vec<MsgEvent>,
}

/// 멤버 간 메시지 하나의 메타데이터. 본문은 싣지 않는다.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "run.MsgEvent")]
pub struct MsgEvent {
    /// 발신 멤버 uuid (조정자는 "coordinator").
    pub from: String,
    pub to: String,
    pub at: i64,
    /// agent | server-alert
    #[serde(skip_serializing_if = "is_empty")]
    pub kind: String,
    /// 본문 바이트 수.
    pub size: i64,
}

impl Record {
    /// 지울 작업 트리들. 경로가 같은 것은 한 번만, 이미 지운 것은 뺀다.
    pub fn worktree_targets(&self) -> Vec<Worktree> {
        let mut seen = std::collections::HashSet::new();
        self.worktree
            .iter()
            .chain(self.members.iter().filter_map(|m| m.worktree.as_ref()))
            .filter(|w| !w.path.is_empty() && !w.removed && seen.insert(w.path.clone()))
            .cloned()
            .collect()
    }

    pub(crate) fn has_member(&self, id: &str) -> bool {
        !id.is_empty() && self.members.iter().any(|m| m.id == id)
    }

    pub(crate) fn predecessor_index(&self, m: &Member) -> Option<usize> {
        if m.succeeded_from.is_empty() {
            return None;
        }
        self.members.iter().position(|x| x.id == m.succeeded_from)
    }
}
