//! GET /api/git/records — Console 탭의 실행 기록 (GIT_UI_REVISION_SRS FR-GIT-218).

use http::StatusCode;
use otter_gocompat::json::RawMessage;
use otter_shared_httpresp::Response;
use otter_webserver_domain_git_core::Record;
use serde::Serialize;

use crate::GitServer;
use crate::history::count_param;
use crate::reply::{ERR_BAD_REQUEST, embed, git_fail, git_json, raw};
use crate::req::Req;

#[derive(Serialize)]
struct RecordsRequested<'a> {
    repo: &'a str,
    n: i64,
}

impl GitServer {
    /// `after` 를 주면 그 뒤 기록과 커서를 함께 준다 (FR-OPT-0-3). 기록은 최신이 먼저다.
    pub(crate) async fn api_git_records(&self, r: &mut Req) -> Response {
        let (git, root, requested) = match self.git_repo_param(r).await {
            Ok(v) => v,
            Err(res) => return res,
        };
        let n = match count_param(&r.query, "n") {
            Ok(n) => n,
            Err(res) => return res,
        };
        let svc = git.service();
        let (all, cursor) = if r.query.has("after") {
            let Ok(after) = otter_gocompat::strconv::parse_uint10(&r.q("after")) else {
                return git_fail(
                    StatusCode::BAD_REQUEST,
                    ERR_BAD_REQUEST,
                    "after 는 0 이상의 정수여야 한다",
                );
            };
            let (all, span) = svc.records_since(after, &r.q("epoch"));
            let cursor = [
                ("lastSeq", raw(&span.last)),
                ("firstSeq", raw(&span.first)),
                ("gap", raw(&span.gap)),
                ("epoch", raw(&span.epoch)),
            ];
            (all, Some(cursor))
        } else {
            (svc.records(0), None)
        };
        let mut out: Vec<Record> = all
            .iter()
            .rev()
            .filter(|rec| rec.cwd == root)
            .map(Record::redacted)
            .collect();
        let total = out.len();
        if n > 0 && (n as usize) < total {
            out.truncate(n as usize);
        }
        let mut head = vec![
            (
                "requested",
                raw(&RecordsRequested {
                    repo: &requested,
                    n,
                }),
            ),
            ("repo", raw(&root)),
            ("records", raw(&out)),
            ("total", raw(&total)),
        ];
        head.extend(cursor.into_iter().flatten());
        git_json(StatusCode::OK, &embed(&head, &RawMessage(b"{}".to_vec())))
    }
}
