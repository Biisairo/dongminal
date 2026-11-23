use dm_gocompat::json;
use serde::{Deserialize, Serialize};

use crate::TermModes;

/// 목록의 한 줄이다 (M8 `GO-13`). 데몬의 `list` RPC 가 이 구조체를 그대로 싣는다.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "toolhub.ToolInfo")]
pub struct ToolInfo {
    pub id: String,
    pub name: String,
    pub pid: i64,
    #[serde(rename = "sizeCols")]
    pub cols: i64,
    #[serde(rename = "sizeRows")]
    pub rows: i64,
    /// 전경 프로세스 이름이다 (FR-TAN-7).
    #[serde(rename = "fgName")]
    pub fg_name: String,
    /// 에이전트 도구의 어댑터 id 다. 비어 있으면 터미널이다 (M8_UNIFIED_SRS D-U-4).
    #[serde(skip_serializing_if = "json::is_empty")]
    pub agent: String,
    /// 프로세스 없는 에이전트 세션의 상태다. 서버가 `/api/state` 에서만 채운다.
    #[serde(skip_serializing_if = "json::is_empty")]
    pub dormant: String,
}

/// 도구 출력 한 조각이다. `end` 는 조각 **끝**의 절대 오프셋이고 0 은 "모른다" 다
/// (TERMINAL_RESUME_SRS FR-TRS-15·16). `size` 가 있으면 출력이 아니라 크기 통보다 (M9_SRS FR-M9-3 ②).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct OutChunk {
    pub data: Vec<u8>,
    pub end: i64,
    pub size: Option<TermSize>,
}

/// PTY 의 크기다 (FR-M9-3).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TermSize {
    pub cols: u16,
    pub rows: u16,
}

/// 데몬이 hello 에서 말한 자기 판이다. `build` 가 비면 "모른다" 이고 불일치가 아니다 (FR-CBG-5).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DaemonInfo {
    pub protocol: i64,
    pub build: String,
}

/// 재접속 스크롤백 복원용 출력 버퍼 상태다 (DAEMON_SPLIT_SRS §6.6). 와이어 모양은 toolipc `SnapshotResult` 다.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ToolSnapshot {
    pub data: Vec<u8>,
    pub total_bytes_in: i64,
    pub total_bytes_drop: i64,
    pub retained: i64,
    /// `data` 끝의 절대 오프셋 (FR-TRS-6).
    pub end: i64,
    /// since 에서 이어 붙였는가. 거짓이면 전량 재생이다 (FR-TRS-10).
    pub resumed: bool,
    /// 지금 PTY 의 크기. 0 은 "모른다" (FR-M9-3 ①).
    pub cols: u16,
    pub rows: u16,
    /// 앱이 켜 둔 터미널 모드 (FR-TMR-24).
    pub modes: TermModes,
}

/// 백그라운드 도구 한 건이다 (FR-BG-6).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "toolhub.BackgroundEntry")]
pub struct BackgroundEntry {
    #[serde(rename = "toolId")]
    pub tool_id: String,
    pub name: String,
    pub cwd: String,
    pub since: i64,
}
