use std::sync::atomic::{AtomicUsize, Ordering};

use super::*;

// DIRECT_MODE_REMOVAL_SRS FR-DMR-2 (TC-DMR-1): 데몬을 띄우지 못하면 오류다.
#[test]
fn spawn_failure_is_error() {
    let home = tempfile::tempdir().unwrap();
    let r = dial_or_start_daemon_with(
        home.path().to_str().unwrap(),
        Arc::new(|| Err(io::Error::other("spawn 실패"))),
    );
    let err = r.err().expect("오류여야 한다");
    assert_eq!(err, DaemonUnavailable::Spawn("spawn 실패".into()));
    assert_eq!(
        err.to_string(),
        "daemon unavailable: 데몬을 띄우지 못했습니다: spawn 실패"
    );
}

// FR-DMR-2: 띄웠는데 준비되지 않으면 역시 오류다. 상한은 tries×poll 이다.
#[test]
fn not_ready_is_error() {
    let home = tempfile::tempdir().unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let c = Arc::clone(&calls);
    let start = Instant::now();
    let r = dial_or_start_daemon_with(
        home.path().to_str().unwrap(),
        Arc::new(move || {
            c.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }),
    );
    let took = start.elapsed();
    let err = r.err().expect("오류여야 한다");
    assert_eq!(err, DaemonUnavailable::NotReady);
    assert_eq!(
        err.to_string(),
        "daemon unavailable: 데몬이 2s 안에 준비되지 않았습니다"
    );
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert!(took >= ready_window(), "{took:?}");
}

#[test]
fn constants_match_go() {
    assert_eq!(DAEMON_BUSY_WAIT, Duration::from_secs(3));
    assert_eq!(DAEMON_READY_TRIES, 20);
    assert_eq!(DAEMON_READY_POLL, Duration::from_millis(100));
    assert_eq!(DAEMON_SUBCOMMAND, "d");
}

#[test]
fn daemon_env_carries_home_and_tool_home() {
    assert_eq!(
        daemon_env("/h", ""),
        vec![(otterenv::ENV_HOME.to_owned(), "/h".to_owned())]
    );
    assert_eq!(
        daemon_env("/h", "/t"),
        vec![
            (otterenv::ENV_HOME.to_owned(), "/h".to_owned()),
            (otterenv::ENV_TOOL_HOME.to_owned(), "/t".to_owned()),
        ]
    );
}
