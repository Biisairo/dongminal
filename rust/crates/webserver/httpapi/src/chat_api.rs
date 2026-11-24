//! 로컬 API `/api/chat` (Go `chat_api.go`, PEER_CHAT_SRS §3.11).
//!
//! 채팅은 데몬에 있다(NFR-PCH-5). 서버는 화면의 요청을 데몬의 사람 참가자 연산 하나로 넘기고,
//! 데몬이 민 글과 바뀜을 SSE 로 방송한다. 서버는 글을 들지 않는다 (FR-PCH-85).

use http::{HeaderValue, StatusCode, header};
use otter_gocompat::json::{self, RawMessage};
use otter_shared_chatwire as chatwire;
use otter_shared_httpresp::{self as httpresp, Response};
use otter_shared_toolipc::{CHAT_KIND_CHANGED, CHAT_KIND_MSG, ChatEvent, ChatParams, ChatResult};
use otter_webserver_apierr as apierr;
use serde::Serialize;

use crate::Server;
use crate::httperr::{JSON_BODY_LIMIT, code_fail, mark};
use crate::req::Req;
use crate::tools_api::off_thread;

/// Go `ChatDaemon`: 데몬 채팅의 접합면이다. 합성 루트가 toolclient 를 감싸 구현한다.
pub trait ChatDaemon: Send + Sync {
    /// 데몬이 chat 기능을 말하는가다. 부를 때마다 묻는다.
    fn chat_ready(&self) -> bool;
    /// 오류 문구는 Go `err.Error()` 다.
    fn chat(&self, p: ChatParams) -> Result<ChatResult, String>;
}

/// Go `chatErrors`: 데몬의 채팅 코드 → HTTP 상태와 와이어 코드. 없는 코드는 400 chat_bad_request 다.
fn chat_error(code: &str) -> (StatusCode, &'static str) {
    match code {
        "too_large" => (StatusCode::PAYLOAD_TOO_LARGE, apierr::CODE_CHAT_TOO_LARGE),
        "rate_limited" => (
            StatusCode::TOO_MANY_REQUESTS,
            apierr::CODE_CHAT_RATE_LIMITED,
        ),
        "not_in_room" => (StatusCode::CONFLICT, apierr::CODE_CHAT_NOT_IN_ROOM),
        "no_such_room" => (StatusCode::NOT_FOUND, apierr::CODE_CHAT_NO_SUCH_ROOM),
        "no_such_participant" => (StatusCode::NOT_FOUND, apierr::CODE_CHAT_NO_SUCH_PARTICIPANT),
        chatwire::CODE_DAEMON_UNAVAILABLE => (
            StatusCode::SERVICE_UNAVAILABLE,
            apierr::CODE_CHAT_UNAVAILABLE,
        ),
        chatwire::CODE_BAD_CODE => (StatusCode::FORBIDDEN, apierr::CODE_CHAT_BAD_CODE),
        chatwire::CODE_LOCKED => (StatusCode::LOCKED, apierr::CODE_CHAT_LOCKED),
        chatwire::CODE_NO_HELPER => (StatusCode::CONFLICT, apierr::CODE_CHAT_NO_HELPER),
        _ => (StatusCode::BAD_REQUEST, apierr::CODE_CHAT_BAD_REQUEST),
    }
}

/// 본문을 그대로 싣고 끝에 줄바꿈을 붙인 JSON 응답이다 (Go `w.Write(append(body, '\n'))`).
pub(crate) fn raw_json(status: StatusCode, body: &[u8]) -> Response {
    let mut b = Vec::with_capacity(body.len() + 1);
    b.extend_from_slice(body);
    b.push(b'\n');
    let mut res = http::Response::new(httpresp::full(b));
    *res.status_mut() = status;
    res.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    res
}

#[derive(Serialize)]
struct ChatMsgArgs<'a> {
    msg: &'a chatwire::Message,
}

impl Server {
    pub(crate) async fn api_chat_get(&self, r: &mut Req) -> Response {
        self.chat_do(r, chatwire::OP_STATE).await
    }

    pub(crate) async fn api_chat_create(&self, r: &mut Req) -> Response {
        self.chat_do(r, chatwire::OP_CREATE).await
    }

    pub(crate) async fn api_chat_direct(&self, r: &mut Req) -> Response {
        self.chat_do(r, chatwire::OP_DIRECT).await
    }

    pub(crate) async fn api_chat_join(&self, r: &mut Req) -> Response {
        self.chat_do(r, chatwire::OP_JOIN).await
    }

    pub(crate) async fn api_chat_leave(&self, r: &mut Req) -> Response {
        self.chat_do(r, chatwire::OP_LEAVE).await
    }

    pub(crate) async fn api_chat_send(&self, r: &mut Req) -> Response {
        self.chat_do(r, chatwire::OP_SEND).await
    }

    /// 사람 명령이다. 본문에 OTP 코드가 든다 (§3.12).
    pub(crate) async fn api_chat_kill(&self, r: &mut Req) -> Response {
        self.chat_do(r, chatwire::OP_KILL).await
    }

    pub(crate) async fn api_chat_kick(&self, r: &mut Req) -> Response {
        self.chat_do(r, chatwire::OP_KICK).await
    }

    /// Go `chatDo`: 연산 op 하나를 데몬에 넘긴다. state 가 아니면 요청 본문이 그 op 의 인자다.
    async fn chat_do(&self, r: &mut Req, op: &str) -> Response {
        // 데몬이 배선되지 않은 서버는 준비되지 않은 데몬과 같다 (DIRECT_MODE_REMOVAL_SRS FR-DMR-22).
        let Some(d) = self.deps.chat_daemon.clone() else {
            return chat_restart();
        };
        let ready = {
            let d = d.clone();
            off_thread(move || d.chat_ready()).await.unwrap_or(false)
        };
        if !ready {
            return chat_restart();
        }
        let mut p = ChatParams {
            op: op.to_owned(),
            ..ChatParams::default()
        };
        if op != chatwire::OP_STATE {
            let raw = match r.read_body(JSON_BODY_LIMIT).await {
                Ok(b) => b,
                Err(e) => {
                    return mark(
                        &e,
                        code_fail(
                            otter_shared_httpreq::status(&e),
                            apierr::body_read_code(&e),
                            "read body",
                        ),
                    );
                }
            };
            if !json::valid(&raw) {
                return code_fail(
                    StatusCode::BAD_REQUEST,
                    apierr::CODE_CHAT_BAD_REQUEST,
                    "body is not JSON",
                );
            }
            p.args = RawMessage(raw.to_vec());
        }
        let res = match off_thread(move || d.chat(p)).await {
            Some(Ok(res)) => res,
            Some(Err(e)) => {
                return code_fail(
                    StatusCode::BAD_GATEWAY,
                    apierr::CODE_CHAT_UNREACHABLE,
                    &format!("daemon: {e}"),
                );
            }
            None => {
                return code_fail(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    apierr::CODE_INTERNAL,
                    "internal error",
                );
            }
        };
        if let Some(e) = &res.error {
            let (status, code) = chat_error(&e.code);
            return code_fail(status, code, &e.message);
        }
        raw_json(StatusCode::OK, &res.result.0)
    }

    /// Go `ChatPushed`: 데몬의 chat push 다. 글은 chat_message 로, 바뀜은 chat_changed 로 방송한다.
    /// 읽기 루프에서 불리므로 데몬 RPC 를 기다리지 않는다.
    pub fn chat_pushed(&self, ev: &ChatEvent) {
        if ev.chat_kind == CHAT_KIND_MSG {
            if let Some(m) = &ev.chat
                && let Some(c) = self.commands()
            {
                c.broadcast(&otter_webserver_sse::payload(
                    "chat_message",
                    Some(&ChatMsgArgs { msg: m }),
                ));
            }
        } else if ev.chat_kind == CHAT_KIND_CHANGED {
            self.refresh_state_topic("chat");
        }
    }

    /// Go `ChatResync`: 데몬에 다시 붙은 뒤다. 끊긴 동안의 바뀜을 잃었으므로 화면이 다시 읽게 한다.
    pub fn chat_resync(&self) {
        self.refresh_state_topic("chat");
    }
}

fn chat_restart() -> Response {
    code_fail(
        StatusCode::CONFLICT,
        apierr::CODE_CHAT_DAEMON_RESTART,
        "restart the daemon to use chat",
    )
}
