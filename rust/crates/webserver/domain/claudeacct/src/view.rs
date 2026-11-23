//! 화면에 내보내는 계정·사용량 뷰 (FR-CAC-90~). 토큰은 싣지 않는다.

use std::collections::BTreeMap;

use dm_gocompat::json::is_empty;
use dm_gocompat::time::GoTime;
use dm_webserver_domain_run::{LEVEL_CRITICAL, LEVEL_WARN};
use serde::Serialize;

use crate::engine::Row;
use crate::pace::{Pace, compute_pace};
use crate::policy::FRESH_FOR_DECISION_S;
use crate::resets::Resets;
use crate::smart::{STATUS_LINE_GRACE_S, merge_window};
use crate::store::{Account, State};
use crate::usage::{Spend, Usage, Window};

/// 로그인 만료 경고를 시작하는 남은 시간이다 (FR-CAC-45).
pub(crate) const LOGIN_WARN_S: i64 = 7 * 86400;
/// 사용률의 경고 경계다 — statusLine 한도와 같은 규칙이다 (D-ASV-9, FR-CAC-93).
const USAGE_WARN_PCT: f64 = 70.0;
const USAGE_CRITICAL_PCT: f64 = 90.0;

/// 사용률의 수준이다: `critical`·`warn`·"".
pub fn usage_level(pct: f64) -> &'static str {
    if pct >= USAGE_CRITICAL_PCT {
        LEVEL_CRITICAL
    } else if pct >= USAGE_WARN_PCT {
        LEVEL_WARN
    } else {
        ""
    }
}

/// 별칭, 없으면 이메일 앞 두 글자 + `***@` 다 (FR-CAC-101).
pub(crate) fn display_name(a: &Account) -> String {
    if !a.alias.is_empty() {
        return a.alias.clone();
    }
    let local = a.email.split_once('@').map_or(a.email.as_str(), |(l, _)| l);
    let head: String = local.chars().take(2).collect();
    format!("{head}***@")
}

/// 이메일을 가린 표시 이름이다.
pub fn masked_name(email: &str) -> String {
    display_name(&Account {
        email: email.to_owned(),
        ..Account::default()
    })
}

/// 창 하나의 뷰. Go 는 `Window` 를 임베드한다.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct WindowView {
    pub pct: f64,
    #[serde(rename = "resetsAt", skip_serializing_if = "is_empty")]
    pub resets_at: i64,
    #[serde(rename = "resetsInSec", skip_serializing_if = "is_empty")]
    pub resets_in_sec: Option<i64>,
    pub level: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct ScopedWindowView {
    pub name: String,
    pub pct: f64,
    #[serde(rename = "resetsAt", skip_serializing_if = "is_empty")]
    pub resets_at: i64,
    #[serde(rename = "resetsInSec", skip_serializing_if = "is_empty")]
    pub resets_in_sec: Option<i64>,
    pub level: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct WindowsView {
    #[serde(rename = "fiveHour", skip_serializing_if = "is_empty")]
    pub five_hour: Option<WindowView>,
    #[serde(rename = "sevenDay", skip_serializing_if = "is_empty")]
    pub seven_day: Option<WindowView>,
    #[serde(skip_serializing_if = "is_empty")]
    pub scoped: Vec<ScopedWindowView>,
    #[serde(skip_serializing_if = "is_empty")]
    pub spend: Option<Spend>,
}

pub(crate) fn window_view(w: Window, now: i64) -> WindowView {
    WindowView {
        pct: w.pct,
        resets_at: w.resets_at,
        resets_in_sec: (w.resets_at > 0).then(|| (w.resets_at - now).max(0)),
        level: usage_level(w.pct).to_owned(),
    }
}

fn windows_view(u: &Usage, now: i64) -> WindowsView {
    WindowsView {
        five_hour: u.five_hour.map(|w| window_view(w, now)),
        seven_day: u.seven_day.map(|w| window_view(w, now)),
        scoped: u
            .scoped
            .iter()
            .map(|s| {
                let v = window_view(s.window(), now);
                ScopedWindowView {
                    name: s.name.clone(),
                    pct: v.pct,
                    resets_at: v.resets_at,
                    resets_in_sec: v.resets_in_sec,
                    level: v.level,
                }
            })
            .collect(),
        spend: u.spend.clone(),
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct PaceView {
    #[serde(rename = "sevenDay", skip_serializing_if = "is_empty")]
    pub seven_day: Option<Pace>,
    #[serde(skip_serializing_if = "is_empty")]
    pub scoped: BTreeMap<String, Pace>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct UsageView {
    #[serde(skip_serializing_if = "is_empty")]
    pub status: String,
    #[serde(skip_serializing_if = "is_empty")]
    pub windows: Option<WindowsView>,
    pub pace: PaceView,
    #[serde(rename = "fetchedAt", skip_serializing_if = "is_empty")]
    pub fetched_at: i64,
    #[serde(rename = "ageSeconds", skip_serializing_if = "is_empty")]
    pub age_seconds: i64,
    #[serde(skip_serializing_if = "is_empty")]
    pub stale: bool,
    #[serde(rename = "nextPollAt", skip_serializing_if = "is_empty")]
    pub next_poll_at: i64,
    #[serde(rename = "backoffUntil", skip_serializing_if = "is_empty")]
    pub backoff_until: i64,
    #[serde(rename = "loginExpiresAt", skip_serializing_if = "is_empty")]
    pub login_expires_at: i64,
    #[serde(rename = "loginExpiringSoon", skip_serializing_if = "is_empty")]
    pub login_expiring_soon: bool,
    #[serde(skip_serializing_if = "is_empty")]
    pub resets: Option<Resets>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct StatusLineWindows {
    #[serde(rename = "fiveHour", skip_serializing_if = "is_empty")]
    pub five_hour: Option<WindowView>,
    #[serde(rename = "sevenDay", skip_serializing_if = "is_empty")]
    pub seven_day: Option<WindowView>,
}

/// statusLine 이 본 사용량의 뷰 (FR-CAC-93).
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct StatusLineView {
    #[serde(skip_serializing_if = "is_empty")]
    pub name: String,
    pub windows: StatusLineWindows,
    #[serde(rename = "observedAt")]
    pub observed_at: i64,
    #[serde(rename = "ageSeconds")]
    pub age_seconds: i64,
    pub stale: bool,
}

/// 계정 하나의 뷰. Go 는 `Account` 를 임베드한다 — JSON 은 계정 필드 뒤에 나머지가 온다.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct AccountView {
    pub account: Account,
    pub active: bool,
    pub usage: Option<UsageView>,
    pub status_line: Option<StatusLineView>,
    pub profile_warnings: Vec<String>,
}

#[derive(Serialize)]
struct AccountViewWire<'a> {
    id: &'a str,
    email: &'a str,
    #[serde(rename = "accountUuid")]
    account_uuid: &'a str,
    #[serde(rename = "organizationUuid")]
    org_uuid: &'a str,
    #[serde(rename = "organizationName")]
    org_name: &'a str,
    #[serde(rename = "addedAt")]
    added_at: GoTime,
    #[serde(skip_serializing_if = "is_empty")]
    alias: String,
    color: &'a str,
    disabled: bool,
    #[serde(skip_serializing_if = "is_empty")]
    threshold: Option<f64>,
    priority: i64,
    active: bool,
    usage: &'a Option<UsageView>,
    #[serde(rename = "statusLine", skip_serializing_if = "is_empty")]
    status_line: Option<StatusLineView>,
    #[serde(rename = "profileWarnings", skip_serializing_if = "is_empty")]
    profile_warnings: Vec<String>,
}

impl Serialize for AccountView {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let a = &self.account;
        AccountViewWire {
            id: &a.id,
            email: &a.email,
            account_uuid: &a.account_uuid,
            org_uuid: &a.org_uuid,
            org_name: &a.org_name,
            added_at: a.added_at,
            alias: a.alias.clone(),
            color: &a.color,
            disabled: a.disabled,
            threshold: a.threshold,
            priority: a.priority,
            active: self.active,
            usage: &self.usage,
            status_line: self.status_line.clone(),
            profile_warnings: self.profile_warnings.clone(),
        }
        .serialize(s)
    }
}

/// statusLine 관측 하나의 뷰다.
pub fn status_line_view_of(u: &Usage, at: i64, now: i64) -> StatusLineView {
    let age = (now - at).max(0);
    StatusLineView {
        windows: StatusLineWindows {
            five_hour: u.five_hour.map(|w| window_view(w, now)),
            seven_day: u.seven_day.map(|w| window_view(w, now)),
        },
        observed_at: at,
        age_seconds: age,
        stale: age > FRESH_FOR_DECISION_S,
        ..StatusLineView::default()
    }
}

/// 계정 목록의 뷰다. 순서는 계정 순서다.
pub fn build_views(st: &State, rows: &BTreeMap<String, Row>, now: i64) -> Vec<AccountView> {
    st.accounts
        .iter()
        .map(|a| {
            let r = rows.get(&a.id).cloned().unwrap_or_default();
            let mut uv = UsageView {
                status: r.status.clone(),
                next_poll_at: r.next_poll_at,
                backoff_until: r.backoff_until,
                login_expires_at: r.login_expires_at,
                resets: r.resets.clone(),
                login_expiring_soon: r.login_expires_at > 0
                    && r.login_expires_at - now <= LOGIN_WARN_S,
                ..UsageView::default()
            };
            if let Some(g) = &r.last_good {
                uv.windows = Some(windows_view(g, now));
                uv.fetched_at = r.fetched_at;
                uv.age_seconds = (now - r.fetched_at).max(0);
                uv.stale = uv.age_seconds > FRESH_FOR_DECISION_S;
                if let Some(w) = g.seven_day {
                    uv.pace.seven_day = compute_pace(w.pct, w.resets_at, r.fetched_at);
                }
                for s in &g.scoped {
                    if let Some(p) = compute_pace(s.pct, s.resets_at, r.fetched_at) {
                        uv.pace.scoped.insert(s.name.clone(), p);
                    }
                }
            }
            AccountView {
                account: a.clone(),
                active: a.id == st.active_id,
                usage: Some(uv),
                ..AccountView::default()
            }
        })
        .collect()
}

impl AccountView {
    /// statusLine 관측을 싣고, 전환 직후가 아니면 5시간·주간 창에 합친다 (FR-CAC-93).
    pub fn apply_status_line(
        &mut self,
        oauth: Option<&Usage>,
        sl: &Usage,
        sl_at: i64,
        last_switch: i64,
        now: i64,
    ) {
        self.status_line = Some(status_line_view_of(sl, sl_at, now));
        let Some(usage) = self.usage.as_mut() else {
            return;
        };
        if sl_at < last_switch + STATUS_LINE_GRACE_S {
            return;
        }
        let (o5, o7) = oauth.map_or((None, None), |o| (o.five_hour, o.seven_day));
        let (m5, m7) = (
            merge_window(o5, sl.five_hour, now),
            merge_window(o7, sl.seven_day, now),
        );
        if m5.is_none() && m7.is_none() {
            return;
        }
        let w = usage.windows.get_or_insert_with(WindowsView::default);
        if let Some(m) = m5 {
            w.five_hour = Some(window_view(m, now));
        }
        if let Some(m) = m7 {
            w.seven_day = Some(window_view(m, now));
        }
    }
}
