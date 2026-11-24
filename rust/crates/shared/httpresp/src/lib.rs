//! Go 기준선 `otterminal/internal/shared/httpresp` 의 Rust 포팅. RUST_PORT_SRS 참고.
//!
//! JSON 응답과 오류 응답을 쓰는 한 자리다 (OPTIMIZE_REFACTOR_SRS FR-OPT-9-4 ·
//! REFACTOR3_DEDUP_GO_SRS FR-RDG-2). 오류 본문의 **모양**(방언)은 여기서 정하지 않는다.
//!
//! 이 crate 는 서버 전체의 응답 타입을 정한다. 핸들러는 [`Response`] 를 돌려준다.
//! 본문은 [`Body`](`BoxBody<Bytes, BoxError>`)이며, 한 번에 쓰는 본문은 [`full`] 로,
//! 스트림은 `otter-webserver-sse` 처럼 자기 `http_body::Body` 를 [`Body`] 로 감싸 만든다.

use bytes::Bytes;
use http::{HeaderValue, StatusCode, header};
use http_body_util::{BodyExt, Full, combinators::BoxBody};
use serde::Serialize;

/// 응답 본문의 오류 타입.
pub type BoxError = Box<dyn std::error::Error + Send + Sync>;

/// 서버 응답의 본문 타입.
pub type Body = BoxBody<Bytes, BoxError>;

/// 서버 응답 타입.
pub type Response = http::Response<Body>;

/// 오류 코드를 싣는 응답 헤더다 (REFACTOR3_DEDUP_GO_SRS FR-RDG-1).
pub const CODE_HEADER: &str = "X-Error-Code";

/// JSON 응답의 `Content-Type`.
pub const CONTENT_TYPE_JSON: &str = "application/json";

/// Go `http.Error` 의 `Content-Type`.
pub const CONTENT_TYPE_TEXT: &str = "text/plain; charset=utf-8";

/// 바이트 하나로 된 본문.
pub fn full(b: impl Into<Bytes>) -> Body {
    Full::new(b.into()).map_err(|never| match never {}).boxed()
}

/// 빈 본문.
pub fn empty() -> Body {
    full(Bytes::new())
}

fn response(status: StatusCode, content_type: &'static str, body: impl Into<Bytes>) -> Response {
    let mut res = http::Response::new(full(body));
    *res.status_mut() = status;
    res.headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    res
}

/// v 를 JSON 으로 쓴다. Go `json.Encoder` 의 기본(끝 개행·HTML 이스케이프)과 같다.
/// 인코딩에 실패하면 Go 처럼 상태와 헤더만 나가고 본문은 빈다.
pub fn json<T: Serialize + ?Sized>(status: StatusCode, v: &T) -> Response {
    let body = otter_gocompat::json::Encoder::new()
        .encode(v)
        .unwrap_or_default();
    response(status, CONTENT_TYPE_JSON, body)
}

/// Go `http.Error` 와 같은 응답이다: 평문, `X-Content-Type-Options: nosniff`, 끝 개행.
pub fn http_error(status: StatusCode, msg: &str) -> Response {
    let mut body = String::with_capacity(msg.len() + 1);
    body.push_str(msg);
    body.push('\n');
    let mut res = response(status, CONTENT_TYPE_TEXT, body);
    res.headers_mut().insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    res
}

/// Go `http.NotFound`: `404 page not found` 평문.
pub fn not_found() -> Response {
    http_error(StatusCode::NOT_FOUND, "404 page not found")
}

/// Go `http.Error(w, http.StatusText(status), status)`: 상태 문구만 담은 평문.
pub fn status_error(status: StatusCode) -> Response {
    http_error(status, status.canonical_reason().unwrap_or_default())
}

fn with_code(mut res: Response, code: &str) -> Response {
    // 코드는 호출자의 ASCII 상수다. 헤더 값이 될 수 없으면 싣지 않는다.
    if let Ok(v) = HeaderValue::from_str(code) {
        res.headers_mut().insert(CODE_HEADER, v);
    }
    res
}

/// Go `Fail(w, status, code, Text(msg))`: 평문 방언. `http.Error` 와 같은 바이트다.
pub fn fail_text(status: StatusCode, code: &str, msg: &str) -> Response {
    with_code(http_error(status, msg), code)
}

/// Go `Fail(w, status, code, Raw(b))`: 이미 직렬화한 JSON 을 끝 개행 없이 그대로 쓴다.
pub fn fail_raw(status: StatusCode, code: &str, raw: impl Into<Bytes>) -> Response {
    with_code(response(status, CONTENT_TYPE_JSON, raw), code)
}

/// Go `Fail(w, status, code, body)`: body 를 [`json`] 과 같은 인코딩으로 쓴다.
pub fn fail_json<T: Serialize + ?Sized>(status: StatusCode, code: &str, body: &T) -> Response {
    with_code(json(status, body), code)
}

#[derive(Serialize)]
struct CodeBody<'a> {
    code: &'a str,
    message: &'a str,
}

/// `{code,message}` 방언 하나다 (FR-RDG-4).
pub fn fail_code(status: StatusCode, code: &str, msg: &str) -> Response {
    fail_json(status, code, &CodeBody { code, message: msg })
}

#[cfg(test)]
mod tests;
