//! `/api/update` (Go `handlers_update.go`, UPDATE_NOTICE_SRS). 배지가 읽는 자리와 토글이 쓰는 자리다.
//!
//! 여기서 밖으로 나가지 않는다 (FR-UPD-8) — 읽기는 캐시만 본다. 토글은 설정 blob 이 아니다 (D-UPD-2).

use http::StatusCode;
use otter_gocompat::json;
use otter_shared_httpresp::Response;
use otter_webserver_apierr as apierr;
use serde::Deserialize;

use crate::Server;
use crate::httperr::{fail, fail_read, http_err, write_json};
use crate::req::Req;
use crate::tools_api::off_thread;

#[derive(Deserialize, Default)]
#[serde(default)]
struct UpdateToggle {
    enabled: Option<bool>,
}

fn unavailable() -> Response {
    http_err(
        "update check unavailable",
        StatusCode::SERVICE_UNAVAILABLE,
        apierr::CODE_UPDATE_UNREADY,
    )
}

impl Server {
    /// GET /api/update — 마지막 확인 결과다 (FR-UPD-7).
    pub(crate) async fn api_update_get(&self, _r: &mut Req) -> Response {
        match &self.deps.updates {
            Some(u) => write_json(&u.snapshot()),
            None => unavailable(),
        }
    }

    /// PUT /api/update — 토글이다 (FR-UPD-13·14).
    pub(crate) async fn api_update_put(&self, r: &mut Req) -> Response {
        let Some(u) = self.deps.updates.clone() else {
            return unavailable();
        };
        let body = match r.read_body(0).await {
            Ok(b) => b,
            Err(e) => return fail_read(&e),
        };
        let on = match json::unmarshal::<UpdateToggle>(&body) {
            Ok(UpdateToggle { enabled: Some(on) }) => on,
            _ => {
                return fail(
                    StatusCode::BAD_REQUEST,
                    "enabled 가 true/false 여야 합니다",
                    None,
                );
            }
        };
        let u2 = u.clone();
        match off_thread(move || u2.set_enabled(on)).await {
            Some(Ok(())) => {
                self.update_changed();
                write_json(&u.snapshot())
            }
            Some(Err(e)) => fail(
                StatusCode::INTERNAL_SERVER_ERROR,
                &format!("설정을 저장하지 못했습니다: {e}"),
                None,
            ),
            None => fail(
                StatusCode::INTERNAL_SERVER_ERROR,
                "설정을 저장하지 못했습니다",
                None,
            ),
        }
    }
}
