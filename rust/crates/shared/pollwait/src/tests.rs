use super::*;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};

fn ms(n: u64) -> Duration {
    Duration::from_millis(n)
}

// --- pollwait_test.go (M8 GO-12)

#[tokio::test]
async fn until_returns_immediately_when_condition_holds() {
    let start = Instant::now();
    let r = until(&CancellationToken::new(), Duration::from_secs(1), ms(100), || true).await;
    assert_eq!(r, Ok(()));
    assert!(start.elapsed() < ms(50));
}

#[tokio::test]
async fn until_times_out_without_sleeping_past_max() {
    let start = Instant::now();
    let r = until(&CancellationToken::new(), ms(30), Duration::from_secs(1), || false).await;
    assert_eq!(r, Err(WaitError::Timeout));
    assert!(start.elapsed() < ms(500));
}

#[tokio::test]
async fn until_stops_when_cancelled() {
    let cancel = CancellationToken::new();
    let polled = Arc::new(tokio::sync::Notify::new());
    let p2 = polled.clone();
    let c2 = cancel.clone();
    let task = tokio::spawn(async move {
        until(&c2, Duration::from_secs(60), Duration::from_secs(60), || {
            p2.notify_one();
            false
        })
        .await
    });
    polled.notified().await;
    let start = Instant::now();
    cancel.cancel();
    let r = tokio::time::timeout(Duration::from_secs(3), task)
        .await
        .expect("취소가 대기를 끊지 않았다")
        .unwrap();
    assert_eq!(r, Err(WaitError::Canceled));
    assert!(start.elapsed() < ms(500));
}

#[test]
fn error_messages_match_go() {
    assert_eq!(WaitError::Timeout.to_string(), "wait: timeout");
    assert_eq!(WaitError::Canceled.to_string(), "context canceled");
}

// --- signal_test.go (FR-OPT-8-4)

#[test]
fn signal_notify_wakes_all_waiters() {
    let s = Signal::default();
    let (a, b) = (s.c(), s.c());
    assert!(!a.fired());
    s.notify();
    assert!(a.fired() && b.fired(), "notify 가 기다리던 쪽을 깨우지 않았다");
    assert!(!s.c().fired(), "notify 뒤의 새 구독이 이미 울려 있다");
}

#[tokio::test]
async fn on_asks_only_on_signal() {
    let s = Arc::new(Signal::default());
    let asks = Arc::new(AtomicI64::new(0));
    let ready = Arc::new(AtomicBool::new(false));
    let (s2, a2, r2) = (s.clone(), asks.clone(), ready.clone());
    let task = tokio::spawn(async move {
        on(&CancellationToken::new(), Duration::from_secs(5), || s2.c(), || {
            a2.fetch_add(1, Ordering::SeqCst);
            r2.load(Ordering::SeqCst)
        })
        .await
    });
    let deadline = Instant::now() + Duration::from_secs(1);
    while asks.load(Ordering::SeqCst) < 1 && Instant::now() < deadline {
        tokio::time::sleep(ms(1)).await;
    }
    tokio::time::sleep(ms(300)).await;
    assert_eq!(asks.load(Ordering::SeqCst), 1, "알림 없이 물었다");
    ready.store(true, Ordering::SeqCst);
    s.notify();
    let r = tokio::time::timeout(Duration::from_secs(1), task)
        .await
        .expect("알림에 깨어나지 않았다")
        .unwrap();
    assert_eq!(r, Ok(()));
}

#[tokio::test]
async fn on_timeout_and_cancel() {
    let s = Signal::default();
    let r = on(&CancellationToken::new(), ms(20), || s.c(), || false).await;
    assert_eq!(r, Err(WaitError::Timeout));
    let cancel = CancellationToken::new();
    cancel.cancel();
    let r = on(&cancel, Duration::from_secs(1), || s.c(), || false).await;
    assert_eq!(r, Err(WaitError::Canceled));
}

// FR-OPT-16-3

#[tokio::test]
async fn on_or_at_asks_only_on_signal_or_at_next() {
    let s = Arc::new(Signal::default());
    let asks = Arc::new(AtomicI64::new(0));
    let ready = Arc::new(AtomicBool::new(false));
    let wake = Instant::now() + ms(150);
    let (s2, a2, r2) = (s.clone(), asks.clone(), ready.clone());
    let task = tokio::spawn(async move {
        on_or_at(&CancellationToken::new(), Duration::from_secs(5), || s2.c(), |_| {
            let n = a2.fetch_add(1, Ordering::SeqCst) + 1;
            if r2.load(Ordering::SeqCst) {
                return (true, None);
            }
            if n == 1 { (false, Some(wake)) } else { (false, None) }
        })
        .await
    });
    tokio::time::sleep(ms(500)).await;
    assert_eq!(asks.load(Ordering::SeqCst), 2, "첫 물음 + 말한 시각의 물음 = 2");
    ready.store(true, Ordering::SeqCst);
    s.notify();
    let r = tokio::time::timeout(Duration::from_secs(1), task)
        .await
        .expect("알림에 깨어나지 않았다")
        .unwrap();
    assert_eq!(r, Ok(()));
    assert_eq!(asks.load(Ordering::SeqCst), 3);
}

#[tokio::test]
async fn on_or_at_next_past_max_times_out_at_max_with_final_ask() {
    let s = Signal::default();
    let asks = AtomicI64::new(0);
    let start = Instant::now();
    let r = on_or_at(&CancellationToken::new(), ms(60), || s.c(), |now| {
        asks.fetch_add(1, Ordering::SeqCst);
        (false, Some(now + Duration::from_secs(3600)))
    })
    .await;
    assert_eq!(r, Err(WaitError::Timeout));
    assert!(start.elapsed() < ms(500));
    assert_eq!(asks.load(Ordering::SeqCst), 2, "첫 물음 + 상한의 마지막 물음 = 2");
}

#[tokio::test]
async fn on_or_at_settles_on_final_ask_at_max() {
    let s = Signal::default();
    let asks = AtomicI64::new(0);
    let r = on_or_at(&CancellationToken::new(), ms(30), || s.c(), |_| {
        (asks.fetch_add(1, Ordering::SeqCst) + 1 == 2, None)
    })
    .await;
    assert_eq!(r, Ok(()), "상한에서의 마지막 물음이 참이면 성공이어야 한다");
}

#[tokio::test]
async fn on_or_at_cancel() {
    let s = Signal::default();
    let cancel = CancellationToken::new();
    cancel.cancel();
    let r = on_or_at(&cancel, Duration::from_secs(1), || s.c(), |_| (false, None)).await;
    assert_eq!(r, Err(WaitError::Canceled));
}
