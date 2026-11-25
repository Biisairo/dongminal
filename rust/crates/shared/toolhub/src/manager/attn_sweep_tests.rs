//! L2 유휴 판정 sweeper (PERF 4.8, 설계 §1 D2). 시계는 tokio 가짜 시계다.

use tokio::time::sleep;

use super::tests::{FakeInfo, leak};
use super::*;

const SEC: Duration = Duration::from_secs(1);
const HOUR: Duration = Duration::from_secs(60 * 60);
const MS: Duration = Duration::from_millis(1);

/// 임계 `idle` 의 등록부와 도구 하나, 그 위에서 도는 sweeper 다. 시계는 가짜 시계를 따른다.
fn sweeping(idle: Duration) -> (ToolManager, Arc<Tool>, CancellationToken, ClockFn) {
    let m = ToolManager::with_proc_info("", None, leak(FakeInfo::default()));
    m.set_attention_config(idle, false);
    let base = attn_now();
    let t0 = tokio::time::Instant::now();
    let now: ClockFn =
        Arc::new(move || base + i64::try_from(t0.elapsed().as_nanos()).unwrap_or(i64::MAX));
    m.set_attn_clock(Arc::clone(&now));
    let p = m.adopt_detached("a");
    let cancel = CancellationToken::new();
    m.spawn_attention_sweeper(cancel.clone());
    (m, p, cancel, now)
}

/// 가짜 시계를 `d` 만큼 보낸다. 판정은 blocking 스레드에서 돌므로, 그동안 시계는 서 있다.
async fn pass(d: Duration) {
    sleep(d).await;
    for _ in 0..4 {
        sleep(MS).await;
    }
}

fn armed(p: &Tool) -> bool {
    p.agent_state().armed
}

#[tokio::test(start_paused = true)]
async fn attention_sweeper_threshold_zero_never_wakes() {
    let (m, p, cancel, now) = sweeping(Duration::ZERO);
    pass(HOUR).await;
    assert_eq!(m.attn_wakes(), 0, "출력 없이 깨어났다");
    p.observe_output_at(b"x", now());
    assert!(armed(&p));
    pass(HOUR).await;
    assert_eq!(m.attn_wakes(), 0, "임계 0 인데 깨어났다");
    assert!(armed(&p), "임계 0 인데 판정했다");
    cancel.cancel();
}

#[tokio::test(start_paused = true)]
async fn idle_deadline_fires_once() {
    let (m, p, cancel, now) = sweeping(SEC);
    pass(HOUR).await;
    let quiet = m.attn_wakes();
    assert!(quiet <= 1, "출력 없이 {quiet}번 깨어났다");
    p.observe_output_at(b"x", now());
    pass(SEC - 100 * MS).await;
    assert!(armed(&p), "마감 전에 판정했다");
    pass(200 * MS).await;
    assert!(!armed(&p), "마감에 판정하지 않았다");
    let wakes = m.attn_wakes();
    assert!(
        wakes - quiet <= 2,
        "출력 하나에 {}번 깨어났다",
        wakes - quiet
    );
    pass(HOUR).await;
    assert_eq!(m.attn_wakes(), wakes, "판정 뒤 깨어났다");
    cancel.cancel();
}

#[tokio::test(start_paused = true)]
async fn output_before_deadline_postpones() {
    let (_m, p, cancel, now) = sweeping(SEC);
    p.observe_output_at(b"x", now());
    pass(800 * MS).await;
    p.observe_output_at(b"y", now());
    pass(400 * MS).await;
    assert!(armed(&p), "마지막 출력에서 임계가 지나지 않았는데 판정했다");
    pass(700 * MS).await;
    assert!(!armed(&p), "미룬 마감에 판정하지 않았다");
    cancel.cancel();
}

#[tokio::test(start_paused = true)]
async fn threshold_set_later_judges_armed_tool() {
    let (m, p, cancel, now) = sweeping(Duration::ZERO);
    p.observe_output_at(b"x", now());
    pass(HOUR).await;
    assert!(armed(&p));
    m.set_attention_config(SEC, false);
    pass(10 * MS).await;
    assert!(!armed(&p), "임계를 켠 뒤 지난 마감을 판정하지 않았다");
    cancel.cancel();
}
