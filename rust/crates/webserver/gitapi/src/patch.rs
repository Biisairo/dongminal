//! /api/git/{hunks,patch} — 부분 스테이징 (GIT_ACTIONS_SRS §3.7 FR-GIT-278·279). Go
//! `handlers_git_patch.go`.
//!
//! 패치는 서버가 만든다 (D6). 요청 구조체에 패치 문자열이 들어올 자리가 없다 — 클라이언트가
//! 보내는 것은 좌표뿐이다: (경로, 축, hunk 번호, 줄 범위, 관측 식별자).

use dm_shared_httpresp::Response;
use dm_webserver_domain_git_query as query;
use dm_webserver_domain_git_write::{self as write, PatchOpts};
use http::StatusCode;
use serde::{Deserialize, Serialize};

use crate::GitServer;
use crate::reply::{ERR_BAD_REQUEST, WErr, embed, git_error, git_json, git_tail, obj, raw};
use crate::req::Req;

/// hunks 응답이 되돌려주는 요청값이다 (FR-GIT-16·54).
#[derive(Serialize)]
struct HunksRequested {
    repo: String,
    axis: String,
    path: String,
}

/// 조각 하나를 적용하는 요청이다. 패치·본문을 담는 필드가 없다 (D6). `hunk` 는 0-기반 덩어리
/// 번호, `from`·`to` 는 그 덩어리 본문 안의 1-기반 줄 번호다 — 둘 다 0 이면 덩어리 전체다.
#[derive(Default, Deserialize)]
#[serde(default, rename = "gitapi.gitPatchReq")]
struct PatchReq {
    repo: String,
    axis: String,
    path: String,
    op: String,
    hunk: i64,
    from: i64,
    to: i64,
    #[serde(rename = "diffId")]
    diff_id: String,
    confirm: bool,
}

impl GitServer {
    /// GET /api/git/hunks?repo=&axis=&path= — 서버가 만든 diff 의 경계 (FR-GIT-278).
    pub(crate) async fn api_git_hunks(&self, r: &mut Req) -> Response {
        let (git, root, requested) = match self.git_repo_param(r).await {
            Ok(v) => v,
            Err(res) => return res,
        };
        let req = HunksRequested {
            repo: requested,
            axis: r.q("axis"),
            path: r.q("path"),
        };
        match query::hunks_of(git.service(), &r.ctx, &root, &req.axis, &req.path).await {
            Ok(fd) => git_json(
                StatusCode::OK,
                &embed(&[("requested", raw(&req))], &raw(&fd)),
            ),
            Err(e) => git_error(&e),
        }
    }

    /// POST /api/git/patch — 조각 하나를 적용한다 (FR-GIT-278·279). revert 는 파괴적이다.
    pub(crate) async fn api_git_patch(&self, r: &mut Req) -> Response {
        let (mut t, req) = self.begin_write::<PatchReq>(r).await;
        // 파괴적 여부는 동작에서 파생한다.
        let destructive = match write::patch_args(&req.op) {
            Ok((_, d)) => d,
            Err(e) => {
                t.reject_with(
                    StatusCode::BAD_REQUEST,
                    ERR_BAD_REQUEST,
                    &git_tail(&e.to_string()),
                );
                false
            }
        };
        t.require_confirm(
            destructive,
            req.confirm,
            "파괴적 동작은 confirm:true 를 요구한다 (FR-GIT-89)",
        );
        t.resolve(&req.repo).await;
        let opts = PatchOpts {
            op: req.op.clone(),
            axis: req.axis.clone(),
            path: req.path.clone(),
            hunk: req.hunk,
            from: req.from,
            to: req.to,
            diff_id: req.diff_id.clone(),
        };
        if !t.stop() {
            let (git, root) = (t.git(), t.root.clone());
            t.apply(|ctx| async move {
                write::patch(git.service(), &ctx, &root, &opts)
                    .await
                    .map(drop)
                    .map_err(WErr::from)
            })
            .await;
        }
        // 요청값을 되돌려준다 — 어느 조각이 적용됐는지 클라이언트가 짝을 확인한다.
        t.ok(Some(&obj! {
            "op" => req.op, "axis" => req.axis, "path" => req.path,
            "hunk" => req.hunk, "from" => req.from, "to" => req.to,
        }));
        t.finish()
    }
}
