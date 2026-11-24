//! Go 기준선 `otterminal/internal/shared/httpreq` 의 Rust 포팅. RUST_PORT_SRS 참고.
//!
//! 요청 본문을 읽는 한 자리다 (REQUEST_GATE_SRS 묶음 J). 오류를 렌더하지 않는다 — 바이트와
//! 오류만 돌려주고, 무엇을 어떻게 답할지는 호출자가 자기 방언으로 정한다.

use std::fmt;

use bytes::Bytes;
use http::{HeaderValue, StatusCode, header};
use http_body_util::{BodyExt, LengthLimitError, Limited};
use hyper::body::Body;

/// 요청 본문의 오류 타입.
pub type BoxError = Box<dyn std::error::Error + Send + Sync>;

/// JSON 본문의 기본 상한이다 (FR-RQG-15).
pub const DEFAULT_LIMIT: i64 = 1 << 20;

/// 워크스페이스처럼 커질 수 있는 종단의 상한이다.
pub const WORKSPACE_LIMIT: i64 = 8 << 20;

/// 작은 JSON 본문의 상한이다 (FR-PNW-43 · FR-RDG-6).
pub const SMALL_LIMIT: i64 = 64 << 10;

/// [`ReadError::TooLarge`] 의 문구 (Go `ErrTooLarge.Error()`).
pub const TOO_LARGE_MSG: &str = "본문이 상한을 넘었다";

/// 본문 읽기의 실패.
#[derive(Debug)]
pub enum ReadError {
    /// 본문이 상한을 넘었다. 호출자는 이것을 413 으로 옮긴다.
    TooLarge,
    /// 그 밖의 읽기 실패(연결 끊김 등).
    Other(BoxError),
}

impl fmt::Display for ReadError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ReadError::TooLarge => f.write_str(TOO_LARGE_MSG),
            ReadError::Other(e) => fmt::Display::fmt(e, f),
        }
    }
}

impl std::error::Error for ReadError {}

/// 본문을 상한 안에서 읽는다. `limit` 이 0 이하면 [`DEFAULT_LIMIT`].
///
/// 상한을 넘었으면 Go `http.MaxBytesReader` 처럼 응답이 연결을 닫아야 한다 —
/// 응답을 만든 쪽이 [`mark_response`] 를 부른다.
pub async fn read<B>(body: B, limit: i64) -> Result<Bytes, ReadError>
where
    B: Body,
    B::Error: Into<BoxError>,
{
    let limit = if limit <= 0 { DEFAULT_LIMIT } else { limit };
    let limit = usize::try_from(limit).unwrap_or(usize::MAX);
    match Limited::new(body, limit).collect().await {
        Ok(c) => Ok(c.to_bytes()),
        Err(e) if e.downcast_ref::<LengthLimitError>().is_some() => Err(ReadError::TooLarge),
        Err(e) => Err(ReadError::Other(e)),
    }
}

/// 오류 하나를 상태 코드로 옮긴다.
pub fn status(err: &ReadError) -> StatusCode {
    match err {
        ReadError::TooLarge => StatusCode::PAYLOAD_TOO_LARGE,
        ReadError::Other(_) => StatusCode::BAD_REQUEST,
    }
}

/// 상한 초과면 응답에 `Connection: close` 를 세운다. Go `http.MaxBytesReader` 가 응답에
/// 남기는 표식과 같다 — 클라이언트가 남은 본문을 계속 보내지 않게 한다.
pub fn mark_response<T>(err: &ReadError, res: &mut http::Response<T>) {
    if matches!(err, ReadError::TooLarge) {
        res.headers_mut()
            .insert(header::CONNECTION, HeaderValue::from_static("close"));
    }
}

/// 빈 본문의 처리다.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Empty {
    /// 빈 본문은 [`DecodeError::NotJson`] 이다.
    NotJson,
    /// 빈 본문을 `{}` 로 읽는다.
    AsObject,
}

/// JSON 본문 읽기의 실패. Go `Failure`(ReadFailed·NotJSON)와 원인 오류를 함께 든다.
#[derive(Debug)]
pub enum DecodeError {
    /// 본문을 읽지 못했다. 상한 초과면 [`ReadError::TooLarge`] 다.
    Read(ReadError),
    /// 본문이 값으로 풀리지 않았다.
    NotJson(otter_gocompat::json::Error),
}

impl fmt::Display for DecodeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            DecodeError::Read(e) => fmt::Display::fmt(e, f),
            DecodeError::NotJson(e) => fmt::Display::fmt(e, f),
        }
    }
}

impl std::error::Error for DecodeError {}

impl DecodeError {
    /// Go `Status(err)`: 상한 초과는 413, 그 밖은 400.
    pub fn status(&self) -> StatusCode {
        match self {
            DecodeError::Read(e) => status(e),
            DecodeError::NotJson(_) => StatusCode::BAD_REQUEST,
        }
    }
}

/// 본문을 상한 안에서 읽어 `T` 로 푼다 (REFACTOR3_DEDUP_GO_SRS FR-RDG-5). `limit` 이 0 이하면
/// [`DEFAULT_LIMIT`]. **답하지 않는다** — 상태·코드·문구는 호출자가 자기 방언으로 정한다.
///
/// Go 는 미리 채운 값 위에 풀지만, 여기서는 새 값을 돌려준다. 미리 채우던 기본값은 `T` 의
/// `#[serde(default)]` 로 옮긴다.
pub async fn decode_json<T, B>(body: B, limit: i64, empty: Empty) -> Result<T, DecodeError>
where
    T: serde::de::DeserializeOwned,
    B: Body,
    B::Error: Into<BoxError>,
{
    let raw = read(body, limit).await.map_err(DecodeError::Read)?;
    let raw: &[u8] = if raw.is_empty() && empty == Empty::AsObject {
        b"{}"
    } else {
        &raw
    };
    otter_gocompat::json::unmarshal(raw).map_err(DecodeError::NotJson)
}

/// 디코드 실패를 클라이언트에 보여도 되는 말로 옮긴다 (QUALITY_GO_SRS FR-QG-1·2). 싣는 것은
/// 요청 자리뿐이다: 문법 오류는 그 문구, 형 오류는 필드 경로와 받은 값의 JSON 종류다.
/// 그 밖은 빈 문자열이다.
pub fn reason_json(err: &otter_gocompat::json::Error) -> String {
    use otter_gocompat::json::ErrorKind;
    match err.kind() {
        ErrorKind::Syntax { .. } => err.to_string(),
        ErrorKind::Type { value, field, .. } if field.is_empty() => {
            format!("{value} 값은 맞지 않다")
        }
        ErrorKind::Type { value, field, .. } => format!("{field}: {value} 값은 맞지 않다"),
        _ => String::new(),
    }
}

/// [`reason_json`] 에 읽기 실패를 더한 것이다. 상한 초과는 [`TOO_LARGE_MSG`], 그 밖의 읽기 실패는 빈 문자열이다.
pub fn reason(err: &DecodeError) -> String {
    match err {
        DecodeError::Read(ReadError::TooLarge) => TOO_LARGE_MSG.to_owned(),
        DecodeError::Read(ReadError::Other(_)) => String::new(),
        DecodeError::NotJson(e) => reason_json(e),
    }
}

/// 고정 문구 prefix 에 [`reason`] 을 잇고, 원인 전문은 로그로 남긴다 (FR-QG-3).
/// 요청 자리가 없으면 prefix 뿐이다. `method`·`path` 는 Go `r.Method`·`r.URL.Path` 다.
pub fn message(
    ctx: otter_shared_otterlog::ReqCtx<'_>,
    method: &str,
    path: &str,
    prefix: &str,
    err: &DecodeError,
) -> String {
    otter_shared_otterlog::infof!(ctx, "body decode {method} {path}: {err}");
    let why = reason(err);
    if why.is_empty() {
        prefix.to_owned()
    } else {
        format!("{prefix}: {why}")
    }
}

#[cfg(test)]
mod tests;
