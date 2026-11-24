//! 쓰기 종단의 잠금 (REPO_FIX 01 §5.4). Go `gitlock.go`.

use std::sync::Mutex;
use std::time::Duration;

use otter_webserver_domain_git_core::{self as core, Ctx};
use otter_webserver_domain_git_jobs::{Exclusion, Keys, Release};
use otter_webserver_domain_git_query as query;
use otter_webserver_domain_git_store::Store;

use crate::GitServer;

/// 종단이 쥐는 잠금의 모양이다.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum LockMode {
    /// 잠그지 않는다 — 잡 경로이거나 저장소를 바꾸지 않는다.
    None,
    /// toplevel 뮤텍스.
    Top,
    /// common-dir 잠금 + toplevel (stash 는 worktree 들이 나눠 쓴다).
    Stash,
}

/// POST 종단 → 잠금 모양. 표에 없는 POST 는 임대가 없다.
pub(crate) const WRITE_LOCKS: &[(&str, LockMode)] = &[
    ("/api/git/init", LockMode::None),
    ("/api/git/repos/pin", LockMode::None),
    ("/api/git/repos/unpin", LockMode::None),
    ("/api/git/stage", LockMode::Top),
    ("/api/git/unstage", LockMode::Top),
    ("/api/git/discard", LockMode::Top),
    ("/api/git/resolve", LockMode::Top),
    ("/api/git/commit", LockMode::Top),
    ("/api/git/undo-last", LockMode::Top),
    // 읽기 기록은 핸들러가 잠그지 않는다.
    ("/api/git/records/replay", LockMode::Top),
    ("/api/git/fetch", LockMode::None),
    ("/api/git/pull", LockMode::Top),
    ("/api/git/push", LockMode::None),
    ("/api/git/job/cancel", LockMode::None),
    ("/api/git/remote/add", LockMode::Top),
    ("/api/git/remote/remove", LockMode::Top),
    ("/api/git/checkout", LockMode::Top),
    ("/api/git/operation", LockMode::Top),
    ("/api/git/branch", LockMode::Top),
    ("/api/git/branch/rename", LockMode::Top),
    ("/api/git/branch/delete", LockMode::Top),
    ("/api/git/branch/merge", LockMode::Top),
    ("/api/git/branch/rebase", LockMode::Top),
    ("/api/git/branch/upstream", LockMode::Top),
    ("/api/git/branch/push", LockMode::None),
    ("/api/git/branch/fetch", LockMode::None),
    ("/api/git/branch/delete-remote", LockMode::None),
    ("/api/git/branch/delete-both", LockMode::Top),
    ("/api/git/stash/push", LockMode::Stash),
    ("/api/git/stash/apply", LockMode::Stash),
    ("/api/git/stash/pop", LockMode::Stash),
    ("/api/git/stash/drop", LockMode::Stash),
    ("/api/git/stash/branch", LockMode::Stash),
    ("/api/git/tag", LockMode::Top),
    ("/api/git/tag/delete", LockMode::Top),
    ("/api/git/tag/push", LockMode::None),
    ("/api/git/tag/delete-remote", LockMode::None),
    ("/api/git/ignore", LockMode::Top),
    ("/api/git/uncommitted/reset", LockMode::Top),
    ("/api/git/uncommitted/clean", LockMode::Top),
    ("/api/git/patch", LockMode::Top),
    ("/api/git/cherry-pick", LockMode::Top),
    ("/api/git/revert", LockMode::Top),
    ("/api/git/reset", LockMode::Top),
    ("/api/git/drop", LockMode::Top),
    ("/api/git/submodules/update", LockMode::None),
    ("/api/git/submodules/sync", LockMode::Top),
    ("/api/git/worktrees/create", LockMode::None),
    ("/api/git/worktrees/remove", LockMode::None),
    ("/api/git/lock/remove", LockMode::None),
];

/// 임대가 쥔 것 하나. 놓을 때는 쥔 역순이다.
pub(crate) enum Hold {
    Lock(Release),
    /// 사전 단계 문맥 — 놓을 때 취소한다.
    Cancel(Ctx),
}

/// 요청 하나의 잠금 임대다. 핸들러가 쥐고 `GitServer::handle` 이 놓는다.
pub(crate) struct WriteLease {
    pub(crate) mode: LockMode,
    holds: Mutex<Vec<Hold>>,
}

impl WriteLease {
    pub(crate) fn hold(&self, h: Hold) {
        self.holds.lock().unwrap_or_else(|e| e.into_inner()).push(h);
    }

    /// 쥔 역순으로 놓는다.
    pub(crate) fn release(&self) {
        let mut hs = std::mem::take(&mut *self.holds.lock().unwrap_or_else(|e| e.into_inner()));
        while let Some(h) = hs.pop() {
            match h {
                Hold::Lock(r) => r.release(),
                Hold::Cancel(c) => c.cancel(),
            }
        }
    }
}

/// Go `withLease`: POST 이고 표에 있는 종단만 임대를 받는다.
pub(crate) fn write_lease(method: &http::Method, path: &str) -> Option<WriteLease> {
    if method != http::Method::POST {
        return None;
    }
    let mode = WRITE_LOCKS.iter().find(|(p, _)| *p == path)?.1;
    Some(WriteLease {
        mode,
        holds: Mutex::new(Vec::new()),
    })
}

impl GitServer {
    /// 저장소 배타 상태. 주입이 없으면 처음 쓸 때 만든다.
    pub(crate) fn exclusion(&self) -> Exclusion {
        match &self.exclusion {
            Some(x) => x.clone(),
            None => self.own_exclusion.get_or_init(Exclusion::new).clone(),
        }
    }

    pub(crate) async fn git_keys(
        &self,
        git: &std::sync::Arc<Store>,
        ctx: &Ctx,
        root: &str,
    ) -> Result<Keys, query::Error> {
        let common = git.common_dir(ctx, root).await?;
        Ok(Keys {
            top: core::exclusion_key(root),
            common: core::exclusion_key(&common),
        })
    }

    /// 서버 수명의 문맥이다. git 이 없으면 Background 다.
    pub(crate) fn git_root(&self) -> Ctx {
        match &self.git {
            Some(g) => g.root().clone(),
            None => Ctx::background(),
        }
    }

    /// 관리자 경유 쓰기 단계의 마감이다.
    pub(crate) fn git_manager_write(&self) -> Duration {
        if self.manager_write.is_zero() {
            core::MANAGER_WRITE_TIMEOUT
        } else {
            self.manager_write
        }
    }

    pub(crate) fn git_lock_wait(&self) -> Duration {
        if self.lock_wait.is_zero() {
            core::LOCK_WAIT
        } else {
            self.lock_wait
        }
    }
}
