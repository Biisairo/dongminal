//! Claude Code 선언. 이것이 검증 대상이다 (D-D).

use std::fs;
use std::io;
use std::path::PathBuf;

use otter_gocompat::json::{self, RawMessage};
use otter_shared_activity as activity;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::install::{InstallSpec, mkdir_all, write_json};
use crate::{
    Adapter, BRIDGE_INPUT_MAX, PolicyInjection, PromptInjection, Readiness, Report, Signals,
    SubReport, Usage,
};

pub(crate) const CLAUDE_ID: &str = "claude";

pub(crate) static ADAPTER: Adapter = Adapter {
    id: CLAUDE_ID,
    detect_cmd: "claude",
    launch: &["claude"],
    model_flag: "--model",
    prompt_injection: PromptInjection::Argv,
    argv_separator: "--",
    // 멤버가 보고·질문을 할 수 있게 otterctl 만 사전 허용한다.
    member_args: &["--allowedTools", "Bash(otterctl:*)"],
    policy_injection: PolicyInjection {
        flags: &["--settings", "--plugin-dir"],
        session_scoped: true,
        shim: true,
    },
    hook_parse: parse_hook,
    signals: Signals {
        idle: true,
        working: true,
        waiting: true,
        done: true,
        ended: true,
        compaction: true,
        tool_detail: true,
        session: true,
    },
    readiness: Readiness {
        hooks: true,
        screen_patterns: &[],
    },
    activity_from_notify: false,
    status_line_reporter: true,
    exit_command: "/exit",
    // `claude --resume <session-id>` (FR-RRC-2).
    resume: Some(|id| vec!["--resume".to_owned(), id.to_owned()]),
    session_pids: Some(session_pids),
    install_assets: Some(install_assets),
    parse_usage: Some(parse_usage),
    context_window: Some(context_window),
};

#[derive(Deserialize, Default)]
#[serde(default)]
struct HookEvent {
    hook_event_name: String,
    tool_name: String,
    tool_input: RawMessage,
    prompt: String,
    message: String,
    notification_type: String,
    source: String,
    trigger: String,
    error: String,
    agent_id: String,
    agent_type: String,
    session_id: String,
    transcript_path: String,
}

fn rep(state: &str) -> Report {
    Report {
        state: state.to_owned(),
        ..Report::default()
    }
}

/// 훅 이벤트를 활동 보고로 바꾼다 (FR-AAP-7, 해석표 FR-ASV-4·5).
/// state 가 빈 보고는 "main 상태를 바꾸지 않는다"다.
pub(crate) fn parse_hook(data: &[u8]) -> Option<Report> {
    let ev: HookEvent = json::unmarshal(data).ok()?;
    // FR-ASV-3: 내부 에이전트(프롬프트 제안·/btw)의 훅이다.
    if !ev.agent_id.is_empty() && ev.agent_type.is_empty() {
        return None;
    }
    let detail = || tool_detail(&ev.tool_name, &ev.tool_input);
    if !ev.agent_id.is_empty() {
        let mut r = parse_subagent_hook(&ev);
        if let Some(s) = r.sub.as_mut() {
            s.agent_id.clone_from(&ev.agent_id);
            s.agent_type.clone_from(&ev.agent_type);
        }
        r.session_id.clone_from(&ev.session_id);
        r.transcript.clone_from(&ev.transcript_path);
        set_bridge_fields(&mut r, &ev);
        return Some(r);
    }
    let mut r = match ev.hook_event_name.as_str() {
        "PreToolUse" | "PostToolUse" | "PostToolUseFailure" => Report {
            tool: ev.tool_name.clone(),
            detail: detail(),
            ..rep(activity::WORKING)
        },
        // C-5: 이 훅은 대화상자와 함께 온다.
        "PermissionRequest" => Report {
            tool: ev.tool_name.clone(),
            detail: detail(),
            ..rep(activity::WAITING)
        },
        "SubagentStart" | "SubagentStop" => Report::default(),
        "PostCompact" if ev.trigger == "manual" => rep(activity::IDLE),
        "PostCompact" => Report::default(),
        "StopFailure" => Report {
            detail: ev.error.clone(),
            ..rep(activity::DONE)
        },
        "PreCompact" => Report {
            compacted: true,
            ..rep(activity::WORKING)
        },
        "UserPromptSubmit" => Report {
            detail: ev.prompt.clone(),
            ..rep(activity::WORKING)
        },
        // C-2: idle_prompt 는 기다림이 아니다 (D-ASV-7).
        "Notification" if waiting_notification(&ev.notification_type) => Report {
            detail: ev.message.clone(),
            ..rep(activity::WAITING)
        },
        "Notification" => Report::default(),
        "Stop" => rep(activity::DONE),
        "SessionEnd" => rep(activity::ENDED),
        // C-7: 압축 뒤의 SessionStart 는 턴 한가운데에도 온다.
        "SessionStart" if ev.source != "compact" => Report {
            detail: ev.source.clone(),
            ..rep(activity::IDLE)
        },
        "SessionStart" => Report::default(),
        _ => return None,
    };
    r.session_id.clone_from(&ev.session_id);
    r.transcript.clone_from(&ev.transcript_path);
    set_bridge_fields(&mut r, &ev);
    Some(r)
}

/// 브리지의 곁들이 값 (FR-TGB-80·81). 원문은 권한 요청과 AskUserQuestion 의 PreToolUse 에만 싣는다.
fn set_bridge_fields(r: &mut Report, ev: &HookEvent) {
    r.hook.clone_from(&ev.hook_event_name);
    let event = ev.hook_event_name.as_str();
    if event != "PermissionRequest" && !(event == "PreToolUse" && ev.tool_name == ASK_TOOL) {
        return;
    }
    if ev.tool_input.0.len() > BRIDGE_INPUT_MAX {
        r.input_over = true;
        return;
    }
    r.input = ev.tool_input.clone();
}

const ASK_TOOL: &str = "AskUserQuestion";
const HANDBACK_TOOL: &str = "SubagentHandback";

fn waiting_notification(kind: &str) -> bool {
    matches!(
        kind,
        "permission_prompt" | "elicitation_dialog" | "elicitation_url_dialog" | "agent_needs_input"
    )
}

fn sub(state: &str, tool: &str, detail: &str) -> Option<SubReport> {
    Some(SubReport {
        state: state.to_owned(),
        tool: tool.to_owned(),
        detail: detail.to_owned(),
        ..SubReport::default()
    })
}

/// 서브에이전트 훅의 해석이다 (FR-ASV-5). 사람을 기다리게 하는 두 훅만 main 도 waiting 이 된다.
fn parse_subagent_hook(ev: &HookEvent) -> Report {
    let tool = ev.tool_name.as_str();
    match ev.hook_event_name.as_str() {
        "SubagentStart" => Report {
            sub: sub(activity::WORKING, "", ""),
            ..Report::default()
        },
        // C-10: 이 도구는 서브에이전트의 마지막 일이다 (D-ASV-13).
        "PreToolUse" | "PostToolUse" | "PostToolUseFailure" if tool == HANDBACK_TOOL => Report {
            sub: sub(activity::DONE, tool, ""),
            ..Report::default()
        },
        "PreToolUse" | "PostToolUse" | "PostToolUseFailure" => Report {
            sub: sub(activity::WORKING, tool, &tool_detail(tool, &ev.tool_input)),
            ..Report::default()
        },
        "PermissionRequest" => {
            let detail = tool_detail(tool, &ev.tool_input);
            Report {
                tool: tool.to_owned(),
                detail: detail.clone(),
                sub: sub(activity::WAITING, tool, &detail),
                ..rep(activity::WAITING)
            }
        }
        "Notification" if waiting_notification(&ev.notification_type) => Report {
            detail: ev.message.clone(),
            sub: sub(activity::WAITING, "", &ev.message),
            ..rep(activity::WAITING)
        },
        "SubagentStop" => Report {
            sub: sub(activity::DONE, "", ""),
            ..Report::default()
        },
        _ => Report::default(),
    }
}

/// tool_input 에서 표시할 인자 하나를 고른다 (FR-AAP-7). 모르는 도구는 빈 값이다.
fn tool_detail(tool: &str, input: &RawMessage) -> String {
    let Ok(m) = json::unmarshal::<Value>(&input.0) else {
        return String::new();
    };
    let pick = |k: &str| m.get(k).and_then(Value::as_str).unwrap_or("").to_owned();
    match tool {
        "Bash" => pick("command"),
        "Edit" | "Write" | "Read" | "NotebookEdit" => pick("file_path"),
        "Grep" | "Glob" => pick("pattern"),
        _ => String::new(),
    }
}

/// 기본 창이다. 다른 크기인 판만 `MODEL_WINDOWS` 에 적는다 (FR-CTX-5b).
pub(crate) const WINDOW_DEFAULT: f64 = 1_000_000.0;

/// 기본과 다른 판들 (접두, 창). 비어 있는 것은 "아는 예외가 없다"는 뜻이다.
const MODEL_WINDOWS: &[(&str, f64)] = &[];

fn context_window(model: &str) -> Option<f64> {
    context_window_in(MODEL_WINDOWS, model)
}

/// 이 에이전트는 언제나 답한다 — 기본이 있기 때문이다 (FR-CTX-5).
fn context_window_in(table: &[(&str, f64)], model: &str) -> Option<f64> {
    let m = model.trim().to_lowercase();
    let w = table
        .iter()
        .find(|(p, _)| m.starts_with(p))
        .map_or(WINDOW_DEFAULT, |(_, w)| *w);
    Some(w)
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct UsageLine {
    message: UsageMessage,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct UsageMessage {
    model: String,
    usage: Option<UsageTokens>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct UsageTokens {
    input_tokens: i64,
    cache_creation_input_tokens: i64,
    cache_read_input_tokens: i64,
}

/// 전사본 JSONL 한 줄의 입력 컨텍스트 = input + cache_creation + cache_read (FR-AAC-10).
fn parse_usage(line: &str) -> Option<Usage> {
    let line = line.trim();
    if line.is_empty() || !line.contains(r#""usage""#) {
        return None;
    }
    let rec: UsageLine = json::unmarshal(line.as_bytes()).ok()?;
    let u = rec.message.usage?;
    let total = u
        .input_tokens
        .wrapping_add(u.cache_creation_input_tokens)
        .wrapping_add(u.cache_read_input_tokens);
    (total > 0).then_some(Usage {
        tokens: total,
        model: rec.message.model,
    })
}

const SESSIONS_DIR: &str = "sessions";

#[derive(Deserialize, Default)]
#[serde(default)]
struct SessionEntry {
    pid: i64,
    #[serde(rename = "sessionId")]
    session_id: String,
}

/// claude 의 세션 등록부 `<설정 폴더>/sessions/<pid>.json` 을 읽는다 (FR-RRC-5, D-RRC-11).
/// 폴더가 없으면 실행 중인 claude 가 없는 것이고, 읽지 못하면 모르는 것이다.
fn session_pids(session_id: &str, config_dirs: &[PathBuf]) -> Option<Vec<i64>> {
    let mut pids = Vec::new();
    for dir in config_dirs {
        let reg = dir.join(SESSIONS_DIR);
        let entries = match fs::read_dir(&reg) {
            Ok(e) => e,
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                if fs::symlink_metadata(&reg).is_err_and(|e| e.kind() == io::ErrorKind::NotFound) {
                    continue;
                }
                return None;
            }
            Err(_) => return None,
        };
        let mut names: Vec<_> = entries
            .filter_map(Result::ok)
            .filter(|e| !e.file_type().is_ok_and(|t| t.is_dir()))
            .map(|e| e.file_name())
            .collect();
        names.sort();
        for name in names {
            if otter_gocompat::filepath::ext(&name.to_string_lossy()) != ".json" {
                continue;
            }
            let Ok(blob) = fs::read(reg.join(&name)) else {
                continue;
            };
            if let Ok(v) = json::unmarshal::<SessionEntry>(&blob)
                && v.pid > 0
                && v.session_id == session_id
            {
                pids.push(v.pid);
            }
        }
    }
    Some(pids)
}

/// 활동 보고를 걸 훅 이름들. `notify` 배선은 없다 (FR-AEV-20).
pub(crate) const HOOK_EVENTS: &[&str] = &[
    "SessionStart",
    "SessionEnd",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "PreCompact",
    "SubagentStop",
    "Stop",
    "Notification",
    "PermissionRequest",
    "PostToolUseFailure",
    "SubagentStart",
    "StopFailure",
    "PostCompact",
];

/// 맥락 훅(`otterctl ctx-hook`)을 함께 거는 이벤트 (FR-ITM-10).
const CTX_HOOK_EVENTS: &[&str] = &["PostToolUse", "UserPromptSubmit"];

/// 깨움 훅(`otterctl chat-wait`)을 거는 이벤트 (ISSUE_TREE_CHAT_SRS FR-CAL-8).
const CHAT_WAIT_EVENT: &str = "Stop";

/// 깨움 훅의 시한(초)이다. claude 의 명령 훅은 시한이 지나면 끊기고, 끊긴 뒤에 온 글로는 다음
/// Stop 까지 깨우지 않는다. 그래서 쉬는 동안 내내 기다리도록 길게 둔다. 7일이다 — JS 타이머의
/// 상한(2^31 ms, 약 24.8일) 안이다.
pub const CHAT_WAIT_TIMEOUT_SECS: u64 = 7 * 24 * 60 * 60;

/// 활동 훅 설정의 파일명. 셸 래퍼가 이 이름으로 찾는다.
pub(crate) const HOOKS_FILE: &str = "claude.json";

fn install_assets(s: &InstallSpec) -> io::Result<()> {
    write_activity_hooks(s)?;
    write_plugin_hooks(s)
}

pub(crate) fn write_activity_hooks(s: &InstallSpec) -> io::Result<()> {
    let hook = json!({"type": "command", "command": s.hook_command(&["activity", CLAUDE_ID])});
    let ctx = json!({"type": "command", "command": s.hook_command(&["ctx-hook", CLAUDE_ID])});
    let mut hooks = serde_json::Map::new();
    for ev in HOOK_EVENTS {
        let list = if CTX_HOOK_EVENTS.contains(ev) {
            json!([hook, ctx])
        } else if *ev == CHAT_WAIT_EVENT {
            json!([hook, {
                "type": "command",
                "command": s.hook_command(&["chat-wait"]),
                "asyncRewake": true,
                "timeout": CHAT_WAIT_TIMEOUT_SECS,
            }])
        } else {
            json!([hook])
        };
        hooks.insert((*ev).to_owned(), json!([{"matcher": "", "hooks": list}]));
    }
    let settings = json!({
        "hooks": hooks,
        // FR-SLP-1: statusLine 프록시.
        "statusLine": {"type": "command", "command": s.hook_command(&["statusline"])},
        // FR-SAU-5: 서브에이전트 값의 프록시.
        "subagentStatusLine": {"type": "command", "command": s.hook_command(&["subagent-statusline"])},
    });
    write_json(&s.dir.join(HOOKS_FILE), &settings)
}

/// 세션 스코프 플러그인의 SessionStart 훅 (FR-INJ-1 · FR-CTX-2). plugin_dir 이 비면 지난다.
fn write_plugin_hooks(s: &InstallSpec) -> io::Result<()> {
    if s.plugin_dir.as_os_str().is_empty() {
        return Ok(());
    }
    let hooks_dir = s.plugin_dir.join("hooks");
    mkdir_all(&hooks_dir)?;
    let settings = json!({"hooks": {"SessionStart": [{
        "matcher": "",
        "hooks": [{"type": "command", "command": s.hook_command(&["agent-context", CLAUDE_ID])}],
    }]}});
    write_json(&hooks_dir.join("hooks.json"), &settings)
}

#[cfg(test)]
mod tests {
    use super::*;

    // FR-RDF-9: MkdirAll 은 gocompat 의 Go 알고리즘이다. 막힌 칸의 경로로 내고, `x/.` 도 만든다.
    #[test]
    fn mkdir_all_matches_go() {
        let d = tempfile::tempdir().unwrap();
        let blocker = d.path().join("f");
        std::fs::write(&blocker, "x").unwrap();
        let e = mkdir_all(&blocker.join("hooks")).unwrap_err();
        assert_eq!(
            e.to_string(),
            format!("mkdir {}: not a directory", blocker.display())
        );
        let dot = format!("{}/new/.", d.path().display());
        mkdir_all(std::path::Path::new(&dot)).unwrap();
        assert!(d.path().join("new").is_dir());
    }

    #[test]
    fn context_window_exception_beats_default() {
        let table = [("claude-tiny", 200_000.0)];
        assert_eq!(
            context_window_in(&table, "claude-tiny-20260115"),
            Some(200_000.0)
        );
        assert_eq!(
            context_window_in(&table, "claude-opus-5"),
            Some(WINDOW_DEFAULT)
        );
    }

    #[test]
    fn context_window_default_is_one_million() {
        assert_eq!(context_window(""), Some(1_000_000.0));
    }

    #[test]
    fn parse_usage_sums_input_context() {
        let line = r#"{"message":{"model":"m","usage":{"input_tokens":1,"cache_creation_input_tokens":2,"cache_read_input_tokens":3,"output_tokens":9}}}"#;
        assert_eq!(
            parse_usage(line),
            Some(Usage {
                tokens: 6,
                model: "m".into()
            })
        );
        assert_eq!(parse_usage(r#"{"type":"user","message":{}}"#), None);
        assert_eq!(parse_usage(r#"{"message":{"usage":{}}}"#), None);
        assert_eq!(
            parse_usage(r#"{"message":{"usage":{"input_tokens":1.5}}}"#),
            None
        );
    }
}
