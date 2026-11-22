//! Go 기준선 `dongminal/internal/webserver/sse` 의 Rust 포팅. RUST_PORT_SRS 참고.
//!
//! 서버가 내보내는 SSE 스트림의 작성기와 방송 본문의 봉투다 (OPTIMIZE_REFACTOR_SRS FR-OPT-8-1).
//! 프레임을 버퍼에 모으고, 쌓인 것을 한 번에 쓴다.
//!
//! 응답 본문은 용량 1 의 채널이다. hyper 는 앞 프레임을 소켓에 내보낸 뒤에야 다음 프레임을
//! 꺼내므로, 읽지 않는 클라이언트에서는 [`Stream::flush`] 의 보내기가 막히고 시한에 걸린다.
//! 시한에 걸린 스트림은 본문을 오류로 끝내 연결을 끊는다 — Go 의 쓰기 시한과 같다.

use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::task::{Context, Poll};
use std::time::Duration;

use bytes::Bytes;
use dm_shared_httpresp::{BoxError, Response};
use http::{HeaderValue, StatusCode, header};
use http_body_util::BodyExt;
use hyper::body::{Body, Frame};
use tokio::sync::mpsc;

mod payload;

pub use payload::{payload, workspace_changed};

/// flush 하나(쓰기+Flush)의 시한이다 (REPO_FIX 02 §3A-2).
pub const WRITE_TIMEOUT: Duration = Duration::from_secs(10);

/// 한 번에 모아 쓰는 양의 상한이다.
pub const MAX_BATCH_BYTES: usize = 64 << 10;

const TIMED_OUT_MSG: &str = "sse: write deadline exceeded";

/// SSE 응답 하나다. 핸들러 하나만 쓴다.
pub struct Stream {
    tx: mpsc::Sender<Bytes>,
    aborted: Arc<AtomicBool>,
    timeout: Duration,
    buf: Vec<u8>,
}

struct SseBody {
    rx: mpsc::Receiver<Bytes>,
    aborted: Arc<AtomicBool>,
}

impl Body for SseBody {
    type Data = Bytes;
    type Error = BoxError;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, BoxError>>> {
        match self.rx.poll_recv(cx) {
            Poll::Ready(Some(b)) => Poll::Ready(Some(Ok(Frame::data(b)))),
            Poll::Ready(None) if self.aborted.load(Ordering::Acquire) => {
                Poll::Ready(Some(Err(TIMED_OUT_MSG.into())))
            }
            Poll::Ready(None) => Poll::Ready(None),
            Poll::Pending => Poll::Pending,
        }
    }
}

/// SSE 헤더와 200 응답, 그리고 그 본문에 쓰는 [`Stream`] 을 만든다.
/// `timeout` 이 0 이면 [`WRITE_TIMEOUT`] 이다.
pub fn start(timeout: Duration) -> (Response, Stream) {
    let timeout = if timeout.is_zero() {
        WRITE_TIMEOUT
    } else {
        timeout
    };
    let (tx, rx) = mpsc::channel(1);
    let aborted = Arc::new(AtomicBool::new(false));
    let body = SseBody {
        rx,
        aborted: Arc::clone(&aborted),
    };
    let mut res = http::Response::new(body.boxed());
    *res.status_mut() = StatusCode::OK;
    let h = res.headers_mut();
    h.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/event-stream"),
    );
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    h.insert(header::CONNECTION, HeaderValue::from_static("keep-alive"));
    let st = Stream {
        tx,
        aborted,
        timeout,
        buf: Vec::new(),
    };
    (res, st)
}

impl Stream {
    /// `: text` 주석 프레임을 버퍼에 더한다.
    pub fn comment(&mut self, text: &str) {
        self.buf.extend_from_slice(b": ");
        self.buf.extend_from_slice(text.as_bytes());
        self.buf.extend_from_slice(b"\n\n");
    }

    /// 이름 없는 `data:` 프레임을 버퍼에 더한다.
    pub fn data(&mut self, payload: &[u8]) {
        self.buf.extend_from_slice(b"data: ");
        self.buf.extend_from_slice(payload);
        self.buf.extend_from_slice(b"\n\n");
    }

    /// 이름 있는 프레임을 버퍼에 더한다.
    pub fn event(&mut self, name: &str, payload: &[u8]) {
        self.buf.extend_from_slice(b"event: ");
        self.buf.extend_from_slice(name.as_bytes());
        self.buf.push(b'\n');
        self.data(payload);
    }

    /// 버퍼가 [`MAX_BATCH_BYTES`] 에 닿았는지 본다.
    pub fn full(&self) -> bool {
        self.buf.len() >= MAX_BATCH_BYTES
    }

    /// 이미 쌓인 payload 를 기다리지 않고 꺼내 [`Stream::data`] 로 더한다. `next` 는 쌓인
    /// 것이 없으면 `None` 을 돌려준다(예: `|| rx.try_recv().ok()`). 버퍼가 차거나 `next` 가
    /// `None` 이면 멈춘다.
    pub fn drain_data<P: AsRef<[u8]>>(&mut self, mut next: impl FnMut() -> Option<P>) {
        while !self.full() {
            match next() {
                Some(p) => self.data(p.as_ref()),
                None => return,
            }
        }
    }

    /// 버퍼를 한 번 쓴다. 빈 버퍼는 쓰지 않는다. 시한 안에 쓰지 못했거나 클라이언트가
    /// 떠났으면 false — 호출자는 핸들러를 끝낸다.
    pub async fn flush(&mut self) -> bool {
        if self.buf.is_empty() {
            return true;
        }
        let b = Bytes::from(std::mem::take(&mut self.buf));
        if self.aborted.load(Ordering::Acquire) {
            return false;
        }
        match tokio::time::timeout(self.timeout, self.tx.send(b)).await {
            Ok(Ok(())) => true,
            Ok(Err(_)) => false,
            Err(_) => {
                self.aborted.store(true, Ordering::Release);
                false
            }
        }
    }
}

#[cfg(test)]
mod tests;
