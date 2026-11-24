//! 브라우저 WebSocket 와이어의 op 코드와 타임아웃 상수. 쓰기 창구(SafeConn)는 2.2.3.

use std::time::Duration;

pub const OP_INPUT: u8 = 0x00;
pub const OP_RESIZE: u8 = 0x01;
pub const OP_OUTPUT: u8 = 0x00;
pub const OP_ERROR: u8 = 0x01;
pub const OP_EXIT: u8 = 0x02;
pub const OP_TOOL_ID: u8 = 0x03;
/// 좌표 통보. 페이로드 9 바이트 — 오프셋 8(빅엔디언) + 전량 재생 여부 1 (FR-TRS-6).
pub const OP_SEQ: u8 = 0x04;
/// PTY 크기 통보. 페이로드 4 바이트 — cols 2 + rows 2, 빅엔디언 (FR-M9-3).
pub const OP_SIZE: u8 = 0x05;
/// 답장 자격 통보. 페이로드 1 바이트 — 1=좌석의 주인 (TERM_REPLY_SEAT_SRS FR-RPS-3).
pub const OP_REPLY_SEAT: u8 = 0x06;

pub const PONG_WAIT: Duration = Duration::from_secs(60);
pub const PING_PERIOD: Duration = Duration::from_secs(54);

/// `OP_SIZE` 의 4 바이트다 (FR-M9-3).
pub fn size_payload(cols: u16, rows: u16) -> [u8; 4] {
    let [c0, c1] = cols.to_be_bytes();
    let [r0, r1] = rows.to_be_bytes();
    [c0, c1, r0, r1]
}

/// 쓰기 한 번의 마감이다(Go `writeWait`).
pub const WRITE_WAIT: Duration = Duration::from_secs(10);
/// 업그레이드의 읽기·쓰기 버퍼 크기다(Go `Upgrader`). `/ws` 처리기(5.5)가 쓴다.
pub const WS_BUFFER_SIZE: usize = 8192;

use std::sync::atomic::{AtomicBool, Ordering::SeqCst};

use dm_shared_dmlog::infof;
use futures_util::{Sink, SinkExt};
use tokio_tungstenite::tungstenite::{Error as WsError, Message};

/// 브라우저 WebSocket 한 벌의 직렬화된 쓰기 창구다. 쓰기는 한 번에 하나이고 마감이 있다.
/// 읽기 반쪽은 처리기가 따로 든다.
pub struct SafeConn<S> {
    sink: tokio::sync::Mutex<S>,
    remote: String,
    closed: AtomicBool,
}

impl<S> SafeConn<S>
where
    S: Sink<Message, Error = WsError> + Unpin + Send,
{
    pub fn new(sink: S, remote_addr: impl Into<String>) -> Self {
        Self {
            sink: tokio::sync::Mutex::new(sink),
            remote: remote_addr.into(),
            closed: AtomicBool::new(false),
        }
    }

    async fn write_within(&self, msg: Message, wait: Duration) -> Result<(), WsError> {
        let mut sink = self.sink.lock().await;
        match tokio::time::timeout(wait, sink.send(msg)).await {
            Ok(r) => r,
            Err(_) => Err(WsError::Io(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "i/o timeout",
            ))),
        }
    }

    pub async fn write_msg(&self, msg: Message) -> Result<(), WsError> {
        self.write_within(msg, WRITE_WAIT).await
    }

    /// 핑이다. 마감은 핑 주기 + 쓰기 마감이다.
    pub async fn write_ping(&self) -> Result<(), WsError> {
        self.write_within(Message::Ping(Default::default()), PING_PERIOD + WRITE_WAIT)
            .await
    }

    /// op 한 바이트 + 페이로드의 바이너리 프레임이다. 실패는 로그에 남긴다.
    pub async fn send(&self, op: u8, payload: &[u8]) -> Result<(), WsError> {
        let mut frame = Vec::with_capacity(1 + payload.len());
        frame.push(op);
        frame.extend_from_slice(payload);
        let r = self.write_msg(Message::binary(frame)).await;
        if let Err(e) = &r {
            infof!(None, "ws send op=0x{op:02x} addr={}: {e}", self.remote);
        }
        r
    }

    /// 한 번만 닫는다.
    pub async fn close(&self) {
        if self.closed.swap(true, SeqCst) {
            return;
        }
        let _ = self.sink.lock().await.close().await;
    }

    pub fn remote_addr(&self) -> &str {
        &self.remote
    }
}

#[cfg(test)]
mod tests {
    use std::pin::Pin;
    use std::sync::{Arc, Mutex};
    use std::task::{Context, Poll};

    use super::*;

    #[derive(Clone, Default)]
    struct VecSink(Arc<Mutex<Vec<Message>>>, Arc<AtomicBool>);

    impl Sink<Message> for VecSink {
        type Error = WsError;
        fn poll_ready(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Result<(), WsError>> {
            Poll::Ready(Ok(()))
        }
        fn start_send(self: Pin<&mut Self>, m: Message) -> Result<(), WsError> {
            self.0.lock().unwrap().push(m);
            Ok(())
        }
        fn poll_flush(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Result<(), WsError>> {
            Poll::Ready(Ok(()))
        }
        fn poll_close(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Result<(), WsError>> {
            self.1.store(true, SeqCst);
            Poll::Ready(Ok(()))
        }
    }

    #[test]
    fn size_payload_is_big_endian() {
        assert_eq!(size_payload(0x0102, 0x0304), [1, 2, 3, 4]);
        assert_eq!(PING_PERIOD, PONG_WAIT * 9 / 10);
    }

    #[tokio::test]
    async fn send_frames_op_then_payload() {
        let sink = VecSink::default();
        let c = SafeConn::new(sink.clone(), "1.2.3.4:5");
        c.send(OP_SIZE, &size_payload(80, 24)).await.unwrap();
        c.write_ping().await.unwrap();
        c.close().await;
        c.close().await;
        let got = sink.0.lock().unwrap().clone();
        assert_eq!(got[0], Message::binary(vec![OP_SIZE, 0, 80, 0, 24]));
        assert!(matches!(got[1], Message::Ping(_)));
        assert!(sink.1.load(SeqCst));
        assert_eq!(c.remote_addr(), "1.2.3.4:5");
    }
}
