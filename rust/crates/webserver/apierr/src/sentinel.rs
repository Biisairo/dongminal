//! Go 의 sentinel 오류(`errors.Is` 대상)를 한 타입으로 모은다.

use std::fmt;
use std::io;

use otter_webserver_domain_git_core as core;
use otter_webserver_domain_git_jobs as jobs;
use otter_webserver_domain_git_query as query;
use otter_webserver_domain_git_write as write;
use otter_webserver_domain_worktree as worktree;

/// wsentry 의 sentinel.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum WsentryKind {
    NotAbsolute,
    NotFound,
    NotDir,
    Unavailable,
}

/// 오류 판정의 대상 하나 (Go 의 `var ErrX = errors.New(...)`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Sentinel {
    Core(core::Kind),
    Query(query::QueryKind),
    Write(write::WriteKind),
    Jobs(jobs::JobsKind),
    Worktree(worktree::Kind),
    /// run 의 사유 코드 (Go `run.ErrX.Error()`).
    Run(&'static str),
    /// Go `fs.ErrNotExist`·`fs.ErrExist`·`fs.ErrPermission`.
    Fs(io::ErrorKind),
    Wsentry(WsentryKind),
    /// Go `sysstat.ErrUnsupported`.
    SysstatUnsupported,
}

impl fmt::Display for Sentinel {
    /// Go `err.Error()` 의 문구.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Sentinel::Core(k) => f.write_str(k.as_str()),
            Sentinel::Query(k) => f.write_str(k.as_str()),
            Sentinel::Write(k) => f.write_str(k.as_str()),
            Sentinel::Jobs(k) => f.write_str(k.as_str()),
            Sentinel::Worktree(k) => f.write_str(k.as_str()),
            Sentinel::Run(c) => f.write_str(c),
            Sentinel::Fs(io::ErrorKind::NotFound) => f.write_str("file does not exist"),
            Sentinel::Fs(io::ErrorKind::AlreadyExists) => f.write_str("file already exists"),
            Sentinel::Fs(io::ErrorKind::PermissionDenied) => f.write_str("permission denied"),
            Sentinel::Fs(k) => write!(f, "{k}"),
            Sentinel::Wsentry(k) => f.write_str(match k {
                WsentryKind::NotAbsolute => "경로가 절대경로가 아니다",
                WsentryKind::NotFound => "경로가 없다",
                WsentryKind::NotDir => "디렉터리가 아니다",
                WsentryKind::Unavailable => "workspace 를 쓸 수 없다",
            }),
            Sentinel::SysstatUnsupported => {
                f.write_str("sysstat: 이 빌드/플랫폼에서 지원되지 않는 지표")
            }
        }
    }
}

/// Go `errors.Is(err, sentinel)`. 각 crate 의 오류가 감싼 사유까지 본다.
pub trait Classify {
    fn is(&self, s: &Sentinel) -> bool;
}

impl Classify for core::Error {
    fn is(&self, s: &Sentinel) -> bool {
        matches!(s, Sentinel::Core(k) if core::Error::is(self, *k))
    }
}

impl Classify for query::Error {
    fn is(&self, s: &Sentinel) -> bool {
        match s {
            Sentinel::Query(k) => query::Error::is(self, *k),
            Sentinel::Core(k) => self.is_core(*k),
            _ => false,
        }
    }
}

impl Classify for write::Error {
    fn is(&self, s: &Sentinel) -> bool {
        match s {
            Sentinel::Write(k) => write::Error::is(self, *k),
            Sentinel::Query(k) => self.is_query(*k),
            Sentinel::Core(k) => self.is_core(*k),
            _ => false,
        }
    }
}

impl Classify for jobs::Error {
    fn is(&self, s: &Sentinel) -> bool {
        match s {
            Sentinel::Jobs(k) => jobs::Error::is(self, *k),
            Sentinel::Core(k) => self.is_core(*k),
            _ => false,
        }
    }
}

impl Classify for worktree::Error {
    fn is(&self, s: &Sentinel) -> bool {
        match s {
            Sentinel::Worktree(k) => worktree::Error::is(self, *k),
            Sentinel::Core(k) => self.is_core(*k),
            _ => false,
        }
    }
}

impl Classify for otter_webserver_domain_run::Error {
    fn is(&self, s: &Sentinel) -> bool {
        matches!(s, Sentinel::Run(c) if self.code() == *c)
    }
}

impl Classify for otter_webserver_domain_wsentry::Error {
    fn is(&self, s: &Sentinel) -> bool {
        use otter_webserver_domain_wsentry::Error as E;
        let Sentinel::Wsentry(k) = s else {
            return false;
        };
        matches!(
            (self, k),
            (E::NotAbsolute, WsentryKind::NotAbsolute)
                | (E::NotFound, WsentryKind::NotFound)
                | (E::NotDir, WsentryKind::NotDir)
                | (E::Unavailable, WsentryKind::Unavailable)
        )
    }
}

impl Classify for io::Error {
    fn is(&self, s: &Sentinel) -> bool {
        matches!(s, Sentinel::Fs(k) if self.kind() == *k)
    }
}

impl Classify for otter_webserver_domain_sysstat::Error {
    fn is(&self, s: &Sentinel) -> bool {
        matches!(
            (self, s),
            (
                otter_webserver_domain_sysstat::Error::Unsupported,
                Sentinel::SysstatUnsupported
            )
        )
    }
}
