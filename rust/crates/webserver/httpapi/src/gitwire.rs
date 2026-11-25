//! `/api/git/*` 의 배선 (Go `server.go` 의 `newGitServer`·`submoduleManager`).
//!
//! git 표면은 gitapi 가 소유한다. 여기는 주입 표면(`Deps`)으로 `GitServer` 를 세워 `GitHandler`
//! 자리에 꽂는 것뿐이다.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use otter_shared_httpresp::Response;
use otter_webserver_domain_git_core::Service;
use otter_webserver_domain_git_jobs::Job;
use otter_webserver_domain_git_store::{Observation, Store};
use otter_webserver_domain_submodule as submodule;
use otter_webserver_domain_wsentry as wsentry;
use otter_webserver_fswatch::{TreeMsg, watch_tree};
use otter_webserver_gitapi::{GitServer, RepoWatcher, ToolLocator};
use otter_webserver_hub::{GitObserver, GitWatcher, TreeEvent, TreeHook, TreeWatcher, WatchGuard};
use tokio_util::sync::CancellationToken;

use crate::serve::GitHandler;
use crate::toolhub::ToolHub;
use crate::{BrokerCast, Deps, ReqBody, Server};

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

    fn job_feed(&self, id: &str) -> Option<otter_webserver_gitapi::JobFeed> {
        self.0.job_feed(id)
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
pub(crate) fn new_git_server(
    deps: &Deps,
    file_read_max: i64,
    watch: Option<&Arc<GitWatcher>>,
    me: &std::sync::Weak<crate::Server>,
) -> GitServer {
    let mut g = GitServer::default();
    // 원격 작업의 시작·끝은 `git.jobs` 토픽으로 민다 (CHANNEL_PROTOCOL C4).
    let jobs_me = me.clone();
    g.on_jobs_changed = Some(Arc::new(move || {
        if let Some(s) = jobs_me.upgrade() {
            s.topics.publish_full("git.jobs", s.git_jobs_value());
        }
    }));
    g.watch = watch.map(|w| Arc::new(WatchNote(w.clone())) as Arc<dyn RepoWatcher>);
    g.git = deps.git_store.clone();
    g.exclusion = deps.git_exclusion.clone();
    g.work = deps
        .work
        .clone()
        .map(|w| w as Arc<dyn wsentry::WorkspaceStore>);
    g.commands = deps
        .commands
        .clone()
        .map(|c| Arc::new(BrokerCast(c, me.clone())) as Arc<dyn wsentry::Broadcaster>);
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

/// gitapi 의 관심 표명을 hub 감시자로 잇는다.
struct WatchNote(Arc<GitWatcher>);

impl RepoWatcher for WatchNote {
    fn note(&self, repo: &str, obs: &Observation) {
        self.0.note(repo, obs);
    }
}

/// 저장소 트리를 OS 파일 감시로 본다 (PERF D-61).
struct FsTree;

impl TreeWatcher for FsTree {
    fn watch(&self, root: &str, hook: TreeHook) -> Result<WatchGuard, String> {
        let w = watch_tree(
            root,
            Arc::new(move |m: TreeMsg| match m {
                TreeMsg::Paths(p) => hook(TreeEvent::Paths(&p)),
                TreeMsg::Lost => hook(TreeEvent::Lost),
            }),
        )?;
        Ok(Box::new(w))
    }
}

/// signature 감시자를 세운다 (GIT_PUSH_OBSERVE_SRS). 저장소 계층이 없으면 서지 않는다 — 감시할
/// 대상이 없고, 그때 gitapi 의 표명 자리는 비어 무해하게 지나간다. 작업 트리 변화는 파일 감시가
/// 계기 관측으로 당긴다 (PERF D-61).
pub(crate) fn new_git_watch(deps: &Deps) -> Option<Arc<GitWatcher>> {
    let store = deps.git_store.clone()?;
    let w = GitWatcher::new(Some(Arc::new(store) as Arc<dyn GitObserver>));
    w.set_on_changed(deps.on_git_changed.clone());
    w.set_on_baseline(deps.on_git_baseline.clone());
    w.set_tree_watcher(Some(Arc::new(FsTree)));
    Some(w)
}

impl Server {
    /// signature 감시 회차를 돌린다 (GIT_PUSH_OBSERVE_SRS FR-GPO-13). 합성 루트(또는 `Run`)가
    /// 부른다. 감시자가 없으면(저장소 계층이 없는 배선) 아무 일도 하지 않는다.
    pub fn start_git_watch(&self, stop: CancellationToken) {
        if let Some(w) = &self.git_watch {
            otter_webserver_hub::start_git_watch(w.clone(), stop);
        }
    }
}
