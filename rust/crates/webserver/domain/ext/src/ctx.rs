//! Go `context.Context` 의 취소·시한 (FR-RSP-36). 취소는 `CancellationToken` 이고, 시한은 따로
//! 기억해 Go 처럼 `context deadline exceeded` 와 `context canceled` 를 가른다.

use std::fmt;
use std::time::Duration;

use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

/// 취소와 시한.
#[derive(Debug, Clone)]
pub struct Ctx {
    token: CancellationToken,
    deadline: Option<Instant>,
}

/// Go `ctx.Err()`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
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

impl Default for Ctx {
    fn default() -> Self {
        Self::background()
    }
}

impl Ctx {
    /// 취소되지 않는 ctx (Go `context.Background()`).
    pub fn background() -> Self {
        Self::new(CancellationToken::new())
    }

    /// token 이 취소되면 끝나는 ctx.
    pub fn new(token: CancellationToken) -> Self {
        Self {
            token,
            deadline: None,
        }
    }

    /// Go `context.WithTimeout`. 부모가 취소되면 같이 끝나고, 더 이른 시한을 지킨다.
    pub fn with_timeout(&self, d: Duration) -> Self {
        let at = Instant::now() + d;
        Self {
            token: self.token.child_token(),
            deadline: Some(self.deadline.map_or(at, |p| p.min(at))),
        }
    }

    /// 아직 끝나지 않았으면 `None`.
    pub fn err(&self) -> Option<CtxError> {
        if let Some(d) = self.deadline
            && Instant::now() >= d
        {
            return Some(CtxError::DeadlineExceeded);
        }
        self.token.is_cancelled().then_some(CtxError::Canceled)
    }

    /// 끝날 때 깨어난다. 돌려주는 값은 그때의 [`Ctx::err`] 다.
    pub async fn done(&self) -> CtxError {
        match self.deadline {
            Some(d) => tokio::select! {
                _ = self.token.cancelled() => self.err().unwrap_or(CtxError::Canceled),
                _ = tokio::time::sleep_until(d) => CtxError::DeadlineExceeded,
            },
            None => {
                self.token.cancelled().await;
                CtxError::Canceled
            }
        }
    }

    /// 이 ctx 를 끝낸다 (Go 의 `cancel()`).
    pub fn cancel(&self) {
        self.token.cancel();
    }
}
