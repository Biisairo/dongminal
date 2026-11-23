//! Go 기준선 `dongminal/internal/webserver/httpapi` 의 Rust 포팅. RUST_PORT_SRS 참고.
//!
//! HTTP·WS·SSE 표면이다. 합성 루트가 [`Server::new`] 로 세우고, 받은 요청마다 [`Server::serve`] 를
//! 부른다. 하위 이슈(5.5.1~5.5.10)가 같은 crate 를 나눠 채운다 — 각 하위 이슈는 자기 모듈을
//! 갖고, 공용 접점(`Deps`·`Server` 필드·`routes::API_ROUTES`)에는 자기 것만 더한다.

// 도우미의 `Err` 는 다 만든 응답이다 — 한 번 만들어 곧바로 돌려줄 뿐이라 상자에 담지 않는다.
#![allow(clippy::result_large_err)]

mod access;
mod access_api;
mod access_denied;
mod agent_render_env;
mod ansi;
mod commands;
mod deps;
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
mod fs_limits;
mod fs_stamp;
mod fs_transfer;
mod httperr;
mod lspsvc;
mod mediatype;
mod multipart;
mod netx;
mod openurl;
mod path_lock;
mod req;
mod reqgate;
mod routes;
mod sandbox_api;
mod serve;
mod settings_etag;
mod toolhub;
mod toolio;
mod tools_api;
mod ws;

use std::path::PathBuf;
use std::sync::atomic::AtomicI64;
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;
use std::time::Instant;

use dm_webserver_domain_wsentry as wsentry;
use dm_webserver_hub::{CommandBroker, CommandHub, FocusRegistry, ReplySeats};
use dm_webserver_seam_toolaccess::{ToolReader, WorkspaceReader};

pub use access::DEFAULT_ACCESS_REFRESH;
pub use deps::{SandboxReaper, SettingsStore, StatsSnapshotter, UpdateService, WorkspaceStore};
pub use lspsvc::LspService;
pub use req::{BodyError, ReqBody};
pub use serve::GitHandler;
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
}

/// 주입 표면이다 (Go `Deps`). 비어 있는 자리는 그 표면만 실패한다.
#[derive(Clone, Default)]
pub struct Deps {
    pub tools: Option<Arc<dyn ToolHub>>,
    /// 없으면 `new` 가 새 `CommandHub` 를 만든다.
    pub commands: Option<Arc<dyn CommandBroker>>,
    pub tool_io: Option<Arc<dyn ToolReader>>,
    pub work_index: Option<Arc<dyn WorkspaceReader>>,
    /// `/api/git/*` 처리기다. 없으면 그 표면은 404 다 (5.5.10 이 gitapi 로 채운다).
    pub git: Option<Arc<dyn GitHandler>>,
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
    /// presence SSE 구독 수.
    pub(crate) presence_subs: AtomicI64,
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
    /// SSE 인사의 주기. `None` 이면 기본값이다 — 시험만이 줄인다.
    pub(crate) hello_every: Mutex<Option<Duration>>,
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
}

/// 탐색기·편집기의 파일 조작 잠금이다 (Go `fsState`).
#[derive(Default)]
pub(crate) struct FsState {
    /// 편집기 저장의 표식 검사~쓰기를 경로마다 한 번에 하나로 묶는다 (REFACTOR3_DEFECTS_SRS FR-RD3-20).
    pub(crate) writes: PathLocks,
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
        if deps.commands.is_none() {
            let hub: Arc<dyn CommandBroker> = CommandHub::new();
            deps.commands = Some(hub);
        }
        let access = Arc::new(AccessStore::new(
            cfg.data_dir.join(dm_shared_dmenv::ACCESS_FILE),
        ));
        // 부팅 시 1회 — 자기 인터페이스 주소를 모른 채로 서면 자기 이름으로 붙는 첫 요청이 막힌다
        // (FR-ACL-5a).
        access.refresh();
        let hosts = HostAllow::new(Some(access.clone()), cfg.allowed_hosts.clone());
        let entries = Arc::new(new_entry_store(&cfg, &deps));
        Server {
            deps,
            cfg,
            focus: FocusRegistry::new(),
            seats: ReplySeats::new(),
            access: Some(access),
            hosts,
            conn: ConnStats::default(),
            browser_in: ws::BrowserInputs::default(),
            hello_every: Mutex::new(None),
            sandbox_put: tokio::sync::Mutex::new(()),
            me,
            started: Instant::now(),
            entries,
            limits: ServerLimits::default(),
            fs: FsState::default(),
        }
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

    /// 지금 서빙하는 자산의 판이다 (FR-AVS-3). 정적 자산은 5.5.8 이 배선한다 — 그 전에는 모른다.
    pub(crate) fn asset_version(&self) -> String {
        String::new()
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
        dm_gocompat::filepath::join(&[data_dir, dm_shared_dmenv::NOTES_DIR]),
        dm_webserver_domain_ext::plugins_dir(&dm_webserver_domain_ext::root_in(data_dir)),
    )
}

#[cfg(test)]
mod tests;
