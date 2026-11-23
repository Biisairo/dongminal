use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use super::support::*;
use crate::{
    Error, Kind, Output, Service, UnguardedSpec, exec_unguarded, exec_unguarded_text,
    unguarded_text, unguarded_text_runner,
};

fn uspec(argv: &[&str], reason: &str) -> UnguardedSpec {
    UnguardedSpec {
        argv: argv.iter().map(|s| s.to_string()).collect(),
        reason: reason.into(),
        ..UnguardedSpec::default()
    }
}

fn seen_service(seen: Arc<Mutex<Vec<String>>>, o: Output) -> Service {
    Service::builder()
        .write_runner(write_runner(move |_, _, a, _| {
            *seen.lock().unwrap() = a;
            Ok(o.clone())
        }))
        .build()
}

// V1 (FR-GXU-1).
#[tokio::test]
async fn exec_unguarded_runs_command_outside_allowlist() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let s = seen_service(seen.clone(), out("worktree /x\n", "", 0));
    let sp = uspec(&["worktree", "list", "--porcelain"], "worktree 도메인");
    let o = s.exec_unguarded(&bg(), &abs_repo(), &sp).await.unwrap();
    assert_eq!(*seen.lock().unwrap(), sp.argv);
    assert_eq!(o.stdout, b"worktree /x\n");
    assert!(
        s.exec(&bg(), &abs_repo(), &sp.argv)
            .await
            .unwrap_err()
            .is(Kind::WriteCommand)
    );
}

// V2: 사유가 비면, dir 이 상대면 실행하지 않고 기록한다.
#[tokio::test]
async fn exec_unguarded_rejects() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let s = seen_service(seen.clone(), Output::default());
    assert!(
        s.exec_unguarded(&bg(), &abs_repo(), &uspec(&["worktree", "list"], ""))
            .await
            .is_err()
    );
    let err = s
        .exec_unguarded(
            &bg(),
            "relative/path",
            &uspec(&["worktree", "list"], "테스트"),
        )
        .await
        .unwrap_err();
    assert!(err.is(Kind::UnsafeArgument));
    assert!(
        s.exec_unguarded(&bg(), &abs_repo(), &uspec(&[], "테스트"))
            .await
            .is_err()
    );
    assert!(seen.lock().unwrap().is_empty());
    assert_eq!(s.records(0).len(), 3);
}

// V4 (FR-GXU-3): spec.timeout 이 기본을 대신하되 더 짧은 ctx 가 이긴다.
#[tokio::test]
async fn exec_unguarded_timeouts() {
    let dl = Arc::new(Mutex::new(None));
    let d2 = dl.clone();
    let s = Service::builder()
        .write_runner(write_runner(move |c, _, _, _| {
            *d2.lock().unwrap() = c.deadline();
            Ok(Output::default())
        }))
        .build();
    let want = Duration::from_secs(180);
    let start = Instant::now();
    let mut sp = uspec(&["submodule", "update", "--init"], "submodule 도메인");
    sp.timeout = want;
    s.exec_unguarded(&bg(), &abs_repo(), &sp).await.unwrap();
    assert!(dl.lock().unwrap().unwrap() - start >= want - Duration::from_secs(1));
    let short = bg().with_timeout(Duration::from_millis(50));
    let start = Instant::now();
    s.exec_unguarded(&short, &abs_repo(), &sp).await.unwrap();
    assert!(dl.lock().unwrap().unwrap() - start <= Duration::from_secs(1));
}

// V5 (FR-GXU-4): 수신자가 없어도 실행되고 규약이 적용된다.
#[tokio::test]
async fn exec_unguarded_nil_service_is_safe() {
    if git_path().is_none() {
        return;
    }
    let repo = git_repo();
    let o = exec_unguarded(
        None,
        &bg(),
        &repo.path,
        &uspec(&["status", "--porcelain"], "nil 안전성"),
    )
    .await
    .unwrap();
    assert_eq!(o.exit_code, 0);
}

// V6 (FR-GXU-5).
#[tokio::test]
async fn exec_unguarded_record_carries_mark() {
    let s = seen_service(Arc::default(), out("x", "", 0));
    s.exec_unguarded(
        &bg(),
        &abs_repo(),
        &uspec(&["worktree", "list"], "worktree 도메인"),
    )
    .await
    .unwrap();
    let r = s.records(0);
    assert!(r.len() == 1 && r[0].unguarded && r[0].reason == "worktree 도메인" && !r[0].write);
    let s = Service::builder()
        .runner(runner(|_, _, _| Ok(Output::default())))
        .build();
    s.exec(&bg(), &abs_repo(), &["status", "--porcelain"])
        .await
        .unwrap();
    assert!(!s.records(0)[0].unguarded);
}

#[test]
fn unguarded_text_shapes() {
    let o = out(" a \n", "warning: x\n", 0);
    assert_eq!(
        unguarded_text(&["status"], Ok(o.clone()), str::trim).unwrap(),
        "a"
    );
    let cause = Error::from_exec(crate::ExecError::new(
        vec![],
        String::new(),
        1,
        String::new(),
        None,
    ))
    .with_output(o);
    let f = unguarded_text(&["status", "-s"], Err(cause), str::trim).unwrap_err();
    assert_eq!(f.text, "a \nwarning: x");
    assert!(f.err.exec_error().is_some() && f.err.to_string().starts_with("git status -s: "));
}

// FR-RDG-61.
#[tokio::test]
async fn exec_unguarded_text_cases() {
    let sp = uspec(&["status"], "시험");
    let run = |r: Result<Output, Error>| {
        Service::builder()
            .write_runner(write_runner(move |_, _, _, _| r.clone()))
            .build()
    };
    let got = run(Ok(out(" a\n", "warn\n", 0)))
        .exec_unguarded_text(&bg(), &abs_repo(), &sp, str::trim)
        .await
        .unwrap();
    assert_eq!(got, "a");
    let f = run(Err(
        Error::new(Kind::GitMissing, "x").with_output(out("x", "", 0))
    ))
    .exec_unguarded_text(&bg(), &abs_repo(), &sp, str::trim)
    .await
    .unwrap_err();
    assert!(
        f.text.is_empty() && f.err.is(Kind::GitMissing) && f.err.to_string() == "git_missing: x"
    );
    let f = run(Ok(out("o\n", "e\n", 1)))
        .exec_unguarded_text(&bg(), &abs_repo(), &sp, str::trim)
        .await
        .unwrap_err();
    assert!(
        f.text == "o\ne"
            && f.err.exec_error().is_some()
            && f.err.to_string().starts_with("git status: ")
    );
    let f = exec_unguarded_text(None, &bg(), &abs_repo(), &uspec(&["status"], ""), str::trim)
        .await
        .unwrap_err();
    assert!(f.err.is(Kind::UnsafeArgument));
}

// FR-QG-50.
#[tokio::test]
async fn unguarded_text_runner_binds_spec() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let svc = Arc::new(seen_service(seen.clone(), out(" a\n", "", 0)));
    let run = unguarded_text_runner(Some(svc), Duration::from_secs(60), "시험", str::trim);
    let got = run(
        bg(),
        abs_repo(),
        vec!["status".into(), "--porcelain".into()],
    )
    .await
    .unwrap();
    assert_eq!(got, "a");
    assert_eq!(seen.lock().unwrap().join(" "), "status --porcelain");
    let run = unguarded_text_runner(None, Duration::ZERO, "", str::trim);
    assert!(
        run(bg(), abs_repo(), vec!["status".into()])
            .await
            .unwrap_err()
            .err
            .is(Kind::UnsafeArgument)
    );
}
