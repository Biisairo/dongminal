//! 묶음 C — 컨텍스트 관측·승계·인수인계 (Go `handlers_runs_context.go`, RUN_CONTEXT_SRS).
//!
//! 관측은 훅이 보낸다. 등급이 올라가면 조정자에게 한 번 알리고(FR-CBG-7), 승계는 같은 역할·같은
//! 작업 트리의 새 멤버로 기록을 넘긴다 (FR-CBG-8). 전임자에게 요약을 청하고 상한만큼 기다린다.

use std::time::Duration;

use http::StatusCode;
use otter_shared_httpresp::Response;
use otter_shared_otterlog::{errorf, infof};
use otter_shared_pollwait as pollwait;
use otter_shared_runwait as runwait;
use otter_webserver_domain_run::{self as run, ContextObservation, ContextPolicy, Member, Record};
use serde::Deserialize;

use crate::Server;
use crate::go_embed::{Obj, raw};
use crate::httperr::{decode_json_body, write_json, write_tool_io_error};
use crate::req::Req;
use crate::runs::{MemberView, Rt, RunFail, extra1, invalid, write_run_error};
use crate::toolio::{ENVELOPE_SERVER_SENDER, agent_envelope};

/// 승계가 전임자의 요약을 기다리는 기본 상한이다 (FR-CBG-9).
const HANDOFF_WAIT_DEFAULT: Duration = runwait::HANDOFF_WAIT_DEFAULT;

#[derive(Deserialize, Default)]
#[serde(default)]
struct PolicyBlob {
    orchestration: Option<PolicyOrch>,
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct PolicyOrch {
    context_bytes_per_token: f64,
    context_limit_tokens: f64,
    context_warn_ratio: f64,
    context_critical_ratio: f64,
}

/// Go `parseContextPolicy`: settings.json 의 `orchestration` 에서 추정 공식과 임계를 읽는다
/// (FR-CBG-2). 읽지 못하면 기본값이다. 빠진 값(0)은 정책이 기본값으로 메운다. 설정 저장소
/// (5.5.8)가 쓴다.
#[allow(dead_code)]
pub(crate) fn parse_context_policy(blob: &[u8]) -> ContextPolicy {
    let Ok(cfg) = otter_gocompat::json::unmarshal::<Option<PolicyBlob>>(blob) else {
        return ContextPolicy::default_policy();
    };
    let o = cfg.and_then(|c| c.orchestration).unwrap_or_default();
    ContextPolicy {
        bytes_per_token: o.context_bytes_per_token,
        limit_tokens: o.context_limit_tokens,
        warn_ratio: o.context_warn_ratio,
        critical_ratio: o.context_critical_ratio,
    }
}

/// Go `contextReq`: 훅 한 번의 관측.
#[derive(Deserialize, Default)]
#[serde(default, rename = "httpapi.contextReq", rename_all = "camelCase")]
struct ContextReq {
    tool_id: String,
    /// transcript 크기. 음수·없음은 모른다.
    bytes: Option<i64>,
    session_id: String,
    compacted: bool,
    /// statusLine·transcript 가 말한 토큰 수. 음수·없음은 모른다.
    tokens: Option<i64>,
    model: String,
    agent: String,
    /// 받기만 한다 — 경로를 기록에 남기지 않는다.
    #[allow(dead_code)]
    transcript_path: String,
}

/// Go `contextObservation`.
fn context_observation(body: &ContextReq) -> ContextObservation {
    let mut obs = ContextObservation {
        session_id: body.session_id.clone(),
        compacted: body.compacted,
        model: body.model.clone(),
        agent: body.agent.clone(),
        ..ContextObservation::default()
    };
    if let Some(b) = body.bytes.filter(|b| *b >= 0) {
        obs.bytes = b;
        obs.has_bytes = true;
    }
    if let Some(t) = body.tokens.filter(|t| *t >= 0) {
        obs.tokens = t;
        obs.has_tokens = true;
    }
    obs
}

/// Go `contextResponse`.
fn context_response(m: &Member, entered: &str) -> Obj {
    let c = &m.context;
    let mut out = Obj::new();
    out.insert("observed", raw(&true));
    out.insert("level", raw(&c.context_level));
    out.insert("ratio", raw(&c.context_ratio));
    out.insert("compactCount", raw(&c.compact_count));
    out.insert("entered", raw(entered));
    out.insert("tokens", raw(&c.context_tokens));
    out.insert("limit", raw(&c.context_limit));
    if m.id.is_empty() {
        out.insert("coordinator", raw(&true));
        out.insert("runId", raw(&m.run_id));
    } else {
        out.insert("memberId", raw(&m.id));
    }
    out
}

fn not_observed() -> Response {
    write_json(&extra1("observed", &false))
}

/// Go `contextAlertAdvice`.
fn context_alert_advice(m: &Member, level: &str) -> String {
    let pct = (m.context.context_ratio * 100.0 + 0.5) as i64;
    let compact = if m.context.compact_count > 0 {
        format!(" (압축 {}회)", m.context.compact_count)
    } else {
        String::new()
    };
    if level == run::LEVEL_CRITICAL {
        return format!(
            "추정 사용률 ~{pct}%{compact}. 이 멤버에게 새 작업을 주지 마라. 승계를 검토해라."
        );
    }
    format!("추정 사용률 ~{pct}%{compact}. 이 멤버에게 새 **큰** 작업을 주지 마라.")
}

/// Go `succeedReq`.
#[derive(Deserialize, Default)]
#[serde(default, rename = "httpapi.succeedReq", rename_all = "camelCase")]
struct SucceedReq {
    member_id: String,
    at: String,
    headless: bool,
    timeout_ms: i64,
    tool_id: String,
    /// 자기 승계 — 요약을 스스로 싣는다 (FR-ITM-*).
    #[serde(rename = "self")]
    self_: bool,
    summary: String,
}

/// Go `selfSucceedMember`: 자기 승계는 부르는 도구가 그 멤버일 때만이다.
fn self_succeed_member(requested: &str, own: Option<&Member>) -> Result<String, RunFail> {
    match own {
        Some(m) if requested.is_empty() || requested == m.id => Ok(m.id.clone()),
        _ => Err(RunFail::of(run::Error::SenderNotMember)),
    }
}

/// Go `succeedArgsError`.
fn succeed_args_error(body: &SucceedReq) -> Option<RunFail> {
    if body.member_id.trim().is_empty() {
        return Some(invalid("--member 는 필수다"));
    }
    if body.headless && !body.at.is_empty() {
        return Some(invalid("--at 과 --headless 는 함께 쓸 수 없다"));
    }
    None
}

/// Go `worktreePath`: 격리 멤버의 작업 트리 경로.
pub(crate) fn worktree_path(wt: Option<&run::Worktree>) -> Option<String> {
    wt.filter(|w| !w.path.is_empty()).map(|w| w.path.clone())
}

/// Go `succeedResponse`.
fn succeed_response(view: &MemberView, prev_after: &Member) -> Obj {
    let mut out = Obj::new();
    out.insert("member", raw(view));
    out.insert("prevMemberId", raw(&prev_after.id));
    out.insert("prevState", raw(&prev_after.state));
    out.insert("hasSummary", raw(&!prev_after.handoff_summary.is_empty()));
    out
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct HandoffBody {
    member_id: String,
    tool_id: String,
    summary: String,
}

impl Server {
    /// POST /api/runs/context (묶음 C): 훅이 보낸 관측을 기록한다.
    pub(crate) async fn api_run_context(&self, r: &mut Req) -> Response {
        let st = match self.runs_ready() {
            Ok(st) => st,
            Err(res) => return res,
        };
        let body: ContextReq = match decode_json_body(r, 0).await {
            Ok(b) => b,
            Err(res) => return res,
        };
        let sender = self.caller_tool_id(r, &body.tool_id);
        self.run_sync(r, move |s, _| {
            let obs = context_observation(&body);
            if !st.has_open() {
                return not_observed();
            }
            let prev = st.member_by_tool(&sender);
            let Some((m, entered)) = st.observe_context(&sender, &obs, s.context_policy()) else {
                return not_observed();
            };
            if let Some(prev) = &prev
                && !m.id.is_empty()
                && m.context.context_level != prev.context.context_level
                && let Some(rec) = st.get(&m.run_id)
            {
                s.broadcast_run_changed(&rec);
            }
            if !entered.is_empty() {
                s.notify_context_alert(&m, &entered);
            }
            write_json(&context_response(&m, &entered))
        })
        .await
    }

    /// Go `observeUsageContext` 의 기록 쪽: 열린 Run 이 있을 때만 관측을 넣는다.
    pub(crate) fn observe_run_context(&self, tool_id: &str, obs: ContextObservation) {
        let Some(st) = self.runs() else {
            return;
        };
        if !st.has_open() {
            return;
        }
        if let Some((m, entered)) = st.observe_context(tool_id, &obs, self.context_policy())
            && !entered.is_empty()
        {
            self.notify_context_alert(&m, &entered);
        }
    }

    /// Go `notifyContextAlert`: 등급에 처음 들어설 때 조정자에게 한 번 알린다 (FR-CBG-7).
    fn notify_context_alert(&self, m: &Member, level: &str) {
        let (Some(st), Some(io)) = (self.runs(), &self.deps.tool_io) else {
            return;
        };
        if !self.run_aux.context_notices.claim(&m.id, level) {
            return;
        }
        let Some(rec) = st.get(&m.run_id) else {
            return;
        };
        if rec.coordinator_tool_id.is_empty() {
            return;
        }
        if !io.has(&rec.coordinator_tool_id) {
            infof!(
                None,
                "[run] context-alert 생략 run={} member={} level={level} — 조정자 도구가 없다",
                rec.short,
                m.id
            );
            return;
        }
        let body = format!(
            "[CONTEXT-ALERT run={} member={} role={} level={level}]\n{}\n승계: otterctl run succeed --member {} --at <새 탭 uuid> | --headless",
            rec.short,
            m.id,
            m.role,
            context_alert_advice(m, level),
            m.id
        );
        let envelope = agent_envelope(ENVELOPE_SERVER_SENDER, &rec.coordinator_tool_id, &body);
        if let Err(e) = self.deliver_to_tool(&rec.coordinator_tool_id, &envelope, true) {
            errorf!(
                None,
                "[run] context-alert 전달 실패 run={} member={}: {e}",
                rec.short,
                m.id
            );
            return;
        }
        infof!(
            None,
            "[run] context-alert run={} member={} role={} level={level} ratio={:.2} compact={}",
            rec.short,
            m.id,
            m.role,
            m.context.context_ratio,
            m.context.compact_count
        );
    }

    /// POST /api/runs/succeed (FR-CBG-8): 멤버를 새 도구로 승계한다.
    pub(crate) async fn api_run_succeed(&self, r: &mut Req) -> Response {
        let st = match self.runs_ready() {
            Ok(st) => st,
            Err(res) => return res,
        };
        if let Err(res) = self.tool_io_ready() {
            return res;
        }
        let mut body: SucceedReq = match decode_json_body(r, 0).await {
            Ok(b) => b,
            Err(res) => return res,
        };
        let caller = self.caller_tool_id(r, &body.tool_id);
        self.run_sync(r, move |s, rt| {
            if body.self_ {
                let own = st.member_by_tool(&caller);
                match self_succeed_member(&body.member_id, own.as_ref()) {
                    Ok(id) => body.member_id = id,
                    Err(e) => return write_run_error(&e, Obj::new()),
                }
            }
            if let Some(e) = succeed_args_error(&body) {
                return write_run_error(&e, Obj::new());
            }
            let (rec, prev) = match s.run_member(&st, &body.member_id) {
                Ok(v) => v,
                Err(res) => return res,
            };
            if rec.state != run::OPEN {
                return write_run_error(&RunFail::of(run::Error::RunClosed), Obj::new());
            }
            let tool_id = match s.succeed_tool(&body, &prev) {
                Ok(id) => id,
                Err(res) => return res,
            };
            let (summary, asked) = if body.self_ {
                (body.summary.trim().to_owned(), false)
            } else {
                s.request_handoff(&st, rt, &rec, &prev, body.timeout_ms)
            };
            if rt.canceled() {
                if body.headless
                    && let Some(hub) = s.tools(None)
                {
                    let _ = hub.delete(&tool_id);
                }
                infof!(
                    None,
                    "[run] succeed 중단 — 요청이 끊겼다 run={} member={}",
                    rec.short,
                    prev.id
                );
                return write_tool_io_error(StatusCode::SERVICE_UNAVAILABLE, "server gone");
            }
            s.complete_succeed(&st, &body, &rec, &prev, &tool_id, summary, asked)
        })
        .await
    }

    /// Go `succeedTool`: 후임 도구 — `--at` 의 탭이거나 새 헤드리스 도구다.
    fn succeed_tool(&self, body: &SucceedReq, prev: &Member) -> Result<String, Response> {
        if !body.headless {
            return self.resolve_tool_id(&body.at);
        }
        let cwd = match worktree_path(prev.worktree.as_ref()) {
            Some(p) => p,
            None => self
                .tools(None)
                .map(|h| h.cwd(&prev.tool_id))
                .unwrap_or_default(),
        };
        self.create_headless_tool(&cwd, "").map_err(|e| {
            write_tool_io_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                &format!("헤드리스 도구 생성 실패: {e}"),
            )
        })
    }

    #[allow(clippy::too_many_arguments)]
    fn complete_succeed(
        &self,
        st: &run::Store,
        body: &SucceedReq,
        rec: &Record,
        prev: &Member,
        tool_id: &str,
        summary: String,
        asked: bool,
    ) -> Response {
        let spec = run::SucceedSpec {
            prev_member_id: prev.id.clone(),
            tool_id: tool_id.to_owned(),
            tab_id: self.tab_id_of_tool(tool_id),
            headless: body.headless,
            summary,
            handoff_asked: asked,
            ..run::SucceedSpec::default()
        };
        let (prev_after, next) = match st.succeed(spec) {
            Ok(v) => v,
            Err(e) => {
                if body.headless
                    && let Some(hub) = self.tools(None)
                {
                    let _ = hub.delete(tool_id);
                    errorf!(None, "[run] headless 롤백 — 승계 실패: tool={tool_id}");
                }
                return write_run_error(&RunFail::of(e), Obj::new());
            }
        };
        let mut view = self.member_view(next.clone());
        if let Some(cur) = st.get(&rec.id) {
            self.mark_workspace_run(&cur, &next.tab_id, &cur.id);
            view.preamble = self.member_preamble(&cur, &next);
            self.broadcast_run_changed(&cur); // FR-RLV-3
        }
        self.notify_tree_succession(rec, &next);
        infof!(
            None,
            "[run] succeed run={} prev={} next={} role={} tool={} tab={} summary={} worktree={}",
            rec.short,
            prev_after.id,
            next.id,
            next.role,
            next.tool_id,
            next.tab_id,
            !prev_after.handoff_summary.is_empty(),
            next.worktree.is_some()
        );
        write_json(&succeed_response(&view, &prev_after))
    }

    /// Go `requestHandoff`: 전임자에게 요약을 청하고 상한만큼 기다린다. 두 번째 값은 청했는가다.
    fn request_handoff(
        &self,
        st: &run::Store,
        rt: &Rt,
        rec: &Record,
        prev: &Member,
        timeout_ms: i64,
    ) -> (String, bool) {
        let baseline = prev.handoff_summary.clone();
        if !self
            .deps
            .tool_io
            .as_ref()
            .is_some_and(|io| io.has(&prev.tool_id))
        {
            return (baseline, false);
        }
        let ask = format!(
            "[HANDOFF-REQUEST run={} member={}]\n\
             너는 곧 승계된다 — 같은 역할·같은 작업 트리의 새 멤버가 이 일을 이어받는다.\n\
             지금까지의 상태를 후임이 읽을 수 있게 남겨라. 무엇을 했는가 / 지금 어디까지\n\
             왔는가 / 다음에 무엇을 해야 하는가 / 알아야 할 함정. 아래를 한 번 실행한다.\n\
             otterctl run handoff --member {} --summary - <<'SUM'\n...본문...\nSUM",
            rec.short, prev.id, prev.id
        );
        let envelope = agent_envelope(ENVELOPE_SERVER_SENDER, &prev.tool_id, &ask);
        if let Err(e) = self.deliver_to_tool(&prev.tool_id, &envelope, true) {
            errorf!(
                None,
                "[run] handoff 요청 실패 run={} member={}: {e}",
                rec.short,
                prev.id
            );
            return (baseline, false);
        }
        let wait = if timeout_ms > 0 {
            Duration::from_millis(timeout_ms as u64)
        } else {
            HANDOFF_WAIT_DEFAULT
        };
        let mut summary = String::new();
        let res = rt.wait(pollwait::on(
            &rt.ctx,
            wait,
            || st.changes(),
            || match st.find_member(&prev.id) {
                Some((_, cur)) if cur.handoff_summary != baseline => {
                    summary = cur.handoff_summary;
                    true
                }
                _ => false,
            },
        ));
        match res {
            Ok(()) => (summary, true),
            Err(pollwait::WaitError::Canceled) => (baseline, true),
            Err(pollwait::WaitError::Timeout) => {
                infof!(
                    None,
                    "[run] handoff 시한 초과 run={} member={} wait={} — 요약 없이 승계하고 기다림을 프리앰블로 넘긴다",
                    rec.short,
                    prev.id,
                    otter_gocompat::time::format_std_duration(wait)
                );
                (baseline, true)
            }
        }
    }

    /// POST /api/runs/handoff (FR-CBG-9): 멤버가 인수인계 요약을 남긴다.
    pub(crate) async fn api_run_handoff(&self, r: &mut Req) -> Response {
        let st = match self.runs_ready() {
            Ok(st) => st,
            Err(res) => return res,
        };
        let body: HandoffBody = match decode_json_body(r, 0).await {
            Ok(b) => b,
            Err(res) => return res,
        };
        let sender = self.caller_tool_id(r, &body.tool_id);
        self.run_sync(r, move |_, _| {
            let m = match st.handoff(&sender, &body.member_id, &body.summary) {
                Ok(m) => m,
                Err(e) => return write_run_error(&RunFail::of(e), Obj::new()),
            };
            infof!(
                None,
                "[run] handoff run={} member={} tool={} len={}",
                m.run_id,
                m.id,
                m.tool_id,
                m.handoff_summary.len()
            );
            let mut out = Obj::new();
            out.insert("memberId", raw(&m.id));
            out.insert("runId", raw(&m.run_id));
            out.insert("len", raw(&m.handoff_summary.len()));
            write_json(&out)
        })
        .await
    }
}
