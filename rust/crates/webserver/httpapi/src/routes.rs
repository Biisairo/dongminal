//! `/api/*` 의 종단 목록 (Go `handlers_api.go` 의 `apiRoutes`). 모양과 디스패치는 `httproute` 가
//! 소유한다 (FR-DRC-10). 매칭은 **첫 성공이 이긴다** — 하위 이슈는 Go 표와 같은 자리에 자기
//! 종단을 끼워 넣는다. 지금은 5.5.1 이 옮긴 종단만 있다.

use std::sync::LazyLock;

use dm_webserver_httproute::{
    METHOD_DELETE, METHOD_GET, Matcher, Route, any, get, post, put, when,
};

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
        get("/api/state", h!(api_state_get)),
        post("/api/tools", h!(api_tools_create)),
        // 에이전트 접합면 (SKILL_INJECTION_SRS FR-API-1/2/3).
        get("/api/tools/output", h!(api_tool_output)),
        post("/api/tools/input", h!(api_tool_input)),
        post("/api/tools/message", h!(api_tool_message)),
        post("/api/tools/kill", h!(api_tool_kill)),
        // 일괄 조회는 단건 종단보다 먼저 와야 한다 (FR-OPT-2-4).
        get("/api/tools/busy", h!(api_tools_busy)),
        when(
            METHOD_GET,
            Matcher::UnderWith("/api/tools/", "/busy"),
            h!(api_tool_busy),
        ),
        when(
            METHOD_DELETE,
            Matcher::Under("/api/tools/"),
            h!(api_tool_delete),
        ),
        get("/api/focus", h!(api_focus_get)),
        post("/api/focus/claim", h!(api_focus_claim)),
        get("/api/sandbox/profiles", h!(api_sandbox_profiles)),
        get("/api/sandbox/runtime", h!(api_sandbox_runtime)),
        post("/api/sandbox/runtime/start", h!(api_sandbox_runtime_start)),
        get("/api/sandbox/config", h!(api_sandbox_config_get)),
        put("/api/sandbox/config", h!(api_sandbox_config_put)),
        get("/api/workspace", h!(api_workspace_get)),
        put("/api/workspace", h!(api_workspace_put)),
        // ACCESS_ALLOWLIST_SRS FR-ACL-19·20. 게이트 **뒤**에 있다 (FR-ACL-21).
        get("/api/access", h!(api_access_get)),
        put("/api/access", h!(api_access_put)),
        post("/api/access/check", h!(api_access_check)),
        any("/api/ping", h!(api_ping)),
        get("/api/stats", h!(api_stats)),
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
