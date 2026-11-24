//! Go `attic_test.go` — 잡 수명의 결함 (ATTIC_FIX_SRS ATT-1).

use std::sync::Arc;
use std::time::Duration;

use tokio::sync::mpsc::error::TryRecvError;
use tokio::sync::{Notify, mpsc};

use super::support::*;
use crate::exec::read_lines;
use crate::{
    Emit, Exclusion, JOB_LINE_MAX, JobRunner, Jobs, JobsOptions, LINE_STDOUT, StartOptions,
    on_finish,
};

// TC-ATF-6 (FR-ATF-6, D-ATF-3): finish 에 든 잡의 Cancel 은 false 다.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn job_cancel_false_while_finishing() {
    let in_hook = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let j = Jobs::new(
        job_svc(),
        JobsOptions {
            runner: Some(done_runner(0, "")),
            ..JobsOptions::default()
        },
    );
    let (ih, rl) = (in_hook.clone(), release.clone());
    let repo = job_repo();
    let jb = j
        .start(
            &repo,
            keys_of(&repo),
            "commit",
            job_commit_spec(),
            on_finish(Box::new(move |_, jb| {
                Box::pin(async move {
                    ih.notify_one();
                    rl.notified().await;
                    jb
                })
            })),
        )
        .unwrap();
    notified(&in_hook).await;
    let got = j.cancel(&jb.id);
    release.notify_one();
    let fin = job_wait(&j, &jb.id, Duration::from_secs(2)).await;
    assert!(!got, "완료 훅이 도는 동안 Cancel 이 true 를 돌려줬다");
    assert!(
        !fin.canceled && fin.err.is_empty(),
        "결과가 바뀌었다: {fin:?}"
    );
}

// TC-ATF-7 (FR-ATF-7, AT-GJB-2): 상한의 두 배에 닿을 때 한 번에 자른다. 보이는 줄 수는 그대로 상한이다.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn job_line_cap_trims_in_bulk() {
    const LINE_CAP: usize = 4;
    let (etx, mut erx) = mpsc::channel::<usize>(1);
    let next = Arc::new(Notify::new());
    let n2 = next.clone();
    let j = Jobs::new(
        job_svc(),
        JobsOptions {
            line_cap: Some(LINE_CAP),
            runner: Some(runner(move |_, _, _, _, emit: Emit| {
                let (etx, next) = (etx.clone(), n2.clone());
                async move {
                    for i in 1..=2 * LINE_CAP {
                        emit(LINE_STDOUT, &format!("줄 {i}"));
                        let _ = etx.send(i).await;
                        next.notified().await;
                    }
                    (0, None)
                }
            })),
            ..JobsOptions::default()
        },
    );
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
    for _ in 0..2 * LINE_CAP {
        let n = tokio::time::timeout(Duration::from_secs(3), erx.recv())
            .await
            .expect("줄이 오지 않았다")
            .unwrap();
        let want = if n == 2 * LINE_CAP { LINE_CAP } else { n };
        assert_eq!(j.stored_lines(&jb.id), want, "{n} 줄 뒤 보존");
        if n == LINE_CAP + 2 {
            let (mut rx, unsub) = j.subscribe(&jb.id, 0).unwrap();
            let mut seqs = Vec::new();
            while seqs.len() < LINE_CAP {
                seqs.push(rx.recv().await.unwrap().seq);
            }
            unsub.cancel();
            assert!(
                seqs[0] == 3
                    && matches!(
                        rx.try_recv(),
                        Err(TryRecvError::Empty | TryRecvError::Disconnected)
                    ),
                "재생 = {seqs:?}, want 3..6 의 {LINE_CAP} 줄"
            );
        }
        next.notify_one();
    }
    job_wait(&j, &jb.id, Duration::from_secs(2)).await;
}

async fn assert_panic_fails_and_frees(o: JobsOptions, st: StartOptions) {
    let x = Exclusion::new();
    let j = Jobs::new(
        job_svc(),
        JobsOptions {
            exclusion: Some(x.clone()),
            ..o
        },
    );
    let repo = job_repo();
    let jb = j
        .start(&repo, keys_of(&repo), "commit", job_commit_spec(), st)
        .unwrap();
    let fin = job_wait(&j, &jb.id, Duration::from_secs(2)).await;
    assert!(fin.err.contains("panic"), "Err = {:?}", fin.err);
    assert!(x.index_busy(&repo).is_none(), "panic 뒤에도 칸이 찼다");
}

// TC-ATF-8 (FR-ATF-8, D-ATF-4): 실행기의 panic 은 그 잡의 실패이고 칸이 빈다.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn job_runner_panic_fails_job_and_frees_slot() {
    let in_future: JobRunner = runner(|_, _, _, _, _| async { panic!("실행기 고장") });
    // Go 의 실행기는 동기 함수다 — 미래를 만들기 전의 panic 도 같은 실패여야 한다.
    let before_future: JobRunner = Arc::new(|_, _, _, _, _| panic!("실행기 고장"));
    for r in [in_future, before_future] {
        assert_panic_fails_and_frees(
            JobsOptions {
                runner: Some(r),
                ..JobsOptions::default()
            },
            StartOptions::default(),
        )
        .await;
    }
}

// FR-ATF-8: 완료 훅의 panic 도 그 잡의 실패이고 칸이 빈다.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn job_finisher_panic_fails_job_and_frees_slot() {
    // onDone
    assert_panic_fails_and_frees(
        JobsOptions {
            runner: Some(done_runner(0, "")),
            on_done: Some(Arc::new(|_| panic!("훅 고장"))),
            ..JobsOptions::default()
        },
        StartOptions::default(),
    )
    .await;
    // finish — 미래 안의 panic
    assert_panic_fails_and_frees(
        JobsOptions {
            runner: Some(done_runner(0, "")),
            ..JobsOptions::default()
        },
        on_finish(Box::new(|_, _| Box::pin(async { panic!("훅 고장") }))),
    )
    .await;
    // finish — 미래를 만들기 전의 panic
    assert_panic_fails_and_frees(
        JobsOptions {
            runner: Some(done_runner(0, "")),
            ..JobsOptions::default()
        },
        on_finish(Box::new(|_, _| panic!("훅 고장"))),
    )
    .await;
}

// TC-ATF-10 (FR-ATF-10, AT-GJB-8): 상한 줄 끊기는 UTF-8 룬 경계에서 한다.
#[test]
fn read_lines_cuts_on_rune_boundary() {
    let head = "a".repeat(JOB_LINE_MAX - 1);
    let input = format!("{head}가나\n");
    let mut got = Vec::new();
    read_lines(Box::new(std::io::Cursor::new(input.into_bytes())), |s| {
        got.push(s.to_owned())
    });
    assert_eq!(got.len(), 2, "줄 = {}개", got.len());
    assert_eq!(got[0], head);
    assert_eq!(got[1], "가나");
    for (i, s) in got.iter().enumerate() {
        assert!(!s.contains('\u{FFFD}'), "{i} 번째 줄이 깨졌다");
    }
}
