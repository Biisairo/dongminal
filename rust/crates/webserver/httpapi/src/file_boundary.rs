//! `/api/file/*` 의 입력 계약 (Go `file_boundary.go`, FILE_API_BOUNDARY_SRS).
//!
//! **경계는 없다** (2026-09-20, 사용자 결정). 남은 것은 입력 형식 검사뿐이다 — 빈 경로와
//! 상대경로는 이 종단이 해석할 수 없는 입력이므로 400 이다.

use dm_gocompat::filepath;
use dm_shared_httpresp::Response;
use dm_webserver_apierr as apierr;
use http::StatusCode;

use crate::Server;
use crate::httperr::http_err;

/// 판정이 거절한 까닭이다 (EDITOR_LIVE_RELOAD_SRS FR-ELR-8). 응답을 쓰지 않는다.
pub(crate) struct FileDenial {
    status: StatusCode,
    code: &'static str,
    msg: &'static str,
}

impl Server {
    /// Go `fileAllow`: 경로를 받아 그대로 돌려준다.
    pub(crate) fn file_allow(&self, p: &str) -> Result<String, FileDenial> {
        if p.is_empty() {
            return Err(FileDenial {
                status: StatusCode::BAD_REQUEST,
                code: apierr::CODE_MISSING_ARG,
                msg: "missing path",
            });
        }
        if !filepath::is_abs(p) {
            return Err(FileDenial {
                status: StatusCode::BAD_REQUEST,
                code: apierr::CODE_ABS_PATH_NEEDED,
                msg: "path must be absolute",
            });
        }
        Ok(p.to_owned())
    }

    /// Go `fileGuard`: `file_allow` 의 판정에 응답까지 붙인 꼴이다.
    pub(crate) fn file_guard(&self, p: &str) -> Result<String, Response> {
        self.file_allow(p)
            .map_err(|d| http_err(d.msg, d.status, d.code))
    }
}
