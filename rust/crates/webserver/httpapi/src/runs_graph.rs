//! 묶음 V — Run 의 관계도 (Go `handlers_runs_graph.go`, RUN_VISUALIZATION_SRS).
//!
//! 그래프는 기록에서 계산한다 — 따로 저장하지 않는다. 메시지 엣지는 `/api/tools/message` 가
//! 남긴 메타데이터다 (FR-RVZ-*). 본문은 싣지 않는다.

use std::collections::{BTreeMap, HashMap};

use dm_gocompat::json::is_empty;
use dm_shared_dmlog::infof;
use dm_webserver_domain_run::{self as run, ContextState, Member, MsgEvent, Record};
use serde::Serialize;

use crate::Server;
use crate::req::Req;
use crate::runs::{Actions, RunFail, extra1, member_actions, run_actions, write_run_error};
use crate::runs_recover::{coord_target, member_target};
use dm_shared_httpresp::Response;

const GRAPH_EVENT_RUN_START: &str = "run_start";
const GRAPH_EVENT_MEMBER_ADD: &str = "member_add";
const GRAPH_EVENT_REPORT: &str = "report";
const GRAPH_EVENT_SUCCEED: &str = "succeed";
const GRAPH_EVENT_CLOSE: &str = "close";

fn is_false(b: &bool) -> bool {
    !*b
}

/// Go `runGraphView`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RunGraphView {
    run_id: String,
    short: String,
    objective: String,
    state: String,
    isolation: String,
    created_at: i64,
    #[serde(skip_serializing_if = "is_empty")]
    closed_at: i64,
    #[serde(skip_serializing_if = "is_empty")]
    coordinator_tool_id: String,
    #[serde(skip_serializing_if = "is_empty")]
    coordinator_agent: String,
    #[serde(skip_serializing_if = "is_false")]
    coordinator_recoverable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    coordinator: Option<GraphContext>,
    #[serde(skip_serializing_if = "is_empty")]
    tree: String,
    actions: Actions,
    members: Vec<GraphMember>,
    edges: Vec<GraphEdge>,
    messages: Vec<MsgEvent>,
    timeline: Vec<GraphEvent>,
}

/// Go `graphMember`: 노드 하나.
#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GraphMember {
    pub(crate) id: String,
    pub(crate) role: String,
    pub(crate) agent: String,
    pub(crate) tool_id: String,
    #[serde(skip_serializing_if = "is_empty")]
    pub(crate) tab_id: String,
    #[serde(skip_serializing_if = "is_false")]
    pub(crate) headless: bool,
    pub(crate) state: String,
    pub(crate) actions: Actions,
    #[serde(skip_serializing_if = "is_empty")]
    pub(crate) outcome: String,
    #[serde(skip_serializing_if = "is_false")]
    pub(crate) recoverable: bool,
    #[serde(skip_serializing_if = "is_empty")]
    pub(crate) context_ratio: f64,
    #[serde(skip_serializing_if = "is_empty")]
    pub(crate) context_level: String,
    #[serde(skip_serializing_if = "is_empty")]
    pub(crate) compact_count: i64,
    #[serde(skip_serializing_if = "is_empty")]
    pub(crate) context_tokens: i64,
    #[serde(skip_serializing_if = "is_empty")]
    pub(crate) context_limit: f64,
    #[serde(skip_serializing_if = "is_empty")]
    pub(crate) succeeded_by: String,
    #[serde(skip_serializing_if = "is_empty")]
    pub(crate) succeeded_from: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) worktree: Option<GraphWorktree>,
    pub(crate) created_at: i64,
    #[serde(skip_serializing_if = "is_empty")]
    pub(crate) reported_at: i64,
}

#[derive(Serialize, Clone)]
pub(crate) struct GraphWorktree {
    #[serde(skip_serializing_if = "is_empty")]
    branch: String,
    #[serde(skip_serializing_if = "is_empty")]
    path: String,
}

/// Go `graphContext`: 조정자의 컨텍스트 관측 (FR-RCX-7).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GraphContext {
    #[serde(skip_serializing_if = "is_empty")]
    context_ratio: f64,
    #[serde(skip_serializing_if = "is_empty")]
    context_level: String,
    #[serde(skip_serializing_if = "is_empty")]
    compact_count: i64,
    #[serde(skip_serializing_if = "is_empty")]
    context_tokens: i64,
    #[serde(skip_serializing_if = "is_empty")]
    context_limit: f64,
}

fn graph_coordinator(c: Option<&ContextState>) -> Option<GraphContext> {
    c.map(|c| GraphContext {
        context_ratio: c.context_ratio,
        context_level: c.context_level.clone(),
        compact_count: c.compact_count,
        context_tokens: c.context_tokens,
        context_limit: c.context_limit,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GraphEdge {
    from: String,
    to: String,
    count: i64,
    last_at: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GraphEvent {
    at: i64,
    kind: &'static str,
    #[serde(skip_serializing_if = "is_empty")]
    member_id: String,
    #[serde(skip_serializing_if = "is_empty")]
    text: String,
}

/// Go `graphEdges`: (from,to) 쌍마다 하나, 처음 나온 순서다.
fn graph_edges(msgs: &[MsgEvent]) -> Vec<GraphEdge> {
    let mut out: Vec<GraphEdge> = Vec::new();
    let mut at: HashMap<(&str, &str), usize> = HashMap::new();
    for ev in msgs {
        let key = (ev.from.as_str(), ev.to.as_str());
        match at.get(&key) {
            Some(&i) => {
                out[i].count += 1;
                if ev.at > out[i].last_at {
                    out[i].last_at = ev.at;
                }
            }
            None => {
                at.insert(key, out.len());
                out.push(GraphEdge {
                    from: ev.from.clone(),
                    to: ev.to.clone(),
                    count: 1,
                    last_at: ev.at,
                });
            }
        }
    }
    out
}

/// Go `graphTimeline`: 시각 순(안정 정렬).
fn graph_timeline(rec: &Record) -> Vec<GraphEvent> {
    let mut out = vec![GraphEvent {
        at: rec.created_at,
        kind: GRAPH_EVENT_RUN_START,
        member_id: String::new(),
        text: rec.objective.clone(),
    }];
    for m in &rec.members {
        let kind = if m.succeeded_from.is_empty() {
            GRAPH_EVENT_MEMBER_ADD
        } else {
            GRAPH_EVENT_SUCCEED
        };
        out.push(GraphEvent {
            at: m.created_at,
            kind,
            member_id: m.id.clone(),
            text: m.role.clone(),
        });
        if m.reported() {
            out.push(GraphEvent {
                at: m.reported_at,
                kind: GRAPH_EVENT_REPORT,
                member_id: m.id.clone(),
                text: m.outcome.clone(),
            });
        }
    }
    if rec.closed_at != 0 {
        out.push(GraphEvent {
            at: rec.closed_at,
            kind: GRAPH_EVENT_CLOSE,
            member_id: String::new(),
            text: rec.abort_reason.clone(),
        });
    }
    out.sort_by_key(|e| e.at);
    out
}

impl Server {
    /// GET /api/runs/{id}/graph (묶음 V).
    pub(crate) async fn api_run_graph(&self, r: &mut Req) -> Response {
        let st = match self.runs_ready() {
            Ok(st) => st,
            Err(res) => return res,
        };
        let p = r.path.strip_prefix("/api/runs/").unwrap_or(&r.path);
        let id = p.strip_suffix("/graph").unwrap_or(p).to_owned();
        self.run_sync(r, move |s, _| match st.get(&id) {
            Some(rec) => crate::httperr::write_json(&s.graph_of(&rec)),
            None => write_run_error(&RunFail::of(run::Error::UnknownRun), extra1("runId", &id)),
        })
        .await
    }

    fn graph_of(&self, rec: &Record) -> RunGraphView {
        RunGraphView {
            run_id: rec.id.clone(),
            short: rec.short.clone(),
            objective: rec.objective.clone(),
            state: rec.state.clone(),
            isolation: rec.isolation.clone(),
            created_at: rec.created_at,
            closed_at: rec.closed_at,
            coordinator_tool_id: rec.coordinator_tool_id.clone(),
            coordinator_agent: rec.coordinator_agent.clone(),
            coordinator_recoverable: rec.state == run::OPEN && self.recoverable(&coord_target(rec)),
            coordinator: graph_coordinator(rec.coordinator.as_ref()),
            tree: rec.tree.clone(),
            actions: run_actions(rec),
            members: self.graph_members(rec),
            edges: graph_edges(&rec.messages),
            messages: rec.messages.clone(),
            timeline: graph_timeline(rec),
        }
    }

    /// Go `graphMembers`.
    pub(crate) fn graph_members(&self, rec: &Record) -> Vec<GraphMember> {
        let open = rec.state == run::OPEN;
        rec.members
            .iter()
            .map(|m| GraphMember {
                id: m.id.clone(),
                role: m.role.clone(),
                agent: m.agent.clone(),
                tool_id: m.tool_id.clone(),
                tab_id: m.tab_id.clone(),
                headless: m.headless,
                state: self.graph_member_state(m),
                actions: member_actions(m),
                outcome: m.outcome.clone(),
                recoverable: open && self.recoverable(&member_target(m)),
                context_ratio: m.context.context_ratio,
                context_level: m.context.context_level.clone(),
                compact_count: m.context.compact_count,
                context_tokens: m.context.context_tokens,
                context_limit: m.context.context_limit,
                succeeded_by: m.succeeded_by.clone(),
                succeeded_from: m.succeeded_from.clone(),
                worktree: m.worktree.as_ref().map(|w| GraphWorktree {
                    branch: w.branch.clone(),
                    path: w.path.clone(),
                }),
                created_at: m.created_at,
                reported_at: m.reported_at,
            })
            .collect()
    }

    /// Go `graphMemberState`: 승계된 멤버는 그 사실을 그대로 보인다.
    fn graph_member_state(&self, m: &Member) -> String {
        if m.state == run::SUCCEEDED {
            return run::SUCCEEDED.to_owned();
        }
        self.derive_member_state(m)
    }

    /// Go `recordRunMessage`: 열린 Run 의 두 참여자 사이 메시지를 엣지로 남긴다 (FR-RVZ-*).
    pub(crate) fn record_run_message(&self, from_tool_id: &str, to_tool_id: &str, size: usize) {
        let Some(st) = self.runs() else {
            return;
        };
        let Some(rec) = self.message_run(from_tool_id, to_tool_id) else {
            return;
        };
        let (Some(from), Some(to)) = (
            self.graph_party(&rec, from_tool_id),
            self.graph_party(&rec, to_tool_id),
        ) else {
            return;
        };
        let ev = MsgEvent {
            from: from.clone(),
            to: to.clone(),
            kind: run::MSG_KIND_AGENT.to_owned(),
            size: size as i64,
            ..MsgEvent::default()
        };
        if let Err(e) = st.append_message(&rec.id, ev) {
            infof!(
                None,
                "[run] 메시지 기록 생략 run={} from={from} to={to}: {e}",
                rec.short
            );
            return;
        }
        self.broadcast_run_changed(&rec);
    }

    /// Go `broadcastRunChanged`: 열린 대시보드가 다시 받게 알린다 (RUN_VIEW_LIVE_SRS).
    pub(crate) fn broadcast_run_changed(&self, rec: &Record) {
        let mut args = BTreeMap::from([(
            "runId".to_owned(),
            serde_json::Value::String(rec.id.clone()),
        )]);
        if !rec.tree.is_empty() {
            args.insert(
                "tree".to_owned(),
                serde_json::Value::String(rec.tree.clone()),
            );
        }
        self.broadcast_layout("run_changed", Some(&args));
    }

    /// Go `messageRun`: 받는 쪽의 Run 이 먼저다.
    fn message_run(&self, from_tool_id: &str, to_tool_id: &str) -> Option<Record> {
        self.open_run_of_tool(to_tool_id)
            .or_else(|| self.open_run_of_tool(from_tool_id))
            .map(|(rec, _)| rec)
    }

    /// Go `graphParty`: 도구를 그 Run 의 참여자 이름(멤버 id 또는 coordinator)으로 옮긴다.
    fn graph_party(&self, rec: &Record, tool_id: &str) -> Option<String> {
        if tool_id.is_empty() {
            return None;
        }
        if let Some(m) = rec.members.iter().find(|m| m.tool_id == tool_id) {
            return Some(m.id.clone());
        }
        if tool_id == rec.coordinator_tool_id {
            return Some(run::COORDINATOR_PARTY.to_owned());
        }
        self.open_run_of_tool(tool_id).map(|(_, m)| m.id)
    }

    /// Go `openRunOfTool`: 도구가 멤버인 열린 Run.
    pub(crate) fn open_run_of_tool(&self, tool_id: &str) -> Option<(Record, Member)> {
        if tool_id.is_empty() {
            return None;
        }
        let st = self.runs()?;
        st.list()
            .into_iter()
            .filter(|rec| rec.state == run::OPEN)
            .find_map(|rec| {
                let m = rec.members.iter().find(|m| m.tool_id == tool_id)?.clone();
                Some((rec, m))
            })
    }
}
