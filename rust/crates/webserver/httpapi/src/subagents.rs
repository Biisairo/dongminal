//! 도구별 서브에이전트 목록과 훅 활동 (Go `handlers_subagents.go`·`handlers_subagent_activity.go`).
//!
//! `otterctl subagent-statusline` 이 틱(약 5초)마다 목록을 보낸다. 보일 행이 없으면 틱이 멈추므로,
//! 받은 지 [`SUBAGENT_STALE`] 이 지난 목록은 없는 것으로 본다 (FR-SAU-12).

use std::cmp::Ordering;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Mutex;
use std::time::Duration;

use http::StatusCode;
use otter_shared_activity as activity;
use otter_shared_agentrec::{self as agentrec, SubagentActivity};
use otter_shared_httpresp::Response;
use otter_shared_statusline::Subagent;
use otter_shared_toolipc as toolipc;
use otter_webserver_apierr as apierr;
use otter_webserver_domain_run::ContextPolicy;
use serde::Serialize;
use time::OffsetDateTime;

use crate::Server;
use crate::httperr::{decode_json_body, http_err, write_json};
use crate::req::Req;
use crate::usage::{lock, unix_milli};

/// 목록이 신선한 기한이다 — 틱 셋이다 (FR-SAU-12).
pub(crate) const SUBAGENT_STALE: Duration = Duration::from_secs(15);

#[derive(Clone)]
pub(crate) struct SubagentList {
    pub(crate) tasks: Option<Vec<Subagent>>,
    pub(crate) observed_at: OffsetDateTime,
}

fn older_than(now: OffsetDateTime, at: OffsetDateTime, keep: Duration) -> bool {
    (now - at) > keep
}

#[derive(Default)]
pub(crate) struct SubagentStore {
    pub(crate) m: Mutex<HashMap<String, SubagentList>>,
}

impl SubagentStore {
    pub(crate) fn put(&self, tool_id: &str, tasks: Option<Vec<Subagent>>, at: OffsetDateTime) {
        lock(&self.m).insert(
            tool_id.to_owned(),
            SubagentList {
                tasks,
                observed_at: at,
            },
        );
    }

    /// now 기준으로 신선한 목록이다. 없거나 기한이 지났으면 `None` 이다.
    pub(crate) fn get(&self, tool_id: &str, now: OffsetDateTime) -> Option<Vec<Subagent>> {
        let m = lock(&self.m);
        let l = m.get(tool_id)?;
        if older_than(now, l.observed_at, SUBAGENT_STALE) {
            return None;
        }
        Some(l.tasks.clone().unwrap_or_default())
    }

    /// live 가 거짓인 도구의 목록을 지우고 지운 수를 돌려준다 (FR-SAU-11).
    #[allow(dead_code)]
    pub(crate) fn prune(&self, live: impl Fn(&str) -> bool) -> usize {
        let mut m = lock(&self.m);
        let before = m.len();
        m.retain(|id, _| live(id));
        before - m.len()
    }
}

#[derive(Default)]
pub(crate) struct SubagentActivityStore {
    pub(crate) m: Mutex<HashMap<String, BTreeMap<String, SubagentActivity>>>,
}

impl SubagentActivityStore {
    /// 활동 하나를 덮어쓴다. 상한 규칙은 `agentrec::put_subagent_activity` 다 (FR-ASV-11).
    pub(crate) fn put(
        &self,
        tool_id: &str,
        agent_id: &str,
        a: SubagentActivity,
        now: OffsetDateTime,
    ) {
        let mut m = lock(&self.m);
        agentrec::put_subagent_activity(m.entry(tool_id.to_owned()).or_default(), agent_id, a, now);
    }

    /// now 기준으로 살아 있는 활동이다. 기한이 지난 done 은 여기서 지운다 (FR-ASV-12).
    pub(crate) fn list(
        &self,
        tool_id: &str,
        now: OffsetDateTime,
    ) -> BTreeMap<String, SubagentActivity> {
        let mut m = lock(&self.m);
        let Some(acts) = m.get_mut(tool_id) else {
            return BTreeMap::new();
        };
        acts.retain(|_, v| {
            !(v.state == activity::DONE
                && older_than(now, v.updated_at, agentrec::SUBAGENT_DONE_KEEP))
        });
        acts.clone()
    }

    /// 신호를 놓친 활동을 지운다 (FR-ASV-12 안전망, C-10·D-ASV-14).
    pub(crate) fn drop_stale(
        &self,
        tool_id: &str,
        now: OffsetDateTime,
        main_busy: bool,
        running: &HashSet<String>,
    ) {
        if main_busy {
            return;
        }
        if let Some(acts) = lock(&self.m).get_mut(tool_id) {
            acts.retain(|id, v| {
                v.state == activity::DONE
                    || running.contains(id)
                    || !older_than(now, v.updated_at, agentrec::SUBAGENT_STALE_KEEP)
            });
        }
    }

    /// 그 도구의 활동을 모두 지운다 — main 이 ended 일 때다 (FR-ASV-12).
    pub(crate) fn drop_tool(&self, tool_id: &str) {
        lock(&self.m).remove(tool_id);
    }

    /// live 가 거짓인 도구의 활동을 지우고 지운 도구 수를 돌려준다 (FR-ASV-12).
    #[allow(dead_code)]
    pub(crate) fn prune(&self, live: impl Fn(&str) -> bool) -> usize {
        let mut m = lock(&self.m);
        let before = m.len();
        m.retain(|id, _| live(id));
        before - m.len()
    }

    pub(crate) fn by_tool(&self, tool_id: &str) -> Option<BTreeMap<String, SubagentActivity>> {
        lock(&self.m).get(tool_id).cloned()
    }
}

/// 활동 목록 항목의 서브에이전트 하나다 (FR-SAU-13, FR-ASV-15).
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub(crate) struct CardSubagent {
    pub(crate) id: String,
    #[serde(rename = "agentType", skip_serializing_if = "String::is_empty")]
    pub(crate) agent_type: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub(crate) status: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub(crate) model: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub(crate) effort: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) tokens: Option<f64>,
    #[serde(rename = "windowTokens", skip_serializing_if = "Option::is_none")]
    pub(crate) window_tokens: Option<f64>,
    #[serde(rename = "ctxPct", skip_serializing_if = "Option::is_none")]
    pub(crate) ctx_pct: Option<f64>,
    #[serde(rename = "ctxLevel", skip_serializing_if = "String::is_empty")]
    pub(crate) ctx_level: String,
    #[serde(rename = "startTime", skip_serializing_if = "Option::is_none")]
    pub(crate) start_time: Option<f64>,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub(crate) state: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub(crate) tool: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub(crate) detail: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub(crate) description: String,
}

/// Go `cmp.Compare` 의 실수 비교다: NaN 은 무엇보다 작다.
fn go_cmp_f64(a: f64, b: f64) -> Ordering {
    match (a.is_nan(), b.is_nan()) {
        (true, true) => Ordering::Equal,
        (true, false) => Ordering::Less,
        (false, true) => Ordering::Greater,
        _ => a.partial_cmp(&b).unwrap_or(Ordering::Equal),
    }
}

/// Go `cardSubagentsOf`: statusLine 목록과 훅 활동을 합쳐 카드 원소로 바꾼다 (FR-SAU-13·14,
/// FR-ASV-14·15). statusLine 원소는 startTime 순이고 없는 원소는 받은 순서로 그 뒤에 선다.
/// statusLine 에 없는 활동은 맨 끝에 updatedAt 순이다. 비었으면 `None` 이다.
pub(crate) fn card_subagents_of(
    tasks: &[Subagent],
    acts: &BTreeMap<String, SubagentActivity>,
    p: ContextPolicy,
) -> Option<Vec<CardSubagent>> {
    if tasks.is_empty() && acts.is_empty() {
        return None;
    }
    let s = |v: &Option<String>| v.clone().unwrap_or_default();
    let mut out = Vec::with_capacity(tasks.len() + acts.len());
    let mut listed = HashSet::new();
    for t in tasks {
        let mut c = CardSubagent {
            id: s(&t.id),
            agent_type: s(&t.agent_type),
            status: s(&t.status),
            model: s(&t.model),
            effort: s(&t.effort),
            tokens: t.tokens,
            window_tokens: t.window_tokens,
            start_time: t.start_time,
            description: agentrec::sanitize(&s(&t.description), agentrec::DETAIL_MAX),
            ..CardSubagent::default()
        };
        listed.insert(c.id.clone());
        c.state = if c.status == "running" {
            activity::WORKING
        } else {
            activity::DONE
        }
        .to_owned();
        if let Some(a) = acts.get(&c.id) {
            c.state.clone_from(&a.state);
            c.tool.clone_from(&a.tool);
            c.detail.clone_from(&a.detail);
            if c.agent_type.is_empty() {
                c.agent_type.clone_from(&a.agent_type);
            }
        }
        if let (true, Some(b)) = (c.effort.is_empty(), t.effort_budget) {
            c.effort = otter_gocompat::strconv::format_float(b, b'f', -1, 64);
        }
        if let (Some(tok), Some(win)) = (t.tokens, t.window_tokens)
            && win > 0.0
        {
            let pct = tok * 100.0 / win;
            c.ctx_pct = Some(pct);
            c.ctx_level = p.grade(pct / 100.0, 0).to_owned();
        }
        out.push(c);
    }
    out.sort_by(|a, b| match (a.start_time, b.start_time) {
        (None, None) => Ordering::Equal,
        (None, _) => Ordering::Greater,
        (_, None) => Ordering::Less,
        (Some(x), Some(y)) => go_cmp_f64(x, y),
    });
    let mut extra: Vec<(&String, &SubagentActivity)> = acts
        .iter()
        .filter(|(id, _)| !listed.contains(*id))
        .collect();
    extra.sort_by(|(ia, a), (ib, b)| a.updated_at.cmp(&b.updated_at).then(ia.cmp(ib)));
    out.extend(extra.into_iter().map(|(id, a)| CardSubagent {
        id: id.clone(),
        agent_type: a.agent_type.clone(),
        state: a.state.clone(),
        tool: a.tool.clone(),
        detail: a.detail.clone(),
        ..CardSubagent::default()
    }));
    Some(out)
}

#[derive(Serialize)]
struct OkAny {
    ok: bool,
}

#[derive(Serialize)]
struct SubagentActivityEvent<'a> {
    #[serde(rename = "agentId")]
    agent_id: &'a str,
    #[serde(rename = "agentType")]
    agent_type: &'a str,
    detail: &'a str,
    state: &'a str,
    tool: &'a str,
    #[serde(rename = "toolId")]
    tool_id: &'a str,
}

impl Server {
    /// POST /api/tools/subagents (FR-SAU-10).
    pub(crate) async fn api_tool_subagents(&self, r: &mut Req) -> Response {
        let mut body: agentrec::SubagentsReport = match decode_json_body(r, 0).await {
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
        self.apply_subagents_report(&body);
        write_json(&OkAny { ok: true })
    }

    /// Go `applySubagentsReport`: HTTP 와 데몬의 report push 가 함께 지난다.
    pub(crate) fn apply_subagents_report(&self, body: &agentrec::SubagentsReport) {
        let now = OffsetDateTime::now_utc();
        self.agents
            .subagents
            .put(&body.tool_id, body.tasks.clone(), now);
        let rec = agentrec::SubagentList {
            tasks: body.tasks.clone(),
            observed_at: unix_milli(now),
        };
        self.put_record(toolipc::RECORD_SUBAGENTS, &body.tool_id, Some(&rec));
    }

    /// Go `freshSubagents`: 상태 응답에 얹을 목록이다. 비었으면 `None` 이다 (FR-SAU-15).
    pub(crate) fn fresh_subagents(&self, tool_id: &str) -> Option<Vec<Subagent>> {
        self.agents
            .subagents
            .get(tool_id, OffsetDateTime::now_utc())
            .filter(|t| !t.is_empty())
    }

    /// Go `reportSubagentActivity`: 서브에이전트 활동을 저장하고 방송한다 (FR-ASV-10·13). main
    /// 활동·알람·턴 표시는 건드리지 않는다.
    pub(crate) fn report_subagent_activity(&self, req: &agentrec::ActivityReport) {
        let (tool_id, agent_id) = (&req.tool_id, &req.agent_id);
        let a = agentrec::subagent_activity_of(req);
        self.agents
            .sub_acts
            .put(tool_id, agent_id, a.clone(), OffsetDateTime::now_utc());
        let by_tool = self.agents.sub_acts.by_tool(tool_id);
        self.put_record(toolipc::RECORD_SUBAGENT_ACTS, tool_id, Some(&by_tool));
        if let Some(cmds) = self.commands() {
            let ev = SubagentActivityEvent {
                agent_id,
                agent_type: &a.agent_type,
                detail: &a.detail,
                state: &a.state,
                tool: &a.tool,
                tool_id,
            };
            cmds.broadcast(&otter_webserver_sse::payload(
                "tool_subagent_activity",
                Some(&ev),
            ));
        }
    }
}
