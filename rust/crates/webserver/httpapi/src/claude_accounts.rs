//! 로컬 API `/api/claude-accounts/*` 와 Claude 다중 계정 도메인의 이음매 (Go `claude_accounts_api.go`·
//! `claude_accounts_mappings.go`·`claude_accounts_statusline.go`·`claude_accounts_wire.go`,
//! CLAUDE_ACCOUNTS_SRS). 본문 오류는 `{code,message}` 방언이다. 응답에는 토큰이 없다 (FR-CAC-9).

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock, PoisonError, Weak};

use http::StatusCode;
use otter_gocompat::json::RawMessage;
use otter_shared_agentrec::ReportAccount;
use otter_shared_httpresp::{self as httpresp, Response};
use otter_shared_otterlog::infof;
use otter_shared_platform::{Secrets, SecretsError};
use otter_shared_statusline::RateWindow;
use otter_webserver_apierr as apierr;
use otter_webserver_domain_claudeacct as ca;
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use tokio_util::sync::CancellationToken;

use crate::httperr::{code_fail, read_json_body};
use crate::req::Req;
use crate::tools_api::off_thread;
use crate::{Config, Server};

/// Go `claudeHistoryDefault`·`claudeHistoryMax`.
const CLAUDE_HISTORY_DEFAULT: usize = 50;
const CLAUDE_HISTORY_MAX: i64 = 1000;

/// 합성 루트가 넣는 Claude 계정의 바깥 자리다 (Go `Config.ClaudeSecrets`·`Config.ClaudeProcs`).
/// 비면 이 OS 의 것이다.
#[derive(Clone, Default)]
pub struct ClaudeHooks {
    pub secrets: Option<Arc<dyn Secrets>>,
    pub procs: Option<ca::ProcsFn>,
}

/// Go `claudeAcctWire`: 서버와 Claude 다중 계정 도메인의 이음매다.
pub(crate) struct ClaudeAcctWire {
    pub(crate) svc: Arc<ca::Service>,
    pub(crate) eng: Arc<ca::Engine>,
    pub(crate) auto: Arc<ca::Auto>,
    pub(crate) sl: Arc<ClaudeSlStore>,
}

/// 이 OS 의 비밀 저장소를 `Arc` 로 감싼다.
struct OsSecrets(&'static dyn Secrets);

impl Secrets for OsSecrets {
    fn available(&self) -> bool {
        self.0.available()
    }
    fn account(&self) -> String {
        self.0.account()
    }
    fn get(&self, service: &str, account: &str) -> Result<Option<String>, SecretsError> {
        self.0.get(service, account)
    }
    fn set(&self, service: &str, account: &str, value: &str) -> Result<(), SecretsError> {
        self.0.set(service, account, value)
    }
    fn delete(&self, service: &str, account: &str) -> Result<(), SecretsError> {
        self.0.delete(service, account)
    }
}

/// Go `claudeUserAgent`.
pub(crate) fn claude_user_agent(version: &str) -> String {
    if version.is_empty() {
        return "otterminal".to_owned();
    }
    format!("otterminal/{version}")
}

/// Go `initClaudeAccounts`: 계정 서비스를 세운다. data_dir 이나 사용자 홈이 없으면 세우지 않는다.
pub(crate) fn init_claude_accounts(
    cfg: &Config,
    hooks: &ClaudeHooks,
    me: Weak<Server>,
) -> Option<ClaudeAcctWire> {
    if cfg.data_dir.as_os_str().is_empty() {
        return None;
    }
    let home = if cfg.claude_home.as_os_str().is_empty() {
        match std::env::home_dir().filter(|h| !h.as_os_str().is_empty()) {
            Some(h) => h,
            None => {
                infof!(
                    None,
                    "claude-accounts: 사용자 홈을 알 수 없다: $HOME is not defined — 끈 채로 시작한다"
                );
                return None;
            }
        }
    } else {
        cfg.claude_home.clone()
    };
    let sec: Arc<dyn Secrets> = match &hooks.secrets {
        Some(s) => s.clone(),
        None => Arc::new(OsSecrets(otter_shared_platform::current().secrets)),
    };
    let dir: PathBuf = cfg
        .data_dir
        .join(otter_shared_otterenv::CLAUDE_ACCOUNTS_DIR);
    let paths = ca::ClaudePaths::default_for(&home);
    let client = Arc::new(ca::Client {
        base: cfg.claude_api.clone(),
        token_base: cfg.claude_api.clone(),
        hc: None,
        user_agent: claude_user_agent(&cfg.version),
    });
    let now: ca::Clock = Arc::new(OffsetDateTime::now_utc);
    let svc = Arc::new(ca::Service::new(
        ca::Store::open(&dir),
        ca::BackupStore {
            dir: dir.clone(),
            sec: sec.clone(),
        },
        ca::LiveStore {
            paths: paths.clone(),
            sec,
            retry_delay: std::time::Duration::ZERO,
        },
        paths,
        &dir,
        client.clone(),
        now.clone(),
        Arc::new(otter_shared_uuid::new_string),
    ));
    let sl = Arc::new(ClaudeSlStore::default());
    let changed: ca::OnChangeFn = {
        let me = me.clone();
        Arc::new(move || {
            if let Some(s) = me.upgrade() {
                s.claude_accounts_changed();
            }
        })
    };
    // 엔진의 판정 함수는 자동 전환기의 것이다 — 자동 전환기가 엔진을 쥐므로 나중에 잇는다.
    let auto_cell: Arc<OnceLock<Weak<ca::Auto>>> = Arc::new(OnceLock::new());
    let mut eng = ca::Engine::new(svc.clone(), client, now.clone());
    eng.on_change = Some(changed.clone());
    eng.status_line = Some({
        let sl = sl.clone();
        Arc::new(move |a: &ca::Account| sl.get(a))
    });
    eng.line_for = Some({
        let cell = auto_cell.clone();
        Arc::new(move |a: &ca::Account| {
            cell.get()
                .and_then(Weak::upgrade)
                .map_or(0.0, |auto| auto.line_for(a))
        })
    });
    eng.models = Some({
        let cell = auto_cell.clone();
        Arc::new(move || {
            cell.get()
                .and_then(Weak::upgrade)
                .map_or_else(Vec::new, |auto| auto.models())
        })
    });
    if let Err(e) = eng.load() {
        infof!(None, "claude-accounts: 사용량 캐시를 읽지 못했다: {e}");
    }
    let eng = Arc::new(eng);
    let mut auto = ca::Auto::new(eng.clone(), now);
    auto.procs = Some(match &hooks.procs {
        Some(p) => p.clone(),
        None => Arc::new(|| otter_shared_platform::command_lines().map_err(|e| e.to_string())),
    });
    auto.notify = Some(Arc::new(move |a: &ca::Alert| {
        if let Some(s) = me.upgrade() {
            s.claude_account_alert(a);
        }
    }));
    auto.on_change = Some(changed);
    if let Err(e) = auto.load() {
        infof!(None, "claude-accounts: 자동 전환 설정을 읽지 못했다: {e}");
    }
    let auto = Arc::new(auto);
    let _ = auto_cell.set(Arc::downgrade(&auto));
    Some(ClaudeAcctWire { svc, eng, auto, sl })
}

// ── statusLine (Go `claude_accounts_statusline.go`) ─────────────────────────

/// Go `claudeSLObs`.
#[derive(Clone)]
struct SlObs {
    email: String,
    u: ca::Usage,
    at: i64,
}

/// Go `claudeSLStore`: 계정별 statusLine 마지막 값이다 (FR-CAC-78). 서버 메모리에만 둔다.
#[derive(Default)]
pub(crate) struct ClaudeSlStore(Mutex<HashMap<(String, String), SlObs>>);

/// Go `claudeSLUsage`: statusLine 의 두 창을 사용량 모양으로 옮긴다. 둘 다 없으면 `None`.
fn sl_usage(rl: Option<&BTreeMap<String, RateWindow>>) -> Option<ca::Usage> {
    let conv = |name: &str| {
        let w = rl?.get(name)?;
        Some(ca::Window {
            pct: w.used_pct?,
            resets_at: w.resets_at.map_or(0, |v| v as i64),
        })
    };
    let u = ca::Usage {
        five_hour: conv("five_hour"),
        seven_day: conv("seven_day"),
        ..Default::default()
    };
    (u.five_hour.is_some() || u.seven_day.is_some()).then_some(u)
}

impl ClaudeSlStore {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<(String, String), SlObs>> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub(crate) fn put(
        &self,
        acc: &ReportAccount,
        rl: Option<&BTreeMap<String, RateWindow>>,
        at: OffsetDateTime,
    ) {
        let Some(u) = sl_usage(rl) else {
            return;
        };
        self.lock().insert(
            (acc.email.clone(), acc.org_uuid.clone()),
            SlObs {
                email: acc.email.clone(),
                u,
                at: at.unix_timestamp(),
            },
        );
    }

    /// Go `get`: Engine.StatusLine 이다.
    pub(crate) fn get(&self, a: &ca::Account) -> Option<(ca::Usage, i64)> {
        self.lock()
            .get(&(a.email.clone(), a.org_uuid.clone()))
            .map(|o| (o.u.clone(), o.at))
    }

    /// Go `others`: 등록되지 않은 계정의 값이다. 이름은 가린 이메일이고 순서는 이름 순이다.
    fn others(&self, accts: &[ca::Account], now: i64) -> Vec<ca::StatusLineView> {
        let known: std::collections::HashSet<(String, String)> = accts
            .iter()
            .map(|a| (a.email.clone(), a.org_uuid.clone()))
            .collect();
        let mut out: Vec<ca::StatusLineView> = self
            .lock()
            .iter()
            .filter(|(k, _)| !known.contains(*k))
            .map(|(_, o)| {
                let mut v = ca::status_line_view_of(&o.u, o.at, now);
                v.name = ca::masked_name(&o.email);
                v
            })
            .collect();
        out.sort_by(|a, b| a.name.cmp(&b.name));
        out
    }
}

// ── 응답 모양 ────────────────────────────────────────────────────────────────

/// Go `claudeAccountsView`.
#[derive(Serialize)]
struct AccountsView {
    #[serde(rename = "activeId")]
    active_id: String,
    accounts: Vec<ca::AccountView>,
    autoswitch: AutoSummary,
    #[serde(rename = "otherStatusLines")]
    other_status_lines: Vec<ca::StatusLineView>,
    ranges: &'static BTreeMap<&'static str, ca::AutoRange>,
}

/// Go `claudeAutoSummary`: foot 표식에 쓰는 자동 전환 요약이다 (FR-CAC-76·92).
#[derive(Serialize)]
struct AutoSummary {
    enabled: bool,
    status: String,
}

#[derive(Serialize)]
struct AddBody {
    account: ca::Account,
    created: bool,
}

#[derive(Serialize)]
struct OkBody {
    ok: bool,
}

const OK: OkBody = OkBody { ok: true };

#[derive(Serialize)]
struct Entries<T> {
    entries: T,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct IdReq {
    id: String,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct OrderReq {
    ids: Vec<String>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct SwitchReq {
    id: String,
    strategy: String,
    by: String,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct RefreshReq {
    id: String,
    resets: bool,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct ResetReq {
    id: String,
    program: String,
    #[serde(rename = "grantId")]
    grant_id: String,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct MappingReq {
    folder: String,
    #[serde(rename = "toolId")]
    tool_id: String,
    #[serde(rename = "accountId")]
    account_id: String,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct LaunchReq {
    #[serde(rename = "toolId")]
    tool_id: String,
    cwd: String,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct NameReq {
    name: String,
}

/// Go `claudeAccountsFail`: 도메인 오류를 상태와 코드로 옮긴다.
fn claude_accounts_fail(err: &ca::Error) -> Response {
    use ca::Sentinel as S;
    let rows: [(S, StatusCode, &str); 12] = [
        (
            S::NotFound,
            StatusCode::NOT_FOUND,
            apierr::CODE_CLAUDE_ACCOUNT_NOT_FOUND,
        ),
        (
            S::Invalid,
            StatusCode::BAD_REQUEST,
            apierr::CODE_CLAUDE_ACCOUNT_INVALID,
        ),
        (
            S::InvalidId,
            StatusCode::BAD_REQUEST,
            apierr::CODE_CLAUDE_ACCOUNT_INVALID,
        ),
        (
            S::NotLoggedIn,
            StatusCode::CONFLICT,
            apierr::CODE_CLAUDE_NOT_LOGGED_IN,
        ),
        (
            S::LiveEmpty,
            StatusCode::CONFLICT,
            apierr::CODE_CLAUDE_NOT_LOGGED_IN,
        ),
        (
            S::EmptyBackup,
            StatusCode::CONFLICT,
            apierr::CODE_CLAUDE_BACKUP_EMPTY,
        ),
        (
            S::ClaudeLockTimeout,
            StatusCode::CONFLICT,
            apierr::CODE_CLAUDE_LOCKED,
        ),
        (
            S::LiveChanged,
            StatusCode::CONFLICT,
            apierr::CODE_CLAUDE_LIVE_CHANGED,
        ),
        (
            S::NoCandidate,
            StatusCode::CONFLICT,
            apierr::CODE_CLAUDE_NO_CANDIDATE,
        ),
        (
            S::KeychainUnavailable,
            StatusCode::SERVICE_UNAVAILABLE,
            apierr::CODE_CLAUDE_KEYCHAIN,
        ),
        (
            S::TooSoon,
            StatusCode::CONFLICT,
            apierr::CODE_CLAUDE_TOO_SOON,
        ),
        (
            S::CswapRunning,
            StatusCode::CONFLICT,
            apierr::CODE_CLAUDE_CSWAP_RUNNING,
        ),
    ];
    for (s, status, code) in rows {
        if err.is(s) {
            return code_fail(status, code, &err.to_string());
        }
    }
    infof!(None, "claude-accounts: {err}");
    code_fail(
        StatusCode::INTERNAL_SERVER_ERROR,
        apierr::CODE_INTERNAL,
        "claude accounts operation failed",
    )
}

fn ok_json<T: Serialize + ?Sized>(v: &T) -> Response {
    httpresp::json(StatusCode::OK, v)
}

/// 블로킹 도메인 호출을 일 스레드로 돌린다. 스레드가 죽으면 내부 오류다.
async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, ca::Error> + Send + 'static,
) -> Result<T, Response> {
    match off_thread(f).await {
        Some(Ok(v)) => Ok(v),
        Some(Err(e)) => Err(claude_accounts_fail(&e)),
        None => Err(code_fail(
            StatusCode::INTERNAL_SERVER_ERROR,
            apierr::CODE_INTERNAL,
            "claude accounts operation failed",
        )),
    }
}

/// `match` 한 줄로 응답을 꺼낸다.
macro_rules! tri {
    ($e:expr) => {
        match $e {
            Ok(v) => v,
            Err(res) => return res,
        }
    };
}

impl Server {
    /// Go `claudeAccountsReady`.
    fn claude_ready(&self) -> Result<&ClaudeAcctWire, Response> {
        self.ca.as_ref().ok_or_else(|| {
            code_fail(
                StatusCode::SERVICE_UNAVAILABLE,
                apierr::CODE_CLAUDE_ACCOUNTS_UNAVAILABLE,
                "claude accounts unavailable",
            )
        })
    }

    /// Go `claudeAccountsChanged`: 계정 상태가 바뀌었다고 브라우저에 알린다 — `claude.accounts`
    /// 토픽 (FR-CAC-122, CHANNEL_PROTOCOL C2b).
    pub(crate) fn claude_accounts_changed(&self) {
        self.refresh_full_topic("claude.accounts");
    }

    /// Go `claudeAccountAlert`: 계정 알림을 브라우저(`alert` 토픽)와, 켜져 있으면 Telegram 으로 보낸다
    /// (FR-CAC-100a).
    pub(crate) fn claude_account_alert(&self, a: &ca::Alert) {
        self.topics
            .publish_event("alert", serde_json::to_value(a).unwrap_or_default());
        if let Some(b) = self.tg.as_ref().and_then(|tg| tg.bridge.as_ref()) {
            let text = a.text();
            if !text.is_empty() {
                b.on_notice(&text);
            }
        }
    }

    /// Go `StartClaudeAccounts`: 사용량 조회기와 자동 전환기를 돌리고, stop 이 취소되면 멈춘다.
    /// 등록된 계정이 없으면 아무 요청도 하지 않는다 (FR-CAC-50).
    pub fn start_claude_accounts(&self, stop: CancellationToken) {
        let Some(w) = &self.ca else {
            return;
        };
        let (eng, auto) = (w.eng.clone(), w.auto.clone());
        let s2 = stop.clone();
        tokio::spawn(async move { eng.run(stop).await });
        tokio::spawn(async move { auto.run(s2).await });
    }

    pub(crate) async fn api_claude_accounts_list(&self, _r: &mut Req) -> Response {
        let w = tri!(self.claude_ready());
        let svc = w.svc.clone();
        let synced = off_thread(move || svc.sync_active_from_live()).await;
        if matches!(synced, Some(Ok(true))) {
            self.claude_accounts_changed(); // FR-CAC-34b: 다른 창도 다시 받는다
        }
        let svc = w.svc.clone();
        let st = tri!(blocking(move || svc.store.load()).await);
        let av = w.auto.view();
        let now = OffsetDateTime::now_utc().unix_timestamp();
        let rows = w.eng.rows();
        let mut views = ca::build_views(&st, &rows, now);
        let last_switch = w.eng.last_switch_at();
        for v in &mut views {
            if let Some((u, at)) = w.sl.get(&v.account) {
                let last_good = rows.get(&v.account.id).and_then(|r| r.last_good.as_ref());
                v.apply_status_line(last_good, &u, at, last_switch, now);
            }
            v.profile_warnings = w.svc.profile_warnings(&v.account.id);
        }
        ok_json(&AccountsView {
            active_id: st.active_id.clone(),
            accounts: views,
            autoswitch: AutoSummary {
                enabled: av.settings.enabled,
                status: av.state.status,
            },
            other_status_lines: w.sl.others(&st.accounts, now),
            ranges: &ca::ACCOUNT_RANGES,
        })
    }

    pub(crate) async fn api_claude_accounts_add(&self, _r: &mut Req) -> Response {
        let w = tri!(self.claude_ready());
        let (account, created) = match w.svc.add_current().await {
            Ok(v) => v,
            Err(e) => return claude_accounts_fail(&e),
        };
        w.eng.wake();
        self.claude_accounts_changed();
        ok_json(&AddBody { account, created })
    }

    pub(crate) async fn api_claude_accounts_item(&self, r: &mut Req) -> Response {
        let w = tri!(self.claude_ready());
        // Go `claudeAccountItemReq`: `id` 와 Patch 의 필드가 한 본문에 든다(구조체 끼워 넣기).
        let raw: RawMessage = tri!(read_json_body(r).await);
        let (Ok(id), Ok(patch)) = (
            otter_gocompat::json::unmarshal::<IdReq>(&raw.0),
            otter_gocompat::json::unmarshal::<ca::Patch>(&raw.0),
        ) else {
            return code_fail(
                StatusCode::BAD_REQUEST,
                apierr::CODE_INVALID_JSON,
                "invalid json",
            );
        };
        let svc = w.svc.clone();
        let a = tri!(blocking(move || svc.update(&id.id, &patch)).await);
        self.claude_accounts_changed();
        ok_json(&a)
    }

    pub(crate) async fn api_claude_accounts_remove(&self, r: &mut Req) -> Response {
        let w = tri!(self.claude_ready());
        let req: IdReq = tri!(read_json_body(r).await);
        if let Err(e) = w.svc.remove(&req.id).await {
            return claude_accounts_fail(&e);
        }
        self.claude_accounts_changed();
        ok_json(&OK)
    }

    pub(crate) async fn api_claude_accounts_order(&self, r: &mut Req) -> Response {
        let w = tri!(self.claude_ready());
        let req: OrderReq = tri!(read_json_body(r).await);
        let svc = w.svc.clone();
        tri!(blocking(move || svc.reorder(&req.ids)).await);
        self.claude_accounts_changed();
        ok_json(&OK)
    }

    pub(crate) async fn api_claude_accounts_switch(&self, r: &mut Req) -> Response {
        let w = tri!(self.claude_ready());
        let req: SwitchReq = tri!(read_json_body(r).await);
        let res = match w
            .eng
            .switch(&ca::SwitchRequest {
                id: req.id,
                strategy: req.strategy,
                by: req.by,
            })
            .await
        {
            Ok(v) => v,
            Err(e) => return claude_accounts_fail(&e),
        };
        if !res.no_op {
            w.eng.wake();
            self.claude_accounts_changed();
        }
        ok_json(&res)
    }

    /// Go `apiClaudeAccountsRefresh`: 계정 하나를 바로 조회한다 (FR-CAC-58). resets 면 두 초기화
    /// 상태만이다 (FR-CAC-65).
    pub(crate) async fn api_claude_accounts_refresh(&self, r: &mut Req) -> Response {
        let w = tri!(self.claude_ready());
        let req: RefreshReq = tri!(read_json_body(r).await);
        let got = if req.resets {
            w.eng.fetch_resets_now(&req.id).await
        } else {
            w.eng.fetch_now(&req.id).await
        };
        if let Err(e) = got {
            return claude_accounts_fail(&e);
        }
        ok_json(&OK)
    }

    /// Go `apiClaudeAccountsReset`: 제한 초기화 하나를 쓴다 (FR-CAC-62·63·65). 결과는 언제나 200
    /// 이다. 브라우저가 끊겨도 보낸 사용은 끝까지 기다린다 — 따로 돈 task 라 요청 취소에 끊기지 않는다.
    pub(crate) async fn api_claude_accounts_reset(&self, r: &mut Req) -> Response {
        let w = tri!(self.claude_ready());
        let req: ResetReq = tri!(read_json_body(r).await);
        let eng = w.eng.clone();
        let task =
            tokio::spawn(async move { eng.claim(&req.id, &req.program, &req.grant_id).await });
        match task.await {
            Ok(Ok(res)) => ok_json(&res),
            Ok(Err(e)) => claude_accounts_fail(&e),
            Err(_) => code_fail(
                StatusCode::INTERNAL_SERVER_ERROR,
                apierr::CODE_INTERNAL,
                "claude accounts operation failed",
            ),
        }
    }

    /// Go `apiClaudeAccountsHistory`: 전환 기록이다 (FR-CAC-110a). 최신 먼저, limit 은 1~1000(기본 50).
    pub(crate) async fn api_claude_accounts_history(&self, r: &mut Req) -> Response {
        let w = tri!(self.claude_ready());
        let mut limit = CLAUDE_HISTORY_DEFAULT;
        let q = r.q("limit");
        if !q.is_empty() {
            match q.parse::<i64>() {
                Ok(v) if (1..=CLAUDE_HISTORY_MAX).contains(&v) => limit = v as usize,
                _ => {
                    return code_fail(
                        StatusCode::BAD_REQUEST,
                        apierr::CODE_CLAUDE_ACCOUNT_INVALID,
                        "limit 은 1~1000 입니다",
                    );
                }
            }
        }
        let dir = w.svc.dir.clone();
        let entries = tri!(blocking(move || ca::read_history(&dir, limit)).await);
        ok_json(&Entries { entries })
    }

    /// Go `apiClaudeAccountsAutoswitchGet`: 자동 전환 설정과 상태다 (FR-CAC-76).
    pub(crate) async fn api_claude_accounts_autoswitch_get(&self, _r: &mut Req) -> Response {
        let w = tri!(self.claude_ready());
        ok_json(&w.auto.view())
    }

    /// Go `apiClaudeAccountsAutoswitchPut`: 설정의 일부 키를 고친다 (FR-CAC-75·76).
    pub(crate) async fn api_claude_accounts_autoswitch_put(&self, r: &mut Req) -> Response {
        let w = tri!(self.claude_ready());
        let raw: RawMessage = tri!(read_json_body(r).await);
        let auto = w.auto.clone();
        let v = tri!(blocking(move || auto.put(&raw.0)).await);
        ok_json(&v)
    }

    // ── 계정별 실행 (묶음 H) ─────────────────────────────────────────────────

    /// Go `claudePruneTabs`: 도구 목록을 아는 때에만, 살아 있지 않은 도구의 탭 지정을 지운다
    /// (FR-CAC-81a). 목록을 모르는 동안(데몬 재접속 창)에는 지우지 않는다.
    async fn claude_prune_tabs(&self, w: &ClaudeAcctWire) {
        let Some(tools) = self.deps.tools.clone() else {
            return;
        };
        let svc = w.svc.clone();
        let changed = off_thread(move || {
            let live: std::collections::HashSet<String> =
                tools.list_ok()?.into_iter().map(|t| t.id).collect();
            Some(svc.prune_tabs(|id| live.contains(id)))
        })
        .await
        .flatten();
        match changed {
            Some(Ok(true)) => self.claude_accounts_changed(),
            Some(Err(e)) => infof!(None, "claude-accounts: 탭 지정을 정리하지 못했다: {e}"),
            _ => {}
        }
    }

    async fn claude_mappings_reply(&self, w: &ClaudeAcctWire) -> Response {
        let svc = w.svc.clone();
        ok_json(&tri!(blocking(move || svc.mappings()).await))
    }

    pub(crate) async fn api_claude_accounts_mappings_get(&self, _r: &mut Req) -> Response {
        let w = tri!(self.claude_ready());
        self.claude_prune_tabs(w).await;
        self.claude_mappings_reply(w).await
    }

    /// Go `apiClaudeAccountsMappingsPut`: `{folder|toolId, accountId}` 하나를 고친다. accountId 가
    /// 비면 푼다.
    pub(crate) async fn api_claude_accounts_mappings_put(&self, r: &mut Req) -> Response {
        let w = tri!(self.claude_ready());
        let req: MappingReq = tri!(read_json_body(r).await);
        if req.folder.is_empty() == req.tool_id.is_empty() {
            return code_fail(
                StatusCode::BAD_REQUEST,
                apierr::CODE_CLAUDE_ACCOUNT_INVALID,
                "folder 와 toolId 중 하나만 주세요",
            );
        }
        let svc = w.svc.clone();
        tri!(
            blocking(move || if req.folder.is_empty() {
                svc.set_tab(&req.tool_id, &req.account_id)
            } else {
                svc.set_folder(&req.folder, &req.account_id)
            })
            .await
        );
        self.claude_accounts_changed();
        self.claude_mappings_reply(w).await
    }

    /// Go `apiClaudeAccountsResolve`: 해석만 한다. 프로필을 맞추지 않는다 (FR-CAC-88).
    pub(crate) async fn api_claude_accounts_resolve(&self, r: &mut Req) -> Response {
        let w = tri!(self.claude_ready());
        self.claude_prune_tabs(w).await;
        let (tool_id, cwd) = (r.q("toolId"), r.q("cwd"));
        let svc = w.svc.clone();
        ok_json(&tri!(blocking(move || svc.resolve(&tool_id, &cwd)).await))
    }

    /// Go `apiClaudeAccountsLaunch`: 해석하고, 계정이 있으면 프로필을 맞춘다. shim 이 부른다
    /// (FR-CAC-83·88).
    pub(crate) async fn api_claude_accounts_launch(&self, r: &mut Req) -> Response {
        let w = tri!(self.claude_ready());
        let req: LaunchReq = tri!(read_json_body(r).await);
        self.claude_prune_tabs(w).await;
        let svc = w.svc.clone();
        let res = tri!(blocking(move || svc.resolve(&req.tool_id, &req.cwd)).await);
        if res.account_id.is_empty() {
            return ok_json(&res);
        }
        let (svc, id) = (w.svc.clone(), res.account_id.clone());
        if let Some(Err(e)) = off_thread(move || svc.prepare_profile(&id)).await {
            infof!(None, "claude-accounts: 프로필을 맞추지 못했다: {e}");
            return code_fail(
                StatusCode::INTERNAL_SERVER_ERROR,
                apierr::CODE_INTERNAL,
                "profile preparation failed",
            );
        }
        ok_json(&res)
    }

    async fn claude_unclaimed_reply(&self, w: &ClaudeAcctWire) -> Response {
        let svc = w.svc.clone();
        let entries = tri!(blocking(move || svc.unclaimed()).await);
        ok_json(&Entries { entries })
    }

    /// Go `apiClaudeAccountsUnclaimed`: 보관 목록이다. 내용은 싣지 않는다 (FR-CAC-34a).
    pub(crate) async fn api_claude_accounts_unclaimed(&self, _r: &mut Req) -> Response {
        let w = tri!(self.claude_ready());
        self.claude_unclaimed_reply(w).await
    }

    pub(crate) async fn api_claude_accounts_unclaimed_remove(&self, r: &mut Req) -> Response {
        let w = tri!(self.claude_ready());
        let req: NameReq = tri!(read_json_body(r).await);
        let svc = w.svc.clone();
        tri!(blocking(move || svc.remove_unclaimed(&req.name)).await);
        self.claude_accounts_changed();
        self.claude_unclaimed_reply(w).await
    }
}
