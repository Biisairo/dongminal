//! /api/git/{checkout,branch,branch/*} — 브랜치 표면 (GIT_SRS §3D.1 FR-GIT-155~160 ·
//! GIT_ACTIONS_SRS §3.2·§3.5). Go `handlers_git_branch.go`.
//!
//! 목록은 /api/git/refs 다 (FR-GIT-147). 서버가 마지막 방어선이다 — force 의 확인·이름 규칙·
//! 이름 충돌·현재 브랜치 삭제 금지·일괄 강제 삭제 금지를 여기서 본다. 원격으로 나가는 셋(push ·
//! fetch into local · 원격 ref 삭제)만 잡 경로다 (FR-GIT-101~104).

use std::sync::Arc;

use dm_shared_httpresp::Response;
use dm_webserver_action as action;
use dm_webserver_apierr::{self as apierr, Classify, Sentinel};
use dm_webserver_domain_git_core::{self as core, Ctx, Kind, WriteSpec};
use dm_webserver_domain_git_query::{self as query, Ref, Status};
use dm_webserver_domain_git_store::Store;
use dm_webserver_domain_git_write::{
    self as write, BranchCreateOpts, BranchDeleteOpts, BranchDeletePlan, BranchPushOpts,
    BranchRenameOpts, CheckoutOpts, MergeOpts, RebaseOpts, RemoteBranchOpts, UpstreamOpts,
};
use http::StatusCode;
use serde::Deserialize;

use crate::GitServer;
use crate::answers::{BranchFacts, branch_answer, branch_exists_body, upstream_answer};
use crate::remote::git_push_error;
use crate::reply::{WErr, git_err_json, git_error, git_json, git_tail, obj, status};
use crate::req::Req;

#[derive(Default, Deserialize)]
#[serde(default, rename = "gitapi.gitCheckoutReq")]
struct CheckoutReq {
    repo: String,
    r#ref: String,
    create: String,
    track: String,
    detach: bool,
    force: bool,
    /// `force` 의 2단계 확인이다 (FR-GIT-89·157).
    confirm: bool,
}

#[derive(Default, Deserialize)]
#[serde(default, rename = "gitapi.gitBranchReq")]
struct BranchReq {
    repo: String,
    name: String,
    #[serde(rename = "startRef")]
    start_ref: String,
    checkout: bool,
}

#[derive(Default, Deserialize)]
#[serde(default, rename = "gitapi.gitBranchRenameReq")]
struct BranchRenameReq {
    repo: String,
    from: String,
    to: String,
}

#[derive(Default, Deserialize)]
#[serde(default, rename = "gitapi.gitBranchDeleteReq")]
struct BranchDeleteReq {
    repo: String,
    names: Option<Vec<String>>,
    force: bool,
    confirm: bool,
}

#[derive(Default, Deserialize)]
#[serde(default, rename = "gitapi.gitBranchMergeReq")]
struct BranchMergeReq {
    repo: String,
    r#ref: String,
    mode: String,
}

#[derive(Default, Deserialize)]
#[serde(default, rename = "gitapi.gitBranchRebaseReq")]
struct BranchRebaseReq {
    repo: String,
    r#ref: String,
    onto: String,
    confirm: bool,
}

#[derive(Default, Deserialize)]
#[serde(default, rename = "gitapi.gitBranchUpstreamReq")]
struct BranchUpstreamReq {
    repo: String,
    branch: String,
    upstream: String,
    unset: bool,
}

#[derive(Default, Deserialize)]
#[serde(default, rename = "gitapi.gitBranchPushReq")]
struct BranchPushReq {
    repo: String,
    branch: String,
    force: String,
    confirm: bool,
    publish: bool,
}

/// `ref` 는 원격 ref 의 전체 이름이다 — 서버가 원격과 브랜치로 가른다 (GV-g). 비었으면
/// remote·branch 를 그대로 쓴다.
#[derive(Default, Deserialize)]
#[serde(default, rename = "gitapi.gitRemoteBranchReq")]
struct RemoteBranchReq {
    repo: String,
    r#ref: String,
    remote: String,
    branch: String,
    confirm: bool,
}

fn write_spec(argv: Vec<String>) -> WriteSpec {
    WriteSpec {
        argv,
        ..WriteSpec::default()
    }
}

/// 미머지 거부 뒤의 선택지다. 대상이 여럿이면 `-D` 로 올리는 선택지를 주지 않는다.
fn branch_delete_options(n: usize) -> Vec<&'static str> {
    if n > 1 {
        return vec![write::BRANCH_DELETE_CANCEL];
    }
    write::BRANCH_DELETE_OPTIONS.to_vec()
}

impl GitServer {
    /// POST /api/git/checkout — 워킹 트리를 다른 ref 로 옮긴다 (FR-GIT-155·156·157). 잡이다.
    pub(crate) async fn api_git_checkout(&self, r: &mut Req) -> Response {
        let (mut t, mut req) = self.begin_write::<CheckoutReq>(r).await;
        t.require_confirm(
            req.force,
            req.confirm,
            "force checkout 은 워킹 트리의 변경을 버린다: confirm:true 를 요구한다 (FR-GIT-89·157)",
        );
        t.resolve(&req.repo).await;
        // track 만 오면 로컬 이름은 서버가 가른 브랜치 이름이다 (GV-g · FR-GIT-156).
        if !req.track.is_empty() && req.create.is_empty() {
            let mut remote = String::new();
            let full = format!("{}{}", query::REMOTE_REF_PREFIX, req.track);
            if !t
                .remote_branch_of(&full, &mut remote, &mut req.create)
                .await
            {
                return t.finish();
            }
        }
        let opts = CheckoutOpts {
            r#ref: req.r#ref.clone(),
            create: req.create.clone(),
            track: req.track.clone(),
            detach: req.detach,
            force: req.force,
        };
        // 잘못된 요청은 실행 전에 답한다.
        let spec = match write::checkout_spec(&opts) {
            Ok(s) => s,
            Err(e) => {
                t.reject(&e);
                WriteSpec::default()
            }
        };
        // 메뉴의 답과 같은 판정이다 (GT-d).
        if !req.create.is_empty() && !req.track.is_empty() {
            let track = req.track.clone();
            let ok = t
                .judge_branch(action::GIT_BRANCH_CHECKOUT_LOCAL, |f| {
                    Some(f.ref_or(query::REF_KIND_REMOTE, &track))
                })
                .await;
            if !ok {
                return t.finish();
            }
        } else if !req.detach && req.create.is_empty() && !req.force {
            // force 는 현재 브랜치에서도 뜻이 있다 (FR-GIT-157).
            let rf = req.r#ref.clone();
            let ok = t
                .judge_branch(action::GIT_BRANCH_CHECKOUT, |f| f.any_ref(&rf))
                .await;
            if !ok {
                return t.finish();
            }
        }
        // 이름 충돌은 저장소를 조회해야 안다 — 사전 단계의 검사다 (§6.2).
        if t.stop() {
            return t.finish();
        }
        if let Some(res) = self
            .git_branch_name_taken(
                &t.git(),
                &t.ctx(),
                &req.repo,
                &t.root,
                &req.create,
                &req.track,
            )
            .await
        {
            return res;
        }
        let before = t.snapshot().await;
        t.start_write_job(spec, before, None, None).await;
        t.finish()
    }

    /// POST /api/git/branch — 브랜치를 만든다 (FR-GIT-158·159·160). 만들면서 옮겨 가면 checkout
    /// 잡이고, 만들기만 하면 동기다 (§5.2).
    pub(crate) async fn api_git_branch_create(&self, r: &mut Req) -> Response {
        let (mut t, req) = self.begin_write::<BranchReq>(r).await;
        t.resolve(&req.repo).await;
        let opts = BranchCreateOpts {
            name: req.name.clone(),
            start_ref: req.start_ref.clone(),
            checkout: req.checkout,
        };
        let argv = match write::branch_create_args(&opts) {
            Ok(a) => a,
            Err(e) => {
                t.reject(&e);
                Vec::new()
            }
        };
        if req.checkout {
            if t.stop() {
                return t.finish();
            }
            if let Some(res) = self
                .git_branch_name_taken(&t.git(), &t.ctx(), &req.repo, &t.root, &req.name, "")
                .await
            {
                return res;
            }
            let before = t.snapshot().await;
            t.start_write_job(write_spec(argv), before, None, None)
                .await;
            return t.finish();
        }
        // 동기 생성의 이름 검증·충돌 확인은 write::branch_create 한 번이다 (FR-ATF-3).
        if t.stop() {
            return t.finish();
        }
        let (git, root) = (t.git(), t.root.clone());
        t.apply(|ctx| async move {
            write::branch_create(git.service(), &ctx, &root, &opts)
                .await
                .map(drop)
                .map_err(WErr::from)
        })
        .await;
        t.ok(None);
        t.finish()
    }

    /// GET /api/git/branch/validate?repo=&name= — 이름 규칙 검사 (FR-GIT-159). 위반을 요청
    /// 실패로 답하지 않는다 — 판정은 200 의 본문이다. exists 는 규칙 위반이 아니다 (FR-GIT-156).
    pub(crate) async fn api_git_branch_validate(&self, r: &mut Req) -> Response {
        let (git, root, requested) = match self.git_repo_param(r).await {
            Ok(v) => v,
            Err(res) => return res,
        };
        let name = r.q("name");
        let mut body = obj! {
            "requested" => obj! {"repo" => requested, "name" => name},
            "repo" => root,
            "ok" => true,
            "reason" => "",
            "exists" => false,
        };
        if let Err(e) = query::valid_branch_name(git.service(), &r.ctx, &root, &name).await {
            if !Classify::is(&e, &Sentinel::Core(Kind::RefName)) {
                // 이름의 문제가 아니라 저장소·git 의 문제다.
                return git_error(&e);
            }
            body.extend(obj! {"ok" => false, "reason" => git_tail(&e.to_string())});
            return git_json(StatusCode::OK, &body);
        }
        match query::local_branch_exists(git.service(), &r.ctx, &root, &name).await {
            Ok(found) => {
                body.extend(obj! {"exists" => found});
                git_json(StatusCode::OK, &body)
            }
            Err(e) => git_error(&e),
        }
    }

    /// 이름 충돌을 실행 전에 답한다 (FR-GIT-156). 선택지를 함께 준다. `Some` 이면 다 만든 응답이다.
    async fn git_branch_name_taken(
        &self,
        git: &Arc<Store>,
        ctx: &Ctx,
        requested: &str,
        root: &str,
        name: &str,
        track: &str,
    ) -> Option<Response> {
        if name.is_empty() {
            return None;
        }
        if let Err(e) = query::valid_branch_name(git.service(), ctx, root, name).await {
            return Some(git_error(&e));
        }
        match query::local_branch_exists(git.service(), ctx, root, name).await {
            Err(e) => Some(git_error(&e)),
            Ok(false) => None,
            Ok(true) => {
                let mut body = branch_exists_body(name, track);
                body.extend(obj! {
                    "error" => apierr::CODE_BRANCH_EXISTS,
                    "message" => format!("로컬 브랜치 {name} 가 이미 있다"),
                    "requested" => requested,
                    "repo" => root,
                });
                Some(git_err_json(
                    StatusCode::CONFLICT,
                    apierr::CODE_BRANCH_EXISTS,
                    &body,
                ))
            }
        }
    }

    /// POST /api/git/branch/rename — `git branch -m` (FR-GIT-253).
    pub(crate) async fn api_git_branch_rename(&self, r: &mut Req) -> Response {
        let (mut t, req) = self.begin_write::<BranchRenameReq>(r).await;
        t.resolve(&req.repo).await;
        let opts = BranchRenameOpts {
            from: req.from.clone(),
            to: req.to.clone(),
        };
        if let Err(e) = write::branch_rename_args(&opts) {
            t.reject(&e);
        }
        let from = req.from.clone();
        let ok = t
            .judge_branch(action::GIT_BRANCH_RENAME, |f| {
                Some(f.ref_or(query::REF_KIND_LOCAL, &from))
            })
            .await;
        if !ok {
            return t.finish();
        }
        // 새 이름의 검증·충돌 확인은 write::branch_rename 한 번이다 (FR-ATF-3).
        let (git, root) = (t.git(), t.root.clone());
        t.apply(|ctx| async move {
            write::branch_rename(git.service(), &ctx, &root, &opts)
                .await
                .map(drop)
                .map_err(WErr::from)
        })
        .await;
        t.ok(None);
        t.finish()
    }

    /// POST /api/git/branch/delete — `git branch -d|-D` (FR-GIT-254). 파괴적이다. 현재 브랜치와
    /// 미머지 브랜치는 실행 전에 답한다 — 미머지는 실패가 아니라 선택지다.
    pub(crate) async fn api_git_branch_delete(&self, r: &mut Req) -> Response {
        let (mut t, req) = self.begin_write::<BranchDeleteReq>(r).await;
        t.require_confirm(
            true,
            req.confirm,
            "브랜치 삭제는 파괴적이다: confirm:true 를 요구한다 (FR-GIT-89·254)",
        );
        t.resolve(&req.repo).await;
        // 같은 이름은 먼저 접는다 — 미머지 선택지의 개수 판정도 접은 수로 한다 (FR-ATF-4).
        let opts = BranchDeleteOpts {
            names: Some(write::fold_branch_names(
                req.names.as_deref().unwrap_or_default(),
            )),
            force: req.force,
        };
        if let Err(e) = write::branch_delete_args(&opts) {
            t.reject(&e);
        }
        let before = t.snapshot().await;
        if t.stop() {
            return t.finish();
        }
        if let Some(res) = self
            .git_branch_delete_blocked(&t.git(), &t.ctx(), &req.repo, &t.root, &before, &opts)
            .await
        {
            return res;
        }
        let (git, root) = (t.git(), t.root.clone());
        let mut plan = BranchDeletePlan::default();
        let out = &mut plan;
        t.apply(|ctx| async move {
            let (res, p) = write::branch_delete(git.service(), &ctx, &root, &opts).await;
            *out = p;
            res.map(drop).map_err(WErr::from)
        })
        .await;
        t.ok(Some(&obj! {"deleted" => plan}));
        t.finish()
    }

    /// 실행 전에 막아야 하는 둘을 본다: ① 현재 브랜치 ② 미머지 브랜치(`-d` 일 때만). `Some` 이면
    /// 다 만든 응답이다.
    async fn git_branch_delete_blocked(
        &self,
        git: &Arc<Store>,
        ctx: &Ctx,
        requested: &str,
        root: &str,
        before: &Status,
        opts: &BranchDeleteOpts,
    ) -> Option<Response> {
        let names = opts.names.as_deref().unwrap_or_default();
        let facts = BranchFacts {
            refs: Vec::new(),
            st: before.clone(),
        };
        for n in names {
            // 메뉴의 답과 같은 판정이다 (GT-d).
            let r = Ref {
                kind: query::REF_KIND_LOCAL.to_owned(),
                short: n.clone(),
                is_head: !before.detached && *n == before.branch,
                ..Ref::default()
            };
            let a = branch_answer(action::GIT_BRANCH_DELETE, &r, &facts);
            if !a.ok {
                return Some(git_err_json(
                    status(a.status),
                    &a.why,
                    &obj! {"error" => a.why, "requested" => requested, "repo" => root, "branch" => n},
                ));
            }
        }
        if opts.force {
            return None;
        }
        for n in names {
            match query::branch_merged(git.service(), ctx, root, n).await {
                Err(e) => return Some(git_error(&e)),
                Ok(true) => continue,
                Ok(false) => {}
            }
            let oid = match query::branch_oid(git.service(), ctx, root, n).await {
                Ok(o) => o,
                Err(e) => return Some(git_error(&e)),
            };
            return Some(git_err_json(
                StatusCode::CONFLICT,
                apierr::CODE_BRANCH_NOT_MERGED,
                &obj! {
                    "error" => apierr::CODE_BRANCH_NOT_MERGED,
                    "requested" => requested,
                    "repo" => root,
                    "branch" => n,
                    "oid" => oid,
                    "message" => format!("{n} 는 아직 합쳐지지 않았다 — 지우면 그 커밋들은 reflog 에만 남는다"),
                    // 여러 개를 한 번에 강제 삭제하는 자리를 만들지 않는다 (FR-GIT-254).
                    "options" => branch_delete_options(names.len()),
                },
            ));
        }
        None
    }

    /// POST /api/git/branch/merge — 대상 ref 를 현재 브랜치에 합친다 (FR-GIT-255). 충돌은 실패가
    /// 아니라 진행 중 상태다 (FR-GIT-251). 잡이다.
    pub(crate) async fn api_git_branch_merge(&self, r: &mut Req) -> Response {
        let (mut t, req) = self.begin_write::<BranchMergeReq>(r).await;
        t.resolve(&req.repo).await;
        let opts = MergeOpts {
            r#ref: req.r#ref.clone(),
            mode: req.mode.clone(),
        };
        let argv = match write::merge_args(&opts) {
            Ok(a) => a,
            Err(e) => {
                t.reject(&e);
                Vec::new()
            }
        };
        let rf = req.r#ref.clone();
        let ok = t
            .judge_branch(action::GIT_BRANCH_MERGE, |f| {
                Some(f.any_ref(&rf).unwrap_or_default())
            })
            .await;
        if !ok {
            return t.finish();
        }
        let before = t.snapshot().await;
        t.start_write_job(write_spec(argv), before, None, None)
            .await;
        t.finish()
    }

    /// POST /api/git/branch/rebase — 대상 ref 위로 현재 브랜치를 다시 얹는다 (FR-GIT-256).
    /// 파괴적이다 — 커밋 해시가 바뀐다.
    pub(crate) async fn api_git_branch_rebase(&self, r: &mut Req) -> Response {
        let (mut t, req) = self.begin_write::<BranchRebaseReq>(r).await;
        t.require_confirm(
            true,
            req.confirm,
            "rebase 는 커밋 해시를 바꾼다: confirm:true 를 요구한다 (FR-GIT-89·256)",
        );
        t.resolve(&req.repo).await;
        let opts = RebaseOpts {
            r#ref: req.r#ref.clone(),
            onto: req.onto.clone(),
        };
        // onto 가 있으면 ref 는 "어디부터" 이므로 진행 중 작업만 본다 (빈 ref 로 판정한다).
        let (rf, onto) = (req.r#ref.clone(), req.onto.clone());
        let ok = t
            .judge_branch(action::GIT_BRANCH_REBASE, |f| {
                if !onto.is_empty() {
                    return Some(Ref::default());
                }
                Some(f.any_ref(&rf).unwrap_or_default())
            })
            .await;
        if !ok {
            return t.finish();
        }
        // hint 는 옮기기 전 HEAD 를 싣는다 (FR-GIT-250.2).
        let before = t.snapshot().await;
        match write::rebase_spec(&t.root, &opts, &before.oid) {
            Ok((spec, hint)) => t.start_write_job(spec, before, None, Some(hint)).await,
            Err(e) => t.reject(&e),
        }
        t.finish()
    }

    /// POST /api/git/branch/upstream — set / unset (FR-GIT-257). 설정은 대화상자의 답(GV-f)과,
    /// 해제는 메뉴의 답(GT-d)과 같은 판정이다.
    pub(crate) async fn api_git_branch_upstream(&self, r: &mut Req) -> Response {
        let (mut t, req) = self.begin_write::<BranchUpstreamReq>(r).await;
        t.resolve(&req.repo).await;
        let opts = UpstreamOpts {
            branch: req.branch.clone(),
            upstream: req.upstream.clone(),
            unset: req.unset,
        };
        let (branch, upstream) = (req.branch.clone(), req.upstream.clone());
        let ok = if !req.unset {
            t.judge_facts(|f| upstream_answer(f, &branch, &upstream))
                .await
        } else {
            t.judge_branch(action::GIT_BRANCH_UPSTREAM_UNSET, |f| {
                Some(f.ref_or(query::REF_KIND_LOCAL, &branch))
            })
            .await
        };
        if !ok {
            return t.finish();
        }
        if let Err(e) = write::upstream_args(&opts) {
            t.reject(&e);
            return t.finish();
        }
        let (git, root) = (t.git(), t.root.clone());
        t.apply(|ctx| async move {
            write::set_upstream(git.service(), &ctx, &root, &opts)
                .await
                .map(drop)
                .map_err(WErr::from)
        })
        .await;
        t.ok(None);
        t.finish()
    }

    /// GET /api/git/branch/merge-preview?repo=&ref= — 머지 한 번의 영향 범위 (FR-GIT-255).
    /// 판정을 200 의 본문에 담는다.
    pub(crate) async fn api_git_branch_merge_preview(&self, r: &mut Req) -> Response {
        let (git, root, requested) = match self.git_repo_param(r).await {
            Ok(v) => v,
            Err(res) => return res,
        };
        let rf = r.q("ref");
        if let Err(e) = core::check_ref_arg("ref", &rf) {
            return git_error(&e);
        }
        match query::merge_preview(git.service(), &r.ctx, &root, &rf).await {
            Ok(im) => git_json(
                StatusCode::OK,
                &obj! {
                    "requested" => obj! {"repo" => requested, "ref" => rf},
                    "repo" => root,
                    "preview" => im,
                },
            ),
            Err(e) => git_error(&e),
        }
    }

    /// POST /api/git/branch/push — 대상 브랜치 하나를 민다 (FR-GIT-258). 잡이다. upstream 이
    /// 없으면 publish 이며 실행 전에 되묻는다.
    pub(crate) async fn api_git_branch_push(&self, r: &mut Req) -> Response {
        let (mut t, req) = self.begin_write::<BranchPushReq>(r).await;
        t.resolve(&req.repo).await;
        let branch = req.branch.clone();
        let ok = t
            .judge_branch(action::GIT_BRANCH_PUSH, |f| {
                Some(f.ref_or(query::REF_KIND_LOCAL, &branch))
            })
            .await;
        if !ok {
            return t.finish();
        }
        let git = t.git();
        let opts = BranchPushOpts {
            branch: req.branch.clone(),
            force: req.force.clone(),
            confirm: req.confirm,
            publish: req.publish,
        };
        let (res, plan) = write::branch_push_spec(git.service(), &t.ctx(), &t.root, &opts).await;
        match res {
            Ok(spec) => {
                t.start_job("push", spec, Some(&obj! {"plan" => plan}))
                    .await
            }
            Err(e) => t.respond(git_push_error(&req.repo, &t.root, &plan, &e)),
        }
        t.finish()
    }

    /// POST /api/git/branch/fetch — 원격 ref 를 같은 이름의 로컬 ref 로 가져온다 (FR-GIT-268). 잡이다.
    pub(crate) async fn api_git_branch_fetch_into(&self, r: &mut Req) -> Response {
        let (mut t, mut req) = self.begin_write::<RemoteBranchReq>(r).await;
        t.resolve(&req.repo).await;
        if !t
            .remote_branch_of(&req.r#ref, &mut req.remote, &mut req.branch)
            .await
        {
            return t.finish();
        }
        let short = format!("{}/{}", req.remote, req.branch);
        let ok = t
            .judge_branch(action::GIT_BRANCH_FETCH, |f| {
                Some(f.ref_or(query::REF_KIND_REMOTE, &short))
            })
            .await;
        if !ok {
            return t.finish();
        }
        match write::remote_fetch_spec(&RemoteBranchOpts {
            remote: req.remote,
            branch: req.branch,
        }) {
            Ok(spec) => t.start_job("fetch", spec, None).await,
            Err(e) => t.reject(&e),
        }
        t.finish()
    }

    /// POST /api/git/branch/delete-remote — 원격의 ref 를 지운다 (FR-GIT-268). 파괴적이다 —
    /// 되살리는 push 는 잡 등록이 성공한 뒤 hint 로 남는다.
    pub(crate) async fn api_git_branch_delete_remote(&self, r: &mut Req) -> Response {
        let (mut t, mut req) = self.begin_write::<RemoteBranchReq>(r).await;
        t.require_confirm(
            true,
            req.confirm,
            "원격 ref 삭제는 파괴적이다: confirm:true 를 요구한다 (FR-GIT-89·268)",
        );
        t.resolve(&req.repo).await;
        if !t
            .remote_branch_of(&req.r#ref, &mut req.remote, &mut req.branch)
            .await
        {
            return t.finish();
        }
        let short = format!("{}/{}", req.remote, req.branch);
        let ok = t
            .judge_branch(action::GIT_BRANCH_DELETE_REMOTE, |f| {
                Some(f.ref_or(query::REF_KIND_REMOTE, &short))
            })
            .await;
        if !ok {
            return t.finish();
        }
        let git = t.git();
        let opts = RemoteBranchOpts {
            remote: req.remote,
            branch: req.branch,
        };
        match write::remote_branch_delete_spec(git.service(), &t.ctx(), &t.root, &opts).await {
            Ok((spec, hint)) => t.start_hinted_job("push", spec, None, Some(hint)).await,
            Err(e) => t.reject(&e),
        }
        t.finish()
    }
}
