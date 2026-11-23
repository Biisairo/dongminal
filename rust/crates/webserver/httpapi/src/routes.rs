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
        // OPTIMIZE_REFACTOR_SRS FR-OPT-4-5: 구독이 열릴 때의 복원 조각을 한 요청으로.
        get("/api/snapshot", h!(api_snapshot)),
        post("/api/tools", h!(api_tools_create)),
        get("/api/tools/attention", h!(api_tools_attention)),
        post("/api/tools/attention/set", h!(api_tool_attention_set)),
        post("/api/tools/attention/clear", h!(api_tool_attention_clear)),
        post(
            "/api/tools/attention/clear-all",
            h!(api_tool_attention_clear_all),
        ),
        post("/api/tools/attention/claim", h!(api_tool_attention_claim)),
        get("/api/tools/activity", h!(api_tools_activity)),
        // 에이전트 접합면 (SKILL_INJECTION_SRS FR-API-1/2/3).
        get("/api/tools/output", h!(api_tool_output)),
        post("/api/tools/input", h!(api_tool_input)),
        post("/api/tools/message", h!(api_tool_message)),
        get("/api/tools/background", h!(api_tools_background)),
        post("/api/tools/background/set", h!(api_tool_background_set)),
        post("/api/tools/activity/set", h!(api_tool_activity_set)),
        // 묶음 S — 상태·대기 계약 (RUN_ORCHESTRATION_SRS FR-STA-1/2/3).
        get("/api/tools/activity/get", h!(api_tool_status)),
        get("/api/tools/migration-advice", h!(api_migration_advice)),
        get("/api/tools/activity/wait", h!(api_tool_status_wait)),
        post("/api/tools/usage", h!(api_tool_usage)),
        post("/api/tools/subagents", h!(api_tool_subagents)),
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
        get("/api/meta", h!(api_meta)),
        put("/api/workspace", h!(api_workspace_put)),
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
        // NOTES_LIVE_EXPLORER_SRS 묶음 L — 겹이 바뀌었는지만 묻는다.
        post("/api/fs/stamp", h!(api_fs_stamp)),
        // FR-OPT-4-2: 겹·파일을 한 요청으로 묻는다.
        post("/api/fs/stamps", h!(api_fs_stamps)),
        // EDITOR_LIVE_RELOAD_SRS FR-ELR-51: 보이는 디렉터리의 감시 등록. 변화는 `fs_changed` 로 온다.
        put("/api/fs/watch", h!(api_fs_watch)),
        // EDITOR_GIT_UX_SRS 묶음 F·G — Editor 창의 파일 이름 찾기·전체 내용 찾기.
        get("/api/fs/find", h!(api_fs_find)),
        get("/api/fs/grep", h!(api_fs_grep)),
        // EXPLORER_TRANSFER_IGNORE_SRS 묶음 A — 한 겹에서 무시된 이름을 가른다 (D-1).
        post("/api/fs/ignored", h!(api_fs_ignored)),
        post("/api/fs/create", h!(api_fs_create)),
        post("/api/fs/rename", h!(api_fs_rename)),
        post("/api/fs/delete", h!(api_fs_delete)),
        // F-a: 메뉴의 답과 삭제할 항목 수.
        post("/api/fs/actions", h!(api_fs_actions)),
        // F-i: 만들기·이름 바꾸기의 이름 판정.
        post("/api/fs/validate-name", h!(api_fs_validate_name)),
        // FR-WBR-60: 루트를 둘 받는 유일한 fs 종단이다.
        post("/api/fs/copy", h!(api_fs_copy)),
        // 묶음 D·E — 탐색기의 전송. /api/{upload,download} 와 같은 일을 하되 root 가드를 받는다.
        get("/api/fs/download", h!(api_fs_download)),
        // 묶음 B — 폴더를 zip 으로 (FR-ETR-11). UX_BATCH12_SRS FR-EXD-3·4: 여러 경로를 zip 하나로.
        get("/api/fs/download-dir", h!(api_fs_download_dir)),
        get("/api/fs/download-many", h!(api_fs_download_many)),
        post("/api/fs/upload", h!(api_fs_upload)),
        // EDITOR_LSP_SRS 묶음 A — 언어 서버의 관측과 설치.
        post("/api/lsp/status", h!(api_lsp_status)),
        get("/api/lsp/paths", h!(api_lsp_paths_get)),
        put("/api/lsp/paths", h!(api_lsp_paths_put)),
        post("/api/lsp/install", h!(api_lsp_install)),
        // CODEMIRROR_MIGRATION_SRS 묶음 S — 브라우저 LSP 클라이언트와 언어 서버의 통로.
        get("/api/lsp/ws", h!(api_lsp_ws)),
        get("/api/editors", h!(api_editors_get)),
        post("/api/editors/add", h!(api_editors_add)),
        // F-m: 편집기 루트 추가 경로의 답.
        post("/api/editors/validate", h!(api_editors_validate)),
        post("/api/editors/remove", h!(api_editors_remove)),
        post("/api/editors/reorder", h!(api_editors_reorder)),
        any("/api/ping", h!(api_ping)),
        // M5 `G4-7`: 워크스페이스 되돌리기. 서버가 돌고 있어도 쓸 수 있다.
        get("/api/workspace/revisions", h!(api_workspace_revisions)),
        post("/api/workspace/revert", h!(api_workspace_revert)),
        get("/api/stats", h!(api_stats)),
        // PEER_NETWORK_SRS FR-PNW-70: 노드 간 통신의 로컬 API (edge_api.rs).
        get("/api/chat", h!(api_chat_get)),
        post("/api/chat/create", h!(api_chat_create)),
        post("/api/chat/direct", h!(api_chat_direct)),
        post("/api/chat/join", h!(api_chat_join)),
        post("/api/chat/leave", h!(api_chat_leave)),
        post("/api/chat/send", h!(api_chat_send)),
        post("/api/chat/kill", h!(api_chat_kill)),
        post("/api/chat/kick", h!(api_chat_kick)),
        get("/api/edges", h!(api_edges_get)),
        put("/api/edges/node", h!(api_edges_node_put)),
        post("/api/edges/invite", h!(api_edges_invite)),
        post("/api/edges/add", h!(api_edges_add)),
        post("/api/edges/remove", h!(api_edges_remove)),
        put("/api/edges/address", h!(api_edges_address)),
        post("/api/edges/notify", h!(api_edges_notify)),
        post("/api/edges/invite/send", h!(api_edges_invite_send)),
        post("/api/edges/invite/accept", h!(api_edges_invite_accept)),
        post("/api/edges/invite/reject", h!(api_edges_invite_reject)),
        // PROFILE_NAME_SRS §3.2: 이 기기의 이름.
        get("/api/profile", h!(api_profile_get)),
        put("/api/profile", h!(api_profile_put)),
        // CLAUDE_ACCOUNTS_SRS FR-CAC-120·121.
        get("/api/claude-accounts", h!(api_claude_accounts_list)),
        post("/api/claude-accounts/add", h!(api_claude_accounts_add)),
        put("/api/claude-accounts/item", h!(api_claude_accounts_item)),
        post(
            "/api/claude-accounts/remove",
            h!(api_claude_accounts_remove),
        ),
        post("/api/claude-accounts/order", h!(api_claude_accounts_order)),
        post(
            "/api/claude-accounts/switch",
            h!(api_claude_accounts_switch),
        ),
        post(
            "/api/claude-accounts/refresh",
            h!(api_claude_accounts_refresh),
        ),
        post("/api/claude-accounts/reset", h!(api_claude_accounts_reset)),
        get(
            "/api/claude-accounts/history",
            h!(api_claude_accounts_history),
        ),
        get(
            "/api/claude-accounts/autoswitch",
            h!(api_claude_accounts_autoswitch_get),
        ),
        put(
            "/api/claude-accounts/autoswitch",
            h!(api_claude_accounts_autoswitch_put),
        ),
        get(
            "/api/claude-accounts/mappings",
            h!(api_claude_accounts_mappings_get),
        ),
        put(
            "/api/claude-accounts/mappings",
            h!(api_claude_accounts_mappings_put),
        ),
        get(
            "/api/claude-accounts/resolve",
            h!(api_claude_accounts_resolve),
        ),
        post(
            "/api/claude-accounts/launch",
            h!(api_claude_accounts_launch),
        ),
        get(
            "/api/claude-accounts/unclaimed",
            h!(api_claude_accounts_unclaimed),
        ),
        post(
            "/api/claude-accounts/unclaimed/remove",
            h!(api_claude_accounts_unclaimed_remove),
        ),
        // TELEGRAM_BRIDGE_SRS FR-TGB-1~5·10~11.
        get("/api/telegram", h!(api_telegram_get)),
        put("/api/telegram/token", h!(api_telegram_token)),
        put("/api/telegram/enabled", h!(api_telegram_enabled)),
        put("/api/telegram/silence", h!(api_telegram_silence)),
        post("/api/telegram/pair", h!(api_telegram_pair)),
        when(
            METHOD_DELETE,
            Matcher::Exact("/api/telegram/pair"),
            h!(api_telegram_unpair),
        ),
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
