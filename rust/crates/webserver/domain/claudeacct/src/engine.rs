//! 사용량 조회 엔진 (FR-CAC-50~65). 계정마다 조회 주기·물러나기·토큰 갱신을 관리하고 usage.json
//! 에 남긴다.

use std::collections::{BTreeMap, HashMap};
use std::io;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use futures_util::future::BoxFuture;
use otter_gocompat::json::{self, is_empty};
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use tokio_util::sync::CancellationToken;

use crate::client::{Client, TokenResult};
use crate::creds::{Credential, unix_millis};
use crate::dirlock::lock_claude;
use crate::error::{Error, Sentinel};
use crate::history::read_history;
use crate::policy::{
    CANDIDATE_DEFAULT_S, DEFAULT_LINE_PCT, EXHAUSTED_S, FETCH_NOW_MIN_GAP_S, PlanInput,
    backoff_seconds, plan_interval, plan_next,
};
use crate::resets::{
    ClaimResult, GRANT_ID_RE, PROGRAM_CEDAR, PROGRAM_JUNIPER, QUERY_CEDAR, QUERY_JUNIPER,
    REQUEST_ID_RE, Resets, claim_result_of, parse_cedar, parse_juniper,
};
use crate::service::{Clock, Service};
use crate::store::{Account, State};
use crate::usage::{Usage, parse_usage};
use crate::waker::Waker;
use crate::{DIR_MODE, FILE_MODE, fsutil};

const USAGE_FILE: &str = "usage.json";
const USAGE_SCHEMA: i64 = 1;
/// 한 회차 안에서 계정 사이에 두는 틈이다.
const FETCH_STAGGER: Duration = Duration::from_millis(250);
/// 활성 계정의 토큰 갱신 시한이다.
const ACTIVE_REFRESH_T: Duration = Duration::from_secs(6);
/// 할 일이 없을 때 다시 보는 간격이다.
const IDLE_WAKE: time::Duration = time::Duration::minutes(5);
/// 회차 사이의 최소 간격이다.
const ROUND_FLOOR: Duration = Duration::from_secs(1);

/// 행의 상태 (FR-CAC-55).
pub const STATUS_OK: &str = "ok";
pub const STATUS_TOKEN_EXPIRED: &str = "token_expired";
pub const STATUS_RELOGIN_REQUIRED: &str = "relogin_required";
pub const STATUS_KEYCHAIN_UNAVAILABLE: &str = "keychain_unavailable";
pub const STATUS_NO_CREDENTIALS: &str = "no_credentials";
pub const STATUS_RATE_LIMITED: &str = "rate_limited";
pub const STATUS_UNAVAILABLE: &str = "unavailable";

/// 사용 요청의 본문이다.
pub type ClaimBody = BTreeMap<String, serde_json::Value>;

/// 엔진이 부르는 Anthropic API 다. 시험은 가짜로 바꾼다.
pub trait UsageApi: Send + Sync {
    fn usage_raw<'a>(
        &'a self,
        token: &'a str,
        query: &'a str,
    ) -> BoxFuture<'a, Result<Vec<u8>, Error>>;
    fn refresh<'a>(&'a self, refresh_token: &'a str) -> BoxFuture<'a, Result<TokenResult, Error>>;
    /// 상태 오류여도 본문을 함께 준다.
    fn claim_reset<'a>(
        &'a self,
        token: &'a str,
        org: &'a str,
        body: &'a ClaimBody,
    ) -> BoxFuture<'a, (Vec<u8>, Result<(), Error>)>;
}

impl UsageApi for Client {
    fn usage_raw<'a>(
        &'a self,
        token: &'a str,
        query: &'a str,
    ) -> BoxFuture<'a, Result<Vec<u8>, Error>> {
        Box::pin(Client::usage_raw(self, token, query))
    }
    fn refresh<'a>(&'a self, refresh_token: &'a str) -> BoxFuture<'a, Result<TokenResult, Error>> {
        Box::pin(Client::refresh(self, refresh_token))
    }
    fn claim_reset<'a>(
        &'a self,
        token: &'a str,
        org: &'a str,
        body: &'a ClaimBody,
    ) -> BoxFuture<'a, (Vec<u8>, Result<(), Error>)> {
        Box::pin(Client::claim_reset(self, token, org, body))
    }
}

/// 한 계정의 조회 기록이다 (usage.json 의 한 행).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename = "claudeacct.Row")]
pub struct Row {
    #[serde(rename = "lastGood", skip_serializing_if = "is_empty")]
    pub last_good: Option<Usage>,
    #[serde(rename = "fetchedAt", skip_serializing_if = "is_empty")]
    pub fetched_at: i64,
    #[serde(rename = "lastAttemptAt", skip_serializing_if = "is_empty")]
    pub last_attempt_at: i64,
    #[serde(rename = "consecutiveFailures", skip_serializing_if = "is_empty")]
    pub consecutive_failures: i64,
    #[serde(rename = "lastError", skip_serializing_if = "is_empty")]
    pub last_error: String,
    #[serde(rename = "backoffUntil", skip_serializing_if = "is_empty")]
    pub backoff_until: i64,
    #[serde(rename = "nextPollAt", skip_serializing_if = "is_empty")]
    pub next_poll_at: i64,
    #[serde(rename = "pollIntervalS", skip_serializing_if = "is_empty")]
    pub poll_interval_s: i64,
    #[serde(rename = "last429At", skip_serializing_if = "is_empty")]
    pub last429_at: i64,
    #[serde(rename = "authDeadFp", skip_serializing_if = "is_empty")]
    pub auth_dead_fp: String,
    #[serde(rename = "loginExpiresAt", skip_serializing_if = "is_empty")]
    pub login_expires_at: i64,
    #[serde(skip_serializing_if = "is_empty")]
    pub status: String,
    /// 성공한 조회 수다. 자동 전환의 "한 번은 봤다" 판정이 쓴다.
    #[serde(rename = "usageOk", skip_serializing_if = "is_empty")]
    pub usage_ok: i64,
    #[serde(skip_serializing_if = "is_empty")]
    pub resets: Option<Resets>,
    #[serde(rename = "resetsAttemptAt", skip_serializing_if = "is_empty")]
    pub resets_attempt_at: i64,
}

impl Row {
    pub(crate) fn due_at(&self) -> i64 {
        self.next_poll_at.max(self.backoff_until)
    }
}

#[derive(Serialize)]
struct UsageFileOut<'a> {
    accounts: &'a BTreeMap<String, Row>,
    #[serde(rename = "schemaVersion")]
    schema_version: i64,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct UsageFileIn {
    accounts: Option<BTreeMap<String, Row>>,
}

pub type JitterFn = Arc<dyn Fn() -> f64 + Send + Sync>;
pub type LineForFn = Arc<dyn Fn(&Account) -> f64 + Send + Sync>;
/// statusLine 이 본 사용량과 그 시각(unix 초). 없으면 `None`.
pub type StatusLineFn = Arc<dyn Fn(&Account) -> Option<(Usage, i64)> + Send + Sync>;
pub type ModelsFn = Arc<dyn Fn() -> Vec<String> + Send + Sync>;
pub type OnChangeFn = Arc<dyn Fn() + Send + Sync>;

#[derive(Default)]
pub(crate) struct Inner {
    pub(crate) rows: BTreeMap<String, Row>,
    /// 응답을 받지 못한 티켓 사용의 request_id 다. 다시 시도할 때 같은 값을 보낸다 (FR-CAC-63).
    unsettled: HashMap<String, String>,
    pub(crate) last_switch_at: i64,
    defer_save: bool,
    dirty: bool,
}

pub struct Engine {
    pub svc: Arc<Service>,
    pub api: Arc<dyn UsageApi>,
    pub now: Clock,
    /// [-1, 1] 의 흔들기. 비면 무작위다.
    pub jitter: Option<JitterFn>,
    /// 계정의 라인(%). 비면 계정 문턱값, 그것도 없으면 90 이다.
    pub line_for: Option<LineForFn>,
    pub status_line: Option<StatusLineFn>,
    /// 판단에 넣을 모델 이름. 비면 scoped 창을 넣지 않는다.
    pub models: Option<ModelsFn>,
    pub on_change: Option<OnChangeFn>,
    /// 0 이면 250ms.
    pub stagger: Duration,
    pub(crate) inner: Mutex<Inner>,
    pub(crate) busy: tokio::sync::Mutex<()>,
    wake: Waker,
    /// usage.json 을 쓴 횟수. 시험이 회차당 쓰기 수를 센다 (GD-23).
    writes: AtomicU64,
}

/// 회차 동안 usage.json 쓰기를 미루고, 끝에 한 번만 쓴다 (GD-23).
pub(crate) struct Round<'a>(&'a Engine);

impl Drop for Round<'_> {
    fn drop(&mut self) {
        let mut g = self.0.lock();
        g.defer_save = false;
        if g.dirty {
            g.dirty = false;
            self.0.save_locked(&g);
        }
    }
}

/// 토큰을 고를 때의 결과: 자격증명, 쓸 수 있는가, 활성 저장소의 것인가, 읽기 오류.
struct CredFor {
    cred: Credential,
    ok: bool,
    live: bool,
    err: Option<Error>,
}

impl Engine {
    pub fn new(svc: Arc<Service>, api: Arc<dyn UsageApi>, now: Clock) -> Self {
        Self {
            svc,
            api,
            now,
            jitter: None,
            line_for: None,
            status_line: None,
            models: None,
            on_change: None,
            stagger: Duration::ZERO,
            inner: Mutex::new(Inner::default()),
            busy: tokio::sync::Mutex::new(()),
            wake: Waker::default(),
            writes: AtomicU64::new(0),
        }
    }

    pub(crate) fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub(crate) fn now_unix(&self) -> i64 {
        (self.now)().unix_timestamp()
    }

    #[cfg(test)]
    pub(crate) fn writes(&self) -> u64 {
        self.writes.load(Ordering::Relaxed)
    }

    fn path(&self) -> PathBuf {
        self.svc.dir.join(USAGE_FILE)
    }

    /// usage.json 과 마지막 전환 시각을 읽는다. 깨진 파일은 비우고 시작한다.
    pub fn load(&self) -> Result<(), Error> {
        let mut g = self.lock();
        g.rows.clear();
        let b = match fsutil::read_file(&self.path()) {
            Ok(b) => b,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(e.into()),
        };
        let Ok(f) = json::unmarshal::<UsageFileIn>(&b) else {
            otter_shared_otterlog::infof!(
                None,
                "claude-accounts: {USAGE_FILE} 가 깨졌다 — 비우고 시작한다"
            );
            return Ok(());
        };
        if let Some(rows) = f.accounts {
            g.rows = rows;
        }
        if let Ok(h) = read_history(&self.svc.dir, 1)
            && let Some(last) = h.first()
        {
            g.last_switch_at = last.at;
        }
        Ok(())
    }

    /// 계정별 행의 사본이다.
    pub fn rows(&self) -> BTreeMap<String, Row> {
        self.lock().rows.clone()
    }

    fn save_locked(&self, g: &Inner) {
        let out = UsageFileOut {
            accounts: &g.rows,
            schema_version: USAGE_SCHEMA,
        };
        let Ok(b) = json::marshal_indent(&out, "", "  ") else {
            return;
        };
        if fsutil::mkdir_all(&self.svc.dir, DIR_MODE).is_err() {
            return;
        }
        self.writes.fetch_add(1, Ordering::Relaxed);
        if let Err(e) = otter_shared_platform::write_file_atomic(&self.path(), &b, FILE_MODE) {
            otter_shared_otterlog::infof!(
                None,
                "claude-accounts: {USAGE_FILE} 를 쓰지 못했다: {}",
                otter_gocompat::oserr::go_error_string(&e)
            );
        }
    }

    fn persist_locked(&self, g: &mut Inner) {
        if g.defer_save {
            g.dirty = true;
            return;
        }
        self.save_locked(g);
    }

    pub(crate) fn begin_round(&self) -> Round<'_> {
        self.lock().defer_save = true;
        Round(self)
    }

    pub(crate) fn set_row(&self, id: &str, r: Row) {
        {
            let mut g = self.lock();
            g.rows.insert(id.to_owned(), r);
            self.persist_locked(&mut g);
        }
        if let Some(f) = &self.on_change {
            f();
        }
    }

    pub(crate) fn row(&self, id: &str) -> Row {
        self.lock().rows.get(id).cloned().unwrap_or_default()
    }

    pub(crate) fn jitter(&self) -> f64 {
        match &self.jitter {
            Some(f) => f(),
            None => rand::random::<f64>() * 2.0 - 1.0,
        }
    }

    pub(crate) fn line_for(&self, a: &Account) -> f64 {
        match &self.line_for {
            Some(f) => f(a),
            None => a.threshold.unwrap_or(DEFAULT_LINE_PCT),
        }
    }

    pub(crate) fn live_is_account(&self, a: &Account) -> bool {
        matches!(
            crate::claudecfg::read_oauth_account(&self.svc.claude.global_config),
            Ok(Some(oa)) if oa.email_address == a.email && oa.organization_uuid == a.org_uuid
        )
    }

    /// 조회할 때가 된 계정을 차례로 조회하고 다음에 깰 시각을 돌려준다 (FR-CAC-53).
    pub async fn tick(&self, ctx: &CancellationToken) -> OffsetDateTime {
        let _busy = self.busy.lock().await;
        let _round = self.begin_round();
        let Ok(st) = self.svc.store.load() else {
            return (self.now)() + IDLE_WAKE;
        };
        let (st, changed) = match self.svc.sync_active_from(st.clone()) {
            Ok(r) => r,
            Err((changed, _)) => (st, changed),
        };
        if changed && let Some(f) = &self.on_change {
            f(); // FR-CAC-34b
        }
        self.drop_removed(&st);
        let mut first = true;
        for a in &st.accounts {
            let r = self.row(&a.id);
            if !r.auth_dead_fp.is_empty() && !self.dead_cleared(a, r) {
                continue;
            }
            if self.row(&a.id).due_at() > self.now_unix() {
                continue;
            }
            if !first && !self.pause(ctx).await {
                break;
            }
            first = false;
            self.fetch(a, a.id == st.active_id, false).await;
        }
        self.next_wake()
    }

    pub(crate) async fn pause(&self, ctx: &CancellationToken) -> bool {
        let d = if self.stagger.is_zero() {
            FETCH_STAGGER
        } else {
            self.stagger
        };
        tokio::select! {
            _ = ctx.cancelled() => false,
            _ = tokio::time::sleep(d) => true,
        }
    }

    fn drop_removed(&self, st: &State) {
        let mut g = self.lock();
        let before = g.rows.len();
        g.rows.retain(|id, _| st.find(id).is_some());
        if g.rows.len() != before {
            self.persist_locked(&mut g);
        }
    }

    /// 다시 로그인해 백업이 바뀌었으면 막힘을 푼다.
    fn dead_cleared(&self, a: &Account, mut r: Row) -> bool {
        match self.svc.backup.read(&a.id) {
            Ok(Some(c)) if c.fingerprint() != r.auth_dead_fp => {}
            _ => return false,
        }
        r.auth_dead_fp.clear();
        r.next_poll_at = 0;
        r.backoff_until = 0;
        r.consecutive_failures = 0;
        self.set_row(&a.id, r);
        true
    }

    fn next_wake(&self) -> OffsetDateTime {
        let g = self.lock();
        let mut next = (self.now)() + IDLE_WAKE;
        for r in g.rows.values() {
            if !r.auth_dead_fp.is_empty() {
                continue;
            }
            if let Ok(t) = OffsetDateTime::from_unix_timestamp(r.due_at())
                && t < next
            {
                next = t;
            }
        }
        next
    }

    /// 계정 하나를 지금 조회한다. 조금 전에 조회했거나 물러나는 중이면 [`Error`] TooSoon 이다
    /// (FR-CAC-56).
    pub async fn fetch_now(&self, id: &str) -> Result<(), Error> {
        let _busy = self.busy.lock().await;
        let st = self.svc.store.load()?;
        let i = st.find(id).ok_or(Error::from(Sentinel::NotFound))?;
        let r = self.row(id);
        let now = self.now_unix();
        if r.backoff_until > now
            || (r.last_attempt_at > 0 && now - r.last_attempt_at < FETCH_NOW_MIN_GAP_S)
        {
            return Err(Sentinel::TooSoon.into());
        }
        self.fetch(&st.accounts[i], id == st.active_id, true).await;
        Ok(())
    }

    fn cred_for(&self, a: &Account, active: bool) -> CredFor {
        if active
            && self.live_is_account(a)
            && let Ok(Some(c)) = self.svc.live.read()
            && !c.is_empty()
        {
            return CredFor {
                cred: c,
                ok: true,
                live: true,
                err: None,
            };
        }
        match self.svc.backup.read(&a.id) {
            Ok(Some(c)) => CredFor {
                ok: !c.is_empty(),
                cred: c,
                live: false,
                err: None,
            },
            Ok(None) => CredFor {
                cred: Credential::default(),
                ok: false,
                live: false,
                err: None,
            },
            Err(e) => CredFor {
                cred: Credential::default(),
                ok: false,
                live: false,
                err: Some(e),
            },
        }
    }

    pub(crate) async fn fetch(&self, a: &Account, active: bool, with_resets: bool) {
        let now = (self.now)();
        let mut r = self.row(&a.id);
        r.last_attempt_at = now.unix_timestamp();
        self.svc.reclaim_profile(a);
        let cf = self.cred_for(a, active);
        if cf.err.is_some() {
            self.fail(&a.id, r, STATUS_KEYCHAIN_UNAVAILABLE, 0, "");
            return;
        }
        if !cf.ok {
            r.status = STATUS_NO_CREDENTIALS.to_owned();
            r.next_poll_at = now.unix_timestamp() + EXHAUSTED_S;
            self.set_row(&a.id, r);
            return;
        }
        let (mut cred, live) = (cf.cred, cf.live);
        r.login_expires_at = cred.refresh_token_expires_at() / 1000;
        if cred.expired(unix_millis(now)) {
            match self.refresh(a, live, false).await {
                Ok(c) => cred = c,
                Err((c, e)) => return self.refresh_failed(&a.id, r, &c, &e),
            }
        }
        let mut res = self.api.usage_raw(&cred.access_token(), "").await;
        if matches!(&res, Err(e) if e.http_status().is_some_and(|s| s.status == 401)) {
            match self.refresh(a, live, true).await {
                Ok(c) => cred = c,
                Err((c, e)) => return self.refresh_failed(&a.id, r, &c, &e),
            }
            res = self.api.usage_raw(&cred.access_token(), "").await;
        }
        let raw = match res {
            Ok(raw) => raw,
            Err(e) => {
                let (status, ra) = e
                    .http_status()
                    .map(|s| (s.status, s.retry_after.clone()))
                    .unwrap_or_default();
                let st = if status == 429 {
                    STATUS_RATE_LIMITED
                } else {
                    STATUS_UNAVAILABLE
                };
                return self.fail(&a.id, r, st, status, &ra);
            }
        };
        let Ok(u) = parse_usage(&raw) else {
            return self.fail(&a.id, r, STATUS_UNAVAILABLE, 0, "");
        };
        r.login_expires_at = cred.refresh_token_expires_at() / 1000;
        let prev = r.last_good.take();
        let mut inp = PlanInput {
            now: now.unix_timestamp(),
            prev_interval: r.poll_interval_s,
            prev: prev.as_ref(),
            next: Some(&u),
            active,
            line: self.line_for(a),
            last429: r.last429_at,
        };
        if inp.prev_interval == 0 {
            inp.prev_interval = CANDIDATE_DEFAULT_S;
        }
        let j = self.jitter();
        r.poll_interval_s = plan_interval(&inp, j);
        r.next_poll_at = plan_next(&inp, j);
        r.fetched_at = now.unix_timestamp();
        r.last_good = Some(u);
        r.consecutive_failures = 0;
        r.last_error.clear();
        r.backoff_until = 0;
        r.status = STATUS_OK.to_owned();
        r.usage_ok += 1;
        if with_resets {
            r.resets = Some(
                self.fetch_resets(&cred.access_token(), r.resets.take())
                    .await,
            );
            r.resets_attempt_at = now.unix_timestamp();
        }
        self.set_row(&a.id, r);
    }

    pub(crate) async fn fetch_resets(&self, token: &str, prev: Option<Resets>) -> Resets {
        let mut out = Resets {
            fetched_at: self.now_unix(),
            ..Resets::default()
        };
        if let Some(p) = prev {
            out.juniper = p.juniper;
            out.cedar = p.cedar;
        }
        if let Ok(raw) = self.api.usage_raw(token, QUERY_JUNIPER).await {
            out.juniper = parse_juniper(&raw);
        }
        if let Ok(raw) = self.api.usage_raw(token, QUERY_CEDAR).await {
            out.cedar = parse_cedar(&raw);
        }
        out
    }

    /// 쓸 수 있는 토큰. 두 번째 값은 활성 저장소의 것인가다.
    async fn usable_cred(&self, a: &Account, active: bool) -> (Result<Credential, Error>, bool) {
        let cf = self.cred_for(a, active);
        if let Some(e) = cf.err {
            return (Err(e), cf.live);
        }
        if !cf.ok {
            return (Err(Sentinel::LiveEmpty.into()), cf.live);
        }
        if cf.cred.expired(unix_millis((self.now)())) {
            return (
                self.refresh(a, cf.live, false).await.map_err(|(_, e)| e),
                cf.live,
            );
        }
        (Ok(cf.cred), cf.live)
    }

    /// 계정의 제한 초기화 상태를 지금 다시 읽는다 (FR-CAC-61).
    pub async fn fetch_resets_now(&self, id: &str) -> Result<(), Error> {
        let st = self.svc.store.load()?;
        let i = st.find(id).ok_or(Error::from(Sentinel::NotFound))?;
        let r = self.row(id);
        let now = self.now_unix();
        if r.backoff_until > now
            || (r.resets_attempt_at > 0 && now - r.resets_attempt_at < FETCH_NOW_MIN_GAP_S)
        {
            return Err(Sentinel::TooSoon.into());
        }
        let _busy = self.busy.lock().await;
        let cred = self
            .usable_cred(&st.accounts[i], id == st.active_id)
            .await
            .0?;
        let mut r = self.row(id);
        r.resets = Some(
            self.fetch_resets(&cred.access_token(), r.resets.take())
                .await,
        );
        r.resets_attempt_at = now;
        self.set_row(id, r);
        Ok(())
    }

    /// 제한 초기화를 쓴다 (FR-CAC-62·63). 인증 실패는 오류가 아니라 `auth_error` 결과다.
    pub async fn claim(
        &self,
        id: &str,
        program: &str,
        grant_id: &str,
    ) -> Result<ClaimResult, Error> {
        let ok = (program == PROGRAM_JUNIPER && grant_id.is_empty())
            || (program == PROGRAM_CEDAR && GRANT_ID_RE.is_match(grant_id));
        if !ok {
            return Err(Error::with_detail(
                Sentinel::Invalid,
                format!(
                    "프로그램 {} 와 티켓 {} 가 맞지 않습니다",
                    otter_gocompat::strconv::quote(program),
                    otter_gocompat::strconv::quote(grant_id)
                ),
            ));
        }
        let st = self.svc.store.load()?;
        let i = st.find(id).ok_or(Error::from(Sentinel::NotFound))?;
        let (a, active) = (st.accounts[i].clone(), id == st.active_id);
        let _busy = self.busy.lock().await;
        let auth_error = || ClaimResult {
            result: "auth_error".to_owned(),
            ..ClaimResult::default()
        };
        let (cred, live) = match self.usable_cred(&a, active).await {
            (Ok(c), live) => (c, live),
            (Err(_), _) => return Ok(auth_error()),
        };
        let mut cred = cred;
        let mut body = ClaimBody::from([("program".to_owned(), program.into())]);
        let key = format!("{id}\x00{grant_id}");
        if program == PROGRAM_CEDAR {
            let mut req = self.lock().unsettled.get(&key).cloned().unwrap_or_default();
            if !REQUEST_ID_RE.is_match(&req) {
                req = (self.svc.new_id)();
            }
            body.insert("grant_id".to_owned(), grant_id.into());
            body.insert("request_id".to_owned(), req.into());
        }
        let (mut raw, mut res) = self
            .api
            .claim_reset(&cred.access_token(), &a.org_uuid, &body)
            .await;
        if matches!(&res, Err(e) if e.http_status().is_some_and(|s| s.status == 401)) {
            match self.refresh(&a, live, true).await {
                Ok(c) => cred = c,
                Err(_) => return Ok(auth_error()),
            }
            (raw, res) = self
                .api
                .claim_reset(&cred.access_token(), &a.org_uuid, &body)
                .await;
        }
        let out = claim_result_of(program, &raw, res.as_ref().err());
        if program == PROGRAM_CEDAR {
            let mut g = self.lock();
            if out.result == "unconfirmed" {
                let req = body["request_id"].as_str().unwrap_or_default().to_owned();
                g.unsettled.insert(key, req);
            } else {
                g.unsettled.remove(&key);
            }
        }
        if out.result == "reset" {
            let now = self.now_unix();
            self.fetch(&a, active, true).await;
            let mut r = self.row(id);
            if r.resets_attempt_at != now {
                r.resets = Some(
                    self.fetch_resets(&cred.access_token(), r.resets.take())
                        .await,
                );
                r.resets_attempt_at = now;
                self.set_row(id, r);
            }
        }
        Ok(out)
    }

    fn fail(&self, id: &str, mut r: Row, status: &str, http_status: u16, retry_after: &str) {
        let now = self.now_unix();
        r.consecutive_failures += 1;
        r.backoff_until = now + backoff_seconds(r.consecutive_failures, http_status, retry_after);
        r.status = status.to_owned();
        r.last_error = status.to_owned();
        if http_status == 429 {
            r.last429_at = now;
        }
        self.set_row(id, r);
    }

    fn refresh_failed(&self, id: &str, mut r: Row, cred: &Credential, err: &Error) {
        if err.is(Sentinel::ReloginRequired) {
            r.auth_dead_fp = cred.fingerprint();
            r.status = STATUS_RELOGIN_REQUIRED.to_owned();
            r.last_error = STATUS_RELOGIN_REQUIRED.to_owned();
            self.set_row(id, r);
            return;
        }
        self.fail(id, r, STATUS_TOKEN_EXPIRED, 0, "");
    }

    /// 토큰을 갱신한다 (FR-CAC-40~44). 실패하면 그때의 자격증명과 오류를 준다.
    pub(crate) async fn refresh(
        &self,
        a: &Account,
        live: bool,
        force: bool,
    ) -> Result<Credential, (Credential, Error)> {
        let none = |e: Error| (Credential::default(), e);
        let empty =
            |c: Option<Credential>| (c.unwrap_or_default(), Error::from(Sentinel::LiveEmpty));
        if live {
            let _lock = lock_claude(&self.svc.claude, self.svc.lock_timeout()).map_err(none)?;
            let cur = match self.svc.live.read() {
                Ok(Some(c)) => c,
                _ => return Err(empty(None)),
            };
            if !force && !cur.expired(unix_millis((self.now)())) {
                return Ok(cur);
            }
            let tr = match tokio::time::timeout(
                ACTIVE_REFRESH_T,
                self.api.refresh(&cur.refresh_token()),
            )
            .await
            {
                Ok(Ok(tr)) => tr,
                Ok(Err(e)) => return Err((cur, e)),
                Err(_) => return Err((cur, Error::new("context deadline exceeded"))),
            };
            let next = cur.with_tokens(&tr, unix_millis((self.now)()));
            if let Err(e) = self.svc.live.write(&next) {
                return Err((cur, e));
            }
            if let Err(e) = self.svc.backup.write(&a.id, &next) {
                otter_shared_otterlog::infof!(
                    None,
                    "claude-accounts: 활성 계정 백업을 쓰지 못했다: {e}"
                );
            }
            return Ok(next);
        }
        if self.svc.pinned_running(&a.id) {
            return self.refresh_pinned(a, force).await;
        }
        let _lock = fsutil::lock_file(&self.svc.consume_lock(&a.id), self.svc.lock_timeout())
            .map_err(|e| none(Error::new(e.to_string())))?;
        let cur = match self.svc.backup.read(&a.id) {
            Ok(Some(c)) => c,
            _ => return Err(empty(None)),
        };
        if !force && !cur.expired(unix_millis((self.now)())) {
            return Ok(cur);
        }
        let tr = match self.api.refresh(&cur.refresh_token()).await {
            Ok(tr) => tr,
            Err(e) => return Err((cur, e)),
        };
        let next = cur.with_tokens(&tr, unix_millis((self.now)()));
        if let Err(e) = self.svc.backup.write(&a.id, &next) {
            return Err((cur, e));
        }
        Ok(next)
    }

    /// 프로필로 실행 중인 계정의 갱신: 프로필 저장소에 쓰고 백업도 맞춘다 (FR-CAC-86).
    async fn refresh_pinned(
        &self,
        a: &Account,
        force: bool,
    ) -> Result<Credential, (Credential, Error)> {
        let pl = self.svc.profile_live(&a.id);
        let _lock = lock_claude(&pl.paths, self.svc.lock_timeout())
            .map_err(|e| (Credential::default(), e))?;
        let cur = match pl.read() {
            Ok(Some(c)) if !c.is_empty() => c,
            _ => match self.svc.backup.read(&a.id) {
                Ok(Some(c)) => c,
                _ => return Err((Credential::default(), Sentinel::LiveEmpty.into())),
            },
        };
        if !force && !cur.expired(unix_millis((self.now)())) {
            return Ok(cur);
        }
        let tr = match self.api.refresh(&cur.refresh_token()).await {
            Ok(tr) => tr,
            Err(e) => return Err((cur, e)),
        };
        let next = cur.with_tokens(&tr, unix_millis((self.now)()));
        if let Err(e) = pl.write(&next) {
            return Err((cur, e));
        }
        if let Err(e) = self.svc.backup.write(&a.id, &next) {
            otter_shared_otterlog::infof!(
                None,
                "claude-accounts: 고정 계정 백업을 쓰지 못했다: {e}"
            );
        }
        Ok(next)
    }

    /// 기다리던 [`Engine::run`] 을 바로 깨운다.
    pub fn wake(&self) {
        self.wake.wake();
    }

    /// stop 이 끊길 때까지 회차를 돈다. 회차 사이는 최소 1초다.
    pub async fn run(&self, stop: CancellationToken) {
        self.wake
            .run(stop, ROUND_FLOOR, |ctx| async move {
                let next = self.tick(&ctx).await;
                (next - OffsetDateTime::now_utc())
                    .try_into()
                    .unwrap_or(Duration::ZERO)
            })
            .await;
    }
}
