//! 거부·실패 사유 (FR-GIT-8). 호출자가 `is(Kind)` 로 종류를 가를 수 있어야 한다.

use std::fmt;

use dm_gocompat::strconv::quote;

use crate::ctx::{Ctx, CtxError};
use crate::exclusion::index_locked_stderr;
use crate::exec::Output;

/// Go 의 sentinel 오류들.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Kind {
    GitMissing,
    NotRepo,
    /// 작업 디렉터리 자체가 없다 (FR-RMS-1). NotRepo 와 가른다.
    RepoMissing,
    Timeout,
    /// 호출자가 요청을 거둬들였다 (FR-GIT-217).
    Canceled,
    UnsafeArgument,
    WriteCommand,
    IndexLocked,
    ServerShutdown,
    /// git 의 ref 이름 규칙을 어긴 이름이다 (FR-GIT-159).
    RefName,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::GitMissing => "git_missing",
            Kind::NotRepo => "not_a_git_repo",
            Kind::RepoMissing => "repo_missing",
            Kind::Timeout => "git_timeout",
            Kind::Canceled => "git_canceled",
            Kind::UnsafeArgument => "unsafe_argument",
            Kind::WriteCommand => "write_command_not_allowed",
            Kind::IndexLocked => "index_locked",
            Kind::ServerShutdown => "server_shutdown",
            Kind::RefName => "ref_name_invalid",
        }
    }
}

impl fmt::Display for Kind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// 실패한 실행 그 자체다. stderr 를 잃지 않는 것이 목적이다.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExecError {
    pub argv: Vec<String>,
    pub cwd: String,
    pub exit_code: i32,
    pub stderr: String,
    pub(crate) kind: Option<Kind>,
}

impl ExecError {
    pub fn new(
        argv: Vec<String>,
        cwd: String,
        exit_code: i32,
        stderr: String,
        kind: Option<Kind>,
    ) -> Self {
        ExecError {
            argv,
            cwd,
            exit_code,
            stderr,
            kind,
        }
    }

    /// Go `Unwrap()`. 분류 불가면 None 이다.
    pub fn kind(&self) -> Option<Kind> {
        self.kind
    }
}

impl fmt::Display for ExecError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let trimmed = self.stderr.trim();
        let msg = if trimmed.is_empty() {
            "(stderr 없음)"
        } else {
            trimmed
        };
        if let Some(k) = self.kind {
            write!(f, "{k}: ")?;
        }
        write!(
            f,
            "git {} (exit {}): {msg}",
            self.argv.join(" "),
            self.exit_code
        )
    }
}

impl std::error::Error for ExecError {}

/// core 의 오류. 실행 함수가 실패해도 Output 을 잃지 않는다 — `output()` 에 싣는다.
#[derive(Clone, Debug)]
pub struct Error {
    kind: Option<Kind>,
    msg: String,
    exec: Option<Box<ExecError>>,
    ctx: Option<CtxError>,
    out: Option<Box<Output>>,
}

impl Error {
    /// Go `fmt.Errorf("%w: <detail>", kind)`.
    pub fn new(kind: Kind, detail: impl fmt::Display) -> Self {
        Error {
            kind: Some(kind),
            msg: format!("{kind}: {detail}"),
            exec: None,
            ctx: None,
            out: None,
        }
    }

    /// 분류되지 않은 오류.
    pub fn other(msg: impl Into<String>) -> Self {
        Error {
            kind: None,
            msg: msg.into(),
            exec: None,
            ctx: None,
            out: None,
        }
    }

    /// 끝난 문맥의 오류 그대로 (Go 에서 runner 가 `ctx.Err()` 를 돌려준 경우).
    pub fn from_ctx(e: CtxError) -> Self {
        Error {
            kind: None,
            msg: e.to_string(),
            exec: None,
            ctx: Some(e),
            out: None,
        }
    }

    pub fn from_exec(e: ExecError) -> Self {
        Error {
            kind: e.kind,
            msg: e.to_string(),
            exec: Some(Box::new(e)),
            ctx: None,
            out: None,
        }
    }

    /// Go `fmt.Errorf("<prefix>: %w", err)`. 종류·실행 오류·문맥 오류를 보존한다.
    pub fn wrap(mut self, prefix: impl fmt::Display) -> Self {
        self.msg = format!("{prefix}: {}", self.msg);
        self
    }

    pub fn with_output(mut self, out: Output) -> Self {
        self.out = Some(Box::new(out));
        self
    }

    /// Go `errors.Is(err, ErrX)`.
    pub fn is(&self, k: Kind) -> bool {
        self.kind == Some(k)
    }

    /// Go `errors.Is(err, context.X)`.
    pub fn is_ctx(&self, e: CtxError) -> bool {
        self.ctx == Some(e)
    }

    pub fn kind(&self) -> Option<Kind> {
        self.kind
    }

    /// Go `errors.As(err, &*ExecError)`.
    pub fn exec_error(&self) -> Option<&ExecError> {
        self.exec.as_deref()
    }

    /// 실패한 실행의 출력. 실행 전에 거부됐으면 exit -1 인 빈 출력이다.
    pub fn output(&self) -> Option<&Output> {
        self.out.as_deref()
    }

    pub fn message(&self) -> &str {
        &self.msg
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.msg)
    }
}

impl std::error::Error for Error {}

impl From<ExecError> for Error {
    fn from(e: ExecError) -> Self {
        Error::from_exec(e)
    }
}

impl From<CtxError> for Error {
    fn from(e: CtxError) -> Self {
        Error::from_ctx(e)
    }
}

/// 다시 물어도 같은 답일 실패인가 (REPO_FIX 01 S-4).
pub fn is_terminal(err: &Error) -> bool {
    err.is(Kind::NotRepo) || err.is(Kind::RepoMissing) || err.is(Kind::GitMissing)
}

/// 분류되지 않은 종료인가 (FR-OPT-7-1). exit 코드가 곧 답인 조회들이 쓴다.
pub fn plain_exit(err: &Error) -> Option<&ExecError> {
    err.exec_error().filter(|x| x.kind.is_none())
}

/// 끝난 ctx 를 core 의 분류로 옮긴다 (FR-ATF-9). 끝나지 않았으면 None 이다.
pub fn ctx_err(ctx: &Ctx, what: &str) -> Option<Error> {
    let e = ctx.err()?;
    let kind = match e {
        CtxError::DeadlineExceeded => Kind::Timeout,
        CtxError::Canceled => Kind::Canceled,
    };
    let mut out = Error::new(kind, format!("{what}: {e}"));
    out.ctx = Some(e);
    Some(out)
}

/// stderr 와 ctx 로 실패의 종류를 정한다.
pub(crate) fn classify(ctx: &Ctx, stderr: &str) -> Option<Kind> {
    match ctx.err() {
        Some(CtxError::DeadlineExceeded) => return Some(Kind::Timeout),
        Some(CtxError::Canceled) => return Some(Kind::Canceled),
        None => {}
    }
    let low = stderr.to_lowercase();
    if low.contains("not a git repository") || low.contains("not a working tree") {
        return Some(Kind::NotRepo);
    }
    if index_locked_stderr(stderr) {
        return Some(Kind::IndexLocked);
    }
    None
}

/// Go `%q` 로 찍은 `[]string`.
pub(crate) fn quote_list<S: AsRef<str>>(v: &[S]) -> String {
    let parts: Vec<String> = v.iter().map(|s| quote(s.as_ref())).collect();
    format!("[{}]", parts.join(" "))
}

/// Go `%v` 로 찍은 `[]string`.
pub(crate) fn plain_list<S: AsRef<str>>(v: &[S]) -> String {
    let parts: Vec<&str> = v.iter().map(|s| s.as_ref()).collect();
    format!("[{}]", parts.join(" "))
}
