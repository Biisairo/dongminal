//! query 의 오류. core 의 오류를 감싸거나 query 자신의 사유를 든다.

use std::fmt;
use std::io;

use dm_webserver_domain_git_core as core;

/// query 의 sentinel 오류들.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum QueryKind {
    DiffAxis,
    DiffPath,
    DiffBothAbsent,
    DiffTruncated,
    DiffSide,
    DiffTooLarge,
    LogOrder,
    UnsafeRev,
    RevNotFound,
    NoRemote,
    BlameTruncated,
    BlameParse,
    BlamePathNotFound,
    CommitParent,
}

impl QueryKind {
    pub fn as_str(self) -> &'static str {
        match self {
            QueryKind::DiffAxis => "unknown_diff_axis",
            QueryKind::DiffPath => "unsafe_diff_path",
            QueryKind::DiffBothAbsent => "diff_both_absent",
            QueryKind::DiffTruncated => "diff_truncated",
            QueryKind::DiffSide => "unknown_diff_side",
            QueryKind::DiffTooLarge => "diff_image_too_large",
            QueryKind::LogOrder => "unknown_log_order",
            QueryKind::UnsafeRev => "unsafe_rev",
            QueryKind::RevNotFound => "rev_not_found",
            QueryKind::NoRemote => "no_remote",
            QueryKind::BlameTruncated => "blame_truncated",
            QueryKind::BlameParse => "blame_parse",
            QueryKind::BlamePathNotFound => "blame_path_not_found",
            QueryKind::CommitParent => "bad_parent_index",
        }
    }
}

impl fmt::Display for QueryKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Clone, Debug)]
pub struct Error {
    msg: String,
    kind: Option<QueryKind>,
    core: Option<core::Error>,
}

impl Error {
    /// Go `fmt.Errorf("%w: <detail>", ErrX)`.
    pub fn new(kind: QueryKind, detail: impl fmt::Display) -> Self {
        Error {
            msg: format!("{kind}: {detail}"),
            kind: Some(kind),
            core: None,
        }
    }

    /// sentinel 그대로 (Go `return ErrX`).
    pub fn bare(kind: QueryKind) -> Self {
        Error {
            msg: kind.as_str().to_owned(),
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

    /// Go 의 `*os.PathError`.
    pub(crate) fn io(op: &str, path: &str, e: io::Error) -> Self {
        let pe = dm_gocompat::oserr::path_error(op, path, e);
        Error::other(dm_gocompat::oserr::go_error_string(&pe))
    }

    pub fn is(&self, k: QueryKind) -> bool {
        self.kind == Some(k)
    }

    /// core 의 사유인가 (Go `errors.Is(err, core.ErrX)`).
    pub fn is_core(&self, k: core::Kind) -> bool {
        self.core.as_ref().is_some_and(|c| c.is(k))
    }

    pub fn kind(&self) -> Option<QueryKind> {
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
            msg: e.to_string(),
            kind: None,
            core: Some(e),
        }
    }
}

pub(crate) fn ref_name_error(detail: impl fmt::Display) -> Error {
    core::Error::new(core::Kind::RefName, detail).into()
}

/// Go `%q` 로 찍은 `[]string`.
pub(crate) fn quote_list(v: &[String]) -> String {
    let parts: Vec<String> = v.iter().map(|s| dm_gocompat::strconv::quote(s)).collect();
    format!("[{}]", parts.join(" "))
}

/// Go 의 nil slice 는 JSON `null` 이다. append 로만 채우는 필드에 쓴다 — 비었으면 nil 이다.
pub(crate) fn nil_if_empty<S: serde::Serializer, T: serde::Serialize>(
    v: &[T],
    s: S,
) -> Result<S::Ok, S::Error> {
    if v.is_empty() {
        s.serialize_none()
    } else {
        s.collect_seq(v)
    }
}
