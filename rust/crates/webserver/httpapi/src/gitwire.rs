//! `/api/git/*` 의 배선 (Go `server.go` 의 `newGitServer`·`submoduleManager`).
//!
//! git 표면은 gitapi 가 소유한다. 여기는 주입 표면(`Deps`)으로 `GitServer` 를 세워 `GitHandler`
//! 자리에 꽂는 것뿐이다.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use dm_shared_httpresp::Response;
use dm_webserver_domain_git_core::Service;
use dm_webserver_domain_git_jobs::Job;
use dm_webserver_domain_git_store::Store;
use dm_webserver_domain_submodule as submodule;
use dm_webserver_domain_wsentry as wsentry;
use dm_webserver_gitapi::{GitServer, ToolLocator};

use crate::serve::GitHandler;
use crate::toolhub::ToolHub;
use crate::{BrokerCast, Deps, ReqBody};

/// gitapi 를 `GitHandler` 로 감싼다.
pub(crate) struct GitApi(pub(crate) Arc<GitServer>);

impl GitHandler for GitApi {
    fn handle(
        &self,
        req: http::Request<ReqBody>,
        req_id: Option<String>,
    ) -> Pin<Box<dyn Future<Output = Option<Response>> + Send + '_>> {
        Box::pin(self.0.handle(req, req_id))
    }

    fn active_jobs(&self) -> Option<Vec<Job>> {
        self.0.active_jobs()
    }
}

/// follow 대상 도구의 cwd 를 도구 허브에서 푼다.
struct ToolCwd(Arc<dyn ToolHub>);

impl ToolLocator for ToolCwd {
    fn cwd(&self, id: &str) -> String {
        self.0.cwd(id)
    }
}

/// 서브모듈 관리자는 git 이 있을 때만 선다 (UX_BATCH5_SRS FR-SUB-1). 실행은 core 의 실행 층을
/// 지난다 (GIT_EXEC_UNIFY_SRS FR-GXU-10).
fn submodule_manager(git: Option<&Arc<Store>>) -> Option<Arc<submodule::Manager>> {
    let git = git?;
    Some(Arc::new(submodule::Manager::new(submodule::runner_for(
        Some(Arc::clone(git.service())),
    ))))
}

/// `/api/git/*` 처리기를 세운다. git 이 없어도 세운다 — 그 표면은 503 이다 (FR-GIT-60).
/// 그림 전용 실행기의 출력 상한은 파일 종단과 같다 (M9_SRS FR-M9-21). `RepoGuard` 는 주입하지
/// 않는다 (FILE_API_BOUNDARY_SRS 묶음 G 폐기).
pub(crate) fn new_git_server(deps: &Deps, file_read_max: i64) -> GitServer {
    let mut g = GitServer::default();
    g.git = deps.git_store.clone();
    g.exclusion = deps.git_exclusion.clone();
    g.work = deps
        .work
        .clone()
        .map(|w| w as Arc<dyn wsentry::WorkspaceStore>);
    g.commands = deps
        .commands
        .clone()
        .map(|c| Arc::new(BrokerCast(c)) as Arc<dyn wsentry::Broadcaster>);
    g.tools = deps
        .tools
        .clone()
        .map(|t| Arc::new(ToolCwd(t)) as Arc<dyn ToolLocator>);
    g.images = Some(Arc::new(
        Service::new().sized(usize::try_from(file_read_max).unwrap_or(0)),
    ));
    g.submodules = submodule_manager(deps.git_store.as_ref());
    g.user_worktrees = deps.user_worktrees.clone();
    g.run_worktree_root = deps
        .worktrees
        .as_ref()
        .map(|w| w.root().to_owned())
        .unwrap_or_default();
    g
}
