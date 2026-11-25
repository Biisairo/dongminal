use std::collections::BTreeSet;
use std::time::Duration;

use crate::*;

const SRC: &str = include_str!("lib.rs");

/// 모듈 문서 표의 첫 칸(`NAME`)들이다. 머리줄·구분줄은 건너뛴다.
fn table_names() -> Vec<String> {
    SRC.lines()
        .filter_map(|l| l.strip_prefix("//! | `"))
        .filter_map(|rest| rest.split_once('`').map(|(name, _)| name.to_owned()))
        .collect()
}

/// `pub const NAME:` 로 선언한 상수들이다.
fn const_names() -> Vec<String> {
    SRC.lines()
        .filter_map(|l| l.strip_prefix("pub const "))
        .filter_map(|rest| rest.split_once(':').map(|(name, _)| name.to_owned()))
        .collect()
}

#[test]
fn doc_table_matches_constants() {
    let table = table_names();
    let consts = const_names();
    let table_set: BTreeSet<_> = table.iter().cloned().collect();
    let const_set: BTreeSet<_> = consts.iter().cloned().collect();
    assert_eq!(table.len(), table_set.len(), "표에 같은 이름이 두 번 있다");
    assert!(!const_set.is_empty(), "상수가 하나도 없다");
    assert_eq!(table_set, const_set, "모듈 문서 표와 상수 목록이 다르다");
}

#[test]
fn every_constant_has_reason_doc() {
    let lines: Vec<&str> = SRC.lines().collect();
    let missing: Vec<&str> = lines
        .iter()
        .enumerate()
        .filter(|(_, l)| l.starts_with("pub const "))
        .filter(|(i, _)| *i == 0 || !lines[i - 1].starts_with("///"))
        .map(|(_, l)| *l)
        .collect();
    assert!(
        missing.is_empty(),
        "이유 문서 주석이 없는 상수: {missing:?}"
    );
}

/// 옮기기 전의 값 그대로다 (동작 변경 0, 4.5).
#[test]
fn values_unchanged_from_previous_homes() {
    let s = Duration::from_secs;
    assert_eq!(DIAG_SNAPSHOT_EVERY, s(60));
    assert_eq!(TOOL_HEARTBEAT_EVERY, s(15));
    assert_eq!(ACCESS_REFRESH_EVERY, s(60));
    assert_eq!(LOG_CHECK_EVERY, s(60));
    assert_eq!(HUMANCMD_HELPER_EVERY, s(30));
    assert_eq!(UPDATE_CHECK_EVERY, s(86_400));
    assert_eq!(GIT_WATCH_ROUND_EVERY, Duration::from_millis(1000));
    assert_eq!(GIT_WATCH_WORKTREE_ROUNDS, 4);
    assert_eq!(GIT_WATCH_BACKOFF_MAX, s(30));
    assert_eq!(SYSSTAT_SAMPLE_EVERY, s(2));
    assert_eq!(MESH_REDIAL_MIN, s(1));
    assert_eq!(MESH_REDIAL_MAX, s(60));
    assert_eq!(MESH_PING_EVERY, s(15));
}
