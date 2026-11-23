//! Go 기준선 `dongminal/internal/webserver/gitapi` 의 Rust 포팅. RUST_PORT_SRS 참고.
//!
//! `/api/git/*` HTTP 핸들러다. 합성 루트가 [`GitServer`] 를 만들고 [`GitServer::handle`] 로
//! 요청을 넘긴다. `None` 이면 이 표면의 요청이 아니다 — 호출자가 404 를 낸다.

// 도우미의 `Err` 는 다 만든 응답이다 — 한 번 만들어 곧바로 돌려줄 뿐이라 상자에 담지 않는다.
#![allow(clippy::result_large_err)]

mod answers;
mod blame;
mod blob;
mod handlers_git;
mod history;
mod init;
mod job;
mod lock;
mod lock_remove;
mod pins;
mod policy;
mod records;
mod replay;
mod reply;
mod req;
mod routes;
mod write;

use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use dm_webserver_domain_git_core::Service;
use dm_webserver_domain_git_jobs::{Exclusion, JobRunner, Jobs};
use dm_webserver_domain_git_store::{Observation, Store};

pub use dm_webserver_domain_wsentry::{Broadcaster, WorkspaceStore};
pub use req::{BodyError, ReqBody};

/// follow 대상 도구의 cwd 를 푸는 최소 표면이다.
pub trait ToolLocator: Send + Sync {
    fn cwd(&self, id: &str) -> String;
}

/// "이 저장소를 지금 보고 있다" 를 받는 쪽이다 (GIT_PUSH_OBSERVE_SRS §2.8 · GIT_WATCH_LEASE_SRS FR-GWL-7).
pub trait RepoWatcher: Send + Sync {
    fn note(&self, repo: &str, obs: &Observation);
    fn note_for(&self, repo: &str, obs: &Observation, client_id: &str);
    fn note_scoped(&self, repo: &str, obs: &Observation, client_id: &str, scope: &str);
    fn release_scope(&self, client_id: &str, scope: &str);
}

/// 푼 저장소 루트를 다뤄도 되는가다. 오류면 403 이다.
pub type RepoGuard = Arc<dyn Fn(&str) -> Result<(), String> + Send + Sync>;

/// `/api/git/*` 핸들러의 수신자다. `GitServer::default()` 뒤 pub 필드를 채운다.
#[derive(Default)]
pub struct GitServer {
    pub git: Option<Arc<Store>>,
    pub work: Option<Arc<dyn WorkspaceStore>>,
    pub commands: Option<Arc<dyn Broadcaster>>,
    pub tools: Option<Arc<dyn ToolLocator>>,
    /// 그림 전용 git 실행기다 (M9_SRS FR-M9-21). 없으면 그림 갈래가 서지 않는다.
    pub images: Option<Arc<Service>>,
    /// 없으면 제한하지 않는다.
    pub repo_guard: Option<RepoGuard>,
    pub watch: Option<Arc<dyn RepoWatcher>>,
    /// 저장소 배타 상태다 (REPO_FIX 01 §5.4). 없으면 처음 쓸 때 만든다.
    pub exclusion: Option<Exclusion>,
    /// 원격 작업의 실행기다. 없으면 실제 git 이다.
    pub job_runner: Option<JobRunner>,
    diffs: OnceLock<Arc<Service>>,
    own_exclusion: OnceLock<Exclusion>,
    // 잡 경로는 5.4.2 의 종단(fetch·pull·push·병합 등)이 처음 부른다.
    #[allow(dead_code)]
    jobs: Mutex<Option<Jobs>>,
    lock_wait: Duration,
}

impl GitServer {
    /// diff 본문·HEAD 판 열기의 실행기다 (OPTIMIZE_REFACTOR_SRS FR-OPT-15-1). 공용
    /// Service 의 출력 상한만 편집기 파일 상한으로 올린다. `git` 이 있을 때만 부른다.
    fn diff_git(&self, git: &Store) -> Arc<Service> {
        self.diffs
            .get_or_init(|| {
                Arc::new(
                    git.service()
                        .sized(dm_shared_editorlimit::FILE_MAX_BYTES as usize),
                )
            })
            .clone()
    }
}

#[cfg(test)]
mod tests;
