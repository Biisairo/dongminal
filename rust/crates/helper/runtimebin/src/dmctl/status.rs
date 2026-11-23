//! 묶음 S 의 CLI 절반 (RUN_ORCHESTRATION_SRS §3.2): status(조회)와 wait(대기).

use std::collections::BTreeMap;
use std::time::Duration;

use dm_gocompat::{json, strconv};
use dm_shared_apipath as apipath;
use serde::Deserialize;

use super::runhttp::run_get_within;
use super::whoami::encode_query;
use crate::argparse::ArgSpec;
use crate::budgets::{CLIENT_SLACK, PREAMBLE_BUDGET, WAIT_DEFAULT_BUDGET};
use crate::ctx::{Ctx, errf, outf};
use crate::helptext::{DMCTL_STATUS_HELP, DMCTL_WAIT_HELP};
use crate::http::{api_result, base_url, http_get_within, self_tool_id};

/// `status` 와 `wait` 의 인자.
#[derive(Default, Debug)]
pub(crate) struct StatusFlags {
    pub target: String,
    pub cond: String,
    pub timeout_ms: i64,
    pub json_out: bool,
    /// 멤버 uuid (FR-HLM-11). target 과 배타이며, 해석은 뒤에서 한다.
    pub member: String,
}

pub(crate) fn parse_status_flags(
    ctx: &mut Ctx<'_>,
    cmd: &str,
    args: &[String],
    want_cond: bool,
) -> (StatusFlags, Option<i32>) {
    let mut f = StatusFlags::default();
    let spec = ArgSpec {
        help: if want_cond {
            DMCTL_WAIT_HELP
        } else {
            DMCTL_STATUS_HELP
        },
        vals: if want_cond {
            &["--at", "-l", "--member", "--for", "--timeout-ms"]
        } else {
            &["--at", "-l", "--member"]
        },
        bools: &["--json"],
        ..Default::default()
    };
    let stop = spec.run(ctx, cmd, args, &mut Vec::new(), &mut |k, v| {
        let v = v.unwrap_or_default();
        match k {
            "--at" | "-l" => f.target = v.to_owned(),
            "--member" => f.member = v.to_owned(),
            "--for" => f.cond = v.to_owned(),
            "--timeout-ms" => match parse_int64(v) {
                Some(n) if n > 0 => f.timeout_ms = n,
                _ => return Err(format!("--timeout-ms 는 양의 정수여야 한다: {v}")),
            },
            _ => f.json_out = true,
        }
        Ok(())
    });
    if stop.is_some() {
        return (f, stop);
    }
    if want_cond && f.cond != "ready" && f.cond != "done" {
        errf!(
            ctx,
            "{cmd}: --for 는 ready 또는 done 이어야 한다: {}\n",
            strconv::quote(&f.cond)
        );
        return (f, Some(2));
    }
    // --at 과 --member 는 같은 질문에 대한 두 답이다 — 조용히 하나를 고르지 않는다.
    if !f.member.is_empty() && !f.target.is_empty() {
        errf!(
            ctx,
            "{cmd}: --at 과 --member 는 함께 쓸 수 없다 — 하나만 지정하라\n"
        );
        return (f, Some(2));
    }
    if f.member.is_empty() {
        if f.target.is_empty() {
            f.target = self_tool_id(ctx.env);
        }
        if f.target.is_empty() {
            errf!(
                ctx,
                "{cmd}: 대상 도구를 알 수 없다 — --at <uuid> 를 지정하라\n"
            );
            return (f, Some(2));
        }
    }
    (f, None)
}

/// Go `strconv.ParseInt(s, 10, 64)`.
fn parse_int64(s: &str) -> Option<i64> {
    crate::argparse::atoi(s)
}

/// 멤버 uuid 를 그 도구 id 로 바꾼다. 도구 없는 멤버는 기다릴 대상이 없다.
pub(crate) fn member_tool_id(ctx: &mut Ctx<'_>, member_id: &str) -> Result<String, i32> {
    let q = encode_query(&[("member", member_id)]);
    // 이 종단은 늦은 인수인계를 기다려 준다 (FR-RUN-4) — 그 상한만큼의 예산이다.
    let raw = run_get_within(
        ctx,
        &format!("{}?{q}", apipath::RUNS_PREAMBLE),
        PREAMBLE_BUDGET,
    )?;
    #[derive(Default, Deserialize)]
    #[serde(default)]
    struct Got {
        #[serde(rename = "toolId")]
        tool_id: String,
        role: String,
    }
    let got = match json::unmarshal::<Got>(&raw) {
        Ok(g) => g,
        Err(e) => {
            errf!(ctx, "dmctl: invalid member response: {e}\n");
            return Err(1);
        }
    };
    if got.tool_id.is_empty() {
        errf!(
            ctx,
            "dmctl: 멤버 {member_id} (role={}) 에 도구가 없다\n",
            got.role
        );
        return Err(1);
    }
    Ok(got.tool_id)
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct StatusContext {
    #[serde(rename = "usedPct")]
    used_pct: Option<f64>,
    #[serde(rename = "windowTokens")]
    window_tokens: f64,
    tokens: f64,
    source: String,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct UsageModel {
    #[serde(rename = "displayName")]
    display_name: Option<String>,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct UsageCost {
    #[serde(rename = "totalCostUsd")]
    total_cost_usd: Option<f64>,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct UsageRate {
    #[serde(rename = "usedPct")]
    used_pct: Option<f64>,
}

/// statusLine 사용량에서 이 명령이 읽는 것만 (`statusline.Usage`).
#[derive(Default, Deserialize)]
#[serde(default, rename = "statusline.Usage")]
struct Usage {
    model: Option<UsageModel>,
    effort: Option<String>,
    cost: Option<UsageCost>,
    #[serde(rename = "rateLimits")]
    rate_limits: Option<BTreeMap<String, UsageRate>>,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct LimitWindow {
    name: String,
    #[serde(rename = "usedPct")]
    used_pct: Option<f64>,
    #[serde(rename = "resetsInSec")]
    resets_in_sec: Option<f64>,
}

/// `limits` 원소다 (FR-ASV-21).
#[derive(Default, Deserialize)]
#[serde(default, rename = "runtimebin.statusLimit")]
struct StatusLimit {
    agent: String,
    windows: Vec<LimitWindow>,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct MemberState {
    state: String,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct StatusResp {
    #[serde(rename = "toolId")]
    tool_id: String,
    live: bool,
    #[serde(rename = "liveUnknown")]
    live_unknown: bool,
    state: String,
    tool: String,
    detail: String,
    #[serde(rename = "quietMs")]
    quiet_ms: i64,
    context: Option<StatusContext>,
    usage: Option<Usage>,
    member: Option<MemberState>,
    limits: Option<Vec<StatusLimit>>,
}

fn f64_fixed(v: f64, prec: i32) -> String {
    strconv::format_float(v, b'f', prec, 64)
}

pub(crate) fn run_dmctl_status(ctx: &mut Ctx<'_>, args: &[String]) -> i32 {
    let (mut f, stop) = parse_status_flags(ctx, "status", args, false);
    if let Some(code) = stop {
        return code;
    }
    if !f.member.is_empty() {
        match member_tool_id(ctx, &f.member) {
            Ok(t) => f.target = t,
            Err(code) => return code,
        }
    }
    let q = encode_query(&[("id", &f.target)]);
    let url = format!("{}{}?{q}", base_url(ctx.env), apipath::TOOLS_ACTIVITY_GET);
    let body = match api_result(
        ctx,
        apipath::TOOLS_ACTIVITY_GET,
        http_get_within(&url, Duration::ZERO),
    ) {
        Ok(b) => b,
        Err(code) => return code,
    };
    if f.json_out {
        write_raw_json(ctx, &body);
        return 0;
    }
    let st = match json::unmarshal::<StatusResp>(&body) {
        Ok(s) => s,
        Err(e) => {
            errf!(ctx, "dmctl: invalid status response: {e}\n");
            return 1;
        }
    };
    let run_state = match &st.member {
        Some(m) if !m.state.is_empty() => format!("  run_state={}", m.state),
        _ => String::new(),
    };
    let live = if st.live_unknown {
        "unknown".to_owned()
    } else {
        st.live.to_string()
    };
    outf!(
        ctx,
        "toolId={}  live={live}  state={}{run_state}{}  quietMs={}\n",
        st.tool_id,
        st.state,
        optional_fields(&st.tool, &st.detail),
        st.quiet_ms
    );
    if let Some(c) = &st.context
        && let Some(p) = c.used_pct
    {
        outf!(
            ctx,
            "context={}%  tokens={}/{}  source={}\n",
            f64_fixed(p, 1),
            f64_fixed(c.tokens, 0),
            f64_fixed(c.window_tokens, 0),
            c.source
        );
    }
    let line = usage_line(st.usage.as_ref());
    if !line.is_empty() {
        outf!(ctx, "{line}\n");
    }
    for line in limit_lines(st.limits.as_deref().unwrap_or_default()) {
        outf!(ctx, "{line}\n");
    }
    0
}

/// 창마다 `claude 5h 34% (resets in 2h 0m)` 한 줄이다. 사용률이 없는 창은 적지 않는다.
fn limit_lines(limits: &[StatusLimit]) -> Vec<String> {
    let mut out = Vec::new();
    for l in limits {
        for w in &l.windows {
            let Some(used) = w.used_pct else { continue };
            let name = match w.name.as_str() {
                "five_hour" => "5h",
                "seven_day" => "7d",
                n => n,
            };
            let mut line = format!("{} {name} {}%", l.agent, f64_fixed(used, 0));
            if let Some(r) = w.resets_in_sec {
                line += &format!(" (resets in {})", limit_reset_text(r));
            }
            out.push(line);
        }
    }
    out
}

/// 남은 초를 큰 단위 둘로 쓴다 — `4d 6h`·`2h 10m`·`35m`. 0 이하면 `soon` 이다.
pub(crate) fn limit_reset_text(sec: f64) -> String {
    if sec <= 0.0 {
        return "soon".to_owned();
    }
    let m = sec as i64 / 60;
    let (d, h) = (m / (24 * 60), m / 60 % 24);
    if d > 0 {
        return format!("{d}d {h}h");
    }
    if m >= 60 {
        return format!("{h}h {}m", m % 60);
    }
    format!("{m}m")
}

/// statusLine 사용량의 한 줄이다 (FR-ITS-1). 값이 없는 항목은 적지 않는다.
fn usage_line(u: Option<&Usage>) -> String {
    let Some(u) = u else {
        return String::new();
    };
    let mut parts = Vec::new();
    if let Some(n) = u.model.as_ref().and_then(|m| m.display_name.as_ref()) {
        parts.push(format!("model={n}"));
    }
    if let Some(e) = &u.effort {
        parts.push(format!("effort={e}"));
    }
    if let Some(c) = u.cost.as_ref().and_then(|c| c.total_cost_usd) {
        parts.push(format!("cost=${}", f64_fixed(c, 2)));
    }
    if let Some(rl) = u.rate_limits.as_ref().filter(|m| !m.is_empty()) {
        let rs: Vec<String> = rl
            .iter()
            .filter_map(|(n, w)| w.used_pct.map(|p| format!("{n}:{}%", f64_fixed(p, 0))))
            .collect();
        if !rs.is_empty() {
            parts.push(format!("rate={}", rs.join(",")));
        }
    }
    parts.join("  ")
}

pub(crate) fn run_dmctl_wait(ctx: &mut Ctx<'_>, args: &[String]) -> i32 {
    let (mut f, stop) = parse_status_flags(ctx, "wait", args, true);
    if let Some(code) = stop {
        return code;
    }
    // FR-HLM-11: 멤버 uuid 를 toolId 로 바꿔 두면 그 뒤는 --at 과 같은 경로다.
    if !f.member.is_empty() {
        match member_tool_id(ctx, &f.member) {
            Ok(t) => f.target = t,
            Err(code) => return code,
        }
    }
    let timeout = f.timeout_ms.to_string();
    let mut q = vec![("id", f.target.as_str()), ("for", f.cond.as_str())];
    if f.timeout_ms > 0 {
        q.push(("timeoutMs", &timeout));
    }
    let url = format!(
        "{}{}?{}",
        base_url(ctx.env),
        apipath::TOOLS_ACTIVITY_WAIT,
        encode_query(&q)
    );
    // 서버가 요청을 붙잡으므로 클라이언트 예산은 서버 상한보다 넉넉해야 한다.
    let r = http_get_within(&url, wait_budget(f.timeout_ms));
    let body = match api_result(ctx, apipath::TOOLS_ACTIVITY_WAIT, r) {
        Ok(b) => b,
        Err(code) => return code,
    };
    #[derive(Default, Deserialize)]
    #[serde(default)]
    struct Rec {
        #[serde(rename = "toolId")]
        tool_id: String,
        status: String,
        reason: String,
        state: String,
        tool: String,
        detail: String,
        #[serde(rename = "quietMs")]
        quiet_ms: i64,
        #[serde(rename = "waitedMs")]
        waited_ms: i64,
    }
    let rec = match json::unmarshal::<Rec>(&body) {
        Ok(r) => r,
        Err(e) => {
            errf!(ctx, "dmctl: invalid wait response: {e}\n");
            return 1;
        }
    };
    if f.json_out {
        write_raw_json(ctx, &body);
    } else {
        let reason = if rec.reason.is_empty() {
            String::new()
        } else {
            format!("  reason={}", rec.reason)
        };
        outf!(
            ctx,
            "status={}{reason}  toolId={}  state={}{}  waitedMs={}\n",
            rec.status,
            rec.tool_id,
            rec.state,
            optional_fields(&rec.tool, &rec.detail),
            rec.waited_ms
        );
    }
    match rec.status.as_str() {
        "ready" | "done" => 0,
        "timeout" => {
            // FR-STA-6: 타임아웃은 실패가 아니다.
            errf!(
                ctx,
                "wait: 타임아웃 — 실패가 아니라 체크포인트다. 마지막 상태 state={} quietMs={}. 계속 기다리려면 다시 호출하라.\n",
                rec.state,
                rec.quiet_ms
            );
            4
        }
        "blocked" => {
            errf!(
                ctx,
                "wait: blocked — 에이전트가 입력을 기다린다(state={}). 시간이 지나도 풀리지 않으니 개입이 필요하다.\n",
                rec.state
            );
            5
        }
        "gone" => {
            errf!(ctx, "wait: 대상 도구가 사라졌다 (toolId={})\n", rec.tool_id);
            1
        }
        s => {
            errf!(ctx, "dmctl: unknown wait status: {}\n", strconv::quote(s));
            1
        }
    }
}

/// `wait` 의 클라이언트 예산이다 — 준 시한(없으면 서버 기본) + 여유.
pub(crate) fn wait_budget(timeout_ms: i64) -> Duration {
    if timeout_ms <= 0 {
        return WAIT_DEFAULT_BUDGET;
    }
    Duration::from_millis(timeout_ms as u64).saturating_add(CLIENT_SLACK)
}

fn optional_fields(tool: &str, detail: &str) -> String {
    let mut out = String::new();
    if !tool.is_empty() {
        out += &format!("  tool={tool}");
    }
    if !detail.is_empty() {
        out += &format!("  detail={detail}");
    }
    out
}

pub(crate) fn write_raw_json(ctx: &mut Ctx<'_>, body: &[u8]) {
    let mut out = body;
    while let [rest @ .., b'\n'] = out {
        out = rest;
    }
    let _ = ctx.out.write_all(out);
    outf!(ctx, "\n");
}
