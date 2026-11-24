//! Go `exclusion_test.go` — 배타 상태 (REPO_FIX 01 §5.4).

use std::sync::Arc;
use std::time::{Duration, Instant};

use otter_webserver_domain_git_core::{Ctx, Kind};
use tokio::sync::Notify;

use super::support::*;
use crate::{Exclusion, Jobs, JobsKind, JobsOptions, Keys, SLOT_COMMON, SLOT_INDEX, slots_of};

const TEST_WAIT: Duration = Duration::from_millis(60);

#[tokio::test]
async fn lock_top_waits_then_repo_busy() {
    let x = Exclusion::new();
    let bg = Ctx::background();
    let release = x.lock_top(&bg, "/k", TEST_WAIT).await.unwrap();
    let started = Instant::now();
    let err = x
        .lock_top(&bg, "/k", TEST_WAIT)
        .await
        .err()
        .expect("RepoBusy");
    assert!(err.is(JobsKind::RepoBusy), "err = {err}");
    assert!(
        started.elapsed() >= TEST_WAIT,
        "상한 {TEST_WAIT:?} 을 기다리지 않았다"
    );
    release.release();
    let r2 = x
        .lock_top(&bg, "/k", TEST_WAIT)
        .await
        .expect("반납 뒤 LockTop");
    r2.release();
    assert!(x.idle());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn lock_top_acquires_when_released_during_wait() {
    let x = Exclusion::new();
    let bg = Ctx::background();
    let release = x.lock_top(&bg, "/k", TEST_WAIT).await.unwrap();
    tokio::spawn(async move {
        tokio::time::sleep(TEST_WAIT / 3).await;
        release.release();
    });
    let r2 = x
        .lock_top(&bg, "/k", Duration::from_secs(1))
        .await
        .expect("대기 중 반납된 잠금을 얻지 못했다");
    r2.release();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn lock_top_canceled_while_waiting() {
    let x = Exclusion::new();
    let release = x
        .lock_top(&Ctx::background(), "/k", TEST_WAIT)
        .await
        .unwrap();
    let ctx = Ctx::background().with_cancel();
    let c2 = ctx.clone();
    tokio::spawn(async move {
        tokio::time::sleep(TEST_WAIT / 3).await;
        c2.cancel();
    });
    let err = x
        .lock_top(&ctx, "/k", Duration::from_secs(1))
        .await
        .err()
        .expect("취소");
    assert!(err.is_core(Kind::Canceled), "err = {err}");
    release.release();
    assert!(x.idle(), "취소된 대기자가 잠금 자리를 남겼다");
}

// 잠금이 비어 있어도 요청이 이미 떠났으면 쥐지 않는다.
#[tokio::test]
async fn lock_top_already_canceled() {
    let x = Exclusion::new();
    let ctx = Ctx::background().with_cancel();
    ctx.cancel();
    let err = x.lock_top(&ctx, "/k", TEST_WAIT).await.err().expect("취소");
    assert!(err.is_core(Kind::Canceled), "err = {err}");
    assert!(x.idle(), "떠난 요청이 잠금을 쥐었다");
}

#[tokio::test]
async fn keys_and_kinds_independent() {
    let x = Exclusion::new();
    let bg = Ctx::background();
    let a = x.lock_top(&bg, "/a", TEST_WAIT).await.unwrap();
    let b = x
        .lock_top(&bg, "/b", TEST_WAIT)
        .await
        .expect("다른 키가 막혔다");
    // 같은 문자열이어도 common-dir 잠금은 toplevel 뮤텍스와 다른 자리다.
    let c = x
        .lock_common(&bg, "/a", TEST_WAIT)
        .await
        .expect("common-dir 잠금이 toplevel 뮤텍스에 막혔다");
    a.release();
    b.release();
    c.release();
    assert!(x.idle(), "모두 반납했는데 자리가 남았다");
}

#[test]
fn try_lock_top() {
    let x = Exclusion::new();
    let release = x.try_lock_top("/k").expect("빈 잠금을 TryLock 하지 못했다");
    assert!(
        x.try_lock_top("/k").is_none(),
        "쥔 잠금을 TryLock 이 또 얻었다"
    );
    release.release();
    let r2 = x.try_lock_top("/k").expect("반납 뒤 TryLock 실패");
    drop(r2);
    assert!(x.idle());
}

// 칸 확인 — index 칸은 toplevel 키, common 칸은 common-dir 키로 찾는다.
#[test]
fn exclusion_slots() {
    let x = Exclusion::new();
    let k = Keys {
        top: "/wt".into(),
        common: "/main/.git".into(),
    };
    x.claim(&k, &slots_of("pull"), "j1").unwrap();
    assert_eq!(x.index_busy("/wt").as_deref(), Some("j1"));
    assert_eq!(x.common_busy("/main/.git").as_deref(), Some("j1"));
    let other = Keys {
        top: "/other".into(),
        common: "/main/.git".into(),
    };
    let err = x.claim(&other, &slots_of("fetch"), "j2").unwrap_err();
    assert!(err.is(JobsKind::JobBusy), "err = {err}");
    assert!(
        x.index_busy("/other").is_none(),
        "실패한 claim 이 칸을 남겼다"
    );
    x.free(&k, &slots_of("pull"), "j1");
    assert!(x.index_busy("/wt").is_none(), "free 뒤에도 index 칸이 찼다");
    assert!(
        x.common_busy("/main/.git").is_none(),
        "free 뒤에도 common 칸이 찼다"
    );
}

#[test]
fn slots_of_kinds() {
    let cases: [(&str, &[&str]); 7] = [
        ("pull", &[SLOT_INDEX, SLOT_COMMON]),
        ("fetch", &[SLOT_COMMON]),
        ("push", &[SLOT_COMMON]),
        ("submodule", &[SLOT_COMMON]),
        ("worktree", &[SLOT_COMMON]),
        ("commit", &[SLOT_INDEX]),
        ("merge", &[SLOT_INDEX]),
    ];
    for (kind, want) in cases {
        assert_eq!(slots_of(kind), sv(want), "{kind}");
    }
}

// §5.4: pull 은 두 칸을 차지하고, 끝나면 두 칸을 비운다. Active 는 한 번만 준다.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn job_start_pull_holds_both_slots() {
    let started = Arc::new(Notify::new());
    let x = Exclusion::new();
    let j = Jobs::new(
        job_svc(),
        JobsOptions {
            runner: Some(block_runner(Some(started.clone()))),
            exclusion: Some(x.clone()),
            ..JobsOptions::default()
        },
    );
    let (a, b, repo) = (abs_work_a(), abs_work_b(), job_repo());
    let k = Keys {
        top: a.clone(),
        common: repo.clone(),
    };
    let jb = j
        .start(
            &a,
            k,
            "pull",
            spec(&["pull", "--progress"], ""),
            Default::default(),
        )
        .unwrap();
    notified(&started).await;
    assert!(
        x.index_busy(&a).is_some(),
        "pull 이 index 칸을 차지하지 않았다"
    );
    let k2 = Keys {
        top: b.clone(),
        common: repo.clone(),
    };
    let err = j
        .start(&b, k2, "fetch", job_fetch_spec(), Default::default())
        .expect_err("JobBusy");
    assert!(err.is(JobsKind::JobBusy), "err = {err}");
    assert_eq!(j.active().len(), 1, "pull 은 한 번");
    j.cancel(&jb.id);
    job_wait(&j, &jb.id, Duration::from_secs(2)).await;
    assert!(x.index_busy(&a).is_none(), "끝난 pull 이 index 칸을 남겼다");
    assert!(
        x.common_busy(&repo).is_none(),
        "끝난 pull 이 common 칸을 남겼다"
    );
}

// §5.4: fetch·push 는 common 칸만 차지한다.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn job_start_fetch_leaves_index_slot_free() {
    let started = Arc::new(Notify::new());
    let x = Exclusion::new();
    let j = Jobs::new(
        job_svc(),
        JobsOptions {
            runner: Some(block_runner(Some(started.clone()))),
            exclusion: Some(x.clone()),
            ..JobsOptions::default()
        },
    );
    let a = abs_work_a();
    let k = Keys {
        top: a.clone(),
        common: job_repo(),
    };
    let jb = j
        .start(&a, k, "fetch", job_fetch_spec(), Default::default())
        .unwrap();
    notified(&started).await;
    assert!(x.index_busy(&a).is_none(), "fetch 가 index 칸을 차지했다");
    j.cancel(&jb.id);
    job_wait(&j, &jb.id, Duration::from_secs(2)).await;
}
