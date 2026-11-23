//! 주의(attention)·활동(activity)·배경(background) 종단 (Go `handlers_attention.go`·
//! `attention_service.go`·`attention_daemon.go`·`attention_claim.go`).
//!
//! 셋은 직교하는 레이어지만 모두 "도구가 지금 어떤 상태인가"를 브라우저에 알리는 같은 목적이고,
//! 같은 상태(추적기)를 읽는다.

use std::collections::{BTreeMap, HashMap};
use std::fmt;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use dm_shared_activity as activity;
use dm_shared_agentrec as agentrec;
use dm_shared_dmlog::warnf;
use dm_shared_httpresp::Response;
use dm_shared_toolhub::{ActivitySnap, ActivityState, BackgroundEntry};
use dm_shared_toolipc::RpcError;
use dm_webserver_apierr as apierr;
use dm_webserver_hub::{self as hub, AttnTracker};
use http::StatusCode;
use serde::{Deserialize, Serialize};

use crate::Server;
use crate::httperr::{BodyRead, http_err, read_body_http, write_json};
use crate::req::Req;
use crate::toolhub::ToolHub;
use crate::tools_api::off_thread;

/// 데몬에 넘긴 호출의 실패다. 데몬이 거절하면 `Rpc` 다.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DaemonCallError {
    Rpc(RpcError),
    Other(String),
}

impl fmt::Display for DaemonCallError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            DaemonCallError::Rpc(e) => e.fmt(f),
            DaemonCallError::Other(s) => f.write_str(s),
        }
    }
}

/// Go `AttentionDaemon`: 데몬의 알람 판정이다 (AGENT_RECORD_DAEMON_SRS §3.3a). `judges` 가 참이면
/// 서버는 판정하지 않는다 — 보고·해제를 데몬에 넘기고, 결과는 attn push 로 거울에 온다.
pub trait AttentionDaemon: Send + Sync {
    /// 지금 붙은 데몬이 판정하는가다. 부를 때마다 묻는다.
    fn judges(&self) -> bool;
    /// HTTP 로 온 보고(`body` 는 JSON)를 데몬에 넘긴다.
    fn report(&self, method: &str, body: &[u8]) -> Result<(), DaemonCallError>;
    fn attend(&self, tool_id: &str, typed: bool) -> Result<(), DaemonCallError>;
    fn attend_all(&self) -> Result<i64, DaemonCallError>;
}

/// Go `attentionService`: 추적기가 배선되지 않았으면 신호·해제·보고는 무동작이다
/// (DIRECT_MODE_REMOVAL_SRS FR-DMR-12).
pub(crate) struct AttentionSvc<'a> {
    t: Option<&'a Arc<AttnTracker>>,
    tools: Option<&'a Arc<dyn ToolHub>>,
    d: Option<&'a Arc<dyn AttentionDaemon>>,
}

impl AttentionSvc<'_> {
    fn judges(&self) -> bool {
        self.d.is_some_and(|d| d.judges())
    }

    /// 추적기의 빈 목록은 Go 처럼 nil(`null`)이고, 추적기가 없으면 빈 배열이다.
    pub(crate) fn attention_ids(&self) -> Option<Vec<String>> {
        match self.t {
            Some(t) => Some(t.attention_ids()).filter(|v| !v.is_empty()),
            None => Some(Vec::new()),
        }
    }

    pub(crate) fn signal_attention(&self, tool_id: &str, reason: &str) {
        let Some(t) = self.t else { return };
        if self.judges() {
            return;
        }
        // 추적기는 모르는 도구에도 상태를 만든다 — 그래서 존재를 먼저 본다.
        if self.tools.is_some_and(|h| h.get(tool_id).is_some()) {
            t.signal_attention(tool_id, reason);
        }
    }

    pub(crate) fn attend(&self, tool_id: &str, typed: bool) {
        let Some(t) = self.t else { return };
        if self.tools.is_none() {
            return;
        }
        if self.judges() {
            if let Some(Err(e)) = self.d.map(|d| d.attend(tool_id, typed)) {
                warnf!(
                    None,
                    "attention: 해제를 데몬에 보내지 못했다 tool={tool_id}: {e}"
                );
            }
            return;
        }
        if typed {
            t.attend_typed(tool_id);
        } else {
            t.attend(tool_id);
        }
    }

    pub(crate) fn clear_all_attention(&self) -> i64 {
        let Some(t) = self.t else { return 0 };
        if !self.judges() {
            return t.clear_all_attention() as i64;
        }
        match self.d.map(|d| d.attend_all()) {
            Some(Ok(n)) => n,
            Some(Err(e)) => {
                warnf!(None, "attention: 전부 해제를 데몬에 보내지 못했다: {e}");
                0
            }
            None => 0,
        }
    }

    pub(crate) fn activity_snapshot(&self) -> Vec<ActivitySnap> {
        self.t.map(|t| t.activity_snapshot()).unwrap_or_default()
    }

    /// 활동 보고 하나다 — 활동·파생 알람 (FR-AEV-10).
    pub(crate) fn report_activity(
        &self,
        tool_id: &str,
        state: &str,
        tool: &str,
        detail: &str,
        turn_known: bool,
    ) {
        let Some(t) = self.t else { return };
        if self.tools.is_none() || self.judges() {
            return;
        }
        t.set_activity(tool_id, state, tool, detail);
        if activity::alarms(state) {
            t.signal_agent_event(tool_id, state, turn_known);
        }
    }

    pub(crate) fn activity(&self, tool_id: &str) -> Option<ActivityState> {
        self.t.and_then(|t| t.activity(tool_id))
    }

    /// 마지막 출력 시각(unix ns)이다. 없으면 0.
    pub(crate) fn last_output_at(&self, tool_id: &str) -> i64 {
        self.t.map_or(0, |t| t.last_output_at(tool_id))
    }

    /// 데몬 모드에서 이미 죽어 있던 도구를 지우는 경로에는 OnExit 가 오지 않는다 (FR-ATL-5).
    pub(crate) fn forget(&self, tool_id: &str) {
        if let Some(t) = self.t {
            t.forget(tool_id);
        }
    }
}

/// 승낙 기록의 수명이다 (FR-ATD-6).
pub(crate) const ATTN_CLAIM_TTL: Duration = Duration::from_secs(60);
/// "이 기계" 의 컴퓨터 키다 (FR-ATD-5).
pub(crate) const ATTN_CLAIM_SELF_HOST: &str = "self";
/// 맡을 수 있는 종류다 (FR-ATD-3).
const ATTN_CLAIM_KINDS: [&str; 2] = ["banner", "sound"];

pub(crate) struct AttnClaimRec {
    at: Instant,
    /// 컴퓨터 + "\x00" + 종류.
    granted: std::collections::HashSet<String>,
}

/// Go `attnClaims`: 한 컴퓨터에서 한 번 (ATTENTION_FIRING_SRS 묶음 D).
#[derive(Default)]
pub(crate) struct AttnClaims {
    pub(crate) by_seq: Mutex<HashMap<u64, AttnClaimRec>>,
    /// 시험 전용 시계다. `None` 이면 벽시계다.
    pub(crate) now: Mutex<Option<Instant>>,
}

impl AttnClaims {
    /// 이 컴퓨터가 seq 알람의 kinds 중 무엇을 맡는지 답한다. 이미 다른 창이 맡은 종류와 모르는
    /// 종류는 빠진다. 지난 기록은 이 자리에서 치운다.
    pub(crate) fn claim(&self, seq: u64, host: &str, kinds: &[String]) -> Vec<String> {
        let now = self
            .now
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .unwrap_or_else(Instant::now);
        let mut by_seq = self.by_seq.lock().unwrap_or_else(|e| e.into_inner());
        by_seq.retain(|_, r| now.saturating_duration_since(r.at) <= ATTN_CLAIM_TTL);
        let rec = by_seq.entry(seq).or_insert_with(|| AttnClaimRec {
            at: now,
            granted: Default::default(),
        });
        let mut granted = Vec::new();
        for kind in kinds {
            let key = format!("{host}\x00{kind}");
            if !ATTN_CLAIM_KINDS.contains(&kind.as_str()) || rec.granted.contains(&key) {
                continue;
            }
            rec.granted.insert(key);
            granted.push(kind.clone());
        }
        granted
    }
}

#[derive(Serialize)]
struct Ok_ {
    ok: bool,
}

fn ok() -> Response {
    write_json(&Ok_ { ok: true })
}

#[derive(Serialize)]
struct ToolIds {
    #[serde(rename = "toolIds")]
    tool_ids: Option<Vec<String>>,
}

#[derive(Serialize)]
struct Cleared {
    cleared: i64,
}

#[derive(Serialize)]
struct Granted {
    granted: Vec<String>,
}

#[derive(Serialize)]
struct BackgroundList {
    background: Vec<BackgroundRow>,
}

/// Go `backgroundRow`: 배경 도구 하나와 그 도구가 멤버인 열린 Run.
#[derive(Default)]
struct BackgroundRow {
    entry: BackgroundEntry,
    run_id: String,
    /// 화면이 runId 를 자르지 않게 서버가 싣는다 (K-l).
    run_short: String,
    member_id: String,
    role: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BackgroundRunOf<'a> {
    #[serde(skip_serializing_if = "str::is_empty")]
    run_id: &'a str,
    #[serde(skip_serializing_if = "str::is_empty")]
    run_short: &'a str,
    #[serde(skip_serializing_if = "str::is_empty")]
    member_id: &'a str,
    #[serde(skip_serializing_if = "str::is_empty")]
    role: &'a str,
}

impl Serialize for BackgroundRow {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        crate::go_embed::Embed {
            inner: &self.entry,
            hide: &["runId", "runShort", "memberId", "role"],
            outer: BackgroundRunOf {
                run_id: &self.run_id,
                run_short: &self.run_short,
                member_id: &self.member_id,
                role: &self.role,
            },
        }
        .serialize(s)
    }
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct ClearBody {
    #[serde(rename = "toolId")]
    tool_id: String,
    typed: bool,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct ClaimBody {
    seq: u64,
    kinds: Option<Vec<String>>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct BackgroundBody {
    #[serde(rename = "toolId")]
    tool_id: String,
    background: bool,
}

#[derive(Serialize)]
struct LayoutReq<'a> {
    action: &'a str,
    args: Option<&'a BTreeMap<String, serde_json::Value>>,
    #[serde(rename = "execClientId", skip_serializing_if = "Option::is_none")]
    exec_client_id: Option<String>,
}

fn bad_request(code: &str) -> Response {
    http_err("bad request", StatusCode::BAD_REQUEST, code)
}

/// Go `checkActivityReport`: 활동 보고의 검사다. 받지 않으면 오류 코드를 돌려준다.
pub(crate) fn check_activity_report(req: &agentrec::ActivityReport) -> Option<&'static str> {
    if req.tool_id.is_empty() || req.state.is_empty() {
        Some(apierr::CODE_MISSING_ARG)
    } else if !hub::valid_activity_state(&req.state)
        || (!req.agent_id.is_empty() && !agentrec::valid_subagent_state(&req.state))
    {
        Some(apierr::CODE_BAD_REQUEST)
    } else {
        None
    }
}

impl Server {
    /// Go `attention()`: 추적기가 있으면 그것이고, 없으면 무동작이다.
    pub(crate) fn attention(&self) -> AttentionSvc<'_> {
        AttentionSvc {
            t: self.deps.attn_tracker.as_ref(),
            tools: self.deps.tools.as_ref(),
            d: self.deps.attn_daemon.as_ref(),
        }
    }

    fn daemon_judges(&self) -> bool {
        self.deps.attn_daemon.as_ref().is_some_and(|d| d.judges())
    }

    /// Go `forwardReport`: 데몬이 판정하면 보고를 넘기고 응답을 돌려준다. 없는 도구는 종전처럼
    /// 200 무동작이고, 넘기지 못하면 503 이다 — 서버가 대신 판정하지 않는다.
    async fn forward_report<T: Serialize>(
        &self,
        method: &'static str,
        body: &T,
    ) -> Option<Response> {
        if !self.daemon_judges() {
            return None;
        }
        let d = self.deps.attn_daemon.clone()?;
        let blob = dm_gocompat::json::marshal(body).unwrap_or_default();
        let res = off_thread(move || d.report(method, &blob)).await;
        Some(match res {
            Some(Ok(())) => ok(),
            Some(Err(DaemonCallError::Rpc(e))) if e.code == dm_shared_toolipc::CODE_NOT_FOUND => {
                ok()
            }
            Some(Err(e)) => {
                warnf!(None, "attention: {method} 보고를 데몬에 넘기지 못했다: {e}");
                daemon_unavailable()
            }
            None => daemon_unavailable(),
        })
    }

    /// GET /api/tools/attention (FR-PAN-8).
    pub(crate) async fn api_tools_attention(&self, _r: &mut Req) -> Response {
        write_json(&ToolIds {
            tool_ids: self.attention().attention_ids(),
        })
    }

    /// POST /api/tools/attention/set. 모르는 도구는 200 무동작, toolId 가 없으면 400 이다.
    pub(crate) async fn api_tool_attention_set(&self, r: &mut Req) -> Response {
        let req = match read_body_http::<agentrec::NotifyReport>(r).await {
            BodyRead::Answered(res) => return res,
            BodyRead::NotJson => return bad_request(apierr::CODE_INVALID_JSON),
            BodyRead::Ok(b) => b,
        };
        if req.tool_id.is_empty() {
            return bad_request(apierr::CODE_MISSING_ARG);
        }
        if let Some(res) = self.forward_report(agentrec::METHOD_NOTIFY, &req).await {
            return res;
        }
        self.apply_notify_report(&req);
        ok()
    }

    /// Go `applyNotifyReport`: 알람 보고 하나다. HTTP 와 데몬의 report push 가 함께 지난다.
    pub(crate) fn apply_notify_report(&self, req: &agentrec::NotifyReport) {
        self.attention()
            .signal_attention(&req.tool_id, agentrec::notify_reason(&req.reason));
    }

    /// POST /api/tools/attention/clear. `typed` 는 사용자가 그 도구에 키를 눌렀는가다 (FR-ATA-9).
    pub(crate) async fn api_tool_attention_clear(&self, r: &mut Req) -> Response {
        let req = match read_body_http::<ClearBody>(r).await {
            BodyRead::Answered(res) => return res,
            BodyRead::NotJson => return bad_request(apierr::CODE_INVALID_JSON),
            BodyRead::Ok(b) => b,
        };
        if req.tool_id.is_empty() {
            return bad_request(apierr::CODE_MISSING_ARG);
        }
        self.attention().attend(&req.tool_id, req.typed);
        ok()
    }

    /// POST /api/tools/attention/clear-all (FR-PAN-17).
    pub(crate) async fn api_tool_attention_clear_all(&self, _r: &mut Req) -> Response {
        write_json(&Cleared {
            cleared: self.attention().clear_all_attention(),
        })
    }

    /// Go `claimHost`: 청구의 출발지를 컴퓨터 키로 바꾼다 (FR-ATD-5).
    pub(crate) fn claim_host(&self, remote_addr: &str) -> String {
        let host = crate::netx::split_host_port(remote_addr).map_or(remote_addr, |(h, _)| h);
        let Some(addr) = crate::netx::parse_addr(host) else {
            return host.to_owned();
        };
        let addr = addr.unmap();
        if addr.is_loopback() || self.access.as_ref().is_some_and(|a| a.is_self(&addr)) {
            return ATTN_CLAIM_SELF_HOST.to_owned();
        }
        addr.to_string()
    }

    /// POST /api/tools/attention/claim (FR-ATD-4). 서버는 seq 의 출처를 검증하지 않는다.
    pub(crate) async fn api_tool_attention_claim(&self, r: &mut Req) -> Response {
        let req = match read_body_http::<ClaimBody>(r).await {
            BodyRead::Answered(res) => return res,
            BodyRead::NotJson => return bad_request(apierr::CODE_INVALID_JSON),
            BodyRead::Ok(b) => b,
        };
        if req.seq == 0 {
            return http_err(
                "seq required",
                StatusCode::BAD_REQUEST,
                apierr::CODE_MISSING_ARG,
            );
        }
        let host = self.claim_host(&r.remote_addr);
        let granted =
            self.attn_claims
                .claim(req.seq, &host, req.kinds.as_deref().unwrap_or_default());
        write_json(&Granted { granted })
    }

    /// POST /api/tools/activity/set (FR-AAP-3).
    pub(crate) async fn api_tool_activity_set(&self, r: &mut Req) -> Response {
        let req = match read_body_http::<agentrec::ActivityReport>(r).await {
            BodyRead::Answered(res) => return res,
            BodyRead::NotJson => return bad_request(apierr::CODE_INVALID_JSON),
            BodyRead::Ok(b) => b,
        };
        if let Some(code) = check_activity_report(&req) {
            return bad_request(code);
        }
        if let Some(res) = self.forward_report(agentrec::METHOD_ACTIVITY, &req).await {
            return res;
        }
        self.apply_activity_report(&req);
        ok()
    }

    /// Go `applyActivityReport`: 받지 않으면 오류 코드를 돌려준다.
    pub(crate) fn apply_activity_report(
        &self,
        req: &agentrec::ActivityReport,
    ) -> Option<&'static str> {
        if let Some(code) = check_activity_report(req) {
            return Some(code);
        }
        if !req.agent_id.is_empty() {
            self.report_subagent_activity(req);
            return None;
        }
        self.report_activity(
            &req.tool_id,
            &req.state,
            &req.tool,
            &req.detail,
            agentrec::agent_reports_turn_start(&req.agent),
        );
        // Telegram 브리지(`telegramActivity`)는 5.5.9 가 잇는다.
        None
    }

    /// Go `reportActivity`: 활동 보고의 한 자리다 (FR-APS-2 · FR-AGT-8). 알람은 활동 이벤트에서
    /// 파생한다 (FR-AEV-10).
    pub(crate) fn report_activity(
        &self,
        tool_id: &str,
        state: &str,
        tool: &str,
        detail: &str,
        turn_known: bool,
    ) {
        let tool = agentrec::sanitize(tool, agentrec::TOOL_MAX);
        let detail = agentrec::sanitize(detail, agentrec::DETAIL_MAX);
        self.attention()
            .report_activity(tool_id, state, &tool, &detail, turn_known);
        if state == activity::ENDED {
            // ACTIVITY_STATE_SUBAGENT_SRS FR-ASV-12
            self.agents.sub_acts.drop_tool(tool_id);
            self.put_record::<()>(dm_shared_toolipc::RECORD_SUBAGENT_ACTS, tool_id, None);
        }
        self.activity_changed.notify();
    }

    /// GET /api/tools/activity (FR-AAP-4·FR-ACU-1·FR-ASV-21).
    pub(crate) async fn api_tools_activity(&self, _r: &mut Req) -> Response {
        #[derive(Serialize)]
        struct Out {
            activities: Vec<crate::usage::ActivityEntry>,
            limits: Vec<crate::usage::LimitEntry>,
        }
        write_json(&Out {
            activities: self.activity_entries(),
            limits: self
                .agents
                .rate_limits
                .view(time::OffsetDateTime::now_utc()),
        })
    }

    /// GET /api/tools/background (FR-BG-6). 열린 Run 의 멤버면 그 Run 을 함께 싣는다 (FR-HLM-9).
    pub(crate) async fn api_tools_background(&self, _r: &mut Req) -> Response {
        let list = match self.deps.tools.clone() {
            Some(h) => off_thread(move || h.background_list())
                .await
                .unwrap_or_default(),
            None => Vec::new(),
        };
        let background = list
            .into_iter()
            .map(|e| {
                let mut row = BackgroundRow::default();
                // 끝난 Run 의 도구는 그 Run 의 것이 아니다 — 그쪽은 고아 목록이 맡는다 (FR-HLM-5).
                if let Some(m) = self.runs().and_then(|st| st.member_by_tool(&e.tool_id)) {
                    row.run_short = dm_webserver_domain_run::short(&m.run_id);
                    row.run_id = m.run_id;
                    row.member_id = m.id;
                    row.role = m.role;
                }
                row.entry = e;
                row
            })
            .collect();
        write_json(&BackgroundList { background })
    }

    /// POST /api/tools/background/set (FR-BG-2/4/7). 모르는 도구는 404 다.
    pub(crate) async fn api_tool_background_set(&self, r: &mut Req) -> Response {
        let body = match read_body_http::<BackgroundBody>(r).await {
            BodyRead::Answered(res) => return res,
            BodyRead::NotJson => None,
            BodyRead::Ok(b) => Some(b),
        };
        let body = match body {
            Some(b) if !b.tool_id.is_empty() => b,
            other => {
                let code = if other.is_none() {
                    apierr::CODE_INVALID_JSON
                } else {
                    apierr::CODE_MISSING_ARG
                };
                return http_err("toolId 필요", StatusCode::BAD_REQUEST, code);
            }
        };
        let set = match self.tools(Some(r)) {
            Some(h) => {
                let (id, bg) = (body.tool_id.clone(), body.background);
                off_thread(move || h.set_background(&id, bg))
                    .await
                    .unwrap_or(false)
            }
            None => false,
        };
        if !set {
            return http_err(
                &format!("toolId={} 존재하지 않음", body.tool_id),
                StatusCode::NOT_FOUND,
                apierr::CODE_TOOL_NOT_FOUND,
            );
        }
        if !body.background {
            self.reconcile_member_tab(&body.tool_id);
        }
        // UX_BATCH6_SRS FR-BGP-2: 목록이 바뀌었음을 모든 구독자에게 알린다.
        self.broadcast_layout("tools_background_changed", None);
        write_json(&Ok_ { ok: true })
    }

    /// Go `broadcastLayout`: 워크스페이스 명령 하나를 방송하고 받은 브라우저 수를 돌려준다
    /// (FR-SXE-1/2). 5.5.5 도 이것을 쓴다.
    pub(crate) fn broadcast_layout(
        &self,
        action: &str,
        args: Option<&BTreeMap<String, serde_json::Value>>,
    ) -> usize {
        let Some(cmds) = self.commands() else {
            return 0;
        };
        let req = LayoutReq {
            action,
            args,
            exec_client_id: hub::is_single_executor_action(action).then(|| self.focus.executor()),
        };
        match dm_gocompat::json::marshal(&req) {
            Ok(payload) => cmds.broadcast(&payload),
            Err(_) => 0,
        }
    }
}

fn daemon_unavailable() -> Response {
    http_err(
        "daemon unavailable",
        StatusCode::SERVICE_UNAVAILABLE,
        apierr::CODE_TOOLS_UNREADY,
    )
}
