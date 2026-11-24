//! /api/git/uncommitted/{reset,clean} — History 의 미커밋 행 메뉴 (GIT_ACTIONS_SRS §3.6
//! FR-GIT-277). Go `handlers_git_uncommitted.go`. 판정 함수는 `answers` 에 있다.

use http::StatusCode;
use otter_shared_httpresp::Response;
use otter_webserver_action::Answer;
use otter_webserver_domain_git_query::Status;
use otter_webserver_domain_git_write as write;
use serde::Deserialize;

use crate::GitServer;
use crate::answers::{clean_answer, reset_answer};
use crate::reply::{ERR_BAD_REQUEST, WErr, obj};
use crate::req::Req;

/// `paths` 는 clean 의 확인창에 보인 목록이다 — 서버는 그것만 지운다. reset 은 읽지 않는다.
#[derive(Default, Deserialize)]
#[serde(default, rename = "gitapi.gitUncommittedReq")]
struct UncommittedReq {
    repo: String,
    confirm: bool,
    paths: Option<Vec<String>>,
}

impl GitServer {
    /// POST /api/git/uncommitted/reset — index 를 HEAD 로 되돌린다 (mixed). 파괴적이 아니다.
    pub(crate) async fn api_git_uncommitted_reset(&self, r: &mut Req) -> Response {
        self.git_uncommitted_route(r, false, reset_answer).await
    }

    /// POST /api/git/uncommitted/clean — 추적되지 않는 파일을 지운다. 파괴적이다 (FR-GIT-89·277).
    /// `paths` 가 없으면 400, 지금의 untracked 와 집합이 다르면 409 stale_observation 이다.
    pub(crate) async fn api_git_uncommitted_clean(&self, r: &mut Req) -> Response {
        self.git_uncommitted_route(r, true, clean_answer).await
    }

    /// 두 동작의 공통 절차다 (FR-GIT-250 ③). 실행 전 거부는 실행 전 상태로 판정한다.
    async fn git_uncommitted_route(
        &self,
        r: &mut Req,
        clean: bool,
        judge: fn(&Status) -> Answer,
    ) -> Response {
        let (mut t, req) = self.begin_write::<UncommittedReq>(r).await;
        if t.stop() {
            return t.finish();
        }
        t.require_confirm(
            clean,
            req.confirm,
            "파괴적 동작은 confirm:true 를 요구한다 (FR-GIT-89·277)",
        );
        let paths = req.paths.unwrap_or_default();
        if clean && paths.is_empty() {
            t.reject_with(
                StatusCode::BAD_REQUEST,
                ERR_BAD_REQUEST,
                "paths 가 없다 — 확인한 목록만 지운다 (FR-GIT-277)",
            );
        }
        t.resolve(&req.repo).await;
        let before = t.snapshot().await;
        if t.stop() {
            return t.finish();
        }
        let a = judge(&before);
        if !a.ok {
            t.reject_answer(&a, Some(&obj! {"status" => before}));
            return t.finish();
        }
        let (git, root) = (t.git(), t.root.clone());
        t.apply(|ctx| async move {
            let res = if clean {
                write::clean_untracked(git.service(), &ctx, &root, &paths).await
            } else {
                write::uncommitted_reset(git.service(), &ctx, &root).await
            };
            res.map(drop).map_err(WErr::from)
        })
        .await;
        t.ok(None);
        t.finish()
    }
}
