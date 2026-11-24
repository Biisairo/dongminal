//! 오류 응답의 방언 (Go `httperr.go`·`fail.go`·`codefail.go` 와 toolio 의 JSON 오류).
//!
//! 방언이 셋이다. 평문(`http_err`·`fail`), `{code,message}`(`code_fail`), `{error}`
//! (`write_tool_io_error`). 셋 다 `X-Error-Code` 를 싣는다.

// 다른 하위 이슈(5.5.2~)의 종단이 쓰는 공용 도우미가 있다.
#![allow(dead_code)]

use std::collections::BTreeMap;
use std::fmt::Display;

use http::StatusCode;
use otter_shared_httpreq::{self as httpreq, DecodeError, Empty, ReadError};
use otter_shared_httpresp::{self as httpresp, Response};
use otter_shared_otterlog::infof;
use otter_webserver_apierr as apierr;
use serde::Serialize;
use serde::de::DeserializeOwned;

use crate::req::Req;

/// Go `jsonBodyLimit`.
pub(crate) const JSON_BODY_LIMIT: i64 = httpreq::SMALL_LIMIT;

/// Go `httpErr`: 평문 오류. `code` 가 비면 상태에서 고른다.
pub(crate) fn http_err(msg: &str, status: StatusCode, code: &str) -> Response {
    let code = if code.is_empty() {
        apierr::code_for_status(status.as_u16())
    } else {
        code
    };
    httpresp::fail_text(status, code, msg)
}

/// Go `fail`: 사용자에게 보일 문구와 기록할 원인을 가른다. 원인은 로그에만 남는다.
pub(crate) fn fail(status: StatusCode, msg: &str, err: Option<&dyn Display>) -> Response {
    if let Some(e) = err {
        infof!(None, "응답 {} ({msg}): {e}", status.as_u16());
    }
    http_err(msg, status, "")
}

/// 본문이 상한을 넘은 응답은 연결을 닫는다 (Go `MaxBytesReader` 가 서버에 거는 것).
pub(crate) fn mark(err: &ReadError, mut res: Response) -> Response {
    httpreq::mark_response(err, &mut res);
    res
}

/// Go `failRead`.
pub(crate) fn fail_read(err: &ReadError) -> Response {
    let res = match err {
        ReadError::TooLarge => fail(StatusCode::PAYLOAD_TOO_LARGE, httpreq::TOO_LARGE_MSG, None),
        ReadError::Other(e) => fail(httpreq::status(err), "본문을 읽지 못했습니다", Some(e)),
    };
    mark(err, res)
}

/// Go `httpErr(w, "read body", httpreq.Status(err), apierr.BodyReadCode(err))`.
pub(crate) fn read_body_err(err: &ReadError) -> Response {
    mark(
        err,
        http_err(
            "read body",
            httpreq::status(err),
            apierr::body_read_code(err),
        ),
    )
}

/// Go `codeFail`.
pub(crate) fn code_fail(status: StatusCode, code: &str, msg: &str) -> Response {
    httpresp::fail_code(status, code, msg)
}

/// Go `writeJSON`.
pub(crate) fn write_json<T: Serialize + ?Sized>(v: &T) -> Response {
    httpresp::json(StatusCode::OK, v)
}

/// Go `writeToolIOError`.
pub(crate) fn write_tool_io_error(status: StatusCode, msg: &str) -> Response {
    write_tool_io_error_code(status, apierr::code_for_status(status.as_u16()), msg)
}

/// Go `writeToolIOErrorCode`.
pub(crate) fn write_tool_io_error_code(status: StatusCode, code: &str, msg: &str) -> Response {
    let mut body = BTreeMap::new();
    body.insert("error", msg);
    httpresp::fail_json(status, code, &body)
}

/// Go `readBodyHTTP` 의 결과.
pub(crate) enum BodyRead<T> {
    Ok(T),
    /// JSON 이 아니다 — 응답은 호출자가 쓴다.
    NotJson,
    /// 읽기 실패. 응답이 이미 만들어졌다.
    Answered(Response),
}

/// Go `readBodyHTTP`: 읽기 실패만 답하고, JSON 이 아닌 것은 호출자에게 맡긴다.
pub(crate) async fn read_body_http<T: DeserializeOwned + Send + 'static>(r: &Req) -> BodyRead<T> {
    match r.decode_json::<T>(0, Empty::NotJson).await {
        Ok(v) => BodyRead::Ok(v),
        Err(DecodeError::Read(e)) => BodyRead::Answered(read_body_err(&e)),
        Err(DecodeError::NotJson(_)) => BodyRead::NotJson,
    }
}

/// Go `readJSONBody`: 빈 본문은 `{}` 다. 실패면 `{code,message}` 방언으로 답한다.
pub(crate) async fn read_json_body<T: DeserializeOwned + Send + 'static>(
    r: &Req,
) -> Result<T, Response> {
    match r.decode_json::<T>(JSON_BODY_LIMIT, Empty::AsObject).await {
        Ok(v) => Ok(v),
        Err(DecodeError::Read(e)) => Err(mark(
            &e,
            code_fail(httpreq::status(&e), apierr::body_read_code(&e), "read body"),
        )),
        Err(DecodeError::NotJson(_)) => Err(code_fail(
            StatusCode::BAD_REQUEST,
            apierr::CODE_INVALID_JSON,
            "invalid json",
        )),
    }
}

/// Go `decodeJSONBody`: `{error}` 방언이다. `limit` 이 0 이면 기본 상한이다.
pub(crate) async fn decode_json_body<T: DeserializeOwned + Send + 'static>(
    r: &Req,
    limit: i64,
) -> Result<T, Response> {
    match r.decode_json::<T>(limit, Empty::NotJson).await {
        Ok(v) => Ok(v),
        Err(err) => {
            let msg_prefix = match err {
                DecodeError::Read(_) => "본문을 읽지 못했다",
                DecodeError::NotJson(_) => "잘못된 JSON",
            };
            let msg = httpreq::message(r.rid(), r.method.as_str(), &r.path, msg_prefix, &err);
            Err(match &err {
                DecodeError::Read(e) => mark(
                    e,
                    write_tool_io_error_code(httpreq::status(e), apierr::body_read_code(e), &msg),
                ),
                DecodeError::NotJson(_) => write_tool_io_error(StatusCode::BAD_REQUEST, &msg),
            })
        }
    }
}
