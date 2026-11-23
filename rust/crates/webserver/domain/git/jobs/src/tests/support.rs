//! 시험 보조 (Go `testpaths_test.go`·`job_test.go` 의 도우미).

use std::sync::Arc;
use std::time::{Duration, Instant};

use dm_webserver_domain_git_core::{self as core, Ctx, Output, Service, WriteSpec};
use tokio::sync::Notify;

use crate::{Emit, Job, JobRunner, Jobs, Keys, LINE_STDERR};

pub(crate) fn abs(parts: &[&str]) -> String {
    dm_shared_testpath::abs(parts)
        .to_string_lossy()
        .into_owned()
}

pub(crate) fn abs_work_a() -> String {
    abs(&["work", "a"])
}
pub(crate) fn abs_work_b() -> String {
    abs(&["work", "b"])
}
pub(crate) fn job_repo() -> String {
    abs(&["work", "repo"])
}

/// 읽기·쓰기 실행기를 함께 막은 Service.
pub(crate) fn job_svc() -> Arc<Service> {
    Arc::new(
        Service::builder()
            .runner(Arc::new(|_, _, _| {
                Box::pin(async { Ok(Output::default()) })
            }))
            .write_runner(Arc::new(|_, _, _, _| {
                Box::pin(async { Ok(Output::default()) })
            }))
            .build(),
    )
}

pub(crate) fn keys_of(repo: &str) -> Keys {
    Keys {
        top: repo.to_owned(),
        common: repo.to_owned(),
    }
}

pub(crate) fn spec(argv: &[&str], stdin: &str) -> WriteSpec {
    WriteSpec {
        argv: argv.iter().map(|s| (*s).to_owned()).collect(),
        destructive: false,
        stdin: stdin.to_owned(),
    }
}

pub(crate) fn job_fetch_spec() -> WriteSpec {
    spec(&["fetch", "--progress"], "")
}

pub(crate) fn job_commit_spec() -> WriteSpec {
    spec(&["commit", "--file=-", "--cleanup=strip"], "m")
}

pub(crate) fn sv(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| (*s).to_owned()).collect()
}

/// 실행기를 async 클로저로 만든다.
pub(crate) fn runner<F, Fut>(f: F) -> JobRunner
where
    F: Fn(Ctx, String, Vec<String>, String, Emit) -> Fut + Send + Sync + 'static,
    Fut: std::future::Future<Output = (i32, Option<core::Error>)> + Send + 'static,
{
    Arc::new(move |c, d, a, s, e| Box::pin(f(c, d, a, s, e)))
}

/// 취소되거나 상한을 넘길 때까지 매달린다. `started` 는 첫 줄을 낸 뒤 알린다.
pub(crate) fn block_runner(started: Option<Arc<Notify>>) -> JobRunner {
    runner(move |ctx: Ctx, _, _, _, emit: Emit| {
        let started = started.clone();
        async move {
            emit(LINE_STDERR, "remote: 세는 중");
            if let Some(n) = started {
                n.notify_one();
            }
            ctx.done().await;
            (-1, ctx.err().map(core::Error::from_ctx))
        }
    })
}

/// 곧바로 exit 로 끝나며 stderr 를 한 줄 낸다.
pub(crate) fn done_runner(exit: i32, stderr: &str) -> JobRunner {
    let stderr = stderr.to_owned();
    runner(move |_, _, _, _, emit: Emit| {
        let stderr = stderr.clone();
        async move {
            if !stderr.is_empty() {
                emit(LINE_STDERR, &stderr);
            }
            (exit, None)
        }
    })
}

/// 작업이 끝나기를 기다린다 (Go `jobWait`).
pub(crate) async fn job_wait(j: &Jobs, id: &str, d: Duration) -> Job {
    let deadline = Instant::now() + d;
    while Instant::now() < deadline {
        if let Some(jb) = j.get(id)
            && jb.done
        {
            return jb;
        }
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
    panic!("작업 {id} 가 {d:?} 안에 끝나지 않았다");
}

/// 알림을 상한 안에 받는다.
pub(crate) async fn notified(n: &Notify) {
    tokio::time::timeout(Duration::from_secs(5), n.notified())
        .await
        .expect("알림이 오지 않았다");
}
