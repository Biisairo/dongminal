//! 서버만 내보내는 SSE 본문들. 키 순서는 Go `map[string]any` 의 직렬화(이름순)와 같다.

use std::sync::atomic::{AtomicU64, Ordering};

use dm_shared_toolhub::ToolInfo;
use dm_webserver_sse::payload;
use serde::Serialize;

/// 어휘 판정이다. `ended` 는 종료 신호 — 카드 제거(상태로 저장하지 않음).
pub fn valid_activity_state(s: &str) -> bool {
    dm_shared_activity::valid(s)
}

#[derive(Serialize)]
struct ToolActivity<'a> {
    detail: &'a str,
    state: &'a str,
    tool: &'a str,
    #[serde(rename = "toolId")]
    tool_id: &'a str,
}

/// `tool_activity` 본문이다.
pub(crate) fn tool_activity_payload(
    tool_id: &str,
    state: &str,
    tool: &str,
    detail: &str,
) -> Vec<u8> {
    payload(
        "tool_activity",
        Some(&ToolActivity {
            detail,
            state,
            tool,
            tool_id,
        }),
    )
}

/// 알람 방송의 번호다 (ATTENTION_FIRING_SRS FR-ATD-1).
static ATTN_SEQ: AtomicU64 = AtomicU64::new(0);

#[derive(Serialize)]
struct ToolAttention<'a> {
    reason: &'a str,
    seq: u64,
    #[serde(rename = "toolId")]
    tool_id: &'a str,
}

pub(crate) fn tool_attention_payload(tool_id: &str, reason: &str) -> Vec<u8> {
    let seq = ATTN_SEQ.fetch_add(1, Ordering::SeqCst) + 1;
    payload(
        "tool_attention",
        Some(&ToolAttention {
            reason,
            seq,
            tool_id,
        }),
    )
}

#[derive(Serialize)]
struct ToolOnly<'a> {
    #[serde(rename = "toolId")]
    tool_id: &'a str,
}

pub(crate) fn tool_attention_clear_payload(tool_id: &str) -> Vec<u8> {
    payload("tool_attention_clear", Some(&ToolOnly { tool_id }))
}

/// 백그라운드 목록 변화다 (FR-BGP-2). 목록을 싣지 않는다 (FR-BGV-1).
pub fn background_changed_payload() -> Vec<u8> {
    payload::<()>("tools_background_changed", None)
}

/// Claude 다중 계정 변화다 (FR-CAC-122). 본문을 싣지 않는다.
pub fn claude_accounts_changed_payload() -> Vec<u8> {
    payload::<()>("claude_accounts_changed", None)
}

/// 계정 알림이다 (FR-CAC-100a).
pub fn claude_account_alert_payload<T: Serialize + ?Sized>(alert: &T) -> Vec<u8> {
    payload("claude_account_alert", Some(alert))
}

/// 판 확인 결과 변화다 (FR-UPD-8a). 결과를 싣지 않는다.
pub fn update_changed_payload() -> Vec<u8> {
    payload::<()>("update_changed", None)
}

#[derive(Serialize)]
struct ToolForeground<'a> {
    name: &'a str,
    #[serde(rename = "toolId")]
    tool_id: &'a str,
}

/// `tool_foreground` 본문이다. 이름이 비면 전경 프로그램이 없다는 뜻이다 (FR-TAN-12).
pub(crate) fn tool_foreground_payload(tool_id: &str, name: &str) -> Vec<u8> {
    payload("tool_foreground", Some(&ToolForeground { name, tool_id }))
}

/// 도구마다 지금의 전경 이름 이벤트다 (FR-FLK-3). 빈 이름도 싣는다.
pub fn foreground_snapshot(tools: &[ToolInfo]) -> Vec<Vec<u8>> {
    tools
        .iter()
        .map(|t| tool_foreground_payload(&t.id, &t.fg_name))
        .collect()
}

#[derive(Serialize)]
struct GitChanged<'a> {
    mark: &'a str,
    repo: &'a str,
}

/// `git_changed` 본문이다. status·signature 를 싣지 않는다 (FR-GPO-4).
pub(crate) fn git_changed_payload(repo: &str, mark: &str) -> Vec<u8> {
    payload("git_changed", Some(&GitChanged { mark, repo }))
}
