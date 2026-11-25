//! 터미널 재생·이어 받기·miss·입력 시각 (Go `term_resume_test.go`·`term_query_vectors_test.go`·
//! `ws_miss_test.go`·`ws_hold_test.go`·`handlers_ws_verdict_test.go`·`browser_input_test.go` 의
//! 단위 부분).

use std::time::{Duration, Instant, SystemTime};

use otter_shared_toolhub::{
    OP_ERROR, OP_EXIT, OP_OUTPUT, OP_SEQ, OP_TOOL_ID, OutChunk, TermSize, ToolScreen,
};

use crate::ws::{
    BrowserInputs, MISS_REPEAT_WINDOW, MissTracker, relay_joinable, replay_delta, seq_payload,
    snap_seq_payload, strip_snapshot_queries, trim_overlap,
};

#[test]
fn replay_delta_strips_osc777_and_queries() {
    assert_eq!(replay_delta(b"FRAME"), b"FRAME");
    assert_eq!(replay_delta("앞\n뒤".as_bytes()), "앞\n뒤".as_bytes());
    assert_eq!(replay_delta(b"a\x1b]777;Cwd;/tmp\x07b\x1b[?6nc"), b"abc");
    assert!(replay_delta(b"").is_empty());
}

#[test]
fn replay_delta_strips_startup_probes() {
    let probes =
        "\x1b]11;?\x07\x1b[?2026$p\x1b[?2048$p\x1b[?2031$p\x1b[?1010$p\x1b[?1011$p\x1bP$q q\x1b\\";
    let got = replay_delta(format!("$ claude{probes}\nready").as_bytes());
    assert_eq!(got, b"$ claude\nready");
}

/// PERF D-19: 스냅숏의 `SEQ` 는 FULL·SNAP 깃발을 세우고, 뒤에 첫 기록 줄 번호(u64 BE)와 cwd 를 붙인다.
#[test]
fn snap_seq_payload_layout() {
    let s = ToolScreen {
        end: 0x0102030405060708,
        alt: true,
        first_line: 77,
        cwd: "/tmp/깨움".to_owned(),
        ..ToolScreen::default()
    };
    let p = snap_seq_payload(&s);
    assert_eq!(
        i64::from_be_bytes(p[..8].try_into().unwrap()),
        0x0102030405060708
    );
    assert_eq!(p[8], 1 | 2 | 4);
    assert_eq!(u64::from_be_bytes(p[9..17].try_into().unwrap()), 77);
    assert_eq!(&p[17..], "/tmp/깨움".as_bytes());
    let main = snap_seq_payload(&ToolScreen::default());
    assert_eq!((main[8], main.len()), (1 | 4, 17));
}

#[test]
fn strip_snapshot_queries_shared_vectors() {
    #[derive(serde::Deserialize)]
    struct V {
        name: String,
        query: String,
        report: String,
    }
    let vs: Vec<V> = serde_json::from_str(include_str!("term_query_report_vectors.json")).unwrap();
    assert!(vs.len() >= 8, "표본이 {}개뿐이다", vs.len());
    for v in vs {
        assert!(!v.query.is_empty() && !v.report.is_empty(), "{}", v.name);
        let got = strip_snapshot_queries(v.query.as_bytes());
        assert!(
            got.is_empty(),
            "{}: {:?} 가 남았다: {got:?}",
            v.name,
            v.query
        );
    }
}

#[test]
fn seq_payload_layout() {
    let p = seq_payload(0x0102030405060708, false);
    assert_eq!(p.len(), 9);
    assert_eq!(
        i64::from_be_bytes(p[..8].try_into().unwrap()),
        0x0102030405060708
    );
    assert_eq!(p[8], 0, "이어 붙이기에는 FULL 깃발이 없다");
    assert_eq!(seq_payload(0, true)[8], 2);
    for op in [OP_OUTPUT, OP_ERROR, OP_EXIT, OP_TOOL_ID] {
        assert_ne!(OP_SEQ, op);
    }
}

#[test]
fn trim_overlap_cases() {
    assert!(trim_overlap(b"abcde", 15, 20).is_empty());
    assert_eq!(trim_overlap(b"abcde", 15, 12), b"cde");
    assert_eq!(trim_overlap(b"abcde", 15, 10), b"abcde");
    assert_eq!(trim_overlap(b"abcde", 0, 999), b"abcde");
    assert_eq!(trim_overlap(b"abcde", 15, -1), b"abcde");
}

#[test]
fn relay_joinable_cases() {
    let c = |data: &[u8], end: i64, size: Option<TermSize>| OutChunk {
        data: bytes::Bytes::copy_from_slice(data),
        end,
        size,
    };
    assert!(relay_joinable(&c(b"ab", 12, None), 10));
    assert!(relay_joinable(&c(b"ab", 0, None), 10));
    assert!(!relay_joinable(&c(b"ab", 20, None), 10));
    assert!(!relay_joinable(&c(b"", 0, Some(TermSize::default())), 10));
}

#[test]
fn miss_tracker_repeat() {
    let mt = MissTracker::default();
    let base = Instant::now();
    assert!(!mt.repeat("tool-a", base), "첫 미스가 반복으로 판정됐다");
    assert!(mt.repeat("tool-a", base + MISS_REPEAT_WINDOW / 2));

    let mt = MissTracker::default();
    mt.repeat("tool-a", base);
    assert!(!mt.repeat("tool-a", base + MISS_REPEAT_WINDOW + Duration::from_secs(1)));

    let mt = MissTracker::default();
    mt.repeat("tool-a", base);
    mt.repeat("tool-a", base + Duration::from_millis(1));
    assert!(!mt.repeat("tool-b", base + Duration::from_millis(2)));
}

#[test]
fn miss_tracker_prunes_stale_entries() {
    let mt = MissTracker::default();
    let base = Instant::now();
    for i in 0..500 {
        mt.repeat(&format!("t{i}"), base);
    }
    mt.repeat("late", base + MISS_REPEAT_WINDOW * 10);
    assert!(mt.size() <= 1, "낡은 항목이 {}개 남았다", mt.size());
}

#[test]
fn browser_inputs_mark_and_last() {
    let b = BrowserInputs::default();
    assert!(b.last("a").is_none());
    let before = SystemTime::now();
    b.mark("a");
    assert!(b.last("a").unwrap() >= before);
    assert!(b.last("b").is_none(), "다른 도구까지 갱신됐다");
}
