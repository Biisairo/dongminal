//! omp(oh my pi) 선언 (OMP_AGENT_SUPPORT_SRS 묶음 A). 훅은 in-process 모듈이라 우리가 shim 을 배포한다.

use std::io;

use otter_gocompat::json;
use otter_shared_activity as activity;
use otter_shared_platform::write_file_if_changed;
use serde::Deserialize;

use crate::install::InstallSpec;
use crate::{Adapter, PolicyInjection, PromptInjection, Readiness, Report, Signals};

/// 멤버의 `otterctl` 사전 허용을 담은 오버레이의 파일명.
pub const OMP_MEMBER_CONFIG_FILE: &str = "omp-member.yml";
/// 활동 보고 훅의 파일명. `omp --hook <이 파일>` 로 붙는다.
pub const OMP_SHIM_FILE: &str = "omp-activity.mjs";

/// `HOOKS_DIR_TOKEN + "/" + OMP_MEMBER_CONFIG_FILE`. 선언은 슬래시, 조립은 OS 표기다 (FR-OMP-22a).
const MEMBER_CONFIG_ARG: &str = "{{otterHooks}}/omp-member.yml";

pub(crate) static ADAPTER: Adapter = Adapter {
    id: "omp",
    detect_cmd: "omp",
    launch: &["omp"],
    model_flag: "--model",
    prompt_injection: PromptInjection::Argv,
    // FR-OMP-3: 없는 함정에 장치를 두지 않는다.
    argv_separator: "",
    member_args: &["--config", MEMBER_CONFIG_ARG],
    policy_injection: PolicyInjection {
        flags: &["--hook", "--plugin-dir"],
        session_scoped: true,
        shim: false,
    },
    hook_parse: parse_hook,
    // FR-AEV-2·3: Waiting 만 거짓이다 — 승인 게이트는 훅에 통지되지 않는다.
    signals: Signals {
        idle: true,
        working: true,
        waiting: false,
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
    status_line_reporter: false,
    exit_command: "/exit",
    // `omp --resume=<value>` (FR-RRC-2).
    resume: Some(|id| vec![format!("--resume={id}")]),
    session_pids: None,
    install_assets: Some(install_assets),
    parse_usage: None,
    context_window: None,
};

#[derive(Deserialize, Default)]
#[serde(default)]
struct ShimEvent {
    event: String,
    tool: String,
    detail: String,
    #[serde(rename = "sessionId")]
    session_id: String,
    transcript: String,
}

/// 우리 shim 의 형식을 활동 보고로 바꾼다 (FR-OMP-6·7). 남의 형식은 `event` 가 비어 거절된다.
pub(crate) fn parse_hook(data: &[u8]) -> Option<Report> {
    let ev: ShimEvent = json::unmarshal(data).ok()?;
    let state = |s: &str| s.to_owned();
    let mut r = match ev.event.as_str() {
        "session_start" => Report {
            state: state(activity::IDLE),
            detail: ev.detail,
            ..Report::default()
        },
        "agent_start" => Report {
            state: state(activity::WORKING),
            detail: ev.detail,
            ..Report::default()
        },
        "turn_start" | "turn_end" => Report {
            state: state(activity::WORKING),
            ..Report::default()
        },
        "tool_call" | "tool_result" => Report {
            state: state(activity::WORKING),
            tool: ev.tool,
            detail: ev.detail,
            ..Report::default()
        },
        "compaction" => Report {
            state: state(activity::WORKING),
            compacted: true,
            ..Report::default()
        },
        "agent_end" => Report {
            state: state(activity::DONE),
            detail: ev.detail,
            ..Report::default()
        },
        "session_shutdown" => Report {
            state: state(activity::ENDED),
            ..Report::default()
        },
        _ => return None,
    };
    r.session_id = ev.session_id;
    r.transcript = ev.transcript;
    Some(r)
}

/// 활동 shim 과 멤버 오버레이를 쓴다 (FR-OMP-10·20). 디렉터리는 호출자가 만들어 둔다.
fn install_assets(s: &InstallSpec) -> io::Result<()> {
    write_file_if_changed(
        &s.dir.join(OMP_SHIM_FILE),
        shim_source(&s.otterctl).as_bytes(),
        0o644,
    )?;
    write_file_if_changed(
        &s.dir.join(OMP_MEMBER_CONFIG_FILE),
        MEMBER_OVERLAY.as_bytes(),
        0o644,
    )
}

/// `otterctl` 만 사전 허용하는 오버레이 (FR-OMP-20·23). 승인 모드는 건드리지 않는다.
const MEMBER_OVERLAY: &str = r#"# otterminal: Run 멤버가 보고·질문을 할 수 있게 otterctl 만 사전 허용한다.
# 이 파일은 --config 로 **그 실행에만** 얹힌다 (OMP_AGENT_SUPPORT_SRS FR-OMP-20).
# 승인 모드 자체는 건드리지 않는다 (FR-OMP-23).
bash:
  patterns:
    - match: "otterctl *"
      approval: allow
    - match: "otterctl"
      approval: allow
"#;

const SHIM_HEAD: &str = r#"// otterminal 활동 보고 훅 (OMP_AGENT_SUPPORT_SRS 묶음 B).
// 설치가 만든 파일이다 — 손으로 고치면 다음 기동에서 덮인다.
import { spawn } from "node:child_process";

const OTTERCTL = "#;

const SHIM_TAIL: &str = r#";

// 보고는 **한 방향**이다. 실패해도 에이전트를 막지 않는다 (FR-OMP-13).
function report(payload) {
  try {
    const p = spawn(OTTERCTL, ["activity", "omp"], { stdio: ["pipe", "ignore", "ignore"] });
    p.on("error", () => {});
    p.stdin.on("error", () => {});
    p.stdin.end(JSON.stringify(payload) + "\n");
  } catch {
    /* 관측이 도구 사용을 막지 않는다 */
  }
}

function ident(ctx) {
  try {
    const sm = ctx && ctx.sessionManager;
    if (!sm) return {};
    return { sessionId: sm.getSessionId() || "", transcript: sm.getSessionFile() || "" };
  } catch {
    return {};
  }
}

// 툴 인자에서 가장 말이 되는 것 하나를 고른다 — claudeToolDetail 과 같은 규약이다.
function detailOf(name, input) {
  try {
    if (!input) return "";
    if (name === "bash") return String(input.command || "");
    if (name === "read" || name === "edit" || name === "write" || name === "notebook") {
      return String(input.path || input.file_path || "");
    }
    if (name === "grep" || name === "glob") return String(input.pattern || "");
    return "";
  } catch {
    return "";
  }
}

export default function (pi) {
  pi.on("session_start", (_e, ctx) => report({ event: "session_start", ...ident(ctx) }));
  pi.on("session_shutdown", (_e, ctx) => report({ event: "session_shutdown", ...ident(ctx) }));
  pi.on("agent_start", (_e, ctx) => report({ event: "agent_start", ...ident(ctx) }));
  pi.on("agent_end", (_e, ctx) => report({ event: "agent_end", ...ident(ctx) }));
  pi.on("turn_start", (_e, ctx) => report({ event: "turn_start", ...ident(ctx) }));
  pi.on("turn_end", (_e, ctx) => report({ event: "turn_end", ...ident(ctx) }));
  pi.on("tool_call", (e, ctx) => report({
    event: "tool_call",
    tool: (e && e.toolName) || "",
    detail: detailOf(e && e.toolName, e && e.input),
    ...ident(ctx),
  }));
  pi.on("tool_result", (e, ctx) => report({
    event: "tool_result",
    tool: (e && e.toolName) || "",
    ...ident(ctx),
  }));
  // 압축은 계기가 둘이고 우리 어휘로는 하나다 (FR-OMP-7).
  pi.on("auto_compaction_start", (_e, ctx) => report({ event: "compaction", ...ident(ctx) }));
  pi.on("session_compact", (_e, ctx) => report({ event: "compaction", ...ident(ctx) }));
}
"#;

/// 훅 모듈의 본문. otterctl 은 절대 경로이고 JS 문자열 리터럴로 넣는다.
fn shim_source(otterctl: &str) -> String {
    format!("{SHIM_HEAD}{}{SHIM_TAIL}", js_string(otterctl))
}

/// 역슬래시와 따옴표만 다룬다 (Go `jsonString`).
fn js_string(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', r"\\").replace('"', "\\\""))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::HOOKS_DIR_TOKEN;

    #[test]
    fn member_config_arg_is_token_and_file() {
        assert_eq!(
            MEMBER_CONFIG_ARG,
            format!("{HOOKS_DIR_TOKEN}/{OMP_MEMBER_CONFIG_FILE}")
        );
    }

    #[test]
    fn js_string_escapes_backslash_and_quote() {
        assert_eq!(js_string(r#"C:\a "b""#), r#""C:\\a \"b\"""#);
    }
}
