//! 주입 trait (Go `deps.go`). 하위 이슈가 자기가 쓰는 것을 더한다.

use dm_shared_workspace::{Error as WorkspaceError, TabEntry, WindowInfo};

/// Go `WorkspaceStore`: workspace.json 의 저장소다. Go `Deps.Work` 하나에 대응한다 — `snapshot`·`save`
/// 는 Editor 목록(`wsentry`)과 함께 쓰는 상위 trait 의 것이다.
pub trait WorkspaceStore: dm_webserver_domain_wsentry::WorkspaceStore {
    fn current_rev(&self) -> u64;
    fn load_err(&self) -> String;
    fn persist_err(&self) -> String;
    fn coordinate_of(&self, id: &str) -> Result<String, WorkspaceError>;
    fn is_known_tab_id(&self, id: &str) -> bool;
    fn entries(&self) -> Vec<TabEntry>;
    /// `None` 은 판단 근거가 없다는 뜻이다(읽지 못했다) — 창이 없는 것과 다르다 (FR-SBX-9).
    fn windows(&self) -> Option<Vec<WindowInfo>>;
}

/// Go `UpdateService`: 새 판 확인 (UPDATE_NOTICE_SRS). 5.5.8 이 표면을 더한다.
pub trait UpdateService: Send + Sync {
    /// 확인을 한 번 깨운다(블로킹일 수 있다).
    fn trigger(&self);
}

/// Go `SettingsStore` 중 이 하위 이슈가 읽는 가지 (설정 blob 저장소). 5.5.8 이 나머지를 더한다.
pub trait SettingsStore: Send + Sync {
    /// 새 도구에 얹을 환경의 사본이다 (FR-ARE-7).
    fn render_env(&self) -> Vec<String>;
    /// 탭 이름을 전경 프로그램에서 파생하는가다 (FR-TAN-19).
    fn fg_tab_names(&self) -> bool;
}

/// Go `SandboxReaper`: 샌드박스 창의 접합면이다. httpapi 는 컨테이너 런타임을 알지 않는다.
pub trait SandboxReaper: Send + Sync {
    /// 살아 있지 않은 Window 의 대응 컨테이너를 치운다.
    fn reap(&self, live: &[String]);
    /// 화면이 고를 수 있는 프로파일들이다 (FR-SBX-25).
    fn profiles(&self) -> Vec<dm_shared_sandbox::ProfileInfo>;
    /// 설정창이 정의 파일을 다루는 자리다 (FR-SBX-43).
    fn config(&self) -> Result<dm_shared_sandbox::Config, dm_shared_sandbox::Error>;
    fn save_config(&self, blob: &[u8]) -> Result<(), dm_shared_sandbox::Error>;
}

/// Go `StatsSnapshotter`: 상태바 지표의 스냅샷 (FR-STAT-9).
pub trait StatsSnapshotter: Send + Sync {
    fn snapshot(&self) -> dm_webserver_domain_sysstat::Snapshot;
}
