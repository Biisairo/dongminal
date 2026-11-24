use std::sync::Arc;

use super::support::*;
use crate::{DEFAULT_RECORD_CAP, Kind, Output, Record, Recorder, Service};

// 케이스 7 (V15, FR-GIT-5): 성공·실패·거부 세 경로 전부가 기록에 남는다.
#[tokio::test]
async fn records_all_paths() {
    let s = Service::builder()
        .runner(runner(|_, _, args| {
            if args[0] == "status" {
                Ok(Output {
                    duration_ms: 7,
                    ..out("## main\n", "", 0)
                })
            } else {
                Ok(Output {
                    duration_ms: 3,
                    ..out("", "fatal: bad object\n", 128)
                })
            }
        }))
        .build();
    s.exec(&bg(), &abs_tmp_repo(), &["status", "--porcelain"])
        .await
        .unwrap();
    assert!(
        s.exec(&bg(), &abs_tmp_repo(), &["show", "deadbeef"])
            .await
            .is_err()
    );
    assert!(
        s.exec(&bg(), &abs_tmp_repo(), &["commit", "-m", "x"])
            .await
            .unwrap_err()
            .is(Kind::WriteCommand)
    );
    let recs = s.records(0);
    assert_eq!(recs.len(), 3);
    for (i, r) in recs.iter().enumerate() {
        assert!(!r.argv().is_empty() && r.cwd == abs_tmp_repo());
        assert!(r.at_unix_ms > 0 && r.seq == i as u64 + 1 && !r.destructive);
    }
    let (ok, fail, denied) = (&recs[0], &recs[1], &recs[2]);
    assert!(ok.exit_code == 0 && ok.duration_ms == 7 && ok.stdout_bytes == 8 && ok.err.is_empty());
    assert!(
        fail.exit_code == 128
            && fail.duration_ms == 3
            && fail.stderr.contains("bad object")
            && !fail.err.is_empty()
    );
    assert!(denied.exit_code == -1 && !denied.err.is_empty() && denied.argv()[0] == "commit");
}

#[test]
fn recorder_ring_eviction() {
    let r = Recorder::new(3);
    for _ in 0..5 {
        r.add(Record {
            cwd: "/x".into(),
            ..Record::default()
        });
    }
    assert_eq!(r.len(), 3);
    let seqs: Vec<u64> = r.recent(0).iter().map(|x| x.seq).collect();
    assert_eq!(seqs, [3, 4, 5]);
    let tail = r.recent(2);
    assert!(tail.len() == 2 && tail[1].seq == 5);
    assert_eq!(r.recent(99)[0].seq, 3);
}

#[test]
fn new_recorder_cap_fallback() {
    let r = Recorder::new(0);
    for _ in 0..DEFAULT_RECORD_CAP + 10 {
        r.add(Record::default());
    }
    assert_eq!(r.len(), DEFAULT_RECORD_CAP);
}

// 케이스 10 (V15): 동시 접근.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn recorder_concurrent() {
    let rec = Arc::new(Recorder::new(16));
    let s = Arc::new(
        Service::builder()
            .recorder(rec.clone())
            .runner(runner(|_, _, _| {
                Ok(Output {
                    duration_ms: 1,
                    ..out("x", "", 0)
                })
            }))
            .build(),
    );
    let mut hs = Vec::new();
    for _ in 0..8 {
        let s1 = s.clone();
        hs.push(tokio::spawn(async move {
            for _ in 0..50 {
                let _ = s1.exec(&bg(), &abs_tmp_repo(), &["status"]).await;
            }
        }));
        let (s2, r2) = (s.clone(), rec.clone());
        hs.push(tokio::spawn(async move {
            for _ in 0..50 {
                let _ = s2.records(5);
                let _ = r2.len();
            }
        }));
    }
    for h in hs {
        h.await.unwrap();
    }
    assert_eq!(rec.len(), 16);
    let mut got = rec.recent(4);
    got[0].cwd = "mutated".into();
    assert_ne!(rec.recent(4)[0].cwd, "mutated");
}

// FR-OPT-4-8.
#[test]
fn recorder_since() {
    let r = Recorder::new(3);
    let (recs, span) = r.since(0, "");
    assert!(recs.is_empty() && !span.gap && span.last == 0 && span.first == 1);
    for _ in 0..5 {
        r.add(Record::default());
    }
    let cases: &[(u64, &[u64], bool)] = &[
        (5, &[], false),
        (4, &[5], false),
        (2, &[3, 4, 5], false),
        (1, &[3, 4, 5], true),
        (0, &[3, 4, 5], true),
        (9, &[3, 4, 5], true),
    ];
    for (after, want, gap) in cases {
        let (recs, span) = r.since(*after, "");
        let got: Vec<u64> = recs.iter().map(|x| x.seq).collect();
        assert_eq!(got, *want, "after {after}");
        assert_eq!((span.gap, span.first, span.last), (*gap, 3, 5));
    }
}

#[test]
fn recorder_since_epoch() {
    let (old, r) = (Recorder::new(8), Recorder::new(8));
    assert!(!old.epoch().is_empty() && old.epoch() != r.epoch());
    assert_eq!(r.epoch().len(), 26);
    assert!(
        r.epoch()
            .bytes()
            .all(|c| c.is_ascii_uppercase() || (b'2'..=b'7').contains(&c))
    );
    for _ in 0..5 {
        r.add(Record::default());
    }
    let (recs, span) = r.since(2, old.epoch());
    assert!(span.gap && recs.len() == 5 && span.epoch == r.epoch());
    let (recs, span) = r.since(2, r.epoch());
    assert!(!span.gap && recs.len() == 3);
    let (recs, span) = r.since(2, "");
    assert!(!span.gap && recs.len() == 3);
}

// 와이어: 필드 순서·omitempty·nil argv.
#[test]
fn record_json_wire() {
    let r = Record {
        seq: 1,
        at_unix_ms: 2,
        cwd: "/r".into(),
        exit_code: -1,
        ..Record::default()
    };
    let got = String::from_utf8(otter_gocompat::json::marshal(&r).unwrap()).unwrap();
    assert_eq!(
        got,
        r#"{"seq":1,"atUnixMs":2,"argv":null,"cwd":"/r","exitCode":-1,"durationMs":0,"stderr":"","stdoutBytes":0,"stdoutTruncated":false,"stderrTruncated":false,"destructive":false,"write":false,"stdinBytes":0}"#
    );
    let full = Record {
        argv: Some(vec!["status".into()]),
        err: "e".into(),
        unguarded: true,
        reason: "why".into(),
        ..r.clone()
    };
    let got = String::from_utf8(otter_gocompat::json::marshal(&full).unwrap()).unwrap();
    assert!(
        got.contains(r#""argv":["status"]"#)
            && got.ends_with(r#""stdinBytes":0,"err":"e","unguarded":true,"reason":"why"}"#),
        "{got}"
    );
    // redacted 는 항상 non-nil argv 다.
    let red = String::from_utf8(otter_gocompat::json::marshal(&r.redacted()).unwrap()).unwrap();
    assert!(red.contains(r#""argv":[]"#), "{red}");
}

#[test]
fn record_redacted() {
    let r = Record {
        argv: Some(vec![
            "push".into(),
            "https://u:tok@host/x".into(),
            "main".into(),
        ]),
        cwd: abs_r(),
        stderr: "remote: rejected https://u:tok@host/x".into(),
        ..Record::default()
    };
    let got = r.redacted();
    assert_eq!(got.argv()[1], "https://***@host/x");
    assert_eq!(got.stderr, "remote: rejected https://***@host/x");
    assert_eq!(r.argv()[1], "https://u:tok@host/x");
}

// FR-GIT-218 · FR-GRF-25.
#[test]
fn record_carries_write_flag() {
    use crate::record::new_record;
    let cases: &[(&[&str], bool)] = &[
        (&["status", "--porcelain=v2"], false),
        (&["rev-parse", "--show-toplevel"], false),
        (&["add", "a.txt"], true),
        (&["commit", "-F", "-"], true),
        (&["clean", "-f"], true),
        (&["stash", "list"], false),
        (&[], false),
    ];
    for (argv, w) in cases {
        let rec = new_record(&abs_r(), argv, &Output::default(), None);
        assert_eq!(rec.write, *w, "{argv:?}");
        assert_eq!(rec.argv.is_none(), argv.is_empty());
    }
}
