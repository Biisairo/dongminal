//! /api/git/submodules* — Submodules 탭의 서버측 (UX_BATCH5_SRS 묶음 D, FR-SUB-1~5). Go
//! `handlers_git_submodule.go`.
//!
//! 서브모듈의 git 실행은 전부 submodule 도메인을 지난다 (D-9 정정). 아래 핸들러는 git 을 저장소
//! 해석에만 쓴다.

use std::fmt;

use http::StatusCode;
use otter_gocompat::filepath;
use otter_shared_httpresp::Response;
use otter_webserver_apierr::{self as apierr, Classify, Sentinel};
use otter_webserver_domain_git_core::{Kind, PRE_PHASE_TIMEOUT};
use otter_webserver_domain_submodule::{self as submodule, Kind as SubKind};
use serde::{Deserialize, Serialize};

use crate::GitServer;
use crate::reply::{
    ERR_BAD_REQUEST, ERR_FAILED, ERR_UNAVAILABLE, GitErr, Obj, git_fail, git_json, git_tail, obj,
    status,
};
use crate::req::Req;

const CONFIRM_REASON: &str = "서브모듈 조작은 확인을 요구한다: confirm:true (FR-SUB-4)";

/// submodule 오류의 분류다 — 실행 실패의 원인(core)이 판정한다 (Go 의 errors.Is 사슬).
struct SubErr(submodule::Error);

impl fmt::Display for SubErr {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(f)
    }
}

impl Classify for SubErr {
    fn is(&self, s: &Sentinel) -> bool {
        self.0.core().is_some_and(|c| Classify::is(c, s))
    }
}

impl GitErr for SubErr {}

#[derive(Serialize)]
struct SubmoduleEntry {
    path: String,
    #[serde(rename = "absPath")]
    abs_path: String,
    oid: String,
    state: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    describe: String,
}

#[derive(Default, Deserialize)]
#[serde(default, rename = "gitapi.gitSubmoduleReq")]
struct SubmoduleReq {
    repo: String,
    path: String,
    init: bool,
    recursive: bool,
    confirm: bool,
}

fn git_submodules_unavailable() -> Response {
    git_fail(
        StatusCode::SERVICE_UNAVAILABLE,
        ERR_UNAVAILABLE,
        "서브모듈 관리자가 구성되지 않았다",
    )
}

/// 경로 가드 위반은 400 이고, 나머지는 표가 판정한다.
fn git_submodule_code(err: &SubErr) -> (StatusCode, &'static str) {
    if err.0.is(SubKind::UnsafePath) {
        return (StatusCode::BAD_REQUEST, ERR_BAD_REQUEST);
    }
    match apierr::GIT.lookup(err) {
        Some((code, name)) => (status(code), name),
        None => (StatusCode::INTERNAL_SERVER_ERROR, ERR_FAILED),
    }
}

fn git_submodule_error(err: submodule::Error) -> Response {
    let e = SubErr(err);
    let (code, name) = git_submodule_code(&e);
    git_fail(code, name, &git_tail(&e.to_string()))
}

impl GitServer {
    /// GET /api/git/submodules?repo= — 서브모듈 목록 (FR-SUB-1).
    pub(crate) async fn api_git_submodules(&self, r: &mut Req) -> Response {
        let Some(mgr) = self.submodules.clone() else {
            return git_submodules_unavailable();
        };
        let (_, root, requested) = match self.git_repo_param(r).await {
            Ok(v) => v,
            Err(res) => return res,
        };
        let ctx = r.ctx.with_timeout(PRE_PHASE_TIMEOUT);
        let entries = mgr.list(&ctx, &root).await;
        ctx.cancel();
        let entries = match entries {
            Ok(e) => e,
            Err(e) => return git_submodule_error(e),
        };
        let out: Vec<SubmoduleEntry> = entries
            .into_iter()
            .map(|e| SubmoduleEntry {
                abs_path: filepath::join(&[root.as_str(), &filepath::from_slash(&e.path)]),
                path: e.path,
                oid: e.oid,
                state: e.state,
                describe: e.describe,
            })
            .collect();
        git_json(
            StatusCode::OK,
            &obj! {"repo" => root, "requested" => requested, "submodules" => out},
        )
    }

    /// POST /api/git/submodules/update — 서브모듈을 등록된 커밋으로 옮긴다 (FR-SUB-4). 파괴적이고
    /// (FR-SUB-5) 잡이다 (M8 D-A-27).
    pub(crate) async fn api_git_submodule_update(&self, r: &mut Req) -> Response {
        let available = self.submodules.is_some();
        let (mut t, req) = self
            .begin_service_write::<SubmoduleReq>(r, available, git_submodules_unavailable)
            .await;
        t.require_confirm(true, req.confirm, CONFIRM_REASON);
        t.resolve(&req.repo).await;
        if t.stop() {
            return t.finish();
        }
        match submodule::update_spec(&t.root, &req.path, req.init, req.recursive) {
            Ok(spec) => {
                t.start_unguarded_job("submodule", spec.argv, &spec.reason)
                    .await;
                t.finish()
            }
            Err(e) => git_submodule_error(e),
        }
    }

    /// POST /api/git/submodules/sync — `.gitmodules` 의 URL 을 설정에 다시 옮긴다 (FR-SUB-4).
    pub(crate) async fn api_git_submodule_sync(&self, r: &mut Req) -> Response {
        let available = self.submodules.is_some();
        let (mut t, req) = self
            .begin_service_write::<SubmoduleReq>(r, available, git_submodules_unavailable)
            .await;
        t.require_confirm(true, req.confirm, CONFIRM_REASON);
        t.resolve(&req.repo).await;
        if t.stop() {
            return t.finish();
        }
        let Some(mgr) = self.submodules.clone() else {
            return git_submodules_unavailable();
        };
        let (root, path) = (t.root.clone(), req.path.clone());
        let mut sub_err: Option<submodule::Error> = None;
        let slot = &mut sub_err;
        let (ran, err) = t
            .write_within(self.git_manager_write(), |ctx| async move {
                match mgr.sync(&ctx, &root, &path).await {
                    Ok(()) => Ok(()),
                    Err(e) => {
                        *slot = Some(e.clone());
                        Err(Box::new(SubErr(e)) as crate::reply::WErr)
                    }
                }
            })
            .await;
        if !ran {
            return t.finish();
        }
        let Some(err) = err else {
            t.ok_plain(None);
            return t.finish();
        };
        if Classify::is(&*err, &Sentinel::Core(Kind::ServerShutdown)) {
            t.reject(&*err);
            return t.finish();
        }
        let ctx = t.post();
        let (code, name) = match sub_err {
            Some(e) => git_submodule_code(&SubErr(e)),
            None => crate::reply::git_error_code(&*err),
        };
        let msg = git_tail(&err.to_string());
        t.git_render_fail(&ctx, code, name, &msg, Some(&*err), Obj::new())
            .await;
        t.finish()
    }
}
