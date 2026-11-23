use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use super::support::*;
use crate::exec::{CappedBuffer, command_in};
#[cfg(unix)]
use crate::exec::{exec_git, forget_git, look_git};
use crate::{
    Ctx, CtxError, DEFAULT_MAX_OUTPUT, DEFAULT_RECORD_CAP, DEFAULT_TIMEOUT, Error, ExecError, Kind,
    Output, Service, command, launch_args, plain_exit,
};

fn waiting_runner(budget: Arc<Mutex<Option<Duration>>>) -> crate::Runner {
    Arc::new(move |ctx: Ctx, _, _| {
        let budget = budget.clone();
        Box::pin(async move {
            if let Some(dl) = ctx.deadline() {
                *budget.lock().unwrap() = Some(dl.saturating_duration_since(Instant::now()));
            }
            ctx.done().await;
            Err(
                Error::from_ctx(ctx.err().expect("끝난 ctx")).with_output(Output {
                    exit_code: -1,
                    ..Output::default()
                }),
            )
        })
    })
}

// 케이스 1 (V2, FR-GIT-2): Runner 가 받은 args 가 전달한 배열과 정확히 같다.
#[tokio::test]
async fn exec_args_passed_verbatim() {
    let want = ["log", "--format=%H %s", "-n", "3", "--", "a b;c$(x)"];
    let got = Arc::new(Mutex::new((String::new(), Vec::new())));
    let g = got.clone();
    let s = Service::builder()
        .runner(runner(move |_, dir, args| {
            *g.lock().unwrap() = (dir, args);
            Ok(out("ok\n", "", 0))
        }))
        .build();
    let o = s.exec(&bg(), &abs_tmp_repo(), &want).await.unwrap();
    assert_eq!(o.stdout, b"ok\n");
    let (dir, args) = got.lock().unwrap().clone();
    assert_eq!(dir, abs_tmp_repo());
    assert_eq!(args, want);
}

// 케이스 2 (V2, FR-GIT-3): 짧은 ctx 가 이기고, 마감 초과는 Timeout.
#[tokio::test]
async fn exec_caller_deadline_wins() {
    let budget = Arc::new(Mutex::new(None));
    let s = Service::builder()
        .runner(waiting_runner(budget.clone()))
        .timeout(Duration::from_secs(10))
        .build();
    let ctx = bg().with_timeout(Duration::from_millis(30));
    let err = s
        .exec(&ctx, &abs_tmp_repo(), &["status"])
        .await
        .unwrap_err();
    assert!(err.is(Kind::Timeout), "{err}");
    assert_eq!(err.to_string(), "git_timeout: context deadline exceeded");
    let b = budget.lock().unwrap().expect("마감");
    assert!(!b.is_zero() && b <= Duration::from_secs(1), "{b:?}");
}

// FR-GIT-217: 취소는 마감 초과와 섞이지 않는다.
#[tokio::test]
async fn exec_caller_cancel_is_canceled() {
    let s = Service::builder()
        .runner(waiting_runner(Arc::default()))
        .timeout(Duration::from_secs(10))
        .build();
    let ctx = bg().with_cancel();
    let c2 = ctx.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(20)).await;
        c2.cancel();
    });
    let err = s
        .exec(&ctx, &abs_tmp_repo(), &["status"])
        .await
        .unwrap_err();
    assert!(err.is(Kind::Canceled), "{err}");
    assert!(!err.is(Kind::Timeout));
}

// 호출자가 마감을 주지 않으면 기본 상한이 걸린다 (FR-GIT-3).
#[tokio::test]
async fn exec_default_timeout_applied() {
    let budget = Arc::new(Mutex::new(None));
    let b2 = budget.clone();
    let s = Service::builder()
        .timeout(Duration::from_secs(2))
        .runner(runner(move |ctx, _, _| {
            let dl = ctx.deadline().expect("기본 타임아웃이 걸리지 않았다");
            *b2.lock().unwrap() = Some(dl.saturating_duration_since(Instant::now()));
            Ok(Output::default())
        }))
        .build();
    s.exec(&bg(), &abs_tmp_repo(), &["status"]).await.unwrap();
    let b = budget.lock().unwrap().unwrap();
    assert!(
        b > Duration::from_secs(1) && b <= Duration::from_secs(2),
        "{b:?}"
    );
}

// 케이스 3 (V2, FR-GIT-8): stderr 분류.
#[tokio::test]
async fn exec_classifies_stderr() {
    let cases = [
        (
            "fatal: not a git repository (or any of the parent directories): .git\n",
            128,
            Some(Kind::NotRepo),
        ),
        (
            "fatal: 'x' is not a working tree\n",
            128,
            Some(Kind::NotRepo),
        ),
        ("error: unknown option `zz'\n", 129, None),
    ];
    for (stderr, exit, want) in cases {
        let s = Service::builder()
            .runner(runner(move |_, _, _| Ok(out("", stderr, exit))))
            .build();
        let err = s
            .exec(&bg(), &abs_tmp_repo(), &["status"])
            .await
            .unwrap_err();
        let xe = err.exec_error().expect("ExecError");
        assert_eq!(
            (xe.exit_code, xe.stderr.as_str(), xe.cwd.clone()),
            (exit, stderr, abs_tmp_repo())
        );
        assert_eq!(err.kind(), want, "{err}");
        assert_eq!(xe.kind(), want);
        assert_eq!(err.output().unwrap().exit_code, exit);
    }
}

// 케이스 4 (V2, FR-GIT-8): PATH 에 git 이 없으면 GitMissing. 소실이 아니다 (§2.2).
#[tokio::test]
async fn exec_git_missing() {
    let empty = temp_dir();
    let dir = temp_dir();
    let s = Service::builder().path_env(&empty.path).build();
    let err = s
        .exec(&bg(), &dir.path, &["rev-parse", "--show-toplevel"])
        .await
        .unwrap_err();
    assert!(err.is(Kind::GitMissing), "{err}");
    assert!(!err.is(Kind::RepoMissing));
    let want = if cfg!(windows) { "%PATH%" } else { "$PATH" };
    assert_eq!(
        err.to_string(),
        format!("git_missing: exec: \"git\": executable file not found in {want}")
    );
    let recs = s.records(0);
    assert!(
        recs.len() == 1 && !recs[0].err.is_empty() && recs[0].exit_code == -1,
        "{recs:?}"
    );
}

#[tokio::test]
async fn exec_rejects_bad_dir() {
    for dir in ["", "  ", "relative/path", "./x"] {
        let s = Service::builder()
            .runner(runner(|_, _, _| panic!("Runner 가 호출되면 안 된다")))
            .build();
        let err = s.exec(&bg(), dir, &["status"]).await.unwrap_err();
        assert!(err.is(Kind::UnsafeArgument), "{dir:?}: {err}");
        assert_eq!(err.output().unwrap().exit_code, -1);
    }
}

// 케이스 8 (V15, FR-GIT-6).
#[test]
fn capped_buffer_truncates() {
    let b = CappedBuffer::new(4);
    assert_eq!(b.write(b"abc"), 3);
    assert_eq!(b.write(b"defgh"), 5);
    assert_eq!(b.bytes(), b"abcd");
    assert!(b.is_truncated());
}

fn big_staged_repo() -> Option<Temp> {
    git_path()?;
    let repo = git_repo();
    std::fs::write(
        Path::new(&repo.path).join("big.txt"),
        "0123456789".repeat(500),
    )
    .unwrap();
    git_run(&repo.path, &["add", "big.txt"]);
    Some(repo)
}

#[tokio::test]
async fn exec_max_output_truncates() {
    let Some(repo) = big_staged_repo() else {
        return;
    };
    let s = Service::builder().max_output(1024).build();
    let o = s
        .exec(&bg(), &repo.path, &["show", ":big.txt"])
        .await
        .unwrap();
    assert!(o.stdout_truncated);
    assert!(o.stdout.len() <= 1024);
    let recs = s.records(1);
    assert!(
        recs[0].stdout_truncated && recs[0].stdout_bytes <= 1024,
        "{recs:?}"
    );
}

// 케이스 12 (V1, FR-GIT-2): 셸을 경유하지 않는다.
#[tokio::test]
async fn exec_git_no_shell() {
    if git_path().is_none() {
        return;
    }
    let repo = git_repo();
    let marker = Path::new(&repo.path).join("pwned");
    let m = marker.to_string_lossy();
    let arg = format!("$(touch {m});touch {m}");
    let err = Service::new()
        .exec(&bg(), &repo.path, &["rev-parse", "--verify", arg.as_str()])
        .await
        .unwrap_err();
    let xe = err.exec_error().expect("ExecError");
    assert_eq!(xe.argv[2], arg);
    assert!(!marker.exists());
}

#[tokio::test]
async fn exec_git_environment() {
    if git_path().is_none() {
        return;
    }
    let repo = git_repo();
    let o = Service::new()
        .exec(&bg(), &repo.path, &["rev-parse", "--show-toplevel"])
        .await
        .unwrap();
    let got = dm_gocompat::filepath::clean(o.stdout_str().trim());
    assert_eq!(got, dm_gocompat::filepath::clean(&repo.path));
    assert!(o.duration_ms >= 0);
}

// FR-RMS-1·2: 작업 디렉터리가 없으면 RepoMissing 이고 경로가 사유에 실린다.
#[tokio::test]
async fn exec_repo_missing() {
    let Some(bin) = git_path() else { return };
    let base = temp_dir();
    let gone = dm_gocompat::filepath::join(&[base.path.as_str(), "gone"]);
    let err = Service::new()
        .exec(&bg(), &gone, &["rev-parse", "--show-toplevel"])
        .await
        .unwrap_err();
    assert!(err.is(Kind::RepoMissing), "{err}");
    assert!(err.to_string().contains(&gone));
    if cfg!(unix) {
        assert_eq!(
            err.to_string(),
            format!("repo_missing: chdir {gone}: fork/exec {bin}: no such file or directory")
        );
    }
}

// FR-RMS-5: git 이 실행되어 stderr 로 실패한 것은 소실이 아니다.
#[tokio::test]
async fn exec_repo_missing_does_not_swallow_other_failures() {
    let cases = [
        (
            "fatal: could not read Username for 'https://x': Permission denied\n",
            128,
        ),
        ("fatal: not a git repository: '.git'\n", 128),
        ("error: unknown option `zz'\n", 129),
    ];
    for (stderr, exit) in cases {
        let s = Service::builder()
            .runner(runner(move |_, _, _| Ok(out("", stderr, exit))))
            .build();
        let err = s
            .exec(&bg(), &abs_tmp_repo(), &["status"])
            .await
            .unwrap_err();
        assert!(!err.is(Kind::RepoMissing), "{err}");
    }
}

// FR-OPT-15-1: sized 는 출력 상한만 다르다 — 기록은 같은 링이다.
#[tokio::test]
async fn service_sized_shares_records_only() {
    let Some(repo) = big_staged_repo() else {
        return;
    };
    let base = Service::builder().max_output(1024).build();
    let big = base.sized(1 << 20);
    assert_eq!((base.max_output(), big.max_output()), (1024, 1 << 20));
    let o = big
        .exec(&bg(), &repo.path, &["show", ":big.txt"])
        .await
        .unwrap();
    assert!(!o.stdout_truncated && o.stdout.len() == 5000);
    let o = base
        .exec(&bg(), &repo.path, &["show", ":big.txt"])
        .await
        .unwrap();
    assert!(o.stdout_truncated);
    assert_eq!(base.records(0).len(), 2);
}

#[tokio::test]
async fn service_sized_keeps_injected_runner() {
    let called = Arc::new(AtomicUsize::new(0));
    let c = called.clone();
    let base = Service::builder()
        .runner(runner(move |_, _, _| {
            c.fetch_add(1, Ordering::SeqCst);
            Ok(out("ok", "", 0))
        }))
        .build();
    let dir = temp_dir();
    base.sized(1 << 20)
        .exec(&bg(), &dir.path, &["status"])
        .await
        .unwrap();
    assert_eq!(called.load(Ordering::SeqCst), 1);
}

// FR-OPT-7-1: 기동 자리가 중립화 인자·환경을 붙인다.
#[test]
fn command_adds_launch_args_and_env() {
    if git_path().is_none() {
        return;
    }
    let gc = command(&abs_tmp_repo(), &["log", "-n", "1"], "").unwrap();
    let args: Vec<String> = gc
        .cmd
        .get_args()
        .map(|a| a.to_string_lossy().into_owned())
        .collect();
    assert_eq!(args.join(" "), "-c log.showSignature=false log -n 1");
    assert_eq!(
        gc.cmd.get_current_dir().unwrap().to_string_lossy(),
        abs_tmp_repo()
    );
    assert!(gc.stdin.is_none());
    let envs: Vec<String> = gc
        .cmd
        .get_envs()
        .map(|(k, v)| {
            format!(
                "{}={}",
                k.to_string_lossy(),
                v.unwrap_or_default().to_string_lossy()
            )
        })
        .collect();
    for want in [
        "GIT_TERMINAL_PROMPT=0",
        "GIT_OPTIONAL_LOCKS=0",
        "LC_ALL=C",
        "GIT_ASKPASS=",
    ] {
        assert!(envs.iter().any(|e| e == want), "{want}: {envs:?}");
    }
    let full = crate::env();
    assert_eq!(full.last().map(String::as_str), Some("LC_ALL=C"));
    assert_eq!(
        command(&abs_tmp_repo(), &["log"], "x")
            .unwrap()
            .stdin
            .as_deref(),
        Some("x")
    );
    assert_eq!(launch_args(&["a"]), ["-c", "log.showSignature=false", "a"]);
}

#[cfg(unix)]
fn fake_git(dir: &str, script: &str) -> String {
    use std::os::unix::fs::PermissionsExt;
    let p = Path::new(dir).join("git");
    std::fs::write(&p, script).unwrap();
    std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
    p.to_string_lossy().into_owned()
}

// 같은 PATH 면 캐시를 쓰고, PATH 가 바뀌면 다시 찾는다. 캐시는 프로세스 전역이므로
// 캐시를 보는 시험은 이 하나에 몬다.
#[cfg(unix)]
#[tokio::test]
async fn look_git_cache_and_vanished_bin() {
    let a = temp_dir();
    let b = temp_dir();
    let bin_a = fake_git(&a.path, "#!/bin/sh\nexit 0\n");
    let bin_b = fake_git(&b.path, "#!/bin/sh\nexit 0\n");

    // 다른 시험이 같은 캐시를 바꿀 수 있어 잠그고 연달아 본다.
    static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _g = SERIAL.lock().await;

    assert_eq!(look_git(Some(&a.path)).unwrap(), bin_a);
    std::fs::remove_file(&bin_a).unwrap();
    // 캐시가 답한다 — 지워도 같은 PATH 에서는 다시 훑지 않는다 (다른 시험이 캐시를
    // 바꾸지 않았다면).
    if let Ok(got) = look_git(Some(&a.path)) {
        assert_eq!(got, bin_a);
    }
    assert_eq!(look_git(Some(&b.path)).unwrap(), bin_b);

    // 캐시된 bin 이 사라지면 부재로 답하고, 다음 실행은 PATH 를 다시 훑는다.
    let Some(real) = git_path() else { return };
    let repo = git_repo();
    let c = temp_dir();
    let bin_c = fake_git(&c.path, "#!/bin/sh\nexit 0\n");
    look_git(Some(&c.path)).unwrap();
    std::fs::remove_file(&bin_c).unwrap();
    let args = vec!["status".to_owned()];
    let err = exec_git(
        &bg(),
        &repo.path,
        &args,
        DEFAULT_MAX_OUTPUT,
        "",
        Some(&c.path),
    )
    .await
    .unwrap_err();
    assert!(err.is(Kind::GitMissing), "{err}");
    let path = format!(
        "{}{}{}",
        dm_gocompat::filepath::dir(&real),
        dm_gocompat::filepath::LIST_SEPARATOR,
        c.path
    );
    exec_git(
        &bg(),
        &repo.path,
        &args,
        DEFAULT_MAX_OUTPUT,
        "",
        Some(&path),
    )
    .await
    .unwrap();
    forget_git();
}

// P-4: 가드 뒤에 `-c log.showSignature=false` 를 앞에 붙인다.
#[cfg(unix)]
#[tokio::test]
async fn exec_git_prepends_show_signature_off() {
    let dir = temp_dir();
    fake_git(&dir.path, "#!/bin/sh\nprintf '%s\\n' \"$@\"\n");
    let args: Vec<String> = ["log", "-n", "1"].map(String::from).to_vec();
    let o = exec_git(
        &bg(),
        &dir.path,
        &args,
        DEFAULT_MAX_OUTPUT,
        "",
        Some(&dir.path),
    )
    .await
    .unwrap();
    assert_eq!(
        o.stdout_str().trim(),
        "-c\nlog.showSignature=false\nlog\n-n\n1"
    );
}

// 신호로 죽은 git 은 exit -1 과 Go 의 ProcessState 문구다.
#[cfg(unix)]
#[tokio::test]
async fn exec_git_signal_is_unclassified_failure() {
    let dir = temp_dir();
    fake_git(&dir.path, "#!/bin/sh\nkill -9 $$\n");
    let args = vec!["status".to_owned()];
    let err = exec_git(
        &bg(),
        &dir.path,
        &args,
        DEFAULT_MAX_OUTPUT,
        "",
        Some(&dir.path),
    )
    .await
    .unwrap_err();
    assert_eq!(err.kind(), None);
    assert_eq!(err.to_string(), "git status: signal: killed");
    assert_eq!(err.output().unwrap().exit_code, -1);
}

#[test]
fn command_missing_git_message() {
    let empty = temp_dir();
    let err = command_in(&abs_tmp_repo(), &["status"], "", Some(&empty.path))
        .err()
        .unwrap();
    assert!(err.is(Kind::GitMissing));
}

// plain_exit 는 분류되지 않은 종료만 참이다.
#[test]
fn plain_exit_only_unclassified() {
    let plain = Error::from_exec(ExecError::new(
        vec![],
        String::new(),
        1,
        String::new(),
        None,
    ));
    assert_eq!(plain_exit(&plain).unwrap().exit_code, 1);
    assert!(plain_exit(&plain.clone().wrap("ctx")).is_some());
    let classified = Error::from_exec(ExecError::new(
        vec![],
        String::new(),
        128,
        String::new(),
        Some(Kind::NotRepo),
    ));
    assert!(plain_exit(&classified).is_none());
    assert!(plain_exit(&Error::new(Kind::Timeout, "x")).is_none());
}

#[test]
fn exec_error_display() {
    let e = ExecError::new(
        vec!["show".into(), "x".into()],
        "/r".into(),
        128,
        "  fatal: bad\n".into(),
        None,
    );
    assert_eq!(e.to_string(), "git show x (exit 128): fatal: bad");
    let e = ExecError::new(
        vec!["status".into()],
        "/r".into(),
        1,
        " \n".into(),
        Some(Kind::NotRepo),
    );
    assert_eq!(
        e.to_string(),
        "not_a_git_repo: git status (exit 1): (stderr 없음)"
    );
}

#[tokio::test]
async fn service_default_recorder() {
    let s = Service::builder()
        .runner(runner(|_, _, _| Ok(Output::default())))
        .build();
    s.exec(&bg(), &abs_tmp_repo(), &["status"]).await.unwrap();
    assert_eq!(s.records(0).len(), 1);
    assert_eq!(DEFAULT_TIMEOUT, Duration::from_secs(30));
    assert_eq!(DEFAULT_MAX_OUTPUT, 1 << 20);
    assert_eq!(DEFAULT_RECORD_CAP, 500);
}

// TC-ATF-9: ctx 오류 분류는 한 함수다.
#[test]
fn ctx_err_classifies() {
    use crate::ctx_err;
    assert!(ctx_err(&bg(), "기다리는 중").is_none());
    let dl = bg().with_timeout(Duration::ZERO);
    let e = ctx_err(&dl, "기다리는 중").unwrap();
    assert!(e.is(Kind::Timeout) && e.is_ctx(CtxError::DeadlineExceeded));
    assert_eq!(
        e.to_string(),
        "git_timeout: 기다리는 중: context deadline exceeded"
    );
    let gone = bg().with_cancel();
    gone.cancel();
    let e = ctx_err(&gone, "기다리는 중").unwrap();
    assert!(e.is(Kind::Canceled) && !e.is(Kind::Timeout));
    assert_eq!(e.to_string(), "git_canceled: 기다리는 중: context canceled");
}

// 먼저 일어난 사유가 남는다 (Go 와 같다).
#[tokio::test]
async fn ctx_first_reason_wins() {
    let c = bg().with_timeout(Duration::from_millis(20));
    c.cancel();
    tokio::time::sleep(Duration::from_millis(40)).await;
    assert_eq!(c.err(), Some(CtxError::Canceled));
    let child = c.with_cancel();
    assert_eq!(child.err(), Some(CtxError::Canceled));
    let d = bg().with_timeout(Duration::from_millis(10));
    tokio::time::sleep(Duration::from_millis(20)).await;
    d.cancel();
    assert_eq!(d.err(), Some(CtxError::DeadlineExceeded));
}
