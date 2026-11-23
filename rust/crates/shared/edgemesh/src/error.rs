use std::fmt;

use dm_shared_edge::CallError;

/// 간선 계층의 오류 종류다. 노드가 오류 코드로 옮긴다 (FR-EGM-26·60).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorKind {
    AddrUnknown,
    Outdated,
    Unreachable,
    NotEdge,
    UnknownNode,
    /// 초대 기억이 만료 전 항목으로 가득 찼다 (FR-ATF-51).
    InviteFull,
    /// 건 연결을 attach 가 중복으로 버렸다. 걸기 실패로 센다 (FR-ATF-77).
    Duplicate,
    NoSigner,
    BadKey,
}

impl ErrorKind {
    fn message(self) -> &'static str {
        match self {
            ErrorKind::AddrUnknown => "상대 주소를 모른다",
            ErrorKind::Outdated => "상대가 간선 연결을 모르는 옛 판이다",
            ErrorKind::Unreachable => "상대에 닿지 못했다",
            ErrorKind::NotEdge => "간선이 아니다",
            ErrorKind::UnknownNode => "모르는 노드다",
            ErrorKind::InviteFull => "초대 기억이 가득 찼다",
            ErrorKind::Duplicate => "같은 상대와의 연결이 이미 있다",
            ErrorKind::NoSigner => "노드 키로 서명할 수 없다",
            ErrorKind::BadKey => "노드 키가 아니다",
        }
    }
}

/// 간선 계층의 오류다. `Display` 는 Go 의 오류 문구(`%w: %w` 로 감싼 것 포함)와 같다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MeshError {
    kind: ErrorKind,
    cause: Option<String>,
    call: Option<CallError>,
}

impl MeshError {
    pub(crate) fn new(kind: ErrorKind) -> Self {
        Self {
            kind,
            cause: None,
            call: None,
        }
    }

    pub(crate) fn wrap(kind: ErrorKind, cause: impl fmt::Display) -> Self {
        Self {
            kind,
            cause: Some(cause.to_string()),
            call: None,
        }
    }

    /// 걸기 실패를 감싼다. 원인은 [`MeshError::call_error`] 로 꺼낸다 (Go `%w`).
    pub(crate) fn wrap_call(kind: ErrorKind, cause: CallError) -> Self {
        Self {
            kind,
            cause: Some(cause.to_string()),
            call: Some(cause),
        }
    }

    /// 감싼 걸기 실패다. Go 의 `errors.As(err, &*edge.RemoteError)` 등에 해당한다.
    pub fn call_error(&self) -> Option<&CallError> {
        self.call.as_ref()
    }

    /// Go 의 `errors.Is(err, edgemesh.ErrXxx)` 에 해당한다.
    pub fn kind(&self) -> ErrorKind {
        self.kind
    }
}

impl From<ErrorKind> for MeshError {
    fn from(kind: ErrorKind) -> Self {
        Self::new(kind)
    }
}

impl fmt::Display for MeshError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.cause {
            Some(c) => write!(f, "{}: {c}", self.kind.message()),
            None => f.write_str(self.kind.message()),
        }
    }
}

impl std::error::Error for MeshError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        self.call
            .as_ref()
            .map(|c| c as &(dyn std::error::Error + 'static))
    }
}
