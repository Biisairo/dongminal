use std::{fmt, io};

use dm_gocompat::{json, strconv};
use dm_shared_toolipc::{PROTOCOL_VERSION, RpcError};

/// toolhub `ErrToolCap` 의 문구다. toolhub 에 아직 없어 여기 둔다 (2.2.3 이 옮겨 갈 자리).
pub const ERR_TOOL_CAP: &str = "도구 수가 상한에 이르렀다";
/// toolhub `ErrToolNotFound` 의 문구다.
pub const ERR_TOOL_NOT_FOUND: &str = "toolhub: tool not found";

/// 데몬 클라이언트의 오류다. `Display` 는 Go 의 `err.Error()` 와 같다. 오류 문구의 `paned` 는
/// toolio·chat·WS 오류 본문에 그대로 실려 나가는 와이어라 바꾸지 않는다 (FR-RGS-6).
#[derive(Debug)]
pub enum Error {
    /// 연결한 적이 없다.
    NotConnected,
    /// 응답 전에 연결이 끊겼다.
    ConnectionLost,
    /// 시한 안에 응답이 없었다. 연결은 끊기고 감독이 다시 붙는다 (FR-14).
    Timeout { method: String },
    /// 클라이언트를 닫았다.
    Closed,
    /// 데몬이 오류로 답했다.
    Rpc(RpcError),
    /// 요청을 부호화하지 못했거나 응답을 해석하지 못했다.
    Json(json::Error),
    /// 소켓 연결·쓰기 실패.
    Io(io::Error),
    /// 도구 수 상한 (Go `fmt.Errorf("%w: %s", toolhub.ErrToolCap, msg)`).
    ToolCap(String),
    /// 없는 도구 (Go `fmt.Errorf("%w: %s", toolhub.ErrToolNotFound, id)`).
    ToolNotFound(String),
    /// hello 실패.
    Hello(Box<Error>),
    /// 데몬의 프로토콜 판이 다르다 (FR-VHL-3).
    ProtocolMismatch { daemon: i64 },
    /// 첫 연결 실패.
    Dial(Box<Error>),
}

impl Error {
    /// 데몬이 답한 오류다 (Go `errors.As(err, *toolipc.RPCError)`).
    pub fn rpc(&self) -> Option<&RpcError> {
        match self {
            Self::Rpc(e) => Some(e),
            Self::Hello(e) | Self::Dial(e) => e.rpc(),
            _ => None,
        }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotConnected => f.write_str("toolclient not connected"),
            Self::ConnectionLost => f.write_str("paned connection lost"),
            Self::Timeout { method } => {
                write!(f, "paned call {} timed out", strconv::quote(method))
            }
            Self::Closed => f.write_str("toolclient closed"),
            Self::Rpc(e) => e.fmt(f),
            Self::Json(e) => e.fmt(f),
            Self::Io(e) => e.fmt(f),
            Self::ToolCap(m) => write!(f, "{ERR_TOOL_CAP}: {m}"),
            Self::ToolNotFound(id) => write!(f, "{ERR_TOOL_NOT_FOUND}: {id}"),
            Self::Hello(e) => write!(f, "hello: {e}"),
            Self::ProtocolMismatch { daemon } => write!(
                f,
                "hello: protocol mismatch: daemon={daemon} server={PROTOCOL_VERSION}"
            ),
            Self::Dial(e) => write!(f, "dial dongminald: {e}"),
        }
    }
}

impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Rpc(e) => Some(e),
            Self::Json(e) => Some(e),
            Self::Io(e) => Some(e),
            Self::Hello(e) | Self::Dial(e) => Some(e.as_ref()),
            _ => None,
        }
    }
}
