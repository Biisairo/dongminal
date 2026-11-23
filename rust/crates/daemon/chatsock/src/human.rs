use dm_gocompat::json::{self, RawMessage};
use dm_shared_chatwire as chatwire;
use dm_shared_humancmd::{self as humancmd, Kick, Request, Signed};
use time::OffsetDateTime;

use crate::{Server, decode};

const NANOS_PER_MILLI: i128 = 1_000_000;

/// 사람 명령의 도우미다. [`humancmd::Client`] 가 구현한다 (PEER_CHAT_SRS §3.12).
pub trait Helper: Send + Sync {
    fn sign(&self, code: &str, r: Request) -> Result<Signed, humancmd::Error>;
}

impl Helper for humancmd::Client {
    fn sign(&self, code: &str, r: Request) -> Result<Signed, humancmd::Error> {
        humancmd::Client::sign(self, code, r)
    }
}

fn wire(code: &str, message: impl Into<String>) -> chatwire::Error {
    chatwire::Error {
        code: code.into(),
        message: message.into(),
    }
}

/// 도우미의 거절을 채팅 코드로 바꾼다. locked 의 메시지는 풀리는 시각이다.
fn helper_error(e: &humancmd::Error) -> chatwire::Error {
    match e.code.as_str() {
        humancmd::CODE_LOCKED => {
            let at =
                OffsetDateTime::from_unix_timestamp_nanos(i128::from(e.until) * NANOS_PER_MILLI)
                    .unwrap_or(OffsetDateTime::UNIX_EPOCH);
            wire(chatwire::CODE_LOCKED, dm_gocompat::time::format_rfc3339(at))
        }
        humancmd::CODE_BAD_CODE => wire(chatwire::CODE_BAD_CODE, "wrong code"),
        humancmd::CODE_BAD_REQUEST => {
            wire(chatwire::CODE_BAD_REQUEST, "helper refused the request")
        }
        _ => wire(chatwire::CODE_NO_HELPER, "helper unavailable"),
    }
}

impl Server {
    /// 사람 참가자의 kill·kick 이다. 도우미에게 코드와 묶음을 보내 서명을 받고, 채팅에 적용해 망에
    /// 낸다 (FR-PCH-70~73). 도우미 저장 실패(unavailable)는 no_helper 로 본다 (§3.12a R-5).
    /// 에이전트의 MCP 연결로는 닿지 않는다 — user_call 만 부른다.
    pub(crate) fn human(&self, op: &str, args: &RawMessage) -> Result<RawMessage, chatwire::Error> {
        let a: chatwire::HumanArgs = decode(args).map_err(|e| e.wire())?;
        let req = Request {
            node: self.o.chat.node().to_string(),
            op: op.into(),
            rooms: a.rooms.unwrap_or_default(),
            kicks: a
                .kicks
                .unwrap_or_default()
                .into_iter()
                .map(|k| Kick {
                    room: k.room,
                    participant: k.participant,
                })
                .collect(),
        };
        if !req.valid() {
            return Err(wire(chatwire::CODE_BAD_REQUEST, "targets"));
        }
        let Some(helper) = &self.o.helper else {
            return Err(wire(chatwire::CODE_NO_HELPER, "no helper"));
        };
        // 도우미는 한 번만 부른다. 서명 본문의 키를 command 가 싣는다 (§3.12a R-3).
        let sg = helper.sign(&a.code, req).map_err(|e| helper_error(&e))?;
        self.o
            .chat
            .command(&sg)
            .map_err(|e| wire(e.code(), e.to_string()))?;
        Ok(RawMessage(
            json::marshal(&chatwire::Ok { ok: true }).unwrap_or_default(),
        ))
    }
}
