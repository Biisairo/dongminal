//! Go `internal/webserver/domain/run` 테스트 중 Go 비교 시나리오가 다루지 않는 것.

use std::fs;
use std::io;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use otter_webserver_domain_run::*;

fn opts(objective: &str) -> StartOptions {
    StartOptions {
        objective: objective.into(),
        projection: INLINE.into(),
        isolation: ISOLATION_NONE.into(),
        coordinator_tool_id: "coord".into(),
        ..StartOptions::default()
    }
}

fn store(dir: &std::path::Path) -> Store {
    let n = AtomicUsize::new(0);
    Store::new(dir)
        .with_clock(|| 100)
        .with_id_gen(move || format!("id-{}", n.fetch_add(1, Ordering::SeqCst)))
}

#[test]
fn missing_and_corrupt_files_start_empty() {
    let d = tempfile::tempdir().unwrap();
    let s = store(d.path());
    s.load();
    assert!(s.list().is_empty());
    fs::write(d.path().join("runs.json"), "{깨짐").unwrap();
    s.load();
    assert!(s.list().is_empty());
}

#[test]
fn runs_file_is_compact_and_reloads() {
    let d = tempfile::tempdir().unwrap();
    let s = store(d.path());
    let a = s.start(opts("하나")).unwrap();
    let b = s.start(opts("둘")).unwrap();
    let blob = fs::read_to_string(d.path().join("runs.json")).unwrap();
    assert!(!blob.contains('\n'));
    assert!(
        blob.starts_with(r#"{"schemaVersion":1,"runs":[{"id":"id-1""#),
        "{blob}"
    );
    let s2 = store(d.path());
    s2.load();
    let ids: Vec<_> = s2.list().into_iter().map(|r| r.id).collect();
    assert_eq!(ids, [b.id, a.id]);
    s2.delete("id-1").unwrap();
    s2.delete("id-0").unwrap();
    assert_eq!(
        fs::read_to_string(d.path().join("runs.json")).unwrap(),
        r#"{"schemaVersion":1,"runs":[]}"#
    );
}

#[test]
fn failed_save_rolls_back_to_last_written_state() {
    let d = tempfile::tempdir().unwrap();
    let fail = Arc::new(AtomicBool::new(false));
    let f = fail.clone();
    let s = store(d.path()).with_writer(move |p, b, perm| {
        if f.load(Ordering::SeqCst) {
            return Err(io::Error::other("disk full"));
        }
        otter_shared_platform::write_state_file(p, b, perm)
    });
    let a = s.start(opts("하나")).unwrap();
    s.add_member(
        &a.id,
        MemberSpec {
            role: "r".into(),
            agent: "claude".into(),
            tool_id: "t1".into(),
            ..MemberSpec::default()
        },
    )
    .unwrap();
    fail.store(true, Ordering::SeqCst);
    assert_eq!(
        s.start(opts("둘")).unwrap_err(),
        Error::Write("disk full".into())
    );
    let e = s
        .add_member(
            &a.id,
            MemberSpec {
                role: "q".into(),
                agent: "claude".into(),
                tool_id: "t2".into(),
                ..MemberSpec::default()
            },
        )
        .unwrap_err();
    assert!(matches!(e, Error::Write(_)));
    let list = s.list();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].members.len(), 1);
    fail.store(false, Ordering::SeqCst);
    assert_eq!(s.start(opts("셋")).unwrap().id, "id-4");
}

#[test]
fn failed_first_save_leaves_nothing() {
    let d = tempfile::tempdir().unwrap();
    let s = store(d.path()).with_writer(|_, _, _| Err(io::Error::other("x")));
    assert!(s.start(opts("하나")).is_err());
    assert!(s.list().is_empty());
}

#[test]
fn append_message_caps_dropping_oldest() {
    let d = tempfile::tempdir().unwrap();
    let s = store(d.path());
    let a = s.start(opts("하나")).unwrap();
    let m = s
        .add_member(
            &a.id,
            MemberSpec {
                role: "r".into(),
                agent: "claude".into(),
                tool_id: "t1".into(),
                ..MemberSpec::default()
            },
        )
        .unwrap();
    for i in 0..MAX_MESSAGES + 3 {
        s.append_message(
            &a.id,
            MsgEvent {
                from: COORDINATOR_PARTY.into(),
                to: m.id.clone(),
                size: i64::try_from(i).unwrap(),
                ..MsgEvent::default()
            },
        )
        .unwrap();
    }
    let msgs = s.get(&a.id).unwrap().messages;
    assert_eq!(msgs.len(), MAX_MESSAGES);
    assert_eq!(msgs[0].size, 3);
    assert_eq!(msgs[0].at, 100);
}

#[test]
fn context_at_only_change_skips_save() {
    let d = tempfile::tempdir().unwrap();
    let writes = Arc::new(AtomicUsize::new(0));
    let w = writes.clone();
    let clock = Arc::new(AtomicUsize::new(100));
    let c = clock.clone();
    let s = Store::new(d.path())
        .with_clock(move || i64::try_from(c.load(Ordering::SeqCst)).unwrap())
        .with_writer(move |p, b, perm| {
            w.fetch_add(1, Ordering::SeqCst);
            otter_shared_platform::write_state_file(p, b, perm)
        });
    let a = s.start(opts("하나")).unwrap();
    s.add_member(
        &a.id,
        MemberSpec {
            role: "r".into(),
            agent: "claude".into(),
            tool_id: "t1".into(),
            ..MemberSpec::default()
        },
    )
    .unwrap();
    let obs = ContextObservation {
        tokens: 10,
        has_tokens: true,
        ..ContextObservation::default()
    };
    let pol = ContextPolicy::default_policy();
    s.observe_context("t1", &obs, pol).unwrap();
    let before = writes.load(Ordering::SeqCst);
    clock.store(200, Ordering::SeqCst);
    let (m, entered) = s.observe_context("t1", &obs, pol).unwrap();
    assert_eq!(writes.load(Ordering::SeqCst), before);
    assert_eq!((m.context.context_at, entered.as_str()), (200, ""));
}

#[test]
fn policy_grades_and_defaults() {
    let p = ContextPolicy::default_policy();
    assert_eq!(p.grade(0.69, 0), LEVEL_OK);
    assert_eq!(p.grade(0.70, 0), LEVEL_WARN);
    assert_eq!(p.grade(0.85, 0), LEVEL_CRITICAL);
    assert_eq!(p.grade(0.0, 1), LEVEL_CRITICAL);
    let swapped = ContextPolicy {
        warn_ratio: 0.9,
        critical_ratio: 0.5,
        ..ContextPolicy::default()
    };
    assert_eq!(swapped.grade(0.6, 0), LEVEL_WARN);
    assert_eq!(swapped.grade(0.95, 0), LEVEL_CRITICAL);
    assert_eq!(p.level(720_000, 0), LEVEL_CRITICAL);
    assert!((p.ratio(360) - 0.0005).abs() < 1e-12);
    assert_eq!(DEFAULT_WINDOW_TOKENS, 200_000.0);
}

#[test]
fn window_for_model_follows_adapter() {
    assert_eq!(window_for_model("claude", ""), Some(1_000_000.0));
    assert_eq!(
        window_for_model(" claude ", "claude-opus-5"),
        Some(1_000_000.0)
    );
    assert_eq!(window_for_model("omp", "x"), None);
    assert_eq!(window_for_model("nope", "x"), None);
}

#[test]
fn vocabulary_wire_values() {
    for p in [DEDICATED_WINDOW, BACKGROUND, INLINE] {
        assert!(valid_projection(p));
    }
    assert!(!valid_projection("") && !valid_projection("window"));
    for i in [ISOLATION_NONE, ISOLATION_PER_RUN, ISOLATION_PER_MEMBER] {
        assert!(valid_isolation(i));
    }
    assert_eq!(
        (DEDICATED_WINDOW, BACKGROUND, INLINE),
        ("dedicated-window", "background", "inline")
    );
}

#[test]
fn headless_tool_ids_reads_open_runs_only() {
    let d = tempfile::tempdir().unwrap();
    let s = store(d.path());
    let a = s.start(opts("하나")).unwrap();
    let spec = |tool: &str, headless: bool| MemberSpec {
        role: tool.into(),
        agent: "claude".into(),
        tool_id: tool.into(),
        headless,
        ..MemberSpec::default()
    };
    s.add_member(&a.id, spec("h1", true)).unwrap();
    s.add_member(&a.id, spec("t1", false)).unwrap();
    let ids = headless_tool_ids(d.path());
    assert_eq!(ids.into_iter().collect::<Vec<_>>(), ["h1"]);
    s.close(&a.id, true).0.unwrap();
    assert!(headless_tool_ids(d.path()).is_empty());
}

#[test]
fn legacy_fields_are_read() {
    let d = tempfile::tempdir().unwrap();
    fs::write(
        d.path().join("runs.json"),
        r#"{"schemaVersion":1,"runs":[{"id":"r1","short":"r1","objective":"o","projection":"inline","isolation":"none","state":"aborted","epoch":"e1","abortReason":"daemon-restart","createdAt":1}]}"#,
    )
    .unwrap();
    let s = store(d.path());
    s.load();
    let r = s.get("r1").unwrap();
    assert_eq!(
        (r.state.as_str(), r.epoch.as_str(), r.abort_reason.as_str()),
        (ABORTED, "e1", ABORT_DAEMON_RESTART)
    );
    assert!(s.start(opts("새")).unwrap().epoch.is_empty());
}

/// NFR-RSP-3: 쓰기 동안 조회가 기다리지 않는다 (Go `TestSave_WriteDoesNotHoldStoreLock`).
#[test]
fn write_does_not_hold_store_lock() {
    use std::sync::Mutex;
    use std::sync::mpsc;
    use std::time::Duration;
    let d = tempfile::tempdir().unwrap();
    let (entered_tx, entered_rx) = mpsc::channel::<()>();
    let (go_tx, go_rx) = mpsc::channel::<()>();
    let gate = Mutex::new((entered_tx, go_rx));
    let s = Arc::new(store(d.path()).with_writer(move |p, b, perm| {
        let g = gate.lock().unwrap();
        let _ = g.0.send(());
        let _ = g.1.recv_timeout(Duration::from_secs(5));
        otter_shared_platform::write_state_file(p, b, perm)
    }));
    let w = s.clone();
    let writer = std::thread::spawn(move || w.start(opts("하나")).unwrap());
    entered_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    let (tx, rx) = mpsc::channel();
    let r = s.clone();
    std::thread::spawn(move || tx.send(r.list().len()).unwrap());
    let n = rx
        .recv_timeout(Duration::from_secs(2))
        .expect("쓰기 동안 조회가 막혔다");
    assert_eq!(n, 1);
    go_tx.send(()).unwrap();
    writer.join().unwrap();
}

/// 앞의 저장이 실패해도 뒤에 시작한 저장이 성공하면 되돌리지 않는다 (Go `TestSave_EarlierFailureCoveredByLaterSuccess`).
#[test]
fn earlier_failure_covered_by_later_success() {
    use std::sync::Mutex;
    use std::sync::mpsc;
    use std::time::Duration;
    let d = tempfile::tempdir().unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let (entered_tx, entered_rx) = mpsc::channel::<()>();
    let (go_tx, go_rx) = mpsc::channel::<()>();
    let gate = Mutex::new((entered_tx, go_rx));
    let c = calls.clone();
    let s = Arc::new(store(d.path()).with_writer(move |p, b, perm| {
        if c.fetch_add(1, Ordering::SeqCst) == 0 {
            let g = gate.lock().unwrap();
            let _ = g.0.send(());
            let _ = g.1.recv_timeout(Duration::from_secs(5));
            return Err(io::Error::other("첫 쓰기 실패"));
        }
        otter_shared_platform::write_state_file(p, b, perm)
    }));
    let w = s.clone();
    let first = std::thread::spawn(move || w.start(opts("하나")));
    entered_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    let w2 = s.clone();
    let second = std::thread::spawn(move || w2.start(opts("둘")));
    // 둘째 저장이 상태를 바꾸고 쓰기 잠금을 기다릴 때까지 기다린다.
    while s.list().len() < 2 {
        std::thread::sleep(Duration::from_millis(5));
    }
    go_tx.send(()).unwrap();
    assert!(
        first.join().unwrap().is_ok(),
        "뒤의 성공이 앞의 실패를 덮어야 한다"
    );
    assert!(second.join().unwrap().is_ok());
    assert_eq!(s.list().len(), 2);
    let s2 = store(d.path());
    s2.load();
    assert_eq!(s2.list().len(), 2);
}

/// ISSUE_TREE_CHAT_SRS FR-LIS-7: 로컬 트리는 원본 이슈 폴더를 Run 에 기록한다. 가지 Run 은 열린 루트의 것을 잇는다.
/// 트리 없는 Run 에는 기록하지 않는다.
#[test]
fn local_tree_records_issue_dir() {
    let d = tempfile::tempdir().unwrap();
    let s = store(d.path());
    let root = s
        .start(StartOptions {
            tree: "perf:2".into(),
            issue_dir: "/repo/docs/perf/issues".into(),
            ..opts("루트")
        })
        .unwrap();
    assert_eq!(root.issue_dir, "/repo/docs/perf/issues");
    let branch = s
        .start(StartOptions {
            tree: "perf:2".into(),
            tree_branch: true,
            ..opts("가지")
        })
        .unwrap();
    assert_eq!(branch.issue_dir, "/repo/docs/perf/issues");
    let blob = fs::read_to_string(d.path().join("runs.json")).unwrap();
    assert!(
        blob.contains(r#""issueDir":"/repo/docs/perf/issues""#),
        "{blob}"
    );
    let gh = s
        .start(StartOptions {
            tree: "o/r#1".into(),
            ..opts("github")
        })
        .unwrap();
    assert!(gh.issue_dir.is_empty());
    let bad = s.start(StartOptions {
        issue_dir: "/x".into(),
        ..opts("트리 없음")
    });
    assert!(matches!(bad, Err(Error::InvalidArgument(_))), "{bad:?}");
}

/// ISSUE_TREE_CHAT_SRS FR-LIS-1: 실행 방식 coord 는 Run 에 기록한다. tree(기본)는 기록하지 않는다(키 없음).
#[test]
fn coord_mode_is_recorded() {
    let d = tempfile::tempdir().unwrap();
    let s = store(d.path());
    let coord = s
        .start(StartOptions {
            tree: "perf:2".into(),
            issue_dir: "/repo/perf/issues".into(),
            mode: MODE_COORD.into(),
            ..opts("조정")
        })
        .unwrap();
    assert_eq!(coord.mode, MODE_COORD);
    let blob = fs::read_to_string(d.path().join("runs.json")).unwrap();
    assert!(blob.contains(r#""mode":"coord""#), "{blob}");
    let tree = s
        .start(StartOptions {
            tree: "o/r#3".into(),
            mode: MODE_TREE.into(),
            ..opts("노드 트리")
        })
        .unwrap();
    assert!(tree.mode.is_empty(), "{tree:?}");
    for (tree, mode) in [("o/r#4", "bogus"), ("", MODE_COORD)] {
        let bad = s.start(StartOptions {
            tree: tree.into(),
            mode: mode.into(),
            ..opts("나쁨")
        });
        assert!(
            matches!(bad, Err(Error::InvalidArgument(_))),
            "{mode}: {bad:?}"
        );
    }
}
