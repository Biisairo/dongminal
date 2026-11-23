//! 자동 전환 (FR-CAC-70~79). 설정과 상태는 autoswitch.json 이다.

use std::collections::BTreeMap;
use std::io;
use std::sync::{Arc, LazyLock, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use dm_gocompat::json::{self, RawMessage, is_empty};
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use tokio_util::sync::CancellationToken;

use crate::alerts::{ALERT_AUTOSWITCH, ALERT_AUTOSWITCH_STOPPED, Alert};
use crate::creds::Credential;
use crate::engine::{Engine, JitterFn, OnChangeFn};
use crate::error::{Error, Sentinel};
use crate::fsutil;
use crate::history::{
    BY_AUTO, TRIGGER_AT_LIMIT, TRIGGER_CONSUME_FIRST, TRIGGER_FAILOVER, TRIGGER_PRIORITY,
    TRIGGER_PROACTIVE,
};
use crate::live::write_secret_file;
use crate::policy::{ESCALATION_MARGIN, RESET_SLACK_S};
use crate::service::Clock;
use crate::smart::{MODELS_ALL, model_set};
use crate::store::{Account, AutoRange, State, THRESHOLD_MAX, THRESHOLD_MIN};
use crate::usage::{Binding, Models, binding_of};
use crate::view::display_name;
use crate::waker::Waker;

const AUTOSWITCH_FILE: &str = "autoswitch.json";
const AUTOSWITCH_SCHEMA: i64 = 1;
/// 꺼졌거나 막혔을 때 다시 보는 간격(초)이다.
const AUTO_IDLE_S: i64 = 300;
/// 다음 조회에 맞춰 당길 때의 최소 간격(초)이다.
const AUTO_MIN_S: f64 = 60.0;
/// 모두 소진됐을 때 잠드는 최대 시간(초)이다.
const AUTO_EXHAUSTED_MAX_S: i64 = 600;
/// 후보의 토큰이 이 안에 만료되면 전환 전에 갱신한다(초).
const AUTO_FRESHEN_BUFFER_S: i64 = 600;
/// 되돌아오기를 막는 데 쓰는 "쓴 만큼"(%p)이다.
const AUTO_SPENT_PCT: f64 = 3.0;
const AUTO_HORIZON_RATIO: f64 = 2.0;
/// 초기화 시각이 이만큼 앞당겨졌으면 회복으로 본다(초).
const AUTO_RECOVERY_S: i64 = 300;
/// cswap auto 확인(ps)을 이 동안 다시 하지 않는다 (GD-8).
pub(crate) const CSWAP_PROBE_TTL: time::Duration = time::Duration::minutes(1);

/// 자동 전환 전략 (FR-CAC-72).
pub const AUTO_STRATEGY_BEST: &str = "best";
pub const AUTO_STRATEGY_CONSUME_FIRST: &str = "consume-first";
pub const AUTO_STRATEGY_PRIORITY_CONSUME_FIRST: &str = "priority-consume-first";

/// 자동 전환 상태 (FR-CAC-76).
pub const AUTO_OFF: &str = "off";
pub const AUTO_ON: &str = "on";
pub const AUTO_UNMANAGED: &str = "unmanaged";
pub const AUTO_EXHAUSTED: &str = "exhausted";

/// 자동 전환 설정이다 (FR-CAC-70).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename = "claudeacct.AutoSettings")]
pub struct AutoSettings {
    pub enabled: bool,
    pub threshold: f64,
    #[serde(rename = "weeklyThreshold")]
    pub weekly_threshold: Option<f64>,
    #[serde(rename = "intervalSeconds")]
    pub interval_seconds: i64,
    #[serde(rename = "cooldownSeconds")]
    pub cooldown_seconds: i64,
    #[serde(rename = "hysteresisPct")]
    pub hysteresis_pct: f64,
    pub strategy: String,
    #[serde(rename = "unhealthyTicks")]
    pub unhealthy_ticks: i64,
    pub models: Option<Vec<String>>,
}

impl Default for AutoSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            threshold: 90.0,
            weekly_threshold: None,
            interval_seconds: 60,
            cooldown_seconds: 300,
            hysteresis_pct: 10.0,
            strategy: AUTO_STRATEGY_BEST.to_owned(),
            unhealthy_ticks: 3,
            models: None,
        }
    }
}

/// FR-CAC-70 의 숫자 칸 범위다. 키는 AutoSettings 의 JSON 이름이다. 범위의 원천은 이 표
/// 하나다 (REFACTOR3_FE_REST1_SRS FR-FR1-12).
pub static AUTO_RANGES: LazyLock<BTreeMap<&'static str, AutoRange>> = LazyLock::new(|| {
    let r = |min, max| AutoRange { min, max };
    BTreeMap::from([
        ("threshold", r(THRESHOLD_MIN, THRESHOLD_MAX)),
        ("weeklyThreshold", r(THRESHOLD_MIN, THRESHOLD_MAX)),
        ("intervalSeconds", r(15.0, 3600.0)),
        ("cooldownSeconds", r(0.0, 86400.0)),
        ("hysteresisPct", r(0.0, 50.0)),
        ("unhealthyTicks", r(1.0, 100.0)),
    ])
});

impl AutoSettings {
    /// 범위와 전략을 본다.
    pub fn validate(&self) -> Result<(), Error> {
        let r = &*AUTO_RANGES;
        let ok = r["threshold"].has(self.threshold)
            && self
                .weekly_threshold
                .is_none_or(|w| r["weeklyThreshold"].has(w))
            && r["intervalSeconds"].has(self.interval_seconds as f64)
            && r["cooldownSeconds"].has(self.cooldown_seconds as f64)
            && r["hysteresisPct"].has(self.hysteresis_pct)
            && r["unhealthyTicks"].has(self.unhealthy_ticks as f64)
            && matches!(
                self.strategy.as_str(),
                AUTO_STRATEGY_BEST
                    | AUTO_STRATEGY_CONSUME_FIRST
                    | AUTO_STRATEGY_PRIORITY_CONSUME_FIRST
            )
            && self.models.iter().flatten().all(|m| !m.trim().is_empty());
        if ok {
            Ok(())
        } else {
            Err(Sentinel::Invalid.into())
        }
    }

    fn models_set(&self) -> Models {
        model_set(self.models.as_deref().unwrap_or_default())
    }
}

/// 마지막 자동 전환이다 (FR-CAC-74).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename = "claudeacct.LastSwitch")]
pub struct LastSwitch {
    pub at: i64,
    pub from: String,
    pub to: String,
    pub trigger: String,
    #[serde(rename = "leftHeadroom")]
    pub left_headroom: Option<f64>,
    #[serde(rename = "leftRecoveryAt", skip_serializing_if = "is_empty")]
    pub left_recovery_at: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename = "claudeacct.AutoState")]
pub struct AutoState {
    #[serde(rename = "lastSwitch", skip_serializing_if = "is_empty")]
    pub last_switch: Option<LastSwitch>,
    /// 다시 로그인해야 하는 계정과 그때의 지문이다 (FR-CAC-75).
    #[serde(skip_serializing_if = "is_empty")]
    pub quarantined: BTreeMap<String, String>,
    #[serde(skip_serializing_if = "is_empty")]
    pub unhealthy: i64,
    /// 보낸 알림의 억제 키와 시각이다 (FR-CAC-100a).
    #[serde(skip_serializing_if = "is_empty")]
    pub notified: BTreeMap<String, i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename = "claudeacct.autoFile")]
struct AutoFile {
    #[serde(rename = "schemaVersion")]
    schema_version: i64,
    settings: AutoSettings,
    state: AutoState,
}

impl Default for AutoFile {
    fn default() -> Self {
        Self {
            schema_version: AUTOSWITCH_SCHEMA,
            settings: AutoSettings::default(),
            state: AutoState::default(),
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct AutoStateView {
    pub status: String,
    #[serde(rename = "lastSwitch", skip_serializing_if = "is_empty")]
    pub last_switch: Option<LastSwitch>,
    pub quarantined: Vec<String>,
    #[serde(rename = "nextTickAt", skip_serializing_if = "is_empty")]
    pub next_tick_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AutoView {
    pub settings: AutoSettings,
    pub state: AutoStateView,
    /// 숫자 칸의 범위 (FR-FR1-12).
    pub ranges: BTreeMap<&'static str, AutoRange>,
}

/// 실행 중인 프로세스의 명령줄들이다.
pub type ProcsFn = Arc<dyn Fn() -> Result<Vec<String>, String> + Send + Sync>;
pub type NotifyFn = Arc<dyn Fn(&Alert) + Send + Sync>;

#[derive(Default)]
pub(crate) struct AutoInner {
    file: AutoFile,
    status: String,
    next_tick_at: i64,
    probe_at: Option<OffsetDateTime>,
    probe_hit: bool,
}

impl AutoInner {
    pub(crate) fn file_state(&mut self) -> &mut AutoState {
        &mut self.file.state
    }
}

pub struct Auto {
    pub eng: Arc<Engine>,
    pub now: Clock,
    pub jitter: Option<JitterFn>,
    pub procs: Option<ProcsFn>,
    pub notify: Option<NotifyFn>,
    pub on_change: Option<OnChangeFn>,
    pub(crate) inner: Mutex<AutoInner>,
    busy: tokio::sync::Mutex<()>,
    wake: Waker,
}

/// 회차의 결과.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Outcome {
    NoAction,
    Blocked,
    Exhausted,
    Idle,
}

/// 판단에 쓰는 계정 하나의 모습이다.
#[derive(Debug, Clone, Default)]
pub(crate) struct AcctView {
    pub(crate) acc: Account,
    pub(crate) h: f64,
    pub(crate) b: Binding,
    pub(crate) has_b: bool,
    pub(crate) known: bool,
    /// 주간 창 초기화 (모르면 0).
    pub(crate) reset: i64,
}

impl AcctView {
    fn lh(&self) -> f64 {
        if self.has_b {
            self.b.line_headroom
        } else {
            self.h
        }
    }

    pub(crate) fn over(&self) -> bool {
        self.has_b && self.b.over
    }

    fn recovery_at(&self, now: i64) -> i64 {
        if self.has_b && self.b.resets_at > now {
            self.b.resets_at
        } else {
            0
        }
    }
}

/// 명령줄들 가운데 cswap auto(드라이런 아님)가 있는가다 (FR-CAC-77).
pub fn cswap_auto_running(cmdlines: &[String]) -> bool {
    for line in cmdlines {
        let f: Vec<&str> = line.split_whitespace().collect();
        for i in 0..f.len().saturating_sub(1) {
            let base = dm_gocompat::filepath::base(f[i]);
            let prev = if i > 0 {
                dm_gocompat::filepath::base(f[i - 1])
            } else {
                String::new()
            };
            let entry = (base == "cswap" || base == "claude-swap")
                && (i == 0 || prev.starts_with("python"));
            let module = f[i] == "claude_swap" && prev == "-m";
            if (entry || module) && f[i + 1] == "auto" && !f[i + 2..].contains(&"--dry-run") {
                return true;
            }
        }
    }
    false
}

fn strict<T: serde::de::DeserializeOwned>(v: &RawMessage) -> Result<T, Error> {
    json::Decoder::new()
        .decode(&v.0)
        .map_err(|_| Error::from(Sentinel::Invalid))
}

fn apply_auto_key(s: &mut AutoSettings, k: &str, v: &RawMessage) -> Result<(), Error> {
    let is_null = v.0.trim_ascii() == b"null";
    match k {
        "enabled" => s.enabled = strict(v)?,
        "threshold" => s.threshold = strict(v)?,
        "weeklyThreshold" => s.weekly_threshold = if is_null { None } else { Some(strict(v)?) },
        "intervalSeconds" => s.interval_seconds = strict(v)?,
        "cooldownSeconds" => s.cooldown_seconds = strict(v)?,
        "hysteresisPct" => s.hysteresis_pct = strict(v)?,
        "strategy" => s.strategy = strict(v)?,
        "unhealthyTicks" => s.unhealthy_ticks = strict(v)?,
        "models" => {
            if is_null {
                s.models = None;
            } else if let Ok(one) = json::unmarshal::<String>(&v.0) {
                if !one.eq_ignore_ascii_case(MODELS_ALL) {
                    return Err(Sentinel::Invalid.into());
                }
                s.models = Some(vec![MODELS_ALL.to_owned()]);
            } else {
                s.models = Some(strict(v)?);
            }
        }
        _ => {
            return Err(Error::with_detail(
                Sentinel::Invalid,
                format!("모르는 키 {}", dm_gocompat::strconv::quote(k)),
            ));
        }
    }
    Ok(())
}

fn or_inf(ts: i64) -> f64 {
    if ts <= 0 { f64::INFINITY } else { ts as f64 }
}

fn all_above_margin_met(cand: f64, active: f64) -> bool {
    cand >= (active * AUTO_HORIZON_RATIO).min(active + AUTO_SPENT_PCT)
}

/// 이번 회차에 옮길 까닭이다. 없으면 "".
pub(crate) fn auto_trigger(active: &AcctView, s: &AutoSettings, unhealthy: i64) -> &'static str {
    if !active.known {
        return if unhealthy < s.unhealthy_ticks {
            ""
        } else {
            TRIGGER_FAILOVER
        };
    }
    if active.over() && active.h <= 0.0 {
        TRIGGER_AT_LIMIT
    } else if active.over() {
        TRIGGER_PROACTIVE
    } else if s.strategy == AUTO_STRATEGY_CONSUME_FIRST {
        TRIGGER_CONSUME_FIRST
    } else if s.strategy == AUTO_STRATEGY_PRIORITY_CONSUME_FIRST {
        TRIGGER_PRIORITY
    } else {
        ""
    }
}

/// 쿨다운 안인가다. at-limit·failover 는 쿨다운을 보지 않는다 (FR-CAC-73).
pub(crate) fn in_cooldown(
    trigger: &str,
    last: Option<&LastSwitch>,
    now: i64,
    cooldown_s: i64,
) -> bool {
    trigger != TRIGGER_AT_LIMIT
        && trigger != TRIGGER_FAILOVER
        && last.is_some_and(|l| now - l.at < cooldown_s)
}

/// 후보를 옮길 순서로 줄 세운다. 조건에 맞지 않는 후보는 뺀다 (FR-CAC-71·72).
pub(crate) fn rank(
    trigger: &str,
    s: &AutoSettings,
    active: &AcctView,
    cands: &[AcctView],
    barred: &str,
) -> Vec<AcctView> {
    let consume = s.strategy == AUTO_STRATEGY_CONSUME_FIRST;
    let measured: Vec<&AcctView> = cands.iter().filter(|c| c.known).collect();
    let mut all_above = !measured.is_empty() && measured.iter().all(|c| c.over());
    if trigger != TRIGGER_AT_LIMIT && trigger != TRIGGER_FAILOVER {
        all_above = all_above && active.over();
    }
    let mut q: Vec<((f64, f64), &AcctView)> = Vec::new();
    for c in cands {
        if !c.known || c.h <= 0.0 || c.acc.id == barred {
            continue;
        }
        if trigger == TRIGGER_PROACTIVE || trigger == TRIGGER_CONSUME_FIRST {
            if c.over() && !all_above {
                continue;
            } else if all_above {
                if !all_above_margin_met(c.h, active.h) {
                    continue;
                }
            } else if consume {
                if trigger == TRIGGER_CONSUME_FIRST
                    && (c.reset == 0 || active.reset == 0 || c.reset >= active.reset)
                {
                    continue;
                }
            } else if active.known && c.lh() - active.lh() < s.hysteresis_pct {
                continue;
            }
        }
        let k = if all_above {
            (-c.h, or_inf(c.b.resets_at))
        } else if consume {
            (or_inf(c.reset), -c.lh())
        } else {
            (-c.lh(), 0.0)
        };
        q.push((k, c));
    }
    q.sort_by(|x, y| x.0.partial_cmp(&y.0).unwrap_or(std::cmp::Ordering::Equal));
    q.into_iter().map(|(_, v)| v.clone()).collect()
}

/// priority-consume-first 의 순서다: 우선순위가 높은 것, 같으면 주간 초기화가 이른 것.
pub(crate) fn rank_priority(active: &AcctView, cands: &[AcctView]) -> Vec<AcctView> {
    let ahead = |c: &AcctView| {
        if c.acc.priority != active.acc.priority {
            c.acc.priority > active.acc.priority
        } else {
            or_inf(c.reset) < or_inf(active.reset)
        }
    };
    let active_ready = active.known && active.h > 0.0 && !active.over();
    let mut q: Vec<AcctView> = cands
        .iter()
        .filter(|c| c.known && c.h > 0.0 && !c.over() && (!active_ready || ahead(c)))
        .cloned()
        .collect();
    q.sort_by(|x, y| {
        y.acc.priority.cmp(&x.acc.priority).then_with(|| {
            or_inf(x.reset)
                .partial_cmp(&or_inf(y.reset))
                .unwrap_or(std::cmp::Ordering::Equal)
        })
    });
    q
}

impl Auto {
    pub fn new(eng: Arc<Engine>, now: Clock) -> Self {
        Self {
            eng,
            now,
            jitter: None,
            procs: None,
            notify: None,
            on_change: None,
            inner: Mutex::new(AutoInner::default()),
            busy: tokio::sync::Mutex::new(()),
            wake: Waker::default(),
        }
    }

    pub(crate) fn lock(&self) -> MutexGuard<'_, AutoInner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub(crate) fn now_unix(&self) -> i64 {
        (self.now)().unix_timestamp()
    }

    /// autoswitch.json 을 읽는다. 깨졌거나 범위를 벗어난 파일은 기본값으로 시작한다.
    pub fn load(&self) -> Result<(), Error> {
        let mut g = self.lock();
        g.file = AutoFile::default();
        let path = self.eng.svc.dir.join(AUTOSWITCH_FILE);
        let b = match fsutil::read_file(&path) {
            Ok(b) => b,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(e.into()),
        };
        match json::unmarshal::<AutoFile>(&b) {
            Ok(mut f) if f.settings.validate().is_ok() => {
                f.schema_version = AUTOSWITCH_SCHEMA;
                g.file = f;
            }
            _ => dm_shared_dmlog::infof!(
                None,
                "claude-accounts: {AUTOSWITCH_FILE} 가 깨졌다 — 기본값으로 시작한다"
            ),
        }
        Ok(())
    }

    pub(crate) fn save_locked(&self, g: &AutoInner) {
        let Ok(b) = json::marshal_indent(&g.file, "", "  ") else {
            return;
        };
        let _lock = match self.eng.svc.store.lock() {
            Ok(l) => l,
            Err(e) => {
                dm_shared_dmlog::infof!(None, "claude-accounts: {AUTOSWITCH_FILE} 락 실패: {e}");
                return;
            }
        };
        if let Err(e) = write_secret_file(&self.eng.svc.dir.join(AUTOSWITCH_FILE), &b) {
            dm_shared_dmlog::infof!(None, "claude-accounts: {AUTOSWITCH_FILE} 쓰기 실패: {e}");
        }
    }

    fn changed(&self) {
        if let Some(f) = &self.on_change {
            f();
        }
    }

    pub(crate) fn settings(&self) -> AutoSettings {
        self.lock().file.settings.clone()
    }

    /// 판단에 넣을 모델 이름이다. Engine 의 `models` 로 잇는다.
    pub fn models(&self) -> Vec<String> {
        self.settings().models.unwrap_or_default()
    }

    /// 계정의 라인이다: 계정 문턱값, 없으면 설정의 문턱값. Engine 의 `line_for` 로 잇는다.
    pub fn line_for(&self, acc: &Account) -> f64 {
        acc.threshold.unwrap_or_else(|| self.settings().threshold)
    }

    /// 화면에 보낼 설정·상태·범위다.
    pub fn view(&self) -> AutoView {
        let g = self.lock();
        let status = if !g.file.settings.enabled {
            AUTO_OFF.to_owned()
        } else if g.status.is_empty() || g.status == AUTO_OFF {
            AUTO_ON.to_owned()
        } else {
            g.status.clone()
        };
        let mut settings = g.file.settings.clone();
        if settings.models.as_ref().is_some_and(Vec::is_empty) {
            settings.models = None;
        }
        AutoView {
            settings,
            state: AutoStateView {
                status,
                last_switch: g.file.state.last_switch.clone(),
                quarantined: g.file.state.quarantined.keys().cloned().collect(),
                next_tick_at: g.next_tick_at,
            },
            ranges: AUTO_RANGES.clone(),
        }
    }

    /// 설정의 일부를 고친다. 모르는 키·범위 밖·형식 오류는 Invalid, 켤 때 cswap auto 가 돌고
    /// 있으면 CswapRunning 이다 (FR-CAC-70·77).
    pub fn put(&self, raw: &[u8]) -> Result<AutoView, Error> {
        let m = match json::unmarshal::<Option<BTreeMap<String, RawMessage>>>(raw) {
            Ok(Some(m)) => m,
            _ => return Err(Sentinel::Invalid.into()),
        };
        let mut next = self.settings();
        for (k, v) in &m {
            apply_auto_key(&mut next, k, v)?;
        }
        next.validate()?;
        if next.enabled && !self.settings().enabled && self.cswap_running(true) {
            return Err(Sentinel::CswapRunning.into());
        }
        {
            let mut g = self.lock();
            if next.enabled != g.file.settings.enabled {
                g.file.state.unhealthy = 0;
                g.probe_at = None;
            }
            g.file.settings = next;
            self.save_locked(&g);
        }
        self.wake();
        self.changed();
        Ok(self.view())
    }

    fn cswap_running(&self, fresh: bool) -> bool {
        let Some(procs) = &self.procs else {
            return false;
        };
        if fresh {
            return procs().is_ok_and(|l| cswap_auto_running(&l));
        }
        let now = (self.now)();
        {
            let g = self.lock();
            if let Some(at) = g.probe_at
                && now - at < CSWAP_PROBE_TTL
            {
                return g.probe_hit;
            }
        }
        let Ok(lines) = procs() else {
            return false;
        };
        let hit = cswap_auto_running(&lines);
        let mut g = self.lock();
        g.probe_at = Some(now);
        g.probe_hit = hit;
        hit
    }

    fn jitter(&self) -> f64 {
        match &self.jitter {
            Some(f) => f(),
            None => self.eng.jitter(),
        }
    }

    /// 기다리던 [`Auto::run`] 을 바로 깨운다.
    pub fn wake(&self) {
        self.wake.wake();
    }

    /// stop 이 끊길 때까지 회차를 돈다.
    pub async fn run(&self, stop: CancellationToken) {
        self.wake
            .run(
                stop,
                Duration::ZERO,
                |ctx| async move { self.tick(&ctx).await },
            )
            .await;
    }

    /// 자동 전환 회차 하나다. 다음 회차까지 기다릴 시간을 돌려준다 (FR-CAC-71~76).
    pub async fn tick(&self, ctx: &CancellationToken) -> Duration {
        let _busy = self.busy.lock().await;
        if self.settings().enabled && self.cswap_running(false) {
            {
                let mut g = self.lock();
                g.file.settings.enabled = false;
                self.save_locked(&g);
            }
            self.notify(Alert {
                kind: ALERT_AUTOSWITCH_STOPPED.to_owned(),
                ..Alert::default()
            });
            self.changed();
        }
        let Ok(mut st) = self.eng.svc.store.load() else {
            return Duration::from_secs(AUTO_IDLE_S as u64);
        };
        self.release_quarantine(&st);
        let s = self.settings();
        let (status, out, sleep_to, switched) = if s.enabled {
            self.decide(ctx, &st, &s).await
        } else {
            (AUTO_OFF, Outcome::Idle, 0, false)
        };
        let mut loaded = true;
        if switched {
            match self.eng.svc.store.load() {
                Ok(s2) => st = s2,
                Err(_) => loaded = false,
            }
        }
        if loaded {
            self.evaluate_alerts(&st, &s);
        }
        let d = self.delay(&st, &s, out, sleep_to);
        let prev = {
            let mut g = self.lock();
            let prev = std::mem::replace(&mut g.status, status.to_owned());
            g.next_tick_at = ((self.now)() + d).unix_timestamp();
            prev
        };
        if prev != status {
            self.changed();
        }
        d
    }

    fn delay(&self, st: &State, s: &AutoSettings, out: Outcome, sleep_to: i64) -> Duration {
        let now = self.now_unix();
        match out {
            Outcome::Exhausted => {
                let d = if sleep_to > now {
                    (sleep_to - now).min(AUTO_EXHAUSTED_MAX_S)
                } else {
                    AUTO_EXHAUSTED_MAX_S
                };
                return Duration::from_secs(d as u64);
            }
            Outcome::Blocked | Outcome::Idle => {
                return Duration::from_secs(s.interval_seconds.max(AUTO_IDLE_S) as u64);
            }
            Outcome::NoAction => {}
        }
        let mut d = s.interval_seconds as f64 * (1.0 + 0.1 * self.jitter());
        let r = self.eng.row(&st.active_id);
        if r.next_poll_at > now && ((r.next_poll_at - now) as f64) < d {
            d = ((r.next_poll_at - now) as f64).max(AUTO_MIN_S);
        }
        Duration::from_secs_f64(d.max(0.0))
    }

    pub(crate) fn notify(&self, al: Alert) {
        if let Some(f) = &self.notify {
            f(&al);
        }
    }

    /// 백업이 바뀐(다시 로그인한) 격리 계정과 지워진 계정을 풀어 준다.
    fn release_quarantine(&self, st: &State) {
        let q = self.lock().file.state.quarantined.clone();
        if q.is_empty() {
            return;
        }
        let drop: Vec<String> = q
            .iter()
            .filter(|(id, fp)| {
                st.find(id).is_none()
                    || matches!(self.eng.svc.backup.read(id), Ok(Some(c)) if c.fingerprint() != **fp)
            })
            .map(|(id, _)| id.clone())
            .collect();
        if drop.is_empty() {
            return;
        }
        {
            let mut g = self.lock();
            for id in &drop {
                g.file.state.quarantined.remove(id);
            }
            self.save_locked(&g);
        }
        self.changed();
    }

    fn quarantine(&self, id: &str, c: &Credential) {
        {
            let mut g = self.lock();
            g.file
                .state
                .quarantined
                .insert(id.to_owned(), c.fingerprint());
            self.save_locked(&g);
        }
        self.changed();
    }

    pub(crate) fn acct_view(&self, acc: &Account, s: &AutoSettings, models: &Models) -> AcctView {
        let mut v = AcctView {
            acc: acc.clone(),
            ..AcctView::default()
        };
        let Some(u) = self.eng.decision_usage(acc) else {
            return v;
        };
        v.h = u.headroom(models);
        v.known = true;
        let (thr, weekly) = match acc.threshold {
            Some(t) => (t, None),
            None => (s.threshold, s.weekly_threshold),
        };
        if let Some(b) = binding_of(&u, models, thr, weekly, s.threshold) {
            v.b = b;
            v.has_b = true;
        }
        if let Some(w) = u.seven_day
            && w.resets_at > self.now_unix()
        {
            v.reset = w.resets_at;
        }
        v
    }

    /// 활성 계정이 라인 가까이 왔는가다. 값을 모르면 참이다.
    fn escalate(&self, acc: &Account, s: &AutoSettings, models: &Models) -> bool {
        let Some(u) = self.eng.decision_usage(acc) else {
            return true;
        };
        let (thr, weekly) = match acc.threshold {
            Some(t) => (t, None),
            None => (s.threshold, s.weekly_threshold),
        };
        u.labeled(models).iter().any(|w| {
            let line = match weekly {
                Some(wk) if !w.five => wk,
                _ => thr,
            };
            w.window.pct >= line - ESCALATION_MARGIN
        })
    }

    async fn decide(
        &self,
        ctx: &CancellationToken,
        st: &State,
        s: &AutoSettings,
    ) -> (&'static str, Outcome, i64, bool) {
        let Some(i) = st
            .find(&st.active_id)
            .filter(|i| self.eng.live_is_account(&st.accounts[*i]))
        else {
            return (AUTO_UNMANAGED, Outcome::Idle, 0, false);
        };
        let models = s.models_set();
        let active_acc = &st.accounts[i];
        if self.escalate(active_acc, s, &models) {
            self.eng.refresh_stale(st).await;
        }
        let active = self.acct_view(active_acc, s, &models);
        let unhealthy = if active.known {
            self.set_unhealthy(0)
        } else {
            self.set_unhealthy(-1)
        };
        let trigger = auto_trigger(&active, s, if active.known { 0 } else { unhealthy });
        if trigger.is_empty() {
            return (AUTO_ON, Outcome::NoAction, 0, false);
        }
        let now = self.now_unix();
        let last = self.lock().file.state.last_switch.clone();
        if in_cooldown(trigger, last.as_ref(), now, s.cooldown_seconds) {
            return (AUTO_ON, Outcome::NoAction, 0, false);
        }
        let cands = self.candidates(st, s, &models);
        if cands.is_empty() {
            return (AUTO_ON, Outcome::Blocked, 0, false);
        }
        let ordered = self.rank_with_bar(trigger, s, &active, &cands, last.as_ref(), now);
        if ordered.is_empty() {
            let exhausted = cands.iter().all(|c| c.known && c.h <= 0.0);
            if !exhausted || trigger == TRIGGER_CONSUME_FIRST || trigger == TRIGGER_PRIORITY {
                return (AUTO_ON, Outcome::Blocked, 0, false);
            }
            let mut all = cands.clone();
            all.push(active.clone());
            return (
                AUTO_EXHAUSTED,
                Outcome::Exhausted,
                earliest_recovery(&all, now),
                false,
            );
        }
        if self
            .switch_first(ctx, &ordered, trigger, active_acc, &active, now)
            .await
        {
            return (AUTO_ON, Outcome::NoAction, 0, true);
        }
        (AUTO_ON, Outcome::Blocked, 0, false)
    }

    async fn switch_first(
        &self,
        _ctx: &CancellationToken,
        ordered: &[AcctView],
        trigger: &str,
        active_acc: &Account,
        active: &AcctView,
        now: i64,
    ) -> bool {
        for c in ordered {
            if !self.freshen(&c.acc).await {
                continue;
            }
            let res = match self.eng.switch_to(&c.acc.id, trigger, BY_AUTO).await {
                Ok(r) => r,
                Err(e) => {
                    dm_shared_dmlog::infof!(None, "claude-accounts: 자동 전환 실패: {e}");
                    continue;
                }
            };
            let ls = LastSwitch {
                at: now,
                from: res.from,
                to: res.to,
                trigger: trigger.to_owned(),
                left_headroom: active.known.then_some(active.h),
                left_recovery_at: active.recovery_at(now),
            };
            {
                let mut g = self.lock();
                g.file.state.last_switch = Some(ls);
                self.save_locked(&g);
            }
            self.notify(Alert {
                kind: ALERT_AUTOSWITCH.to_owned(),
                from: display_name(active_acc),
                to: display_name(&c.acc),
                trigger: trigger.to_owned(),
                ..Alert::default()
            });
            self.eng.wake();
            self.changed();
            return true;
        }
        false
    }

    /// 옮겨 갈 수 있는 계정들이다: 활성·제외·격리·막힘·프로필 실행 중이 아닌 것 (FR-CAC-87).
    pub(crate) fn candidates(
        &self,
        st: &State,
        s: &AutoSettings,
        models: &Models,
    ) -> Vec<AcctView> {
        let quarantined = self.lock().file.state.quarantined.clone();
        st.accounts
            .iter()
            .filter(|acc| {
                acc.id != st.active_id
                    && !acc.disabled
                    && quarantined.get(&acc.id).is_none_or(String::is_empty)
                    && self.eng.row(&acc.id).auth_dead_fp.is_empty()
                    && !self.eng.svc.pinned_running(&acc.id)
            })
            .map(|acc| self.acct_view(acc, s, models))
            .collect()
    }

    /// n 이 음수면 하나 늘리고, 아니면 n 으로 둔다. 바뀌었으면 쓴다.
    fn set_unhealthy(&self, n: i64) -> i64 {
        let mut g = self.lock();
        let next = if n < 0 { g.file.state.unhealthy + 1 } else { n };
        if next != g.file.state.unhealthy {
            g.file.state.unhealthy = next;
            self.save_locked(&g);
        }
        next
    }

    /// 후보의 토큰을 미리 갱신한다. 영구 실패면 격리한다 (FR-CAC-75).
    async fn freshen(&self, acc: &Account) -> bool {
        let c = match self.eng.svc.backup.read(&acc.id) {
            Ok(Some(c)) if !c.is_empty() => c,
            _ => return false,
        };
        if c.expires_at() / 1000 - self.now_unix() > AUTO_FRESHEN_BUFFER_S {
            return true;
        }
        match self.eng.refresh(acc, false, true).await {
            Ok(_) => true,
            Err((_, e)) => {
                if e.is(Sentinel::ReloginRequired) {
                    self.quarantine(&acc.id, &c);
                }
                false
            }
        }
    }

    fn rank_with_bar(
        &self,
        trigger: &str,
        s: &AutoSettings,
        active: &AcctView,
        cands: &[AcctView],
        last: Option<&LastSwitch>,
        now: i64,
    ) -> Vec<AcctView> {
        if s.strategy == AUTO_STRATEGY_PRIORITY_CONSUME_FIRST {
            return rank_priority(active, cands);
        }
        let mut barred = String::new();
        let mut recovered = false;
        if (trigger == TRIGGER_PROACTIVE || trigger == TRIGGER_CONSUME_FIRST)
            && let Some(last) = last
            && last.to == active.acc.id
        {
            barred = last.from.clone();
            for c in cands.iter().filter(|c| c.acc.id == last.from && c.known) {
                recovered = last
                    .left_headroom
                    .is_some_and(|l| c.h >= l + AUTO_SPENT_PCT)
                    || (last.left_recovery_at > 0
                        && c.recovery_at(now) > 0
                        && c.recovery_at(now) <= last.left_recovery_at - AUTO_RECOVERY_S);
                if recovered && active.known && all_above_margin_met(c.h, active.h) {
                    barred.clear();
                }
            }
        }
        let ranked = rank(trigger, s, active, cands, &barred);
        if !barred.is_empty() && ranked.is_empty() && recovered {
            return rank(trigger, s, active, cands, "");
        }
        ranked
    }
}

fn earliest_recovery(vs: &[AcctView], now: i64) -> i64 {
    vs.iter()
        .map(|v| v.recovery_at(now))
        .filter(|r| *r > 0)
        .min()
        .map_or(0, |r| r + RESET_SLACK_S)
}
