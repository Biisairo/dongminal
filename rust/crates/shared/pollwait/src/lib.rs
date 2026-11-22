//! Go 기준선 `dongminal/internal/shared/pollwait` 의 Rust 포팅.
//!
//! "조건이 설 때까지 묻는" 대기 한 벌이다 (M8 D-A-15, GO-27). 기다리는 것은 시간이
//! 아니라 **사실**이고, 사실이 서면 곧 돌아온다.
//!
//! Go 의 `context.Context` 자리는 [`CancellationToken`] 이 맡는다. 취소되면 곧
//! [`WaitError::Canceled`] 로 돌아온다. 대기는 tokio 타이머로 하므로 tokio 런타임 안에서
//! 불러야 한다.

use std::fmt;
use std::time::{Duration, Instant};

use tokio::sync::watch;
pub use tokio_util::sync::CancellationToken;

/// 대기의 실패다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WaitError {
    /// 상한 안에 조건이 서지 않았다 — "오지 않았다". 문구 `wait: timeout`.
    Timeout,
    /// 묻는 쪽이 사라졌다. 문구는 Go `context.Canceled` 와 같은 `context canceled`.
    Canceled,
}

impl fmt::Display for WaitError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            WaitError::Timeout => "wait: timeout",
            WaitError::Canceled => "context canceled",
        })
    }
}

impl std::error::Error for WaitError {}

/// `cond` 가 참이 될 때까지 `every` 간격으로 묻는다 — 최대 `max` 동안.
///
/// 조건은 먼저 한 번 묻고, 그 뒤 `every` 마다 묻는다. 남은 시간이 `every` 보다 짧으면
/// 그만큼만 기다린다. 취소되면 즉시 돌아온다.
pub async fn until(
    cancel: &CancellationToken,
    max: Duration,
    every: Duration,
    mut cond: impl FnMut() -> bool,
) -> Result<(), WaitError> {
    let deadline = Instant::now() + max;
    loop {
        if cond() {
            return Ok(());
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(WaitError::Timeout);
        }
        tokio::select! {
            _ = cancel.cancelled() => return Err(WaitError::Canceled),
            _ = tokio::time::sleep(remaining.min(every)) => {}
        }
    }
}

/// "바뀌었다" 방송이다 (FR-OPT-8-4). 상태의 주인이 바꿀 때 [`Signal::notify`] 하고,
/// 기다리는 쪽은 [`Signal::c`] 로 받은 [`Changed`] 가 울리기를 기다린다.
/// `Default` 로 만든 값을 그대로 쓸 수 있다. `notify` 는 런타임 밖에서도 부를 수 있다.
///
/// 기다리는 쪽은 **`c` 를 먼저 받고** 조건을 묻는다 — 그 사이에 온 알림을 놓치지 않는다.
#[derive(Debug)]
pub struct Signal {
    tx: watch::Sender<u64>,
}

impl Default for Signal {
    fn default() -> Self {
        Self {
            tx: watch::channel(0).0,
        }
    }
}

impl Signal {
    /// 다음 `notify` 에 울릴 구독이다.
    pub fn c(&self) -> Changed {
        Changed(self.tx.subscribe())
    }

    /// 지금 기다리는 쪽을 모두 깨운다.
    pub fn notify(&self) {
        self.tx.send_modify(|v| *v = v.wrapping_add(1));
    }
}

/// [`Signal::c`] 가 준 구독이다. 구독한 뒤 `notify` 가 한 번이라도 있었으면 울린 것이다.
#[derive(Debug)]
pub struct Changed(watch::Receiver<u64>);

impl Changed {
    /// 이미 울렸는가다 (기다리지 않는다).
    pub fn fired(&self) -> bool {
        self.0.has_changed().unwrap_or(false)
    }

    /// 울릴 때까지 기다린다. 신호의 주인이 사라지면 영원히 기다린다 — 다시 울릴 일이 없다.
    pub async fn wait(&mut self) {
        if self.0.changed().await.is_err() {
            std::future::pending::<()>().await;
        }
    }
}

/// [`until`] 의 알림판이다: `cond` 를 먼저 한 번 묻고, 그 뒤에는 `changed` 가 준 구독이
/// 울릴 때만 다시 묻는다 — 최대 `max` 동안. 상한에 이르면 마지막으로 한 번 묻는다.
pub async fn on(
    cancel: &CancellationToken,
    max: Duration,
    mut changed: impl FnMut() -> Changed,
    mut cond: impl FnMut() -> bool,
) -> Result<(), WaitError> {
    let timer = tokio::time::sleep(max);
    tokio::pin!(timer);
    loop {
        let mut ch = changed();
        if cond() {
            return Ok(());
        }
        tokio::select! {
            _ = cancel.cancelled() => return Err(WaitError::Canceled),
            _ = &mut timer => {
                return if cond() { Ok(()) } else { Err(WaitError::Timeout) };
            }
            _ = ch.wait() => {}
        }
    }
}

/// [`on`] 에 시간축을 더한 것이다 (FR-OPT-16-3): `cond` 는 서지 않았으면 다음에 물을
/// 시각을 함께 돌려준다. 구독이 울리거나 그 시각에 이르면 다시 묻는다. 시각이 `None` 이면
/// 알림만 기다린다. 상한 `max` 에 이르면 마지막으로 한 번 묻는다.
pub async fn on_or_at(
    cancel: &CancellationToken,
    max: Duration,
    mut changed: impl FnMut() -> Changed,
    mut cond: impl FnMut(Instant) -> (bool, Option<Instant>),
) -> Result<(), WaitError> {
    let deadline = Instant::now() + max;
    loop {
        let mut ch = changed();
        let (ok, next) = cond(Instant::now());
        if ok {
            return Ok(());
        }
        let wake = match next {
            Some(n) if n < deadline => n,
            _ => deadline,
        };
        tokio::select! {
            _ = cancel.cancelled() => return Err(WaitError::Canceled),
            _ = tokio::time::sleep_until(wake.into()) => {
                let now = Instant::now();
                if now >= deadline {
                    return if cond(now).0 { Ok(()) } else { Err(WaitError::Timeout) };
                }
            }
            _ = ch.wait() => {}
        }
    }
}

#[cfg(test)]
mod tests;
