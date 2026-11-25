//! 메서드·이벤트 이름과 그 인자·결과의 모양이다 (OPTIMIZE_REFACTOR_SRS FR-OPT-2-6).

use std::collections::BTreeMap;

use otter_gocompat::json::{self, RawMessage};
use otter_shared_toolhub::{AgentState, BackgroundEntry, TermModes, ToolInfo};
use serde::{Deserialize, Serialize};

pub const METHOD_HELLO: &str = "hello";
pub const METHOD_CREATE: &str = "create";
pub const METHOD_RESTORE: &str = "restore";
pub const METHOD_KILL: &str = "kill";
pub const METHOD_TERMINATE: &str = "terminate";
pub const METHOD_WRITE: &str = "write";
pub const METHOD_PASTE: &str = "paste";
pub const METHOD_RESIZE: &str = "resize";
pub const METHOD_LIST: &str = "list";
pub const METHOD_SNAPSHOT: &str = "snapshot";
/// 화면 상태 스냅숏 (PERF FR-TRM-4). FEATURE_SCREEN_STATE 를 말한 데몬에만 보낸다.
pub const METHOD_SCREEN: &str = "screen";
/// 화면 상태의 글자 (PERF FR-TRM-8, D-22). read-screen 이 부른다.
pub const METHOD_SCREEN_TEXT: &str = "screentext";
pub const METHOD_CWD: &str = "cwd";
pub const METHOD_BUSY: &str = "busy";
pub const METHOD_BUSY_MANY: &str = "busymany";
pub const METHOD_SET_BACKGROUND: &str = "setbackground";
pub const METHOD_BACKGROUND_LIST: &str = "backgroundlist";
/// 응답 없는 알림이다 (FR-OPT-2-2). 인자는 write·resize 와 같고 id 를 싣지 않는다.
pub const METHOD_INPUT: &str = "input";
pub const METHOD_RESIZE_NOTIFY: &str = "resizenotify";
/// 에이전트 기록 (FR-ARD-11·13). FEATURE_RECORDS 를 말한 데몬에만 보낸다.
pub const METHOD_RECORD_SET: &str = "recordset";
pub const METHOD_RECORDS: &str = "records";
/// 알람 판정 (§3.3a). FEATURE_ATTENTION 을 말한 데몬에만 보낸다.
pub const METHOD_ATTN_CONFIG: &str = "attnconfig";
pub const METHOD_ATTEND: &str = "attend";
pub const METHOD_ATTEND_ALL: &str = "attendall";
pub const METHOD_REPORT: &str = "report";
/// 간선 (PEER_DAEMON_SRS §3.5a). FEATURE_EDGE 를 말한 데몬에만 보낸다.
pub const METHOD_EDGE: &str = "edge";
pub const METHOD_EDGE_PORT: &str = "edgeport";
/// 사람 참가자의 채팅 (PEER_CHAT_SRS §3.11). FEATURE_CHAT 을 말한 데몬에만 보낸다.
pub const METHOD_CHAT: &str = "chat";
/// 복구 판정의 셸 상태 (FR-RRC-10). FEATURE_SHELL_PROBE 를 말한 데몬에만 보낸다.
pub const METHOD_SHELL_PROBE: &str = "shellprobe";

pub const EVENT_OUTPUT: &str = "output";
pub const EVENT_FOREGROUND: &str = "fg";
pub const EVENT_EXIT: &str = "exit";
pub const EVENT_SIZE: &str = "size";
pub const EVENT_REPORT: &str = "report";
pub const EVENT_ATTN: &str = "attn";
pub const EVENT_EDGES: &str = "edges";
pub const EVENT_CHAT: &str = "chat";

/// 서버가 hello 에 싣는 것이다. 비어 있으면 키째 빠진다 (D-OPT-1).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "toolipc.HelloParams")]
pub struct HelloParams {
    #[serde(skip_serializing_if = "json::is_empty")]
    pub features: Vec<String>,
}

/// 판 둘(FR-VHL-1)과 데몬이 아는 기능 이름이다 (D-OPT-1).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "toolipc.HelloResult")]
pub struct HelloResult {
    pub build: String,
    #[serde(skip_serializing_if = "json::is_empty")]
    pub features: Vec<String>,
    pub version: i64,
}

/// 데몬이 전경 조회 티커를 돌리고 fg push 를 민다 (FR-OPT-2-1).
pub const FEATURE_FOREGROUND_TICK: &str = "fgtick";
/// 없는 도구의 snapshot 을 CODE_NOT_FOUND 로 답한다 (FR-OPT-2-5).
pub const FEATURE_SNAPSHOT_NOT_FOUND: &str = "snapnotfound";
/// input·resizenotify 알림을 안다 (FR-OPT-2-2).
pub const FEATURE_NOTIFY: &str = "notify";
/// busymany 일괄 조회를 안다 (FR-OPT-2-4).
pub const FEATURE_BUSY_MANY: &str = "busymany";
/// recordset·records 와 record push 를 안다 (FR-ARD-11~14).
pub const FEATURE_RECORDS: &str = "records";
/// 서버가 report push 를 안다 (§3.2a).
pub const FEATURE_REPORTS: &str = "reports";
/// 알람 판정을 데몬이 한다 (§3.3a). 양쪽이 말한다.
pub const FEATURE_ATTENTION: &str = "attention";
/// 데몬이 노드다 (FR-PDM-50). 양쪽이 말한다.
pub const FEATURE_EDGE: &str = "edge";
/// 채팅의 사람 참가자 (§3.11). 양쪽이 말한다.
pub const FEATURE_CHAT: &str = "chat";
/// shellprobe 를 안다 (FR-RRC-10).
pub const FEATURE_SHELL_PROBE: &str = "shellprobe";

/// 화면 상태 스냅숏(`screen`)을 안다 (PERF FR-TRM-4, D-18).
pub const FEATURE_SCREEN_STATE: &str = "screen";

/// 이 데몬이 hello 에서 말하는 기능이다.
pub const DAEMON_FEATURES: &[&str] = &[
    FEATURE_FOREGROUND_TICK,
    FEATURE_SNAPSHOT_NOT_FOUND,
    FEATURE_NOTIFY,
    FEATURE_BUSY_MANY,
    FEATURE_RECORDS,
    FEATURE_ATTENTION,
    FEATURE_EDGE,
    FEATURE_CHAT,
    FEATURE_SHELL_PROBE,
    FEATURE_SCREEN_STATE,
];
/// 서버가 hello 에서 말하는 기능이다.
pub const SERVER_FEATURES: &[&str] = &[
    FEATURE_REPORTS,
    FEATURE_ATTENTION,
    FEATURE_EDGE,
    FEATURE_CHAT,
];

/// 상대가 말한 기능 목록에 name 이 있는가다. 말하지 않은 옛 상대는 아무것도 갖지 않는다.
pub fn has_feature<S: AsRef<str>>(features: &[S], name: &str) -> bool {
    features.iter().any(|f| f.as_ref() == name)
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "toolipc.CreateParams")]
pub struct CreateParams {
    pub cols: u16,
    pub command: String,
    pub cwd: String,
    #[serde(rename = "extraEnv")]
    pub extra_env: Option<Vec<String>>,
    pub profile: String,
    pub rows: u16,
    pub window: String,
    pub work: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "toolipc.CreateResult")]
pub struct CreateResult {
    pub cols: u16,
    pub id: String,
    pub name: String,
    pub pid: i64,
    pub rows: u16,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "toolipc.RestoreParams")]
pub struct RestoreParams {
    pub cols: u16,
    pub cwd: String,
    pub id: String,
    pub name: String,
    pub rows: u16,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "toolipc.RestoreResult")]
pub struct RestoreResult {
    pub cols: u16,
    pub id: String,
    pub rows: u16,
}

/// 도구 id 하나만 싣는 요청이다 — kill·cwd·busy.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "toolipc.IDParams")]
pub struct IdParams {
    pub id: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "toolipc.TerminateParams")]
pub struct TerminateParams {
    #[serde(rename = "graceMs")]
    pub grace_ms: i64,
    pub id: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "toolipc.WriteParams")]
pub struct WriteParams {
    #[serde(with = "json::bytes")]
    pub data: Vec<u8>,
    pub id: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "toolipc.PasteParams")]
pub struct PasteParams {
    #[serde(with = "json::bytes")]
    pub data: Vec<u8>,
    pub id: String,
    pub submit: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "toolipc.ResizeParams")]
pub struct ResizeParams {
    pub cols: u16,
    pub id: String,
    pub rows: u16,
}

/// since 가 없는 옛 요청은 -1(전량 재생)로 읽는다 (FR-TRS-3) — 받는 쪽이 -1 로 채운 뒤 푼다.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "toolipc.SnapshotParams")]
pub struct SnapshotParams {
    pub id: String,
    pub since: i64,
}

/// toolhub `ToolSnapshot` 의 와이어 모양이다. 제로값은 "모른다" 다 (FR-M9-3 ①, FR-TMR-24).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "toolipc.SnapshotResult")]
pub struct SnapshotResult {
    pub cols: u16,
    #[serde(with = "json::bytes")]
    pub data: Vec<u8>,
    pub end: i64,
    pub modes: TermModes,
    pub resumed: bool,
    pub retained: i64,
    pub rows: u16,
    #[serde(rename = "totalBytesDrop")]
    pub total_bytes_drop: i64,
    #[serde(rename = "totalBytesIn")]
    pub total_bytes_in: i64,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "toolipc.ScreenParams")]
pub struct ScreenParams {
    /// 스냅숏에 실을 기록 행 수다.
    pub history: usize,
    pub id: String,
}

/// 화면 상태 스냅숏이다. `data` 를 새 터미널에 넣고 출력 오프셋 `end` 뒤를 이어 넣는다.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "toolipc.ScreenResult")]
pub struct ScreenResult {
    pub alt: bool,
    pub cols: u16,
    pub cwd: String,
    #[serde(with = "json::bytes")]
    pub data: Vec<u8>,
    pub end: i64,
    /// 실린 가장 오래된 기록 줄의 절대 번호(줄 저장소 번호)다.
    #[serde(rename = "firstLine")]
    pub first_line: u64,
    pub rows: u16,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "toolipc.ScreenTextParams")]
pub struct ScreenTextParams {
    /// 끝에서 이만큼의 바이트 안에서 낸다. 0 은 화면과 기록 전부다.
    pub bytes: usize,
    pub id: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "toolipc.ScreenTextResult")]
pub struct ScreenTextResult {
    pub text: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "toolipc.CwdResult")]
pub struct CwdResult {
    pub cwd: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "toolipc.BusyResult")]
pub struct BusyResult {
    pub busy: bool,
}

/// shellprobe 다 (FR-RRC-10). pids 는 세션 등록부가 그 세션을 기록한 pid 들이다.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "toolipc.ShellProbeParams")]
pub struct ShellProbeParams {
    pub id: String,
    pub pids: Option<Vec<i64>>,
}

/// state 는 toolhub `ShellState::as_str` 의 값이다.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "toolipc.ShellProbeResult")]
pub struct ShellProbeResult {
    pub state: String,
}

/// busymany 다 (FR-OPT-2-4). 없는 도구는 false 다.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "toolipc.BusyManyParams")]
pub struct BusyManyParams {
    pub ids: Option<Vec<String>>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "toolipc.BusyManyResult")]
pub struct BusyManyResult {
    pub busy: Option<BTreeMap<String, bool>>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "toolipc.SetBackgroundParams")]
pub struct SetBackgroundParams {
    pub background: bool,
    pub id: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "toolipc.SetBackgroundResult")]
pub struct SetBackgroundResult {
    pub ok: bool,
}

/// tools 가 `None` 이면 와이어에서 `null`(0개)이다. 받는 쪽은 키가 없는 것과 가른다 (FR-TLU-2).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "toolipc.ListResult")]
pub struct ListResult {
    pub tools: Option<Vec<ToolInfo>>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "toolipc.BackgroundListResult")]
pub struct BackgroundListResult {
    pub background: Option<Vec<BackgroundEntry>>,
}

/// end 는 이 청크 끝의 절대 오프셋이다 (FR-TRS-15).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "toolipc.OutputEvent")]
pub struct OutputEvent {
    #[serde(with = "json::bytes")]
    pub data: Vec<u8>,
    pub end: i64,
    pub event: String,
    pub tool: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "toolipc.ExitEvent")]
pub struct ExitEvent {
    pub code: i64,
    pub event: String,
    pub tool: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "toolipc.ForegroundEvent")]
pub struct ForegroundEvent {
    pub event: String,
    pub name: String,
    pub tool: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "toolipc.SizeEvent")]
pub struct SizeEvent {
    pub cols: u16,
    pub event: String,
    pub rows: u16,
    pub tool: String,
}

/// 기록의 종류다 (§3.1a). RECORD_AGENT 의 값은 toolhub `AgentState` 이고 나머지는 서버가 정한 JSON 이다.
pub const RECORD_AGENT: &str = "agent";
pub const RECORD_USAGE: &str = "usage";
pub const RECORD_SUBAGENTS: &str = "subagents";
pub const RECORD_SUBAGENT_ACTS: &str = "subagentActs";
pub const RECORD_MIGRATION_TOLD: &str = "migrationTold";
/// 도구가 없는 전역 기록이다.
pub const RECORD_LIMITS: &str = "limits";

/// kind 가 도구 없는 전역 기록인가다. 모르는 종류는 `None` 이다 (Go 의 ok=false).
pub fn record_is_global(kind: &str) -> Option<bool> {
    match kind {
        RECORD_LIMITS => Some(true),
        RECORD_AGENT
        | RECORD_USAGE
        | RECORD_SUBAGENTS
        | RECORD_SUBAGENT_ACTS
        | RECORD_MIGRATION_TOLD => Some(false),
        _ => None,
    }
}

/// recordset 이다. value 가 null 이면 그 기록을 지운다.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "toolipc.RecordSetParams")]
pub struct RecordSetParams {
    pub kind: String,
    #[serde(skip_serializing_if = "json::is_empty")]
    pub tool: String,
    pub value: RawMessage,
}

/// records 스냅샷이다. tools 는 살아 있는 도구 전부다.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "toolipc.RecordsResult")]
pub struct RecordsResult {
    #[serde(skip_serializing_if = "json::is_empty")]
    pub global: BTreeMap<String, RawMessage>,
    pub tools: Option<Vec<ToolRecords>>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "toolipc.ToolRecords")]
pub struct ToolRecords {
    pub agent: AgentState,
    #[serde(skip_serializing_if = "json::is_empty")]
    pub records: BTreeMap<String, RawMessage>,
    pub tool: String,
}

/// report push 다 — 데몬의 보고 소켓이 받은 보고 그대로다 (§3.2a).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "toolipc.ReportEvent")]
pub struct ReportEvent {
    pub event: String,
    pub method: String,
    pub body: RawMessage,
}
