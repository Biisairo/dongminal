//! codex 선언. best-effort 다 (FR-ADP-4 / D-D). 표준 notify 는 `agent-turn-complete` 하나뿐이다.

use dm_gocompat::json;
use dm_shared_activity as activity;
use serde::Deserialize;

use crate::{Adapter, PolicyInjection, PromptInjection, Readiness, Report, Signals};

pub(crate) static ADAPTER: Adapter = Adapter {
    id: "codex",
    detect_cmd: "codex",
    launch: &["codex"],
    model_flag: "--model",
    prompt_injection: PromptInjection::Argv,
    argv_separator: "",
    member_args: &[],
    policy_injection: PolicyInjection {
        flags: &["-c"],
        session_scoped: true,
        shim: false,
    },
    hook_parse: parse_hook,
    // FR-AEV-12: Working=false 가 가장 중요한 한 줄이다.
    signals: Signals {
        idle: false,
        working: false,
        waiting: false,
        done: true,
        ended: false,
        compaction: false,
        tool_detail: false,
        session: false,
    },
    readiness: Readiness {
        hooks: false,
        screen_patterns: &[],
    },
    activity_from_notify: true,
    status_line_reporter: false,
    exit_command: "",
    resume: None,
    session_pids: None,
    install_assets: None,
    parse_usage: None,
    context_window: None,
};

#[derive(Deserialize, Default)]
#[serde(default)]
struct NotifyEvent {
    #[serde(rename = "type")]
    kind: String,
    #[serde(rename = "last-assistant-message")]
    last_message: String,
}

/// codex notify → 활동 보고. tool/detail 은 언제나 비어 있다 (FR-AAP-9). detail 은 마지막 메시지다 (FR-AEV-15).
pub(crate) fn parse_hook(data: &[u8]) -> Option<Report> {
    let ev: NotifyEvent = json::unmarshal(data).ok()?;
    (ev.kind == "agent-turn-complete").then(|| Report {
        state: activity::DONE.to_owned(),
        detail: ev.last_message,
        ..Report::default()
    })
}
