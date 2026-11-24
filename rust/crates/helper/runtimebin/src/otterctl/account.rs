//! `otterctl account` (CLAUDE_ACCOUNTS_SRS FR-CAC-102·103) — Claude 다중 계정.

use std::collections::{BTreeMap, HashSet};

use otter_gocompat::json;
use otter_gocompat::strconv::{format_float, quote};
use otter_shared_apipath as apipath;
use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::argparse::atoi;
use crate::budgets::ACCOUNT_CALL_BUDGET;
use crate::ctx::{Ctx, errf, outf};
use crate::helptext::OTTERCTL_ACCOUNT_HELP;
use crate::http::{
    base_url, clean, code_rule, http_exit, http_get, http_json_within, self_tool_id,
};
use crate::otterctl::edge::{SubArgs, SubSpec, decode, parse_sub_args};

/// `--json` 출력의 형식 판이다 (FR-CAC-103).
const ACCOUNT_SCHEMA_VERSION: i64 = 1;
const HISTORY_DEFAULT_LIMIT: i64 = 20;
const HISTORY_MAX_LIMIT: i64 = 1000;
const ACCOUNT_STRATEGIES: &[&str] = &["next", "next-available", "best"];

#[derive(Clone, Default, Deserialize)]
#[serde(default, rename = "runtimebin.accountRow")]
struct AccountRow {
    id: String,
    email: String,
    #[serde(rename = "organizationName")]
    org_name: String,
    alias: String,
    disabled: bool,
    usage: Option<AccountUsage>,
}

impl AccountRow {
    fn label(&self) -> String {
        if !self.alias.is_empty() {
            return format!("{} <{}>", self.alias, self.email);
        }
        self.email.clone()
    }
}

/// 서버가 셈한 창 하나다. 남은 시간과 등급은 서버의 값만 쓴다 (D-CAC-15).
#[derive(Clone, Default, Deserialize)]
#[serde(default, rename = "runtimebin.accountWin")]
struct AccountWin {
    name: String,
    pct: f64,
    #[serde(rename = "resetsInSec")]
    resets_in_sec: Option<i64>,
    level: String,
}

#[derive(Clone, Default, Deserialize)]
#[serde(default)]
struct Spend {
    used: f64,
    limit: f64,
    currency: String,
}

#[derive(Clone, Default, Deserialize)]
#[serde(default)]
struct Windows {
    #[serde(rename = "fiveHour")]
    five_hour: Option<AccountWin>,
    #[serde(rename = "sevenDay")]
    seven_day: Option<AccountWin>,
    scoped: Option<Vec<AccountWin>>,
    spend: Option<Spend>,
}

#[derive(Clone, Default, Deserialize)]
#[serde(default)]
struct PaceSevenDay {
    #[serde(rename = "expectedPct")]
    expected_pct: f64,
    #[serde(rename = "aheadOfPace")]
    ahead_of_pace: bool,
    #[serde(rename = "projectedExhaustionAt")]
    projected_exhaustion_at: i64,
    #[serde(rename = "willLastToReset")]
    will_last_to_reset: bool,
}

#[derive(Clone, Default, Deserialize)]
#[serde(default)]
struct Pace {
    #[serde(rename = "sevenDay")]
    seven_day: Option<PaceSevenDay>,
}

#[derive(Clone, Default, Deserialize)]
#[serde(default)]
struct Juniper {
    eligible: bool,
    available: bool,
    #[serde(rename = "nextAvailableAt")]
    next_available_at: i64,
}

#[derive(Clone, Default, Deserialize)]
#[serde(default)]
struct Cedar {
    eligible: bool,
    grants: Option<Vec<AccountGrant>>,
}

#[derive(Clone, Default, Deserialize)]
#[serde(default)]
struct Resets {
    #[serde(rename = "juniperTide")]
    juniper: Option<Juniper>,
    #[serde(rename = "cedarEmber")]
    cedar: Option<Cedar>,
}

#[derive(Clone, Default, Deserialize)]
#[serde(default, rename = "runtimebin.accountUsage")]
struct AccountUsage {
    status: String,
    windows: Option<Windows>,
    pace: Pace,
    stale: bool,
    #[serde(rename = "ageSeconds")]
    age_seconds: i64,
    #[serde(rename = "backoffUntil")]
    backoff_until: i64,
    #[serde(rename = "loginExpiresAt")]
    login_expires_at: i64,
    #[serde(rename = "loginExpiringSoon")]
    login_expiring_soon: bool,
    resets: Option<Resets>,
}

#[derive(Clone, Default, Deserialize)]
#[serde(default, rename = "runtimebin.accountGrant")]
struct AccountGrant {
    id: String,
    label: String,
    #[serde(rename = "resetsTotal")]
    resets_total: i64,
    #[serde(rename = "resetsLeft")]
    resets_left: i64,
    #[serde(rename = "endsAt")]
    ends_at: i64,
    clears: Option<Vec<String>>,
    paused: bool,
    #[serde(rename = "usableNow")]
    usable_now: bool,
    #[serde(rename = "givesBackWeekly")]
    gives_back_weekly: bool,
}

impl AccountGrant {
    fn name(&self) -> &str {
        if self.label.is_empty() {
            &self.id
        } else {
            &self.label
        }
    }
}

#[derive(Default, Deserialize)]
#[serde(default, rename = "runtimebin.accountsOut")]
struct AccountsOut {
    #[serde(rename = "activeId")]
    active_id: String,
    accounts: Option<Vec<AccountRow>>,
}

impl AccountsOut {
    fn rows(&self) -> &[AccountRow] {
        self.accounts.as_deref().unwrap_or_default()
    }

    /// id·별칭·이메일(대소문자 무시)로 계정을 찾는다.
    fn resolve(&self, r: &str) -> Option<&AccountRow> {
        self.rows()
            .iter()
            .find(|a| a.id == r || (!a.alias.is_empty() && a.alias == r) || equal_fold(&a.email, r))
    }

    /// 계정 ID 의 표시 이름이다. 지워진 계정은 "삭제된 계정" 이다.
    fn name(&self, id: &str) -> String {
        match self.resolve(id) {
            Some(a) if !id.is_empty() => clean(&a.label()),
            _ => "삭제된 계정".to_owned(),
        }
    }
}

/// Go `strings.EqualFold`.
fn equal_fold(a: &str, b: &str) -> bool {
    let fold = |c: char| c.to_lowercase().next().unwrap_or(c);
    a.chars().count() == b.chars().count()
        && a.chars().zip(b.chars()).all(|(x, y)| {
            x == y || fold(x) == fold(y) || x.to_uppercase().next() == y.to_uppercase().next()
        })
}

fn account_sub(name: &str) -> Option<SubSpec> {
    let spec = |positional, rest, flags, bools, run| SubSpec {
        positional,
        rest,
        flags,
        bools,
        run,
    };
    Some(match name {
        "list" => spec(0, false, &[], &["json"], account_list),
        "add" => spec(0, false, &[], &[], account_add),
        "switch" => spec(0, true, &["strategy"], &[], account_switch),
        "usage" => spec(0, true, &[], &["refresh", "json"], account_usage),
        "reset" => spec(1, false, &["program", "grant"], &["yes"], account_reset),
        "auto" => spec(1, false, &[], &["json"], account_auto),
        "history" => spec(0, false, &["limit"], &[], account_history),
        "pin" => spec(0, true, &["tab"], &["clear"], account_pin),
        "map" => spec(0, true, &[], &[], account_map),
        "unmap" => spec(0, true, &[], &[], account_unmap),
        "maps" => spec(0, false, &[], &[], account_maps),
        _ => return None,
    })
}

pub(crate) fn run_otterctl_account(ctx: &mut Ctx<'_>, args: &[String]) -> i32 {
    let Some((sub, rest)) = args.split_first() else {
        errf!(ctx, "{OTTERCTL_ACCOUNT_HELP}");
        return 2;
    };
    if sub == "-h" || sub == "--help" || sub == "help" {
        outf!(ctx, "{OTTERCTL_ACCOUNT_HELP}");
        return 0;
    }
    let Some(spec) = account_sub(sub) else {
        errf!(ctx, "otterctl account: 모르는 하위 명령 {}\n", quote(sub));
        errf!(ctx, "{OTTERCTL_ACCOUNT_HELP}");
        return 2;
    };
    let (pa, mut err) = parse_sub_args(rest, spec.flags, spec.bools);
    if pa.help {
        outf!(ctx, "{OTTERCTL_ACCOUNT_HELP}");
        return 0;
    }
    if err.is_none() && !spec.rest && pa.pos.len() != spec.positional {
        err = Some(format!("인자가 {} 개여야 합니다", spec.positional));
    }
    if let Some(e) = err {
        errf!(ctx, "otterctl account {sub}: {e}\n");
        return 2;
    }
    (spec.run)(ctx, &pa)
}

fn account_api(
    ctx: &mut Ctx<'_>,
    method: &str,
    path: &str,
    body: Option<Value>,
) -> Result<Vec<u8>, i32> {
    let url = format!("{}{}", base_url(ctx.env), path);
    let r = match body {
        None => http_get(&url),
        Some(b) => http_json_within(method, &url, &b, ACCOUNT_CALL_BUDGET),
    };
    http_exit(ctx, r, code_rule())
}

fn load_accounts(ctx: &mut Ctx<'_>) -> Result<(AccountsOut, Vec<u8>), i32> {
    let raw = account_api(ctx, "GET", apipath::CLAUDE_ACCOUNTS, None)?;
    match decode::<AccountsOut>(&raw) {
        Ok(v) => Ok((v, raw)),
        Err(e) => {
            errf!(ctx, "otterctl account: 응답을 읽지 못했습니다: {e}\n");
            Err(1)
        }
    }
}

fn no_such_account(ctx: &mut Ctx<'_>, r: &str) -> i32 {
    errf!(
        ctx,
        "otterctl account: 그런 계정이 없습니다: {}\n",
        clean(r)
    );
    1
}

macro_rules! try_rc {
    ($e:expr) => {
        match $e {
            Ok(v) => v,
            Err(rc) => return rc,
        }
    };
}

/// Go 가 `map[string]any` 로 읽은 값이다 — 수는 모두 float64 다.
fn go_any(v: Value) -> Value {
    match v {
        Value::Number(n) => n
            .as_f64()
            .and_then(serde_json::Number::from_f64)
            .map_or(Value::Null, Value::Number),
        Value::Array(a) => Value::Array(a.into_iter().map(go_any).collect()),
        Value::Object(m) => Value::Object(m.into_iter().map(|(k, v)| (k, go_any(v))).collect()),
        v => v,
    }
}

fn decode_object(raw: &[u8]) -> Option<Map<String, Value>> {
    match json::unmarshal::<Option<Map<String, Value>>>(raw) {
        Ok(Some(m)) => match go_any(Value::Object(m)) {
            Value::Object(m) => Some(m),
            _ => None,
        },
        _ => None,
    }
}

fn marshal_line(v: &Value) -> String {
    String::from_utf8_lossy(&json::marshal(v).unwrap_or_default()).into_owned()
}

fn account_list(ctx: &mut Ctx<'_>, pa: &SubArgs) -> i32 {
    let (v, raw) = try_rc!(load_accounts(ctx));
    if pa.has("json") {
        // FR-RDG-26 (DM-F5): 본문이 객체가 아니면(null) 빈 객체에서 시작한다.
        let mut m = decode_object(&raw).unwrap_or_default();
        m.insert("schemaVersion".into(), json!(ACCOUNT_SCHEMA_VERSION));
        outf!(ctx, "{}\n", clean(&marshal_line(&Value::Object(m))));
        return 0;
    }
    for a in v.rows() {
        let mark = if a.id == v.active_id { "* " } else { "  " };
        let extra = if a.disabled { "  disabled" } else { "" };
        outf!(
            ctx,
            "{mark}{}  org={}  id={}{extra}\n",
            clean(&a.label()),
            clean(&a.org_name),
            clean(&a.id)
        );
    }
    0
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct AddResp {
    created: bool,
    account: AccountRow,
}

fn account_add(ctx: &mut Ctx<'_>, _pa: &SubArgs) -> i32 {
    let raw = try_rc!(account_api(
        ctx,
        "POST",
        apipath::CLAUDE_ACCOUNTS_ADD,
        Some(json!({}))
    ));
    let v: AddResp = decode(&raw).unwrap_or_default();
    let verb = if v.created { "등록" } else { "갱신" };
    outf!(
        ctx,
        "{verb}: {}  id={}\n",
        clean(&v.account.label()),
        clean(&v.account.id)
    );
    0
}

/// `best` 가 전환하지 않은 이유의 문구다.
fn reason_text(reason: &str) -> &str {
    match reason {
        "none" => "제외되지 않은 다른 계정이 없습니다",
        "current-unavailable" => "활성 계정의 사용량을 모릅니다",
        "no-comparison" => "비교할 수 있는 다른 계정의 사용량이 없습니다",
        "exhausted" => "모든 계정의 한도가 찼습니다",
        "stay" => "활성 계정의 여유가 가장 큽니다",
        r => r,
    }
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct SwitchResp {
    to: String,
    #[serde(rename = "noop")]
    no_op: bool,
    reason: String,
    #[serde(rename = "pinnedRunning")]
    pinned_running: bool,
}

fn account_switch(ctx: &mut Ctx<'_>, pa: &SubArgs) -> i32 {
    let strategy = pa.flag("strategy");
    if strategy.is_empty() == pa.pos.is_empty() || pa.pos.len() > 1 {
        errf!(
            ctx,
            "otterctl account switch: <계정> 하나 또는 --strategy 하나가 필요합니다\n"
        );
        return 2;
    }
    if !strategy.is_empty() && !ACCOUNT_STRATEGIES.contains(&strategy) {
        errf!(
            ctx,
            "otterctl account switch: --strategy 는 next, next-available, best 중 하나입니다\n"
        );
        return 2;
    }
    let (v, _) = try_rc!(load_accounts(ctx));
    let body = if strategy.is_empty() {
        let Some(a) = v.resolve(&pa.pos[0]) else {
            return no_such_account(ctx, &pa.pos[0]);
        };
        json!({"id": a.id, "by": "otterctl"})
    } else {
        json!({"strategy": strategy, "by": "otterctl"})
    };
    let raw = try_rc!(account_api(
        ctx,
        "POST",
        apipath::CLAUDE_ACCOUNTS_SWITCH,
        Some(body)
    ));
    let res: SwitchResp = decode(&raw).unwrap_or_default();
    let to = v.resolve(&res.to).cloned().unwrap_or_default();
    if !res.reason.is_empty() {
        outf!(ctx, "전환하지 않았습니다: {}\n", reason_text(&res.reason));
        return 0;
    }
    if res.no_op {
        outf!(ctx, "이미 활성 계정입니다: {}\n", clean(&to.label()));
        return 0;
    }
    outf!(
        ctx,
        "전환: {}\n새로 시작하는 Claude Code 세션부터 새 계정을 씁니다. 실행 중인 세션은 건드리지 않습니다.\n",
        clean(&to.label())
    );
    if res.pinned_running {
        outf!(
            ctx,
            "이 계정은 고정 실행 중인 탭이 있습니다. 그 탭은 영향을 받지 않습니다.\n"
        );
    }
    0
}

// ── 사용량 ─────────────────────────────────────────────

/// 로컬 시간대의 달력 값 (년, 월, 일, 시, 분).
fn local_parts(sec: i64) -> (i64, i64, i64, i64, i64) {
    let local = sec + i64::from(otter_gocompat::time::local().offset_at(sec));
    let days = local.div_euclid(86400);
    let rem = local.rem_euclid(86400);
    // Howard Hinnant 의 civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    (y, m, d, rem / 3600, rem / 60 % 60)
}

/// Go `Format("15:04")`.
fn fmt_hm(sec: i64) -> String {
    let (_, _, _, h, mi) = local_parts(sec);
    format!("{h:02}:{mi:02}")
}

/// Go `Format("01-02 15:04")`.
fn fmt_md_hm(sec: i64) -> String {
    let (_, m, d, h, mi) = local_parts(sec);
    format!("{m:02}-{d:02} {h:02}:{mi:02}")
}

/// Go `Format("01-02")`.
fn fmt_md(sec: i64) -> String {
    let (_, m, d, _, _) = local_parts(sec);
    format!("{m:02}-{d:02}")
}

/// Go `Format("2006-01-02")`.
fn fmt_ymd(sec: i64) -> String {
    let (y, m, d, _, _) = local_parts(sec);
    format!("{y:04}-{m:02}-{d:02}")
}

/// Go `Format("2006-01-02 15:04")`.
fn fmt_ymd_hm(sec: i64) -> String {
    let (y, m, d, h, mi) = local_parts(sec);
    format!("{y:04}-{m:02}-{d:02} {h:02}:{mi:02}")
}

/// 남은 초를 큰 단위 둘로 쓴다 — 화면(`limitResetText`)과 같은 규칙이다.
fn account_span(sec: i64) -> String {
    if sec <= 0 {
        return "곧".to_owned();
    }
    let m = sec / 60;
    let (d, h) = (m / 1440, m / 60 % 24);
    if d > 0 {
        return format!("{d}일 {h}시간");
    }
    if m >= 60 {
        return format!("{h}시간 {}분", m % 60);
    }
    format!("{m}분")
}

fn level_text(level: &str) -> &'static str {
    match level {
        "warn" => " (경고)",
        "critical" => " (위험)",
        _ => "",
    }
}

fn win_line(ctx: &mut Ctx<'_>, name: &str, win: &AccountWin) {
    let mut line = format!(
        "    {} {}%{}",
        clean(name),
        format_float(win.pct, b'f', 0, 64),
        level_text(&win.level)
    );
    if let Some(s) = win.resets_in_sec {
        line += &format!("  {} 후 초기화", account_span(s));
    }
    outf!(ctx, "{line}\n");
}

fn money(n: f64, cur: &str) -> String {
    let v = if n.trunc() == n && n.abs() < 9.2e18 {
        format!("{}", n as i64)
    } else {
        format_float(n, b'f', 2, 64)
    };
    if cur == "USD" {
        return format!("${v}");
    }
    format!("{v} {}", clean(cur))
}

/// 계정 하나의 사용량이다 (FR-CAC-55·56·57·91 의 글자판).
fn print_usage(ctx: &mut Ctx<'_>, a: &AccountRow, active: bool) {
    let mark = if active { "* " } else { "  " };
    let mut head = vec![format!("{mark}{}", clean(&a.label()))];
    let u = a.usage.as_ref();
    if let Some(u) = u
        && !u.status.is_empty()
        && u.status != "ok"
    {
        head.push(clean(&u.status));
        if u.backoff_until > 0 {
            head.push(format!("다음 시도 {}", fmt_hm(u.backoff_until)));
        }
    }
    if let Some(u) = u
        && u.stale
    {
        head.push(format!("{}분 전", (u.age_seconds / 60).max(1)));
    }
    outf!(ctx, "{}\n", head.join(" · "));
    let Some((u, ws)) = u.and_then(|u| u.windows.as_ref().map(|w| (u, w))) else {
        if u.is_none_or(|u| u.status.is_empty()) {
            outf!(ctx, "    아직 조회하지 않음\n");
        }
        return;
    };
    if let Some(w) = &ws.five_hour {
        win_line(ctx, "5시간", w);
    }
    if let Some(w) = &ws.seven_day {
        win_line(ctx, "주간", w);
    }
    if let Some(p) = &u.pace.seven_day {
        let mut parts = vec![format!(
            "예상 {}%",
            format_float(p.expected_pct, b'g', -1, 64)
        )];
        if p.ahead_of_pace {
            parts.push("속도가 앞섬".to_owned());
        }
        if p.will_last_to_reset {
            parts.push("초기화까지 버팀".to_owned());
        } else if p.projected_exhaustion_at > 0 {
            parts.push(format!(
                "초기화 전 소진 ({})",
                fmt_md_hm(p.projected_exhaustion_at)
            ));
        } else {
            parts.push("초기화 전 소진".to_owned());
        }
        outf!(ctx, "    주간 예측 {}\n", parts.join(" · "));
    }
    for w in ws.scoped.iter().flatten() {
        win_line(ctx, &w.name, w);
    }
    print_resets(ctx, u);
    if let Some(sp) = &ws.spend {
        outf!(
            ctx,
            "    추가 사용량 {} / {}\n",
            money(sp.used, &sp.currency),
            money(sp.limit, &sp.currency)
        );
    }
    if u.login_expires_at > 0 {
        let soon = if u.login_expiring_soon {
            " (7일 안)"
        } else {
            ""
        };
        outf!(
            ctx,
            "    로그인 만료 {}{soon}\n",
            fmt_ymd(u.login_expires_at)
        );
    }
}

/// 초기화가 채우는 창의 이름이다. 모르는 창은 원래 이름을 쓴다.
fn window_name(w: &str) -> String {
    match w {
        "five_hour" => "5시간".to_owned(),
        "seven_day" => "주간".to_owned(),
        w => clean(w),
    }
}

/// 쓸 수 있는 제한 초기화 줄이다 (FR-CAC-65). 대상이 아니면 아무것도 쓰지 않는다.
fn print_resets(ctx: &mut Ctx<'_>, u: &AccountUsage) {
    let Some(r) = &u.resets else { return };
    if let Some(j) = &r.juniper
        && j.eligible
    {
        if j.available {
            outf!(ctx, "    주간 5시간 초기화: 쓸 수 있음\n");
        } else if j.next_available_at > 0 {
            outf!(
                ctx,
                "    주간 5시간 초기화: 다음 가능 {}\n",
                fmt_md_hm(j.next_available_at)
            );
        }
    }
    if let Some(c) = &r.cedar
        && c.eligible
    {
        for g in c.grants.iter().flatten() {
            if g.resets_left <= 0 {
                continue;
            }
            let mut parts = vec![format!("{}/{}회 남음", g.resets_left, g.resets_total)];
            if g.ends_at > 0 {
                parts.push(format!("{}까지", fmt_md(g.ends_at)));
            }
            if g.paused {
                parts.push("멈춤".to_owned());
            } else if g.usable_now {
                parts.push("쓸 수 있음".to_owned());
            }
            outf!(
                ctx,
                "    초기화 티켓 {}: {}  (--grant {})\n",
                clean(g.name()),
                parts.join(" · "),
                clean(&g.id)
            );
        }
    }
}

fn pick(v: &AccountsOut, pos: &[String]) -> Option<Vec<AccountRow>> {
    match pos.first() {
        None => Some(v.rows().to_vec()),
        Some(r) => v.resolve(r).map(|a| vec![a.clone()]),
    }
}

/// `otterctl account usage [<계정>] [--refresh] [--json]` 이다 (FR-CAC-102). --refresh 는 대상
/// 계정마다 바로 조회하고(FR-CAC-58), 실패한 계정이 있어도 나머지와 출력을 마친 뒤 1 로 끝난다.
fn account_usage(ctx: &mut Ctx<'_>, pa: &SubArgs) -> i32 {
    if pa.pos.len() > 1 {
        errf!(ctx, "otterctl account usage: 계정은 하나까지입니다\n");
        return 2;
    }
    let (mut v, mut raw) = try_rc!(load_accounts(ctx));
    let Some(mut rows) = pick(&v, &pa.pos) else {
        return no_such_account(ctx, &pa.pos[0]);
    };
    let mut code = 0;
    if pa.has("refresh") {
        for a in &rows {
            let body = json!({"id": a.id});
            if account_api(ctx, "POST", apipath::CLAUDE_ACCOUNTS_REFRESH, Some(body)).is_err() {
                code = 1;
            }
        }
        (v, raw) = try_rc!(load_accounts(ctx));
        let Some(r) = pick(&v, &pa.pos) else {
            return no_such_account(ctx, &pa.pos[0]);
        };
        rows = r;
    }
    if pa.has("json") {
        let keep: HashSet<&str> = rows.iter().map(|a| a.id.as_str()).collect();
        let full = decode_object(&raw).unwrap_or_default();
        let out: Vec<Value> = match full.get("accounts") {
            Some(Value::Array(list)) => list
                .iter()
                .filter(|a| {
                    a.get("id")
                        .and_then(Value::as_str)
                        .is_some_and(|id| keep.contains(id))
                })
                .cloned()
                .collect(),
            _ => Vec::new(),
        };
        let doc = json!({
            "schemaVersion": ACCOUNT_SCHEMA_VERSION,
            "activeId": v.active_id,
            "accounts": out,
        });
        outf!(ctx, "{}\n", clean(&marshal_line(&doc)));
        return code;
    }
    for a in &rows {
        print_usage(ctx, a, a.id == v.active_id);
    }
    code
}

// ── 초기화 ─────────────────────────────────────────────

/// 사용 결과의 문구다 (FR-CAC-63).
fn result_text(r: &str) -> Option<&'static str> {
    Some(match r {
        "reset" => "초기화했습니다",
        "already_used" => "이미 썼습니다",
        "not_limited" => "지금은 한도에 걸려 있지 않아 쓸 수 없습니다",
        "cooldown" => "아직 쓸 수 없습니다 (대기 중)",
        "ineligible" => "이 계정은 쓸 수 없습니다",
        "unavailable" => "지금은 쓸 수 없습니다",
        "rate_limited" => "요청이 너무 많습니다. 잠시 뒤 다시 하세요",
        "auth_error" => "인증에 실패했습니다. Claude Code 에서 다시 로그인하세요",
        "error" => "실패했습니다",
        "unconfirmed" => {
            "확인하지 못했습니다 — 잠시 뒤 사용량을 확인하세요. 자동으로 다시 보내지 않습니다"
        }
        _ => return None,
    })
}

/// FR-CAC-62 의 확인 내용이다. 서버가 아는 상태가 없으면 그 사실만 적는다.
fn reset_prompt(ctx: &mut Ctx<'_>, a: &AccountRow, program: &str, grant: &str) {
    outf!(ctx, "계정: {}\n", clean(&a.label()));
    if program == "juniper_tide" {
        outf!(
            ctx,
            "주간 5시간 초기화를 씁니다.\n  채우는 것: 5시간\n  주간 한도에서 차감됩니다.\n"
        );
        return;
    }
    let g = a
        .usage
        .as_ref()
        .and_then(|u| u.resets.as_ref())
        .and_then(|r| r.cedar.as_ref())
        .and_then(|c| c.grants.as_ref())
        .and_then(|gs| gs.iter().rfind(|g| g.id == grant));
    let Some(g) = g else {
        outf!(
            ctx,
            "초기화 티켓 {} 를 씁니다. (서버가 아는 상태가 없어 내용을 보일 수 없습니다)\n",
            clean(grant)
        );
        return;
    };
    let names: Vec<String> = g.clears.iter().flatten().map(|c| window_name(c)).collect();
    outf!(
        ctx,
        "초기화 티켓 {} 를 씁니다.\n  채우는 것: {}\n  남은 횟수 {}/{}\n",
        clean(g.name()),
        names.join(", "),
        g.resets_left,
        g.resets_total
    );
    if g.ends_at > 0 {
        outf!(ctx, "  기한: {}\n", fmt_ymd_hm(g.ends_at));
    }
    if g.gives_back_weekly {
        outf!(ctx, "  쓴 만큼 주간 한도를 돌려받습니다.\n");
    } else {
        outf!(ctx, "  주간 한도에서 차감됩니다.\n");
    }
}

/// Go `bufio.Reader.ReadString('\n')` 한 번 — 오류는 버린다.
fn read_line(ctx: &mut Ctx<'_>) -> String {
    let mut buf = Vec::new();
    let mut b = [0u8; 1];
    while let Ok(1) = ctx.inp.read(&mut b) {
        buf.push(b[0]);
        if b[0] == b'\n' {
            break;
        }
    }
    String::from_utf8_lossy(&buf).into_owned()
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct ResetResp {
    result: String,
    #[serde(rename = "resetsLeft")]
    resets_left: Option<i64>,
    #[serde(rename = "nextAvailableAt")]
    next_available_at: i64,
    #[serde(rename = "cooldownUntil")]
    cooldown_until: i64,
}

/// `otterctl account reset` 이다 (FR-CAC-62·65). 결과가 reset 이 아니면 1 로 끝난다.
fn account_reset(ctx: &mut Ctx<'_>, pa: &SubArgs) -> i32 {
    let (program, grant) = (pa.flag("program"), pa.flag("grant"));
    let ok = (program == "juniper_tide" && grant.is_empty())
        || (program == "cedar_ember" && !grant.is_empty());
    if !ok {
        errf!(
            ctx,
            "otterctl account reset: --program juniper_tide, 또는 --program cedar_ember --grant <id> 가 필요합니다\n"
        );
        return 2;
    }
    let (v, _) = try_rc!(load_accounts(ctx));
    let Some(a) = v.resolve(&pa.pos[0]) else {
        return no_such_account(ctx, &pa.pos[0]);
    };
    if !pa.has("yes") {
        reset_prompt(ctx, a, program, grant);
        outf!(ctx, "계속할까요? [y/N] ");
        let line = read_line(ctx);
        let ans = line.trim().to_lowercase();
        if ans != "y" && ans != "yes" {
            outf!(ctx, "\n취소했습니다.\n");
            return 1;
        }
    }
    let mut body = json!({"id": a.id, "program": program});
    if !grant.is_empty() {
        body["grantId"] = json!(grant);
    }
    let raw = try_rc!(account_api(
        ctx,
        "POST",
        apipath::CLAUDE_ACCOUNTS_RESET,
        Some(body)
    ));
    let res: ResetResp = decode(&raw).unwrap_or_default();
    let mut msg = match result_text(&res.result) {
        Some(t) => t.to_owned(),
        None => format!("알 수 없는 결과: {}", clean(&res.result)),
    };
    if let Some(n) = res.resets_left {
        msg += &format!(" (남은 횟수 {n})");
    }
    if res.cooldown_until > 0 {
        msg += &format!(" — {} 뒤에 다시", fmt_md_hm(res.cooldown_until));
    }
    if res.next_available_at > 0 && res.result == "reset" {
        msg += &format!(" — 다음 가능 {}", fmt_md_hm(res.next_available_at));
    }
    outf!(ctx, "{msg}\n");
    if res.result != "reset" {
        return 1;
    }
    0
}

// ── 자동 전환·기록 ─────────────────────────────────────

#[derive(Default, Deserialize)]
#[serde(default)]
struct AutoSettings {
    threshold: f64,
    #[serde(rename = "weeklyThreshold")]
    weekly_threshold: Option<f64>,
    #[serde(rename = "intervalSeconds")]
    interval_seconds: i64,
    #[serde(rename = "cooldownSeconds")]
    cooldown_seconds: i64,
    #[serde(rename = "hysteresisPct")]
    hysteresis_pct: f64,
    strategy: String,
    #[serde(rename = "unhealthyTicks")]
    unhealthy_ticks: i64,
    models: Option<Vec<String>>,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct SwitchEntry {
    at: i64,
    from: String,
    to: String,
    trigger: String,
    by: String,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct AutoState {
    status: String,
    #[serde(rename = "lastSwitch")]
    last_switch: Option<SwitchEntry>,
    quarantined: Option<Vec<String>>,
}

#[derive(Default, Deserialize)]
#[serde(default, rename = "runtimebin.autoView")]
struct AutoView {
    settings: AutoSettings,
    state: AutoState,
}

fn auto_status_text(status: &str) -> &'static str {
    match status {
        "on" => "켜짐",
        "unmanaged" => "켜짐 — 활성 계정이 등록되지 않아 판단하지 않습니다",
        "exhausted" => "켜짐 — 모든 후보의 한도가 차서 쉬는 중입니다",
        _ => "꺼짐",
    }
}

fn account_auto(ctx: &mut Ctx<'_>, pa: &SubArgs) -> i32 {
    match pa.pos[0].as_str() {
        p @ ("on" | "off") => {
            let body = json!({"enabled": p == "on"});
            let raw = try_rc!(account_api(
                ctx,
                "PUT",
                apipath::CLAUDE_ACCOUNTS_AUTOSWITCH,
                Some(body)
            ));
            let v: AutoView = decode(&raw).unwrap_or_default();
            outf!(ctx, "자동 전환: {}\n", auto_status_text(&v.state.status));
            0
        }
        "status" => account_auto_status(ctx, pa),
        p => {
            errf!(
                ctx,
                "otterctl account auto: on, off, status 중 하나여야 합니다: {}\n",
                clean(p)
            );
            2
        }
    }
}

fn account_auto_status(ctx: &mut Ctx<'_>, pa: &SubArgs) -> i32 {
    let raw = try_rc!(account_api(
        ctx,
        "GET",
        apipath::CLAUDE_ACCOUNTS_AUTOSWITCH,
        None
    ));
    if pa.has("json") {
        let mut m = decode_object(&raw).unwrap_or_default();
        m.insert("schemaVersion".into(), json!(ACCOUNT_SCHEMA_VERSION));
        let b = json::marshal_indent(&Value::Object(m), "", "  ").unwrap_or_default();
        outf!(ctx, "{}\n", String::from_utf8_lossy(&b));
        return 0;
    }
    let v: AutoView = match decode(&raw) {
        Ok(v) => v,
        Err(e) => {
            errf!(ctx, "otterctl account: 응답을 읽지 못했습니다: {e}\n");
            return 1;
        }
    };
    let (accts, _) = try_rc!(load_accounts(ctx));
    let s = &v.settings;
    let weekly = match s.weekly_threshold {
        Some(w) => format!("{}%", format_float(w, b'f', -1, 64)),
        None => "문턱값과 같음".to_owned(),
    };
    let models = match &s.models {
        Some(m) if !m.is_empty() => m.join(", "),
        _ => "5시간·주간만".to_owned(),
    };
    outf!(ctx, "자동 전환: {}\n", auto_status_text(&v.state.status));
    outf!(
        ctx,
        "문턱값 {}% · 주간 문턱값 {weekly} · 전략 {} · 판단 간격 {}초 · 쿨다운 {}초 · 히스테리시스 {}%p · 모름 허용 {}번 · 모델 {}\n",
        format_float(s.threshold, b'f', -1, 64),
        clean(&s.strategy),
        s.interval_seconds,
        s.cooldown_seconds,
        format_float(s.hysteresis_pct, b'f', -1, 64),
        s.unhealthy_ticks,
        clean(&models)
    );
    if let Some(ls) = &v.state.last_switch {
        outf!(
            ctx,
            "마지막 전환: {}  {} → {}  ({})\n",
            fmt_ymd_hm(ls.at),
            accts.name(&ls.from),
            accts.name(&ls.to),
            clean(&ls.trigger)
        );
    }
    if let Some(q) = v.state.quarantined.as_ref().filter(|q| !q.is_empty()) {
        let names: Vec<String> = q.iter().map(|id| accts.name(id)).collect();
        outf!(
            ctx,
            "격리(토큰 갱신 영구 실패, 다시 추가하면 풀림): {}\n",
            names.join(", ")
        );
    }
    0
}

#[derive(Default, Deserialize)]
#[serde(default, rename = "runtimebin.historyResp")]
struct HistoryResp {
    entries: Option<Vec<SwitchEntry>>,
}

fn account_history(ctx: &mut Ctx<'_>, pa: &SubArgs) -> i32 {
    let mut limit = HISTORY_DEFAULT_LIMIT;
    if let Some(s) = pa.flags.get("limit") {
        match atoi(s) {
            Some(n) if (1..=HISTORY_MAX_LIMIT).contains(&n) => limit = n,
            _ => {
                errf!(ctx, "otterctl account history: --limit 은 1~1000 입니다\n");
                return 2;
            }
        }
    }
    let (accts, _) = try_rc!(load_accounts(ctx));
    let path = format!("{}?limit={limit}", apipath::CLAUDE_ACCOUNTS_HISTORY);
    let raw = try_rc!(account_api(ctx, "GET", &path, None));
    let v: HistoryResp = match decode(&raw) {
        Ok(v) => v,
        Err(e) => {
            errf!(ctx, "otterctl account: 응답을 읽지 못했습니다: {e}\n");
            return 1;
        }
    };
    let entries = v.entries.unwrap_or_default();
    if entries.is_empty() {
        outf!(ctx, "전환 기록이 없습니다.\n");
        return 0;
    }
    for e in &entries {
        outf!(
            ctx,
            "{}  {} → {}  {}  {}\n",
            fmt_ymd_hm(e.at),
            accts.name(&e.from),
            accts.name(&e.to),
            clean(&e.trigger),
            clean(&e.by)
        );
    }
    0
}

// ── 탭 지정·폴더 연결 (FR-CAC-102 묶음 H) ──────────────

fn account_by_ref(ctx: &mut Ctx<'_>, r: &str) -> Result<AccountRow, i32> {
    let (v, _) = load_accounts(ctx)?;
    match v.resolve(r) {
        Some(a) => Ok(a.clone()),
        None => Err(no_such_account(ctx, r)),
    }
}

fn account_pin(ctx: &mut Ctx<'_>, pa: &SubArgs) -> i32 {
    let unpin = pa.has("clear");
    if unpin == (pa.pos.len() == 1) || pa.pos.len() > 1 {
        errf!(
            ctx,
            "otterctl account pin: <계정> 하나 또는 --clear 가 필요합니다\n"
        );
        return 2;
    }
    let mut tool = pa.flag("tab").to_owned();
    if tool.is_empty() {
        tool = self_tool_id(ctx.env);
    }
    if tool.is_empty() {
        errf!(
            ctx,
            "otterctl account pin: 이 셸의 탭을 알 수 없습니다. --tab <toolId> 를 주세요\n"
        );
        return 2;
    }
    let (mut id, mut label) = (String::new(), String::new());
    if !unpin {
        let a = try_rc!(account_by_ref(ctx, &pa.pos[0]));
        (id, label) = (a.id.clone(), a.label());
    }
    let body = json!({"toolId": tool, "accountId": id});
    try_rc!(account_api(
        ctx,
        "PUT",
        apipath::CLAUDE_ACCOUNTS_MAPPINGS,
        Some(body)
    ));
    if unpin {
        outf!(ctx, "탭 지정을 풀었습니다: {}\n", clean(&tool));
    } else {
        outf!(ctx, "탭 지정: {} → {}\n", clean(&tool), clean(&label));
    }
    outf!(
        ctx,
        "실행 중인 claude 에는 적용되지 않고 다음 실행부터 적용됩니다.\n"
    );
    0
}

/// 경로 인자를 절대 경로로 바꾼다. 비면 현재 폴더다.
fn folder_arg(ctx: &mut Ctx<'_>, p: &str) -> Result<String, i32> {
    let p = if p.is_empty() { "." } else { p };
    match otter_gocompat::filepath::abs(p) {
        Ok(a) => Ok(a),
        Err(e) => {
            errf!(ctx, "otterctl account: 경로를 알 수 없습니다: {e}\n");
            Err(1)
        }
    }
}

fn account_map(ctx: &mut Ctx<'_>, pa: &SubArgs) -> i32 {
    if pa.pos.is_empty() || pa.pos.len() > 2 {
        errf!(ctx, "otterctl account map: <계정> [경로] 가 필요합니다\n");
        return 2;
    }
    let a = try_rc!(account_by_ref(ctx, &pa.pos[0]));
    let path = pa.pos.get(1).map_or("", String::as_str);
    let dir = try_rc!(folder_arg(ctx, path));
    let body = json!({"folder": dir, "accountId": a.id});
    try_rc!(account_api(
        ctx,
        "PUT",
        apipath::CLAUDE_ACCOUNTS_MAPPINGS,
        Some(body)
    ));
    outf!(
        ctx,
        "폴더 연결: {} → {}\n다음 claude 실행부터 적용됩니다.\n",
        clean(&dir),
        clean(&a.label())
    );
    0
}

fn account_unmap(ctx: &mut Ctx<'_>, pa: &SubArgs) -> i32 {
    if pa.pos.len() > 1 {
        errf!(ctx, "otterctl account unmap: [경로] 하나만 받습니다\n");
        return 2;
    }
    let path = pa.pos.first().map_or("", String::as_str);
    let dir = try_rc!(folder_arg(ctx, path));
    let body = json!({"folder": dir, "accountId": ""});
    try_rc!(account_api(
        ctx,
        "PUT",
        apipath::CLAUDE_ACCOUNTS_MAPPINGS,
        Some(body)
    ));
    outf!(ctx, "폴더 연결을 풀었습니다: {}\n", clean(&dir));
    0
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct MappedAccount {
    #[serde(rename = "accountId")]
    account_id: String,
}

#[derive(Default, Deserialize)]
#[serde(default, rename = "runtimebin.accountMappings")]
struct AccountMappings {
    folders: Option<BTreeMap<String, MappedAccount>>,
    tabs: Option<BTreeMap<String, MappedAccount>>,
}

fn account_maps(ctx: &mut Ctx<'_>, _pa: &SubArgs) -> i32 {
    let (v, _) = try_rc!(load_accounts(ctx));
    let raw = try_rc!(account_api(
        ctx,
        "GET",
        apipath::CLAUDE_ACCOUNTS_MAPPINGS,
        None
    ));
    let m: AccountMappings = match decode(&raw) {
        Ok(m) => m,
        Err(e) => {
            errf!(ctx, "otterctl account: 응답을 읽지 못했습니다: {e}\n");
            return 1;
        }
    };
    let name = |id: &str| match v.resolve(id) {
        Some(a) => clean(&a.label()),
        None => "(삭제된 계정)".to_owned(),
    };
    outf!(ctx, "폴더 연결:\n");
    for (k, f) in m.folders.iter().flatten() {
        outf!(ctx, "  {} → {}\n", clean(k), name(&f.account_id));
    }
    outf!(ctx, "탭 지정:\n");
    for (k, t) in m.tabs.iter().flatten() {
        outf!(ctx, "  {} → {}\n", clean(k), name(&t.account_id));
    }
    0
}

#[cfg(test)]
pub(crate) fn span_for_test(sec: i64) -> String {
    account_span(sec)
}
