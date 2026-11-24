//! 브랜치 행 메뉴의 답과 양쪽 삭제 (SERVER_DRIVEN_ACTIONS_SRS GT-d · FR-SDA-35). Go
//! `handlers_git_actions_branch.go` 중 5.4.2 가 당기지 않은 것.

use std::collections::BTreeMap;

use dm_shared_httpresp::Response;
use dm_webserver_action::{self as action, Answer};
use dm_webserver_apierr as apierr;
use dm_webserver_domain_git_jobs::{SLOT_COMMON, SLOT_INDEX};
use dm_webserver_domain_git_query::{self as query, Ref};
use dm_webserver_domain_git_write::{
    self as write, BranchDeleteOpts, BranchDeletePlan, RemoteBranchOpts,
};
use http::StatusCode;
use serde::Deserialize;

use crate::GitServer;
use crate::answers::{branch_answer, branch_pair, slots_answer, split_remote_ref};
use crate::reply::{WErr, git_error, git_fail, git_json, obj};
use crate::req::Req;

#[derive(Default, Deserialize)]
#[serde(default, rename = "gitapi.gitBranchDeleteBothReq")]
struct BranchDeleteBothReq {
    repo: String,
    r#ref: String,
    force: bool,
    confirm: bool,
}

/// 브랜치 동작이 쓰는 작업 칸이다 (GR-1a).
fn branch_slots(id: &str) -> &'static [&'static str] {
    match id {
        action::GIT_BRANCH_PUSH | action::GIT_BRANCH_FETCH | action::GIT_BRANCH_DELETE_REMOTE => {
            &[SLOT_COMMON]
        }
        action::GIT_BRANCH_DELETE_BOTH => &[SLOT_INDEX, SLOT_COMMON],
        _ => &[SLOT_INDEX],
    }
}

/// 메뉴에 싣는 동작이다. 삭제는 ref 의 종류가 정한다.
fn branch_menu_ids(r: &Ref) -> [&'static str; 11] {
    let del = if r.kind == query::REF_KIND_REMOTE {
        action::GIT_BRANCH_DELETE_REMOTE
    } else {
        action::GIT_BRANCH_DELETE
    };
    [
        action::GIT_BRANCH_CHECKOUT,
        action::GIT_BRANCH_CHECKOUT_LOCAL,
        action::GIT_BRANCH_RENAME,
        action::GIT_BRANCH_MERGE,
        action::GIT_BRANCH_REBASE,
        action::GIT_BRANCH_UPSTREAM_SET,
        action::GIT_BRANCH_UPSTREAM_UNSET,
        action::GIT_BRANCH_PUSH,
        action::GIT_BRANCH_FETCH,
        del,
        action::GIT_BRANCH_DELETE_BOTH,
    ]
}

impl GitServer {
    /// `kind=branch` 의 답이다 — ref 하나의 메뉴 전부 (GT-d). 칸이 먼저다.
    pub(crate) async fn git_branch_menu(&self, r: &Req, root: &str, requested: &str) -> Response {
        let Some(git) = self.git.clone() else {
            return crate::reply::git_unavailable();
        };
        let name = r.q("ref");
        let st = match git.status(&r.ctx, root).await.0 {
            Ok(obs) => obs.status,
            Err(e) => return git_error(&e),
        };
        let f = match self.branch_facts(&git, &r.ctx, root, st).await {
            Ok(f) => f,
            Err(e) => return git_error(&e),
        };
        let Some(target) = f.refs.iter().find(|x| x.name == name).cloned() else {
            return git_fail(
                StatusCode::NOT_FOUND,
                apierr::CODE_NOT_FOUND,
                &format!("ref not found: {name}"),
            );
        };
        let keys = match self.git_keys(&git, &r.ctx, root).await {
            Ok(k) => k,
            Err(e) => return git_error(&e),
        };
        let x = self.exclusion();
        let out: BTreeMap<String, Answer> = branch_menu_ids(&target)
            .into_iter()
            .map(|id| {
                let a = action::first([
                    slots_answer(&x, &keys, branch_slots(id)),
                    branch_answer(id, &target, &f),
                ]);
                (id.to_owned(), a)
            })
            .collect();
        git_json(
            StatusCode::OK,
            &obj! {
                "requested" => obj! {"repo" => requested, "kind" => "branch", "ref" => name},
                "repo" => root,
                "actions" => out,
            },
        )
    }

    /// POST /api/git/branch/delete-both — 로컬 브랜치와 그 upstream 을 함께 지운다 (FR-SDA-35 ·
    /// FR-BMU-10). 로컬은 동기로 지우고 원격은 잡이다. 원격 잡이 막혀도 로컬 결과를 싣는다
    /// (FR-ATF-75).
    pub(crate) async fn api_git_branch_delete_both(&self, r: &mut Req) -> Response {
        let (mut t, req) = self.begin_write::<BranchDeleteBothReq>(r).await;
        t.require_confirm(
            true,
            req.confirm,
            "양쪽 삭제는 파괴적이다: confirm:true 를 요구한다 (FR-GIT-89 · FR-BMU-10)",
        );
        t.resolve(&req.repo).await;
        let before = t.snapshot().await;
        if t.stop() {
            return t.finish();
        }
        let git = t.git();
        let f = match self
            .branch_facts(&git, &t.ctx(), &t.root, before.clone())
            .await
        {
            Ok(f) => f,
            Err(e) => {
                t.reject(&e);
                return t.finish();
            }
        };
        // Go 처럼 같은 이름이 여럿이면 마지막 것이다.
        let target = f
            .refs
            .iter()
            .rev()
            .find(|x| x.name == req.r#ref)
            .cloned()
            .unwrap_or_default();
        if target.name.is_empty() {
            t.reject_with(
                StatusCode::NOT_FOUND,
                apierr::CODE_NOT_FOUND,
                &format!("ref not found: {}", req.r#ref),
            );
            return t.finish();
        }
        // common 칸을 여기서 먼저 보는 것은 로컬을 지운 뒤 원격에서 막히는 반쪽 삭제를 피하려는 것이다.
        let a = action::first([
            slots_answer(&self.exclusion(), &t.keys, &[SLOT_COMMON]),
            branch_answer(action::GIT_BRANCH_DELETE_BOTH, &target, &f),
        ]);
        if !a.ok {
            t.reject_answer(&a, None);
            return t.finish();
        }
        let (local, upstream, _) = branch_pair(&target, &f);
        let mut names = match self.remote_names(&git, &t.ctx(), &t.root).await {
            Ok(n) => n,
            Err(e) => {
                t.reject(&e);
                return t.finish();
            }
        };
        let Some((remote, branch)) = split_remote_ref(&mut names, &upstream) else {
            t.reject_with(
                StatusCode::CONFLICT,
                apierr::CODE_NO_UPSTREAM,
                &format!("upstream remote not found: {upstream}"),
            );
            return t.finish();
        };
        let opts = BranchDeleteOpts {
            names: Some(vec![local.short.clone()]),
            force: req.force,
        };
        if let Some(res) = self
            .git_branch_delete_blocked(&git, &t.ctx(), &req.repo, &t.root, &before, &opts)
            .await
        {
            return res;
        }
        let (spec, hint) = match write::remote_branch_delete_spec(
            git.service(),
            &t.ctx(),
            &t.root,
            &RemoteBranchOpts { remote, branch },
        )
        .await
        {
            Ok(v) => v,
            Err(e) => {
                t.reject(&e);
                return t.finish();
            }
        };
        let root = t.root.clone();
        let mut plan = BranchDeletePlan::default();
        let out = &mut plan;
        let svc = git.clone();
        t.apply(|ctx| async move {
            let (res, p) = write::branch_delete(svc.service(), &ctx, &root, &opts).await;
            *out = p;
            res.map(drop).map_err(WErr::from)
        })
        .await;
        // 로컬은 이미 지워졌다 — 거절 응답에도 성공과 같은 모양의 `deleted` 를 싣는다.
        let applied = obj! {"deleted" => plan};
        t.applied = Some(applied.clone());
        t.start_hinted_job("push", spec, Some(&applied), Some(hint))
            .await;
        t.finish()
    }
}
