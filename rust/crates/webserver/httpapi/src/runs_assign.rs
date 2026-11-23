//! 이슈 트리 배정과 멤버 프리앰블 (Go `handlers_runs_assign.go`, ISSUE_TREE_OPS_SRS FR-ITA-*).

use dm_gocompat::filepath;
use dm_gocompat::json::{self, RawMessage};
use dm_shared_httpresp::Response;
use dm_webserver_domain_run::{self as run, Member, Record, TreeContext};
use serde::Deserialize;

use crate::Server;
use crate::go_embed::Obj;
use crate::httperr::{decode_json_body, write_json};
use crate::req::Req;
use crate::runs::{RunFail, extra1, invalid, write_run_error};

/// 설치된 이슈 트리 절차 문서의 자리 (FR-ITA-12).
const ISSUE_TREE_DOC: [&str; 3] = ["agent-plugin", "commands", "issue-tree.md"];

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct AssignBody {
    member_id: String,
    title: Option<String>,
    goal: Option<String>,
    parallel: Option<bool>,
    ctx_pct: Option<i64>,
    no_commit: Option<bool>,
    tool_id: String,
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct WsGroups {
    window_groups: Option<Vec<WsGroup>>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct WsGroup {
    id: String,
    tree: Option<WsGroupTree>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct WsGroupTree {
    repo: String,
    root: RawMessage,
}

/// Go `issueTreeDocPath`: 홈이 없으면 빈다.
fn issue_tree_doc_path() -> String {
    let home = std::env::var(dm_shared_dmenv::ENV_HOME).unwrap_or_default();
    if home.is_empty() {
        return String::new();
    }
    let mut parts = vec![home.as_str(), dm_shared_dmenv::BIN_DIR];
    parts.extend(ISSUE_TREE_DOC);
    filepath::join(&parts)
}

impl Server {
    /// Go `memberPreamble`: 트리 멤버는 배정 블록을 실은 프리앰블을 받는다 (FR-ITA-10).
    pub(crate) fn member_preamble(&self, rec: &Record, m: &Member) -> String {
        match &m.assign {
            None => run::preamble(rec, m),
            Some(_) => run::tree_preamble(rec, m, &self.tree_context(rec, m)),
        }
    }

    /// Go `treeContext`: 기록 밖에서 오는 값 (FR-ITA-11~13, FR-ITM-3).
    fn tree_context(&self, rec: &Record, m: &Member) -> TreeContext {
        let conf = self.migration_conf();
        let mut tc = TreeContext {
            parent_tool_id: self.tree_parent_tool(rec, m),
            group_id: self.tree_group_id(&rec.tree),
            doc_path: issue_tree_doc_path(),
            ctx_pct: conf.tree_pct,
        };
        if let Some(a) = &m.assign
            && a.ctx_pct > 0
        {
            tc.ctx_pct = a.ctx_pct;
        }
        if !conf.tree_on {
            tc.ctx_pct = 0;
        }
        tc
    }

    /// Go `treeParentTool`: 부모 멤버의 지금 도구. 루트면 살아 있는 조율의 도구다.
    fn tree_parent_tool(&self, rec: &Record, m: &Member) -> String {
        if let Some(a) = &m.assign
            && !a.parent.is_empty()
        {
            return self.current_tool_of(&a.parent);
        }
        let coord = &rec.coordinator_tool_id;
        if coord.is_empty() || *coord == m.tool_id || !self.tool_live(coord) {
            return String::new();
        }
        coord.clone()
    }

    /// Go `currentToolOf`: 승계 사슬의 끝 멤버의 도구.
    pub(crate) fn current_tool_of(&self, member_id: &str) -> String {
        let Some(st) = self.runs() else {
            return String::new();
        };
        let mut seen = std::collections::HashSet::new();
        let mut id = member_id.to_owned();
        while !id.is_empty() && seen.insert(id.clone()) {
            let Some((_, m)) = st.find_member(&id) else {
                return String::new();
            };
            if m.succeeded_by.is_empty() {
                return m.tool_id;
            }
            id = m.succeeded_by;
        }
        String::new()
    }

    /// Go `treeGroupID`: 트리 표지(`repo#root`)에 맞는 창 그룹.
    fn tree_group_id(&self, tree: &str) -> String {
        let Some(work) = self.work() else {
            return String::new();
        };
        let Some(i) = tree.rfind('#').filter(|_| !tree.is_empty()) else {
            return String::new();
        };
        let (repo, root) = (&tree[..i], &tree[i + 1..]);
        let (blob, _) = work.snapshot();
        let Ok(ws) = json::unmarshal::<WsGroups>(&blob) else {
            return String::new();
        };
        for g in ws.window_groups.unwrap_or_default() {
            let Some(t) = &g.tree else { continue };
            if t.repo != repo {
                continue;
            }
            if String::from_utf8_lossy(&t.root.0).trim_matches('"') == root {
                return g.id;
            }
        }
        String::new()
    }

    /// POST /api/runs/assign (FR-ITA-4): 트리 멤버 배정의 부분 갱신.
    pub(crate) async fn api_run_assign(&self, r: &mut Req) -> Response {
        let st = match self.runs_ready() {
            Ok(st) => st,
            Err(res) => return res,
        };
        let body: AssignBody = match decode_json_body(r, 0).await {
            Ok(b) => b,
            Err(res) => return res,
        };
        let caller = self.caller_tool_id(r, &body.tool_id);
        self.run_sync(r, move |s, _| {
            if body.member_id.trim().is_empty() {
                return write_run_error(&invalid("--member 는 필수다"), Obj::new());
            }
            let patch = run::AssignPatch {
                title: body.title,
                goal: body.goal,
                parallel: body.parallel,
                ctx_pct: body.ctx_pct,
                no_commit: body.no_commit,
            };
            let m = match st.update_assign(&caller, &body.member_id, patch) {
                Ok(m) => m,
                Err(e) => return write_run_error(&RunFail::of(e), Obj::new()),
            };
            if let Some(rec) = st.get(&m.run_id) {
                s.broadcast_run_changed(&rec);
            }
            write_json(&extra1("member", &s.member_view(m)))
        })
        .await
    }
}
