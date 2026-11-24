//! 에이전트 접합면의 도구 입출력 (Go `handlers_toolio.go`, SKILL_INJECTION_SRS FR-API-1/2/3).
//! `otterctl read-screen`·`read-output`·`send-input`·`msg` 가 부른다. 공용 도우미는 다른 하위
//! 이슈의 종단도 쓴다.

use std::sync::Arc;

use http::StatusCode;
use otter_shared_httpresp::Response;
use otter_shared_otterlog::infof;
use serde::{Deserialize, Serialize};

use crate::Server;
use crate::ToolHub;
use crate::ansi::{go_string, strip_ansi};
use crate::httperr::{decode_json_body, write_json, write_tool_io_error};
use crate::req::Req;
use crate::toolhub::with_req;

/// 서버가 보낸 봉투의 발신자 이름이다.
#[allow(dead_code)]
pub(crate) const ENVELOPE_SERVER_SENDER: &str = "otterminal-server";

impl Server {
    #[allow(dead_code)]
    /// Go `tools(r)`: 요청 ID 를 데몬 RPC 로그에 싣는 허브. 허브가 없으면 `None` 이다.
    pub(crate) fn tools(&self, r: Option<&Req>) -> Option<Arc<dyn ToolHub>> {
        let hub = self.deps.tools.clone()?;
        match r {
            Some(r) => Some(with_req(hub, r.rid())),
            None => Some(hub),
        }
    }

    /// Go `toolIOReady`: 입출력 접합면이 배선됐는가. 아니면 503 이다.
    pub(crate) fn tool_io_ready(&self) -> Result<(), Response> {
        if self.deps.tool_io.is_none() || self.deps.work_index.is_none() {
            return Err(write_tool_io_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "tool io unavailable",
            ));
        }
        Ok(())
    }

    /// Go `resolveToolID`: 식별자(uuid·toolId)를 살아 있는 도구 ID 로 푼다.
    pub(crate) fn resolve_tool_id(&self, id: &str) -> Result<String, Response> {
        if id.is_empty() {
            return Err(write_tool_io_error(StatusCode::BAD_REQUEST, "id 누락"));
        }
        let tool_id = self.resolve_tool_strict(id)?;
        let has = self
            .deps
            .tool_io
            .as_ref()
            .is_some_and(|io| io.has(&tool_id));
        if !has {
            return Err(write_tool_io_error(
                StatusCode::NOT_FOUND,
                &format!("tool 없음: {tool_id}"),
            ));
        }
        Ok(tool_id)
    }

    /// Go `resolveSender`: 빈 발신자는 그대로 둔다.
    pub(crate) fn resolve_sender(&self, from: &str) -> Result<String, Response> {
        if from.is_empty() {
            return Ok(String::new());
        }
        self.resolve_tool_strict(from)
    }

    /// Go `resolveToolStrict`: 좌표 라벨이면 400, 그 밖의 실패는 404 다 (FR-IDU-9).
    pub(crate) fn resolve_tool_strict(&self, ident: &str) -> Result<String, Response> {
        let Some(idx) = &self.deps.work_index else {
            return Err(write_tool_io_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "tool io unavailable",
            ));
        };
        idx.resolve_strict(ident).map_err(|err| {
            let label = err
                .downcast_ref::<otter_shared_workspace::Error>()
                .is_some_and(otter_shared_workspace::Error::is_label_identifier);
            let status = if label {
                StatusCode::BAD_REQUEST
            } else {
                StatusCode::NOT_FOUND
            };
            write_tool_io_error(status, &err.to_string())
        })
    }

    /// Go `deliverToTool`.
    pub(crate) fn deliver_to_tool(
        &self,
        tool_id: &str,
        text: &str,
        submit: bool,
    ) -> Result<(), String> {
        match &self.deps.tool_io {
            Some(io) => io
                .send_paste(tool_id, text.as_bytes(), submit)
                .map_err(|e| e.to_string()),
            None => Err("tool io unavailable".to_owned()),
        }
    }

    /// GET /api/tools/output?id=&bytes=&strip=1.
    pub(crate) async fn api_tool_output(&self, r: &mut Req) -> Response {
        if let Err(res) = self.tool_io_ready() {
            return res;
        }
        let q = r.query();
        let tool_id = match self.resolve_tool_id(&q.get_or_empty("id")) {
            Ok(id) => id,
            Err(res) => return res,
        };
        let mut n: i64 = 0;
        let v = q.get_or_empty("bytes");
        if !v.is_empty() {
            match v.parse::<i64>() {
                Ok(p) => n = p,
                Err(_) => {
                    return write_tool_io_error(
                        StatusCode::BAD_REQUEST,
                        &format!("bytes 는 정수여야 한다: {v}"),
                    );
                }
            }
        }
        let snap = self
            .deps
            .tool_io
            .as_ref()
            .and_then(|io| io.snapshot(&tool_id));
        let Some((mut data, dropped)) = snap else {
            return write_tool_io_error(StatusCode::NOT_FOUND, &format!("tool 없음: {tool_id}"));
        };
        if let Ok(n) = usize::try_from(n)
            && n > 0
            && data.len() > n
        {
            data.drain(..data.len() - n);
        }
        let text = if q.get_or_empty("strip") == "1" {
            strip_ansi(&data)
        } else {
            go_string(&data)
        };
        write_json(&OutputBody {
            dropped,
            text,
            tool_id,
        })
    }

    /// POST /api/tools/input {id, text, execute}.
    pub(crate) async fn api_tool_input(&self, r: &mut Req) -> Response {
        if let Err(res) = self.tool_io_ready() {
            return res;
        }
        let body: InputReq = match decode_json_body(r, 0).await {
            Ok(b) => b,
            Err(res) => return res,
        };
        let tool_id = match self.resolve_tool_id(&body.id) {
            Ok(id) => id,
            Err(res) => return res,
        };
        if let Err(e) = self.deliver_to_tool(&tool_id, &body.text, body.execute) {
            return write_tool_io_error(StatusCode::INTERNAL_SERVER_ERROR, &e);
        }
        infof!(
            None,
            "[toolio] input tool={tool_id} id={} execute={} textLen={}",
            body.id,
            body.execute,
            body.text.len()
        );
        write_json(&InputResp {
            execute: body.execute,
            len: body.text.len(),
            tool_id,
        })
    }

    /// POST /api/tools/message {to, from, message}: 봉투로 감싸 대상의 입력에 넣고 제출한다.
    pub(crate) async fn api_tool_message(&self, r: &mut Req) -> Response {
        if let Err(res) = self.tool_io_ready() {
            return res;
        }
        let body: MessageReq = match decode_json_body(r, 0).await {
            Ok(b) => b,
            Err(res) => return res,
        };
        if body.message.is_empty() {
            return write_tool_io_error(StatusCode::BAD_REQUEST, "message 누락");
        }
        let tool_id = match self.resolve_tool_id(&body.to) {
            Ok(id) => id,
            Err(res) => return res,
        };
        let from_tool_id = match self.resolve_sender(&body.from) {
            Ok(id) => id,
            Err(res) => return res,
        };
        let sender = envelope_sender(&from_tool_id);
        let envelope = agent_envelope(&sender, &tool_id, &body.message);
        if let Err(e) = self.deliver_to_tool(&tool_id, &envelope, true) {
            return write_tool_io_error(StatusCode::INTERNAL_SERVER_ERROR, &e);
        }
        self.record_run_message(&from_tool_id, &tool_id, body.message.len());
        infof!(
            None,
            "[toolio] message from={sender}(input={}) to={tool_id}(input={}) msgLen={}",
            body.from,
            body.to,
            body.message.len()
        );
        write_json(&MessageResp {
            from: sender,
            len: body.message.len(),
            to: tool_id.clone(),
            tool_id,
        })
    }
}

/// Go `agentEnvelope`: 받는 쪽 에이전트가 신뢰 채널로 알아보는 봉투다.
pub(crate) fn agent_envelope(from: &str, to_tool_id: &str, body: &str) -> String {
    // Go 배치 `15:04:05`(지역 시각).
    let t = otter_gocompat::time::now_local();
    let ts = format!("{:02}:{:02}:{:02}", t.hour(), t.minute(), t.second());
    format!(
        "[OTTERMINAL-AGENT-MSG from={from} to={to_tool_id} ts={ts}]\n{}\n[/OTTERMINAL-AGENT-MSG]",
        quote_envelope(body)
    )
}

/// Go `quoteEnvelope`: 본문 안의 봉투 표지를 깨뜨려 가짜 봉투를 막는다.
pub(crate) fn quote_envelope(msg: &str) -> String {
    const CLOSE: &str = "[/OTTERMINAL-AGENT-MSG";
    const OPEN: &str = "[OTTERMINAL-AGENT-MSG";
    let mut out = String::with_capacity(msg.len());
    let mut rest = msg;
    while !rest.is_empty() {
        if let Some(r) = rest.strip_prefix(CLOSE) {
            out.push_str("[\\/OTTERMINAL-AGENT-MSG");
            rest = r;
        } else if let Some(r) = rest.strip_prefix(OPEN) {
            out.push_str("[\\OTTERMINAL-AGENT-MSG");
            rest = r;
        } else {
            let c = rest.chars().next().unwrap_or_default();
            out.push(c);
            rest = &rest[c.len_utf8()..];
        }
    }
    out
}

/// Go `envelopeSender`.
pub(crate) fn envelope_sender(from_tool_id: &str) -> String {
    if from_tool_id.is_empty() {
        "unknown".to_owned()
    } else {
        from_tool_id.to_owned()
    }
}

/// 응답 키는 Go `map[string]any` 라 이름 순이다.
#[derive(Serialize)]
struct OutputBody {
    dropped: i64,
    text: String,
    #[serde(rename = "toolId")]
    tool_id: String,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct InputReq {
    id: String,
    text: String,
    execute: bool,
}

#[derive(Serialize)]
struct InputResp {
    execute: bool,
    len: usize,
    #[serde(rename = "toolId")]
    tool_id: String,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct MessageReq {
    to: String,
    from: String,
    message: String,
}

#[derive(Serialize)]
struct MessageResp {
    from: String,
    len: usize,
    to: String,
    #[serde(rename = "toolId")]
    tool_id: String,
}
