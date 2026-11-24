//! shellwait_test.go — "셸이 무언가 그리고 조용해질 때까지" 는 wait_quiet 하나다 (FR-OPT-9-2).

use std::cell::Cell;
use std::time::{Duration, Instant};

use crate::shellwait::{ChangeTracker, QuietError, wait_quiet_every};

const POLL: Duration = Duration::from_millis(5);

#[test]
fn returns_once_quiet() {
    let drawn = Instant::now();
    let start = Instant::now();
    let res = wait_quiet_every(
        || Ok::<_, String>((10, Some(drawn))),
        Duration::from_secs(5),
        Duration::from_millis(50),
        POLL,
    );
    assert!(res.is_ok(), "{res:?}");
    assert!(start.elapsed() <= Duration::from_secs(2));
}

#[test]
fn zero_time_counts_as_long_ago() {
    let res = wait_quiet_every(
        || Ok::<_, String>((1, None)),
        Duration::from_millis(60),
        Duration::from_secs(1),
        POLL,
    );
    assert!(res.is_ok(), "{res:?}");
}

#[test]
fn nothing_drawn() {
    let res = wait_quiet_every(
        || Ok::<_, String>((0, None)),
        Duration::from_millis(60),
        Duration::from_millis(10),
        POLL,
    );
    assert!(matches!(res, Err(QuietError::NothingDrawn)), "{res:?}");
    assert_eq!(res.unwrap_err().to_string(), "셸이 아무 것도 그리지 않았다");
}

#[test]
fn still_changing() {
    let res = wait_quiet_every(
        || Ok::<_, String>((1, Some(Instant::now()))),
        Duration::from_millis(60),
        Duration::from_secs(1),
        POLL,
    );
    assert!(matches!(res, Err(QuietError::NotQuiet)), "{res:?}");
    assert_eq!(res.unwrap_err().to_string(), "셸 출력이 조용해지지 않았다");
}

#[test]
fn snapshot_error_aborts() {
    let calls = Cell::new(0);
    let res = wait_quiet_every(
        || {
            calls.set(calls.get() + 1);
            if calls.get() == 2 {
                return Err("boom".to_owned());
            }
            Ok((0, None))
        },
        Duration::from_secs(5),
        Duration::from_millis(10),
        POLL,
    );
    match res {
        Err(QuietError::Snapshot(e)) => assert_eq!(e, "boom"),
        other => panic!("{other:?}"),
    }
    assert_eq!(calls.get(), 2);
}

#[test]
fn change_tracker() {
    let mut c = ChangeTracker::default();
    assert_eq!(c.observe(b""), (0, None), "빈 관측");
    let (n, at1) = c.observe(b"ab");
    assert_eq!(n, 2);
    assert!(at1.is_some(), "첫 변화");
    let (_, at2) = c.observe(b"ab");
    assert_eq!(at2, at1, "같은 관측이 변화 시각을 옮겼다");
}
