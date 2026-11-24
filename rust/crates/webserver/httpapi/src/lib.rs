//! Go 기준선 `otterminal/internal/webserver/httpapi` 의 Rust 포팅. RUST_PORT_SRS 참고.
//!
//! HTTP·WS·SSE 표면이다. 합성 루트가 [`Server::new`] 로 세우고, 받은 요청마다 [`Server::serve`] 를
//! 부른다. 하위 이슈(5.5.1~5.5.10)가 같은 crate 를 나눠 채운다 — 각 하위 이슈는 자기 모듈을
//! 갖고, 공용 접점(`Deps`·`Server` 필드·`routes::API_ROUTES`)에는 자기 것만 더한다.

// 도우미의 `Err` 는 다 만든 응답이다 — 한 번 만들어 곧바로 돌려줄 뿐이라 상자에 담지 않는다.
#![allow(clippy::result_large_err)]

mod access;
mod access_api;
mod access_denied;
mod agent_records;
mod agent_render_env;
mod ansi;
mod asset_version;
mod attention;
mod carry;
mod channel;
mod chat_api;
mod claude_accounts;
mod commands;
mod deps;
mod diag_snapshot;
mod edge_api;
mod editors;
mod entity_name;
mod file_boundary;
mod file_probe;
mod files;
mod files_rw;
mod files_stamp;
mod files_transfer;
mod fs;
mod fs_actions;
mod fs_copy;
mod fs_limits;
mod fs_mutate;
mod fs_search;
mod fs_stamp;
mod fs_transfer;
mod fs_watch;
mod fs_zip;
mod git_topics;
mod gitwire;
mod go_embed;
mod handlers_diag;
mod handlers_fs_ignored;
mod health;
mod httperr;
mod lsp_api;
mod lspsvc;
mod mediatype;
mod meta;
mod migration_advice;
mod mimetable;
mod multipart;
mod netx;
mod openurl;
mod path_lock;
mod rebind;
mod rebind_conns;
mod req;
mod reqgate;
mod routes;
mod run;
mod runs;
mod runs_assign;
mod runs_close;
mod runs_context;
mod runs_graph;
mod runs_headless;
mod runs_marks;
mod runs_recover;
mod runs_tree;
mod runs_worktree;
mod sandbox_api;
mod serve;
mod serve_content;
mod settings;
mod settings_etag;
mod snapshot;
mod static_assets;
mod status;
mod subagents;
mod telegram_api;
mod toolhub;
mod toolio;
mod tools_api;
mod update_api;
mod usage;
mod whoami;
mod workspace_revert;
mod ws;

use std::path::PathBuf;
use std::sync::atomic::AtomicI64;
use std::sync::{Arc, Weak};
use std::time::Instant;

use otter_webserver_domain_wsentry as wsentry;
use otter_webserver_hub::{AttnTracker, CommandBroker, CommandHub, FocusRegistry, ReplySeats};
use otter_webserver_seam_toolaccess::{ToolReader, WorkspaceReader};

pub use access::DEFAULT_ACCESS_REFRESH;
pub use agent_records::RecordSink;
pub use attention::{AttentionDaemon, DaemonCallError};
pub use chat_api::ChatDaemon;
pub use claude_accounts::ClaudeHooks;
pub use deps::{SandboxReaper, SettingsStore, StatsSnapshotter, UpdateService, WorkspaceStore};
pub use diag_snapshot::DIAG_SNAPSHOT_EVERY;
pub use edge_api::EdgeDaemon;
pub use lspsvc::LspService;
pub use migration_advice::{MigrationConf, parse_migration_conf};
pub use req::{BodyError, ReqBody};
pub use run::SHUTDOWN_GRACE;
pub use serve::GitHandler;
pub use static_assets::{AssetEntry, StaticAssets, WebAssets};
pub use toolhub::{ToolError, ToolHub, ToolIdentity, Unsubscribe};

use access::AccessStore;
use fs_limits::ServerLimits;
use path_lock::PathLocks;
use reqgate::HostAllow;

/// 프로세스 수준의 설정이다 (Go `Config`).
#[derive(Clone, Debug, Default)]
pub struct Config {
    pub port: String,
    pub data_dir: PathBuf,
    /// `--allowed-host` 로 명시 추가한 이름들이다 (REQUEST_GATE_SRS FR-RQG-6). `*.ts.net` 처럼
    /// 접미사 와일드카드를 쓸 수 있다.
    pub allowed_hosts: Vec<String>,
    /// 이 서버 바이너리의 판이다 (VERSION_HEALTH_SRS FR-VHL-10).
    pub version: String,
    /// 브라우저로 서빙할 정적 자산이다 (Go `StaticFS`). 없으면 `/` 가 서지 않는다. 실물은 [`WebAssets`].
    pub static_fs: Option<Arc<dyn StaticAssets>>,
    /// Telegram Bot API 주소다. 비면 실제 주소이고, 시험이 가짜 서버로 바꾼다.
    pub telegram_api: String,
    /// Claude Code 설정(`~/.claude`·`~/.claude.json`)을 찾을 사용자 홈이다. 비면 OS 의 홈이다.
    pub claude_home: PathBuf,
    /// Anthropic API 주소다. 비면 실제 주소이고, 시험이 가짜 서버로 바꾼다.
    pub claude_api: String,
}

/// 주입 표면이다 (Go `Deps`). 비어 있는 자리는 그 표면만 실패한다.
#[derive(Clone, Default)]
pub struct Deps {
    pub tools: Option<Arc<dyn ToolHub>>,
    /// 없으면 `new` 가 새 `CommandHub` 를 만든다.
    pub commands: Option<Arc<dyn CommandBroker>>,
    pub tool_io: Option<Arc<dyn ToolReader>>,
    pub work_index: Option<Arc<dyn WorkspaceReader>>,
    /// `/api/git/*` 처리기다. 없으면 `new` 가 아래 git 자리들로 gitapi 를 세운다.
    pub git: Option<Arc<dyn GitHandler>>,
    /// 모든 git 조회가 지나는 지점이다 (Go `Deps.Git`). 없으면 /api/git/* 이 503 이다 (FR-GIT-60).
    pub git_store: Option<Arc<otter_webserver_domain_git_store::Store>>,
    /// 저장소 배타 상태다 — 쓰기·잡·Run 격리가 같은 것을 봐야 한다 (REPO_FIX 01 §5.4).
    pub git_exclusion: Option<otter_webserver_domain_git_jobs::Exclusion>,
    /// 사용자 worktree 영역의 관리자다 (FR-WKT-13). 없으면 Worktrees 탭이 503 이다.
    pub user_worktrees: Option<Arc<dyn otter_webserver_domain_worktree::Service>>,
    /// Run 격리 영역의 관리자다 (Go `Deps.Worktrees`). gitapi 는 root 경로만 쓴다 (FR-GIT-240).
    pub worktrees: Option<Arc<dyn otter_webserver_domain_worktree::Service>>,
    /// workspace.json 저장소다 (Go `Deps.Work`). Editor 목록(`Server::entries`)도 읽고 쓴다.
    pub work: Option<Arc<dyn WorkspaceStore>>,
    pub updates: Option<Arc<dyn UpdateService>>,
    pub settings: Option<Arc<dyn SettingsStore>>,
    /// 샌드박스 창의 대응 컨테이너 회수자다. 없으면 컨테이너 기능이 꺼진다.
    pub sandbox: Option<Arc<dyn SandboxReaper>>,
    /// 상태바 지표다. 없으면 `/api/stats` 는 hostname·srvUptime 만 낸다.
    pub stats: Option<Arc<dyn StatsSnapshotter>>,
    /// 경로의 git 저장소 루트를 답한다 (Go `Deps.Git.RepoRoot`). 없으면 Editor 행 추가의 저장소
    /// 연동만 서지 않는다 (FR-EDT-33).
    pub repo_root: Option<wsentry::RepoRootFn>,
    /// 편집기의 코드 탐색 표면이다 (EDITOR_LSP_SRS 묶음 A). 없으면 그 연동만 빠진다.
    pub lsp: Option<Arc<dyn LspService>>,
    /// 주의·활동 추적기다 (Go `Deps.AttnTracker`). 없으면 주의·활동 종단이 무동작으로 답한다.
    pub attn_tracker: Option<Arc<AttnTracker>>,
    /// 에이전트 기록을 데몬에 쓰는 자리다 (FR-ARD-11). 없으면 거울만 쓴다 (FR-ARD-14).
    pub records: Option<Arc<dyn RecordSink>>,
    /// 데몬의 알람 판정이다 (§3.3a). 없거나 판정하지 않으면 추적기가 판정한다.
    pub attn_daemon: Option<Arc<dyn AttentionDaemon>>,
    /// 데몬의 노드다 (PEER_DAEMON_SRS §3.5a). 없으면 간선 API 는 503 이다 (FR-DMR-21).
    pub edge_daemon: Option<Arc<dyn EdgeDaemon>>,
    /// 데몬의 채팅 사람 참가자다 (PEER_CHAT_SRS §3.11). 없으면 준비되지 않은 데몬과 같다 (FR-DMR-22).
    pub chat_daemon: Option<Arc<dyn ChatDaemon>>,
    /// Claude 계정의 비밀 저장소·프로세스 목록이다 (Go `Config.ClaudeSecrets`·`ClaudeProcs`).
    pub claude: ClaudeHooks,
    /// 실행 기록을 공유할 git core 서비스다 (Go `Deps.Git.Service()`). 없어도 무시 판정은 돌고
    /// 기록만 빠진다 (FR-GXU-4·10).
    pub git_service: Option<Arc<otter_webserver_domain_git_core::Service>>,
    /// 호출자의 원격 주소를 그 셸의 도구로 푼다 (Go `Deps.WhoAmI`). 없으면 `/api/whoami` 가 500 이다.
    pub who_am_i: Option<Arc<dyn otter_webserver_seam_toolaccess::ClientToolResolver>>,
    /// git 감시자가 `git_changed` 를 방송할 때 그 저장소로 불린다 (REPO_FIX 02 §3A-6).
    pub on_git_changed: Option<otter_webserver_hub::RepoHook>,
    /// git 감시자가 저장소의 첫 표명을 기준선으로 삼을 때 불린다 (CODEMIRROR_MIGRATION_SRS §11.6 W).
    pub on_git_baseline: Option<otter_webserver_hub::RepoHook>,
    /// runs.json 저장소다 (Go `Deps.Runs`, RUN_ORCHESTRATION_SRS 묶음 R). 없으면 /api/runs* 가 503
    /// 이고 그 밖의 동작에는 영향이 없다 (NFR-RUN-1).
    pub runs: Option<Arc<otter_webserver_domain_run::Store>>,
}

/// 연결 진단의 계수다 (Go `connStats` 중 이 하위 이슈가 쓰는 것).
#[derive(Default)]
pub(crate) struct ConnStats {
    /// 마지막 요청 시각(UnixNano). 로깅 미들웨어가 갱신한다.
    pub(crate) last_req: AtomicI64,
    /// 마지막 WS 연결 시각(UnixNano).
    pub(crate) last_ws: AtomicI64,
    /// 열린 WS 수.
    pub(crate) ws_open: AtomicI64,
    /// 붙잡힌 WS 수 (ws_miss).
    pub(crate) holds: AtomicI64,
    pub(crate) misses: ws::MissTracker,
}

/// HTTP 서버 한 벌이다 (Go `Server`). 두 서버가 한 프로세스에 함께 설 수 있다.
pub struct Server {
    deps: Deps,
    cfg: Config,
    /// 창→클라이언트 소유 (FR-XDF-1).
    pub focus: FocusRegistry,
    /// 도구마다 답장을 보낼 연결 하나 (TERM_REPLY_SEAT_SRS FR-RPS-1).
    pub seats: ReplySeats,
    /// 접속 허용 목록이다 (ACCESS_ALLOWLIST_SRS). 있으면 게이트가 모든 표면 앞에 선다.
    pub(crate) access: Option<Arc<AccessStore>>,
    /// `Host`·`Origin` 판정의 허용 집합이다 (REQUEST_GATE_SRS FR-RQG-6).
    pub(crate) hosts: HostAllow,
    pub(crate) conn: ConnStats,
    pub(crate) browser_in: ws::BrowserInputs,
    /// 채널 토픽의 상태·순번·구독 (`perf/CHANNEL_PROTOCOL.md` §11.1).
    pub(crate) topics: channel::TopicHub,
    /// `PUT /api/sandbox/config` 의 지문 검사와 저장을 한 덩이로 묶는다 (FR-LIV-2).
    pub(crate) sandbox_put: tokio::sync::Mutex<()>,
    me: Weak<Server>,
    pub(crate) started: Instant,
    /// workspace.json 최상위의 두 목록(git.pinned[]·editors.list[])이다 (EDITOR_TAB_SRS
    /// FR-EDT-116). `/api/editors/*` 와 `/api/fs/*` 의 루트 가드가 읽는다 (FR-EDT-113).
    pub entries: Arc<wsentry::Store>,
    /// 요청 상한이다 (M8 `GO-9`). 시험만이 서버 하나의 값을 낮춘다.
    pub(crate) limits: ServerLimits,
    /// 탐색기·편집기의 파일 조작 잠금이다.
    pub(crate) fs: FsState,
    /// 도구·에이전트별 메모리 상태다 (Go `agents`).
    pub(crate) agents: usage::AgentStores,
    /// 알람의 배너·소리를 어느 창이 맡았는지다 (ATTENTION_FIRING_SRS 묶음 D).
    pub(crate) attn_claims: attention::AttnClaims,
    /// 지금 붙잡힌 활동 대기 수와 상한이다 (FR-STA-9).
    pub(crate) waits: status::StatusWaits,
    /// 활동 보고의 알림이다 — 활동 대기가 이것과 마감 시각에만 다시 본다 (FR-OPT-16-3).
    pub(crate) activity_changed: otter_shared_pollwait::Signal,
    /// 실행 중 리바인드·이사 보관·연결 시한이다 (HOT_REBIND_SRS 묶음 R).
    pub(crate) rebind: rebind::RebindState,
    /// 저장소 signature 를 감시해 `git_changed` 를 방송한다 (GIT_PUSH_OBSERVE_SRS). 저장소 계층이
    /// 없으면 없다.
    pub(crate) git_watch: Option<Arc<otter_webserver_hub::GitWatcher>>,
    /// 정적 자산 `/` 의 처리기와 자산의 판이다. 정적 자산이 없는 구성이면 없다.
    pub(crate) statics: Option<static_assets::StaticHandler>,
    /// Run 표면의 서버 쪽 보조 상태다 — 복구·통지 (Go `runAux`).
    pub(crate) run_aux: runs_recover::RunAux,
    /// 이 기기의 `이름#번호` 기억이다 (Go `handle`).
    pub(crate) handle: edge_api::HandleCache,
    /// 노드 포트를 다시 맞추라는 신호다 (Go `edgeKick`).
    pub(crate) edge_kick: edge_api::EdgeKick,
    /// `/api/lsp/ws` 의 메시지 상한이다 (FR-CMR-104). 시험만이 낮춘다.
    pub(crate) lsp_ws_read_limit: usize,
    /// Telegram 알림 이음매다 (Go `tg`). data_dir 이 없으면 없다.
    pub(crate) tg: Option<telegram_api::TelegramWire>,
    /// Claude 다중 계정이다 (Go `ca`, CLAUDE_ACCOUNTS_SRS). data_dir 이 없으면 없다.
    pub(crate) ca: Option<claude_accounts::ClaudeAcctWire>,
}

/// 탐색기·편집기의 파일 조작 잠금이다 (Go `fsState`).
#[derive(Default)]
pub(crate) struct FsState {
    /// 보이는 디렉터리의 파일 감시다 (FR-ELR-51). `new` 가 언제나 세운다.
    pub(crate) watch: Option<otter_webserver_fswatch::Manager>,
    /// 폴더 zip 내려받기의 상한과 지금 흐르는 수다 (FR-ETR-12·45).
    pub(crate) zip: fs_zip::ZipLimits,
    /// 편집기 저장의 표식 검사~쓰기를 경로마다 한 번에 하나로 묶는다 (REFACTOR3_DEFECTS_SRS FR-RD3-20).
    pub(crate) writes: PathLocks,
    /// 탐색기의 파일 조작을 직렬화한다 (FR-EDT-115). 실제 파일 조작 구간만 잡는다.
    pub(crate) ops: Arc<std::sync::Mutex<()>>,
}

/// 명령 허브를 Editor 목록 저장소의 방송 자리로 잇는다.
struct BrokerCast(Arc<dyn CommandBroker>);

impl wsentry::Broadcaster for BrokerCast {
    fn broadcast(&self, payload: &[u8]) -> usize {
        self.0.broadcast(payload)
    }
}

impl Server {
    /// Go `New`. `deps.commands` 가 없으면 새 허브를 만든다.
    pub fn new(cfg: Config, deps: Deps) -> Arc<Server> {
        Arc::new_cyclic(|me| Server::build(cfg, deps, me.clone()))
    }

    /// 시험이 상한·홈 같은 서버 하나의 값을 바꾼 뒤 세운다.
    #[cfg(test)]
    pub(crate) fn new_with(cfg: Config, deps: Deps, f: impl FnOnce(&mut Server)) -> Arc<Server> {
        Arc::new_cyclic(|me| {
            let mut srv = Server::build(cfg, deps, me.clone());
            f(&mut srv);
            srv
        })
    }

    fn build(cfg: Config, mut deps: Deps, me: Weak<Server>) -> Server {
        let mut own_hub = None;
        if deps.commands.is_none() {
            let hub = CommandHub::new();
            own_hub = Some(hub.clone());
            deps.commands = Some(hub as Arc<dyn CommandBroker>);
        }
        // DataDir 이 비면 이름만 남는다 — 작업 디렉터리의 그 파일이다.
        if deps.settings.is_none() {
            let path = cfg.data_dir.join(otter_shared_otterenv::SETTINGS_FILE);
            deps.settings = Some(Arc::new(settings::FileSettings::new(path)));
        }
        let access = Arc::new(AccessStore::new(
            cfg.data_dir.join(otter_shared_otterenv::ACCESS_FILE),
        ));
        // 부팅 시 1회 — 자기 인터페이스 주소를 모른 채로 서면 자기 이름으로 붙는 첫 요청이 막힌다
        // (FR-ACL-5a).
        access.refresh();
        let hosts = HostAllow::new(Some(access.clone()), cfg.allowed_hosts.clone());
        let entries = Arc::new(new_entry_store(&cfg, &deps));
        let limits = ServerLimits::default();
        let statics = cfg.static_fs.clone().map(static_assets::StaticHandler::new);
        let git_watch = gitwire::new_git_watch(&deps);
        if deps.git.is_none() {
            let me = me.clone();
            let on_jobs: Arc<dyn Fn() + Send + Sync> = Arc::new(move || {
                if let Some(s) = me.upgrade() {
                    s.topics.publish_full("git.jobs", s.git_jobs_value());
                }
            });
            let g = gitwire::new_git_server(
                &deps,
                limits.file_read_max,
                git_watch.as_ref(),
                Some(on_jobs),
            );
            deps.git = Some(Arc::new(gitwire::GitApi(Arc::new(g))));
        }
        let deps_commands = deps.commands.clone();
        let tg = telegram_api::init_telegram(&cfg, me.clone());
        let ca = claude_accounts::init_claude_accounts(&cfg, &deps.claude, me.clone());
        let srv = Server {
            deps,
            cfg,
            focus: FocusRegistry::new(),
            seats: ReplySeats::new(),
            access: Some(access),
            hosts,
            conn: ConnStats::default(),
            browser_in: ws::BrowserInputs::default(),
            topics: channel::TopicHub::default(),
            sandbox_put: tokio::sync::Mutex::new(()),
            me,
            started: Instant::now(),
            entries,
            limits,
            fs: FsState {
                watch: Some(fs_watch::new_fs_watch(deps_commands, git_watch.clone())),
                ..FsState::default()
            },
            agents: usage::AgentStores::default(),
            attn_claims: attention::AttnClaims::default(),
            waits: status::StatusWaits::default(),
            activity_changed: otter_shared_pollwait::Signal::default(),
            rebind: rebind::RebindState::default(),
            git_watch,
            statics,
            run_aux: runs_recover::RunAux::default(),
            handle: edge_api::HandleCache::default(),
            edge_kick: edge_api::EdgeKick::default(),
            lsp_ws_read_limit: lsp_api::LSP_WS_READ_LIMIT,
            tg,
            ca,
        };
        if let Some(hub) = own_hub {
            srv.wire_telegram_attention(&hub);
        }
        srv.wire_git_topics();
        srv
    }

    pub fn deps(&self) -> &Deps {
        &self.deps
    }

    pub fn config(&self) -> &Config {
        &self.cfg
    }

    /// 이 서버의 `Arc` 다. 요청 뒤에도 사는 task(SSE·WS)가 쓴다.
    pub(crate) fn arc(&self) -> Option<Arc<Server>> {
        self.me.upgrade()
    }

    pub(crate) fn work(&self) -> Option<&dyn WorkspaceStore> {
        self.deps.work.as_deref()
    }

    /// 지금 서빙하는 자산의 판이다 (FR-AVS-3). 정적 자산이 없는 구성이면 모른다 (FR-AVS-10).
    pub(crate) fn asset_version(&self) -> String {
        self.statics
            .as_ref()
            .map(|h| h.version.clone())
            .unwrap_or_default()
    }

    pub(crate) fn commands(&self) -> Option<&Arc<dyn CommandBroker>> {
        self.deps.commands.as_ref()
    }
}

/// Go `newEntryStore`: Editor·메모·플러그인 목록의 저장소다.
fn new_entry_store(cfg: &Config, deps: &Deps) -> wsentry::Store {
    let (notes_dir, plugins_dir) = data_dir_layout(&cfg.data_dir.to_string_lossy());
    let mut st = wsentry::Store::default();
    st.work = deps
        .work
        .clone()
        .map(|w| w as Arc<dyn wsentry::WorkspaceStore>);
    st.commands = deps
        .commands
        .clone()
        .map(|c| Arc::new(BrokerCast(c)) as Arc<dyn wsentry::Broadcaster>);
    st.repo_root = deps.repo_root.clone();
    st.notes_dir = notes_dir;
    st.plugins_dir = plugins_dir;
    st
}

/// Go `dataDirLayout`: 데이터 디렉터리 아래 메모·플러그인 자리다. 비면 둘 다 빈다 (FR-NOT-1·11,
/// FR-EXT-9b).
fn data_dir_layout(data_dir: &str) -> (String, String) {
    if data_dir.is_empty() {
        return (String::new(), String::new());
    }
    (
        otter_gocompat::filepath::join(&[data_dir, otter_shared_otterenv::NOTES_DIR]),
        otter_webserver_domain_ext::plugins_dir(&otter_webserver_domain_ext::root_in(data_dir)),
    )
}

#[cfg(test)]
mod tests;
