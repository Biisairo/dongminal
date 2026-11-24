use std::fmt;

// 채팅 연산의 오류 코드다 (FR-PCH-51). MCP·IPC 로 그대로 나간다.
pub const CODE_NOT_IN_ROOM: &str = "not_in_room";
pub const CODE_NO_SUCH_ROOM: &str = "no_such_room";
pub const CODE_NO_SUCH_PARTICIPANT: &str = "no_such_participant";
pub const CODE_TOO_LARGE: &str = "too_large";
pub const CODE_RATE_LIMITED: &str = "rate_limited";
pub const CODE_BAD_REQUEST: &str = "bad_request";

/// 채팅 오류다. 코드가 비면 채팅 오류가 아닌 것(Go 의 일반 `error`)이다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Error {
    code: &'static str,
    msg: String,
}

impl Error {
    pub(crate) fn fail(code: &'static str, msg: impl Into<String>) -> Self {
        Self {
            code,
            msg: msg.into(),
        }
    }

    pub(crate) fn plain(e: impl fmt::Display) -> Self {
        Self {
            code: "",
            msg: e.to_string(),
        }
    }

    /// 채팅 오류 코드다. 채팅 오류가 아니면 빈 값이다 (Go `ErrorCode`).
    pub fn code(&self) -> &'static str {
        self.code
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.code.is_empty() {
            f.write_str(&self.msg)
        } else {
            write!(f, "{}: {}", self.code, self.msg)
        }
    }
}

impl std::error::Error for Error {}
