//! Go 기준선 `dongminal/internal/shared/fanout` 의 Rust 포팅.
//!
//! 상한 있는 병렬 반복 한 벌이다 (FR-OPT-7-4). git 핀 관측·핀 목록 조립·감시 회차가
//! 같은 규칙을 쓴다.

use futures_util::StreamExt;
use futures_util::stream::FuturesUnordered;
pub use tokio_util::sync::CancellationToken;

/// `i ∈ [0, n)` 마다 `f(i)` 를 돌리되 동시에 도는 것은 `limit` 개까지다.
///
/// 취소되면 **남은 것을 시작하지 않는다.** 이미 시작한 것은 끝까지 기다린다 — 반환
/// 뒤에 `f` 의 future 가 도는 일은 없다. `limit` 이 1 보다 작으면 1 이다.
///
/// future 들은 이 호출의 task 안에서 함께 돈다(goroutine 처럼 스레드를 나누지 않는다).
/// CPU 를 오래 쓰는 일은 `f` 안에서 `spawn_blocking` 으로 넘긴다.
pub async fn each<F, Fut>(cancel: &CancellationToken, limit: usize, n: usize, mut f: F)
where
    F: FnMut(usize) -> Fut,
    Fut: Future<Output = ()>,
{
    let limit = limit.max(1);
    let mut running = FuturesUnordered::new();
    for i in 0..n {
        // 자리를 얻은 **뒤에** 본다 — 자리를 기다리는 동안의 취소도 잡는다.
        while running.len() >= limit {
            running.next().await;
        }
        if cancel.is_cancelled() {
            break;
        }
        running.push(f(i));
    }
    while running.next().await.is_some() {}
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicI32, Ordering};
    use std::time::Duration;

    #[tokio::test]
    async fn all_once_within_limit() {
        const N: usize = 50;
        const LIMIT: usize = 3;
        let cur = Arc::new(AtomicI32::new(0));
        let peak = Arc::new(AtomicI32::new(0));
        let seen: Arc<Vec<AtomicI32>> = Arc::new((0..N).map(|_| AtomicI32::new(0)).collect());
        each(&CancellationToken::new(), LIMIT, N, |i| {
            let (cur, peak, seen) = (cur.clone(), peak.clone(), seen.clone());
            async move {
                let c = cur.fetch_add(1, Ordering::SeqCst) + 1;
                peak.fetch_max(c, Ordering::SeqCst);
                tokio::time::sleep(Duration::from_millis(1)).await;
                seen[i].fetch_add(1, Ordering::SeqCst);
                cur.fetch_sub(1, Ordering::SeqCst);
            }
        })
        .await;
        for (i, v) in seen.iter().enumerate() {
            assert_eq!(v.load(Ordering::SeqCst), 1, "seen[{i}]");
        }
        let p = peak.load(Ordering::SeqCst);
        assert!(p <= LIMIT as i32, "동시 {p} > 상한 {LIMIT}");
        assert!(p > 1, "병렬로 돌지 않았다");
    }

    #[tokio::test]
    async fn stops_launching_on_cancel() {
        let cancel = CancellationToken::new();
        let calls = AtomicI32::new(0);
        each(&cancel, 1, 10, |i| {
            calls.fetch_add(1, Ordering::SeqCst);
            if i == 2 {
                cancel.cancel();
            }
            async {}
        })
        .await;
        assert_eq!(calls.load(Ordering::SeqCst), 3);
        each(&cancel, 4, 10, |_| -> std::future::Ready<()> { panic!("끝난 취소로 시작했다") }).await;
    }

    #[tokio::test]
    async fn zero_limit_reads_as_one() {
        let calls = AtomicI32::new(0);
        each(&CancellationToken::new(), 0, 3, |_| {
            calls.fetch_add(1, Ordering::SeqCst);
            async {}
        })
        .await;
        assert_eq!(calls.load(Ordering::SeqCst), 3);
    }
}
