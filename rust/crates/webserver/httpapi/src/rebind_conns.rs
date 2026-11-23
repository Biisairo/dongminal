//! 서버가 받은 연결과 연결마다의 시한 (Go `rebind_conns.go` 와 `http.Server` 의
//! `ReadHeaderTimeout`·`IdleTimeout`).
//!
//! expose 를 끄면 같은 망에서 맺은 연결을 끊어야 한다 (HOT_REBIND_SRS FR-HRB-32). 리스너를 닫아도
//! 이미 맺은 연결(WebSocket 포함)은 남기 때문이다. 업그레이드된 연결도 이 IO 를 그대로 쓰므로 함께
//! 끊긴다.

use std::collections::HashMap;
use std::future::Future;
use std::io;
use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll, Waker};
use std::time::Duration;

use bytes::Bytes;
use hyper::body::{Body, Frame, SizeHint};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::TcpStream;
use tokio::time::{Instant, Sleep};
use tokio_util::sync::{CancellationToken, WaitForCancellationFutureOwned};

use crate::openurl::is_loopback_addr;

/// 서버가 받은 연결이다 (Go `connSet`).
#[derive(Default)]
pub(crate) struct ConnSet {
    m: Mutex<HashMap<u64, (SocketAddr, CancellationToken)>>,
    next: AtomicU64,
}

/// 집합에 든 연결 하나다. 버려지면 집합에서 빠진다 (Go `trackedConn.Close`).
pub(crate) struct ConnTrack {
    id: u64,
    set: Arc<ConnSet>,
    pub(crate) kill: CancellationToken,
}

impl Drop for ConnTrack {
    fn drop(&mut self) {
        self.set
            .m
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.id);
    }
}

impl ConnSet {
    /// 연결을 집합에 넣는다.
    pub(crate) fn track(self: &Arc<Self>, remote: SocketAddr) -> ConnTrack {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let kill = CancellationToken::new();
        self.m
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id, (remote, kill.clone()));
        ConnTrack {
            id,
            set: Arc::clone(self),
            kill,
        }
    }

    #[cfg(test)]
    pub(crate) fn size(&self) -> usize {
        self.m.lock().unwrap_or_else(|e| e.into_inner()).len()
    }

    /// 출발지가 루프백이 아닌 연결을 모두 끊는다.
    pub(crate) fn revoke_remote(&self) {
        let drop: Vec<CancellationToken> = self
            .m
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .filter(|(a, _)| !is_loopback_addr(&a.to_string()))
            .map(|(_, k)| k.clone())
            .collect();
        for k in drop {
            k.cancel();
        }
    }
}

/// 연결마다의 두 시한이다 (REQUEST_GATE_SRS FR-RQG-18).
#[derive(Clone, Copy, Debug)]
pub(crate) struct ConnTimeouts {
    pub(crate) read_header: Duration,
    pub(crate) idle: Duration,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum PhaseKind {
    /// 요청 머리를 기다린다 — 머리 시한이 걸린다.
    Header,
    /// 요청을 처리 중이다. 시한이 없다 (Go 는 `ReadTimeout` 을 두지 않는다).
    Busy(usize),
    /// 응답을 마치고 다음 요청을 기다린다 — 유휴 시한이 걸린다.
    Idle,
    /// 업그레이드(WebSocket)됐다. 시한이 없다 (Go 의 하이재킹).
    Upgraded,
}

struct PhaseState {
    kind: PhaseKind,
    deadline: Option<Instant>,
    waker: Option<Waker>,
}

/// 연결 하나의 단계다. 첫 요청은 머리 시한으로 시작한다 (Go `readRequest`).
pub(crate) struct Phase {
    t: ConnTimeouts,
    st: Mutex<PhaseState>,
}

impl Phase {
    pub(crate) fn new(t: ConnTimeouts) -> Arc<Phase> {
        Arc::new(Phase {
            t,
            st: Mutex::new(PhaseState {
                kind: PhaseKind::Header,
                deadline: Some(Instant::now() + t.read_header),
                waker: None,
            }),
        })
    }

    /// 단계를 바꾸고, 시한을 기다리던 읽기를 깨운다.
    fn update(&self, f: impl FnOnce(PhaseKind) -> Option<(PhaseKind, Option<Instant>)>) {
        let mut st = self.st.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((kind, deadline)) = f(st.kind) {
            st.kind = kind;
            st.deadline = deadline;
            if let Some(w) = st.waker.take() {
                w.wake();
            }
        }
    }

    /// 머리를 다 읽었다. 응답 본문이 끝나면 [`ReqGuard`] 가 되돌린다.
    pub(crate) fn begin(self: &Arc<Self>) -> ReqGuard {
        self.update(|k| match k {
            PhaseKind::Upgraded => None,
            PhaseKind::Busy(n) => Some((PhaseKind::Busy(n + 1), None)),
            _ => Some((PhaseKind::Busy(1), None)),
        });
        ReqGuard(Arc::clone(self))
    }

    pub(crate) fn upgraded(&self) {
        self.update(|_| Some((PhaseKind::Upgraded, None)));
    }

    fn end(&self) {
        let idle = self.t.idle;
        self.update(|k| match k {
            PhaseKind::Busy(n) if n > 1 => Some((PhaseKind::Busy(n - 1), None)),
            PhaseKind::Busy(_) => Some((PhaseKind::Idle, Some(Instant::now() + idle))),
            _ => None,
        });
    }

    /// 유휴 중에 바이트가 오면 머리 시한으로 넘어간다.
    fn saw_bytes(&self) {
        let rh = self.t.read_header;
        self.update(|k| {
            (k == PhaseKind::Idle).then(|| (PhaseKind::Header, Some(Instant::now() + rh)))
        });
    }

    fn deadline(&self, w: &Waker) -> Option<Instant> {
        let mut st = self.st.lock().unwrap_or_else(|e| e.into_inner());
        st.waker = Some(w.clone());
        st.deadline
    }
}

/// 요청 하나가 끝날 때(응답 본문을 버릴 때) 단계를 되돌린다.
pub(crate) struct ReqGuard(Arc<Phase>);

impl Drop for ReqGuard {
    fn drop(&mut self) {
        self.0.end();
    }
}

/// 응답 본문이다. 다 쓰고 버려지면 연결이 유휴로 돌아간다.
pub(crate) struct DoneBody {
    pub(crate) inner: dm_shared_httpresp::Body,
    pub(crate) _guard: ReqGuard,
}

impl Body for DoneBody {
    type Data = Bytes;
    type Error = <dm_shared_httpresp::Body as Body>::Error;

    fn poll_frame(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, Self::Error>>> {
        Pin::new(&mut self.get_mut().inner).poll_frame(cx)
    }

    fn is_end_stream(&self) -> bool {
        self.inner.is_end_stream()
    }

    fn size_hint(&self) -> SizeHint {
        self.inner.size_hint()
    }
}

/// 받은 연결의 IO 다 (Go `trackedConn` 과 연결 시한).
pub(crate) struct ConnIo {
    inner: TcpStream,
    _track: ConnTrack,
    killed: Pin<Box<WaitForCancellationFutureOwned>>,
    phase: Arc<Phase>,
    sleep: Pin<Box<Sleep>>,
    armed: Option<Instant>,
}

impl ConnIo {
    pub(crate) fn new(inner: TcpStream, track: ConnTrack, phase: Arc<Phase>) -> ConnIo {
        let killed = Box::pin(track.kill.clone().cancelled_owned());
        ConnIo {
            inner,
            _track: track,
            killed,
            phase,
            sleep: Box::pin(tokio::time::sleep(Duration::ZERO)),
            armed: None,
        }
    }

    fn revoked(&mut self, cx: &mut Context<'_>) -> bool {
        self.killed.as_mut().poll(cx).is_ready()
    }
}

fn revoked_err() -> io::Error {
    io::Error::new(io::ErrorKind::ConnectionAborted, "connection revoked")
}

impl AsyncRead for ConnIo {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        if this.revoked(cx) {
            return Poll::Ready(Err(revoked_err()));
        }
        if let Some(d) = this.phase.deadline(cx.waker()) {
            if this.armed != Some(d) {
                this.sleep.as_mut().reset(d);
                this.armed = Some(d);
            }
            if this.sleep.as_mut().poll(cx).is_ready() {
                return Poll::Ready(Err(io::Error::new(io::ErrorKind::TimedOut, "i/o timeout")));
            }
        }
        let before = buf.filled().len();
        let r = Pin::new(&mut this.inner).poll_read(cx, buf);
        if matches!(r, Poll::Ready(Ok(()))) && buf.filled().len() > before {
            this.phase.saw_bytes();
        }
        r
    }
}

impl AsyncWrite for ConnIo {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        data: &[u8],
    ) -> Poll<io::Result<usize>> {
        let this = self.get_mut();
        if this.revoked(cx) {
            return Poll::Ready(Err(revoked_err()));
        }
        Pin::new(&mut this.inner).poll_write(cx, data)
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_flush(cx)
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_shutdown(cx)
    }
}
