//! `GET /api/diag` — 기계가 읽는 자리다 (Go `handlers_diag.go`, OBSERVABILITY_SRS 묶음 D).
//!
//! 개별 식별 정보(주소·경로·도구 이름·작업 폴더)를 싣지 않는다 (FR-OBS-13 / D-OBS-5). 거절 계수는
//! 게이트가 올리는 프로세스 전역 값이다 (`access_api::ACCESS_DENIES`·`reqgate::REQUEST_DENIES`).

use std::sync::atomic::Ordering;

use dm_shared_httpresp::Response;
use serde::Serialize;

use crate::Server;
use crate::access_api::ACCESS_DENIES;
use crate::httperr::write_json;
use crate::req::Req;
use crate::reqgate::REQUEST_DENIES;
use crate::tools_api::off_thread;

#[derive(Serialize)]
struct DiagGate {
    access: i64,
    request: i64,
}

#[derive(Serialize)]
struct DiagBody {
    tools: usize,
    ws: i64,
    goroutines: usize,
    #[serde(rename = "allocMB")]
    alloc_mb: u64,
    #[serde(rename = "persistErr")]
    persist_err: String,
    gate: DiagGate,
    reconnects: i64,
    uptime: i64,
    version: String,
    #[serde(rename = "logLevel")]
    log_level: String,
}

/// Go `runtime.NumGoroutine` 의 자리다 — 살아 있는 tokio task 수다. 런타임 밖이면 0 이다.
pub(crate) fn live_tasks() -> usize {
    tokio::runtime::Handle::try_current().map_or(0, |h| h.metrics().num_alive_tasks())
}

/// Go `MemStats.Alloc` 의 MiB 자리다. Rust 에는 GC 힙 계수가 없어 0 이다.
pub(crate) fn alloc_mb() -> u64 {
    0
}

impl Server {
    /// GET /api/diag.
    pub(crate) async fn api_diag(&self, _r: &mut Req) -> Response {
        let mut out = DiagBody {
            tools: 0,
            ws: self.conn.ws_open.load(Ordering::Relaxed),
            goroutines: live_tasks(),
            alloc_mb: alloc_mb(),
            persist_err: String::new(),
            gate: DiagGate {
                access: ACCESS_DENIES.load(Ordering::Relaxed),
                request: REQUEST_DENIES.load(Ordering::Relaxed),
            },
            reconnects: 0,
            uptime: i64::try_from(self.started.elapsed().as_secs()).unwrap_or(i64::MAX),
            version: self.cfg.version.clone(),
            log_level: dm_shared_dmlog::level().to_owned(),
        };
        if let Some(t) = self.deps.tools.clone() {
            // 수만 센다. 목록의 내용(이름·작업 폴더)은 나가지 않는다.
            if let Some((n, rc)) = off_thread(move || (t.list().len(), t.reconnects())).await {
                out.tools = n;
                out.reconnects = rc;
            }
        }
        if let Some(w) = self.work() {
            out.persist_err = w.persist_err();
        }
        write_json(&out)
    }
}
