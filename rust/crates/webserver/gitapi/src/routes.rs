//! `/api/git/*` 의 종단 목록 (Go `routes.go`). 모양과 디스패치는 `httproute` 가 소유한다
//! (FR-DRC-10). 5.4.1·5.4.2 가 옮긴 종단만 싣는다 — 나머지는 5.4.3 이 이어 붙인다.

use std::sync::LazyLock;

use dm_webserver_httproute::{Route, get, post};

use crate::GitServer;
use crate::reply::git_unavailable;
use crate::req::{BoxFut, Handler, Req};

/// 처리기 하나를 표의 함수로 감싼다. `need_git` 이면 git 가용성 가드를 먼저 세운다
/// (REFACTOR3_DEDUP_GO_SRS FR-RDG-8).
macro_rules! h {
    ($m:ident) => {{
        fn f<'a>(s: &'a GitServer, r: &'a mut Req) -> BoxFut<'a, dm_shared_httpresp::Response> {
            Box::pin(s.$m(r))
        }
        f as Handler
    }};
    (need_git $m:ident) => {{
        fn f<'a>(s: &'a GitServer, r: &'a mut Req) -> BoxFut<'a, dm_shared_httpresp::Response> {
            Box::pin(async move {
                if s.git.is_none() {
                    return git_unavailable();
                }
                s.$m(r).await
            })
        }
        f as Handler
    }};
}

pub(crate) static ROUTES: LazyLock<Vec<Route<Handler>>> = LazyLock::new(|| {
    vec![
        get("/api/git/repos", h!(need_git api_git_repos)),
        // REPO_TAB_UNIFY_SRS FR-RTU-29: 성공의 결과가 곧 핀이라 핀 추가와 같은 묶음이다.
        post("/api/git/init", h!(need_git api_git_init)),
        post("/api/git/repos/pin", h!(need_git api_git_pin)),
        post("/api/git/repos/unpin", h!(need_git api_git_unpin)),
        get("/api/git/status", h!(api_git_status)),
        get("/api/git/signature", h!(api_git_signature)),
        get("/api/git/diff-content", h!(api_git_diff_content)),
        // M9_SRS FR-M9-21: diff 한쪽의 원본 바이트 — `<img src>` 가 건다.
        get("/api/git/blob", h!(api_git_blob)),
        get("/api/git/preflight", h!(api_git_preflight)),
        get("/api/git/policy", h!(need_git api_git_policy)),
        get("/api/git/recovery", h!(need_git api_git_recovery)),
        post("/api/git/stage", h!(api_git_stage)),
        post("/api/git/unstage", h!(api_git_unstage)),
        post("/api/git/discard", h!(api_git_discard)),
        post("/api/git/resolve", h!(api_git_resolve)),
        post("/api/git/commit", h!(api_git_commit_create)),
        post("/api/git/undo-last", h!(api_git_undo_last)),
        get("/api/git/log", h!(api_git_log)),
        get("/api/git/blame", h!(api_git_blame)),
        get("/api/git/commit", h!(api_git_commit)),
        get("/api/git/refs", h!(api_git_refs)),
        get("/api/git/records", h!(api_git_records)),
        // FR-GIT-281: 클라이언트는 seq 만 보내고 argv 는 서버가 자기 기록에서 꺼낸다.
        post("/api/git/records/replay", h!(api_git_replay)),
        post("/api/git/fetch", h!(api_git_fetch)),
        post("/api/git/pull", h!(api_git_pull)),
        post("/api/git/push", h!(api_git_push)),
        post("/api/git/job/cancel", h!(api_git_job_cancel)),
        get("/api/git/job/events", h!(need_git api_git_job_events)),
        get("/api/git/jobs", h!(need_git api_git_jobs)),
        // 묶음 E — 원격 목록 (FR-GIT-269).
        get("/api/git/remotes", h!(api_git_remotes)),
        post("/api/git/remote/add", h!(api_git_remote_add)),
        post("/api/git/remote/remove", h!(api_git_remote_remove)),
        // 묶음 N — 브랜치 (GIT_SRS FR-GIT-155~160). 목록은 /api/git/refs 가 이미 준다.
        post("/api/git/checkout", h!(api_git_checkout)),
        // GIT_ACTIONS_SRS FR-GIT-252: 진행 중 작업의 출구.
        post("/api/git/operation", h!(api_git_operation)),
        post("/api/git/branch", h!(api_git_branch_create)),
        get("/api/git/branch/validate", h!(api_git_branch_validate)),
        // 묶음 B — 브랜치 동작 (GIT_ACTIONS_SRS §3.2).
        post("/api/git/branch/rename", h!(api_git_branch_rename)),
        post("/api/git/branch/delete", h!(api_git_branch_delete)),
        post("/api/git/branch/merge", h!(api_git_branch_merge)),
        post("/api/git/branch/rebase", h!(api_git_branch_rebase)),
        post("/api/git/branch/upstream", h!(api_git_branch_upstream)),
        get("/api/git/branch/merge-preview", h!(api_git_branch_merge_preview)),
        post("/api/git/branch/push", h!(api_git_branch_push)),
        post("/api/git/branch/fetch", h!(api_git_branch_fetch_into)),
        post("/api/git/branch/delete-remote", h!(api_git_branch_delete_remote)),
        // REPO_FIX 01 §7.2: 남은 index.lock 을 사용자 확인 뒤 지운다. 자동 삭제는 없다.
        post("/api/git/lock/remove", h!(api_git_lock_remove)),
    ]
});
