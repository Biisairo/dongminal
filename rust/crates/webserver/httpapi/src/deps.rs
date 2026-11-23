//! 주입 trait (Go `deps.go`). 하위 이슈가 자기가 쓰는 것을 더한다.

use dm_shared_workspace::{Error as WorkspaceError, TabEntry, WindowInfo};

/// Go `WorkspaceStore`: workspace.json 의 저장소다.
pub trait WorkspaceStore: Send + Sync {
    fn raw(&self) -> Vec<u8>;
    fn current_rev(&self) -> u64;
    fn load_err(&self) -> String;
    fn persist_err(&self) -> String;
    fn snapshot(&self) -> (Vec<u8>, u64);
    fn save(&self, blob: &[u8], if_match: &str) -> Result<u64, WorkspaceError>;
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
