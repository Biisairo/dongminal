//! `GET /api/health` (Go `handlers_health.go`, VERSION_HEALTH_SRS 묶음 H).
//!
//! 생존이 아니라 어긋남을 답한다. 언제나 200 이다 (FR-VHL-12). 이미 메모리에 있는 값만 읽는다
//! (NFR-VHL-1·2).

use dm_shared_httpresp::{self as httpresp, Response};
use http::StatusCode;
use serde::Serialize;

use crate::Server;
use crate::req::Req;
use crate::tools_api::off_thread;

/// 데몬 쪽 사실이다 (FR-VHL-10). `protocol`·`build` 는 데몬이 말한 것이다.
#[derive(Serialize, Default)]
struct HealthDaemon {
    connected: bool,
    protocol: i64,
    build: String,
    /// 양쪽 빌드를 알고 서로 다를 때만 참이다 (FR-VHL-11).
    mismatch: bool,
}

#[derive(Serialize, Default)]
struct HealthWorkspace {
    rev: u64,
    #[serde(rename = "lastPersistErr")]
    last_persist_err: String,
    #[serde(rename = "lastLoadErr")]
    last_load_err: String,
}

#[derive(Serialize, Default)]
struct HealthBody {
    version: String,
    uptime: i64,
    daemon: HealthDaemon,
    workspace: HealthWorkspace,
    tools: i64,
}

impl Server {
    /// GET /api/health.
    pub(crate) async fn api_health(&self, _r: &mut Req) -> Response {
        let mut out = HealthBody {
            version: self.cfg.version.clone(),
            uptime: i64::try_from(self.started.elapsed().as_secs()).unwrap_or(i64::MAX),
            ..HealthBody::default()
        };
        let hub = self.tools(None);
        let work = self.deps.work.clone();
        let version = out.version.clone();
        let facts = off_thread(move || {
            let tools = hub.map(|t| {
                let n = i64::try_from(t.list().len()).unwrap_or(i64::MAX);
                let info = t.daemon_info();
                let mismatch =
                    !info.build.is_empty() && !version.is_empty() && info.build != version;
                (
                    n,
                    HealthDaemon {
                        connected: t.connected(),
                        protocol: info.protocol,
                        build: info.build,
                        mismatch,
                    },
                )
            });
            let ws = work.map(|w| HealthWorkspace {
                rev: w.current_rev(),
                last_load_err: w.load_err(),
                last_persist_err: w.persist_err(),
            });
            (tools, ws)
        })
        .await;
        if let Some((tools, ws)) = facts {
            if let Some((n, d)) = tools {
                out.tools = n;
                out.daemon = d;
            }
            if let Some(ws) = ws {
                out.workspace = ws;
            }
        }
        httpresp::json(StatusCode::OK, &out)
    }
}
