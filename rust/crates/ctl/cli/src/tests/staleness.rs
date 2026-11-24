use std::collections::HashMap;
use std::path::Path;

use super::proc::write_pid;
use super::{Vars, with_env};
use crate::health::run_health_in;
use crate::staleness::{DaemonState, classify_daemon, daemon_state_line, inspect_daemon_with};
use crate::{Common, HealthOpts};

fn write_daemon_build(home: &Path, fp: &str) {
    std::fs::write(
        home.join(otter_shared_toolipc::DAEMON_BUILD_FILE),
        format!("{fp}\n"),
    )
    .unwrap();
}

fn me() -> String {
    std::process::id().to_string()
}

fn proc() -> &'static dyn otter_shared_platform::Process {
    otter_shared_platform::current().process
}

// FR-DFP-8: 판정의 네 상태. 모른다를 일치로 접지 않는다 (FR-DFP-3).
#[test]
fn classify() {
    use DaemonState::*;
    let cases = [
        (false, "abc", "abc", NotRunning),
        (false, "abc", "def", NotRunning),
        (true, "abc", "abc", Fresh),
        (true, "abc", "def", Stale),
        (true, "abc", "", Unknown),
        (true, "", "abc", Unknown),
        (true, "", "", Unknown),
    ];
    for (alive, rec, cur, want) in cases {
        assert_eq!(
            classify_daemon(alive, rec, cur),
            want,
            "{alive} {rec} {cur}"
        );
    }
}

// FR-DFP-11: 네 상태가 서로 다른 말을 하고, 불일치만 조치를 말한다.
#[test]
fn state_lines_distinct() {
    use DaemonState::*;
    let mut seen = HashMap::new();
    for s in [Unknown, NotRunning, Fresh, Stale] {
        let line = daemon_state_line(s);
        assert!(!line.trim().is_empty());
        assert!(seen.insert(line, s).is_none(), "{s:?}");
    }
    assert!(daemon_state_line(Stale).contains("세션을 유지"));
    assert!(!daemon_state_line(Fresh).contains("교체"));
}

#[test]
fn inspect_reads_recorded_file() {
    let d = tempfile::tempdir().unwrap();
    let home = d.path().to_str().unwrap();
    write_pid(d.path(), &me());
    write_daemon_build(d.path(), "deadbeef");
    assert_eq!(
        inspect_daemon_with(home, "deadbeef", proc()),
        DaemonState::Fresh
    );
    assert_eq!(
        inspect_daemon_with(home, "cafebabe", proc()),
        DaemonState::Stale
    );
    assert_eq!(inspect_daemon_with(home, "", proc()), DaemonState::Unknown);
}

#[test]
fn inspect_no_record_is_unknown() {
    let d = tempfile::tempdir().unwrap();
    write_pid(d.path(), &me());
    assert_eq!(
        inspect_daemon_with(d.path().to_str().unwrap(), "deadbeef", proc()),
        DaemonState::Unknown
    );
}

#[test]
fn inspect_no_pid_is_not_running() {
    let d = tempfile::tempdir().unwrap();
    write_daemon_build(d.path(), "deadbeef");
    assert_eq!(
        inspect_daemon_with(d.path().to_str().unwrap(), "cafebabe", proc()),
        DaemonState::NotRunning
    );
}

// FR-DFP-10: 낡은 데몬이 health 의 종료 코드를 1 로 바꾸지 않는다.
#[test]
fn health_daemon_only_stale_keeps_exit_zero() {
    let d = tempfile::tempdir().unwrap();
    write_pid(d.path(), &me());
    write_daemon_build(d.path(), "deadbeef");
    let o = HealthOpts {
        common: Common {
            home: d.path().to_str().unwrap().to_owned(),
            port: String::new(),
        },
        daemon_only: true,
    };
    let mut out = Vec::new();
    let mut err = Vec::new();
    let user = tempfile::tempdir().unwrap();
    let v = Vars::new(&[(super::USER_HOME_VAR, user.path().to_str().unwrap())]);
    let code = with_env(&v, |env| {
        run_health_in(&o, env, proc(), "cafebabe", &mut out, &mut err)
    });
    assert_eq!(code, 0);
    assert_eq!(
        String::from_utf8(out).unwrap(),
        format!("{}\n", daemon_state_line(DaemonState::Stale))
    );
}
