//! 이슈 트리 배정과 멤버 프리앰블 (Go `handlers_runs_assign.go`, ISSUE_TREE_OPS_SRS FR-ITA-*).

use otter_gocompat::filepath;
use otter_gocompat::json::{self, RawMessage};
use otter_shared_httpresp::Response;
use otter_webserver_domain_run::{self as run, Member, Record, TreeContext};
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
    name: String,
    tree: Option<WsGroupTree>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct WsGroupTree {
    repo: String,
    root: RawMessage,
}

/// Go `issueTreeDocPath`: 홈이 없으면 빈다. Go 는 서버가 `OTTERMINAL_HOME` 에 심은 홈을 읽었다 —
/// 그 값은 서버의 데이터 디렉터리와 같으므로 환경 대신 그것을 받는다.
fn issue_tree_doc_path(home: &str) -> String {
    if home.is_empty() {
        return String::new();
    }
    let mut parts = vec![home, otter_shared_otterenv::BIN_DIR];
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
            group_id: self.tree_group_id(rec),
            doc_path: issue_tree_doc_path(&self.cfg.data_dir.to_string_lossy()),
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

    /// Go `treeGroupID`: 트리 표지(`repo#root`)에 맞는 창 그룹. 로컬 트리(FR-LIS-16)의 그룹은 표지가 없으므로
    /// 이름이 `<별칭>:<ID>` 이거나 그 뒤에 빈칸과 제목이 붙은 그룹이다.
    fn tree_group_id(&self, rec: &Record) -> String {
        let tree = rec.tree.as_str();
        let Some(work) = self.work() else {
            return String::new();
        };
        let (blob, _) = work.snapshot();
        if !rec.issue_dir.is_empty() {
            let Ok(ws) = json::unmarshal::<WsGroups>(&blob) else {
                return String::new();
            };
            return ws
                .window_groups
                .unwrap_or_default()
                .into_iter()
                .find(|g| {
                    g.tree.is_none()
                        && g.name
                            .strip_prefix(tree)
                            .is_some_and(|r| r.is_empty() || r.starts_with(' '))
                })
                .map(|g| g.id)
                .unwrap_or_default();
        }
        let Some(i) = tree.rfind('#').filter(|_| !tree.is_empty()) else {
            return String::new();
        };
        let (repo, root) = (&tree[..i], &tree[i + 1..]);
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

#[cfg(test)]
mod doc_path_tests {
    use super::issue_tree_doc_path;

    // 서버 프로세스는 홈을 환경에 심지 않는다 — 문서 경로는 받은 홈(데이터 디렉터리)에서 온다.
    #[test]
    fn doc_path_follows_given_home() {
        assert_eq!(issue_tree_doc_path(""), "");
        let want = otter_gocompat::filepath::join(&[
            "/h",
            otter_shared_otterenv::BIN_DIR,
            "agent-plugin",
            "commands",
            "issue-tree.md",
        ]);
        assert_eq!(issue_tree_doc_path("/h"), want);
    }
}
