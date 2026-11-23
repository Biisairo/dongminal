//! runs 종단의 왕복과 `{error,detail,…}` 방언의 거절 문구.

#![allow(dead_code)]

use std::io::Write;
use std::time::Duration;

use dm_gocompat::json::RawMessage;
use serde::Deserialize;
use serde_json::Value;

use crate::ctx::Ctx;
use crate::http::{
    ExitRule, HttpOut, base_url, http_delete, http_exit, http_get_within, http_post_json_within,
    parse_refusal, print_api_error, refuse_with, take_field,
};

/// Run 멤버의 뷰다. 거절 본문의 `unreported` 가 이 모양이다.
#[derive(Default, Deserialize, Clone, Debug)]
#[serde(default, rename = "runtimebin.runMember")]
pub(crate) struct RunMember {
    pub id: String,
    pub role: String,
    pub agent: String,
    #[serde(rename = "toolId")]
    pub tool_id: String,
    #[serde(rename = "tabId")]
    pub tab_id: String,
    pub state: String,
    pub outcome: String,
    pub summary: String,
    pub worktree: Option<RawMessage>,
    pub headless: bool,
    #[serde(rename = "contextRatio")]
    pub context_ratio: f64,
    #[serde(rename = "contextLevel")]
    pub context_level: String,
    #[serde(rename = "compactCount")]
    pub compact_count: i64,
    #[serde(rename = "contextTokens")]
    pub context_tokens: i64,
    #[serde(rename = "contextLimit")]
    pub context_limit: f64,
    #[serde(rename = "succeededFrom")]
    pub succeeded_from: String,
}

pub(crate) fn run_post_within(
    ctx: &mut Ctx<'_>,
    path: &str,
    body: &Value,
    budget: Duration,
) -> Result<Vec<u8>, i32> {
    let r = http_post_json_within(&format!("{}{path}", base_url(ctx.env)), body, budget);
    run_result(ctx, path, r)
}

pub(crate) fn run_post(ctx: &mut Ctx<'_>, path: &str, body: &Value) -> Result<Vec<u8>, i32> {
    run_post_within(ctx, path, body, Duration::ZERO)
}

pub(crate) fn run_get_within(
    ctx: &mut Ctx<'_>,
    path: &str,
    budget: Duration,
) -> Result<Vec<u8>, i32> {
    let r = http_get_within(&format!("{}{path}", base_url(ctx.env)), budget);
    run_result(ctx, path, r)
}

pub(crate) fn run_get(ctx: &mut Ctx<'_>, path: &str) -> Result<Vec<u8>, i32> {
    run_get_within(ctx, path, Duration::ZERO)
}

pub(crate) fn run_delete(ctx: &mut Ctx<'_>, path: &str) -> Result<Vec<u8>, i32> {
    let r = http_delete(&format!("{}{path}", base_url(ctx.env)));
    run_result(ctx, path, r)
}

pub(crate) fn run_result(ctx: &mut Ctx<'_>, path: &str, r: HttpOut) -> Result<Vec<u8>, i32> {
    http_exit(ctx, r, run_rule(path))
}

/// runs 의 `{error,detail,…}` 방언 종단이다.
pub(crate) fn run_rule(path: &str) -> ExitRule<'_> {
    ExitRule {
        prefix: "dmctl",
        on_err: None,
        ok: None,
        refuse: refuse_with(move |w, st, b| print_run_refusal(w, st, path, b)),
    }
}

/// 열거된 사유와 서버가 붙인 목록(close 의 미보고 멤버 등)을 찍는다.
pub(crate) fn print_run_refusal(w: &mut dyn Write, status: u16, path: &str, raw: &[u8]) {
    dm_gocompat::go_type!(GoMembers = "[]runtimebin.runMember");
    #[derive(Default, Deserialize)]
    struct Members(
        #[serde(deserialize_with = "dm_gocompat::json::with_go_type::<GoMembers, _, _>")]
        Vec<RunMember>,
    );
    let fields = parse_refusal(raw).and_then(|r| {
        Some((
            take_field::<String>(&r.error)?,
            take_field::<String>(&r.detail)?,
            take_field::<Members>(&r.unreported)?,
            take_field::<String>(&r.run_id)?,
            take_field::<Option<bool>>(&r.stale)?,
            take_field::<String>(&r.member_id)?,
            take_field::<String>(&r.state)?,
            take_field::<String>(&r.hint)?,
        ))
    });
    let Some((error, detail, unreported, run_id, stale, member_id, state, hint)) =
        fields.filter(|f| !f.0.is_empty())
    else {
        print_api_error(w, status, path, raw);
        return;
    };
    let _ = writeln!(w, "dmctl run: {error} ({status})");
    if !detail.is_empty() && detail != error {
        let _ = writeln!(w, "  {detail}");
    }
    for m in &unreported.0 {
        let _ = writeln!(
            w,
            "  미보고: role={}  state={}  memberId={}",
            m.role, m.state, m.id
        );
    }
    if !member_id.is_empty() {
        let _ = writeln!(
            w,
            "  이 이슈를 쥔 멤버: memberId={member_id}  state={state}"
        );
    }
    if !hint.is_empty() {
        let _ = writeln!(w, "  {hint}");
    }
    if let Some(stale) = stale
        && !run_id.is_empty()
    {
        if stale {
            let _ = writeln!(
                w,
                "  이 트리의 Run {run_id} 은 멈췄다(살아 있는 멤버 없음). 정리한 뒤 다시 연다: dmctl run close --run {run_id} --force"
            );
        } else {
            let _ = writeln!(
                w,
                "  이 트리는 이미 돌고 있다: Run {run_id} (dmctl run tree 로 본다)"
            );
        }
    }
}
