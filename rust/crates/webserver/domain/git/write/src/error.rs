//! write 의 거부·실패 사유. Go 의 sentinel(`errors.Is`)을 [`Error::is`]·[`Error::is_query`]·
//! [`Error::is_core`] 로 가른다. `Display` 는 Go `err.Error()` 와 같다.

use std::fmt;

use otter_webserver_domain_git_core as core;
use otter_webserver_domain_git_query as query;

use core::Output;
use query::QueryKind;

/// write 의 sentinel 오류들.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum WriteKind {
    Operation,
    PickVerb,
    MergeParent,
    ResetMode,
    BranchExists,
    CheckoutTarget,
    BranchRename,
    BranchDelete,
    MergeMode,
    BranchUpstream,
    PullMode,
    PushForce,
    ForceConfirm,
    PublishRequired,
    UpstreamLocal,
    DetachedPush,
    PushTarget,
    RemoteName,
    RemoteUrl,
    RemoteExists,
    RemoteMissing,
    ReplayTarget,
    StashEmpty,
    StashMoved,
    TagExists,
    TagNotFound,
    TagKind,
    TagMessage,
    TagPushTarget,
    PatchOp,
    PatchAxis,
    PatchStale,
    PatchRange,
    PatchEmpty,
    UncommittedNoHead,
    NothingToClean,
    CleanChanged,
    IgnorePath,
}

impl WriteKind {
    pub fn as_str(self) -> &'static str {
        use WriteKind::*;
        match self {
            Operation => "operation_invalid",
            PickVerb => "pick_verb_invalid",
            MergeParent => "merge_parent_required",
            ResetMode => "reset_mode_invalid",
            BranchExists => "branch_exists",
            CheckoutTarget => "checkout_target_invalid",
            BranchRename => "branch_rename_invalid",
            BranchDelete => "branch_delete_invalid",
            MergeMode => "merge_mode_invalid",
            BranchUpstream => "branch_upstream_invalid",
            PullMode => "pull_mode_invalid",
            PushForce => "push_force_invalid",
            ForceConfirm => "force_confirmation_required",
            PublishRequired => "publish_required",
            UpstreamLocal => "upstream_local",
            DetachedPush => "detached_head_push",
            PushTarget => "push_target_invalid",
            RemoteName => "remote_name_invalid",
            RemoteUrl => "remote_url_invalid",
            RemoteExists => "remote_exists",
            RemoteMissing => "remote_missing",
            ReplayTarget => "replay_target_invalid",
            StashEmpty => "nothing_to_stash",
            StashMoved => "stash_moved",
            TagExists => "tag_exists",
            TagNotFound => "tag_not_found",
            TagKind => "tag_kind_invalid",
            TagMessage => "tag_message_required",
            TagPushTarget => "tag_push_target_invalid",
            PatchOp => "patch_op_invalid",
            PatchAxis => "patch_axis_invalid",
            PatchStale => "patch_stale",
            PatchRange => "patch_range_invalid",
            PatchEmpty => "patch_empty",
            UncommittedNoHead => "no_head",
            NothingToClean => "nothing_to_clean",
            CleanChanged => "clean_changed",
            IgnorePath => "unsafe_ignore_path",
        }
    }
}

impl fmt::Display for WriteKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// 경로 묶음 실행이 중간에 실패했다 (Go `*BatchError`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Batch {
    /// 실패한 묶음의 argv.
    pub argv: Vec<String>,
    /// 실패 전에 실행이 끝난 경로 수.
    pub applied: usize,
    /// 요청된 경로 수.
    pub total: usize,
}

impl Batch {
    pub fn partial(&self) -> bool {
        self.applied > 0
    }
}

#[derive(Clone, Debug)]
pub struct Error(Box<Inner>);

#[derive(Clone, Debug)]
struct Inner {
    msg: String,
    kinds: Vec<WriteKind>,
    query: Vec<query::Error>,
    batch: Option<Batch>,
    branch_exists: Option<String>,
    output: Option<Output>,
}

impl Error {
    /// Go `fmt.Errorf("%w: <detail>", Err<kind>)`.
    pub(crate) fn new(kind: WriteKind, detail: impl fmt::Display) -> Self {
        Self::bare(kind, format!("{kind}: {detail}"))
    }

    fn bare(kind: WriteKind, msg: String) -> Self {
        Error(Box::new(Inner {
            msg,
            kinds: vec![kind],
            query: Vec::new(),
            batch: None,
            branch_exists: None,
            output: None,
        }))
    }

    /// Go `fmt.Errorf("%w: %w", Err<kind>, inner)`.
    pub(crate) fn wrap(kind: WriteKind, inner: impl Into<Error>) -> Self {
        let mut e: Error = inner.into();
        e.0.msg = format!("{kind}: {}", e.0.msg);
        e.0.kinds.insert(0, kind);
        e
    }

    /// Go `fmt.Errorf("%w: %v", Err<kind>, inner)` — 안쪽 사유는 문구로만 남는다.
    pub(crate) fn wrap_text(kind: WriteKind, inner: impl fmt::Display) -> Self {
        Self::new(kind, inner)
    }

    /// sentinel 없는 오류 (Go `fmt.Errorf("...")`).
    pub(crate) fn other(msg: impl Into<String>) -> Self {
        Error(Box::new(Inner {
            msg: msg.into(),
            kinds: Vec::new(),
            query: Vec::new(),
            batch: None,
            branch_exists: None,
            output: None,
        }))
    }

    pub(crate) fn unsafe_argument(detail: impl fmt::Display) -> Self {
        core::Error::new(core::Kind::UnsafeArgument, detail).into()
    }

    pub(crate) fn branch_exists_for(name: &str) -> Self {
        let mut e = Self::bare(
            WriteKind::BranchExists,
            format!(
                "{}: 로컬 브랜치 {} 가 이미 있다",
                WriteKind::BranchExists,
                otter_gocompat::strconv::quote(name)
            ),
        );
        e.0.branch_exists = Some(name.to_owned());
        e
    }

    pub(crate) fn batch_failed(batch: Batch, inner: Error) -> Self {
        let mut e = inner;
        e.0.msg = format!(
            "git {}: 경로 {}/{} 까지 적용된 뒤 실패했다: {}",
            batch.argv.join(" "),
            batch.applied,
            batch.total,
            e.0.msg
        );
        e.0.batch = Some(batch);
        e
    }

    /// Go `errors.Join(a, b)`.
    pub(crate) fn join(a: Option<Error>, b: Error) -> Self {
        let Some(mut a) = a else {
            return b;
        };
        a.0.msg = format!("{}\n{}", a.0.msg, b.0.msg);
        a.0.kinds.extend(b.0.kinds);
        a.0.query.extend(b.0.query);
        a.0.batch = a.0.batch.or(b.0.batch);
        a.0.branch_exists = a.0.branch_exists.or(b.0.branch_exists);
        a
    }

    pub(crate) fn with_output(mut self, out: Output) -> Self {
        self.0.output = Some(out);
        self
    }

    pub fn is(&self, k: WriteKind) -> bool {
        self.0.kinds.contains(&k)
    }

    pub fn is_query(&self, k: QueryKind) -> bool {
        self.0.query.iter().any(|q| q.is(k))
    }

    pub fn is_core(&self, k: core::Kind) -> bool {
        self.0.query.iter().any(|q| q.is_core(k))
    }

    /// 가장 바깥 sentinel.
    pub fn kind(&self) -> Option<WriteKind> {
        self.0.kinds.first().copied()
    }

    pub fn query(&self) -> Option<&query::Error> {
        self.0.query.first()
    }

    pub fn core(&self) -> Option<&core::Error> {
        self.0.query.iter().find_map(query::Error::core)
    }

    /// Go `errors.As(err, &*BatchError)`.
    pub fn batch(&self) -> Option<&Batch> {
        self.0.batch.as_ref()
    }

    /// Go `errors.As(err, &*BranchExistsError)` 의 `Name`.
    pub fn branch_exists(&self) -> Option<&str> {
        self.0.branch_exists.as_deref()
    }

    /// Go `core.PlainExit(err)`.
    pub fn plain_exit(&self) -> Option<&core::ExecError> {
        self.core().and_then(core::plain_exit)
    }

    /// Go 가 오류와 함께 돌려준 Output. 실행 전 거부는 `exit_code == -1` 이다.
    pub fn output(&self) -> Output {
        self.0.output.clone().unwrap_or_else(denied)
    }

    pub fn message(&self) -> &str {
        &self.0.msg
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0.msg)
    }
}

impl std::error::Error for Error {}

impl From<query::Error> for Error {
    fn from(e: query::Error) -> Self {
        Error(Box::new(Inner {
            msg: e.to_string(),
            kinds: Vec::new(),
            query: vec![e],
            batch: None,
            branch_exists: None,
            output: None,
        }))
    }
}

impl From<core::Error> for Error {
    fn from(e: core::Error) -> Self {
        query::Error::from(e).into()
    }
}

/// 실행하지 않았다는 표시 (Go `denied()`).
pub fn denied() -> Output {
    Output {
        exit_code: -1,
        ..Output::default()
    }
}

/// Go `s.ExecWrite(...)`: 실패하면 그 실행의 Output 을 오류에 싣는다.
pub(crate) async fn exec_write(
    s: &core::Service,
    ctx: &core::Ctx,
    repo: &str,
    spec: core::WriteSpec,
) -> Result<Output, Error> {
    s.exec_write(ctx, repo, &spec).await.map_err(exec_err)
}

/// Go `s.Exec(...)`.
pub(crate) async fn exec<S: AsRef<str>>(
    s: &core::Service,
    ctx: &core::Ctx,
    repo: &str,
    args: &[S],
) -> Result<Output, Error> {
    s.exec(ctx, repo, args).await.map_err(exec_err)
}

fn exec_err(e: core::Error) -> Error {
    let out = e.output().cloned().unwrap_or_default();
    Error::from(e).with_output(out)
}
