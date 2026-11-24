//! GET /api/git/blob — diff 한쪽의 원본 바이트 (M9_SRS FR-M9-21). Go `handlers_git_blob.go`.
//!
//! 그림만 내보낸다. SVG 는 `Content-Security-Policy: sandbox` 로 스크립트를 막는다.

use http::{HeaderValue, StatusCode, header};
use otter_shared_httpresp::{self as httpresp, Response};
use otter_shared_mimeprobe as mimeprobe;
use otter_webserver_apierr as apierr;
use otter_webserver_domain_git_query as query;

use crate::GitServer;
use crate::reply::{git_error, git_fail};
use crate::req::Req;

impl GitServer {
    pub(crate) async fn api_git_blob(&self, r: &mut Req) -> Response {
        let (_, root, _) = match self.git_repo_param(r).await {
            Ok(v) => v,
            Err(res) => return res,
        };
        let Some(img) = &self.images else {
            return git_fail(
                StatusCode::SERVICE_UNAVAILABLE,
                apierr::CODE_UNAVAILABLE,
                "그림 전용 git 실행기가 없다",
            );
        };
        let body = match query::side_bytes(
            img,
            &r.ctx,
            &root,
            &r.q("axis"),
            &r.q("path"),
            &r.q("origPath"),
            &r.q("oid"),
            &r.q("parentOid"),
            &r.q("side"),
        )
        .await
        {
            Ok(b) => b,
            Err(e) => return git_error(&e),
        };
        let mime = mimeprobe::image_mime(&body);
        if mime.is_empty() {
            return git_fail(
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                apierr::CODE_NOT_AN_IMAGE,
                "not an image",
            );
        }
        let len = body.len();
        let mut res = http::Response::new(httpresp::full(body));
        let h = res.headers_mut();
        if mime == mimeprobe::SVG_MIME {
            h.insert(
                header::CONTENT_SECURITY_POLICY,
                HeaderValue::from_static("sandbox"),
            );
        }
        h.insert(header::CONTENT_TYPE, HeaderValue::from_static(mime));
        h.insert(
            header::X_CONTENT_TYPE_OPTIONS,
            HeaderValue::from_static("nosniff"),
        );
        h.insert(header::CONTENT_LENGTH, HeaderValue::from(len));
        res
    }
}
