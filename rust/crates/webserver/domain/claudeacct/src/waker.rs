//! Engine·Auto 의 Run 이 함께 쓰는 깨우기 신호와 회차 루프 (REFACTOR3_DEDUP_GO_SRS FR-RDG-62).
//! 둘이 다른 것은 tick 과 기다림의 하한뿐이다.

use std::future::Future;
use std::sync::{Mutex, PoisonError};
use std::time::Duration;

use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

#[derive(Debug, Default)]
pub(crate) struct Waker {
    tx: Mutex<Option<mpsc::Sender<()>>>,
}

impl Waker {
    /// 기다리던 루프를 바로 깨운다. 루프가 아직 서지 않았으면 아무 일도 없다.
    pub(crate) fn wake(&self) {
        let tx = self
            .tx
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        if let Some(tx) = tx {
            let _ = tx.try_send(());
        }
    }

    /// stop 이 끊길 때까지 tick 을 부르고, 그것이 준 시간(floor 보다 짧으면 floor)만큼
    /// 기다린다. 기다리는 중 wake 가 오면 곧바로 다음 회차다. tick 이 받는 토큰은 stop 이
    /// 끊기면 함께 끊긴다.
    pub(crate) async fn run<F, Fut>(&self, stop: CancellationToken, floor: Duration, mut tick: F)
    where
        F: FnMut(CancellationToken) -> Fut,
        Fut: Future<Output = Duration>,
    {
        let (tx, mut rx) = mpsc::channel::<()>(1);
        *self.tx.lock().unwrap_or_else(PoisonError::into_inner) = Some(tx);
        loop {
            let d = tick(stop.child_token()).await.max(floor);
            tokio::select! {
                _ = stop.cancelled() => return,
                _ = rx.recv() => {}
                _ = tokio::time::sleep(d) => {}
            }
        }
    }
}
