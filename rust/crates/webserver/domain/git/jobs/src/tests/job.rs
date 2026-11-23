//! Go `job_test.go` — 작업 인프라 (GIT_SRS §3B.1 FR-GIT-101~104).

use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime};

use dm_webserver_domain_git_core::{self as core, Ctx};
use tokio::sync::{Notify, mpsc};

use super::support::*;
use crate::exec::{exec_stream, read_lines};
use crate::{
    Emit, FIX_FORCE_WITH_LEASE, JOB_LINE_CAP, JOB_RETENTION, Jobs, JobsKind, JobsOptions,
    LINE_STDERR, LINE_STDOUT, Line, StartOptions,
};

fn jobs(o: JobsOptions) -> Jobs {
    Jobs::new(job_svc(), o)
}

fn with_runner(r: crate::JobRunner) -> JobsOptions {
    JobsOptions {
        runner: Some(r),
        ..JobsOptions::default()
    }
}

async fn drain(mut rx: mpsc::Receiver<Line>) -> Vec<Line> {
    let mut out = Vec::new();
    while let Some(ln) = tokio::time::timeout(Duration::from_secs(3), rx.recv())
        .await
        .expect("채널이 닫히지 않았다")
    {
        out.push(ln);
    }
    out
}

// R1 (V42, FR-GIT-102): 취소가 프로세스를 끝내고 그 사실이 작업에 남는다.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn job_cancel_ends_job_and_marks_canceled() {
    let started = Arc::new(Notify::new());
    let j = jobs(with_runner(block_runner(Some(started.clone()))));
    let repo = job_repo();
    let jb = j
        .start(
            &repo,
            keys_of(&repo),
            "fetch",
            job_fetch_spec(),
            StartOptions::default(),
        )
        .unwrap();
    notified(&started).await;
    assert!(j.cancel(&jb.id), "Cancel 이 거짓을 돌려줬다");
    let done = job_wait(&j, &jb.id, Duration::from_secs(2)).await;
    assert!(done.canceled, "Canceled = false: {done:?}");
    assert!(!done.err.is_empty(), "취소 사유가 비었다");
    assert!(j.active().is_empty(), "Active = {:?}", j.active());
}

#[cfg(unix)]
mod proc {
    use std::path::Path;
    use std::process::Command;
    use std::time::Instant;

    use super::*;

    fn sh(script: &str) -> Command {
        let mut c = Command::new("/bin/sh");
        c.args(["-c", script]);
        c
    }

    fn await_pid(path: &Path) -> i32 {
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            if let Ok(s) = std::fs::read_to_string(path)
                && let Ok(p) = s.trim().parse::<i32>()
                && p > 0
            {
                return p;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        panic!("{} 에서 자식 pid 를 읽지 못했다", path.display());
    }

    fn await_gone(pid: i32, d: Duration) {
        let p = &dm_shared_platform::current().process;
        let deadline = Instant::now() + d;
        while Instant::now() < deadline {
            if !p.alive(pid) {
                return;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let _ = p.kill(pid);
        panic!("pid {pid} 가 살아 있다 — 프로세스 그룹이 끝나지 않았다");
    }

    fn noop() -> Emit {
        Arc::new(|_, _| {})
    }

    async fn cancel_and_check(script: String, pid_file: &Path, limit: Duration) {
        let ctx = Ctx::background().with_cancel();
        let c2 = ctx.clone();
        let args = sv(&["-c", &script]);
        let h = tokio::spawn(async move {
            exec_stream(&c2, sh(&script), None, "/bin/sh", &args, noop()).await
        });
        let pf = pid_file.to_path_buf();
        let child = tokio::task::spawn_blocking(move || await_pid(&pf))
            .await
            .unwrap();
        ctx.cancel();
        tokio::time::timeout(limit, h)
            .await
            .expect("exec_stream 이 취소 후에도 돌아오지 않았다")
            .unwrap();
        tokio::task::spawn_blocking(move || await_gone(child, Duration::from_secs(5)))
            .await
            .unwrap();
    }

    // R1 (V42): 취소가 프로세스 그룹을 끝낸다.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn exec_stream_cancel_kills_process_group() {
        let dir = tempfile::tempdir().unwrap();
        let pid_file = dir.path().join("child.pid");
        let script = format!("sleep 300 & echo $! > {}; wait", pid_file.display());
        cancel_and_check(script, &pid_file, Duration::from_secs(10)).await;
    }

    // R1 (V42): SIGTERM 을 무시하는 자식도 유예 뒤 SIGKILL 로 끝난다.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn exec_stream_cancel_escalates_to_kill() {
        let dir = tempfile::tempdir().unwrap();
        let pid_file = dir.path().join("stubborn.pid");
        let inner = "trap '' TERM; while true; do sleep 1; done";
        let script = format!(
            "/bin/sh -c \"{inner}\" & echo $! > {}; wait",
            pid_file.display()
        );
        cancel_and_check(
            script,
            &pid_file,
            3 * core::KILL_GRACE + Duration::from_secs(10),
        )
        .await;
    }

    // R2 (V42): 실제 프로세스가 `\r` 로 낸 진행이 개별 Line 으로 도착한다.
    #[tokio::test]
    async fn job_progress_lines_arrive_individually() {
        let script = r"printf 'Receiving objects:  1%%\rReceiving objects: 100%%\rdone.\n' 1>&2";
        let got: Arc<Mutex<Vec<(String, String)>>> = Arc::default();
        let g2 = got.clone();
        let emit: Emit = Arc::new(move |s, t| g2.lock().unwrap().push((s.into(), t.into())));
        let (_, err) = exec_stream(
            &Ctx::background(),
            sh(script),
            None,
            "/bin/sh",
            &sv(&["-c", script]),
            emit,
        )
        .await;
        assert!(err.is_none(), "exec_stream: {err:?}");
        let got = got.lock().unwrap().clone();
        for (s, _) in &got {
            assert_eq!(s, LINE_STDERR);
        }
        let texts: Vec<String> = got.into_iter().map(|(_, t)| t).collect();
        assert_eq!(
            texts,
            sv(&["Receiving objects:  1%", "Receiving objects: 100%", "done."])
        );
    }
}

// R2 (V42, FR-GIT-103): `\r` 로 갱신되는 진행 줄이 개별 줄로 갈린다.
#[test]
fn read_lines_splits_on_carriage_return() {
    let cases: [(&str, &str, &[&str]); 4] = [
        (
            "진행 갱신",
            "Receiving objects:  1%\rReceiving objects: 52%\rReceiving objects: 100%\rdone.\n",
            &[
                "Receiving objects:  1%",
                "Receiving objects: 52%",
                "Receiving objects: 100%",
                "done.",
            ],
        ),
        ("CRLF 는 한 줄 끝", "a\r\nb\r\n", &["a", "b"]),
        ("끝에 구분자 없음", "tail", &["tail"]),
        ("빈 줄은 버린다", "a\n\n\nb\n", &["a", "b"]),
    ];
    for (name, input, want) in cases {
        let mut got = Vec::new();
        read_lines(
            Box::new(std::io::Cursor::new(input.as_bytes().to_vec())),
            |s| got.push(s.to_owned()),
        );
        assert_eq!(got, sv(want), "{name}");
    }
}

// R3 (V40, FR-GIT-101): 같은 리포의 두 번째 Start 는 JobBusy 다.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn job_start_same_repo_is_busy() {
    let started = Arc::new(Notify::new());
    let j = jobs(with_runner(block_runner(Some(started.clone()))));
    let repo = job_repo();
    let first = j
        .start(
            &repo,
            keys_of(&repo),
            "fetch",
            job_fetch_spec(),
            StartOptions::default(),
        )
        .unwrap();
    notified(&started).await;
    let err = j
        .start(
            &repo,
            keys_of(&repo),
            "push",
            spec(&["push", "--progress"], ""),
            StartOptions::default(),
        )
        .expect_err("JobBusy");
    assert!(err.is(JobsKind::JobBusy), "err = {err}");
    j.cancel(&first.id);
    job_wait(&j, &first.id, Duration::from_secs(2)).await;
    j.start(
        &repo,
        keys_of(&repo),
        "fetch",
        job_fetch_spec(),
        StartOptions::default(),
    )
    .expect("끝난 뒤 Start");
}

// R4: 다른 리포의 작업은 서로를 막지 않는다.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn job_start_other_repo_not_blocked() {
    let j = jobs(with_runner(block_runner(None)));
    for r in [abs_work_a(), abs_work_b()] {
        j.start(
            &r,
            keys_of(&r),
            "fetch",
            job_fetch_spec(),
            StartOptions::default(),
        )
        .unwrap_or_else(|e| panic!("{r}: {e}"));
    }
    assert_eq!(j.active().len(), 2);
}

// R8 (O9): 상한을 넘긴 작업은 종료되고 Err 에 사유가 남는다.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn job_ceiling_ends_job_with_reason() {
    let j = jobs(JobsOptions {
        ceiling: Some(Duration::from_millis(30)),
        ..with_runner(block_runner(None))
    });
    let repo = job_repo();
    let jb = j
        .start(
            &repo,
            keys_of(&repo),
            "fetch",
            job_fetch_spec(),
            StartOptions::default(),
        )
        .unwrap();
    let done = job_wait(&j, &jb.id, Duration::from_secs(3)).await;
    assert!(!done.canceled, "상한 초과는 사용자의 취소가 아니다");
    assert!(done.err.contains("상한"), "Err = {:?}", done.err);
}

// R9: JobLineCap 초과 시 앞에서 버리고 Seq 는 단조 증가한다.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn job_line_cap_drops_from_front() {
    const EXTRA: usize = 100;
    let j = jobs(with_runner(runner(|_, _, _, _, emit: Emit| async move {
        for i in 0..JOB_LINE_CAP + EXTRA {
            emit(LINE_STDOUT, &format!("줄 {i}"));
        }
        (0, None)
    })));
    let repo = job_repo();
    let jb = j
        .start(
            &repo,
            keys_of(&repo),
            "fetch",
            job_fetch_spec(),
            StartOptions::default(),
        )
        .unwrap();
    job_wait(&j, &jb.id, Duration::from_secs(3)).await;
    let (rx, _unsub) = j
        .subscribe(&jb.id, 0)
        .expect("Subscribe 가 거짓을 돌려줬다");
    let lines = drain(rx).await;
    assert_eq!(lines.len(), JOB_LINE_CAP);
    assert_eq!(lines[0].seq, EXTRA as u64 + 1, "앞에서 버리지 않았다");
    for w in lines.windows(2) {
        assert_eq!(w[1].seq, w[0].seq + 1, "Seq 가 단조 증가하지 않는다");
    }
}

// Subscribe 는 afterSeq 이후만 준다.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn job_subscribe_after_seq() {
    let j = jobs(with_runner(runner(|_, _, _, _, emit: Emit| async move {
        for i in 1..=5 {
            emit(LINE_STDOUT, &format!("줄 {i}"));
        }
        (0, None)
    })));
    let repo = job_repo();
    let jb = j
        .start(
            &repo,
            keys_of(&repo),
            "fetch",
            job_fetch_spec(),
            StartOptions::default(),
        )
        .unwrap();
    job_wait(&j, &jb.id, Duration::from_secs(3)).await;
    let (rx, _unsub) = j
        .subscribe(&jb.id, 3)
        .expect("Subscribe 가 거짓을 돌려줬다");
    let seqs: Vec<u64> = drain(rx).await.iter().map(|l| l.seq).collect();
    assert_eq!(seqs, [4, 5]);
}

// 진행 중 작업의 구독은 새 줄을 받고, 끝나면 채널이 닫힌다.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn job_subscribe_live_then_close() {
    let release = Arc::new(Notify::new());
    let r2 = release.clone();
    let j = jobs(with_runner(runner(move |_, _, _, _, emit: Emit| {
        let r = r2.clone();
        async move {
            r.notified().await;
            emit(LINE_STDERR, "진행 중");
            (0, None)
        }
    })));
    let repo = job_repo();
    let jb = j
        .start(
            &repo,
            keys_of(&repo),
            "fetch",
            job_fetch_spec(),
            StartOptions::default(),
        )
        .unwrap();
    let (rx, _unsub) = j
        .subscribe(&jb.id, 0)
        .expect("Subscribe 가 거짓을 돌려줬다");
    release.notify_one();
    let lines = drain(rx).await;
    assert_eq!(lines.len(), 1, "줄 = {lines:?}");
    assert_eq!(lines[0].text, "진행 중");
    assert_eq!(lines[0].stream, LINE_STDERR);
}

// 알 수 없는 작업의 구독은 거짓이다.
#[tokio::test]
async fn job_subscribe_unknown_id() {
    let j = jobs(JobsOptions::default());
    assert!(j.subscribe("없는-작업", 0).is_none());
    assert!(j.get("없는-작업").is_none());
    assert!(!j.cancel("없는-작업"));
}

// 표에 없거나 모양이 틀린 kind 는 받지 않는다 (REPO_FIX 01 §6.1).
#[tokio::test]
async fn job_start_rejects_non_remote_kind() {
    let j = jobs(with_runner(block_runner(None)));
    let repo = job_repo();
    let cases: [(&str, &str, &str, &[&str]); 4] = [
        ("작업이 아닌 종류", &repo, "commit", &["commit", "-m", "x"]),
        (
            "kind 와 argv 불일치",
            &repo,
            "fetch",
            &["push", "--progress"],
        ),
        ("읽기 명령", &repo, "fetch", &["status"]),
        ("상대 경로", "repo", "fetch", &["fetch", "--progress"]),
    ];
    for (name, r, kind, argv) in cases {
        assert!(
            j.start(r, keys_of(r), kind, spec(argv, ""), StartOptions::default())
                .is_err(),
            "{name}: 거부되지 않았다"
        );
    }
}

// 끝난 작업은 보존 기간이 지나면 사라진다.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn job_retention_drops_finished() {
    let now = Arc::new(Mutex::new(SystemTime::now()));
    let n2 = now.clone();
    let j = jobs(JobsOptions {
        clock: Some(Arc::new(move || *n2.lock().unwrap())),
        ..with_runner(done_runner(0, ""))
    });
    let repo = job_repo();
    let jb = j
        .start(
            &repo,
            keys_of(&repo),
            "fetch",
            job_fetch_spec(),
            StartOptions::default(),
        )
        .unwrap();
    job_wait(&j, &jb.id, Duration::from_secs(3)).await;
    {
        let mut t = now.lock().unwrap();
        *t += JOB_RETENTION + Duration::from_secs(1);
    }
    assert!(j.get(&jb.id).is_none(), "보존 기간이 지난 작업이 남아 있다");
}

// 완료 훅은 작업당 한 번 불린다.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn job_on_done_called_once() {
    let (tx, mut rx) = mpsc::unbounded_channel();
    let j = jobs(JobsOptions {
        on_done: Some(Arc::new(move |jb| {
            let _ = tx.send(jb.clone());
        })),
        ..with_runner(done_runner(0, ""))
    });
    let repo = job_repo();
    let jb = j
        .start(
            &repo,
            keys_of(&repo),
            "fetch",
            job_fetch_spec(),
            StartOptions::default(),
        )
        .unwrap();
    let got = tokio::time::timeout(Duration::from_secs(3), rx.recv())
        .await
        .expect("완료 훅이 불리지 않았다")
        .unwrap();
    assert!(
        got.id == jb.id && got.repo == repo && got.done,
        "훅이 받은 작업 = {got:?}"
    );
    if let Ok(Some(got)) = tokio::time::timeout(Duration::from_millis(50), rx.recv()).await {
        panic!("훅이 두 번 불렸다: {got:?}");
    }
}

// 인증 실패는 감지만 하고 자격증명을 요구하지 않는다 (FR-GIT-104, O10).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn job_auth_required_from_stderr() {
    let j = jobs(with_runner(done_runner(
        128,
        "fatal: could not read Username for 'https://example.com': terminal prompts disabled",
    )));
    let repo = job_repo();
    let jb = j
        .start(
            &repo,
            keys_of(&repo),
            "push",
            spec(&["push", "--progress"], ""),
            StartOptions::default(),
        )
        .unwrap();
    let done = job_wait(&j, &jb.id, Duration::from_secs(3)).await;
    assert!(done.auth_required, "AuthRequired = false: {done:?}");
    assert!(done.stderr_tail.contains("terminal prompts disabled"));
    assert!(
        !done.err.is_empty(),
        "exit {} 인데 사유가 비었다",
        done.exit_code
    );
}

// FR-GIT-105: non-fast-forward 거부는 force 를 기본 제안하지 않는다 — 목록에서 마지막이다.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn job_rejected_offers_fetch_first() {
    let j = jobs(with_runner(done_runner(
        1,
        " ! [rejected]        main -> main (non-fast-forward)",
    )));
    let repo = job_repo();
    let jb = j
        .start(
            &repo,
            keys_of(&repo),
            "push",
            spec(&["push", "--progress"], ""),
            StartOptions::default(),
        )
        .unwrap();
    let done = job_wait(&j, &jb.id, Duration::from_secs(3)).await;
    assert!(done.rejected, "Rejected = false: {done:?}");
    let opts = done.options.clone().unwrap_or_default();
    assert!(!opts.is_empty(), "후속 선택지가 없다");
    assert_ne!(opts[0], FIX_FORCE_WITH_LEASE, "force 가 첫 제안이다");
    assert_eq!(
        opts[opts.len() - 1],
        FIX_FORCE_WITH_LEASE,
        "force 가 마지막이 아니다"
    );
}

// R5 (V43): argv·출력 줄·실행 기록 전부에서 자격증명이 사라진다.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn job_sanitizes_credentials_everywhere() {
    const SECRET_URL: &str = "https://user:s3cr3t@example.com/o/r.git";
    let svc = job_svc();
    let j = Jobs::new(
        svc.clone(),
        with_runner(runner(
            |_, _, args: Vec<String>, _, emit: Emit| async move {
                if !args.join(" ").contains("s3cr3t") {
                    return (
                        -1,
                        Some(core::Error::other(format!(
                            "실행기가 원본 argv 를 받지 못했다: {args:?}"
                        ))),
                    );
                }
                emit(
                    LINE_STDERR,
                    &format!("fatal: unable to access '{SECRET_URL}': 401"),
                );
                (128, None)
            },
        )),
    );
    let repo = job_repo();
    let jb = j
        .start(
            &repo,
            keys_of(&repo),
            "push",
            spec(&["push", "--progress", SECRET_URL, "main"], ""),
            StartOptions::default(),
        )
        .unwrap();
    let done = job_wait(&j, &jb.id, Duration::from_secs(3)).await;
    let mut blob = format!(
        "{:?}\n{:?}\n{}\n{}",
        jb.argv, done.argv, done.err, done.stderr_tail
    );
    let (rx, _unsub) = j
        .subscribe(&jb.id, 0)
        .expect("Subscribe 가 거짓을 돌려줬다");
    for ln in drain(rx).await {
        blob += &format!("\n{}", ln.text);
    }
    for rec in svc.records(0) {
        blob += &format!("\n{:?}\n{}\n{}", rec.argv(), rec.stderr, rec.err);
    }
    assert!(!blob.contains("s3cr3t"), "자격증명이 남았다:\n{blob}");
    assert!(
        blob.contains("***@example.com"),
        "지운 흔적이 없다:\n{blob}"
    );
}

// 완료 훅은 끝이 공개되기 전에 불린다 (FR-GIT-107).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn job_on_done_runs_before_done_is_published() {
    let cell: Arc<OnceLock<Jobs>> = Arc::default();
    let c2 = cell.clone();
    let (tx, mut rx) = mpsc::unbounded_channel();
    let j = jobs(JobsOptions {
        on_done: Some(Arc::new(move |jb| {
            let cur = c2.get().and_then(|j| j.get(&jb.id));
            let _ = tx.send(cur.is_some_and(|c| c.done));
        })),
        ..with_runner(done_runner(0, ""))
    });
    let _ = cell.set(j.clone());
    let repo = job_repo();
    let jb = j
        .start(
            &repo,
            keys_of(&repo),
            "fetch",
            job_fetch_spec(),
            StartOptions::default(),
        )
        .unwrap();
    let published = tokio::time::timeout(Duration::from_secs(3), rx.recv())
        .await
        .expect("완료 훅이 불리지 않았다")
        .unwrap();
    assert!(!published, "훅이 불릴 때 이미 Done 이 공개돼 있다");
    job_wait(&j, &jb.id, Duration::from_secs(3)).await;
}

// M9_SRS FR-M9-18: 기록도 끝이 공개되기 전에 쓴다.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn job_record_is_written_before_done_is_published() {
    let svc = job_svc();
    let s2 = svc.clone();
    let (tx, mut rx) = mpsc::unbounded_channel();
    let j = Jobs::new(
        svc,
        JobsOptions {
            on_done: Some(Arc::new(move |_| {
                let _ = tx.send(s2.records(5).len());
            })),
            ..with_runner(done_runner(0, ""))
        },
    );
    let repo = job_repo();
    j.start(
        &repo,
        keys_of(&repo),
        "fetch",
        job_fetch_spec(),
        StartOptions::default(),
    )
    .unwrap();
    let n = tokio::time::timeout(Duration::from_secs(3), rx.recv())
        .await
        .expect("완료 훅이 불리지 않았다")
        .unwrap();
    assert_eq!(n, 1, "훅이 불릴 때 기록 {n}개");
}

// M8 D-A-27 (FBE-08): 인가를 호출자가 지는 작업 — 사유를 요구하고 기록은 Unguarded 표식과 사유를 든다.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn job_start_unguarded_records_reason_and_shares_machinery() {
    let svc = job_svc();
    let release = Arc::new(Notify::new());
    let r2 = release.clone();
    let j = Jobs::new(
        svc.clone(),
        with_runner(runner(move |_, _, args: Vec<String>, _, emit: Emit| {
            let r = r2.clone();
            async move {
                emit(LINE_STDERR, "Cloning into 'vendor/x'...");
                if args[0] != "submodule" {
                    return (2, None);
                }
                r.notified().await;
                (0, None)
            }
        })),
    );
    let repo = job_repo();
    let jb = j
        .start_unguarded(
            &repo,
            keys_of(&repo),
            "submodule",
            sv(&["submodule", "update", "--init", "--", "vendor/x"]),
            "테스트 사유",
            StartOptions::default(),
        )
        .unwrap();
    assert!(
        jb.kind == "submodule" && jb.argv[0] == "submodule",
        "job={jb:?}"
    );
    let err = j
        .start_unguarded(
            &repo,
            keys_of(&repo),
            "submodule",
            sv(&["submodule", "update"]),
            "x",
            StartOptions::default(),
        )
        .expect_err("같은 리포는 배타여야 한다");
    assert!(err.is(JobsKind::JobBusy), "err = {err}");
    release.notify_one();
    let fin = job_wait(&j, &jb.id, Duration::from_secs(1)).await;
    assert!(fin.exit_code == 0 && fin.err.is_empty(), "final={fin:?}");
    let recs = svc.records(5);
    assert!(
        recs.len() == 1
            && recs[0].unguarded
            && recs[0].reason == "테스트 사유"
            && recs[0].argv()[0] == "submodule",
        "기록: {recs:?}"
    );
}

#[tokio::test]
async fn job_start_unguarded_rejects_missing_reason_or_argv() {
    let j = jobs(with_runner(block_runner(None)));
    let repo = job_repo();
    let o = StartOptions::default;
    assert!(
        j.start_unguarded(
            &repo,
            keys_of(&repo),
            "submodule",
            sv(&["submodule", "update"]),
            "",
            o()
        )
        .is_err(),
        "사유 없는 인가 우회가 통과했다"
    );
    assert!(
        j.start_unguarded(&repo, keys_of(&repo), "submodule", Vec::new(), "x", o())
            .is_err(),
        "빈 argv 가 통과했다"
    );
    assert!(
        j.start_unguarded(
            "repo",
            keys_of("repo"),
            "submodule",
            sv(&["submodule"]),
            "x",
            o()
        )
        .is_err(),
        "상대 경로가 통과했다"
    );
    assert!(
        j.start_unguarded(&repo, keys_of(&repo), "fetch", sv(&["submodule"]), "x", o())
            .is_err(),
        "kind 와 argv 불일치가 통과했다"
    );
}

// FR-OPT-4-4: 목록이 바뀐 뒤 알린다 — 시작과 끝, 작업당 두 번.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn job_on_change_after_publish() {
    let release = Arc::new(Notify::new());
    let r2 = release.clone();
    let cell: Arc<OnceLock<Jobs>> = Arc::default();
    let c2 = cell.clone();
    let (tx, mut rx) = mpsc::unbounded_channel();
    let j = jobs(JobsOptions {
        on_change: Some(Arc::new(move || {
            let _ = tx.send(c2.get().map_or(usize::MAX, |j| j.active().len()));
        })),
        ..with_runner(runner(move |_, _, _, _, _| {
            let r = r2.clone();
            async move {
                r.notified().await;
                (0, None)
            }
        }))
    });
    let _ = cell.set(j.clone());
    let repo = job_repo();
    j.start(
        &repo,
        keys_of(&repo),
        "fetch",
        job_fetch_spec(),
        StartOptions::default(),
    )
    .unwrap();
    for (i, want) in [1usize, 0].into_iter().enumerate() {
        if i == 1 {
            release.notify_one();
        }
        let got = tokio::time::timeout(Duration::from_secs(3), rx.recv())
            .await
            .unwrap_or_else(|_| panic!("알림 {i} 이 오지 않았다"))
            .unwrap();
        assert_eq!(got, want, "알림 {i} 에서 Active");
    }
    if let Ok(Some(got)) = tokio::time::timeout(Duration::from_millis(50), rx.recv()).await {
        panic!("알림이 세 번 왔다 (Active={got})");
    }
}
