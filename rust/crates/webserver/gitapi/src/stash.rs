//! /api/git/stash{,/push,/apply,/pop,/drop,/show,/branch} — stash 표면 (GIT_SRS §3D.2
//! FR-GIT-161~170 · GIT_ACTIONS_SRS FR-GIT-272). Go `handlers_git_stash.go`.
//!
//! 서버가 마지막 방어선이다. drop 의 2단계 확인과 "담을 것이 없다" 를 여기서 다시 본다.

use std::future::Future;

use dm_shared_httpresp::Response;
use dm_webserver_apierr::{self as apierr, Classify, Sentinel};
use dm_webserver_domain_git_core::{Ctx, Kind};
use dm_webserver_domain_git_query::Status;
use dm_webserver_domain_git_write::{self as write, StashPopKept, StashPushOpts, WriteKind};
use http::StatusCode;
use serde::Deserialize;

use crate::GitServer;
use crate::answers::stash_create_answer;
use crate::reply::{
    ERR_BAD_REQUEST, Obj, WErr, git_err_json, git_error, git_error_code, git_fail, git_json,
    git_tail, obj, raw,
};
use crate::req::Req;
use crate::write::{GitWrite, git_status_delta};

const DESTRUCTIVE: &str = "파괴적 동작은 confirm:true 를 요구한다 (FR-GIT-89·168)";
const INDEX_GONE: &str = "index 는 더 이상 받지 않는다 — oid 를 보내라";

#[derive(Default, Deserialize)]
#[serde(default, rename = "gitapi.gitStashPushReq")]
struct StashPushReq {
    repo: String,
    message: String,
    #[serde(rename = "includeUntracked")]
    include_untracked: bool,
    #[serde(rename = "keepIndex")]
    keep_index: bool,
}

/// `oid` 는 클라이언트가 목록에서 본 stash 다 (REPO_FIX 01 §5.3). `index` 는 보냈는지만 가른다 —
/// 보냈으면 400 이다.
#[derive(Clone, Default, Deserialize)]
#[serde(default, rename = "gitapi.gitStashIndexReq")]
struct StashIndexReq {
    repo: String,
    oid: String,
    index: Option<i64>,
    #[serde(rename = "withIndex")]
    with_index: bool,
    confirm: bool,
}

#[derive(Default, Deserialize)]
#[serde(default, rename = "gitapi.gitStashBranchReq")]
struct StashBranchReq {
    repo: String,
    oid: String,
    index: Option<i64>,
    name: String,
}

/// apply·pop·drop 중 무엇을 실행하는가.
#[derive(Clone, Copy)]
enum IndexOp {
    Apply,
    Pop,
    Drop,
}

/// stash 잔존 사실의 응답 필드다 — pop 과 branch 가 같은 세 필드를 쓴다 (REPO_FIX 01 §5.3).
fn stash_kept_fields(kept: &StashPopKept) -> Obj {
    obj! {
        "stashKept" => kept.kept,
        "stashKeptReason" => kept.reason,
        "stashKeptOid" => kept.oid,
    }
}

/// stash 지목이 잘못됐으면 사유다.
fn stash_target_invalid(oid: &str, index: Option<i64>) -> Option<String> {
    if index.is_some() {
        return Some(INDEX_GONE.to_owned());
    }
    write::check_stash_oid(oid)
        .err()
        .map(|e| git_tail(&e.to_string()))
}

/// stash 실패의 코드다. stash 가 남았다는 사실이 가장 앞이다 (FR-GIT-165).
fn stash_error_code(
    err: &dyn crate::reply::GitErr,
    extra: &Option<Obj>,
) -> (StatusCode, &'static str) {
    let kept = extra
        .as_ref()
        .and_then(|x| x.get("stashKept"))
        .is_some_and(|v| v.0 == b"true");
    if kept {
        return (StatusCode::CONFLICT, apierr::CODE_STASH_KEPT);
    }
    git_error_code(err)
}

impl GitServer {
    /// GET /api/git/stash?repo= — stash 목록 (FR-GIT-161).
    pub(crate) async fn api_git_stash_list(&self, r: &mut Req) -> Response {
        let (git, root, requested) = match self.git_repo_param(r).await {
            Ok(v) => v,
            Err(res) => return res,
        };
        match write::stash_list(git.service(), &r.ctx, &root).await {
            Ok(list) => git_json(
                StatusCode::OK,
                &obj! {"requested" => obj! {"repo" => requested}, "repo" => root, "stashes" => list},
            ),
            Err(e) => git_error(&e),
        }
    }

    /// GET /api/git/stash/show?repo=&oid= — 선택한 stash 의 변경 파일 (FR-GIT-169). 목록에 없는
    /// oid 는 409 stash_moved(현재 목록을 함께 싣는다).
    pub(crate) async fn api_git_stash_show(&self, r: &mut Req) -> Response {
        let (git, root, requested) = match self.git_repo_param(r).await {
            Ok(v) => v,
            Err(res) => return res,
        };
        if r.query.has("index") {
            return git_fail(StatusCode::BAD_REQUEST, ERR_BAD_REQUEST, INDEX_GONE);
        }
        let oid = r.q("oid");
        if let Err(e) = write::check_stash_oid(&oid) {
            return git_fail(
                StatusCode::BAD_REQUEST,
                ERR_BAD_REQUEST,
                &git_tail(&e.to_string()),
            );
        }
        let requested = obj! {"repo" => requested, "oid" => oid};
        match write::stash_preview(git.service(), &r.ctx, &root, &oid).await {
            Ok(files) => git_json(
                StatusCode::OK,
                &obj! {"requested" => requested, "repo" => root, "files" => files},
            ),
            Err(e) if Classify::is(&e, &Sentinel::Write(WriteKind::StashMoved)) => {
                let mut body = obj! {
                    "error" => apierr::CODE_STASH_MOVED,
                    "message" => git_tail(&e.to_string()),
                    "requested" => requested,
                    "repo" => root,
                };
                if let Ok(list) = write::stash_list(git.service(), &r.ctx, &root).await {
                    body.insert("stashes".to_owned(), raw(&list));
                }
                git_err_json(StatusCode::CONFLICT, apierr::CODE_STASH_MOVED, &body)
            }
            Err(e) => git_error(&e),
        }
    }

    /// POST /api/git/stash/push — 워킹 트리의 변경을 stash 로 옮긴다 (FR-GIT-166·167). 담을 것이
    /// 없으면 실행하지 않는다 — 판정은 답 종단과 같은 함수다 (D-SDA-6).
    pub(crate) async fn api_git_stash_push(&self, r: &mut Req) -> Response {
        let (mut t, req) = self.begin_write::<StashPushReq>(r).await;
        t.resolve(&req.repo).await;
        if t.stop() {
            return t.finish();
        }
        let before = t.snapshot().await;
        if t.stop() {
            return t.finish();
        }
        let a = stash_create_answer(&before, req.include_untracked);
        if !a.ok {
            t.reject_answer(&a, Some(&obj! {"status" => before}));
            return t.finish();
        }
        let opts = StashPushOpts {
            message: req.message,
            include_untracked: req.include_untracked,
            keep_index: req.keep_index,
        };
        let (git, root) = (t.git(), t.root.clone());
        t.stash_apply(&before, |ctx| async move {
            let res = write::stash_push(git.service(), &ctx, &root, &opts).await;
            (None, res.map(drop).map_err(WErr::from))
        })
        .await;
        t.finish()
    }

    /// POST /api/git/stash/apply — stash 를 얹고 남긴다 (FR-GIT-163).
    pub(crate) async fn api_git_stash_apply(&self, r: &mut Req) -> Response {
        self.git_stash_index_route(r, false, IndexOp::Apply).await
    }

    /// POST /api/git/stash/pop — stash 를 얹고 지운다 (FR-GIT-164). 충돌로 끝나면 git 이 stash 를
    /// 남긴다 — 그 사실을 응답에 담는다 (FR-GIT-165).
    pub(crate) async fn api_git_stash_pop(&self, r: &mut Req) -> Response {
        self.git_stash_index_route(r, false, IndexOp::Pop).await
    }

    /// POST /api/git/stash/drop — stash 를 지운다. 파괴적이다 (FR-GIT-89·168).
    pub(crate) async fn api_git_stash_drop(&self, r: &mut Req) -> Response {
        self.git_stash_index_route(r, true, IndexOp::Drop).await
    }

    /// POST /api/git/stash/branch — stash 를 새 브랜치에 적용하며 옮겨 간다 (FR-GIT-272). 이름은
    /// 실행 전에 검증한다 (FR-GIT-250.3).
    pub(crate) async fn api_git_stash_branch(&self, r: &mut Req) -> Response {
        let (mut t, req) = self.begin_write::<StashBranchReq>(r).await;
        if t.stop() {
            return t.finish();
        }
        if let Some(msg) = stash_target_invalid(&req.oid, req.index) {
            t.reject_with(StatusCode::BAD_REQUEST, ERR_BAD_REQUEST, &msg);
            return t.finish();
        }
        t.resolve(&req.repo).await;
        if t.stop() {
            return t.finish();
        }
        // 대화상자의 답(`git.stash.branch`)과 같은 판정이다 (GV-c · D-SDA-6).
        let git = t.git();
        let a = self
            .stash_branch_answer(&git, &t.ctx(), &t.root, &req.name)
            .await;
        if !t.judge(a) {
            return t.finish();
        }
        // 위치는 실행 직전에 oid 로 찾으므로 여기서는 이름만 본다 (FR-GIT-250 ①).
        if let Err(e) = write::stash_branch_args(&req.name, 0) {
            t.reject_with(
                StatusCode::BAD_REQUEST,
                ERR_BAD_REQUEST,
                &git_tail(&e.to_string()),
            );
            return t.finish();
        }
        let before = t.snapshot().await;
        if t.stop() {
            return t.finish();
        }
        let root = t.root.clone();
        t.stash_apply(&before, |ctx| async move {
            let (res, kept) =
                write::stash_branch(git.service(), &ctx, &root, &req.name, &req.oid).await;
            (
                Some(stash_kept_fields(&kept)),
                res.map(drop).map_err(WErr::from),
            )
        })
        .await;
        t.finish()
    }

    /// apply·pop·drop 의 공통 절차다.
    async fn git_stash_index_route(&self, r: &mut Req, confirm: bool, op: IndexOp) -> Response {
        let (mut t, req) = self.begin_write::<StashIndexReq>(r).await;
        if t.stop() {
            return t.finish();
        }
        t.require_confirm(confirm, req.confirm, DESTRUCTIVE);
        if t.stop() {
            return t.finish();
        }
        if let Some(msg) = stash_target_invalid(&req.oid, req.index) {
            t.reject_with(StatusCode::BAD_REQUEST, ERR_BAD_REQUEST, &msg);
            return t.finish();
        }
        t.resolve(&req.repo).await;
        let before = t.snapshot().await;
        if t.stop() {
            return t.finish();
        }
        let (git, root) = (t.git(), t.root.clone());
        t.stash_apply(&before, |ctx| async move {
            let svc = git.service();
            match op {
                IndexOp::Apply => {
                    let res = write::stash_apply(svc, &ctx, &root, &req.oid, req.with_index).await;
                    (None, res.map(drop).map_err(WErr::from))
                }
                IndexOp::Pop => {
                    let (res, kept) =
                        write::stash_pop_checked(svc, &ctx, &root, &req.oid, req.with_index).await;
                    (
                        Some(stash_kept_fields(&kept)),
                        res.map(drop).map_err(WErr::from),
                    )
                }
                IndexOp::Drop => {
                    let res = write::stash_drop(svc, &ctx, &root, &req.oid).await;
                    (None, res.map(drop).map_err(WErr::from))
                }
            }
        })
        .await;
        t.finish()
    }
}

impl GitWrite<'_> {
    /// stash 쓰기 한 번을 실행하고 목록과 상태를 다시 찍는다 (FR-GIT-170). pop 이 충돌로 끝나면
    /// stash 가 남고(FR-GIT-165), 그 사실과 남은 목록이 실패 응답에 실린다. `run` 이 준 필드는
    /// 성공·실패 양쪽에 실린다.
    async fn stash_apply<F, Fut>(&mut self, before: &Status, run: F)
    where
        F: FnOnce(Ctx) -> Fut,
        Fut: Future<Output = (Option<Obj>, Result<(), WErr>)>,
    {
        let mut extra: Option<Obj> = None;
        let slot = &mut extra;
        let (ran, run_err) = self
            .write(|ctx| async move {
                let (x, res) = run(ctx).await;
                *slot = x;
                res
            })
            .await;
        if !ran {
            return;
        }
        if let Some(e) = &run_err
            && Classify::is(&**e, &Sentinel::Core(Kind::ServerShutdown))
        {
            // §8: 재조회 없이 503.
            self.reject(&**e);
            return;
        }
        let ctx = self.post();
        let git = self.git();
        git.invalidate(&self.root);
        let (status_res, _) = git.status(&ctx, &self.root).await;
        let mut body =
            obj! {"requested" => self.requested, "repo" => self.root, "partial" => false};
        if let Some(x) = &extra {
            body.extend(x.clone());
        }
        if let Ok(obs) = &status_res {
            body.insert("status".to_owned(), raw(&obs.status));
            // 목록 조회의 실패로 응답을 버리지 않는다 — 실행 결과가 더 중요하다.
            if let Ok(list) = write::stash_list(git.service(), &ctx, &self.root).await {
                body.insert("stashes".to_owned(), raw(&list));
            }
            let changed = git_status_delta(before, &obs.status);
            if !changed.is_empty() && run_err.is_some() {
                body.insert("partial".to_owned(), raw(&true));
                body.insert("changed".to_owned(), raw(&changed));
            }
        }
        let Some(run_err) = run_err else {
            match status_res {
                // 실행은 됐고 재조회가 실패했다. 성공으로 보이면 화면이 낡은 목록을 유지한다.
                Err(e) => self.respond(git_error(&e)),
                Ok(_) => {
                    body.insert("ok".to_owned(), raw(&true));
                    self.respond(git_json(StatusCode::OK, &body));
                }
            }
            return;
        };
        let (code, name) = stash_error_code(&*run_err, &extra);
        let msg = git_tail(&run_err.to_string());
        self.git_render_fail(&ctx, code, name, &msg, Some(&*run_err), body)
            .await;
    }
}
