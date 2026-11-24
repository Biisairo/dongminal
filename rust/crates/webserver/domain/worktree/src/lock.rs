//! 저장소 잠금 (FR-WKT-7, 개정). 인스턴스가 아니라 저장소(common-dir 키)로 잡는다 — 사용자
//! 영역의 두 번째 Manager 가 같은 저장소를 건드려도 서로를 본다(D13).
//!
//! 저장소별 잠금은 지우지 않는다. 저장소 수는 사람이 열거나 핀한 리포 수준이라 무한히 늘지 않는다.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use otter_gocompat::time::format_std_duration;
use otter_webserver_domain_git_core::{self as core, Ctx, CtxError};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

use crate::error::{Error, Kind};

static REPO_LOCKS: LazyLock<Mutex<HashMap<String, Arc<Semaphore>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// 쥔 저장소 잠금. 놓거나 `release` 하면 반납한다. 여러 번 반납해도 한 번만 반납된다.
#[derive(Debug)]
pub struct RepoLock {
    permit: Option<OwnedSemaphorePermit>,
}

impl RepoLock {
    pub fn release(&mut self) {
        self.permit.take();
    }
}

/// 끝난 ctx 의 분류다 (core.CtxErr).
pub(crate) fn ctx_err(ctx: &Ctx) -> Option<Error> {
    core::ctx_err(ctx, "worktree 잠금을 기다리는 중").map(Error::from)
}

/// 저장소 잠금을 wait 까지(ctx 마감이 짧으면 그때까지) 기다려 쥔다 (REPO_FIX 01 §5.6).
///
/// key 는 common-dir 키다(`core::common_dir_key`). 정규화(심링크·표기)는 여기서 한 번 더 한다.
pub async fn lock_repo(ctx: &Ctx, key: &str, wait: Duration) -> Result<RepoLock, Error> {
    if let Some(e) = ctx_err(ctx) {
        return Err(e);
    }
    let k = core::exclusion_key(key);
    let sem = {
        let mut locks = REPO_LOCKS.lock().unwrap_or_else(|e| e.into_inner());
        locks
            .entry(k.clone())
            .or_insert_with(|| Arc::new(Semaphore::new(1)))
            .clone()
    };
    tokio::select! {
        p = sem.acquire_owned() => match p {
            Ok(permit) => Ok(RepoLock { permit: Some(permit) }),
            Err(_) => Err(Error::other("worktree 잠금이 닫혔다")),
        },
        _ = ctx.done() => Err(ctx_err(ctx).unwrap_or_else(|| Error::from(core::Error::from(CtxError::Canceled)))),
        _ = tokio::time::sleep(wait) => Err(Error::new(
            Kind::RepoBusy,
            format!("{k} 의 worktree 조작이 {} 안에 끝나지 않았다", format_std_duration(wait)),
        )),
    }
}
