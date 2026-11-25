//! 실행 파일의 역할 판정 (Go `cmd/otterminal/main.go`). 모두 임시 홈에서만 돈다.

use std::path::Path;
use std::process::{Command, Output};

const BIN: &str = env!("CARGO_BIN_EXE_otterminal");

/// 사용자 인스턴스를 가리키는 값을 모두 지우고 임시 홈만 심는다 (Go `isolatedEnv`).
fn isolated(cmd: &mut Command, home: &Path) {
    for (k, _) in std::env::vars_os() {
        if k.to_string_lossy().starts_with("OTTERMINAL_") {
            cmd.env_remove(k);
        }
    }
    cmd.env("OTTERMINAL_HOME", home)
        .env("OTTERMINAL_TOOL_HOME", home.join("tool-home"));
}

fn run(home: &Path, args: &[&str]) -> Output {
    let mut c = Command::new(BIN);
    c.args(args);
    isolated(&mut c, home);
    c.output().expect("run")
}

#[test]
fn daemon_version_query_prints_handover_version_only() {
    let d = tempfile::tempdir().unwrap();
    let home = d.path().join("h");
    let out = run(&home, &["d", "--handover-version"]);
    assert_eq!(out.status.code(), Some(0));
    assert_eq!(
        String::from_utf8_lossy(&out.stdout),
        format!("{}\n", otter_shared_handover::VERSION)
    );
    // FR-DSK-12: 홈을 건드리지 않는다.
    assert!(!home.exists());
}

#[test]
fn daemon_bad_args_exit_2_with_log_line() {
    let d = tempfile::tempdir().unwrap();
    let out = run(d.path(), &["d", "--bogus"]);
    assert_eq!(out.status.code(), Some(2));
    let err = String::from_utf8_lossy(&out.stderr);
    assert!(err.starts_with("time="), "{err}");
    assert!(
        err.ends_with(" level=ERROR msg=\"알 수 없는 데몬 인자: --bogus\"\n"),
        "{err}"
    );
    assert!(out.stdout.is_empty());
}

#[test]
fn cli_version_goes_through_dispatch() {
    let d = tempfile::tempdir().unwrap();
    let out = run(d.path(), &["version"]);
    assert_eq!(out.status.code(), Some(0));
    let s = String::from_utf8_lossy(&out.stdout);
    assert!(s.starts_with("otterminal "), "{s}");
    assert!(s.ends_with(" go1.27.2\n"), "{s}");
}

#[test]
fn unknown_action_is_cli_error_not_daemon() {
    let d = tempfile::tempdir().unwrap();
    let out = run(d.path(), &["no-such-action"]);
    assert_ne!(out.status.code(), Some(0));
    assert!(!d.path().join("paned.pid").exists());
}

#[cfg(unix)]
#[test]
fn helper_name_argv0_runs_helper() {
    let d = tempfile::tempdir().unwrap();
    let link = d.path().join("otterctl");
    std::os::unix::fs::symlink(BIN, &link).unwrap();
    let mut c = Command::new(&link);
    c.arg("--help");
    isolated(&mut c, d.path());
    let out = c.output().unwrap();
    let all = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(all.contains("otterctl"), "{all}");
    assert!(!all.contains("사용법: otterminal"), "{all}");
}
