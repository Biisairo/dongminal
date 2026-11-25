//! 전경 이름 사건 기반 조회 (PERF 4.6, 설계 §1 D1·Q3). 시계는 tokio 가짜 시계다.

use std::sync::Mutex as StdMutex;
use std::sync::atomic::AtomicI32;

use otter_shared_cadence::FOREGROUND_SETTLE;
use tokio::time::sleep;

use super::tests::{FakeInfo, fg_tool, leak, written_tool};
use super::*;

const MS: Duration = Duration::from_millis(1);
const MINUTE: Duration = Duration::from_secs(60);

/// 가짜 시계를 `d` 만큼 보낸다. 조회는 blocking 스레드에서 돌므로, 그동안 시계는 서 있다.
async fn pass(d: Duration) {
    sleep(d).await;
    for _ in 0..4 {
        sleep(MS).await;
    }
}

/// 도구 `ids` 를 등록하고 조회 수를 세는 probe 를 건 등록부와 그 위에서 도는 정착 작업이다.
fn probing(
    ids: &[&str],
) -> (
    ToolManager,
    Vec<Arc<Tool>>,
    Arc<AtomicI32>,
    CancellationToken,
) {
    let m = ToolManager::with_proc_info("", None, leak(FakeInfo::default()));
    let tools: Vec<Arc<Tool>> = ids
        .iter()
        .map(|id| {
            let (p, _) = written_tool(id);
            m.adopt(Arc::clone(&p));
            p
        })
        .collect();
    let calls = Arc::new(AtomicI32::new(0));
    let c = Arc::clone(&calls);
    m.set_foreground_probe(Some(Arc::new(move |ids: &[String]| {
        c.fetch_add(1, SeqCst);
        ids.iter().map(|i| (i.clone(), "vim".to_owned())).collect()
    })));
    let cancel = CancellationToken::new();
    m.spawn_foreground_refresh(cancel.clone());
    (m, tools, calls, cancel)
}

#[tokio::test(start_paused = true)]
async fn quiet_tools_never_probe_foreground() {
    let (_m, _t, calls, cancel) = probing(&["a", "b"]);
    pass(MINUTE).await;
    assert_eq!(calls.load(SeqCst), 0, "입출력이 없는데 전경을 조회했다");
    cancel.cancel();
}

#[tokio::test(start_paused = true)]
async fn output_then_settle_probes_once() {
    let (m, t, calls, cancel) = probing(&["a"]);
    t[0].handle_chunk(b"prompt$ ");
    pass(FOREGROUND_SETTLE - 10 * MS).await;
    assert_eq!(calls.load(SeqCst), 0, "정착 창 전에 조회했다");
    pass(10 * MS).await;
    assert_eq!(calls.load(SeqCst), 1, "정착 창 뒤 조회하지 않았다");
    assert_eq!(
        m.cached_foreground_names().get("a").map(String::as_str),
        Some("vim")
    );
    pass(MINUTE).await;
    assert_eq!(calls.load(SeqCst), 1, "입출력 없이 다시 조회했다");
    m.write("a", b"ls\r").unwrap();
    pass(FOREGROUND_SETTLE).await;
    assert_eq!(
        calls.load(SeqCst),
        2,
        "입력 뒤 정착 창이 지나도 조회하지 않았다"
    );
    pass(MINUTE).await;
    assert_eq!(calls.load(SeqCst), 2);
    cancel.cancel();
}

#[tokio::test(start_paused = true)]
async fn continuous_output_probes_at_most_once_per_window() {
    let (_m, t, calls, cancel) = probing(&["a"]);
    let span = FOREGROUND_SETTLE * 5;
    let step = Duration::from_millis(100);
    let mut spent = Duration::ZERO;
    while spent < span {
        t[0].handle_chunk(b"x");
        sleep(step).await;
        spent += step;
    }
    let during = calls.load(SeqCst);
    assert!(during >= 1, "계속 출력하는 동안 한 번도 조회하지 않았다");
    assert!(during <= 5, "창 하나에 두 번 이상 조회했다: {during}");
    pass(MINUTE).await;
    let after = calls.load(SeqCst);
    assert!(
        after <= during + 1,
        "출력이 멎은 뒤 여러 번 조회했다: {during} → {after}"
    );
    cancel.cancel();
}

#[tokio::test(start_paused = true)]
async fn unchanged_pgid_skips_name_lookup() {
    let info = leak(FakeInfo::named(&[(500, "vim"), (600, "node")]));
    let m = ToolManager::with_proc_info("", None, info);
    let fg = Arc::new(StdMutex::new(Some(500)));
    let p = fg_tool("a", 1001, &fg);
    m.adopt(Arc::clone(&p));
    let cancel = CancellationToken::new();
    m.spawn_foreground_refresh(cancel.clone());
    for _ in 0..3 {
        p.handle_chunk(b"frame");
        pass(FOREGROUND_SETTLE).await;
    }
    assert_eq!(
        info.names_calls.load(SeqCst),
        1,
        "pgid 가 같은데 이름을 다시 조회했다"
    );
    assert_eq!(
        m.cached_foreground_names().get("a").map(String::as_str),
        Some("vim")
    );
    *fg.lock().unwrap() = Some(600);
    p.handle_chunk(b"frame");
    pass(FOREGROUND_SETTLE).await;
    assert_eq!(
        info.names_calls.load(SeqCst),
        2,
        "pgid 가 바뀌었는데 이름을 조회하지 않았다"
    );
    assert_eq!(
        m.cached_foreground_names().get("a").map(String::as_str),
        Some("node")
    );
    cancel.cancel();
}
