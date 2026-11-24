//! 의존 조립이다 (Go `main.go` 의 buildDepsWithHub·buildCommonDeps 와 그 조각들).

use std::path::Path;
use std::sync::Arc;

use otter_gocompat::filepath;
use otter_shared_otterenv as otterenv;
use otter_shared_otterlog::warnf;
use otter_shared_sandboxplace::Placer;
use otter_shared_workspace::{Error as WorkspaceError, FilePersister, Manager, WindowInfo};
use otter_webserver_domain_ext as ext;
use otter_webserver_domain_git_core::{Ctx, Service as GitService};
use otter_webserver_domain_git_jobs::Exclusion;
use otter_webserver_domain_git_store::{Store, StoreOptions};
use otter_webserver_domain_lsp::{self as lsp, RepoWatch};
use otter_webserver_domain_run as run;
use otter_webserver_domain_sysstat::{self as sysstat, Sampler};
use otter_webserver_domain_worktree::Manager as WorktreeManager;
use otter_webserver_domain_wsentry::RepoRootFn;
use otter_webserver_httpapi::{Config, Deps};
use otter_webserver_hub::{AttnTracker, CommandBroker, CommandHub, RepoHook, default_idle_ms};
use otter_webserver_seam_adapters as adapters;
use otter_webserver_toolclient::ToolClient;

use super::adapters::{Hub, Lsp, Sandbox, Stats, Work, known_windows};
use super::attention::attn_live_probe;
use super::lsp_watch::LspRepoView;

/// 조립된 의존과, 수명을 합성 루트가 쥐어야 하는 구성원들이다 (Go `builtDeps`).
#[derive(Default)]
pub(crate) struct BuiltDeps {
    pub(crate) deps: Deps,
    /// 주입한 명령 허브다. Telegram 관찰자를 다는 데 구체 타입이 필요하다.
    pub(crate) cmd_hub: Option<Arc<CommandHub>>,
    pub(crate) attn_tracker: Option<Arc<AttnTracker>>,
    pub(crate) sampler: Option<Arc<Sampler>>,
    pub(crate) ws_mgr: Option<Arc<Manager>>,
    /// 언어 서버들의 수명을 소유한다. `deps.lsp` 로는 스위퍼·정지를 부를 수 없다 (EDITOR_LSP_SRS D-4).
    pub(crate) lsp_svc: Option<Arc<lsp::Service>>,
    /// 샌드박스 정지를 종료 표가 부른다.
    pub(crate) sandbox: Option<Arc<Placer>>,
}

/// 회수에 넘길 살아 있는 Window 목록이다. `None` 은 그대로 옮긴다 — "판단 근거 없음" 이 회수
/// 쪽에서 구분되어야 한다 (FR-SBX-9).
pub(crate) fn live_window_uuids(ws: Option<Vec<WindowInfo>>) -> Option<Vec<String>> {
    ws.map(|ws| ws.into_iter().map(|w| w.uuid).collect())
}

fn data_dir(cfg: &Config) -> String {
    cfg.data_dir.to_string_lossy().into_owned()
}

/// 데몬 허브(ToolClient)로 의존을 조립한다. 도구는 데몬에 있다 (DIRECT_MODE_REMOVAL_SRS).
pub(crate) fn build_deps_with_hub(
    cfg: &Config,
    client: Arc<ToolClient>,
    git_ctx: Ctx,
) -> Result<BuiltDeps, WorkspaceError> {
    let cmd_hub = CommandHub::new();
    // 배치는 데몬이 한다(boot). 여기서는 회수만 맡는다 — 회수는 workspace 를 봐야 하고 그 주인은
    // 웹서버 프로세스다 (FR-SBX-9).
    let reaper = otter_shared_sandboxplace::wire(&data_dir(cfg), otter_ctl_cli::VERSION, &cfg.port);

    // L2 유휴 판정은 데몬에 busy 를 물어 맨 프롬프트가 알람을 울리지 않게 한다 (FR-15).
    let broker: Arc<dyn CommandBroker> = cmd_hub.clone();
    let attn = AttnTracker::new(broker, default_idle_ms());
    let busy = Arc::clone(&client);
    attn.set_busy_probe(Some(Arc::new(move |ids: &[String]| busy.busy_many(ids))));
    // FR-ATL-6: 종료 통지를 놓쳐도 죽은 도구의 알람이 복원되지 않게 한다.
    attn.set_live_probe(Some(attn_live_probe(client.clone())));

    let mut bd = build_common_deps(cfg, client, cmd_hub, attn, git_ctx)?;
    attach_sandbox(&mut bd, reaper);
    Ok(bd)
}

/// 샌드박스 표면을 싣고 부팅 시 고아를 회수한다 (FR-SBX-8). 런타임이 없으면(`None`) 아무것도
/// 하지 않는다.
pub(crate) fn attach_sandbox(bd: &mut BuiltDeps, pl: Option<Arc<Placer>>) {
    let Some(pl) = pl else {
        return;
    };
    bd.deps.sandbox = Some(Arc::new(Sandbox(pl.clone())));
    let live = live_window_uuids(bd.ws_mgr.as_deref().and_then(known_windows));
    pl.reap(live.as_deref());
    bd.sandbox = Some(pl);
}

/// toolaccess 어댑터 둘을 만든다. 둘 다 허브(ToolClient)를 쓴다.
pub(crate) fn new_tool_adapters(
    hub: Arc<dyn adapters::ToolSource>,
) -> (adapters::Tool, adapters::Client) {
    (
        adapters::Tool {
            hub: Some(hub.clone()),
        },
        adapters::Client { hub: Some(hub) },
    )
}

/// git 실행의 단일 지점과 그것을 받는 것들이다.
pub(crate) struct GitDeps {
    pub(crate) store: Arc<Store>,
    pub(crate) worktrees: Arc<WorktreeManager>,
    pub(crate) user_worktrees: Arc<WorktreeManager>,
}

/// git 실행의 단일 지점(FR-GIT-1)을 **worktree 보다 먼저** 만든다 — worktree 가 이것을 받아야
/// 실행 환경과 기록을 함께 쓴다 (GIT_EXEC_UNIFY_SRS FR-GXU-10). Run 격리(worktrees)와 사용자
/// worktree(git-worktrees)는 root 만 형제인 별개의 관리자다 (FR-WKT-13).
pub(crate) fn new_git_deps(cfg: &Config, git_ctx: Ctx) -> GitDeps {
    let svc = Arc::new(GitService::new());
    let dir = data_dir(cfg);
    GitDeps {
        store: Store::new(svc.clone(), StoreOptions::default().root(git_ctx)),
        worktrees: Arc::new(
            WorktreeManager::new(&filepath::join(&[dir.as_str(), otterenv::WORKTREES_DIR]))
                .with_service(svc.clone()),
        ),
        user_worktrees: Arc::new(
            WorktreeManager::new(&filepath::join(&[
                dir.as_str(),
                otterenv::GIT_WORKTREES_DIR,
            ]))
            .with_service(svc),
        ),
    }
}

/// Run 레코드 저장소다 (RUN_ORCHESTRATION_SRS 묶음 R). 파일이 없거나 손상돼도 부팅을 막지 않는다.
pub(crate) fn new_run_store(cfg: &Config) -> Arc<run::Store> {
    let st = run::Store::new(cfg.data_dir.clone());
    st.load();
    Arc::new(st)
}

/// 편집기 코드 탐색의 언어 서버다 (LSP_PLUGIN_SRS). 동봉 선언을 한 번 펴 둘 뿐 서버도 런타임도
/// 받지 않는다 (FR-EXT-16·34).
pub(crate) fn new_lsp_service(cfg: &Config) -> Arc<lsp::Service> {
    let dir = data_dir(cfg);
    let ext_svc = Arc::new(ext::Service::new(&filepath::join(&[
        dir.as_str(),
        ext::DIR_NAME,
    ])));
    for e in ext_svc.deploy() {
        warnf!(None, "플러그인 선언을 펴지 못했습니다: {e}");
    }
    let svc = Arc::new(lsp::Service::new(Some(ext_svc)));
    // REPO_FIX 02 §3A-3: 실행 파일 경로 표는 서버가 보관한다.
    if let Err(e) = svc.load_paths(&filepath::join(&[dir.as_str(), otterenv::LSP_PATHS_FILE])) {
        warnf!(None, "LSP 경로 표를 읽지 못했습니다: {e}");
    }
    svc
}

fn repo_root_fn(st: &Arc<Store>) -> RepoRootFn {
    let st = Arc::clone(st);
    Arc::new(move |ctx: Ctx, cwd: String| {
        let st = Arc::clone(&st);
        Box::pin(async move { st.repo_root(&ctx, &cwd).await.map_err(|e| e.to_string()) })
    })
}

/// 데몬 허브 둘레의 관리자들을 잇는다 (Go `buildCommonDeps`).
pub(crate) fn build_common_deps(
    cfg: &Config,
    client: Arc<ToolClient>,
    cmd_hub: Arc<CommandHub>,
    attn: Arc<AttnTracker>,
    git_ctx: Ctx,
) -> Result<BuiltDeps, WorkspaceError> {
    let hub = Hub(client);
    let ws_path = filepath::join(&[data_dir(cfg).as_str(), otterenv::WORKSPACE_FILE]);
    let ws = Arc::new(Manager::new(
        Arc::new(hub.clone()),
        Arc::new(FilePersister::new(Path::new(&ws_path))),
    )?);
    let (pa, resolver) = new_tool_adapters(Arc::new(hub.clone()));
    let runs = new_run_store(cfg);
    let git = new_git_deps(cfg, git_ctx);
    // 상태바 지표 샘플러. 요청 경로에서 커널을 부르지 않는다 (SYSTEM_STATS_SRS FR-STAT-8/9/11).
    let sampler = Arc::new(Sampler::new(
        sysstat::new_reader(),
        sysstat::DEFAULT_INTERVAL,
        "/",
    ));
    let lsp_svc = new_lsp_service(cfg);
    // CODEMIRROR_MIGRATION_SRS FR-CMR-111: 저장소가 바뀌면 바뀐 파일을 통로에 알린다.
    let repo_watch = Arc::new(RepoWatch::new(
        Arc::new(LspRepoView {
            st: git.store.clone(),
        }),
        lsp_svc.clone(),
    ));
    let changed: RepoHook = {
        let rw = Arc::clone(&repo_watch);
        Arc::new(move |repo: &str| {
            let (rw, repo) = (Arc::clone(&rw), repo.to_owned());
            // gitwatch 를 기다리게 하지 않는다 — 비교가 git 을 부를 수 있다.
            match tokio::runtime::Handle::try_current() {
                Ok(h) => drop(h.spawn_blocking(move || rw.changed(&repo))),
                Err(_) => drop(std::thread::spawn(move || rw.changed(&repo))),
            }
        })
    };
    let baseline: RepoHook = Arc::new(move |repo: &str| repo_watch.seen(repo));

    let deps = Deps {
        tools: Some(Arc::new(hub)),
        work: Some(Arc::new(Work(ws.clone()))),
        commands: Some(cmd_hub.clone()),
        attn_tracker: Some(attn.clone()),
        who_am_i: Some(Arc::new(resolver)),
        tool_io: Some(Arc::new(pa)),
        work_index: Some(Arc::new(adapters::Workspace { ws: ws.clone() })),
        stats: Some(Arc::new(Stats(sampler.clone()))),
        runs: Some(runs),
        worktrees: Some(git.worktrees),
        user_worktrees: Some(git.user_worktrees),
        git_service: Some(git.store.service().clone()),
        repo_root: Some(repo_root_fn(&git.store)),
        git_store: Some(git.store),
        git_exclusion: Some(Exclusion::new()),
        on_git_changed: Some(changed),
        on_git_baseline: Some(baseline),
        lsp: Some(Arc::new(Lsp(lsp_svc.clone()))),
        ..Deps::default()
    };
    Ok(BuiltDeps {
        deps,
        cmd_hub: Some(cmd_hub),
        attn_tracker: Some(attn),
        sampler: Some(sampler),
        ws_mgr: Some(ws),
        lsp_svc: Some(lsp_svc),
        sandbox: None,
    })
}
