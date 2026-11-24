//! Go `operation_test.go`·`replay_test.go`.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use otter_webserver_domain_git_core::{Output, Record, Service};
use otter_webserver_domain_git_query as query;

use super::support::*;
use crate::*;

#[test]
fn operation_args_per_kind() {
    let cases = [
        (query::OP_MERGE, OP_CONTINUE, ["merge", "--continue"]),
        (query::OP_MERGE, OP_ABORT, ["merge", "--abort"]),
        (query::OP_REBASE, OP_CONTINUE, ["rebase", "--continue"]),
        (query::OP_REBASE, OP_ABORT, ["rebase", "--abort"]),
        (query::OP_REBASE, OP_SKIP, ["rebase", "--skip"]),
        (
            query::OP_CHERRY_PICK,
            OP_CONTINUE,
            ["cherry-pick", "--continue"],
        ),
        (query::OP_CHERRY_PICK, OP_ABORT, ["cherry-pick", "--abort"]),
        (query::OP_CHERRY_PICK, OP_SKIP, ["cherry-pick", "--skip"]),
        (query::OP_REVERT, OP_CONTINUE, ["revert", "--continue"]),
        (query::OP_REVERT, OP_ABORT, ["revert", "--abort"]),
        (query::OP_REVERT, OP_SKIP, ["revert", "--skip"]),
    ];
    for (kind, action, want) in cases {
        assert_eq!(
            operation_args(kind, action).unwrap(),
            sv(&want),
            "{kind}/{action}"
        );
    }
}

#[test]
fn operation_args_rejects() {
    let cases = [
        (query::OP_NONE, OP_ABORT),
        ("", ""),
        (query::OP_BISECT, OP_CONTINUE),
        (query::OP_BISECT, OP_SKIP),
        (query::OP_MERGE, OP_SKIP),
        (query::OP_REBASE, "start"),
        (query::OP_REBASE, "--abort"),
    ];
    for (kind, action) in cases {
        let e = operation_args(kind, action).unwrap_err();
        assert!(e.is(WriteKind::Operation), "{kind:?}/{action:?}: {e}");
    }
}

#[test]
fn operation_spec_destructive() {
    for (action, want) in [(OP_CONTINUE, false), (OP_SKIP, false), (OP_ABORT, true)] {
        let spec = operation_spec(query::OP_REBASE, action).unwrap();
        assert_eq!(spec.destructive, want, "{action}");
    }
}

// ── replay_test.go ──

fn flagging_service(read: bool, write: bool) -> (Service, Arc<AtomicBool>) {
    let called = Arc::new(AtomicBool::new(false));
    let mut b = Service::builder();
    if read {
        let c = called.clone();
        b = b.runner(runner(move |_| {
            c.store(true, Ordering::SeqCst);
            Output::default()
        }));
    }
    if write {
        let c = called.clone();
        b = b.write_runner(write_runner(move |_, _| {
            c.store(true, Ordering::SeqCst);
            Output::default()
        }));
    }
    (b.build(), called)
}

#[tokio::test]
async fn replay_rejects_unguarded_record() {
    let (s, called) = flagging_service(true, true);
    let rec = Record {
        argv: Some(sv(&["worktree", "remove", "--force", "/tmp/x"])),
        cwd: abs_repo(),
        unguarded: true,
        reason: "worktree 도메인".into(),
        ..Record::default()
    };
    let e = replay(&s, &bg(), &abs_repo(), &rec).await.unwrap_err();
    assert!(e.is(WriteKind::ReplayTarget), "{e}");
    assert!(!called.load(Ordering::SeqCst), "실행기까지 닿았다");
    assert!(e.to_string().contains("인가"), "{e}");
}

#[tokio::test]
async fn replay_allows_guarded_record() {
    let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
    let s2 = seen.clone();
    let s = Service::builder()
        .runner(runner(move |a| {
            *s2.lock().unwrap() = a.to_vec();
            Output::default()
        }))
        .build();
    let rec = Record {
        argv: Some(sv(&["status", "--porcelain"])),
        cwd: abs_repo(),
        ..Record::default()
    };
    replay(&s, &bg(), &abs_repo(), &rec).await.unwrap();
    assert_eq!(seen.lock().unwrap().join(" "), "status --porcelain");
}

#[tokio::test]
async fn replay_rejects_stdin_record() {
    let (s, called) = flagging_service(false, true);
    let rec = Record {
        argv: Some(sv(&["tag", "-a", "v1", "-F", "-"])),
        cwd: abs_repo(),
        write: true,
        stdin_bytes: 12,
        ..Record::default()
    };
    let e = replay(&s, &bg(), &abs_repo(), &rec).await.unwrap_err();
    assert!(e.is(WriteKind::ReplayTarget), "{e}");
    assert!(!called.load(Ordering::SeqCst), "stdin 기록이 재실행됐다");
}

#[tokio::test]
async fn replay_rejects_stash_write_record() {
    let (s, called) = flagging_service(false, true);
    let rec = Record {
        argv: Some(sv(&["stash", "drop", "stash@{0}"])),
        cwd: abs_repo(),
        write: true,
        ..Record::default()
    };
    let e = replay(&s, &bg(), &abs_repo(), &rec).await.unwrap_err();
    assert!(e.is(WriteKind::ReplayTarget), "{e}");
    assert!(!called.load(Ordering::SeqCst), "stash 기록이 재실행됐다");
}
