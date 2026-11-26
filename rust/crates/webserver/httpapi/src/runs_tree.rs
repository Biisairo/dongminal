//! 이슈 트리의 조회·승계 알림·조율 이전과 팀 조회 (Go `handlers_runs_tree.go`·
//! `handlers_runs_team.go`, ISSUE_AGENT_TREE_SRS·ISSUE_TREE_OPS_SRS).

use std::collections::{HashMap, HashSet};

use http::StatusCode;
use otter_shared_httpresp::Response;
use otter_shared_otterlog::{errorf, infof};
use otter_webserver_apierr as apierr;
use otter_webserver_domain_run::{self as run, Member, Record};
use serde::{Deserialize, Serialize, Serializer};

use crate::Server;
use crate::go_embed::{Embed, Obj, raw};
use crate::httperr::{decode_json_body, http_err, write_json};
use crate::req::Req;
use crate::runs::{RunFail, extra1, invalid, settled_state, write_run_error};
use crate::runs_graph::GraphMember;
use crate::runs_recover::member_target;
use crate::toolio::{ENVELOPE_SERVER_SENDER, agent_envelope};

/// 사슬 이름(role)의 마디 구분자다.
const TREE_CHAIN_SEP: &str = "›";
/// 트리의 보관 방식 (ISSUE_TREE_CHAT_SRS FR-LIS-1·17). 원본 이슈 폴더가 있으면 로컬이다.
const STORAGE_LOCAL: &str = "local";
const STORAGE_GITHUB: &str = "github";

fn storage_of(issue_dir: &str) -> &'static str {
    if issue_dir.is_empty() {
        STORAGE_GITHUB
    } else {
        STORAGE_LOCAL
    }
}

/// Go `treeNode`: 트리 노드 하나. 승계 사슬은 끝 멤버 하나로 보인다.
#[derive(Clone)]
struct TreeNode {
    gm: GraphMember,
    run_id: String,
    parent: String,
    leaf: bool,
    issue: String,
    title: String,
    ended_at: i64,
    recoverable: bool,
    /// 배정 부모(승계 사슬 끝으로 옮긴 뒤).
    parent_id: String,
    created_at: i64,
    /// 기록 안에서 사슬 첫 멤버의 자리 — 같은 초에 선 형제의 순서.
    seq: usize,
}

fn is_false(b: &bool) -> bool {
    !*b
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TreeOuter<'a> {
    run_id: &'a str,
    parent: &'a str,
    leaf: bool,
    #[serde(skip_serializing_if = "str::is_empty")]
    issue: &'a str,
    #[serde(skip_serializing_if = "str::is_empty")]
    title: &'a str,
    #[serde(skip_serializing_if = "otter_gocompat::json::is_empty")]
    ended_at: i64,
    #[serde(skip_serializing_if = "is_false")]
    recoverable: bool,
}

impl Serialize for TreeNode {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        Embed {
            inner: &self.gm,
            hide: &["recoverable"],
            outer: TreeOuter {
                run_id: &self.run_id,
                parent: &self.parent,
                leaf: self.leaf,
                issue: &self.issue,
                title: &self.title,
                ended_at: self.ended_at,
                recoverable: self.recoverable,
            },
        }
        .serialize(s)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TreeRun {
    id: String,
    short: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    window_id: String,
    #[serde(skip_serializing_if = "is_false")]
    tree_branch: bool,
}

/// Go `teamView`: 팀 동료 하나 (WS-4).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TeamView {
    role: String,
    member_id: String,
    to: String,
    state: String,
    headless: bool,
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct CoordinateBody {
    to: String,
    tool_id: String,
}

/// Go `treeParent`: 사슬 이름의 가장 긴 열린 조상.
fn tree_parent(role: &str, exists: &HashSet<String>) -> String {
    let parts: Vec<&str> = role.split(TREE_CHAIN_SEP).collect();
    for k in (1..parts.len()).rev() {
        let cand = parts[..k].join(TREE_CHAIN_SEP);
        if exists.contains(&cand) {
            return cand;
        }
    }
    String::new()
}

/// Go `treeEnded`.
fn tree_ended(st: &str) -> bool {
    settled_state(st)
}

/// Go `treeChainOrder`: 승계 사슬은 첫 멤버의 시각·자리를 잇는다.
fn tree_chain_order(members: &[Member]) -> (HashMap<String, i64>, HashMap<String, usize>) {
    let mut started = HashMap::new();
    let mut seq = HashMap::new();
    for (i, m) in members.iter().enumerate() {
        let (mut at, mut pos) = (m.created_at, i);
        if let Some(&a) = started.get(&m.succeeded_from) {
            at = a;
            pos = seq[&m.succeeded_from];
        }
        started.insert(m.id.clone(), at);
        seq.insert(m.id.clone(), pos);
    }
    (started, seq)
}

/// Go `linkTree`: 부모·잎을 정하고 깊이 우선 순서로 놓는다.
fn link_tree(mut nodes: Vec<TreeNode>, successor: &HashMap<String, String>) -> Vec<TreeNode> {
    let end = |id: &str| -> String {
        let mut id = id.to_owned();
        let mut seen = HashSet::new();
        while let Some(next) = successor.get(&id).filter(|n| !n.is_empty()) {
            if !seen.insert(id.clone()) {
                break;
            }
            id = next.clone();
        }
        id
    };
    let mut role_of = HashMap::new();
    let mut active = HashSet::new();
    for n in &nodes {
        role_of.insert(n.gm.id.clone(), n.gm.role.clone());
        if !tree_ended(&n.gm.state) {
            active.insert(n.gm.role.clone());
        }
    }
    for n in &mut nodes {
        n.parent = if n.parent_id.is_empty() {
            tree_parent(&n.gm.role, &active)
        } else {
            role_of.get(&end(&n.parent_id)).cloned().unwrap_or_default()
        };
    }
    let open_child: HashSet<String> = nodes
        .iter()
        .filter(|n| !tree_ended(&n.gm.state))
        .map(|n| n.parent.clone())
        .collect();
    for n in &mut nodes {
        n.leaf = !tree_ended(&n.gm.state) && !open_child.contains(&n.gm.role);
    }
    tree_depth_first(nodes)
}

/// Go `treeDepthFirst`: 시작 시각·자리 순으로 형제를 놓는다.
fn tree_depth_first(mut nodes: Vec<TreeNode>) -> Vec<TreeNode> {
    nodes.sort_by_key(|n| (n.created_at, n.seq));
    let present: HashSet<&str> = nodes.iter().map(|n| n.gm.role.as_str()).collect();
    let mut kids: HashMap<&str, Vec<usize>> = HashMap::new();
    let mut roots = Vec::new();
    for (i, n) in nodes.iter().enumerate() {
        if n.parent.is_empty() || !present.contains(n.parent.as_str()) {
            roots.push(i);
            continue;
        }
        kids.entry(n.parent.as_str()).or_default().push(i);
    }
    let mut out = Vec::with_capacity(nodes.len());
    let mut seen = HashSet::new();
    let mut stack: Vec<usize> = roots.into_iter().rev().collect();
    while let Some(i) = stack.pop() {
        if !seen.insert(i) {
            continue;
        }
        out.push(i);
        if let Some(k) = kids.get(nodes[i].gm.role.as_str()) {
            stack.extend(k.iter().rev());
        }
    }
    out.into_iter().map(|i| nodes[i].clone()).collect()
}

impl Server {
    /// Go `treeOpenExtra`: `tree_open` 에 그 Run 과, 그 트리에 산 도구가 없는지를 싣는다.
    pub(crate) fn tree_open_extra(&self, err: &run::Error) -> Obj {
        let run::Error::TreeOpen { run_id } = err else {
            return Obj::new();
        };
        let mut stale = true;
        if let Some(st) = self.runs()
            && let Some(rec) = st.get(run_id)
        {
            for r in st.list() {
                if r.state != run::OPEN || r.tree != rec.tree {
                    continue;
                }
                for m in &r.members {
                    if self.tool_live(&m.tool_id) {
                        stale = false;
                    }
                }
            }
        }
        let mut out = extra1("runId", run_id);
        out.insert("stale", raw(&stale));
        out
    }

    /// Go `nodeTakenExtra`: `node_taken` 에 그 노드를 쥔 멤버와 상태를 싣는다 (FR-ITB-4).
    pub(crate) fn node_taken_extra(&self, err: &run::Error) -> Obj {
        let run::Error::NodeTaken { member_id } = err else {
            return Obj::new();
        };
        let mut out = extra1("memberId", member_id);
        if let Some(st) = self.runs()
            && let Some((_, m)) = st.find_member(member_id)
        {
            let state = self.derive_member_state(&m);
            if state == run::LOST {
                out.insert(
                    "hint",
                    raw(&format!(
                        "otterctl run succeed --member {member_id} --at <새 탭 uuid> 로 이어받는다"
                    )),
                );
            }
            out.insert("state", raw(&state));
        }
        out
    }

    /// Go `notifyTreeSuccession`: 부모와 열린 자식에게 새 도구를 알린다 (FR-ITC-*).
    pub(crate) fn notify_tree_succession(&self, rec: &Record, next: &Member) {
        let Some(a) = &next.assign else {
            return;
        };
        if rec.tree.is_empty() {
            return;
        }
        let Some(st) = self.runs() else {
            return;
        };
        let text = format!(
            "[ISSUE-TREE 승계] {} 새 toolId={} member={}",
            next.role, next.tool_id, next.id
        );
        let mut targets = vec![self.current_tool_of(&a.parent)];
        for r in st.list() {
            if r.state != run::OPEN || r.tree != rec.tree {
                continue;
            }
            for m in &r.members {
                if m.assign.as_ref().is_some_and(|ma| ma.parent == next.id)
                    && m.succeeded_by.is_empty()
                    && !m.reported()
                {
                    targets.push(m.tool_id.clone());
                }
            }
        }
        for to in targets.iter().filter(|t| !t.is_empty()) {
            if let Err(e) =
                self.deliver_to_tool(to, &agent_envelope(ENVELOPE_SERVER_SENDER, to, &text), true)
            {
                errorf!(None, "[run] 트리 승계 알림 실패 to={to}: {e}");
            }
        }
    }

    /// GET /api/runs/tree?ref= (ISSUE_AGENT_TREE_SRS 묶음 D).
    pub(crate) async fn api_runs_tree(&self, r: &mut Req) -> Response {
        let st = match self.runs_ready() {
            Ok(st) => st,
            Err(res) => return res,
        };
        let reference = r.q("ref").trim().to_owned();
        if reference.is_empty() {
            return http_err(
                "ref required",
                StatusCode::BAD_REQUEST,
                apierr::CODE_MISSING_ARG,
            );
        }
        self.run_sync(r, move |s, _| {
            let mut runs = Vec::new();
            let mut nodes = Vec::new();
            let mut successor = HashMap::new();
            let mut issue_dir = String::new();
            for rec in st.list() {
                if rec.state != run::OPEN || rec.tree != reference {
                    continue;
                }
                if issue_dir.is_empty() {
                    issue_dir = rec.issue_dir.clone();
                }
                runs.push(TreeRun {
                    id: rec.id.clone(),
                    short: rec.short.clone(),
                    window_id: rec.window_id.clone(),
                    tree_branch: rec.tree_branch,
                });
                nodes.extend(s.tree_nodes_of(&rec, &mut successor));
            }
            let nodes = link_tree(nodes, &successor);
            let mut out = Obj::new();
            out.insert("tree", raw(&reference));
            out.insert("runs", raw(&runs));
            out.insert("nodes", raw(&nodes));
            // GitHub 트리는 Go 기준선 모양 그대로다 — 보관 방식이 없으면 github 다.
            if !issue_dir.is_empty() {
                out.insert("storage", raw(STORAGE_LOCAL));
                out.insert("issueDir", raw(&issue_dir));
            }
            write_json(&out)
        })
        .await
    }

    /// Go `treeNodesOf`: 승계된 멤버는 빼고 사슬 끝만 노드로 낸다.
    fn tree_nodes_of(
        &self,
        rec: &Record,
        successor: &mut HashMap<String, String>,
    ) -> Vec<TreeNode> {
        let mut raw_members = HashMap::new();
        for m in &rec.members {
            raw_members.insert(m.id.clone(), m);
            if !m.succeeded_by.is_empty() {
                successor.insert(m.id.clone(), m.succeeded_by.clone());
            }
        }
        let (started, seq) = tree_chain_order(&rec.members);
        let open = rec.state == run::OPEN;
        let mut nodes = Vec::new();
        for gm in self.graph_members(rec) {
            let Some(m) = raw_members.get(&gm.id) else {
                continue;
            };
            if !m.succeeded_by.is_empty() {
                continue;
            }
            let a = m.assign.clone().unwrap_or_default();
            nodes.push(TreeNode {
                run_id: rec.id.clone(),
                parent: String::new(),
                leaf: false,
                issue: a.issue,
                title: a.title,
                ended_at: m.reported_at,
                recoverable: open && self.recoverable(&member_target(m)),
                parent_id: a.parent,
                created_at: started.get(&m.id).copied().unwrap_or_default(),
                seq: seq.get(&m.id).copied().unwrap_or_default(),
                gm,
            });
        }
        nodes
    }

    /// POST /api/runs/coordinate (ISSUE_TREE_CLOSE_SRS FR-ITX-7): 조율을 다른 도구로 넘긴다.
    pub(crate) async fn api_run_coordinate(&self, r: &mut Req) -> Response {
        let st = match self.runs_ready() {
            Ok(st) => st,
            Err(res) => return res,
        };
        let body: CoordinateBody = match decode_json_body(r, 0).await {
            Ok(b) => b,
            Err(res) => return res,
        };
        let caller = self.caller_tool_id(r, &body.tool_id);
        self.run_sync(r, move |s, _| {
            let to = body.to.trim().to_owned();
            if to.is_empty() || caller.is_empty() {
                return write_run_error(&invalid("--to 와 부르는 도구가 필요하다"), Obj::new());
            }
            if to == caller {
                return write_run_error(&invalid("자기 자신에게 넘길 수 없다"), Obj::new());
            }
            if !s.tool_live(&to) {
                return write_run_error(
                    &invalid(format!("살아 있는 도구가 아니다: {to}")),
                    Obj::new(),
                );
            }
            let moved = match st.move_coordinator(&caller, &to) {
                Ok(m) => m,
                Err(e) => return write_run_error(&RunFail::of(e), Obj::new()),
            };
            let mut ids = Vec::with_capacity(moved.len());
            for rec in &moved {
                ids.push(rec.id.clone());
                s.notify_tree_coordinator(rec, &to);
                s.broadcast_run_changed(rec);
            }
            infof!(
                None,
                "[run] coordinate from={caller} to={to} runs={}",
                ids.len()
            );
            let mut out = extra1("to", &to);
            out.insert("moved", raw(&ids));
            write_json(&out)
        })
        .await
    }

    /// Go `notifyTreeCoordinator`: 루트 노드들에게 새 조율 도구를 알린다.
    fn notify_tree_coordinator(&self, rec: &Record, to: &str) {
        if rec.tree.is_empty() {
            return;
        }
        let text = format!("[ISSUE-TREE 승계] 조율 새 toolId={to} run={}", rec.id);
        for m in &rec.members {
            let root = m.assign.as_ref().is_some_and(|a| a.parent.is_empty());
            if !root || !m.succeeded_by.is_empty() || m.reported() {
                continue;
            }
            let env = agent_envelope(ENVELOPE_SERVER_SENDER, &m.tool_id, &text);
            if let Err(e) = self.deliver_to_tool(&m.tool_id, &env, true) {
                errorf!(None, "[run] 조율 승계 알림 실패 to={}: {e}", m.tool_id);
            }
        }
    }

    /// GET /api/runs/issues[?toolId=] (ISSUE_TREE_CHAT_SRS FR-LIS-7): 부르는 도구가 멤버이거나 조율하는 열린 Run 의
    /// 트리와 보관 방식, 로컬이면 원본 이슈 폴더. `otterctl issue` 가 폴더를 찾는다.
    pub(crate) async fn api_run_issues(&self, r: &mut Req) -> Response {
        let st = match self.runs_ready() {
            Ok(st) => st,
            Err(res) => return res,
        };
        let caller = self.caller_tool_id(r, &r.q("toolId"));
        self.run_sync(r, move |_, _| {
            let found = st.list().into_iter().find(|rec| {
                rec.state == run::OPEN
                    && !caller.is_empty()
                    && (rec.coordinator_tool_id == caller
                        || rec.members.iter().any(|m| m.tool_id == caller))
            });
            let Some(rec) = found else {
                return write_run_error(
                    &RunFail::of(run::Error::SenderNotMember),
                    extra1("toolId", &caller),
                );
            };
            let mut out = extra1("runId", &rec.id);
            out.insert("tree", raw(&rec.tree));
            out.insert("storage", raw(storage_of(&rec.issue_dir)));
            if !rec.issue_dir.is_empty() {
                out.insert("issueDir", raw(&rec.issue_dir));
            }
            write_json(&out)
        })
        .await
    }

    /// GET /api/runs/team[?toolId=] (묶음 P, WS-4): 부르는 멤버의 동료.
    pub(crate) async fn api_run_team(&self, r: &mut Req) -> Response {
        let st = match self.runs_ready() {
            Ok(st) => st,
            Err(res) => return res,
        };
        drop(st);
        let caller = self.caller_tool_id(r, &r.q("toolId"));
        self.run_sync(r, move |s, _| {
            let Some((rec, me)) = s.open_run_of_tool(&caller) else {
                return write_run_error(
                    &RunFail::of(run::Error::SenderNotMember),
                    extra1("toolId", &caller),
                );
            };
            let mates: Vec<TeamView> = rec
                .members
                .iter()
                .filter(|m| m.id != me.id)
                .filter(|m| m.state != run::RELEASED && m.state != run::SUCCEEDED)
                .map(|m| TeamView {
                    role: m.role.clone(),
                    member_id: m.id.clone(),
                    to: m.tool_id.clone(),
                    state: s.derive_member_state(m),
                    headless: m.headless,
                })
                .collect();
            let mut out = Obj::new();
            out.insert("runId", raw(&rec.id));
            out.insert("memberId", raw(&me.id));
            out.insert("role", raw(&me.role));
            out.insert("team", raw(&mates));
            write_json(&out)
        })
        .await
    }
}
