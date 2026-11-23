//! Go `resolve_test.go`.

use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use dm_webserver_domain_git_core::{self as core, Kind, Output, Recorder, Service};

use super::support::*;
use crate::*;

fn recording_svc() -> (Service, Arc<Mutex<Vec<Vec<String>>>>) {
    let argvs = Arc::new(Mutex::new(Vec::new()));
    let a2 = argvs.clone();
    let s = Service::builder()
        .runner(head_runner())
        .write_runner(write_runner(move |args, _| {
            a2.lock().unwrap().push(args.to_vec());
            Output::default()
        }))
        .build();
    (s, argvs)
}

#[tokio::test]
async fn resolve_checkout_then_add() {
    let (s, argvs) = recording_svc();
    resolve(
        &s,
        &bg(),
        &abs_tmp_repo(),
        RESOLVE_OURS,
        &sv(&["a.txt", "d ir/b.txt"]),
    )
    .await
    .unwrap();
    assert_eq!(
        *argvs.lock().unwrap(),
        vec![
            sv(&[
                "checkout",
                "--ours",
                "--",
                ":(literal)a.txt",
                ":(literal)d ir/b.txt"
            ]),
            sv(&["add", "--", ":(literal)a.txt", ":(literal)d ir/b.txt"]),
        ]
    );
    let hints = s.hints(0);
    assert!(
        hints.len() == 1 && hints[0].action == core::ACTION_RESOLVE_SIDE,
        "{hints:?}"
    );
    assert_eq!(hints[0].targets.as_ref().map(Vec::len), Some(2));
}

#[tokio::test]
async fn resolve_theirs_side() {
    let (s, argvs) = recording_svc();
    resolve(&s, &bg(), &abs_tmp_repo(), RESOLVE_THEIRS, &sv(&["a.txt"]))
        .await
        .unwrap();
    assert_eq!(argvs.lock().unwrap()[0][1], "--theirs");
}

#[tokio::test]
async fn resolve_checkout_is_declared_destructive() {
    let s = Service::builder()
        .runner(head_runner())
        .write_runner(write_runner(|_, _| Output::default()))
        .recorder(Arc::new(Recorder::new(core::DEFAULT_RECORD_CAP)))
        .build();
    resolve(&s, &bg(), &abs_tmp_repo(), RESOLVE_OURS, &sv(&["a.txt"]))
        .await
        .unwrap();
    let seen: Vec<bool> = s
        .records(0)
        .iter()
        .filter(|r| r.argv().first().is_some_and(|a| a == "checkout"))
        .map(|r| r.destructive)
        .collect();
    assert_eq!(seen, vec![true]);
}

#[tokio::test]
async fn resolve_rejects_bad_side_and_empty_paths() {
    let (s, _) = recording_svc();
    let e = resolve(&s, &bg(), &abs_tmp_repo(), "mine", &sv(&["a.txt"]))
        .await
        .unwrap_err();
    assert!(e.is_core(Kind::UnsafeArgument), "{e}");
    let e = resolve(&s, &bg(), &abs_tmp_repo(), RESOLVE_OURS, &[])
        .await
        .unwrap_err();
    assert!(e.is_core(Kind::UnsafeArgument), "{e}");
}

#[tokio::test]
async fn resolve_stops_when_checkout_fails() {
    let argvs = Arc::new(Mutex::new(Vec::new()));
    let a2 = argvs.clone();
    let s = Service::builder()
        .runner(head_runner())
        .write_runner(write_runner(move |args, _| {
            a2.lock().unwrap().push(args.to_vec());
            if args[0] == "checkout" {
                return out("", "fatal: 실패\n", 1);
            }
            Output::default()
        }))
        .build();
    let res = resolve(&s, &bg(), &abs_tmp_repo(), RESOLVE_OURS, &sv(&["a.txt"]))
        .await
        .unwrap();
    assert!(
        res.len() == 1 && !res[0].ok && !res[0].error.is_empty(),
        "{res:?}"
    );
    assert_eq!(argvs.lock().unwrap().len(), 1);
}

#[test]
fn resolve_side_is_destructive_action() {
    assert!(core::DESTRUCTIVE_ACTIONS.contains(&core::ACTION_RESOLVE_SIDE));
}

/// 충돌로 exit 1 이 나는 merge. 준비 단계라 실패를 무시한다.
pub(super) fn merge_ignoring_conflict(fx: &Fx, branch: &str) {
    let _ = Command::new("git")
        .args(["merge", "-q", branch])
        .current_dir(fx.dir())
        .env("GIT_CONFIG_GLOBAL", null_device())
        .env("GIT_CONFIG_SYSTEM", null_device())
        .output();
}

fn null_device() -> &'static str {
    if cfg!(windows) { "NUL" } else { "/dev/null" }
}

/// Go `conflictRepo`: f 는 수정/삭제 충돌(UD), g 는 양쪽 수정 충돌(UU).
fn conflict_repo() -> Option<Fx> {
    let repo = temp_repo()?;
    let d = repo.dir();
    git_run(d, &["config", "core.autocrlf", "false"]);
    for f in ["f", "g"] {
        write_file(d, f, "base\n");
    }
    git_run(d, &["add", "f", "g"]);
    git_run(d, &["commit", "-q", "-m", "base"]);
    git_run(d, &["checkout", "-q", "-b", "del"]);
    git_run(d, &["rm", "-q", "f"]);
    write_file(d, "g", "theirs\n");
    git_run(d, &["commit", "-q", "-am", "del f, edit g"]);
    git_run(d, &["checkout", "-q", "main"]);
    write_file(d, "f", "ours\n");
    write_file(d, "g", "ours\n");
    git_run(d, &["commit", "-q", "-am", "edit f g"]);
    merge_ignoring_conflict(&repo, "del");
    Some(repo)
}

#[tokio::test]
async fn resolve_deleted_side_removes_and_batch_continues() {
    let Some(repo) = conflict_repo() else { return };
    let res = resolve(
        &Service::new(),
        &bg(),
        repo.p(),
        RESOLVE_THEIRS,
        &sv(&["f", "g"]),
    )
    .await
    .unwrap();
    for r in &res {
        assert!(r.ok, "경로 {} 실패: {}", r.path, r.error);
    }
    assert!(!repo.join("f").exists(), "theirs 가 지운 f 가 남아 있다");
    assert_eq!(std::fs::read_to_string(repo.join("g")).unwrap(), "theirs\n");
    assert_eq!(git_run(repo.dir(), &["ls-files", "-u"]), "");
}

#[tokio::test]
async fn resolve_kept_side_checks_out() {
    let Some(repo) = conflict_repo() else { return };
    let res = resolve(&Service::new(), &bg(), repo.p(), RESOLVE_OURS, &sv(&["f"]))
        .await
        .unwrap();
    assert!(res.len() == 1 && res[0].ok, "{res:?}");
    assert_eq!(std::fs::read_to_string(repo.join("f")).unwrap(), "ours\n");
}

#[tokio::test]
async fn resolve_deadline_skips_remaining() {
    let ctx = bg().with_cancel();
    let calls = Arc::new(AtomicUsize::new(0));
    let (c2, cx) = (calls.clone(), ctx.clone());
    let s = Service::builder()
        .runner(head_runner())
        .write_runner(write_runner(move |args, _| {
            c2.fetch_add(1, Ordering::SeqCst);
            if args[0] == "add" {
                cx.cancel();
            }
            Output::default()
        }))
        .build();
    let paths: Vec<String> = (0..MAX_PATHS_PER_CALL + 2)
        .map(|i| format!("p{i}"))
        .collect();
    let res = resolve(&s, &ctx, &abs_tmp_repo(), RESOLVE_OURS, &paths)
        .await
        .unwrap();
    assert!(
        res[0].ok && res[MAX_PATHS_PER_CALL - 1].ok,
        "첫 묶음 = {:?}",
        res[0]
    );
    for r in &res[MAX_PATHS_PER_CALL..] {
        assert!(r.skipped && !r.ok, "남은 묶음 = {r:?}");
    }
    assert_eq!(calls.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn resolve_classified_batch_failure_is_not_retried() {
    let calls = Arc::new(AtomicUsize::new(0));
    let c2 = calls.clone();
    let s = Service::builder()
        .runner(head_runner())
        .write_runner(write_runner(move |_, _| {
            c2.fetch_add(1, Ordering::SeqCst);
            out(
                "",
                "fatal: Unable to create '/r/.git/index.lock': File exists.\n",
                128,
            )
        }))
        .build();
    let res = resolve(
        &s,
        &bg(),
        &abs_tmp_repo(),
        RESOLVE_OURS,
        &sv(&["a", "b", "c"]),
    )
    .await
    .unwrap();
    for r in &res {
        assert!(
            !r.ok && r.err.as_ref().is_some_and(|e| e.is_core(Kind::IndexLocked)),
            "{r:?}"
        );
    }
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}
