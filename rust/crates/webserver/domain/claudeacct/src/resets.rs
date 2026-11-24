//! 묶음 F — 제한 초기화 (FR-CAC-60~65). 형식은 Claude Code 2.1.323 의 `juniper-tide`·`cedar-ember` 와 같다.

use std::collections::BTreeMap;
use std::sync::LazyLock;

use otter_gocompat::json::{self, RawMessage, is_empty};
use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::error::Error;
use crate::usage::parse_resets_at;

/// 두 프로그램 (FR-CAC-60).
pub const PROGRAM_JUNIPER: &str = "juniper_tide";
pub const PROGRAM_CEDAR: &str = "cedar_ember";

pub(crate) const QUERY_JUNIPER: &str = "at_wall=1&skip_spend=1";
pub(crate) const QUERY_CEDAR: &str = "cedar_ember=1&skip_spend=1";

pub(crate) static GRANT_ID_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[a-z0-9_-]{1,40}$").expect("상수 정규식"));
pub(crate) static REQUEST_ID_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_-]{1,64}$").expect("상수 정규식"));

/// clears·blocking·exhausted 에 남기는 창 이름이다 (FR-CAC-60a).
const RESET_WINDOWS: [&str; 8] = [
    "five_hour",
    "seven_day",
    "seven_day_overage_included",
    "seven_day_opus",
    "seven_day_sonnet",
    "seven_day_cowork",
    "seven_day_omelette",
    "seven_day_oauth_apps",
];

/// 프로그램마다 서버가 낼 수 있는 결과다. 모르는 값은 unavailable 이다.
fn claim_results(program: &str) -> &'static [&'static str] {
    match program {
        PROGRAM_JUNIPER => &[
            "reset",
            "already_used",
            "not_limited",
            "ineligible",
            "unavailable",
        ],
        PROGRAM_CEDAR => &[
            "reset",
            "already_used",
            "not_limited",
            "cooldown",
            "ineligible",
            "unavailable",
        ],
        _ => &[],
    }
}

/// 주간 5시간 초기화의 상태다. 시각은 unix 초이고 모르면 0 이다.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "claudeacct.JuniperStatus")]
pub struct JuniperStatus {
    pub eligible: bool,
    #[serde(rename = "ineligibleReason", skip_serializing_if = "is_empty")]
    pub ineligible_reason: String,
    pub available: bool,
    #[serde(rename = "nextAvailableAt", skip_serializing_if = "is_empty")]
    pub next_available_at: i64,
}

/// 초기화 티켓 하나다.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "claudeacct.CedarGrant")]
pub struct CedarGrant {
    pub id: String,
    pub label: String,
    #[serde(rename = "resetsTotal")]
    pub resets_total: i64,
    #[serde(rename = "resetsLeft")]
    pub resets_left: i64,
    #[serde(rename = "startsAt", skip_serializing_if = "is_empty")]
    pub starts_at: i64,
    #[serde(rename = "endsAt", skip_serializing_if = "is_empty")]
    pub ends_at: i64,
    pub clears: Vec<String>,
    pub paused: bool,
    #[serde(rename = "usableNow")]
    pub usable_now: bool,
    #[serde(rename = "useRequiresLimit")]
    pub use_requires_limit: bool,
    #[serde(rename = "percentUsed", skip_serializing_if = "is_empty")]
    pub percent_used: BTreeMap<String, i64>,
    pub blocking: Vec<String>,
    #[serde(rename = "givesBackWeekly")]
    pub gives_back_weekly: bool,
    #[serde(rename = "unavailableReason", skip_serializing_if = "is_empty")]
    pub unavailable_reason: String,
}

/// 초기화 티켓의 상태다.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "claudeacct.CedarStatus")]
pub struct CedarStatus {
    pub eligible: bool,
    #[serde(rename = "ineligibleReason", skip_serializing_if = "is_empty")]
    pub ineligible_reason: String,
    #[serde(rename = "atLimit")]
    pub at_limit: bool,
    pub exhausted: Vec<String>,
    #[serde(rename = "cooldownUntil", skip_serializing_if = "is_empty")]
    pub cooldown_until: i64,
    #[serde(rename = "weeklyResetsAt", skip_serializing_if = "is_empty")]
    pub weekly_resets_at: i64,
    pub grants: Vec<CedarGrant>,
}

/// 한 계정의 두 상태다. 프로그램이 없으면 그 필드가 `None` 이다 (FR-CAC-61).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "claudeacct.Resets")]
pub struct Resets {
    #[serde(rename = "juniperTide", skip_serializing_if = "is_empty")]
    pub juniper: Option<JuniperStatus>,
    #[serde(rename = "cedarEmber", skip_serializing_if = "is_empty")]
    pub cedar: Option<CedarStatus>,
    #[serde(rename = "fetchedAt")]
    pub fetched_at: i64,
}

impl Resets {
    /// 지금 쓸 수 있는 제한 초기화가 있는가다 (FR-CAC-65 의 "초기화 사용…" 조건).
    pub fn usable(r: Option<&Resets>) -> bool {
        let Some(r) = r else { return false };
        if let Some(j) = &r.juniper
            && j.eligible
            && j.available
        {
            return true;
        }
        if let Some(c) = &r.cedar
            && c.eligible
        {
            return c.grants.iter().any(|g| g.resets_left > 0 && g.usable_now);
        }
        false
    }
}

/// 사용의 결과다 (FR-CAC-63).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "claudeacct.ClaimResult")]
pub struct ClaimResult {
    pub result: String,
    #[serde(skip_serializing_if = "is_empty")]
    pub reason: String,
    #[serde(rename = "resetsLeft", skip_serializing_if = "is_empty")]
    pub resets_left: Option<i64>,
    #[serde(skip_serializing_if = "is_empty")]
    pub cleared: Vec<String>,
    #[serde(rename = "nextAvailableAt", skip_serializing_if = "is_empty")]
    pub next_available_at: i64,
    #[serde(rename = "weeklyResetsAt", skip_serializing_if = "is_empty")]
    pub weekly_resets_at: i64,
    #[serde(rename = "cooldownUntil", skip_serializing_if = "is_empty")]
    pub cooldown_until: i64,
}

fn known_windows(v: Vec<String>) -> Vec<String> {
    v.into_iter()
        .filter(|w| RESET_WINDOWS.contains(&w.as_str()))
        .collect()
}

fn time_of(p: Option<String>) -> i64 {
    parse_resets_at(&p.unwrap_or_default())
}

/// 본문의 한 필드를 꺼낸다. 없거나 null 이면 `None` 이다.
fn block(raw: &[u8], name: &str) -> Option<RawMessage> {
    let top = json::unmarshal::<Option<BTreeMap<String, RawMessage>>>(raw)
        .ok()
        .flatten()?;
    let b = top.get(name)?;
    if b.0.is_empty() || b.0 == b"null" {
        return None;
    }
    Some(b.clone())
}

/// `?at_wall=1` 응답의 `juniper_tide` 다. 없거나 형식이 틀리면 `None` 이다.
pub fn parse_juniper(raw: &[u8]) -> Option<JuniperStatus> {
    #[derive(Deserialize, Default)]
    #[serde(default)]
    struct V {
        eligible: Option<bool>,
        ineligible_reason: Option<String>,
        available: Option<bool>,
        next_available_at: Option<String>,
    }
    let b = block(raw, PROGRAM_JUNIPER)?;
    let v = json::unmarshal::<V>(&b.0).ok()?;
    Some(JuniperStatus {
        eligible: v.eligible?,
        ineligible_reason: v.ineligible_reason.unwrap_or_default(),
        available: v.available == Some(true),
        next_available_at: time_of(v.next_available_at),
    })
}

fn parse_grant(b: &RawMessage) -> Option<CedarGrant> {
    #[derive(Deserialize, Default)]
    #[serde(default)]
    struct V {
        id: String,
        label: String,
        resets_total: i64,
        resets_left: Option<i64>,
        starts_at: Option<String>,
        ends_at: Option<String>,
        clears: Option<Vec<String>>,
        paused: bool,
        usable_now: bool,
        use_requires_limit: Option<bool>,
        percent_used: Option<BTreeMap<String, serde_json::Value>>,
        blocking: Option<Vec<String>>,
        gives_back_weekly: bool,
        unavailable_reason: Option<String>,
    }
    let v = json::unmarshal::<V>(&b.0).ok()?;
    let left = v.resets_left.filter(|n| *n >= 0)?;
    if !GRANT_ID_RE.is_match(&v.id) {
        return None;
    }
    let mut pct = BTreeMap::new();
    for (k, x) in v.percent_used.unwrap_or_default() {
        if let Some(f) = x.as_f64()
            && RESET_WINDOWS.contains(&k.as_str())
            && f == f.trunc()
            && (0.0..=100.0).contains(&f)
        {
            pct.insert(k, f as i64);
        }
    }
    Some(CedarGrant {
        id: v.id,
        label: v.label,
        resets_total: v.resets_total.max(0),
        resets_left: left,
        starts_at: time_of(v.starts_at),
        ends_at: time_of(v.ends_at),
        clears: known_windows(v.clears.unwrap_or_default()),
        paused: v.paused,
        usable_now: v.usable_now,
        use_requires_limit: v.use_requires_limit.unwrap_or(true),
        percent_used: pct,
        blocking: known_windows(v.blocking.unwrap_or_default()),
        gives_back_weekly: v.gives_back_weekly,
        unavailable_reason: v.unavailable_reason.unwrap_or_default(),
    })
}

/// `?cedar_ember=1` 응답의 `cedar_ember` 다. 형식이 틀린 티켓은 그 티켓만 뺀다.
pub fn parse_cedar(raw: &[u8]) -> Option<CedarStatus> {
    #[derive(Deserialize, Default)]
    #[serde(default)]
    struct V {
        eligible: Option<bool>,
        ineligible_reason: Option<String>,
        at_limit: bool,
        exhausted: Option<Vec<String>>,
        grants: Option<Vec<RawMessage>>,
        weekly_resets_at: Option<String>,
        cooldown_until: Option<String>,
    }
    let b = block(raw, PROGRAM_CEDAR)?;
    let v = json::unmarshal::<V>(&b.0).ok()?;
    Some(CedarStatus {
        eligible: v.eligible?,
        ineligible_reason: v.ineligible_reason.unwrap_or_default(),
        at_limit: v.at_limit,
        exhausted: known_windows(v.exhausted.unwrap_or_default()),
        weekly_resets_at: time_of(v.weekly_resets_at),
        cooldown_until: time_of(v.cooldown_until),
        grants: v
            .grants
            .unwrap_or_default()
            .iter()
            .filter_map(parse_grant)
            .collect(),
    })
}

/// 사용 요청의 답을 결과로 바꾼다 (FR-CAC-63). err 가 상태 오류가 아니면 응답을 받지 못한 것이다.
pub(crate) fn claim_result_of(program: &str, raw: &[u8], err: Option<&Error>) -> ClaimResult {
    let res = |s: &str| ClaimResult {
        result: s.to_owned(),
        ..ClaimResult::default()
    };
    if let Some(err) = err {
        return match err.http_status().map(|s| s.status) {
            None => res("unconfirmed"),
            Some(429) => res("rate_limited"),
            Some(401 | 403) => res("auth_error"),
            Some(_) => res("error"),
        };
    }
    #[derive(Deserialize, Default)]
    #[serde(default)]
    struct V {
        result: Option<String>,
        reason: Option<String>,
        resets_left: Option<i64>,
        cleared: Option<Vec<String>>,
        next_available_at: Option<String>,
        weekly_resets_at: Option<String>,
        cooldown_until: Option<String>,
    }
    let Some(v) = json::unmarshal::<V>(raw).ok() else {
        return res("error");
    };
    let Some(r) = v.result else {
        return res("error");
    };
    let r = if claim_results(program).contains(&r.as_str()) {
        r
    } else {
        "unavailable".to_owned()
    };
    let mut out = res(&r);
    if program == PROGRAM_JUNIPER {
        out.next_available_at = time_of(v.next_available_at);
        return out;
    }
    out.reason = v.reason.unwrap_or_default();
    out.resets_left = v.resets_left.filter(|n| *n >= 0);
    out.cleared = known_windows(v.cleared.unwrap_or_default());
    out.weekly_resets_at = time_of(v.weekly_resets_at);
    out.cooldown_until = time_of(v.cooldown_until);
    out
}
