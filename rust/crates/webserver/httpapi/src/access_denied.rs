//! 차단 페이지 (Go `access_denied.go`, ACCESS_ALLOWLIST_SRS FR-ACL-11). 브라우저가 문서를 열다
//! 막혔을 때만 HTML 로 답한다 — 그 밖의 요청은 평문 403 이다.

use dm_shared_httpresp::{self as httpresp, Response};
use dm_webserver_apierr as apierr;
use http::{HeaderValue, StatusCode, header};

use crate::req::Req;

/// 문서 CSP 의 공통 꼬리다 (Go `static.go` 의 `cspRest`). 정적 자산 처리기(5.5.8)도 쓴다.
pub(crate) const CSP_REST: &str = "style-src 'self' 'unsafe-inline'; \
font-src 'self' data:; \
img-src 'self' data: blob:; \
connect-src 'self' ws: wss:; \
worker-src 'self' blob:; \
frame-ancestors 'none'; \
base-uri 'self'; \
form-action 'self'";

const DENIED_HEAD: &str = include_str!("denied_head.html");
const DENIED_TAIL: &str = include_str!("denied_tail.html");

/// Go `wantsDeniedPage`: WebSocket 은 아니고, 문서 탐색이거나 HTML 을 받겠다는 요청이다.
pub(crate) fn wants_denied_page(r: &Req) -> bool {
    if r.header("Upgrade").eq_ignore_ascii_case("websocket") {
        return false;
    }
    let mode = r.header("Sec-Fetch-Mode");
    if mode.eq_ignore_ascii_case("websocket") {
        return false;
    }
    if mode.eq_ignore_ascii_case("navigate") {
        return true;
    }
    r.header("Accept").contains("text/html")
}

/// Go `writeDeniedPage`.
pub(crate) fn write_denied_page(ip: &str) -> Response {
    let mut res = http::Response::new(httpresp::full(denied_page_html(ip)));
    *res.status_mut() = StatusCode::FORBIDDEN;
    let h = res.headers_mut();
    h.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/html; charset=utf-8"),
    );
    if let Ok(v) = HeaderValue::from_str(&format!(
        "default-src 'self'; script-src 'self'; {CSP_REST}"
    )) {
        h.insert(header::CONTENT_SECURITY_POLICY, v);
    }
    h.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    h.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    h.insert(
        httpresp::CODE_HEADER,
        HeaderValue::from_static(apierr::CODE_FORBIDDEN),
    );
    res
}

/// Go `deniedPageHTML`.
pub(crate) fn denied_page_html(ip: &str) -> String {
    let shown = if ip.trim().is_empty() {
        "(알 수 없음)"
    } else {
        ip
    };
    format!("{DENIED_HEAD}{}{DENIED_TAIL}", html_escape(shown))
}

/// Go `html.EscapeString`.
pub(crate) fn html_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '&' => out.push_str("&amp;"),
            '\'' => out.push_str("&#39;"),
            '"' => out.push_str("&#34;"),
            _ => out.push(c),
        }
    }
    out
}
