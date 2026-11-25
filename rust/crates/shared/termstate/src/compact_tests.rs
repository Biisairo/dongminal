//! 에뮬레이터 기록 상한(A)·옮겨 비우기(compact)·크기 바꾸기 정리(R) 시험 (M4_MEMORY_DESIGN §2·§3·§4).

use otter_shared_termlimit::emu_keep;

use super::*;
use crate::snap_tests::{
    HIST, check_handover_with, check_points_with, corpus, first_diff, norm, sampled,
};

/// 4.1.1 까지 데몬이 쓰던 에뮬레이터 기록 줄 수다. 옛 데몬이 넘긴 화면을 받는 시험에 쓴다.
const OLD_EMU_KEEP: usize = 1_000;

fn lines(from: usize, n: usize) -> Vec<u8> {
    (from..from + n)
        .flat_map(|i| format!("L{i:02}\r\n").into_bytes())
        .collect()
}

fn store_texts(s: &Screen) -> Vec<String> {
    let st = s.store();
    st.lines(st.first(), st.len())
        .1
        .iter()
        .map(|l| l.text().trim_end().to_string())
        .collect()
}

/// 색·링크·넓은 글자·자동 줄바꿈이 섞인 줄이다.
fn styled(n: usize) -> Vec<u8> {
    let mut data = Vec::new();
    for i in 0..n {
        data.extend_from_slice(format!("\x1b[3{}mline {i} ", i % 8).as_bytes());
        data.extend(std::iter::repeat_n(b'x', i % 23));
        data.extend_from_slice("\x1b]8;;http://e\x1b\\한\x1b]8;;\x1b\\\x1b[0m\r\n".as_bytes());
    }
    data
}

/// 넓은 글자가 행 끝에 걸치는 긴 줄이다.
fn wide_wrapped(n: usize) -> Vec<u8> {
    let mut data = Vec::new();
    for i in 0..n {
        data.extend_from_slice(format!("w{i} ").as_bytes());
        data.extend_from_slice("가나다라마바사".repeat(1 + i % 4).as_bytes());
        data.extend_from_slice(b"\r\n");
    }
    data
}

// ── A: 기록 상한 ──

#[test]
fn history_keeps_emu_keep_rows() {
    for (cols, rows) in [(80, 24), (120, 40), (200, 50)] {
        let mut s = Screen::new(cols, rows, HIST);
        s.feed(&lines(0, 3_000));
        assert_eq!(s.history_len(), emu_keep(rows), "{cols}x{rows}");
    }
}

#[test]
fn keep_follows_resize() {
    let mut s = Screen::new(120, 40, HIST);
    s.feed(&lines(0, 3_000));
    s.resize(80, 24);
    s.feed(&lines(3_000, 3_000));
    assert_eq!(s.history_len(), emu_keep(24));
    s.resize(200, 50);
    s.feed(&lines(6_000, 3_000));
    assert_eq!(s.history_len(), emu_keep(50));
}

/// 좁히면 재흐름으로 기록 행이 늘어난다. 상한을 넘는 행을 버리지 않고 저장소로 옮긴다.
#[test]
fn narrowing_keeps_all_history() {
    let mut s = Screen::new(120, 40, HIST);
    let data: Vec<u8> = (0..2_000)
        .flat_map(|i| format!("{i:05}{}\r\n", "x".repeat(95)).into_bytes())
        .collect();
    s.feed(&data);
    let before = s.text(0);
    s.resize(20, 40);
    assert_eq!(s.text(0), before);
    s.resize(7, 30);
    assert_eq!(s.text(0), before);
}

// ── compact ──

#[test]
fn compact_moves_history_to_store_in_order() {
    let mut s = Screen::with_keep(10, 5, Some(20), 1_000);
    s.feed(&lines(0, 100));
    let text = s.text(0);
    assert_eq!(s.history_len(), 20);
    s.compact();
    assert_eq!(s.history_len(), 0);
    let want: Vec<String> = (0..96).map(|i| format!("L{i:02}")).collect();
    assert_eq!(store_texts(&s), want);
    assert_eq!((s.store().first(), s.store().end()), (0, 96));
    assert_eq!(s.text(0), text);
    s.compact();
    assert_eq!((s.history_len(), s.store().end()), (0, 96));
}

/// 화면 첫 행으로 이어지는 논리 줄의 기록 쪽 행은 남긴다(Q5).
#[test]
fn compact_keeps_tail_wrapped_into_the_screen() {
    let mut s = Screen::with_keep(10, 3, Some(50), 1_000);
    s.feed(format!("{}{}", "x\r\n".repeat(5), "a".repeat(45)).as_bytes());
    assert_eq!(s.history_len(), 7);
    let text = s.text(0);
    s.compact();
    assert_eq!(s.history_len(), 2);
    assert_eq!(store_texts(&s), vec!["x"; 5]);
    assert_eq!(s.text(0), text);
}

#[test]
fn compact_in_alt_screen_does_nothing() {
    let mut s = Screen::with_keep(10, 5, Some(20), 1_000);
    s.feed(&lines(0, 40));
    s.feed(b"\x1b[?1049h\x1b[2Jalt");
    let st = norm(s.state(HIST));
    let store = (s.store().first(), s.store().end());
    s.compact();
    assert_eq!(norm(s.state(HIST)), st);
    assert_eq!((s.store().first(), s.store().end()), store);
    s.feed(b"\x1b[?1049l");
    assert_eq!(s.history_len(), 20);
}

/// 이름·자료·크기·keep 덮어쓰기.
type Case = (&'static str, Vec<u8>, (u16, u16), Option<usize>);

/// 비우기 앞뒤의 스냅숏(모든 기록)·글자·화면 상태가 같다.
#[test]
fn compact_keeps_snapshot_text_and_rows() {
    let cases: [Case; 6] = [
        ("sim-line", corpus("sim-line.bin"), (120, 40), None),
        ("sim-tui", corpus("sim-tui.bin"), (120, 40), None),
        ("styled", styled(80), (12, 6), Some(5)),
        ("styled keep", styled(80), (12, 6), None),
        ("wide", wide_wrapped(60), (9, 5), Some(4)),
        ("wrap", corpus("wrap.bin"), (40, 10), Some(3)),
    ];
    for (name, data, (cols, rows), keep) in cases {
        let mut a = Screen::with_keep(cols, rows, keep, HIST);
        a.feed(&data);
        let st = norm(a.state(HIST));
        let text = a.text(0);
        let snap = a.snapshot(HIST);
        let rows_before: Vec<Option<Row>> = (0..i32::from(rows)).map(|y| a.row(y)).collect();
        a.compact();
        let after = norm(a.state(HIST));
        assert!(st == after, "{name}: {}", first_diff(&st, &after));
        assert_eq!(a.text(0), text, "{name}");
        let rows_after: Vec<Option<Row>> = (0..i32::from(rows)).map(|y| a.row(y)).collect();
        assert_eq!(rows_after, rows_before, "{name}");
        // 비운 뒤 스냅숏을 받은 쪽은 비우기 전 스냅숏을 받은 쪽과 같다.
        let fed = |bytes: &[u8]| {
            let mut b = Screen::with_keep(cols, rows, keep, HIST);
            b.feed(bytes);
            norm(b.state(HIST))
        };
        let (x, y) = (fed(&snap.bytes), fed(&a.snapshot(HIST).bytes));
        assert!(x == y, "{name}: {}", first_diff(&x, &y));
    }
}

/// 모든 분할점에서 비우고 스냅숏을 만든다. 비운 뒤 이어 넣어도 비우지 않은 것과 같다.
#[test]
fn compact_at_every_split() {
    let run = |data: &[u8], (cols, rows): (u16, u16), keep: Option<usize>| {
        check_points_with(
            &|| Screen::with_keep(cols, rows, keep, HIST),
            keep,
            data,
            0..=data.len(),
            true,
        );
    };
    run(&styled(60), (12, 6), Some(5));
    run(&wide_wrapped(30), (9, 5), Some(4));
    run(&corpus("vectors.bin"), (80, 24), None);
    run(&corpus("wrap.bin"), (40, 10), Some(3));
    run(&corpus("alt-roundtrip.bin"), (80, 24), None);
}

#[test]
fn compact_at_sampled_splits_of_agent_sim() {
    let line = corpus("sim-line.bin");
    check_points_with(
        &|| Screen::new(120, 40, HIST),
        None,
        &line,
        sampled(line.len(), 40, 11),
        true,
    );
    let tui = corpus("sim-tui.bin");
    check_points_with(
        &|| Screen::new(120, 40, HIST),
        None,
        &tui,
        sampled(tui.len(), 40, 12),
        true,
    );
}

/// 비운 뒤 다시 출력이 오면 평소대로 기록이 쌓이고 넘는 줄은 저장소로 간다.
#[test]
fn output_after_compact_continues() {
    let mut s = Screen::new(80, 24, HIST);
    s.feed(&lines(0, 3_000));
    s.compact();
    s.feed(&lines(3_000, 3_000));
    assert_eq!(s.history_len(), emu_keep(24));
    let want: String = (0..6_000).map(|i| format!("L{i:02}\n")).collect();
    assert_eq!(s.text(0), want);
}

// ── 데몬 교체 ──

/// keep 1,000 으로 돌던 옛 데몬이 넘긴 화면을 받는다. 받은 뒤 기록은 새 상한으로 줄어든다.
#[test]
fn restore_accepts_handover_from_old_keep() {
    let line = corpus("sim-line.bin");
    check_handover_with(
        &line,
        (120, 40),
        (Some(OLD_EMU_KEEP), None),
        false,
        sampled(line.len(), 6, 21),
    );
    let mut a = Screen::with_keep(120, 40, Some(OLD_EMU_KEEP), HIST);
    a.feed(&lines(0, 3_000));
    assert_eq!(a.history_len(), OLD_EMU_KEEP);
    let h = a.handover();
    let b = Screen::restore(120, 40, HIST, &h.snapshot, &h.store);
    assert_eq!(b.history_len(), emu_keep(40));
    assert_eq!(b.text(0), a.text(0));
}

#[test]
fn handover_after_compact_round_trips() {
    let data = styled(80);
    check_handover_with(
        &data,
        (12, 6),
        (Some(5), Some(5)),
        true,
        (0..data.len()).step_by(3).chain([data.len()]),
    );
    let line = corpus("sim-line.bin");
    check_handover_with(
        &line,
        (120, 40),
        (None, None),
        true,
        sampled(line.len(), 6, 22),
    );
}

/// 대체 화면에서 크기를 바꿔도 대체 화면에는 기록이 생기지 않는다.
#[test]
fn resize_in_alt_screen_leaves_alt_without_history() {
    let mut s = Screen::new(40, 10, HIST);
    s.feed(&lines(0, 100));
    s.feed(b"\x1b[?1049h");
    s.resize(20, 8);
    s.feed(&lines(0, 50));
    assert_eq!(s.history_len(), 0);
    s.feed(b"\x1b[?1049l");
    assert!(s.history_len() > 0);
}
