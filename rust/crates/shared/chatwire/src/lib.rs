//! Go 기준선 `otterminal/internal/shared/chatwire` 의 Rust 포팅. RUST_PORT_SRS 참고.
//!
//! 데몬의 채팅 소켓 와이어다 (PEER_CHAT_SRS §3.10). 데몬(chatsock)과 otterctl(chat-mcp·ctx-hook)이
//! 같은 한 벌을 쓴다. 줄 하나에 JSON 프레임 하나다.

use std::io::{self, ErrorKind, Read};
use std::path::{Path, PathBuf};

use otter_gocompat::json::{self, RawMessage};
use serde::{Deserialize, Serialize};

/// 채팅 소켓 이름이다. 데몬 소켓과 같은 0700 폴더에 산다.
pub const SOCKET_FILE: &str = "chat.sock";

/// 프레임 한 줄의 상한이다. 넘으면 연결을 끊는다.
pub const MAX_LINE: usize = 1 << 20;

/// Go `NewScanner` 가 처음 잡는 버퍼 크기다. 한 번에 읽는 양의 상한으로 쓴다.
const READ_CHUNK: usize = 64 << 10;

pub const TYPE_HELLO: &str = "hello";
pub const TYPE_ERROR: &str = "error";
pub const TYPE_CALL: &str = "call";
pub const TYPE_REPLY: &str = "reply";
pub const TYPE_MSG: &str = "msg";
pub const TYPE_COUNT_ASK: &str = "count?";
pub const TYPE_COUNT: &str = "count";
pub const TYPE_UNREAD: &str = "unread";
/// 깨움 훅(chat-wait)의 첫 프레임이자 데몬의 답이다 (ISSUE_TREE_CHAT_SRS FR-CAL-9). 답의 total 이
/// 0 이면 깨우지 않는다.
pub const TYPE_WAIT: &str = "wait";
/// 데몬이 MCP 에 깨울 글을 묻는다. MCP 는 표식 없는 깨울 글이 생기면 wake 로 답한다.
pub const TYPE_WAKE_ASK: &str = "wake?";
/// MCP 의 답이다. 답한 글에는 표식을 붙인다 (FR-CAL-11).
pub const TYPE_WAKE: &str = "wake";
/// 기다리던 훅이 사라져 데몬이 그 물음을 거둔다.
pub const TYPE_WAKE_DROP: &str = "wake-drop";

pub const OP_ONLINE: &str = "online";
pub const OP_ROOMS: &str = "rooms";
pub const OP_CREATE: &str = "create";
pub const OP_DIRECT: &str = "direct";
pub const OP_JOIN: &str = "join";
pub const OP_LEAVE: &str = "leave";
pub const OP_SEND: &str = "send";
/// 내 알림 단계를 방마다 정한다 (FR-CAL-5·6).
pub const OP_NOTIFY: &str = "notify";
/// 사람 화면의 한 번 읽기다: 나·온라인 목록·방 목록 (§3.11).
pub const OP_STATE: &str = "state";
/// 사람 명령이다 (§3.12). 서명한 명령 본문의 종류로 그대로 건네지므로 humancmd 의 이름을 가리킨다.
pub const OP_KILL: &str = otter_shared_humancmd::OP_KILL;
pub const OP_KICK: &str = otter_shared_humancmd::OP_KICK;

/// 알림 단계다 (FR-CAL-5). 정하지 않으면 [`NOTIFY_CALLED`] 다.
pub const NOTIFY_ALL: &str = "all";
pub const NOTIFY_CALLED: &str = "called";
pub const NOTIFY_OFF: &str = "off";

pub const CODE_BAD_REQUEST: &str = "bad_request";
pub const CODE_DAEMON_UNAVAILABLE: &str = "daemon_unavailable";
pub const CODE_FULL: &str = "participants_full";
/// 사람 명령의 도우미 오류다 (§3.12). locked 의 메시지는 풀리는 시각(RFC 3339)이다.
pub const CODE_BAD_CODE: &str = "bad_code";
pub const CODE_LOCKED: &str = "locked";
pub const CODE_NO_HELPER: &str = "no_helper";

/// home 인스턴스의 채팅 소켓 경로다.
pub fn socket_path(home: &Path) -> PathBuf {
    otter_shared_platform::sibling_socket(home, SOCKET_FILE)
}

/// 채팅 소켓의 프레임 하나다. 종류에 따라 쓰는 필드가 다르다(§3.10 표).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "chatwire.Frame")]
pub struct Frame {
    pub t: String,
    #[serde(skip_serializing_if = "json::is_empty")]
    pub n: u64,
    #[serde(skip_serializing_if = "json::is_empty")]
    pub session: String,
    #[serde(skip_serializing_if = "json::is_empty")]
    pub tool: String,
    #[serde(skip_serializing_if = "json::is_empty")]
    pub tab: String,
    #[serde(skip_serializing_if = "json::is_empty")]
    pub id: String,
    #[serde(skip_serializing_if = "json::is_empty")]
    pub label: String,
    #[serde(skip_serializing_if = "json::is_empty")]
    pub op: String,
    #[serde(skip_serializing_if = "json::is_empty")]
    pub args: RawMessage,
    #[serde(skip_serializing_if = "json::is_empty")]
    pub result: RawMessage,
    #[serde(skip_serializing_if = "json::is_empty")]
    pub error: Option<Error>,
    #[serde(skip_serializing_if = "json::is_empty")]
    pub msg: Option<Message>,
    /// count·unread·wake·wait: 안 읽은 글 수. 방 이름은 싣지 않는다 (§3.10).
    #[serde(skip_serializing_if = "json::is_empty")]
    pub total: i64,
    /// wake·wait: 그 가운데 나를 부른 글 수다 (FR-CAL-10).
    #[serde(skip_serializing_if = "json::is_empty")]
    pub called: i64,
}

/// 실패 하나다.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "chatwire.Error")]
pub struct Error {
    pub code: String,
    pub message: String,
}

/// 데몬이 MCP 에 넘기는 글이다. 방 종류·이름·목적을 싣는다 (FR-PCH-13).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "chatwire.Message")]
pub struct Message {
    pub id: String,
    pub room: String,
    #[serde(rename = "roomKind")]
    pub room_kind: String,
    #[serde(rename = "roomName")]
    pub room_name: String,
    #[serde(rename = "roomPurpose")]
    pub room_purpose: String,
    pub from: String,
    #[serde(rename = "fromLabel")]
    pub from_label: String,
    #[serde(rename = "fromKind")]
    pub from_kind: String,
    pub node: String,
    pub text: String,
    pub at: i64,
    /// 부른 상대(참가자 id 또는 user)다 (ISSUE_TREE_CHAT_SRS FR-CUX-7). 비면 싣지 않는다 — 옛 형식과 같다.
    #[serde(skip_serializing_if = "json::is_empty")]
    pub call: Vec<String>,
    /// 받는 참가자를 부른 글인가다 (FR-CAL-4). 거짓이면 싣지 않는다 — 옛 형식과 같다.
    #[serde(skip_serializing_if = "json::is_empty")]
    pub called: bool,
}

/// 온라인 목록의 노드 하나다. FP 는 지문 앞자리다.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "chatwire.Node")]
pub struct Node {
    pub fp: String,
    pub name: String,
    pub online: bool,
    #[serde(rename = "self")]
    pub self_: bool,
}

/// 참가자 하나다.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "chatwire.Member")]
pub struct Member {
    pub id: String,
    pub label: String,
    pub kind: String,
    pub node: String,
    pub online: bool,
    /// 사람 화면의 state: 이 노드의 참가자면 그 방의 알림 단계다 (FR-CUX-12).
    #[serde(skip_serializing_if = "json::is_empty")]
    pub notify: String,
    /// 사람 화면의 state: 이 노드의 에이전트면 그 도구 id 다. 화면이 활동 상태를 읽는다 (FR-CUX-12).
    #[serde(skip_serializing_if = "json::is_empty")]
    pub tool: String,
}

/// online 의 결과다.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "chatwire.Online")]
pub struct Online {
    pub nodes: Option<Vec<Node>>,
    pub participants: Option<Vec<Member>>,
}

/// 방 하나의 보기다. Unread 는 MCP 가 자기 글함에서 채운다.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "chatwire.Room")]
pub struct Room {
    pub id: String,
    pub kind: String,
    #[serde(skip_serializing_if = "json::is_empty")]
    pub name: String,
    #[serde(skip_serializing_if = "json::is_empty")]
    pub purpose: String,
    pub creator: String,
    #[serde(rename = "creatorName")]
    pub creator_name: String,
    pub members: i64,
    pub joined: bool,
    pub unread: i64,
    /// 이 방에서 내 알림 단계다 (FR-CAL-6·7).
    pub notify: String,
    /// 방의 참가자 목록이다. 사람 화면의 state 만 채운다 (§3.11).
    #[serde(skip_serializing_if = "json::is_empty")]
    pub people: Option<Vec<Member>>,
}

/// rooms 의 결과다.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "chatwire.Rooms")]
pub struct Rooms {
    pub rooms: Option<Vec<Room>>,
}

/// state 의 결과다. Me 는 사람 참가자다.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "chatwire.State")]
pub struct State {
    pub me: Member,
    pub online: Online,
    pub rooms: Option<Vec<Room>>,
    /// 이 노드에 사람 명령의 도우미가 있는가다 (§3.12).
    pub helper: bool,
}

/// create·direct·join 의 결과다.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "chatwire.RoomResult")]
pub struct RoomResult {
    pub room: Room,
}

/// leave·send 의 결과다.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "chatwire.OK")]
pub struct Ok {
    pub ok: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "chatwire.CreateArgs")]
pub struct CreateArgs {
    pub name: String,
    pub purpose: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "chatwire.DirectArgs")]
pub struct DirectArgs {
    pub participant: String,
    pub purpose: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "chatwire.RoomArgs")]
pub struct RoomArgs {
    pub room: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "chatwire.SendArgs")]
pub struct SendArgs {
    pub room: String,
    pub text: String,
    /// 부를 상대다: 참가자 id · 도구 id · `user` (FR-CAL-1).
    #[serde(skip_serializing_if = "json::is_empty")]
    pub call: Option<Vec<String>>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "chatwire.NotifyArgs")]
pub struct NotifyArgs {
    pub room: String,
    pub level: String,
}

/// 강퇴 대상 하나다 (§3.12).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "chatwire.Kick")]
pub struct Kick {
    pub room: String,
    pub participant: String,
}

/// kill·kick 의 인자다 (§3.12).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "chatwire.HumanArgs")]
pub struct HumanArgs {
    #[serde(skip_serializing_if = "json::is_empty")]
    pub rooms: Option<Vec<String>>,
    #[serde(skip_serializing_if = "json::is_empty")]
    pub kicks: Option<Vec<Kick>>,
    pub code: String,
}

/// 프레임 한 줄이다(끝에 줄바꿈).
pub fn encode(f: &Frame) -> Result<Vec<u8>, json::Error> {
    let mut b = json::marshal(f)?;
    b.push(b'\n');
    Ok(b)
}

/// 줄 읽기의 실패다. Go `bufio.Scanner.Err()` 에 해당한다(EOF 는 실패가 아니다).
#[derive(Debug)]
pub enum ScanError {
    /// `bufio.ErrTooLong`: 줄바꿈 없이 [`MAX_LINE`] 바이트가 찼다.
    TooLong,
    Io(io::Error),
}

/// 줄 상한을 건 프레임 읽개다. Go `NewScanner`(ScanLines, 상한 [`MAX_LINE`])와 같은 토큰을 낸다:
/// 끝의 `\r` 은 떼고, 줄바꿈 없이 끝난 마지막 조각도 토큰이며, 빈 줄은 빈 토큰이다.
pub struct Scanner<R> {
    r: R,
    buf: Vec<u8>,
    start: usize,
    done: bool,
    err: Option<ScanError>,
}

impl<R: Read> Scanner<R> {
    pub fn new(r: R) -> Self {
        Self {
            r,
            buf: Vec::new(),
            start: 0,
            done: false,
            err: None,
        }
    }

    /// 다음 줄이다. 끝났거나 실패했으면 `None` 이고, 실패는 [`Scanner::err`] 로 읽는다.
    pub fn next_line(&mut self) -> Option<Vec<u8>> {
        let mut chunk = vec![0u8; READ_CHUNK];
        loop {
            let pending = &self.buf[self.start..];
            if let Some(i) = pending.iter().position(|&c| c == b'\n') {
                let tok = drop_cr(&pending[..i]).to_vec();
                self.start += i + 1;
                return Some(tok);
            }
            if self.done {
                if pending.is_empty() {
                    return None;
                }
                let tok = drop_cr(pending).to_vec();
                self.start = self.buf.len();
                return Some(tok);
            }
            if pending.len() >= MAX_LINE {
                self.done = true;
                self.err = Some(ScanError::TooLong);
                return None;
            }
            self.buf.drain(..self.start);
            self.start = 0;
            let want = (MAX_LINE - self.buf.len()).min(READ_CHUNK);
            match self.r.read(&mut chunk[..want]) {
                Ok(0) => self.done = true,
                Ok(n) => self.buf.extend_from_slice(&chunk[..n]),
                Err(e) if e.kind() == ErrorKind::Interrupted => {}
                Err(e) => {
                    self.done = true;
                    self.err = Some(ScanError::Io(e));
                }
            }
        }
    }

    /// EOF 가 아닌 실패다.
    pub fn err(&self) -> Option<&ScanError> {
        self.err.as_ref()
    }
}

fn drop_cr(b: &[u8]) -> &[u8] {
    b.strip_suffix(b"\r").unwrap_or(b)
}

#[cfg(test)]
mod tests;
