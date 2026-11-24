//! Go 기준선 `otterminal/internal/webserver/seam/toolaccess` 의 Rust 포팅.
//!
//! 도구(PTY)·워크스페이스·커맨드 허브에 대한 읽기·쓰기 접합면이다. 구체 타입(httpapi,
//! workspace)을 소비자에게 드러내지 않는 경계이며, 구현은 `seam/adapters` 가 준다.

use otter_shared_pollwait::Changed;

/// 접합면의 오류다. 구현의 문구를 그대로 실어 나른다.
pub type Error = Box<dyn std::error::Error + Send + Sync>;

/// 살아 있는 도구 하나의 최소 요약이다.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ToolInfo {
    pub id: String,
    pub name: String,
    pub shell_pid: i64,
    /// 전경 프로세스 이름이다. 셸이 프롬프트에 있으면 cwd 의 마지막 조각(홈이면 `~`)이고,
    /// 그것도 모를 때만 빈 문자열이다 (FR-TAN-5/6, FR-UXF-65). 직접·데몬 모드에서 같게
    /// 채운다 (FR-TAN-7).
    pub foreground_name: String,
}

/// PTY 도구의 읽기·쓰기다.
pub trait ToolReader: Send + Sync {
    fn list(&self) -> Vec<ToolInfo>;
    fn has(&self, tool_id: &str) -> bool;
    /// 화면 버퍼와 누적 소실 바이트 수다. 도구가 없으면 `None`.
    fn snapshot(&self, tool_id: &str) -> Option<(Vec<u8>, i64)>;
    fn send_paste(&self, tool_id: &str, text: &[u8], submit: bool) -> Result<(), Error>;
    fn size(&self, tool_id: &str) -> String;
}

/// `workspace.TabEntry` 의 거울이다. 도구 계층이 workspace 를 직접 쓰지 않게 이 crate 가 갖는다.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct WorkspaceEntry {
    pub tool_id: String,
    pub label: String,
    pub window_name: String,
    pub tab_name: String,
    pub is_active: bool,
    /// 개체 식별자 (UUID_IDENTITY_SRS Phase 1). 스키마 이전의 workspace.json 이면 비어 있다.
    pub window_uuid: String,
    pub pane_uuid: String,
    pub tab_uuid: String,
    pub short_code: String,
}

/// 워크스페이스 색인의 읽기다.
pub trait WorkspaceReader: Send + Sync {
    fn resolve(&self, label_or_id: &str) -> Result<String, Error>;
    /// 좌표 라벨을 받지 않는 `resolve` 다 (FR-IDU-1). 에이전트용 종단이 쓴다.
    fn resolve_strict(&self, id: &str) -> Result<String, Error>;
    fn entries(&self) -> Vec<WorkspaceEntry>;
    /// UUID 를 정규 좌표(`W{n}.P{n}.T{n}`)로 바꾼다. UUID 가 아니면 그대로 둔다.
    fn coordinate_of(&self, id: &str) -> Result<String, Error>;
    /// `id` 가 알려진 tab.id 인가다 (FR-DMC-9).
    fn is_known_tab_id(&self, id: &str) -> bool;
    /// 다음 색인 교체에 울릴 구독이다 (FR-OPT-8-4).
    fn changes(&self) -> Changed;
}

/// 호출자의 원격 주소를 그 셸이 품은 도구로 바꾼다 (PID 부모 사슬, FR-API-WAI-1).
pub trait ClientToolResolver: Send + Sync {
    /// `(tool_id, shell_pid)`.
    fn resolve_client_pane(&self, remote_addr: &str) -> Result<(String, i64), Error>;
}
