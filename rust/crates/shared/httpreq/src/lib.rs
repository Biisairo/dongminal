//! Go 기준선 `dongminal/internal/shared/httpreq` 의 Rust 포팅. RUST_PORT_SRS 참고.
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

#[cfg(test)]
mod tests;
