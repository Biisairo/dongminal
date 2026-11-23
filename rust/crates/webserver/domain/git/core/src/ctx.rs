//! Go `context.Context` 의 취소·마감 부분. 4.2 jobs 도 쓴다.

use std::fmt;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tokio_util::sync::CancellationToken;

/// Go `context.Canceled`·`context.DeadlineExceeded`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CtxError {
    Canceled,
    DeadlineExceeded,
}

impl fmt::Display for CtxError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            CtxError::Canceled => "context canceled",
            CtxError::DeadlineExceeded => "context deadline exceeded",
        })
    }
}

impl std::error::Error for CtxError {}

struct Inner {
    token: CancellationToken,
    deadline: Option<Instant>,
    parent: Option<Arc<Inner>>,
    // 처음 관측된 사유. Go 처럼 먼저 일어난 쪽이 남는다.
    err: Mutex<Option<CtxError>>,
}

impl Inner {
    fn err(&self) -> Option<CtxError> {
        let mut slot = self.err.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(e) = *slot {
            return Some(e);
        }
        let found = self
            .parent
            .as_ref()
            .and_then(|p| p.err())
            .or_else(|| {
                self.deadline
                    .filter(|d| Instant::now() >= *d)
                    .map(|_| CtxError::DeadlineExceeded)
            })
            .or_else(|| self.token.is_cancelled().then_some(CtxError::Canceled));
        *slot = found;
        found
    }
}

/// 취소 토큰과 마감. 복제는 같은 문맥을 가리킨다.
#[derive(Clone)]
pub struct Ctx {
    inner: Arc<Inner>,
}

impl Default for Ctx {
    fn default() -> Self {
        Self::background()
    }
}

impl fmt::Debug for Ctx {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Ctx")
            .field("deadline", &self.inner.deadline)
            .field("err", &self.err())
            .finish()
    }
}

impl Ctx {
    fn make(
        token: CancellationToken,
        deadline: Option<Instant>,
        parent: Option<Arc<Inner>>,
    ) -> Self {
        Ctx {
            inner: Arc::new(Inner {
                token,
                deadline,
                parent,
                err: Mutex::new(None),
            }),
        }
    }

    /// Go `context.Background()`.
    pub fn background() -> Self {
        Self::make(CancellationToken::new(), None, None)
    }

    /// 바깥 토큰에 묶인 문맥. 토큰이 취소되면 Canceled 다.
    pub fn from_token(token: CancellationToken) -> Self {
        Self::make(token, None, None)
    }

    /// 이 문맥의 토큰. 마감이 지나도 토큰은 스스로 취소되지 않는다 — 마감까지 기다리려면
    /// `done()` 을 쓴다.
    pub fn token(&self) -> &CancellationToken {
        &self.inner.token
    }

    /// Go `ctx.Deadline()`.
    pub fn deadline(&self) -> Option<Instant> {
        self.inner.deadline
    }

    /// Go `context.WithCancel`.
    pub fn with_cancel(&self) -> Self {
        Self::make(
            self.inner.token.child_token(),
            self.inner.deadline,
            Some(self.inner.clone()),
        )
    }

    /// Go `context.WithTimeout`. 부모의 마감이 더 이르면 그것이 남는다.
    pub fn with_timeout(&self, d: Duration) -> Self {
        let own = Instant::now().checked_add(d);
        let deadline = match (self.inner.deadline, own) {
            (Some(p), Some(o)) => Some(p.min(o)),
            (p, o) => p.or(o),
        };
        Self::make(
            self.inner.token.child_token(),
            deadline,
            Some(self.inner.clone()),
        )
    }

    /// Go `cancel()`. 이미 끝났으면 사유를 바꾸지 않는다.
    pub fn cancel(&self) {
        if self.inner.err().is_none() {
            let mut slot = self.inner.err.lock().unwrap_or_else(|e| e.into_inner());
            slot.get_or_insert(CtxError::Canceled);
        }
        self.inner.token.cancel();
    }

    /// Go `ctx.Err()`.
    pub fn err(&self) -> Option<CtxError> {
        self.inner.err()
    }

    /// Go `<-ctx.Done()`.
    pub async fn done(&self) {
        match self.inner.deadline {
            Some(d) => {
                tokio::select! {
                    _ = self.inner.token.cancelled() => {}
                    _ = tokio::time::sleep_until(d.into()) => {}
                }
            }
            None => self.inner.token.cancelled().await,
        }
    }
}
