//! `dmctl notify [label]` — 현재 도구가 주의가 필요함을 알린다. DONGMINAL_TOOL_ID 로 자신을
//! 식별하므로 제어 터미널이 없는 에이전트 훅에서도 동작한다.

use std::io::sink;

use dm_shared_agentadapter as agentadapter;
use dm_shared_agentrec as agentrec;
use dm_shared_apipath as apipath;
use dm_shared_dmenv as dmenv;
use serde_json::json;

use super::post::{command_rule, dmctl_http_result};
use crate::budgets::HOOK_BUDGET;
use crate::ctx::{Ctx, errf, outf};
use crate::helptext::DMCTL_NOTIFY_HELP;
use crate::http::self_tool_id;
use crate::report::post_report;

pub(crate) fn run_dmctl_notify(ctx: &mut Ctx<'_>, args: &[String]) -> i32 {
    let mut label = "attention";
    for a in args {
        if a == "-h" || a == "--help" {
            outf!(ctx, "{DMCTL_NOTIFY_HELP}");
            return 0;
        }
        if !a.is_empty() && !a.starts_with('-') {
            label = a;
            break;
        }
    }
    let tool_id = self_tool_id(ctx.env);
    if tool_id.is_empty() {
        errf!(
            ctx,
            "dmctl notify: {} 미설정 (dongminal tool 안에서 실행해야 함)\n",
            dmenv::ENV_TOOL_ID
        );
        return 1;
    }
    let body = json!({"toolId": tool_id, "reason": sanitize_notify_label(label)});
    let r = post_report(
        ctx.env,
        agentrec::METHOD_NOTIFY,
        apipath::TOOLS_ATTENTION_SET,
        &body,
        HOOK_BUDGET,
    );
    // 알림 POST 가 실패해도 활동은 보고한다. 조용하고 종료 코드에 영향이 없다.
    report_notify_activity(ctx, label, args, &tool_id);
    let mut discard = sink();
    let mut quiet = Ctx::new(&mut discard, &mut *ctx.err, &mut *ctx.inp, ctx.env);
    dmctl_http_result(&mut quiet, command_rule("dmctl notify"), r, false)
}

/// 제어 문자를 지우고 64 바이트로 자른다.
pub(crate) fn sanitize_notify_label(s: &str) -> String {
    let s: String = s
        .chars()
        .filter(|&r| !(r < '\x20' || r == '\x7f'))
        .collect();
    if s.is_empty() {
        return "attention".to_owned();
    }
    if s.len() <= 64 {
        return s;
    }
    go_string_bytes(&s.as_bytes()[..64])
}

/// Go 문자열(임의 바이트)을 JSON 으로 낼 때처럼, 잘못된 UTF-8 바이트를 하나씩 U+FFFD 로 바꾼다.
pub(crate) fn go_string_bytes(mut b: &[u8]) -> String {
    let mut out = String::new();
    while !b.is_empty() {
        match std::str::from_utf8(b) {
            Ok(s) => {
                out.push_str(s);
                break;
            }
            Err(e) => {
                let good = e.valid_up_to();
                out.push_str(std::str::from_utf8(&b[..good]).unwrap_or_default());
                out.push('\u{FFFD}');
                b = &b[good + 1..];
            }
        }
    }
    out
}

/// 활동을 notify 경로로만 보고하는 에이전트(FR-AAC-31)의 활동 보고다. 인자 가운데 처음
/// `{` 로 시작하는 것을 훅 JSON 으로 읽는다. `agent` 는 싣지 않는다 (FR-AEV-21).
pub(crate) fn report_notify_activity(ctx: &Ctx<'_>, label: &str, args: &[String], tool_id: &str) {
    if tool_id.is_empty() {
        return;
    }
    let Ok(adapter) = agentadapter::get(label) else {
        return;
    };
    if !adapter.activity_from_notify {
        return;
    }
    if let Some(a) = args.iter().find(|a| a.starts_with('{'))
        && let Some(rep) = (adapter.hook_parse)(a.as_bytes())
    {
        let _ = post_report(
            ctx.env,
            agentrec::METHOD_ACTIVITY,
            apipath::TOOLS_ACTIVITY_SET,
            &json!({"toolId": tool_id, "state": rep.state, "tool": rep.tool, "detail": rep.detail}),
            HOOK_BUDGET,
        );
    }
}
