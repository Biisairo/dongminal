//! /api/git/{preflight,policy,recovery} — 안전 정책 표면 (GIT_SRS §3A.3 FR-GIT-86~93).

use std::collections::BTreeMap;

use http::StatusCode;
use otter_shared_httpresp::Response;
use otter_webserver_domain_git_core as core;
use otter_webserver_domain_git_jobs as jobs;
use otter_webserver_domain_git_query as query;
use otter_webserver_domain_git_write as write;

use crate::GitServer;
use crate::reply::{git_error, git_json, git_unavailable, obj};
use crate::req::Req;

impl GitServer {
    /// GET /api/git/preflight?repo=<abs> — 커밋 실행 전 검사 (FR-GIT-86~88).
    pub(crate) async fn api_git_preflight(&self, r: &mut Req) -> Response {
        let (git, root, requested) = match self.git_repo_param(r).await {
            Ok(v) => v,
            Err(res) => return res,
        };
        match query::preflight_of(git.service(), &r.ctx, &root).await {
            Ok(pf) => git_json(
                StatusCode::OK,
                &obj! {"requested" => requested, "repo" => root, "preflight" => pf},
            ),
            Err(e) => git_error(&e),
        }
    }

    /// GET /api/git/policy — 파괴적 동작 목록 (FR-GIT-89). 정책은 저장소마다 다르지 않다.
    pub(crate) async fn api_git_policy(&self, _r: &mut Req) -> Response {
        let ops: BTreeMap<String, Vec<String>> = write::operation_kinds()
            .into_iter()
            .map(|k| {
                let acts = write::operation_actions(&k);
                (k, acts)
            })
            .collect();
        let log_limits = BTreeMap::from([
            ("initial", query::LOG_INITIAL_LIMIT),
            ("page", query::LOG_PAGE_LIMIT),
            ("max", query::LOG_MAX_LIMIT),
        ]);
        git_json(
            StatusCode::OK,
            &obj! {
                "destructive" => core::DESTRUCTIVE_ACTIONS,
                "operations" => ops,
                "tagKinds" => write::TAG_KINDS,
                "resetModes" => write::RESET_MODES,
                "jobLineCap" => jobs::JOB_LINE_CAP,
                "jobSlots" => jobs::SLOT_ORDER,
                "logLimits" => log_limits,
            },
        )
    }

    /// GET /api/git/recovery — 세션 동안 기록된 recovery hint (FR-GIT-92·93).
    pub(crate) async fn api_git_recovery(&self, _r: &mut Req) -> Response {
        let Some(git) = &self.git else {
            return git_unavailable();
        };
        git_json(StatusCode::OK, &obj! {"hints" => git.service().hints(0)})
    }
}
