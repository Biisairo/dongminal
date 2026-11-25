//! 유휴 비우기 compactor (PERF 4.1.3, D-50·D-53, 설계 §5). 시계는 tokio 가짜 시계다.

use otter_shared_termlimit::SCREEN_IDLE_COMPACT;
use otter_shared_termstate::Screen;
use tokio::time::sleep;

use super::tests::{FakeInfo, leak, written_tool};
use super::*;
use crate::search::Query;

const SEC: Duration = Duration::from_secs(1);
const HOUR: Duration = Duration::from_secs(60 * 60);

fn numbered(from: usize, n: usize) -> Vec<u8> {
    (from..from + n)
        .map(|i| format!("\x1b[3{}mL{i:05}\x1b[0m tail\r\n", i % 7 + 1))
        .collect::<String>()
        .into_bytes()
}

/// 도구 `id` 를 등록한 등록부와 그 위에서 도는 compactor 다.
fn compacting(ids: &[&str]) -> (ToolManager, Vec<Arc<Tool>>, CancellationToken) {
    let m = ToolManager::with_proc_info("", None, leak(FakeInfo::default()));
    let tools: Vec<Arc<Tool>> = ids
        .iter()
        .map(|id| {
            let (p, _) = written_tool(id);
            m.adopt(Arc::clone(&p));
            p
        })
        .collect();
    let cancel = CancellationToken::new();
    m.spawn_screen_compactor(cancel.clone());
    (m, tools, cancel)
}

fn history_len(p: &Tool) -> usize {
    p.with_screen(|s, _| s.history_len()).unwrap()
}

/// 가짜 시계를 `d` 만큼 보낸다. 비우기는 blocking 스레드에서 돌므로, 그동안 시계는 서 있다.
async fn pass(d: Duration) {
    sleep(d).await;
    for _ in 0..4 {
        sleep(Duration::from_millis(1)).await;
    }
}

#[tokio::test(start_paused = true)]
async fn compacts_once_after_idle_and_then_sleeps() {
    let (m, t, cancel) = compacting(&["a"]);
    t[0].handle_chunk(&numbered(0, 3_000));
    assert!(history_len(&t[0]) > 0);
    pass(SCREEN_IDLE_COMPACT - SEC).await;
    assert!(history_len(&t[0]) > 0, "5분 전에 비웠다");
    pass(2 * SEC).await;
    assert_eq!(history_len(&t[0]), 0, "5분 뒤 비우지 않았다");
    let wakes = m.compact_wakes();
    pass(HOUR).await;
    assert_eq!(m.compact_wakes(), wakes, "비운 뒤 깨어났다");
    assert_eq!(history_len(&t[0]), 0);
    cancel.cancel();
}

#[tokio::test(start_paused = true)]
async fn output_before_deadline_postpones() {
    let (_m, t, cancel) = compacting(&["a"]);
    t[0].handle_chunk(&numbered(0, 3_000));
    pass(SCREEN_IDLE_COMPACT - SEC).await;
    t[0].handle_chunk(&numbered(3_000, 1));
    pass(2 * SEC).await;
    assert!(
        history_len(&t[0]) > 0,
        "마지막 출력에서 5분이 지나지 않았는데 비웠다"
    );
    pass(SCREEN_IDLE_COMPACT - 3 * SEC).await;
    assert!(history_len(&t[0]) > 0);
    pass(2 * SEC).await;
    assert_eq!(history_len(&t[0]), 0, "미룬 시각에 비우지 않았다");
    cancel.cancel();
}

#[tokio::test(start_paused = true)]
async fn clean_tools_never_wake_the_compactor() {
    let (m, t, cancel) = compacting(&["a", "b"]);
    pass(HOUR).await;
    assert_eq!(m.compact_wakes(), 0);
    t[0].handle_chunk(&numbered(0, 3_000));
    pass(SCREEN_IDLE_COMPACT + SEC).await;
    assert_eq!(history_len(&t[0]), 0);
    let wakes = m.compact_wakes();
    assert!(wakes > 0);
    pass(HOUR).await;
    assert_eq!(m.compact_wakes(), wakes);
    cancel.cancel();
}

#[tokio::test(start_paused = true)]
async fn each_tool_compacts_on_its_own_deadline() {
    let (_m, t, cancel) = compacting(&["a", "b"]);
    t[0].handle_chunk(&numbered(0, 3_000));
    pass(2 * 60 * SEC).await;
    t[1].handle_chunk(&numbered(0, 3_000));
    pass(3 * 60 * SEC + SEC).await;
    assert_eq!(history_len(&t[0]), 0);
    assert!(history_len(&t[1]) > 0);
    pass(2 * 60 * SEC).await;
    assert_eq!(history_len(&t[1]), 0);
    cancel.cancel();
}

#[tokio::test(start_paused = true)]
async fn resize_counts_as_activity() {
    let (_m, t, cancel) = compacting(&["a"]);
    t[0].handle_chunk(&numbered(0, 3_000));
    pass(SCREEN_IDLE_COMPACT + SEC).await;
    assert_eq!(history_len(&t[0]), 0);
    t[0].handle_chunk(&numbered(3_000, 3_000));
    pass(SCREEN_IDLE_COMPACT - SEC).await;
    t[0].resize(100, 30).unwrap();
    t[0].handle_chunk(&numbered(6_000, 3_000));
    assert!(history_len(&t[0]) > 0);
    pass(SCREEN_IDLE_COMPACT + SEC).await;
    assert_eq!(history_len(&t[0]), 0);
    cancel.cancel();
}

/// 인계로 받은 도구는 기록이 에뮬레이터에 든 채 시작한다 — 받자마자 dirty 다.
#[tokio::test(start_paused = true)]
async fn adopted_screen_starts_dirty() {
    let (src, _) = written_tool("src");
    src.handle_chunk(&numbered(0, 3_000));
    let h = src.screen_handover().unwrap();
    let ring = src.stream().unwrap().snapshot().0;

    let m = ToolManager::with_proc_info("", None, leak(FakeInfo::default()));
    let cancel = CancellationToken::new();
    m.spawn_screen_compactor(cancel.clone());
    let (p, _) = written_tool("dst");
    p.adopt_screen(&ring, &h.snapshot, h.back, &h.store, HISTORY_CAP);
    m.adopt(Arc::clone(&p));
    assert!(history_len(&p) > 0);
    pass(SCREEN_IDLE_COMPACT + SEC).await;
    assert_eq!(history_len(&p), 0, "인계 받은 도구를 비우지 않았다");
    cancel.cancel();
}

/// 비우기 앞뒤로 깨움 스냅숏·read-screen·위로 받기·이전 기록 찾기가 같은 결과를 낸다.
#[tokio::test(start_paused = true)]
async fn compaction_keeps_screen_history_search_and_text() {
    let (m, t, cancel) = compacting(&["a"]);
    let p = &t[0];
    p.handle_chunk(&numbered(0, 3_000));
    p.handle_chunk("한글 넓은 글자 \x1b]8;;http://x\x07link\x1b]8;;\x07 끝\r\n$ ".as_bytes());

    let replay = |m: &ToolManager| {
        let s = m.screen_tool("a", 5_000).unwrap();
        let mut b = Screen::new(s.cols, s.rows, HISTORY_CAP);
        b.feed(&s.data);
        let store = b.store();
        let (_, older) = store.lines(store.first(), usize::try_from(store.end()).unwrap());
        let older: Vec<String> = older.iter().map(|l| l.to_ansi()).collect();
        (b.text(0), older, s.end, s.cols, s.rows, s.alt)
    };
    let q = Query::new("L0", false, true, false).unwrap();
    let (end0, emu_rows) = p
        .with_screen(|s, _| {
            let hl = i32::try_from(s.history_len()).unwrap();
            let rows: Vec<String> = (-hl..0)
                .map(|y| {
                    let r = s.row(y).unwrap();
                    let t: String = r.cells.iter().map(|c| c.text.as_str()).collect();
                    t.trim_end().to_string()
                })
                .collect();
            (s.store().end(), rows)
        })
        .unwrap();
    assert!(!emu_rows.is_empty());
    let before = (
        replay(&m),
        m.screen_text_tool("a", 0),
        m.history_tool("a", end0, 700),
        m.search_tool("a", &q, end0, 50),
    );

    pass(SCREEN_IDLE_COMPACT + SEC).await;
    assert_eq!(history_len(p), 0);

    let after = (
        replay(&m),
        m.screen_text_tool("a", 0),
        m.history_tool("a", end0, 700),
        m.search_tool("a", &q, end0, 50),
    );
    assert_eq!(before.0, after.0, "깨움 스냅숏");
    assert_eq!(before.1, after.1, "read-screen");
    assert_eq!(before.2, after.2, "위로 받기");
    assert_eq!(before.3, after.3, "이전 기록 찾기");

    // 옮긴 행은 저장소의 옛 끝에서 이어진다.
    let end1 = p.with_screen(|s, _| s.store().end()).unwrap();
    let moved = m
        .history_tool("a", end1, usize::try_from(end1 - end0).unwrap())
        .unwrap();
    assert_eq!(moved.from, end0);
    let plain: Vec<String> = moved
        .lines
        .iter()
        .map(|l| {
            let mut s = Screen::new(200, 2, 10);
            s.feed(l.as_bytes());
            s.text(0).trim_end().to_string()
        })
        .collect();
    assert_eq!(plain, emu_rows);
    cancel.cancel();
}
