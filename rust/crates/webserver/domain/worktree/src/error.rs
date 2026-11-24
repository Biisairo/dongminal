//! worktree 의 오류. 자기 사유를 들거나 core 의 오류를 감싼다.

use std::fmt;

use dm_webserver_domain_git_core as core;

/// 거부 사유 (Go 의 sentinel 들). 무엇이 위험했는지 호출자가 구분할 수 있어야 한다.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Kind {
    GitMissing,
    NotRepo,
    UnsafeArgument,
    UnsafePath,
    /// 같은 저장소의 다른 worktree 조작이 잠금을 쥐고 있어 대기 상한을 넘겼다 (REPO_FIX 01 §5.6).
    /// 마감(ctx)에 걸린 것은 core 의 Timeout 이다 — 앞은 409, 뒤는 504 다.
    RepoBusy,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::GitMissing => "git_missing",
            Kind::NotRepo => "not_a_git_repo",
            Kind::UnsafeArgument => "unsafe_argument",
            Kind::UnsafePath => "unsafe_path",
            Kind::RepoBusy => "repo_busy",
        }
    }
}

impl fmt::Display for Kind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Clone, Debug)]
pub struct Error {
    msg: String,
    kind: Option<Kind>,
    core: Option<core::Error>,
}

impl Error {
    /// Go `fmt.Errorf("%w: <detail>", ErrX)`.
    pub fn new(kind: Kind, detail: impl fmt::Display) -> Self {
        Error {
            msg: format!("{kind}: {detail}"),
            kind: Some(kind),
            core: None,
        }
    }

    pub fn other(msg: impl Into<String>) -> Self {
        Error {
            msg: msg.into(),
            kind: None,
            core: None,
        }
    }

    /// Go `fmt.Errorf("%w <suffix>", err)`. 종류와 원인을 보존한다.
    pub(crate) fn suffix(mut self, s: impl fmt::Display) -> Self {
        self.msg = format!("{}{s}", self.msg);
        self
    }

    pub fn is(&self, k: Kind) -> bool {
        self.kind == Some(k)
    }

    /// core 의 사유인가 (Go `errors.Is(err, core.ErrX)`).
    pub fn is_core(&self, k: core::Kind) -> bool {
        self.core.as_ref().is_some_and(|c| c.is(k))
    }

    pub fn kind(&self) -> Option<Kind> {
        self.kind
    }

    pub fn core(&self) -> Option<&core::Error> {
        self.core.as_ref()
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.msg)
    }
}

impl std::error::Error for Error {}

impl From<core::Error> for Error {
    fn from(e: core::Error) -> Self {
        Error {
            msg: e.message().to_owned(),
            kind: None,
            core: Some(e),
        }
    }
}

/// git 한 번의 실패. 실패에도 진단 텍스트(stdout 다음 stderr)가 있다.
#[derive(Clone, Debug)]
pub struct Failure {
    pub text: String,
    pub err: Error,
}

impl Failure {
    pub fn new(err: Error) -> Self {
        Failure {
            text: String::new(),
            err,
        }
    }
}
