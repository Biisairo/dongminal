//! Go 의 `error` 하나. 문구는 Go `err.Error()` 와 같고, `errors.Is` 로 가리던 표지는 [`Sentinel`],
//! `errors.As(*HTTPStatusError)` 는 [`Error::http_status`] 다.

use std::fmt;
use std::io;

use otter_gocompat::oserr::go_error_string;

/// Go 의 이름 붙은 오류 값.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Sentinel {
    /// `ErrInvalid`
    Invalid,
    /// `ErrNotFound`
    NotFound,
    /// `ErrInvalidID`
    InvalidId,
    /// `ErrKeychainUnavailable`
    KeychainUnavailable,
    /// `ErrClaudeLockTimeout`
    ClaudeLockTimeout,
    /// `ErrReloginRequired`
    ReloginRequired,
    /// `os.ErrNotExist`
    NotExist,
    /// `ErrNotLoggedIn`
    NotLoggedIn,
    /// `ErrLiveEmpty`
    LiveEmpty,
    /// `ErrEmptyBackup`
    EmptyBackup,
    /// `ErrLiveChanged`
    LiveChanged,
    /// `ErrNoCandidate`
    NoCandidate,
    /// `ErrTooSoon`
    TooSoon,
    /// `ErrCswapRunning`
    CswapRunning,
}

impl Sentinel {
    pub(crate) fn text(self) -> &'static str {
        match self {
            Sentinel::Invalid => "값이 범위를 벗어났습니다",
            Sentinel::NotFound => "계정이 없습니다",
            Sentinel::InvalidId => "계정 ID 형식이 틀렸습니다",
            Sentinel::KeychainUnavailable => "키체인을 읽을 수 없습니다",
            Sentinel::ClaudeLockTimeout => {
                "Claude Code 가 자격증명을 갱신하는 중입니다. 잠시 뒤 다시 시도하세요"
            }
            Sentinel::ReloginRequired => "다시 로그인해야 합니다",
            Sentinel::NotExist => "file does not exist",
            Sentinel::NotLoggedIn => {
                "Claude Code 에 로그인한 계정이 없습니다. 먼저 Claude Code 에서 /login 으로 로그인하세요"
            }
            Sentinel::LiveEmpty => "활성 자격증명이 없습니다. Claude Code 에서 다시 로그인하세요",
            Sentinel::EmptyBackup => {
                "이 계정의 백업이 비었습니다. 그 계정으로 로그인한 뒤 다시 추가하세요"
            }
            Sentinel::LiveChanged => "전환 도중 활성 자격증명이 바뀌었습니다. 다시 시도하세요",
            Sentinel::NoCandidate => "전환할 계정이 없습니다",
            Sentinel::TooSoon => "조금 전에 조회했거나 물러나는 중입니다",
            Sentinel::CswapRunning => {
                "cswap 자동 전환이 돌고 있습니다. 먼저 cswap auto 를 멈추세요"
            }
        }
    }
}

/// Go `*HTTPStatusError`: 2xx 가 아닌 응답이다. 본문은 싣지 않는다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpStatusError {
    pub status: u16,
    pub retry_after: String,
}

impl fmt::Display for HttpStatusError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "anthropic api: status {}", self.status)
    }
}

/// 오류 하나. `Display` 는 Go 의 문구다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Error {
    msg: String,
    sentinel: Option<Sentinel>,
    http: Option<HttpStatusError>,
}

impl Error {
    pub(crate) fn new(msg: impl Into<String>) -> Self {
        Self {
            msg: msg.into(),
            sentinel: None,
            http: None,
        }
    }

    /// Go `fmt.Errorf("<prefix>: %w", err)`.
    pub(crate) fn wrap(self, prefix: impl fmt::Display) -> Self {
        Self {
            msg: format!("{prefix}: {}", self.msg),
            ..self
        }
    }

    /// Go `fmt.Errorf("%w: <detail>", sentinel)`.
    pub(crate) fn with_detail(s: Sentinel, detail: impl fmt::Display) -> Self {
        Self {
            msg: format!("{}: {detail}", s.text()),
            sentinel: Some(s),
            http: None,
        }
    }

    /// 표지를 지닌 임의 문구 (`fmt.Errorf("%w (%s)", sentinel, x)` 처럼 `: ` 가 아닌 꼴).
    pub(crate) fn tagged(s: Sentinel, msg: String) -> Self {
        Self {
            msg,
            sentinel: Some(s),
            http: None,
        }
    }

    /// Go `errors.Is(err, <표지>)`.
    pub fn is(&self, s: Sentinel) -> bool {
        self.sentinel == Some(s)
    }

    /// Go `errors.As(err, &*HTTPStatusError)`.
    pub fn http_status(&self) -> Option<&HttpStatusError> {
        self.http.as_ref()
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.msg)
    }
}

impl std::error::Error for Error {}

impl From<Sentinel> for Error {
    fn from(s: Sentinel) -> Self {
        Self {
            msg: s.text().to_owned(),
            sentinel: Some(s),
            http: None,
        }
    }
}

impl From<HttpStatusError> for Error {
    fn from(e: HttpStatusError) -> Self {
        Self {
            msg: e.to_string(),
            sentinel: None,
            http: Some(e),
        }
    }
}

impl From<io::Error> for Error {
    fn from(e: io::Error) -> Self {
        let sentinel = (e.kind() == io::ErrorKind::NotFound).then_some(Sentinel::NotExist);
        Self {
            msg: go_error_string(&e),
            sentinel,
            http: None,
        }
    }
}

impl From<otter_gocompat::json::Error> for Error {
    fn from(e: otter_gocompat::json::Error) -> Self {
        Self::new(e.to_string())
    }
}

impl From<otter_shared_platform::SecretsError> for Error {
    fn from(e: otter_shared_platform::SecretsError) -> Self {
        Self::new(e.to_string())
    }
}

/// Go `errors.Join`: nil 을 빼고 줄바꿈으로 잇는다. 모두 nil 이면 `Ok`.
pub(crate) fn join(errs: Vec<Error>) -> Result<(), Error> {
    if errs.is_empty() {
        return Ok(());
    }
    let msg = errs
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>()
        .join("\n");
    let sentinel = errs.iter().find_map(|e| e.sentinel);
    let http = errs.iter().find_map(|e| e.http.clone());
    Err(Error {
        msg,
        sentinel,
        http,
    })
}
