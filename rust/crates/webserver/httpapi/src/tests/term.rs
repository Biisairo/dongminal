//! 터미널 재생·이어 받기·miss·입력 시각 (Go `term_resume_test.go`·`term_query_vectors_test.go`·
//! `ws_miss_test.go`·`ws_hold_test.go`·`handlers_ws_verdict_test.go`·`browser_input_test.go` 의
//! 단위 부분).

use std::time::{Duration, Instant, SystemTime};

use otter_shared_toolhub::{OP_ERROR, OP_EXIT, OP_OUTPUT, OP_SEQ, OP_TOOL_ID, OutChunk, TermSize};

use crate::ws::{
    BrowserInputs, MISS_REPEAT_WINDOW, MissTracker, TERM_HARD_CLEAR, TERM_RESET, TRS_ALIGN_SCAN,
    align_head, build_replay, parse_since, relay_joinable, seq_payload, strip_snapshot_queries,
    trim_overlap,
};

fn contains(h: &[u8], n: &[u8]) -> bool {
    find(h, n).is_some()
}

fn find(h: &[u8], n: &[u8]) -> Option<usize> {
    h.windows(n.len()).position(|w| w == n)
}

#[test]
fn align_head_cases() {
    assert_eq!(
        align_head("2;34m깨진앞머리\nOK부터\n뒤".as_bytes()),
        "OK부터\n뒤".as_bytes()
    );
    let long = vec![b'x'; TRS_ALIGN_SCAN + 100];
    assert_eq!(align_head(&long).len(), long.len(), "밀면 안 된다");
    let mut beyond = vec![b'x'; TRS_ALIGN_SCAN + 10];
    beyond.extend_from_slice(b"\na");
    assert_eq!(align_head(&beyond).len(), beyond.len());
    assert_eq!(align_head(b"\nabc"), b"abc");
    assert!(align_head(b"").is_empty());
}

#[test]
fn build_replay_full_order_and_clear() {
    let got = build_replay(b"\nBODY", true, false);
    let (r, c, b) = (
        find(&got, TERM_RESET),
        find(&got, TERM_HARD_CLEAR),
        find(&got, b"BODY"),
    );
    assert_eq!(r, Some(0));
    assert!(r < c && c < b, "{r:?} {c:?} {b:?}");
    let got = build_replay(b"\nx", true, false);
    for want in ["\x1b[2J", "\x1b[3J", "\x1b[?1049l", "\x1b[H"] {
        assert!(contains(&got, want.as_bytes()), "{want:?}");
    }
}

#[test]
fn build_replay_restores_alt_at_head() {
    let alt_on = b"\x1b[?1049h";
    let cases = [
        ("전환 없음·지금 대체 화면", "\nFRAME", true, true),
        ("전환 없음·지금 주 화면", "\nFRAME", false, false),
        (
            "첫 전환이 끄기",
            "\nFRAME\x1b[?1049l$ \x1b[?1049hVIM",
            true,
            true,
        ),
        ("첫 전환이 켜기", "\n$ vim\x1b[?1049hVIM", true, false),
        ("옛 형태 47 끄기", "\nFRAME\x1b[?47l$ ", false, true),
    ];
    for (name, body, alt, want) in cases {
        let got = build_replay(body.as_bytes(), true, alt);
        let i = find(&got, TERM_HARD_CLEAR).unwrap() + TERM_HARD_CLEAR.len();
        assert_eq!(got[i..].starts_with(alt_on), want, "{name}");
    }
}

#[test]
fn build_replay_delta() {
    assert_eq!(build_replay(b"FRAME", false, true), b"FRAME");
    let got = build_replay(b"delta", false, false);
    assert_eq!(got, b"delta");
    assert!(!contains(&got, TERM_HARD_CLEAR) && !contains(&got, TERM_RESET));
    assert_eq!(
        build_replay("앞\n뒤".as_bytes(), false, false),
        "앞\n뒤".as_bytes()
    );
    assert_eq!(
        build_replay(b"a\x1b]777;Cwd;/tmp\x07b\x1b[?6nc", false, false),
        b"abc"
    );
    assert!(build_replay(b"", false, false).is_empty());
    let full = build_replay(b"\na\x1b]777;Cwd;/tmp\x07b", true, false);
    assert!(!contains(&full, b"777"));
}

#[test]
fn build_replay_strips_startup_probes() {
    let probes =
        "\x1b]11;?\x07\x1b[?2026$p\x1b[?2048$p\x1b[?2031$p\x1b[?1010$p\x1b[?1011$p\x1bP$q q\x1b\\";
    let got = build_replay(format!("$ claude{probes}\nready").as_bytes(), false, false);
    assert_eq!(got, b"$ claude\nready");
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
    let p = seq_payload(0x0102030405060708, true, false);
    assert_eq!(p.len(), 9);
    assert_eq!(
        i64::from_be_bytes(p[..8].try_into().unwrap()),
        0x0102030405060708
    );
    assert_eq!(p[8], 1);
    for (full, alt, want) in [
        (false, false, 0),
        (true, false, 1),
        (false, true, 2),
        (true, true, 3),
    ] {
        assert_eq!(seq_payload(0, full, alt)[8], want);
    }
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
fn parse_since_cases() {
    let cases = [
        ("", None),
        ("abc", None),
        ("-1", None),
        ("0", Some(0)),
        ("1048576", Some(1048576)),
        ("9007199254740991", Some(9007199254740991)),
        ("99999999999999999999", None),
    ];
    for (q, want) in cases {
        assert_eq!(parse_since(q), want, "{q:?}");
    }
}

#[test]
fn relay_joinable_cases() {
    let c = |data: &[u8], end: i64, size: Option<TermSize>| OutChunk {
        data: data.to_vec(),
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
fn miss_tracker_count() {
    let base = Instant::now();
    let ms = Duration::from_millis;
    let mt = MissTracker::default();
    for i in 1..=4 {
        assert_eq!(mt.count("tool-a", base + ms(i)), i as usize);
    }
    let mt = MissTracker::default();
    for i in 0..10 {
        mt.count("tool-a", base + ms(i));
    }
    assert_eq!(
        mt.count("tool-a", base + MISS_REPEAT_WINDOW + Duration::from_secs(1)),
        1
    );
    let mt = MissTracker::default();
    for i in 0..5 {
        mt.count("tool-a", base + ms(i));
    }
    assert_eq!(mt.count("tool-b", base + ms(6)), 1);
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
