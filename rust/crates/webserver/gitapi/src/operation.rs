//! POST /api/git/operation — 진행 중 작업의 출구: 계속 / 건너뛰기 / 중단
//! (GIT_ACTIONS_SRS §3.1 / FR-GIT-252). Go `handlers_git_operation.go`.
//!
//! 중단은 파괴적이다 — 그 작업 중 해결한 내용이 사라진다. `confirm:true` 없이는 실행하지 않는다.

use dm_shared_httpresp::Response;
use dm_webserver_apierr as apierr;
use dm_webserver_domain_git_core::WriteSpec;
use dm_webserver_domain_git_write as write;
use http::StatusCode;
use serde::Deserialize;

use crate::GitServer;
use crate::reply::{ERR_BAD_REQUEST, git_err_json, git_tail, obj};
use crate::req::Req;

#[derive(Default, Deserialize)]
#[serde(default, rename = "gitapi.gitOperationReq")]
struct OperationReq {
    repo: String,
    kind: String,
    action: String,
    confirm: bool,
}

/// 사유 문구에 쓸 이름이다. 빈 값은 "없음" 이다.
fn operation_label(kind: &str) -> &str {
    if kind.is_empty() { "없음" } else { kind }
}

impl GitServer {
    pub(crate) async fn api_git_operation(&self, r: &mut Req) -> Response {
        let (mut t, req) = self.begin_write::<OperationReq>(r).await;
        t.require_confirm(
            req.action == write::OP_ABORT,
            req.confirm,
            "중단은 그 작업 중 해결한 내용을 버린다: confirm:true 를 요구한다 (FR-GIT-89)",
        );
        // 잘못된 조합은 실행 전에 답한다. 코드는 호출 문맥이 정한다 (등록부를 지나지 않는다).
        let spec = match write::operation_spec(&req.kind, &req.action) {
            Ok(s) => s,
            Err(e) => {
                t.reject_with(
                    StatusCode::BAD_REQUEST,
                    ERR_BAD_REQUEST,
                    &git_tail(&e.to_string()),
                );
                WriteSpec::default()
            }
        };
        t.resolve(&req.repo).await;
        let before = t.snapshot().await;
        if t.stop() {
            return t.finish();
        }
        // 화면이 아는 작업과 저장소의 작업이 같은지 본다 — 다르면 실행하지 않는다.
        let cur = before.operation.kind.clone();
        if cur != req.kind {
            let name = if cur.is_empty() {
                apierr::CODE_NO_OPERATION
            } else {
                apierr::CODE_OPERATION_MISMATCH
            };
            return git_err_json(
                StatusCode::CONFLICT,
                name,
                &obj! {
                    "error" => name, "requested" => req.repo, "repo" => t.root,
                    "message" => format!("진행 중인 작업이 {} 입니다", operation_label(&cur)),
                    "status" => before,
                },
            );
        }
        // §5.2: 출구는 잡이다 — kind 는 argv[0].
        t.start_write_job(spec, before, None, None).await;
        t.finish()
    }
}
