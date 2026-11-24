//! 잡의 거부 사유. Go sentinel 은 [`Error::is`]·[`Error::is_core`] 로 가른다.

use std::fmt;

use otter_webserver_domain_git_core as core;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum JobsKind {
    JobBusy,
    JobKind,
    RepoBusy,
}

impl JobsKind {
    pub fn as_str(self) -> &'static str {
        match self {
            JobsKind::JobBusy => "job_busy",
            JobsKind::JobKind => "job_kind_not_allowed",
            JobsKind::RepoBusy => "repo_busy",
        }
    }
}

impl fmt::Display for JobsKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Clone, Debug)]
pub struct Error {
    msg: String,
    kind: Option<JobsKind>,
    core: Option<Box<core::Error>>,
}

impl Error {
    pub(crate) fn new(kind: JobsKind, detail: impl fmt::Display) -> Self {
        Error {
            msg: format!("{kind}: {detail}"),
            kind: Some(kind),
            core: None,
        }
    }

    pub fn is(&self, k: JobsKind) -> bool {
        self.kind == Some(k)
    }

    pub fn is_core(&self, k: core::Kind) -> bool {
        self.core.as_ref().is_some_and(|c| c.is(k))
    }

    pub fn kind(&self) -> Option<JobsKind> {
        self.kind
    }

    pub fn core(&self) -> Option<&core::Error> {
        self.core.as_deref()
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
            msg: e.to_string(),
            kind: None,
            core: Some(Box::new(e)),
        }
    }
}
