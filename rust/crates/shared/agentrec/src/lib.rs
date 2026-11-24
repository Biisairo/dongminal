//! Go 기준선 `otterminal/internal/shared/agentrec` 의 Rust 포팅. RUST_PORT_SRS 참고.
//!
//! 에이전트 보고의 해석과 기록 값의 모양이다. 데몬과 서버가 같은 한 벌을 쓴다
//! (AGENT_RECORD_DAEMON_SRS §3.2a).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use otter_gocompat::json::{RawMessage, is_empty};
use otter_gocompat::time::{json_time, zero_time};
use otter_shared_activity as activity;
use otter_shared_statusline as statusline;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use time::OffsetDateTime;

/// 데몬의 보고 소켓 이름. 데몬 소켓과 같은 0700 폴더에 산다 (FR-ARD-20).
pub const SOCKET_FILE: &str = "report.sock";

/// 보고 소켓이 받는 메서드는 넷뿐이다 (FR-ARD-21).
pub const METHOD_ACTIVITY: &str = "report.activity";
pub const METHOD_USAGE: &str = "report.usage";
pub const METHOD_SUBAGENTS: &str = "report.subagents";
pub const METHOD_NOTIFY: &str = "report.notify";

/// 보고 소켓 연결 하나의 읽기·쓰기 시한.
pub const IO_TIMEOUT: Duration = Duration::from_secs(2);

/// 활동 문자열의 상한 (NFR-AAP-3).
pub const TOOL_MAX: usize = 64;
pub const DETAIL_MAX: usize = 512;
/// done 이 된 서브에이전트 활동을 남겨 두는 기한 (FR-ASV-12).
pub const SUBAGENT_DONE_KEEP: Duration = Duration::from_secs(30);
/// 갱신이 끊긴 done 아닌 서브에이전트 활동을 남겨 두는 기한 (FR-ASV-12 안전망).
pub const SUBAGENT_STALE_KEEP: Duration = Duration::from_secs(120);

/// home 인스턴스의 보고 소켓 경로. 데몬과 otterctl 이 이 함수 하나로 찾는다.
pub fn socket_path(home: &Path) -> PathBuf {
    otter_shared_platform::sibling_socket(home, SOCKET_FILE)
}

/// 보고 소켓이 받는 메서드인가.
pub fn known_method(m: &str) -> bool {
    matches!(
        m,
        METHOD_ACTIVITY | METHOD_USAGE | METHOD_SUBAGENTS | METHOD_NOTIFY
    )
}

/// 보고 소켓의 요청 한 줄. body 는 같은 보고의 HTTP 본문 그대로다.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "agentrec.Request")]
pub struct Request {
    pub method: String,
    pub body: RawMessage,
}

/// 보고 소켓의 응답 한 줄.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "agentrec.Reply")]
pub struct Reply {
    pub ok: bool,
    #[serde(skip_serializing_if = "is_empty")]
    pub error: String,
}

/// `POST /api/tools/activity/set` 과 report.activity 의 본문.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "agentrec.ActivityReport")]
pub struct ActivityReport {
    #[serde(rename = "toolId")]
    pub tool_id: String,
    pub state: String,
    pub tool: String,
    pub detail: String,
    /// 보고한 에이전트의 id (FR-AEV-10).
    pub agent: String,
    /// 훅이 실어 보내지만 쓰지 않는다 (FR-AGR-9).
    #[serde(rename = "sessionId")]
    pub session_id: String,
    /// 있으면 서브에이전트 활동이다 (FR-ASV-10).
    #[serde(rename = "agentId")]
    pub agent_id: String,
    #[serde(rename = "agentType")]
    pub agent_type: String,
    /// 브리지의 곁들이 값 (FR-TGB-80·81).
    #[serde(skip_serializing_if = "is_empty")]
    pub hook: String,
    #[serde(skip_serializing_if = "is_empty")]
    pub input: RawMessage,
    #[serde(rename = "inputOver", skip_serializing_if = "is_empty")]
    pub input_over: bool,
    #[serde(skip_serializing_if = "is_empty")]
    pub transcript: String,
}

/// `POST /api/tools/usage` 와 report.usage 의 본문.
///
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename = "agentrec.UsageReport")]
pub struct UsageReport {
    #[serde(rename = "toolId")]
    pub tool_id: String,
    pub usage: statusline::Usage,
    /// 그 세션이 로그인한 Claude 계정 (FR-CAC-78). 모르면 없다.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account: Option<ReportAccount>,
}

/// statusLine 보고의 계정. 토큰은 없다.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "agentrec.ReportAccount")]
pub struct ReportAccount {
    pub email: String,
    #[serde(rename = "organizationUuid")]
    pub org_uuid: String,
}

/// `POST /api/tools/subagents` 와 report.subagents 의 본문.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename = "agentrec.SubagentsReport")]
pub struct SubagentsReport {
    #[serde(rename = "toolId")]
    pub tool_id: String,
    pub tasks: Option<Vec<statusline::Subagent>>,
}

/// `POST /api/tools/attention/set` 과 report.notify 의 본문.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "agentrec.NotifyReport")]
pub struct NotifyReport {
    #[serde(rename = "toolId")]
    pub tool_id: String,
    pub reason: String,
}

/// 알람 사유. 비면 signaled 다.
pub fn notify_reason(r: &str) -> &str {
    if r.is_empty() { "signaled" } else { r }
}

/// 도구 하나의 statusLine 사용량 기록 — 받은 값과 받은 시각(밀리초).
/// JSON 은 Go 의 임베드처럼 `statusline::Usage` 의 필드 뒤에 `observedAt` 이 온다.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Usage {
    pub usage: statusline::Usage,
    pub observed_at: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UsageOut<'a> {
    #[serde(skip_serializing_if = "Option::is_none")]
    session_id: &'a Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    version: &'a Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    model: &'a Option<statusline::Model>,
    #[serde(skip_serializing_if = "Option::is_none")]
    effort: &'a Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    thinking: &'a Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    fast_mode: &'a Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    output_style: &'a Option<String>,
    #[serde(rename = "exceeds200k", skip_serializing_if = "Option::is_none")]
    exceeds_200k: &'a Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cost: &'a Option<statusline::Cost>,
    #[serde(skip_serializing_if = "Option::is_none")]
    context_window: &'a Option<statusline::ContextWindow>,
    #[serde(skip_serializing_if = "Option::is_none")]
    rate_limits: &'a Option<BTreeMap<String, statusline::RateWindow>>,
    observed_at: i64,
}

impl Serialize for Usage {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let u = &self.usage;
        UsageOut {
            session_id: &u.session_id,
            version: &u.version,
            model: &u.model,
            effort: &u.effort,
            thinking: &u.thinking,
            fast_mode: &u.fast_mode,
            output_style: &u.output_style,
            exceeds_200k: &u.exceeds_200k,
            cost: &u.cost,
            context_window: &u.context_window,
            rate_limits: &u.rate_limits,
            observed_at: self.observed_at,
        }
        .serialize(s)
    }
}

#[derive(Deserialize, Default)]
#[serde(default, rename = "agentrec.Usage", rename_all = "camelCase")]
struct UsageIn {
    session_id: Option<String>,
    version: Option<String>,
    model: Option<statusline::Model>,
    effort: Option<String>,
    thinking: Option<bool>,
    fast_mode: Option<bool>,
    output_style: Option<String>,
    #[serde(rename = "exceeds200k")]
    exceeds_200k: Option<bool>,
    cost: Option<statusline::Cost>,
    context_window: Option<statusline::ContextWindow>,
    rate_limits: Option<BTreeMap<String, statusline::RateWindow>>,
    observed_at: i64,
}

impl<'de> Deserialize<'de> for Usage {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let u = UsageIn::deserialize(d)?;
        Ok(Self {
            usage: statusline::Usage {
                session_id: u.session_id,
                version: u.version,
                model: u.model,
                effort: u.effort,
                thinking: u.thinking,
                fast_mode: u.fast_mode,
                output_style: u.output_style,
                exceeds_200k: u.exceeds_200k,
                cost: u.cost,
                context_window: u.context_window,
                rate_limits: u.rate_limits,
            },
            observed_at: u.observed_at,
        })
    }
}

impl Usage {
    /// 지금 맥락에 든 토큰 — 입력·캐시 생성·캐시 읽기의 합. 값이 하나도 없으면 `None`.
    pub fn context_tokens(&self) -> Option<f64> {
        let c = self.usage.context_window.as_ref()?.current_usage.as_ref()?;
        let vals: Vec<f64> = [
            c.input_tokens,
            c.cache_creation_input_tokens,
            c.cache_read_input_tokens,
        ]
        .into_iter()
        .flatten()
        .collect();
        (!vals.is_empty()).then(|| vals.iter().sum())
    }
}

/// 서브에이전트 목록 기록. 시각은 밀리초다.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename = "agentrec.SubagentList")]
pub struct SubagentList {
    pub tasks: Option<Vec<statusline::Subagent>>,
    #[serde(rename = "observedAt")]
    pub observed_at: i64,
}

/// 서브에이전트 하나의 훅 활동 (FR-ASV-10).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "agentrec.SubagentActivity")]
pub struct SubagentActivity {
    #[serde(rename = "agentType", skip_serializing_if = "is_empty")]
    pub agent_type: String,
    pub state: String,
    #[serde(skip_serializing_if = "is_empty")]
    pub tool: String,
    #[serde(skip_serializing_if = "is_empty")]
    pub detail: String,
    #[serde(rename = "updatedAt", with = "json_time")]
    pub updated_at: OffsetDateTime,
}

impl Default for SubagentActivity {
    fn default() -> Self {
        Self {
            agent_type: String::new(),
            state: String::new(),
            tool: String::new(),
            detail: String::new(),
            updated_at: zero_time(),
        }
    }
}

/// 서브에이전트 활동이 가질 수 있는 상태인가 (FR-ASV-10).
pub fn valid_subagent_state(s: &str) -> bool {
    s == activity::WORKING || s == activity::WAITING || s == activity::DONE
}

/// 보고에서 정리한 서브에이전트 활동.
pub fn subagent_activity_of(r: &ActivityReport) -> SubagentActivity {
    SubagentActivity {
        agent_type: sanitize(&r.agent_type, TOOL_MAX),
        state: r.state.clone(),
        tool: sanitize(&r.tool, TOOL_MAX),
        detail: sanitize(&r.detail, DETAIL_MAX),
        updated_at: zero_time(),
    }
}

/// m 에 활동 하나를 덮어쓴다. 상한을 넘으면 가장 오래 갱신되지 않은 것을 버린다 (FR-ASV-11).
pub fn put_subagent_activity(
    m: &mut BTreeMap<String, SubagentActivity>,
    agent_id: &str,
    mut a: SubagentActivity,
    now: OffsetDateTime,
) {
    a.updated_at = now;
    m.insert(agent_id.to_owned(), a);
    while m.len() > statusline::SUBAGENT_MAX_TASKS {
        let oldest = m
            .iter()
            .min_by_key(|(_, v)| v.updated_at)
            .map(|(k, _)| k.clone());
        match oldest {
            Some(k) => m.remove(&k),
            None => break,
        };
    }
}

/// 에이전트 하나의 계정 한도 기록. 시각은 밀리초다.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename = "agentrec.LimitRecord")]
pub struct LimitRecord {
    pub windows: Option<BTreeMap<String, statusline::RateWindow>>,
    #[serde(rename = "observedAt")]
    pub observed_at: i64,
}

/// agent 의 한도를 m 에 넣는다. 빈 한도는 넣지 않는다 (FR-ASV-20).
pub fn merge_limits(
    m: &mut BTreeMap<String, LimitRecord>,
    agent: &str,
    windows: &BTreeMap<String, statusline::RateWindow>,
    at: OffsetDateTime,
) {
    if windows.is_empty() {
        return;
    }
    let ms = i64::try_from(at.unix_timestamp_nanos().div_euclid(1_000_000)).unwrap_or(i64::MAX);
    m.insert(
        agent.to_owned(),
        LimitRecord {
            windows: Some(windows.clone()),
            observed_at: ms,
        },
    );
}

/// 제어 문자를 지우고 길이를 max 바이트로 묶는다. 글자 중간을 끊지 않는다 (NFR-AAP-3, IPC-27).
pub fn sanitize(s: &str, max: usize) -> String {
    let mut out: String = s
        .chars()
        .filter(|&r| !(r < '\u{20}' || r == '\u{7f}'))
        .collect();
    if out.len() > max {
        let mut cut = max;
        while cut > 0 && !out.is_char_boundary(cut) {
            cut -= 1;
        }
        out.truncate(cut);
    }
    out
}

/// 그 에이전트가 턴의 시작(`working`)을 알릴 수 있는가 (FR-AEV-12). 모르는 id 에는 참이다.
pub fn agent_reports_turn_start(id: &str) -> bool {
    if id.is_empty() {
        return true;
    }
    otter_shared_agentadapter::get(id).map_or(true, |a| a.signals.working)
}

#[cfg(test)]
mod tests;
