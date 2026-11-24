//! 상태·대기 계약의 서버측 절반 (Go `handlers_status.go`, RUN_ORCHESTRATION_SRS §3.2).
//!
//! 조회(get)와 대기(wait) 두 종단이다. 대기는 서버가 붙잡는다 (FR-STA-3). 서버는 활동 보고의
//! 알림과 판정이 바뀔 수 있는 가장 이른 시각에만 재평가한다 (FR-OPT-16-3).

use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use dm_shared_activity as activity;
use dm_shared_httpresp::Response;
use dm_shared_statusline::Subagent;
use http::StatusCode;
use serde::Serialize;

use crate::Server;
use crate::httperr::{write_json, write_tool_io_error};
use crate::req::Req;
use crate::tools_api::off_thread;
use crate::usage::{LimitEntry, ToolContext, ToolUsage};

/// "훅이 한 번도 보고하지 않았다"이며 오류가 아니다.
const ACTIVITY_STATE_UNKNOWN: &str = "unknown";
/// 훅 상태가 없을 때 준비완료로 볼 출력 정적 구간 (FR-STA-4 3단계).
const READY_QUIET_MS: i64 = 3000;
const WAIT_DEFAULT_TIMEOUT_MS: i64 = dm_shared_runwait::ACTIVITY_WAIT_DEFAULT.as_millis() as i64;
const WAIT_MAX_TIMEOUT_MS: i64 = dm_shared_runwait::ACTIVITY_WAIT_MAX.as_millis() as i64;
const WAIT_MIN_TIMEOUT_MS: i64 = 100;
/// 생존 확인의 주기다 (NFR-RUN-4). 알림 밖의 변화를 줍는 안전망이기도 하다.
const WAIT_LIVENESS_INTERVAL: Duration = Duration::from_secs(1);
/// 동시에 붙잡는 활동 대기의 상한이다 (FR-STA-9). `diag` 의 hold 임계와 같다 (FR-CNR-13).
pub(crate) const WAIT_MAX_CONCURRENT: i64 = 32;

/// 활동 대기의 동시 수와 상한이다 (Go `waitInFlight`·`serverLimits.waitMaxConcurrent`).
pub(crate) struct StatusWaits {
    pub(crate) in_flight: AtomicI64,
    pub(crate) max: AtomicI64,
    /// 대기의 재평가 수다 — 시험이 알림·마감에만 다시 보는지 잰다.
    #[cfg(test)]
    pub(crate) evals: AtomicI64,
}

impl Default for StatusWaits {
    fn default() -> Self {
        StatusWaits {
            in_flight: AtomicI64::new(0),
            max: AtomicI64::new(WAIT_MAX_CONCURRENT),
            #[cfg(test)]
            evals: AtomicI64::new(0),
        }
    }
}

/// 잡은 자리를 돌려준다 — 이른 반환·끊긴 요청 어디서든 (FR-STA-9).
struct Seat<'a>(&'a AtomicI64);

impl Drop for Seat<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

/// 생존 판정의 세 값이다 (AGENT_RECORD_DAEMON_SRS FR-ARD-1).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Liveness {
    Alive,
    Dead,
    Unknown,
}

/// Go `toolStatus`: 도구 하나의 에이전트 상태 관측이다. `quiet_ms` 의 -1 은 출력을 본 적이 없다는
/// 뜻이다.
#[derive(Clone, Debug, Default, Serialize)]
pub(crate) struct ToolStatus {
    #[serde(rename = "toolId")]
    pub(crate) tool_id: String,
    pub(crate) live: bool,
    #[serde(rename = "liveUnknown", skip_serializing_if = "std::ops::Not::not")]
    pub(crate) live_unknown: bool,
    pub(crate) state: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub(crate) tool: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub(crate) detail: String,
    #[serde(rename = "updatedAt")]
    pub(crate) updated_at: i64,
    #[serde(rename = "lastOutputAt")]
    pub(crate) last_output_at: i64,
    #[serde(rename = "quietMs")]
    pub(crate) quiet_ms: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) context: Option<ToolContext>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) usage: Option<ToolUsage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) subagents: Option<Vec<Subagent>>,
    /// 이 도구가 Run 멤버면 그 멤버와 계산한 상태다 (FR-ITC-5).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) member: Option<ToolMember>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub(crate) limits: Vec<LimitEntry>,
}

/// Go `toolMember`.
#[derive(Clone, Debug, Default, Serialize)]
pub(crate) struct ToolMember {
    pub(crate) id: String,
    pub(crate) state: String,
}

/// Go `waitResult`: 대기의 결말이다. `timeout` 은 실패가 아니라 체크포인트다 (FR-STA-6).
#[derive(Serialize)]
struct WaitResult<'a> {
    #[serde(rename = "toolId")]
    tool_id: &'a str,
    live: bool,
    #[serde(rename = "liveUnknown", skip_serializing_if = "std::ops::Not::not")]
    live_unknown: bool,
    state: &'a str,
    #[serde(skip_serializing_if = "str::is_empty")]
    tool: &'a str,
    #[serde(skip_serializing_if = "str::is_empty")]
    detail: &'a str,
    #[serde(rename = "updatedAt")]
    updated_at: i64,
    #[serde(rename = "lastOutputAt")]
    last_output_at: i64,
    #[serde(rename = "quietMs")]
    quiet_ms: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    context: &'a Option<ToolContext>,
    #[serde(skip_serializing_if = "Option::is_none")]
    usage: &'a Option<ToolUsage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    subagents: &'a Option<Vec<Subagent>>,
    #[serde(skip_serializing_if = "<[LimitEntry]>::is_empty")]
    limits: &'a [LimitEntry],
    status: &'a str,
    #[serde(skip_serializing_if = "str::is_empty")]
    reason: &'a str,
    #[serde(rename = "waitedMs")]
    waited_ms: i64,
    #[serde(rename = "timeoutMs")]
    timeout_ms: i64,
}

fn unix_nanos_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_nanos()).unwrap_or(i64::MAX))
}

/// Go `evaluateWait`: 준비 사다리(FR-STA-4)와 막힘 규칙(FR-STA-5). 아직 기다려야 하면 `None` 이다.
/// 사다리의 2단계(어댑터의 화면 패턴)는 Go 처럼 비어 있다.
pub(crate) fn evaluate_wait(
    cond: &str,
    st: &ToolStatus,
    allow_quiescence: bool,
) -> Option<(&'static str, &'static str)> {
    // §3.4a: 생존을 모르면 끝내지 않는다.
    if st.live_unknown {
        return None;
    }
    if !st.live {
        return Some(("gone", "tool 이 사라졌다"));
    }
    match st.state.as_str() {
        // 권한 확인 대기는 시간이 지난다고 풀리지 않는다.
        activity::WAITING => return Some(("blocked", activity::WAITING)),
        activity::IDLE if cond == "ready" => return Some(("ready", "hook")),
        activity::DONE if cond == "ready" => return Some(("ready", "hook")),
        activity::DONE => return Some(("done", "hook")),
        _ => {}
    }
    // 정적 폴백은 ready 전용이다 — 침묵은 완료의 근거가 아니다.
    if allow_quiescence
        && cond == "ready"
        && st.state == ACTIVITY_STATE_UNKNOWN
        && st.quiet_ms >= READY_QUIET_MS
    {
        return Some(("ready", "quiescence"));
    }
    None
}

/// Go `nextWaitEval`: 알림 없이 판정이 바뀔 수 있는 가장 이른 시각이다.
fn next_wait_eval(
    cond: &str,
    st: &ToolStatus,
    allow_quiescence: bool,
    live_checked_at: Instant,
) -> Instant {
    let mut next = live_checked_at + WAIT_LIVENESS_INTERVAL;
    if allow_quiescence
        && cond == "ready"
        && st.state == ACTIVITY_STATE_UNKNOWN
        && st.last_output_at > 0
    {
        let quiet_at = st.last_output_at.saturating_add(READY_QUIET_MS * 1_000_000);
        let left = quiet_at.saturating_sub(unix_nanos_now());
        let quiet = Instant::now() + Duration::from_nanos(u64::try_from(left).unwrap_or(0));
        if quiet < next {
            next = quiet;
        }
    }
    next
}

impl Server {
    /// Go `toolLive`: 생존을 묻는다. 데몬 모드에서는 RPC 이므로 되풀이하는 쪽은 주기를 둔다.
    pub(crate) fn tool_live(&self, tool_id: &str) -> bool {
        self.deps.tool_io.as_ref().is_some_and(|io| io.has(tool_id))
    }

    /// Go `toolLiveness`: dead 는 데몬이 목록에 답했고 그 목록에 없을 때만이다 (FR-ARD-1).
    pub(crate) fn tool_liveness(&self, tool_id: &str) -> Liveness {
        if let Some(h) = &self.deps.tools
            && h.list_ok().is_none()
        {
            return Liveness::Unknown;
        }
        if self.tool_live(tool_id) {
            Liveness::Alive
        } else {
            Liveness::Dead
        }
    }

    /// 확인된 죽음이다 — 수거가 지워도 되는 근거 (FR-ARD-2·5).
    #[allow(dead_code)]
    pub(crate) fn tool_dead(&self, tool_id: &str) -> bool {
        self.tool_liveness(tool_id) == Liveness::Dead
    }

    /// prune 에 넘기는 질의다. 모르는 도구의 기록은 남긴다 (FR-ARD-2).
    #[allow(dead_code)]
    pub(crate) fn tool_not_dead(&self, tool_id: &str) -> bool {
        !self.tool_dead(tool_id)
    }

    /// Go `toolStatusAt`: 모르면 live:false 에 liveUnknown:true 다 (FR-ARD-2).
    pub(crate) fn tool_status_at(&self, tool_id: &str, lv: Liveness) -> ToolStatus {
        let mut st = self.tool_status_of(tool_id, lv == Liveness::Alive);
        st.live_unknown = lv == Liveness::Unknown;
        st
    }

    /// Go `toolStatusOf`: 관측을 조립한다.
    pub(crate) fn tool_status_of(&self, tool_id: &str, live: bool) -> ToolStatus {
        let mut st = ToolStatus {
            tool_id: tool_id.to_owned(),
            live,
            state: ACTIVITY_STATE_UNKNOWN.to_owned(),
            quiet_ms: -1,
            ..ToolStatus::default()
        };
        let attn = self.attention();
        if let Some(a) = attn.activity(tool_id) {
            st.state = a.state;
            st.tool = a.tool;
            st.detail = a.detail;
            st.updated_at = a.updated_at;
        }
        let last = attn.last_output_at(tool_id);
        if last > 0 {
            st.last_output_at = last;
            st.quiet_ms = (unix_nanos_now() - last) / 1_000_000;
        }
        (st.context, st.usage) = self.tool_usage_view(tool_id);
        st.subagents = self.fresh_subagents(tool_id);
        st
    }

    /// Go `quiescenceAllowed`: 훅으로 준비완료를 말하는 에이전트에는 정적 폴백을 쓰지 않는다.
    /// 어떤 에이전트가 도는지는 Run 멤버 기록이 안다. 멤버가 아닌 도구는 폴백을 허용한다
    /// (NFR-RUN-1).
    pub(crate) fn quiescence_allowed(&self, tool_id: &str) -> bool {
        let Some(m) = self.runs().and_then(|st| st.member_by_tool(tool_id)) else {
            return true;
        };
        match dm_shared_agentadapter::get(&m.agent) {
            Ok(ad) => !ad.readiness.hooks,
            Err(_) => true,
        }
    }

    /// GET /api/tools/activity/get?id= (FR-STA-1).
    pub(crate) async fn api_tool_status(&self, r: &mut Req) -> Response {
        if let Err(res) = self.tool_io_ready() {
            return res;
        }
        let id = r.q("id");
        let Some(srv) = self.arc() else {
            return write_tool_io_error(StatusCode::SERVICE_UNAVAILABLE, "server gone");
        };
        let res = off_thread(move || -> Result<ToolStatus, Response> {
            let tool_id = srv.resolve_tool_id(&id)?;
            let mut st = srv.tool_status_at(&tool_id, srv.tool_liveness(&tool_id));
            if let Some(m) = srv.runs().and_then(|r| r.member_by_tool(&tool_id)) {
                let state = srv.derive_member_state(&m);
                st.member = Some(ToolMember { id: m.id, state });
            }
            st.limits = srv.agents.rate_limits.view(time::OffsetDateTime::now_utc());
            Ok(st)
        })
        .await;
        match res {
            Some(Ok(st)) => write_json(&st),
            Some(Err(res)) => res,
            None => write_tool_io_error(StatusCode::SERVICE_UNAVAILABLE, "server gone"),
        }
    }

    /// GET /api/tools/activity/wait?id=&for=&timeoutMs= (FR-STA-2/3). 조건이 서거나 상한이 지날
    /// 때까지 요청을 붙잡는다. 결말은 모두 200 이고 `status` 가 결과를 말한다.
    pub(crate) async fn api_tool_status_wait(&self, r: &mut Req) -> Response {
        if let Err(res) = self.tool_io_ready() {
            return res;
        }
        // FR-STA-9: 동시 대기 상한. 자리를 먼저 잡고, 돌려주는 것은 Drop 이 한다.
        let in_flight = &self.waits.in_flight;
        if in_flight.fetch_add(1, Ordering::SeqCst) + 1 > self.waits.max.load(Ordering::SeqCst) {
            in_flight.fetch_sub(1, Ordering::SeqCst);
            return write_tool_io_error(
                StatusCode::TOO_MANY_REQUESTS,
                "동시 대기가 상한에 닿았다 — 잠시 뒤 다시 시도하세요",
            );
        }
        let _seat = Seat(in_flight);
        let cond = r.q("for");
        if cond != "ready" && cond != "done" {
            return write_tool_io_error(
                StatusCode::BAD_REQUEST,
                &format!("for 는 ready 또는 done 이어야 한다: {cond}"),
            );
        }
        let mut timeout_ms = WAIT_DEFAULT_TIMEOUT_MS;
        let v = r.q("timeoutMs");
        if !v.is_empty() {
            match v.parse::<i64>() {
                Ok(n) => timeout_ms = n,
                Err(_) => {
                    return write_tool_io_error(
                        StatusCode::BAD_REQUEST,
                        &format!("timeoutMs 는 정수여야 한다: {v}"),
                    );
                }
            }
        }
        // 클램프는 조용하지 않다 — 유효값을 응답에 실어 호출자가 알 수 있게 한다.
        timeout_ms = timeout_ms.clamp(WAIT_MIN_TIMEOUT_MS, WAIT_MAX_TIMEOUT_MS);
        let Some(srv) = self.arc() else {
            return write_tool_io_error(StatusCode::SERVICE_UNAVAILABLE, "server gone");
        };
        let id = r.q("id");
        let resolved = {
            let srv = srv.clone();
            off_thread(move || {
                srv.resolve_tool_id(&id)
                    .map(|t| (srv.quiescence_allowed(&t), t))
            })
            .await
        };
        let (allow_quiescence, tool_id) = match resolved {
            Some(Ok(v)) => v,
            Some(Err(res)) => return res,
            None => return write_tool_io_error(StatusCode::SERVICE_UNAVAILABLE, "server gone"),
        };
        let start = Instant::now();
        let outcome = wait_loop(
            srv,
            &r.ctx,
            Arc::from(tool_id.as_str()),
            cond == "ready",
            allow_quiescence,
            start + Duration::from_millis(timeout_ms as u64),
        )
        .await;
        let Some((st, status, reason)) = outcome else {
            // 호출자가 끊은 것이다. 응답할 상대가 없다.
            return write_tool_io_error(StatusCode::SERVICE_UNAVAILABLE, "canceled");
        };
        write_json(&WaitResult {
            tool_id: &st.tool_id,
            live: st.live,
            live_unknown: st.live_unknown,
            state: &st.state,
            tool: &st.tool,
            detail: &st.detail,
            updated_at: st.updated_at,
            last_output_at: st.last_output_at,
            quiet_ms: st.quiet_ms,
            context: &st.context,
            usage: &st.usage,
            subagents: &st.subagents,
            limits: &st.limits,
            status,
            reason,
            waited_ms: i64::try_from(start.elapsed().as_millis()).unwrap_or(i64::MAX),
            timeout_ms,
        })
    }
}

/// 대기 본체 (Go `pollwait.OnOrAt` 자리). 생존 확인은 RPC 일 수 있어 워커 밖에서 돈다.
/// 끊기면 `None` 이다.
async fn wait_loop(
    srv: Arc<Server>,
    cancel: &tokio_util::sync::CancellationToken,
    tool_id: Arc<str>,
    ready: bool,
    allow_quiescence: bool,
    deadline: Instant,
) -> Option<(ToolStatus, &'static str, &'static str)> {
    let cond: &'static str = if ready { "ready" } else { "done" };
    // resolve_tool_id 가 방금 생존을 증명했다.
    let mut live = Liveness::Alive;
    let mut live_checked_at = Instant::now();
    loop {
        let mut ch = srv.activity_changed.c();
        #[cfg(test)]
        srv.waits.evals.fetch_add(1, Ordering::SeqCst);
        let (st, verdict, next) = {
            let srv = srv.clone();
            let tool_id = tool_id.clone();
            let now = Instant::now();
            let probe = now.duration_since(live_checked_at) >= WAIT_LIVENESS_INTERVAL;
            let (st, lv) = off_thread(move || {
                let lv = if probe {
                    srv.tool_liveness(&tool_id)
                } else {
                    live
                };
                (srv.tool_status_at(&tool_id, lv), lv)
            })
            .await?;
            if probe {
                live = lv;
                live_checked_at = now;
            }
            let verdict = evaluate_wait(cond, &st, allow_quiescence);
            let next = next_wait_eval(cond, &st, allow_quiescence, live_checked_at);
            (st, verdict, next)
        };
        if let Some((status, reason)) = verdict {
            return Some((st, status, reason));
        }
        if Instant::now() >= deadline {
            return Some((st, "timeout", ""));
        }
        let wake = next.min(deadline);
        tokio::select! {
            _ = cancel.cancelled() => return None,
            _ = tokio::time::sleep_until(wake.into()) => {}
            _ = ch.wait() => {}
        }
    }
}
