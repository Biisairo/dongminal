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
mod ansi;
mod commands;
mod deps;
mod entity_name;
mod httperr;
mod netx;
mod openurl;
mod req;
mod reqgate;
mod routes;
mod serve;
mod settings_etag;
mod toolhub;
mod toolio;
mod ws;

use std::path::PathBuf;
use std::sync::atomic::AtomicI64;
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;
use std::time::Instant;

use dm_webserver_hub::{CommandBroker, CommandHub, FocusRegistry, ReplySeats};
use dm_webserver_seam_toolaccess::{ToolReader, WorkspaceReader};

pub use access::DEFAULT_ACCESS_REFRESH;
pub use deps::{UpdateService, WorkspaceStore};
pub use req::{BodyError, ReqBody};
pub use serve::GitHandler;
pub use toolhub::{ToolError, ToolHub, ToolIdentity, Unsubscribe};

use access::AccessStore;
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
    pub work: Option<Arc<dyn WorkspaceStore>>,
    pub updates: Option<Arc<dyn UpdateService>>,
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
    me: Weak<Server>,
    #[allow(dead_code)]
    pub(crate) started: Instant,
}

impl Server {
    /// Go `New`. `deps.commands` 가 없으면 새 허브를 만든다.
    pub fn new(cfg: Config, mut deps: Deps) -> Arc<Server> {
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
        Arc::new_cyclic(|me| Server {
            deps,
            cfg,
            focus: FocusRegistry::new(),
            seats: ReplySeats::new(),
            access: Some(access),
            hosts,
            conn: ConnStats::default(),
            browser_in: ws::BrowserInputs::default(),
            hello_every: Mutex::new(None),
            me: me.clone(),
            started: Instant::now(),
        })
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

#[cfg(test)]
mod tests;
