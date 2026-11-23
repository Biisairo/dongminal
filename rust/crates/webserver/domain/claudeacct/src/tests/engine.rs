//! engine_test·engine_round_test·engine_resets_test·engine_fetchnow_race_test, 그리고 profile_test 의
//! TestRefreshPinnedWritesProfileAndBackup.

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures_util::future::BoxFuture;
use tokio_util::sync::CancellationToken;

use super::service::{Env, clock_fn, new_env, write_session};
use crate::error::{Error, HttpStatusError, Sentinel};
use crate::resets::{QUERY_CEDAR, QUERY_JUNIPER};
use crate::*;

pub(crate) const NOW_UNIX: i64 = 1_800_000_000;

/// 사용 요청의 가짜 응답 하나.
#[derive(Clone)]
pub(crate) struct FakeClaim {
    pub(crate) body: &'static str,
    pub(crate) err: Option<&'static str>,
}

#[derive(Default)]
pub(crate) struct FakeUsageApi {
    pub(crate) usage: Mutex<HashMap<String, String>>,
    pub(crate) status: Mutex<HashMap<String, u16>>,
    pub(crate) refresh: Mutex<HashMap<String, TokenResult>>,
    pub(crate) refresh_err: Mutex<HashMap<String, Sentinel>>,
    pub(crate) calls: Mutex<Vec<String>>,
    pub(crate) by_query: Mutex<HashMap<String, String>>,
    pub(crate) claims: Mutex<Vec<FakeClaim>>,
    pub(crate) claim_body: Mutex<Vec<ClaimBody>>,
}

fn status_err(s: u16) -> Error {
    HttpStatusError {
        status: s,
        retry_after: String::new(),
    }
    .into()
}

impl FakeUsageApi {
    pub(crate) fn count(&self, prefix: &str) -> usize {
        self.calls
            .lock()
            .unwrap()
            .iter()
            .filter(|c| c.starts_with(prefix))
            .count()
    }
    pub(crate) fn set_usage(&self, token: &str, body: &str) {
        self.usage.lock().unwrap().insert(token.into(), body.into());
    }
    fn call(&self, s: String) {
        self.calls.lock().unwrap().push(s);
    }
}

impl UsageApi for FakeUsageApi {
    fn usage_raw<'a>(
        &'a self,
        token: &'a str,
        query: &'a str,
    ) -> BoxFuture<'a, Result<Vec<u8>, Error>> {
        let st = self.status.lock().unwrap().get(token).copied();
        let r = if !query.is_empty() {
            self.call(format!("status:{token}?{query}"));
            match st {
                Some(s) => Err(status_err(s)),
                None => Ok(self
                    .by_query
                    .lock()
                    .unwrap()
                    .get(query)
                    .cloned()
                    .unwrap_or("{}".into())
                    .into_bytes()),
            }
        } else {
            self.call(format!("usage:{token}"));
            match (st, self.usage.lock().unwrap().get(token)) {
                (Some(s), _) => Err(status_err(s)),
                (None, Some(b)) => Ok(b.clone().into_bytes()),
                (None, None) => Err(status_err(401)),
            }
        };
        Box::pin(async move { r })
    }
    fn refresh<'a>(&'a self, rt: &'a str) -> BoxFuture<'a, Result<TokenResult, Error>> {
        self.call(format!("refresh:{rt}"));
        let r = match self.refresh_err.lock().unwrap().get(rt) {
            Some(s) => Err(Error::from(*s)),
            None => self
                .refresh
                .lock()
                .unwrap()
                .get(rt)
                .cloned()
                .ok_or_else(|| Error::new("transient")),
        };
        Box::pin(async move { r })
    }
    fn claim_reset<'a>(
        &'a self,
        token: &'a str,
        org: &'a str,
        body: &'a ClaimBody,
    ) -> BoxFuture<'a, (Vec<u8>, Result<(), Error>)> {
        self.call(format!("claim:{token}:{org}"));
        self.claim_body.lock().unwrap().push(body.clone());
        let r = if let Some(s) = self.status.lock().unwrap().get(&format!("claim:{token}")) {
            (Vec::new(), Err(status_err(*s)))
        } else {
            let mut q = self.claims.lock().unwrap();
            if q.is_empty() {
                (br#"{"result":"reset"}"#.to_vec(), Ok(()))
            } else {
                let c = q.remove(0);
                (
                    c.body.as_bytes().to_vec(),
                    c.err.map_or(Ok(()), |e| Err(Error::new(e))),
                )
            }
        };
        Box::pin(async move { r })
    }
}

pub(crate) fn future_cred(access: &str, refresh: &str) -> String {
    format!(
        r#"{{"claudeAiOauth":{{"accessToken":"{access}","refreshToken":"{refresh}","expiresAt":{},"refreshTokenExpiresAt":{}}}}}"#,
        (NOW_UNIX + 3600) * 1000,
        (NOW_UNIX + 30 * 86400) * 1000
    )
}

pub(crate) fn expired_cred(access: &str, refresh: &str) -> String {
    format!(
        r#"{{"claudeAiOauth":{{"accessToken":"{access}","refreshToken":"{refresh}","expiresAt":{}}}}}"#,
        (NOW_UNIX - 10) * 1000
    )
}

impl Env {
    pub(crate) fn login_cred(&self, email: &str, org: &str, acc: &str, cred: &str) {
        self.sec.put(&self.paths.keychain_service, "tester", cred);
        let cfg = format!(
            r#"{{"oauthAccount":{{"emailAddress":"{email}","organizationUuid":"{org}","accountUuid":"{acc}"}}}}"#
        );
        std::fs::write(&self.paths.global_config, cfg).unwrap();
    }

    pub(crate) fn set(&self, t: i64) {
        self.clock.store(t, Ordering::SeqCst);
    }

    pub(crate) fn advance(&self, d: i64) {
        self.clock.fetch_add(d, Ordering::SeqCst);
    }
}

pub(crate) fn engine(e: &Env, api: &Arc<FakeUsageApi>) -> Engine {
    let mut eng = Engine::new(e.svc.clone(), api.clone(), clock_fn(&e.clock));
    eng.jitter = Some(Arc::new(|| 0.0));
    eng.load().unwrap();
    eng
}

pub(crate) async fn new_engine_env() -> (Env, Engine, Arc<FakeUsageApi>) {
    let e = new_env();
    e.set(NOW_UNIX);
    e.login_cred("a@x.com", "org-a", "acc-a", &future_cred("at-a", "rt-a"));
    e.svc.add_current().await.unwrap();
    e.login_cred("b@x.com", "org-b", "acc-b", &future_cred("at-b", "rt-b"));
    e.svc.add_current().await.unwrap();
    let api = Arc::new(FakeUsageApi::default());
    api.set_usage("at-a", r#"{"five_hour":{"utilization":10,"resets_at":"2027-01-01T00:00:00Z"},"seven_day":{"utilization":20}}"#);
    api.set_usage(
        "at-b",
        r#"{"five_hour":{"utilization":50},"seven_day":{"utilization":60}}"#,
    );
    let eng = engine(&e, &api);
    (e, eng, api)
}

/// 계정 셋, 첫 회차를 돈 엔진 (smart_test 의 threeAccounts).
pub(crate) async fn three_accounts() -> (Env, Engine, Arc<FakeUsageApi>) {
    let e = new_env();
    e.set(NOW_UNIX);
    for x in ["a", "b", "c"] {
        e.login_cred(
            &format!("{x}@x.com"),
            &format!("org-{x}"),
            &format!("acc-{x}"),
            &future_cred(&format!("at-{x}"), &format!("rt-{x}")),
        );
        e.svc.add_current().await.unwrap();
    }
    let api = Arc::new(FakeUsageApi::default());
    api.set_usage(
        "at-a",
        r#"{"five_hour":{"utilization":30},"seven_day":{"utilization":10}}"#,
    );
    api.set_usage(
        "at-b",
        r#"{"five_hour":{"utilization":50},"seven_day":{"utilization":10}}"#,
    );
    api.set_usage(
        "at-c",
        r#"{"five_hour":{"utilization":80},"seven_day":{"utilization":10}}"#,
    );
    let mut eng = engine(&e, &api);
    eng.stagger = Duration::from_millis(1);
    eng.tick(&CancellationToken::new()).await;
    (e, eng, api)
}

pub(crate) async fn tick(eng: &Engine) {
    eng.tick(&CancellationToken::new()).await;
}

fn row(eng: &Engine, id: &str) -> Row {
    eng.rows().get(id).cloned().unwrap_or_default()
}

#[tokio::test]
async fn engine_fetches_all_due_and_persists() {
    let (e, eng, api) = new_engine_env().await;
    tick(&eng).await;
    let (r1, r2) = (row(&eng, "id1"), row(&eng, "id2"));
    assert_eq!(r1.last_good.as_ref().unwrap().five_hour.unwrap().pct, 10.0);
    assert_eq!(r2.last_good.as_ref().unwrap().seven_day.unwrap().pct, 60.0);
    assert!(r1.status == STATUS_OK && r1.fetched_at == NOW_UNIX && r1.next_poll_at > NOW_UNIX);
    assert_eq!(r1.login_expires_at, NOW_UNIX + 30 * 86400);
    assert!(api.count("usage:at-a") == 1 && api.count("usage:at-b") == 1);
    tick(&eng).await;
    assert_eq!(api.count("usage:"), 2, "not due yet");
    let eng2 = engine(&e, &api);
    assert!(row(&eng2, "id1").last_good.is_some(), "persisted");
    let b = std::fs::read_to_string(e.data.join("usage.json")).unwrap();
    assert!(
        !b.contains("at-a") && !b.contains("rt-a"),
        "usage.json must not contain tokens"
    );
    // 관측 바이트: usage.json 의 머리와 한 행.
    assert!(b.starts_with("{\n  \"accounts\": {\n    \"id1\": {\n      \"lastGood\": {\n        \"fiveHour\": {\n          \"pct\": 10,\n          \"resetsAt\": 1798761600\n        },\n        \"sevenDay\": {\n          \"pct\": 20\n        }\n      },\n      \"fetchedAt\": 1800000000,\n      \"lastAttemptAt\": 1800000000,\n"), "{b}");
    assert!(b.ends_with("  },\n  \"schemaVersion\": 1\n}"), "{b}");
    assert!(
        b.contains("\"status\": \"ok\",\n      \"usageOk\": 1\n"),
        "{b}"
    );
}

#[tokio::test]
async fn engine_active_uses_live_credential() {
    let (e, eng, api) = new_engine_env().await;
    e.sec.put(
        &e.paths.keychain_service,
        "tester",
        &future_cred("at-b2", "rt-b2"),
    );
    api.set_usage("at-b2", r#"{"five_hour":{"utilization":50}}"#);
    tick(&eng).await;
    assert_eq!(api.count("usage:at-b2"), 1, "active must use live store");
}

#[tokio::test]
async fn engine_refresh_inactive_writes_backup_only() {
    let (e, eng, api) = new_engine_env().await;
    e.svc
        .backup
        .write(
            "id1",
            &Credential::parse(expired_cred("old-a", "rt-a").as_bytes()).unwrap(),
        )
        .unwrap();
    api.refresh.lock().unwrap().insert(
        "rt-a".into(),
        TokenResult {
            access_token: "at-a".into(),
            refresh_token: "rt-a2".into(),
            expires_in: 3600,
            ..Default::default()
        },
    );
    let before = e.live().access_token();
    tick(&eng).await;
    let b = e.svc.backup.read("id1").unwrap().unwrap();
    assert_eq!(
        (b.access_token(), b.refresh_token()),
        ("at-a".into(), "rt-a2".into())
    );
    assert_eq!(b.expires_at(), (NOW_UNIX + 3600) * 1000);
    assert_eq!(
        e.live().access_token(),
        before,
        "inactive refresh must not touch live store"
    );
    assert_eq!(row(&eng, "id1").status, STATUS_OK);
}

#[tokio::test]
async fn engine_refresh_active_writes_live_and_backup() {
    let (e, eng, api) = new_engine_env().await;
    e.sec.put(
        &e.paths.keychain_service,
        "tester",
        &expired_cred("old-b", "rt-b"),
    );
    api.refresh.lock().unwrap().insert(
        "rt-b".into(),
        TokenResult {
            access_token: "at-b".into(),
            refresh_token: "rt-b2".into(),
            expires_in: 3600,
            ..Default::default()
        },
    );
    tick(&eng).await;
    let l = e.live();
    assert_eq!(
        (l.access_token(), l.refresh_token()),
        ("at-b".into(), "rt-b2".into())
    );
    assert_eq!(
        e.svc.backup.read("id2").unwrap().unwrap().refresh_token(),
        "rt-b2"
    );
}

#[tokio::test]
async fn engine_401_refreshes_once_and_retries() {
    let (_e, eng, api) = new_engine_env().await;
    api.usage.lock().unwrap().remove("at-a");
    api.refresh.lock().unwrap().insert(
        "rt-a".into(),
        TokenResult {
            access_token: "at-a-new".into(),
            expires_in: 3600,
            ..Default::default()
        },
    );
    api.set_usage("at-a-new", r#"{"five_hour":{"utilization":1}}"#);
    tick(&eng).await;
    assert_eq!(api.count("refresh:rt-a"), 1);
    assert_eq!(row(&eng, "id1").status, STATUS_OK);
}

#[tokio::test]
async fn engine_permanent_refresh_failure_stops() {
    let (e, eng, api) = new_engine_env().await;
    e.svc
        .backup
        .write(
            "id1",
            &Credential::parse(expired_cred("old-a", "rt-a").as_bytes()).unwrap(),
        )
        .unwrap();
    api.refresh_err
        .lock()
        .unwrap()
        .insert("rt-a".into(), Sentinel::ReloginRequired);
    tick(&eng).await;
    let r = row(&eng, "id1");
    assert_eq!(
        (r.status.as_str(), r.last_error.as_str()),
        (STATUS_RELOGIN_REQUIRED, STATUS_RELOGIN_REQUIRED)
    );
    assert_eq!(
        r.auth_dead_fp,
        e.svc.backup.read("id1").unwrap().unwrap().fingerprint()
    );
    e.set(NOW_UNIX + 100_000);
    tick(&eng).await;
    assert_eq!(api.count("refresh:rt-a"), 1, "dead token is not retried");
    let fresh = format!(
        r#"{{"claudeAiOauth":{{"accessToken":"at-a","refreshToken":"rt-a-fresh","expiresAt":{}}}}}"#,
        (NOW_UNIX + 200_000) * 1000
    );
    e.svc
        .backup
        .write("id1", &Credential::parse(fresh.as_bytes()).unwrap())
        .unwrap();
    tick(&eng).await;
    let r = row(&eng, "id1");
    assert!(
        r.status == STATUS_OK && r.auth_dead_fp.is_empty(),
        "new credential clears dead mark"
    );
}

#[tokio::test]
async fn engine_transient_failure_backs_off() {
    let (e, eng, api) = new_engine_env().await;
    api.status.lock().unwrap().insert("at-a".into(), 500);
    tick(&eng).await;
    let r = row(&eng, "id1");
    assert!(
        r.consecutive_failures == 1
            && r.backoff_until == NOW_UNIX + 30
            && r.status == STATUS_UNAVAILABLE
    );
    api.status.lock().unwrap().insert("at-a".into(), 429);
    e.set(NOW_UNIX + 31);
    tick(&eng).await;
    let r = row(&eng, "id1");
    assert!(
        r.status == STATUS_RATE_LIMITED
            && r.last429_at == NOW_UNIX + 31
            && r.backoff_until == NOW_UNIX + 31 + 60,
        "{r:?}"
    );
}

#[tokio::test]
async fn engine_no_credentials() {
    let (e, eng, _api) = new_engine_env().await;
    e.svc.backup.delete("id1").unwrap();
    tick(&eng).await;
    let r = row(&eng, "id1");
    assert!(r.status == STATUS_NO_CREDENTIALS && r.next_poll_at == NOW_UNIX + 600);
}

#[tokio::test]
async fn engine_keychain_unavailable() {
    let (e, eng, _api) = new_engine_env().await;
    *e.sec.fail_get.lock().unwrap() = true;
    tick(&eng).await;
    let r = row(&eng, "id1");
    assert!(r.status == STATUS_KEYCHAIN_UNAVAILABLE && r.backoff_until == NOW_UNIX + 30);
}

#[tokio::test]
async fn engine_fetch_now_rules() {
    let (e, eng, api) = new_engine_env().await;
    tick(&eng).await;
    let err = eng.fetch_now("id1").await.unwrap_err();
    assert!(err.is(Sentinel::TooSoon));
    assert_eq!(err.to_string(), "조금 전에 조회했거나 물러나는 중입니다");
    e.set(NOW_UNIX + 179);
    assert!(
        eng.fetch_now("id1")
            .await
            .unwrap_err()
            .is(Sentinel::TooSoon),
        "D-CAC-36: 179s 도 거절한다"
    );
    e.set(NOW_UNIX + 181);
    eng.fetch_now("id1").await.unwrap();
    assert_eq!(api.count("usage:at-a"), 2);
    assert!(
        eng.fetch_now("nope")
            .await
            .unwrap_err()
            .is(Sentinel::NotFound)
    );
}

#[tokio::test]
async fn engine_drops_removed_accounts() {
    let (e, eng, _api) = new_engine_env().await;
    tick(&eng).await;
    e.svc.remove("id1").await.unwrap();
    tick(&eng).await;
    assert!(!eng.rows().contains_key("id1"));
}

#[tokio::test]
async fn sync_active_from_live_in_tick() {
    let (e, eng, _api) = new_engine_env().await;
    let active = || e.svc.store.load().unwrap().active_id;
    assert!(!e.svc.sync_active_from_live().unwrap() && active() == "id2");
    e.login_cred("a@x.com", "org-a", "acc-a", &future_cred("at-a", "rt-a"));
    assert!(e.svc.sync_active_from_live().unwrap() && active() == "id1");
    assert!(
        read_history(&e.data, 10).unwrap().is_empty(),
        "전환 기록은 남기지 않는다"
    );
    e.login_cred("z@x.com", "org-z", "acc-z", &future_cred("at-z", "rt-z"));
    assert!(!e.svc.sync_active_from_live().unwrap() && active() == "id1");
    e.login_cred("b@x.com", "org-b", "acc-b", &future_cred("at-b", "rt-b"));
    let changed = Arc::new(AtomicUsize::new(0));
    let c2 = changed.clone();
    let mut eng = eng;
    eng.on_change = Some(Arc::new(move || {
        c2.fetch_add(1, Ordering::SeqCst);
    }));
    tick(&eng).await;
    assert!(active() == "id2" && changed.load(Ordering::SeqCst) > 0);
}

#[tokio::test]
async fn engine_tick_returns_next_wake() {
    let (_e, eng, _api) = new_engine_env().await;
    let next = eng.tick(&CancellationToken::new()).await;
    let due = eng.rows().values().map(Row::due_at).min().unwrap();
    assert_eq!(next.unix_timestamp(), due.min(NOW_UNIX + 300));
}

// --- engine_round_test (GD-9·10·23) ---

#[tokio::test]
async fn engine_tick_writes_usage_once_per_round() {
    let (e, eng, api) = three_accounts().await;
    e.advance(24 * 3600);
    let (writes, before) = (eng.writes(), api.calls.lock().unwrap().len());
    tick(&eng).await;
    assert_eq!(api.calls.lock().unwrap().len() - before, 3);
    assert_eq!(
        eng.writes() - writes,
        1,
        "usage.json 쓰기는 회차당 한 번이다 (GD-9)"
    );
    let again = engine(&e, &api);
    for (id, r) in eng.rows() {
        let got = row(&again, &id);
        assert!(
            got.fetched_at == r.fetched_at && got.next_poll_at == r.next_poll_at,
            "{id}"
        );
    }
}

#[tokio::test]
async fn engine_tick_reads_accounts_once() {
    let (e, eng, _api) = three_accounts().await;
    let before = e.svc.store.reads();
    tick(&eng).await;
    assert_eq!(
        e.svc.store.reads() - before,
        1,
        "엔진 회차의 accounts.json 읽기 (GD-23)"
    );
}

#[tokio::test]
async fn engine_tick_stagger_honors_cancel() {
    let (e, mut eng, api) = three_accounts().await;
    eng.stagger = Duration::from_millis(300);
    e.advance(24 * 3600);
    let ctx = CancellationToken::new();
    ctx.cancel();
    let before = api.calls.lock().unwrap().len();
    let start = Instant::now();
    eng.tick(&ctx).await;
    assert!(
        start.elapsed() < eng.stagger,
        "끊긴 회차는 곧바로 돌아온다 (GD-10)"
    );
    assert_eq!(
        api.calls.lock().unwrap().len() - before,
        1,
        "끊긴 뒤에는 조회하지 않는다"
    );
}

// --- engine_resets_test (FR-CAC-60~65) ---

const JUNIPER_BODY: &str = r#"{"juniper_tide":{"eligible":true,"available":true}}"#;
const CEDAR_BODY: &str = r#"{"cedar_ember":{"eligible":true,"grants":[{"id":"g_1","resets_left":2,"resets_total":3,"usable_now":true,"clears":["five_hour"]}]}}"#;

fn with_resets(api: &FakeUsageApi) {
    let mut q = api.by_query.lock().unwrap();
    q.insert(QUERY_JUNIPER.into(), JUNIPER_BODY.into());
    q.insert(QUERY_CEDAR.into(), CEDAR_BODY.into());
}

#[tokio::test]
async fn engine_resets_only_on_manual_refresh() {
    let (e, eng, api) = new_engine_env().await;
    with_resets(&api);
    tick(&eng).await;
    assert!(
        api.count("status:") == 0 && row(&eng, "id1").resets.is_none(),
        "주기 조회는 상태를 묻지 않는다"
    );
    for want in [2, 4] {
        e.advance(181);
        eng.fetch_now("id1").await.unwrap();
        assert_eq!(api.count("status:at-a?"), want);
    }
    let rs = row(&eng, "id1").resets.unwrap();
    assert!(rs.juniper.as_ref().unwrap().available && rs.cedar.as_ref().unwrap().grants.len() == 1);
    assert_eq!(rs.fetched_at, NOW_UNIX + 362);
    for _ in 0..3 {
        e.advance(700);
        tick(&eng).await;
    }
    assert_eq!(api.count("status:at-a?"), 4, "주기 조회가 상태를 물었다");
}

#[tokio::test]
async fn engine_resets_missing_keeps_none() {
    let (e, eng, api) = new_engine_env().await;
    tick(&eng).await;
    e.advance(181);
    eng.fetch_now("id1").await.unwrap();
    let rs = row(&eng, "id1").resets.unwrap();
    assert!(
        api.count("status:") > 0 && rs.juniper.is_none() && rs.cedar.is_none(),
        "필드가 없으면 없음이다 (FR-CAC-61)"
    );
}

#[tokio::test]
async fn engine_fetch_resets_now() {
    let (e, eng, api) = new_engine_env().await;
    with_resets(&api);
    tick(&eng).await;
    assert!(
        eng.fetch_now("id1")
            .await
            .unwrap_err()
            .is(Sentinel::TooSoon)
    );
    e.advance(181);
    eng.fetch_now("id1").await.unwrap();
    assert!(
        eng.fetch_resets_now("id1")
            .await
            .unwrap_err()
            .is(Sentinel::TooSoon),
        "180초 안이면 거절한다"
    );
    e.advance(181);
    eng.fetch_resets_now("id1").await.unwrap();
    assert!(
        api.count("status:at-a?") == 4 && api.count("usage:at-a") == 2,
        "상태만 조회한다"
    );
    assert_eq!(row(&eng, "id1").resets.unwrap().fetched_at, NOW_UNIX + 362);
    assert!(
        eng.fetch_resets_now("nope")
            .await
            .unwrap_err()
            .is(Sentinel::NotFound)
    );
}

#[tokio::test]
async fn engine_claim_juniper_refetches() {
    let (_e, mut eng, api) = new_engine_env().await;
    with_resets(&api);
    let changed = Arc::new(AtomicUsize::new(0));
    let c2 = changed.clone();
    eng.on_change = Some(Arc::new(move || {
        c2.fetch_add(1, Ordering::SeqCst);
    }));
    *api.claims.lock().unwrap() = vec![FakeClaim {
        body: r#"{"result":"reset","next_available_at":"2027-02-01T00:00:00Z"}"#,
        err: None,
    }];
    let res = eng.claim("id1", PROGRAM_JUNIPER, "").await.unwrap();
    assert!(res.result == "reset" && res.next_available_at != 0);
    let bodies = api.claim_body.lock().unwrap().clone();
    assert!(
        api.count("claim:at-a:org-a") == 1
            && bodies[0].len() == 1
            && bodies[0]["program"] == PROGRAM_JUNIPER
    );
    assert!(
        api.count("usage:at-a") == 1
            && api.count("status:at-a?") == 2
            && changed.load(Ordering::SeqCst) > 0,
        "성공하면 바로 다시 조회한다"
    );
}

#[tokio::test]
async fn engine_claim_validation() {
    let (_e, eng, api) = new_engine_env().await;
    for (program, grant) in [
        ("other", ""),
        (PROGRAM_CEDAR, ""),
        (PROGRAM_CEDAR, "BAD ID"),
        (PROGRAM_JUNIPER, "g_1"),
    ] {
        assert!(
            eng.claim("id1", program, grant)
                .await
                .unwrap_err()
                .is(Sentinel::Invalid),
            "{program} {grant}"
        );
    }
    assert_eq!(
        eng.claim("id1", PROGRAM_CEDAR, "BAD ID")
            .await
            .unwrap_err()
            .to_string(),
        "값이 범위를 벗어났습니다: 프로그램 \"cedar_ember\" 와 티켓 \"BAD ID\" 가 맞지 않습니다"
    );
    assert!(
        eng.claim("nope", PROGRAM_JUNIPER, "")
            .await
            .unwrap_err()
            .is(Sentinel::NotFound)
    );
    assert_eq!(api.count("claim:"), 0, "보내지 않는다");
}

#[tokio::test]
async fn engine_claim_unconfirmed_reuses_request_id() {
    let (_e, eng, api) = new_engine_env().await;
    *api.claims.lock().unwrap() = vec![
        FakeClaim {
            body: "",
            err: Some("timeout"),
        },
        FakeClaim {
            body: r#"{"result":"reset","resets_left":1}"#,
            err: None,
        },
        FakeClaim {
            body: r#"{"result":"already_used"}"#,
            err: None,
        },
    ];
    let r1 = eng.claim("id1", PROGRAM_CEDAR, "g_1").await.unwrap();
    let r2 = eng.claim("id1", PROGRAM_CEDAR, "g_1").await.unwrap();
    let r3 = eng.claim("id1", PROGRAM_CEDAR, "g_1").await.unwrap();
    assert!(
        r1.result == "unconfirmed"
            && r2.result == "reset"
            && r2.resets_left == Some(1)
            && r3.result == "already_used"
    );
    let b = api.claim_body.lock().unwrap().clone();
    assert!(
        b[0]["program"] == PROGRAM_CEDAR && b[0]["grant_id"] == "g_1" && b[0]["request_id"] != ""
    );
    assert_eq!(
        b[1]["request_id"], b[0]["request_id"],
        "확인하지 못한 요청은 같은 request_id 로 다시 보낸다"
    );
    assert_ne!(
        b[2]["request_id"], b[1]["request_id"],
        "결과를 받은 뒤에는 새 request_id 다"
    );
}

#[tokio::test]
async fn engine_claim_401_refreshes_once() {
    let (_e, eng, api) = new_engine_env().await;
    api.status.lock().unwrap().insert("claim:at-a".into(), 401);
    api.refresh.lock().unwrap().insert(
        "rt-a".into(),
        TokenResult {
            access_token: "at-a2".into(),
            refresh_token: "rt-a2".into(),
            expires_in: 3600,
            ..Default::default()
        },
    );
    api.set_usage("at-a2", r#"{"five_hour":{"utilization":10}}"#);
    let res = eng.claim("id1", PROGRAM_JUNIPER, "").await.unwrap();
    assert!(
        res.result == "reset"
            && api.count("claim:at-a2:org-a") == 1
            && api.count("refresh:rt-a") == 1
    );
    api.status.lock().unwrap().insert("claim:at-a2".into(), 401);
    api.refresh.lock().unwrap().insert(
        "rt-a2".into(),
        TokenResult {
            access_token: "at-a3".into(),
            refresh_token: "rt-a3".into(),
            expires_in: 3600,
            ..Default::default()
        },
    );
    api.status.lock().unwrap().insert("claim:at-a3".into(), 401);
    assert_eq!(
        eng.claim("id1", PROGRAM_JUNIPER, "").await.unwrap().result,
        "auth_error",
        "두 번째 401 은 auth_error"
    );
}

#[tokio::test]
async fn engine_fetch_now_overlap_fetches_once() {
    let (_e, eng, api) = new_engine_env().await;
    let g = eng.busy.lock().await;
    let release = async {
        tokio::time::sleep(Duration::from_millis(100)).await;
        drop(g);
    };
    let ((), r1, r2) = tokio::join!(release, eng.fetch_now("id1"), eng.fetch_now("id1"));
    assert_eq!(api.count("usage:at-a"), 1);
    let errs = [r1, r2];
    assert_eq!(
        errs.iter()
            .filter(|r| r.as_ref().is_err_and(|e| e.is(Sentinel::TooSoon)))
            .count(),
        1
    );
    assert_eq!(errs.iter().filter(|r| r.is_ok()).count(), 1);
}

#[tokio::test]
async fn refresh_pinned_writes_profile_and_backup() {
    let (e, eng, api) = new_engine_env().await;
    e.alive.lock().unwrap().push(42);
    e.svc
        .backup
        .write(
            "id1",
            &Credential::parse(expired_cred("at-a", "rt-a").as_bytes()).unwrap(),
        )
        .unwrap();
    e.svc.prepare_profile("id1").unwrap();
    write_session(&e.svc.profile_dir("id1"), 42);
    api.refresh.lock().unwrap().insert(
        "rt-a".into(),
        TokenResult {
            access_token: "at-a9".into(),
            refresh_token: "rt-a9".into(),
            expires_in: 3600,
            ..Default::default()
        },
    );
    let body = api.usage.lock().unwrap()["at-a"].clone();
    api.set_usage("at-a9", &body);
    eng.fetch_now("id1").await.unwrap();
    assert_eq!(
        e.svc.backup.read("id1").unwrap().unwrap().access_token(),
        "at-a9"
    );
    assert_eq!(
        e.svc
            .profile_live("id1")
            .read()
            .unwrap()
            .unwrap()
            .access_token(),
        "at-a9"
    );
    assert_eq!(e.live().access_token(), "at-b", "live untouched");
}
