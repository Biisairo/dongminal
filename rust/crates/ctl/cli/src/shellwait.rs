//! "셸이 무언가 그리고 조용해질 때까지" 기다리기 (OPTIMIZE_REFACTOR_SRS FR-OPT-9-2 · SHR-18).

use std::fmt;
use std::time::{Duration, Instant};

/// 출력이 오고 이만큼 조용하면 셸이 프롬프트를 그린 것으로 본다. 고정 대기는 대상마다 셸 기동
/// 시간이 달라 플레이크를 냈다 (FR-E2K-2). pwsh 는 PSReadLine 을 올리는 데 초 단위가 걸린다.
pub(crate) const SHELL_QUIET_FOR: Duration = Duration::from_millis(700);

/// `wait_quiet` 가 다시 보는 간격이다.
pub(crate) const SHELL_POLL: Duration = Duration::from_millis(100);

#[derive(Debug)]
pub(crate) enum QuietError<E> {
    /// limit 안에 아무 것도 그려지지 않았다.
    NothingDrawn,
    /// 그린 것은 있으나 limit 안에 조용해지지 않았다.
    NotQuiet,
    /// snapshot 이 낸 오류다.
    Snapshot(E),
}

impl<E: fmt::Display> fmt::Display for QuietError<E> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NothingDrawn => f.write_str("셸이 아무 것도 그리지 않았다"),
            Self::NotQuiet => f.write_str("셸 출력이 조용해지지 않았다"),
            Self::Snapshot(e) => e.fmt(f),
        }
    }
}

/// 무언가 그려지고(n>0) 마지막 변화 뒤 quiet 만큼 지날 때까지 기다린다. snapshot 의 변화 시각이
/// `None` 이면 아주 오래전(Go 의 영 시각)이다. snapshot 이 오류를 내면 그것을 돌려주며 멈춘다.
/// limit 을 넘기면 `NothingDrawn`·`NotQuiet` 이다 — 실패로 볼지는 호출자가 정한다.
pub(crate) fn wait_quiet<E>(
    snapshot: impl FnMut() -> Result<(usize, Option<Instant>), E>,
    limit: Duration,
    quiet: Duration,
) -> Result<(), QuietError<E>> {
    wait_quiet_every(snapshot, limit, quiet, SHELL_POLL)
}

pub(crate) fn wait_quiet_every<E>(
    mut snapshot: impl FnMut() -> Result<(usize, Option<Instant>), E>,
    limit: Duration,
    quiet: Duration,
    poll: Duration,
) -> Result<(), QuietError<E>> {
    let deadline = Instant::now() + limit;
    let mut drawn = false;
    loop {
        let (n, last) = snapshot().map_err(QuietError::Snapshot)?;
        if n > 0 {
            drawn = true;
            if last.is_none_or(|t| t.elapsed() >= quiet) {
                return Ok(());
            }
        }
        if Instant::now() >= deadline {
            return Err(if drawn {
                QuietError::NotQuiet
            } else {
                QuietError::NothingDrawn
            });
        }
        std::thread::sleep(poll);
    }
}

/// 폴링으로 얻은 화면의 마지막 변화 시각을 기억한다 — 스냅숏만 주는 출처를 `wait_quiet` 로 옮긴다.
#[derive(Default)]
pub(crate) struct ChangeTracker {
    last: Vec<u8>,
    at: Option<Instant>,
}

impl ChangeTracker {
    pub(crate) fn observe(&mut self, s: &[u8]) -> (usize, Option<Instant>) {
        if s != self.last.as_slice() {
            self.last = s.to_vec();
            self.at = Some(Instant::now());
        }
        (self.last.len(), self.at)
    }
}
