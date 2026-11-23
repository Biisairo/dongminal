//! 수동·전략 전환 (FR-CAC-31). 판단에는 신선한 사용량만 쓴다.

use std::collections::HashSet;

use crate::engine::Engine;
use crate::error::{Error, Sentinel};
use crate::history::{
    BY_DMCTL, BY_UI, HistoryEntry, TRIGGER_BEST, TRIGGER_MANUAL, TRIGGER_NEXT,
    TRIGGER_NEXT_AVAILABLE, append_history,
};
use crate::policy::FRESH_FOR_DECISION_S;
use crate::service::SwitchResult;
use crate::store::{Account, State};
use crate::usage::{Models, Usage, Window};

/// 전환 전략 (FR-CAC-31).
pub const STRATEGY_NEXT: &str = "next";
pub const STRATEGY_NEXT_AVAILABLE: &str = "next-available";
pub const STRATEGY_BEST: &str = "best";

/// 모든 모델을 판단에 넣는다는 표시다.
pub const MODELS_ALL: &str = "all";

/// `best` 가 전환하지 않은 이유 (FR-CAC-31a).
pub const REASON_NONE: &str = "none";
pub const REASON_CURRENT_UNAVAILABLE: &str = "current-unavailable";
pub const REASON_NO_COMPARISON: &str = "no-comparison";
pub const REASON_EXHAUSTED: &str = "exhausted";
pub const REASON_STAY: &str = "stay";

/// statusLine 관측을 전환 직후 이만큼은 믿지 않는다(이전 계정의 값일 수 있다).
pub(crate) const STATUS_LINE_GRACE_S: i64 = 60;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SwitchRequest {
    pub id: String,
    pub strategy: String,
    pub by: String,
}

/// 모델 이름 목록을 판단용 집합으로. `all` 이 있으면 `None`(모두)이다.
pub(crate) fn model_set(models: &[String]) -> Models {
    let mut set = HashSet::new();
    for m in models {
        if m.eq_ignore_ascii_case(MODELS_ALL) {
            return None;
        }
        set.insert(m.clone());
    }
    Some(set)
}

/// OAuth 창과 statusLine 창 중 판단에 쓸 것이다. 지난 창은 버린다. 초기화 시각이 크게
/// 다르면 더 나중 것을, 아니면 사용률이 높은 것을 고른다.
pub(crate) fn merge_window(oauth: Option<Window>, sl: Option<Window>, now: i64) -> Option<Window> {
    let live = |w: Option<Window>| w.filter(|w| !(w.resets_at > 0 && w.resets_at <= now));
    match (live(oauth), live(sl)) {
        (None, s) => s,
        (o, None) => o,
        (Some(o), Some(s))
            if o.resets_at > 0
                && s.resets_at > 0
                && (o.resets_at - s.resets_at).abs() > FRESH_FOR_DECISION_S =>
        {
            Some(if s.resets_at > o.resets_at { s } else { o })
        }
        (Some(o), Some(s)) => Some(if s.pct > o.pct { s } else { o }),
    }
}

pub(crate) fn account_by_id(st: &State, id: &str) -> Account {
    st.find(id).map_or_else(
        || Account {
            id: id.to_owned(),
            ..Account::default()
        },
        |i| st.accounts[i].clone(),
    )
}

impl Engine {
    pub(crate) fn models(&self) -> Models {
        match &self.models {
            None => Some(HashSet::new()),
            Some(f) => model_set(&f()),
        }
    }

    /// 마지막 전환 시각(unix 초)이다.
    pub fn last_switch_at(&self) -> i64 {
        self.lock().last_switch_at
    }

    /// 판단에 쓸 사용량: 신선한 OAuth 값과 statusLine 값을 합친 것이다.
    pub(crate) fn decision_usage(&self, a: &Account) -> Option<Usage> {
        let now = self.now_unix();
        let r = self.row(&a.id);
        let oauth = r
            .last_good
            .filter(|_| now - r.fetched_at <= FRESH_FOR_DECISION_S);
        let sl = self
            .status_line
            .as_ref()
            .and_then(|f| f(a))
            .filter(|(_, at)| {
                now - at <= FRESH_FOR_DECISION_S
                    && *at >= self.last_switch_at() + STATUS_LINE_GRACE_S
            });
        if oauth.is_none() && sl.is_none() {
            return None;
        }
        let mut out = oauth.unwrap_or_default();
        let sl = sl.map(|(u, _)| u).unwrap_or_default();
        out.five_hour = merge_window(out.five_hour, sl.five_hour, now);
        out.seven_day = merge_window(out.seven_day, sl.seven_day, now);
        if out.five_hour.is_none() && out.seven_day.is_none() && out.scoped.is_empty() {
            return None;
        }
        Some(out)
    }

    pub(crate) fn fresh_headroom(&self, a: &Account, models: &Models) -> Option<f64> {
        self.decision_usage(a).map(|u| u.headroom(models))
    }

    /// 판단할 값이 없는 계정을 조회한다. 물러나는 중이거나 조금 전에 본 계정은 건너뛴다.
    async fn refresh_stale(&self, st: &State) {
        let _busy = self.busy.lock().await;
        let _round = self.begin_round();
        let ctx = tokio_util::sync::CancellationToken::new();
        let mut first = true;
        for a in &st.accounts {
            if a.disabled && a.id != st.active_id {
                continue;
            }
            if self.fresh_headroom(a, &None).is_some() {
                continue;
            }
            let r = self.row(&a.id);
            let now = self.now_unix();
            if !r.auth_dead_fp.is_empty()
                || r.backoff_until > now
                || (r.last_attempt_at > 0
                    && now - r.last_attempt_at < crate::policy::FETCH_NOW_MIN_GAP_S)
            {
                continue;
            }
            if !first && !self.pause(&ctx).await {
                return;
            }
            first = false;
            self.fetch(a, a.id == st.active_id, false).await;
        }
    }

    /// 수동 전환이다: id 로, 또는 전략으로 (FR-CAC-31).
    pub async fn switch(&self, req: &SwitchRequest) -> Result<SwitchResult, Error> {
        let by = if req.by.is_empty() {
            BY_UI
        } else {
            req.by.as_str()
        };
        if by != BY_UI && by != BY_DMCTL {
            return Err(Error::with_detail(
                Sentinel::Invalid,
                format!("by {}", dm_gocompat::strconv::quote(&req.by)),
            ));
        }
        if !req.id.is_empty() {
            return self.switch_to(&req.id, TRIGGER_MANUAL, by).await;
        }
        let st = self.svc.store.load()?;
        match req.strategy.as_str() {
            STRATEGY_NEXT => {
                let id = st
                    .next_after(|_| true)
                    .ok_or(Error::from(Sentinel::NoCandidate))?;
                self.switch_to(&id, TRIGGER_NEXT, by).await
            }
            STRATEGY_NEXT_AVAILABLE => {
                self.refresh_stale(&st).await;
                let models = self.models();
                let id = st
                    .next_after(|a| self.fresh_headroom(a, &models).is_some_and(|h| h > 0.0))
                    .ok_or(Error::from(Sentinel::NoCandidate))?;
                self.switch_to(&id, TRIGGER_NEXT_AVAILABLE, by).await
            }
            STRATEGY_BEST => {
                self.refresh_stale(&st).await;
                match self.pick_best(&st) {
                    Ok(id) => self.switch_to(&id, TRIGGER_BEST, by).await,
                    Err(reason) => Ok(SwitchResult {
                        from: st.active_id.clone(),
                        to: st.active_id.clone(),
                        no_op: true,
                        reason: reason.to_owned(),
                        ..SwitchResult::default()
                    }),
                }
            }
            _ => Err(Error::with_detail(
                Sentinel::Invalid,
                "id 또는 strategy 가 필요합니다",
            )),
        }
    }

    /// 헤드룸이 가장 큰 다른 계정이다. 옮기지 않으면 그 이유다 (FR-CAC-31a).
    pub(crate) fn pick_best(&self, st: &State) -> Result<String, &'static str> {
        let models = self.models();
        let others: Vec<&Account> = st
            .accounts
            .iter()
            .filter(|a| a.id != st.active_id && !a.disabled)
            .collect();
        if others.is_empty() {
            return Err(REASON_NONE);
        }
        let Some(cur) = self.fresh_headroom(&account_by_id(st, &st.active_id), &models) else {
            return Err(REASON_CURRENT_UNAVAILABLE);
        };
        let mut best: Option<(&str, f64)> = None;
        for a in others {
            if let Some(h) = self.fresh_headroom(a, &models)
                && best.is_none_or(|(_, b)| h > b)
            {
                best = Some((&a.id, h));
            }
        }
        match best {
            None => Err(REASON_NO_COMPARISON),
            Some((id, h)) if h > cur => Ok(id.to_owned()),
            _ if cur <= 0.0 => Err(REASON_EXHAUSTED),
            _ => Err(REASON_STAY),
        }
    }

    /// 전환하고 기록을 남긴다 (FR-CAC-110).
    pub(crate) async fn switch_to(
        &self,
        id: &str,
        trigger: &str,
        by: &str,
    ) -> Result<SwitchResult, Error> {
        let st = self.svc.store.load()?;
        let models = self.models();
        let from = self.fresh_headroom(&account_by_id(&st, &st.active_id), &models);
        let to = self.fresh_headroom(&account_by_id(&st, id), &models);
        let res = self.svc.switch(id).await?;
        if res.no_op {
            return Ok(res);
        }
        let now = self.now_unix();
        self.lock().last_switch_at = now;
        let h = HistoryEntry {
            at: now,
            from: res.from.clone(),
            to: res.to.clone(),
            trigger: trigger.to_owned(),
            headroom_from: from,
            headroom_to: to,
            by: by.to_owned(),
        };
        if let Err(e) = append_history(&self.svc.dir, &h) {
            dm_shared_dmlog::infof!(None, "claude-accounts: 전환 기록 실패: {e}");
        }
        Ok(res)
    }
}
