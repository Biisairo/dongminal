//! 이슈 트리 배정 (ISSUE_TREE_OPS_SRS FR-ITA·ITM).

use otter_gocompat::json::is_empty;
use serde::{Deserialize, Serialize};

use crate::store::{index_of_member, open_tree_runs};
use crate::{Error, Member, OPEN, Record, Store};

/// 트리 멤버의 배정.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "run.Assignment", rename_all = "camelCase")]
pub struct Assignment {
    pub issue: String,
    #[serde(skip_serializing_if = "is_empty")]
    pub title: String,
    /// 부모 노드의 member id. 루트는 비어 있다.
    #[serde(skip_serializing_if = "is_empty")]
    pub parent: String,
    /// 남은 목표 경로(번호 목록).
    #[serde(skip_serializing_if = "is_empty")]
    pub goal: String,
    #[serde(skip_serializing_if = "is_empty")]
    pub parallel: bool,
    /// 0 이면 설정을 따른다 (FR-ITM-3).
    #[serde(skip_serializing_if = "is_empty")]
    pub ctx_pct: i64,
    #[serde(skip_serializing_if = "is_empty")]
    pub no_commit: bool,
}

/// 배정의 부분 갱신. `None` 은 그대로 둔다.
#[derive(Debug, Clone, Default)]
pub struct AssignPatch {
    pub title: Option<String>,
    pub goal: Option<String>,
    pub parallel: Option<bool>,
    pub ctx_pct: Option<i64>,
    pub no_commit: Option<bool>,
}

const CTX_PCT_MIN: i64 = 1;
const CTX_PCT_MAX: i64 = 100;

fn valid_ctx_pct(v: i64) -> bool {
    (CTX_PCT_MIN..=CTX_PCT_MAX).contains(&v)
}

fn ctx_range_error() -> Error {
    Error::invalid(format!("--ctx 는 {CTX_PCT_MIN}~{CTX_PCT_MAX} 이다"))
}

pub(crate) fn check_assign(
    runs: &[Record],
    rec: &Record,
    a: Option<&Assignment>,
) -> Result<(), Error> {
    if rec.tree.is_empty() {
        if a.is_some() {
            return Err(Error::invalid("배정은 트리 Run 의 멤버만 받는다"));
        }
        return Ok(());
    }
    let Some(a) = a.filter(|a| !a.issue.trim().is_empty()) else {
        return Err(Error::invalid("트리 Run 의 멤버는 --issue 가 필요하다"));
    };
    if a.ctx_pct != 0 && !valid_ctx_pct(a.ctx_pct) {
        return Err(ctx_range_error());
    }
    if !a.parent.is_empty() && !tree_has_member(runs, &rec.tree, &a.parent) {
        return Err(Error::invalid(format!(
            "부모 멤버 {} 가 같은 트리의 열린 Run 에 없다",
            a.parent
        )));
    }
    Ok(())
}

fn tree_has_member(runs: &[Record], tree: &str, member_id: &str) -> bool {
    open_tree_runs(runs, tree).any(|r| r.members.iter().any(|m| m.id == member_id))
}

fn may_assign(runs: &[Record], caller: &str, m: &Member) -> bool {
    if caller.is_empty() {
        return false;
    }
    if m.tool_id == caller {
        return true;
    }
    let parent = m.assign.as_ref().map_or("", |a| a.parent.as_str());
    if parent.is_empty() {
        return false;
    }
    index_of_member(runs, parent).is_some_and(|(ri, mi)| runs[ri].members[mi].tool_id == caller)
}

impl Store {
    /// 배정을 고친다. 자기 자신이나 부모 노드의 도구만 고칠 수 있다.
    pub fn update_assign(
        &self,
        caller_tool_id: &str,
        member_id: &str,
        p: AssignPatch,
    ) -> Result<Member, Error> {
        let mut g = self.lock();
        let (ri, mi) = index_of_member(&g.runs, member_id).ok_or(Error::UnknownMember)?;
        if g.runs[ri].state != OPEN {
            return Err(Error::RunClosed);
        }
        let m = &g.runs[ri].members[mi];
        let Some(cur) = m.assign.clone() else {
            return Err(Error::invalid("배정이 없는 멤버다"));
        };
        if !may_assign(&g.runs, caller_tool_id, m) {
            return Err(Error::SenderNotMember);
        }
        if p.ctx_pct.is_some_and(|v| !valid_ctx_pct(v)) {
            return Err(ctx_range_error());
        }
        let mut next = cur;
        if let Some(t) = p.title {
            next.title = t.trim().to_owned();
        }
        if let Some(goal) = p.goal {
            next.goal = goal.trim().to_owned();
        }
        if let Some(v) = p.parallel {
            next.parallel = v;
        }
        if let Some(v) = p.ctx_pct {
            next.ctx_pct = v;
        }
        if let Some(v) = p.no_commit {
            next.no_commit = v;
        }
        let m = &mut g.runs[ri].members[mi];
        m.assign = Some(next);
        let out = m.clone();
        self.save(g)?;
        Ok(out)
    }

    /// 이 멤버를 부모로 둔, 보고하지 않은 자식 노드가 열린 트리에 있는가.
    pub fn has_open_child(&self, member_id: &str) -> bool {
        let g = self.lock();
        let Some((ri, _)) = index_of_member(&g.runs, member_id) else {
            return false;
        };
        let tree = &g.runs[ri].tree;
        if tree.is_empty() {
            return false;
        }
        open_tree_runs(&g.runs, tree).any(|r| {
            r.members
                .iter()
                .any(|m| m.assign.as_ref().is_some_and(|a| a.parent == member_id) && !m.settled())
        })
    }
}
