//! POST /api/git/records/replay — 기록 하나를 다시 실행한다 (FR-GIT-281).
//!
//! 클라이언트는 seq 만 보내고 argv 는 서버가 자기 기록에서 꺼낸다 — 문자열을 받아 실행하면
//! 임의 명령 표면이 된다. 쓰기 기록이면 확인과 잠금을 요구한다.

use http::StatusCode;
use otter_shared_httpresp::Response;
use otter_webserver_apierr as apierr;
use otter_webserver_domain_git_core::Record;
use otter_webserver_domain_git_write as write;
use serde::Deserialize;

use crate::GitServer;
use crate::reply::{WErr, obj};
use crate::req::Req;

#[derive(Default, Deserialize)]
#[serde(default, rename = "gitapi.gitReplayReq")]
struct ReplayReq {
    repo: String,
    seq: u64,
    confirm: bool,
}

impl GitServer {
    pub(crate) async fn api_git_replay(&self, r: &mut Req) -> Response {
        let (mut t, req) = self.begin_write::<ReplayReq>(r).await;
        t.resolve_root(&req.repo).await;
        if t.stop() {
            return t.finish();
        }
        let Some(rec) = self.git_record_of(&t.root, req.seq) else {
            t.reject_with(
                StatusCode::NOT_FOUND,
                apierr::CODE_RECORD_MISSING,
                "그 기록이 이 저장소에 없다 — 버퍼에서 밀려났을 수 있다",
            );
            return t.finish();
        };
        t.lock(rec.write).await;
        t.require_confirm(
            rec.write,
            req.confirm,
            "쓰기 기록을 다시 실행한다: confirm:true 를 요구한다 (FR-GIT-89)",
        );
        let git = self.git.clone();
        let (root, rec2) = (t.root.clone(), rec.clone());
        t.apply(|ctx| async move {
            let Some(git) = git else { return Ok(()) };
            write::replay(git.service(), &ctx, &root, &rec2)
                .await
                .map(drop)
                .map_err(WErr::from)
        })
        .await;
        t.ok(Some(&obj! {"argv" => rec.argv}));
        t.finish()
    }

    /// 그 저장소의 seq 기록이다. 다른 저장소의 기록은 없는 것으로 본다.
    fn git_record_of(&self, root: &str, seq: u64) -> Option<Record> {
        self.git
            .as_ref()?
            .service()
            .records(0)
            .into_iter()
            .find(|rec| rec.seq == seq && rec.cwd == root)
    }
}
