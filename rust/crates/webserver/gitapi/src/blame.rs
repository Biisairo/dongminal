//! GET /api/git/blame?repo=&rev=&path= — 파일 하나의 줄별 출처 (FR-GIT-276). Go `handlers_git_blame.go`.

use http::StatusCode;
use otter_shared_httpresp::Response;
use otter_webserver_domain_git_query::{self as query, BlameQuery};
use serde::Serialize;

use crate::GitServer;
use crate::reply::{ERR_BAD_REQUEST, embed, git_error, git_fail, git_json, raw};
use crate::req::Req;

/// 클라이언트가 보낸 값 그대로다 (FR-GIT-54 의 stale 가드와 같은 규약).
#[derive(Serialize)]
struct BlameRequested {
    repo: String,
    rev: String,
    path: String,
}

impl GitServer {
    pub(crate) async fn api_git_blame(&self, r: &mut Req) -> Response {
        let (git, root, requested) = match self.git_repo_param(r).await {
            Ok(v) => v,
            Err(res) => return res,
        };
        let req = BlameRequested {
            repo: requested,
            rev: r.q("rev"),
            path: r.q("path"),
        };
        if req.path.is_empty() {
            return git_fail(StatusCode::BAD_REQUEST, ERR_BAD_REQUEST, "path 가 비었다");
        }
        let q = BlameQuery {
            repo: root.clone(),
            rev: req.rev.clone(),
            path: req.path.clone(),
        };
        match query::blame(git.service(), &r.ctx, &q).await {
            Ok(mut b) => {
                b.repo = root;
                git_json(
                    StatusCode::OK,
                    &embed(&[("requested", raw(&req))], &raw(&b)),
                )
            }
            Err(e) => git_error(&e),
        }
    }
}
