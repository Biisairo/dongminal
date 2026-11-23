//! `/api/*` 의 종단 목록 (Go `handlers_api.go` 의 `apiRoutes`). 모양과 디스패치는 `httproute` 가
//! 소유한다 (FR-DRC-10). 매칭은 **첫 성공이 이긴다** — 하위 이슈는 Go 표와 같은 자리에 자기
//! 종단을 끼워 넣는다. 지금은 5.5.1 이 옮긴 종단만 있다.

use std::sync::LazyLock;

use dm_webserver_httproute::{Route, any, get, post, put};

use crate::Server;
use crate::req::{BoxFut, Handler, Req};

/// 처리기 하나를 표의 함수로 감싼다.
macro_rules! h {
    ($m:ident) => {{
        fn f<'a>(s: &'a Server, r: &'a mut Req) -> BoxFut<'a, dm_shared_httpresp::Response> {
            Box::pin(s.$m(r))
        }
        f as Handler
    }};
}

pub(crate) static API_ROUTES: LazyLock<Vec<Route<Handler>>> = LazyLock::new(|| {
    vec![
        // 에이전트 접합면 (SKILL_INJECTION_SRS FR-API-1/2/3).
        get("/api/tools/output", h!(api_tool_output)),
        post("/api/tools/input", h!(api_tool_input)),
        post("/api/tools/message", h!(api_tool_message)),
        // ACCESS_ALLOWLIST_SRS FR-ACL-19·20. 게이트 **뒤**에 있다 (FR-ACL-21).
        get("/api/access", h!(api_access_get)),
        put("/api/access", h!(api_access_put)),
        post("/api/access/check", h!(api_access_check)),
        post("/api/upload", h!(api_upload)),
        get("/api/download", h!(api_download)),
        get("/api/cwd", h!(api_cwd)),
        get("/api/file/read", h!(api_file_read)),
        post("/api/file/write", h!(api_file_write)),
        // EDITOR_LIVE_RELOAD_SRS 묶음 E — 열어 둔 파일들이 바뀌었는지만 묻는다 (FR-ELR-7).
        post("/api/file/stamps", h!(api_file_stamps)),
        // EDITOR_GIT_UX_SRS 묶음 V — 열 수 있는 형식인가, 그리고 이미지 바이트.
        get("/api/file/probe", h!(api_file_probe)),
        get("/api/file/raw", h!(api_file_raw)),
        // 묶음 S — 탐색기의 디렉터리 조회 (FR-EDT-108). root 를 함께 받아 그 아래로 제한한다 (D-16).
        get("/api/fs/list", h!(api_fs_list)),
        get("/api/editors", h!(api_editors_get)),
        post("/api/editors/add", h!(api_editors_add)),
        // F-m: 편집기 루트 추가 경로의 답.
        post("/api/editors/validate", h!(api_editors_validate)),
        post("/api/editors/remove", h!(api_editors_remove)),
        post("/api/editors/reorder", h!(api_editors_reorder)),
        any("/api/ping", h!(api_ping)),
        #[cfg(test)]
        get("/api/test/panic", h!(api_test_panic)),
    ]
});

#[cfg(test)]
impl Server {
    async fn api_test_panic(&self, _r: &mut Req) -> dm_shared_httpresp::Response {
        panic!("시험 패닉")
    }
}
