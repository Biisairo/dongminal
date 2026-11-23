//! `GET /api/whoami` (Go `handlers_whoami.go`, DMCTL_WHO_AM_I_SRS FR-API-WAI-1).
//!
//! 호출자의 TCP 출발 포트 → clientPID → 도구(부모 사슬)를 주입된 해석기로 찾고, 워크스페이스 항목과
//! 터미널 크기를 덧붙인다. `?toolId=` 가 오면(데몬 모드) 그 도구가 있는지만 본다.

use dm_shared_httpresp::{self as httpresp, Response};
use dm_webserver_apierr as apierr;
use http::StatusCode;
use serde::Serialize;

use crate::Server;
use crate::httperr::{http_err, write_tool_io_error};
use crate::req::Req;
use crate::tools_api::off_thread;

/// Go 의 `map[string]any` 응답이다 — 키는 바이트 순이다.
#[derive(Serialize, Default)]
struct WhoAmI {
    focused: bool,
    label: String,
    /// 열린 Run 의 멤버이면 그 정체다 (ISSUE_TREE_OPS_SRS FR-ITB-6).
    #[serde(skip_serializing_if = "Option::is_none")]
    member: Option<WhoMember>,
    #[serde(rename = "paneUuid")]
    pane_uuid: String,
    #[serde(rename = "shellPid")]
    shell_pid: i64,
    short: String,
    #[serde(rename = "sizeCols")]
    size_cols: i64,
    #[serde(rename = "sizeRows")]
    size_rows: i64,
    tab: String,
    #[serde(rename = "toolId")]
    tool_id: String,
    uuid: String,
    window: String,
    #[serde(rename = "windowUuid")]
    window_uuid: String,
}

/// Go 의 `map[string]any{"id","runId","role"[,"tree"]}` — 키는 바이트 순이다.
#[derive(Serialize)]
struct WhoMember {
    id: String,
    role: String,
    #[serde(rename = "runId")]
    run_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    tree: Option<String>,
}

impl Server {
    /// GET /api/whoami.
    pub(crate) async fn api_who_am_i(&self, r: &mut Req) -> Response {
        let mut tool_id = r.q("toolId");
        let mut shell_pid = 0;
        if !tool_id.is_empty() {
            if let Some(t) = self.tools(Some(r)) {
                let id = tool_id.clone();
                if off_thread(move || t.get(&id)).await.flatten().is_none() {
                    return write_tool_io_error(
                        StatusCode::NOT_FOUND,
                        &format!("tool not found: {tool_id}"),
                    );
                }
            }
        } else if let Some(who) = self.deps.who_am_i.clone() {
            let addr = r.remote_addr.clone();
            let res = off_thread(move || who.resolve_client_pane(&addr).map_err(|e| e.to_string()))
                .await
                .unwrap_or_else(|| Err("whoami canceled".to_owned()));
            match res {
                Ok((id, pid)) => (tool_id, shell_pid) = (id, pid),
                Err(e) => return write_tool_io_error(StatusCode::NOT_FOUND, &e),
            }
        } else {
            return http_err(
                "whoami unavailable",
                StatusCode::INTERNAL_SERVER_ERROR,
                apierr::CODE_INTERNAL,
            );
        }
        let mut resp = WhoAmI {
            tool_id,
            shell_pid,
            ..WhoAmI::default()
        };
        let hub = self.tools(Some(r));
        let work = self.deps.work.clone();
        let id = resp.tool_id.clone();
        let found = off_thread(move || {
            let size = hub.and_then(|t| t.list().into_iter().find(|p| p.id == id));
            let entry = work.and_then(|w| w.entries().into_iter().find(|e| e.tool_id == id));
            (size, entry)
        })
        .await;
        if let Some((size, entry)) = found {
            if let Some(p) = size {
                resp.size_cols = p.cols;
                resp.size_rows = p.rows;
            }
            if let Some(e) = entry {
                resp.label = e.label;
                resp.uuid = e.tab_uuid;
                resp.short = e.short_code;
                resp.window = e.window_name;
                resp.tab = e.tab_name;
                resp.window_uuid = e.window_uuid;
                resp.pane_uuid = e.pane_uuid;
                resp.focused = e.is_active;
            }
        }
        // FR-ITB-6: migration 이 이 값을 보고 승계 갈래로 간다.
        if let Some(runs) = &self.deps.runs
            && let Some(m) = runs.member_by_tool(&resp.tool_id)
        {
            let tree = runs
                .get(&m.run_id)
                .map(|rec| rec.tree)
                .filter(|t| !t.is_empty());
            resp.member = Some(WhoMember {
                id: m.id,
                role: m.role,
                run_id: m.run_id,
                tree,
            });
        }
        httpresp::json(StatusCode::OK, &resp)
    }
}
