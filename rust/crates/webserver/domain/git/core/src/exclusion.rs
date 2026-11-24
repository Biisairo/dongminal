//! 쓰기 배타와 index.lock (REPO_FIX 01 §5·§7.2).

use std::time::Duration;

use otter_gocompat::filepath;
use serde::Serialize;

use crate::ctx::Ctx;
use crate::error::{Error, Kind};
use crate::exec::Service;

/// 잠금 하나를 기다리는 상한이다. 넘으면 409 repo_busy 다.
pub const LOCK_WAIT: Duration = Duration::from_secs(5);
/// 쓰기 전 검사·조회 전체의 마감이다.
pub const PRE_PHASE_TIMEOUT: Duration = Duration::from_secs(10);
/// 쓰기 뒤 무효화·재조회·lock 판정 전체의 마감이다.
pub const POST_PHASE_TIMEOUT: Duration = Duration::from_secs(15);
/// worktree·submodule Manager 경유 쓰기 단계의 마감이다.
pub const MANAGER_WRITE_TIMEOUT: Duration = Duration::from_secs(180);

/// 배타 키다 (§5.1). 존재하는 가장 가까운 조상까지 심링크를 풀고 나머지 조각을 붙인다.
pub fn exclusion_key(p: &str) -> String {
    let clean = filepath::clean(p);
    let mut dir = clean.clone();
    let mut tail: Vec<String> = Vec::new();
    loop {
        if let Ok(resolved) = filepath::eval_symlinks(&dir) {
            let mut parts = vec![resolved];
            parts.extend(tail);
            return filepath::join(&parts);
        }
        let parent = filepath::dir(&dir);
        if parent == dir {
            return clean;
        }
        tail.insert(0, filepath::base(&dir));
        dir = parent;
    }
}

/// common-dir 배타 키다 (§5.1). 수신자가 없어도 동작한다 (FR-GXU-4) — 기록만 생략한다.
pub async fn common_dir_key(svc: Option<&Service>, ctx: &Ctx, repo: &str) -> Result<String, Error> {
    let (_, common) = match svc {
        Some(s) => s.git_dirs(ctx, repo).await?,
        None => Service::new().git_dirs(ctx, repo).await?,
    };
    Ok(exclusion_key(&common))
}

/// index_locked 실패에 싣는 lock 정보다. 파일이 없으면 mtime 이 없다.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct LockInfo {
    pub path: String,
    #[serde(
        rename = "mtimeUnixMs",
        skip_serializing_if = "otter_gocompat::json::is_empty"
    )]
    pub mtime_unix_ms: Option<i64>,
}

impl Service {
    /// `common_dir_key(Some(self), ..)`.
    pub async fn common_dir_key(&self, ctx: &Ctx, repo: &str) -> Result<String, Error> {
        common_dir_key(Some(self), ctx, repo).await
    }

    /// root 의 index.lock 절대 경로다 (§7.2). 링크드 worktree 는 자기 gitdir 아래다.
    pub async fn index_lock_path(&self, ctx: &Ctx, root: &str) -> Result<String, Error> {
        let out = self
            .exec(ctx, root, &["rev-parse", "--git-path", "index.lock"])
            .await?;
        let stdout = out.stdout_str();
        let mut p = stdout.trim().to_owned();
        if p.is_empty() {
            return Err(Error::new(
                Kind::NotRepo,
                format!("rev-parse 가 index.lock 경로를 주지 않았다: {root}"),
            ));
        }
        if !filepath::is_abs(&p) {
            p = filepath::join(&[root, p.as_str()]);
        }
        Ok(filepath::clean(&p))
    }

    /// root 의 index.lock 경로와 mtime 이다. 경로를 구하지 못하면 None 이다.
    pub async fn index_lock_info(&self, ctx: &Ctx, root: &str) -> Option<LockInfo> {
        let path = self.index_lock_path(ctx, root).await.ok()?;
        let mtime_unix_ms = std::fs::symlink_metadata(&path)
            .and_then(|m| m.modified())
            .ok()
            .map(unix_ms);
        Some(LockInfo {
            path,
            mtime_unix_ms,
        })
    }
}

fn unix_ms(t: std::time::SystemTime) -> i64 {
    match t.duration_since(std::time::UNIX_EPOCH) {
        Ok(d) => d.as_millis() as i64,
        Err(e) => -(e.duration().as_millis() as i64),
    }
}

/// stderr 가 index.lock 을 만들지 못한 실패인가다.
pub fn index_locked_stderr(stderr: &str) -> bool {
    let low = stderr.to_lowercase();
    low.contains("unable to create '") && low.contains("index.lock': file exists")
}
