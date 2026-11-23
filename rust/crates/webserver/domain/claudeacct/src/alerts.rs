//! 알림 (FR-CAC-100·100a·101). 이름은 표시 이름뿐이다 — 이메일·ID·토큰을 싣지 않는다.

use dm_gocompat::json::is_empty;
use dm_gocompat::time::{Zone, to_zone};
use serde::Serialize;
use time::OffsetDateTime;

use crate::auto::{AUTO_STRATEGY_PRIORITY_CONSUME_FIRST, Auto, AutoSettings, rank, rank_priority};
use crate::engine::STATUS_RELOGIN_REQUIRED;
use crate::history::TRIGGER_PROACTIVE;
use crate::resets::Resets;
use crate::store::State;
use crate::view::{LOGIN_WARN_S, display_name};

/// 알림 사건 (FR-CAC-100a).
pub const ALERT_AUTOSWITCH: &str = "autoswitch";
pub const ALERT_NEAR_LIMIT: &str = "near_limit";
pub const ALERT_ALL_EXHAUSTED: &str = "all_exhausted";
pub const ALERT_RELOGIN: &str = "relogin";
pub const ALERT_LOGIN_EXPIRING: &str = "login_expiring";
pub const ALERT_AUTOSWITCH_STOPPED: &str = "autoswitch_stopped";

/// 억제 키를 남겨 두는 시간(초)이다.
const ALERT_KEEP_S: i64 = 8 * 86400;

/// SSE `claude_account_alert` 의 본문이다.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct Alert {
    pub kind: String,
    #[serde(skip_serializing_if = "is_empty")]
    pub name: String,
    #[serde(skip_serializing_if = "is_empty")]
    pub from: String,
    #[serde(skip_serializing_if = "is_empty")]
    pub to: String,
    #[serde(skip_serializing_if = "is_empty")]
    pub trigger: String,
    #[serde(skip_serializing_if = "is_empty")]
    pub window: String,
    #[serde(rename = "resetsAt", skip_serializing_if = "is_empty")]
    pub resets_at: i64,
    #[serde(rename = "expiresAt", skip_serializing_if = "is_empty")]
    pub expires_at: i64,
    #[serde(rename = "resetAvailable", skip_serializing_if = "is_empty")]
    pub reset_available: bool,
}

/// unix 초의 로컬 날짜(`2006-01-02`).
fn local_day(unix: i64) -> String {
    local_day_in(unix, dm_gocompat::time::local())
}

/// `zone` 에서 본 unix 초의 날짜(`2006-01-02`). `time` 이 담지 못하는 시각은 빈 글이다.
pub(crate) fn local_day_in(unix: i64, zone: &Zone) -> String {
    OffsetDateTime::from_unix_timestamp(unix)
        .map(|t| {
            let t = to_zone(t, zone);
            format!("{:04}-{:02}-{:02}", t.year(), u8::from(t.month()), t.day())
        })
        .unwrap_or_default()
}

impl Alert {
    /// Telegram 으로 보낼 글이다 (FR-CAC-100a). 모르는 사건은 빈 글이다.
    pub fn text(&self) -> String {
        match self.kind.as_str() {
            ALERT_AUTOSWITCH => format!(
                "Claude 계정 자동 전환: {} → {} ({})",
                self.from, self.to, self.trigger
            ),
            ALERT_NEAR_LIMIT => format!(
                "Claude 계정 한도 임박: {} 의 {} 창이 라인에 닿았고 전환할 계정이 없습니다",
                self.name, self.window
            ),
            ALERT_ALL_EXHAUSTED if self.reset_available => {
                "Claude 계정: 모든 계정의 한도가 찼습니다 — 쓸 수 있는 제한 초기화가 있습니다"
                    .to_owned()
            }
            ALERT_ALL_EXHAUSTED => "Claude 계정: 모든 계정의 한도가 찼습니다".to_owned(),
            ALERT_RELOGIN => format!("Claude 계정 {}: 다시 로그인해야 합니다", self.name),
            ALERT_LOGIN_EXPIRING => format!(
                "Claude 계정 {}: 로그인 만료가 가까워졌습니다 ({})",
                self.name,
                local_day(self.expires_at)
            ),
            ALERT_AUTOSWITCH_STOPPED => {
                "Claude 계정 자동 전환을 껐습니다 — cswap auto 가 돌고 있습니다".to_owned()
            }
            _ => String::new(),
        }
    }
}

impl Auto {
    /// 억제 키가 없으면 기록하고 true 다 (FR-CAC-100a).
    fn once(&self, key: String) -> bool {
        let mut g = self.lock();
        if g.file_state().notified.contains_key(&key) {
            return false;
        }
        let now = self.now_unix();
        g.file_state().notified.insert(key, now);
        self.save_locked(&g);
        true
    }

    fn prune_notified(&self) {
        let mut g = self.lock();
        let cut = self.now_unix() - ALERT_KEEP_S;
        let n = g.file_state().notified.len();
        g.file_state().notified.retain(|_, at| *at >= cut);
        if g.file_state().notified.len() != n {
            self.save_locked(&g);
        }
    }

    /// 자동 전환이 꺼져 있어도 도는 알림 판정이다 (FR-CAC-100·100a). st 는 회차가 읽은
    /// accounts.json 이다 (GD-23).
    pub(crate) fn evaluate_alerts(&self, st: &State, s: &AutoSettings) {
        self.prune_notified();
        let now = self.now_unix();
        let models = crate::smart::model_set(s.models.as_deref().unwrap_or_default());
        for acc in &st.accounts {
            let r = self.eng.row(&acc.id);
            if r.status == STATUS_RELOGIN_REQUIRED
                && !r.auth_dead_fp.is_empty()
                && self.once(format!("relogin:{}:{}", acc.id, r.auth_dead_fp))
            {
                self.notify(Alert {
                    kind: ALERT_RELOGIN.to_owned(),
                    name: display_name(acc),
                    ..Alert::default()
                });
            }
            let exp = r.login_expires_at;
            if exp > 0
                && exp - now <= LOGIN_WARN_S
                && self.once(format!("expiring:{}:{}", acc.id, local_day(now)))
            {
                self.notify(Alert {
                    kind: ALERT_LOGIN_EXPIRING.to_owned(),
                    name: display_name(acc),
                    expires_at: exp,
                    ..Alert::default()
                });
            }
        }
        let Some(i) = st.find(&st.active_id) else {
            return;
        };
        let active = self.acct_view(&st.accounts[i], s, &models);
        if !active.known {
            return;
        }
        let mut exhausted = true;
        let mut usable = false;
        for acc in &st.accounts {
            usable = usable || Resets::usable(self.eng.row(&acc.id).resets.as_ref());
            if acc.disabled && acc.id != st.active_id {
                continue;
            }
            exhausted = exhausted
                && self
                    .eng
                    .fresh_headroom(acc, &models)
                    .is_some_and(|h| h <= 0.0);
        }
        if exhausted {
            if self.once(format!("exhausted:{}", active.b.resets_at)) {
                self.notify(Alert {
                    kind: ALERT_ALL_EXHAUSTED.to_owned(),
                    reset_available: usable,
                    ..Alert::default()
                });
            }
            return;
        }
        if !active.over() {
            return;
        }
        let cands = self.candidates(st, s, &models);
        let ranked = if s.strategy == AUTO_STRATEGY_PRIORITY_CONSUME_FIRST {
            rank_priority(&active, &cands)
        } else {
            rank(TRIGGER_PROACTIVE, s, &active, &cands, "")
        };
        if !ranked.is_empty() {
            return;
        }
        let key = format!(
            "near:{}:{}:{}",
            st.active_id, active.b.name, active.b.resets_at
        );
        if self.once(key) {
            self.notify(Alert {
                kind: ALERT_NEAR_LIMIT.to_owned(),
                name: display_name(&st.accounts[i]),
                window: active.b.name.clone(),
                resets_at: active.b.resets_at,
                ..Alert::default()
            });
        }
    }
}
