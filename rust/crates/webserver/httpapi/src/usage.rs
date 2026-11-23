//! 도구별 사용량과 계정 한도 (Go `handlers_usage.go`, `handlers_limits.go` 의 저장소, `server_state.go`
//! 의 `agentState`).
//!
//! `dmctl statusline`(프록시)이 Claude Code 의 statusLine 입력에서 꺼낸 값을 보낸다. 받는 꼴은
//! 타입으로 고정한 허용 목록(`statusline::Usage`)이다 (FR-SLP-2a). 메모리에만 둔다.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Mutex;

use dm_shared_activity as activity;
use dm_shared_agentrec as agentrec;
use dm_shared_httpresp::Response;
use dm_shared_statusline as statusline;
use dm_shared_toolipc as toolipc;
use dm_webserver_apierr as apierr;
use dm_webserver_domain_run::ContextPolicy;
use http::StatusCode;
use serde::Serialize;
use time::OffsetDateTime;

use crate::Server;
use crate::httperr::{decode_json_body, http_err, write_json};
use crate::req::Req;
use crate::subagents::{CardSubagent, SubagentActivityStore, SubagentStore, card_subagents_of};

/// 도구 하나의 statusLine 사용량 관측이다 (Go `toolUsage`).
pub(crate) type ToolUsage = agentrec::Usage;

const CONTEXT_SOURCE_STATUS_LINE: &str = "statusline";
const CONTEXT_SOURCE_TRANSCRIPT: &str = "transcript";

/// resetsAt 이 이보다 크면 밀리초로 본다 (R-4).
const RESETS_AT_MILLIS_FLOOR: f64 = 1e12;

/// 앞에 세우는 창 이름이다. 나머지는 사전 순으로 뒤에 선다 (FR-ASV-21).
const LIMIT_WINDOW_ORDER: [&str; 2] = ["five_hour", "seven_day"];

pub(crate) fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

pub(crate) fn unix_milli(t: OffsetDateTime) -> i64 {
    i64::try_from(t.unix_timestamp_nanos().div_euclid(1_000_000)).unwrap_or(i64::MAX)
}

pub(crate) fn from_unix_milli(ms: i64) -> OffsetDateTime {
    OffsetDateTime::from_unix_timestamp_nanos(i128::from(ms) * 1_000_000)
        .unwrap_or(OffsetDateTime::UNIX_EPOCH)
}

/// Go `agentState`: 도구·에이전트별 메모리 상태다. 저장소마다 자기 잠금을 쥔다.
#[derive(Default)]
pub(crate) struct AgentStores {
    /// 도구별 statusLine 사용량 (FR-SLP-10).
    pub(crate) usage: UsageStore,
    /// 도구별 서브에이전트 목록 (FR-SAU-10).
    pub(crate) subagents: SubagentStore,
    /// 도구별 서브에이전트 활동(훅) (FR-ASV-10).
    pub(crate) sub_acts: SubagentActivityStore,
    /// 에이전트별 마지막 계정 한도 (FR-ASV-20). 도구가 죽어도 남는다.
    pub(crate) rate_limits: RateLimitStore,
    /// 「맥락 사용률을 모른다」 를 이미 알린 도구다 (FR-ITM-13).
    pub(crate) migration_unknown_told: Mutex<HashSet<String>>,
}

#[derive(Default)]
pub(crate) struct UsageStore {
    pub(crate) m: Mutex<HashMap<String, ToolUsage>>,
}

impl UsageStore {
    pub(crate) fn put(&self, tool_id: &str, v: ToolUsage) {
        lock(&self.m).insert(tool_id.to_owned(), v);
    }

    pub(crate) fn get(&self, tool_id: &str) -> Option<ToolUsage> {
        lock(&self.m).get(tool_id).cloned()
    }

    /// live 가 거짓인 도구의 사용량을 지우고 지운 수를 돌려준다. Run 수거 루프가 부른다.
    #[allow(dead_code)]
    pub(crate) fn prune(&self, live: impl Fn(&str) -> bool) -> usize {
        let mut m = lock(&self.m);
        let before = m.len();
        m.retain(|id, _| live(id));
        before - m.len()
    }
}

/// `dmctl status` 의 `context` 다 (FR-SLP-20).
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub(crate) struct ToolContext {
    #[serde(rename = "usedPct", skip_serializing_if = "Option::is_none")]
    pub(crate) used_pct: Option<f64>,
    #[serde(rename = "windowTokens", skip_serializing_if = "is_zero")]
    pub(crate) window_tokens: f64,
    #[serde(skip_serializing_if = "is_zero")]
    pub(crate) tokens: f64,
    pub(crate) source: String,
    #[serde(rename = "observedAt")]
    pub(crate) observed_at: i64,
}

fn is_zero(v: &f64) -> bool {
    *v == 0.0
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub(crate) struct LimitWindow {
    name: String,
    #[serde(rename = "usedPct", skip_serializing_if = "Option::is_none")]
    used_pct: Option<f64>,
    #[serde(rename = "resetsAt", skip_serializing_if = "Option::is_none")]
    resets_at: Option<f64>,
    #[serde(rename = "resetsInSec", skip_serializing_if = "Option::is_none")]
    resets_in_sec: Option<f64>,
    level: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub(crate) struct LimitEntry {
    pub(crate) agent: String,
    #[serde(rename = "observedAt")]
    pub(crate) observed_at: i64,
    pub(crate) windows: Vec<LimitWindow>,
}

#[derive(Clone)]
pub(crate) struct LimitObs {
    pub(crate) windows: BTreeMap<String, statusline::RateWindow>,
    pub(crate) observed_at: OffsetDateTime,
}

#[derive(Default)]
pub(crate) struct RateLimitStore {
    pub(crate) m: Mutex<BTreeMap<String, LimitObs>>,
}

impl RateLimitStore {
    /// 비어 있지 않은 한도로 그 에이전트의 마지막 값을 덮어쓴다 (FR-ASV-20).
    pub(crate) fn put(
        &self,
        agent: &str,
        windows: &BTreeMap<String, statusline::RateWindow>,
        at: OffsetDateTime,
    ) {
        if windows.is_empty() {
            return;
        }
        lock(&self.m).insert(
            agent.to_owned(),
            LimitObs {
                windows: windows.clone(),
                observed_at: at,
            },
        );
    }

    /// now 기준의 응답이다. 남은 시간은 서버 시계로 셈한다 (D-ASV-10). 비면 빈 배열이다.
    pub(crate) fn view(&self, now: OffsetDateTime) -> Vec<LimitEntry> {
        lock(&self.m)
            .iter()
            .map(|(agent, obs)| LimitEntry {
                agent: agent.clone(),
                observed_at: unix_milli(obs.observed_at),
                windows: limit_window_names(&obs.windows)
                    .into_iter()
                    .map(|name| limit_window_of(name, &obs.windows[name], now))
                    .collect(),
            })
            .collect()
    }

    /// Go `records`: 데몬에 쓰는 모양이다.
    pub(crate) fn records(&self) -> BTreeMap<String, agentrec::LimitRecord> {
        lock(&self.m)
            .iter()
            .map(|(agent, obs)| {
                (
                    agent.clone(),
                    agentrec::LimitRecord {
                        windows: Some(obs.windows.clone()),
                        observed_at: unix_milli(obs.observed_at),
                    },
                )
            })
            .collect()
    }

    /// Go `replace`: 스냅샷으로 통째로 바꾼다.
    pub(crate) fn replace(&self, recs: BTreeMap<String, agentrec::LimitRecord>) {
        let m = recs
            .into_iter()
            .map(|(agent, r)| {
                (
                    agent,
                    LimitObs {
                        windows: r.windows.unwrap_or_default(),
                        observed_at: from_unix_milli(r.observed_at),
                    },
                )
            })
            .collect();
        *lock(&self.m) = m;
    }
}

fn limit_window_names(windows: &BTreeMap<String, statusline::RateWindow>) -> Vec<&str> {
    let rank = |n: &str| {
        LIMIT_WINDOW_ORDER
            .iter()
            .position(|o| *o == n)
            .unwrap_or(LIMIT_WINDOW_ORDER.len())
    };
    let mut names: Vec<&str> = windows.keys().map(String::as_str).collect();
    names.sort_by(|a, b| rank(a).cmp(&rank(b)).then(a.cmp(b)));
    names
}

fn limit_window_of(name: &str, w: &statusline::RateWindow, now: OffsetDateTime) -> LimitWindow {
    let mut out = LimitWindow {
        name: name.to_owned(),
        used_pct: w.used_pct,
        resets_at: None,
        resets_in_sec: None,
        level: String::new(),
    };
    if let Some(pct) = w.used_pct {
        out.level = dm_webserver_domain_claudeacct::usage_level(pct).to_owned();
    }
    if let Some(mut at) = w.resets_at {
        if at > RESETS_AT_MILLIS_FLOOR {
            at /= 1000.0;
        }
        let left = go_max0(at - now.unix_timestamp() as f64);
        out.resets_at = Some(at);
        out.resets_in_sec = Some(left);
    }
    out
}

/// Go `max(0, x)`: NaN 은 NaN 이다.
fn go_max0(x: f64) -> f64 {
    if x.is_nan() || x > 0.0 { x } else { 0.0 }
}

/// 활동 목록 항목의 사용량 요약이다 (ACTIVITY_CARD_USAGE_SRS FR-ACU-2).
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub(crate) struct CardUsage {
    #[serde(rename = "ctxPct", skip_serializing_if = "Option::is_none")]
    pub(crate) ctx_pct: Option<f64>,
    #[serde(rename = "ctxLevel", skip_serializing_if = "String::is_empty")]
    pub(crate) ctx_level: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub(crate) model: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub(crate) effort: String,
}

/// Go `cardUsageOf`: 실을 값이 없으면 `None` 이다 (FR-ACU-4). 등급 경계는 맥락 정책의 것이다.
pub(crate) fn card_usage_of(
    c: Option<&ToolContext>,
    u: Option<&ToolUsage>,
    p: ContextPolicy,
) -> Option<CardUsage> {
    let mut out = CardUsage::default();
    if let Some(pct) = c.and_then(|c| c.used_pct) {
        out.ctx_pct = Some(pct);
        out.ctx_level = p.grade(pct / 100.0, 0).to_owned();
    }
    if let Some(u) = u {
        if let Some(m) = &u.usage.model {
            match (&m.display_name, &m.id) {
                (Some(d), _) if !d.is_empty() => out.model = d.clone(),
                (_, Some(id)) => out.model = id.clone(),
                _ => {}
            }
        }
        if let Some(e) = &u.usage.effort {
            out.effort = e.clone();
        }
    }
    (out != CardUsage::default()).then_some(out)
}

/// `GET /api/tools/activity` 의 항목이다. 앞 필드는 `ActivitySnap` 그대로다 (FR-ACU-1).
#[derive(Clone, Debug, Serialize)]
pub(crate) struct ActivityEntry {
    #[serde(rename = "toolId")]
    tool_id: String,
    state: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    tool: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    detail: String,
    #[serde(rename = "updatedAt")]
    updated_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    usage: Option<CardUsage>,
    /// 신선한 서브에이전트 목록이 비어 있지 않을 때만 선다 (FR-SAU-13).
    #[serde(skip_serializing_if = "Option::is_none")]
    subagents: Option<Vec<CardSubagent>>,
}

/// statusLine 목록에서 running 인 서브에이전트의 id 들이다 (D-ASV-14).
fn running_subagents(tasks: &[statusline::Subagent]) -> HashSet<String> {
    tasks
        .iter()
        .filter(|t| t.status.as_deref() == Some("running"))
        .map(|t| t.id.clone().unwrap_or_default())
        .collect()
}

#[derive(Serialize)]
struct OkAny {
    ok: bool,
}

impl Server {
    /// Go `contextPolicy`: 추정 공식과 임계를 설정에서 읽는다 (FR-CBG-2). 설정이 없으면 기본값이다.
    pub(crate) fn context_policy(&self) -> ContextPolicy {
        match &self.deps.settings {
            Some(s) => s.context_policy(),
            None => ContextPolicy::default_policy(),
        }
    }

    /// Go `callerToolID`: 누가 말하는가. PID 사슬 해석(`WhoAmI`)은 5.5.8 이 배선한다 — 그 전에는
    /// 주장한 id 다.
    pub(crate) fn caller_tool_id(&self, _r: &Req, claimed: &str) -> String {
        claimed.to_owned()
    }

    /// POST /api/tools/usage (FR-SLP-10).
    pub(crate) async fn api_tool_usage(&self, r: &mut Req) -> Response {
        let mut body: agentrec::UsageReport = match decode_json_body(r, 0).await {
            Ok(b) => b,
            Err(res) => return res,
        };
        body.tool_id = self.caller_tool_id(r, &body.tool_id);
        if body.tool_id.is_empty() {
            return http_err(
                "toolId required",
                StatusCode::BAD_REQUEST,
                apierr::CODE_MISSING_ARG,
            );
        }
        self.apply_usage_report(&body);
        write_json(&OkAny { ok: true })
    }

    /// Go `applyUsageReport`: 사용량 보고 하나다. HTTP 와 데몬의 report push 가 함께 지난다.
    pub(crate) fn apply_usage_report(&self, body: &agentrec::UsageReport) {
        let tool_id = &body.tool_id;
        let now = OffsetDateTime::now_utc();
        let u = ToolUsage {
            usage: body.usage.clone(),
            observed_at: unix_milli(now),
        };
        self.agents.usage.put(tool_id, u.clone());
        self.put_record(toolipc::RECORD_USAGE, tool_id, Some(&u));
        // FR-ASV-20: 계정 한도의 임자는 statusLine 을 보고하는 에이전트다. FR-CAC-78: 계정을 실은
        // 보고는 계정별로 둔다. 에이전트 단위 값은 계정을 모르는 보고만이다.
        let limits = u.usage.rate_limits.as_ref().filter(|l| !l.is_empty());
        let acc = body.account.as_ref().filter(|a| !a.email.is_empty());
        if let (Some(acc), Some(ca)) = (acc, &self.ca) {
            ca.sl.put(acc, u.usage.rate_limits.as_ref(), now);
        } else if let (Some(agent), Some(limits)) =
            (dm_shared_agentadapter::status_line_reporter(), limits)
        {
            self.agents.rate_limits.put(agent, limits, now);
            let recs = self.agents.rate_limits.records();
            self.put_record(toolipc::RECORD_LIMITS, "", Some(&recs));
        }
        self.observe_usage_context(tool_id, &u);
    }

    /// Go `toolUsageView`: 상태 응답에 얹을 `context`·`usage` 다. statusLine 값이 없으면 Run 기록의
    /// transcript 값으로 `context` 만 채운다 (FR-SLP-11).
    pub(crate) fn tool_usage_view(
        &self,
        tool_id: &str,
    ) -> (Option<ToolContext>, Option<ToolUsage>) {
        let Some(u) = self.agents.usage.get(tool_id) else {
            return (self.transcript_context(tool_id), None);
        };
        let mut c = ToolContext {
            source: CONTEXT_SOURCE_STATUS_LINE.to_owned(),
            observed_at: u.observed_at,
            ..ToolContext::default()
        };
        if let Some(cw) = &u.usage.context_window {
            c.used_pct = cw.used_pct;
            if let Some(w) = cw.window_tokens {
                c.window_tokens = w;
            }
        }
        if let Some(t) = u.context_tokens() {
            c.tokens = t;
        }
        (Some(c), Some(u))
    }

    /// Go `toolUsageView` 의 Run 기록 갈래.
    fn transcript_context(&self, tool_id: &str) -> Option<ToolContext> {
        let m = self.runs()?.member_by_tool(tool_id)?;
        if m.context.context_tokens <= 0 {
            return None;
        }
        Some(ToolContext {
            used_pct: Some(m.context.context_ratio * 100.0),
            window_tokens: m.context.context_limit,
            tokens: m.context.context_tokens as f64,
            source: CONTEXT_SOURCE_TRANSCRIPT.to_owned(),
            observed_at: m.context.context_at,
        })
    }

    /// Go `observeUsageContext`: Run 의 맥락 기록에도 공식 값을 넣는다 (FR-SLP-11·22).
    fn observe_usage_context(&self, tool_id: &str, u: &ToolUsage) {
        let Some(tokens) = u.context_tokens() else {
            return;
        };
        let mut obs = dm_webserver_domain_run::ContextObservation {
            tokens: tokens as i64,
            has_tokens: true,
            ..Default::default()
        };
        if let Some(w) = u
            .usage
            .context_window
            .as_ref()
            .and_then(|c| c.window_tokens)
        {
            obs.window = w;
        }
        if let Some(sid) = &u.usage.session_id {
            obs.session_id = sid.clone();
        }
        self.observe_run_context(tool_id, obs);
    }

    pub(crate) fn activity_entries(&self) -> Vec<ActivityEntry> {
        let snap = self.attention().activity_snapshot();
        let p = self.context_policy();
        let now = OffsetDateTime::now_utc();
        snap.into_iter()
            .map(|a| {
                let (c, u) = self.tool_usage_view(&a.tool_id);
                let subs = self
                    .agents
                    .subagents
                    .get(&a.tool_id, now)
                    .unwrap_or_default();
                let busy = a.state == activity::WORKING || a.state == activity::WAITING;
                self.agents
                    .sub_acts
                    .drop_stale(&a.tool_id, now, busy, &running_subagents(&subs));
                let acts = self.agents.sub_acts.list(&a.tool_id, now);
                ActivityEntry {
                    usage: card_usage_of(c.as_ref(), u.as_ref(), p),
                    subagents: card_subagents_of(&subs, &acts, p),
                    tool_id: a.tool_id,
                    state: a.state,
                    tool: a.tool,
                    detail: a.detail,
                    updated_at: a.updated_at,
                }
            })
            .collect()
    }
}
