//! POST /api/git/init — 저장소가 아닌 자리를 저장소로 만들고 핀한다 (REPO_TAB_UNIFY_SRS FR-RTU-25~29).
//!
//! 초기 브랜치 이름을 주지 않는다 — 사용자의 `init.defaultBranch` 를 따른다.

use dm_shared_httpresp::Response;
use dm_webserver_domain_git_core::{self as core, WriteSpec};
use dm_webserver_domain_wsentry as wsentry;
use http::StatusCode;

use crate::GitServer;
use crate::handlers_git::decode_abs_path;
use crate::reply::{
    ERR_BAD_REQUEST, ERR_EXISTS, ERR_FAILED, git_fail, git_json, git_tail, git_unavailable, obj,
};
use crate::req::Req;

impl GitServer {
    pub(crate) async fn api_git_init(&self, r: &mut Req) -> Response {
        let Some(git) = self.git.clone() else {
            return git_unavailable();
        };
        let path = match decode_abs_path(r).await {
            Ok(p) => p,
            Err(res) => return res,
        };
        let dir = wsentry::normalize_path(&path);
        let meta = match std::fs::metadata(&dir) {
            Ok(m) => m,
            Err(_) => {
                return git_fail(
                    StatusCode::BAD_REQUEST,
                    ERR_BAD_REQUEST,
                    &format!("그런 폴더가 없습니다: {dir}"),
                );
            }
        };
        if !meta.is_dir() {
            return git_fail(
                StatusCode::BAD_REQUEST,
                ERR_BAD_REQUEST,
                &format!("디렉터리가 아닙니다: {dir}"),
            );
        }
        // RepoRoot 는 실패를 캐시하므로 판정 전에 잊는다 (FR-RTU-28). 하위 폴더는 init 한다.
        git.forget_root(&dir);
        if let Ok(root) = git.repo_root(&r.ctx, &dir).await
            && root == dir
        {
            return git_fail(
                StatusCode::CONFLICT,
                ERR_EXISTS,
                &format!("이미 git 저장소입니다: {dir}"),
            );
        }
        let spec = WriteSpec {
            argv: vec!["init".to_owned()],
            ..WriteSpec::default()
        };
        let exec: crate::req::BoxFut<'_, _> =
            Box::pin(git.service().exec_write(&r.ctx, &dir, &spec));
        if let Err(e) = exec.await {
            let stderr = e.output().map(|o| o.stderr.clone()).unwrap_or_default();
            return git_fail(
                StatusCode::INTERNAL_SERVER_ERROR,
                ERR_FAILED,
                &git_tail(&init_err(&stderr, &e)),
            );
        }
        git.forget_root(&dir);
        if path != dir {
            git.forget_root(&path);
        }
        match self.entries().pin_add(&dir) {
            Ok((stored, lists)) => git_json(
                StatusCode::OK,
                &obj! {"ok" => true, "repo" => stored, "pinned" => lists.pinned, "editors" => lists.editors},
            ),
            Err(e) => git_fail(
                StatusCode::INTERNAL_SERVER_ERROR,
                ERR_FAILED,
                &git_tail(&e.to_string()),
            ),
        }
    }
}

/// git 의 stderr 가 사유다. 비었으면 실행 오류 문구다.
fn init_err(stderr: &str, err: &core::Error) -> String {
    let s = git_tail(stderr);
    if s.is_empty() { err.to_string() } else { s }
}
