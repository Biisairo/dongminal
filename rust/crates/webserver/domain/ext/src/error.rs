//! Go 의 `error` 하나. 문구는 Go `err.Error()` 와 같고, `errors.Is` 로 가리던 표지는 [`Sentinel`] 이다.

use std::fmt;
use std::io;

use dm_gocompat::oserr::go_error_string;

/// Go 의 이름 붙은 오류 값 (`ErrArchiveTooLarge`·`ErrExtractTooLarge`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Sentinel {
    /// 받는 중에 [`crate::MAX_ARCHIVE_BYTES`] 를 넘었다.
    ArchiveTooLarge,
    /// 풀어 놓은 총량이 상한을 넘었다 (FR-ATF-25).
    ExtractTooLarge,
}

impl Sentinel {
    fn text(self) -> &'static str {
        match self {
            Sentinel::ArchiveTooLarge => "아카이브가 크기 상한을 넘었습니다",
            Sentinel::ExtractTooLarge => "아카이브를 푼 총량이 상한을 넘었습니다",
        }
    }

    /// 이 표지를 담은 `io::Error`. 쓰기·읽기 도중에 표지를 실어 나른다.
    pub(crate) fn io(self) -> io::Error {
        io::Error::other(SentinelError(self))
    }
}

#[derive(Debug)]
struct SentinelError(Sentinel);

impl fmt::Display for SentinelError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.0.text())
    }
}

impl std::error::Error for SentinelError {}

/// 오류 하나. `Display` 는 Go 의 문구다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Error {
    msg: String,
    sentinel: Option<Sentinel>,
}

impl Error {
    pub(crate) fn new(msg: impl Into<String>) -> Self {
        Self {
            msg: msg.into(),
            sentinel: None,
        }
    }

    /// Go `fmt.Errorf("<prefix>: %w", err)`.
    pub(crate) fn wrap(self, prefix: impl fmt::Display) -> Self {
        Self {
            msg: format!("{prefix}: {}", self.msg),
            sentinel: self.sentinel,
        }
    }

    /// Go `errors.Is(err, <표지>)`.
    pub fn is(&self, s: Sentinel) -> bool {
        self.sentinel == Some(s)
    }
}

impl From<Sentinel> for Error {
    fn from(s: Sentinel) -> Self {
        Self {
            msg: s.text().to_owned(),
            sentinel: Some(s),
        }
    }
}

impl From<io::Error> for Error {
    fn from(e: io::Error) -> Self {
        let sentinel = e
            .get_ref()
            .and_then(|r| r.downcast_ref::<SentinelError>())
            .map(|s| s.0);
        Self {
            msg: go_error_string(&e),
            sentinel,
        }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.msg)
    }
}

impl std::error::Error for Error {}

/// Go `fmt.Errorf(format, ...)` 처럼 문구만 있는 오류.
macro_rules! errorf {
    ($($t:tt)*) => { $crate::error::Error::new(format!($($t)*)) };
}
pub(crate) use errorf;
