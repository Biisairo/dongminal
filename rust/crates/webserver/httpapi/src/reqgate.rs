//! 출처 게이트 (Go `reqgate.go`, REQUEST_GATE_SRS). "어느 출처인가" 를 `Host`·`Origin`·
//! `Sec-Fetch-Site`·`Content-Type` 으로 가른다. 접근 게이트(출발지 IP) 안쪽에 선다.

use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};

use http::{Method, StatusCode};
use otter_shared_httpresp::Response;
use otter_shared_otterlog::infof;
use otter_webserver_apierr as apierr;

use crate::access::{AccessStore, go_trim_space};
use crate::httperr::http_err;
use crate::netx;
use crate::req::Req;

/// 출처 게이트가 거절한 수다 (Go `requestDenies`, `/api/diag` 가 읽는다).
pub(crate) static REQUEST_DENIES: AtomicI64 = AtomicI64::new(0);

/// `Host`·`Origin` 판정의 허용 집합이다 (Go `hostAllow`).
pub(crate) struct HostAllow {
    store: Option<Arc<AccessStore>>,
    extra: Vec<String>,
    /// 이 기계의 호스트명(소문자, 끝 점 없음). 모르면 비어 있다.
    pub(crate) hostname: String,
}

impl HostAllow {
    pub(crate) fn new(store: Option<Arc<AccessStore>>, extra: Vec<String>) -> HostAllow {
        let hostname = otter_shared_platform::hostname()
            .map(|n| n.strip_suffix('.').unwrap_or(&n).to_lowercase())
            .unwrap_or_default();
        HostAllow {
            store,
            extra,
            hostname,
        }
    }

    /// Go `ok`: 정규화한 호스트 이름이 허용되는가.
    pub(crate) fn ok(&self, host: &str) -> bool {
        if host.is_empty() {
            return false;
        }
        if matches!(host, "localhost" | "127.0.0.1" | "::1" | "0.0.0.0" | "::") {
            return true;
        }
        if !self.hostname.is_empty()
            && (host == self.hostname || host == format!("{}.local", self.hostname))
        {
            return true;
        }
        if let Some(a) = netx::parse_addr(host) {
            if a.is_loopback() {
                return true;
            }
            if self.store.as_ref().is_some_and(|s| s.is_self(&a)) {
                return true;
            }
        }
        if self.extra.iter().any(|e| match_host_pattern(e, host)) {
            return true;
        }
        self.store.as_ref().is_some_and(|s| s.has_host_alias(host))
    }
}

/// Go `normalizeHost`: `Host` 헤더나 `Origin` 에서 이름만 꺼낸다(포트·대괄호·끝 점을 떼고 소문자).
pub(crate) fn normalize_host(raw: &str) -> String {
    let raw = go_trim_space(raw);
    if raw.is_empty() {
        return String::new();
    }
    let mut host = raw.to_owned();
    if raw.contains("://") {
        match netx::parse_url(raw) {
            Some(u) => host = u.host,
            None => return String::new(),
        }
    }
    if let Some((h, _)) = netx::split_host_port(&host) {
        host = h.to_owned();
    }
    let h = host.strip_prefix('[').unwrap_or(&host);
    let h = h.strip_suffix(']').unwrap_or(h);
    h.strip_suffix('.').unwrap_or(h).to_lowercase()
}

/// Go `sameAuthority`: `Origin` 이 요청의 `Host` 와 같은 이름·포트인가. 기본 포트를 추론하지 않는다.
pub(crate) fn same_authority(origin: &str, host: &str) -> bool {
    if host.is_empty() {
        return false;
    }
    let Some(u) = netx::parse_url(go_trim_space(origin)) else {
        return false;
    };
    if (u.scheme != "http" && u.scheme != "https") || u.host.is_empty() {
        return false;
    }
    let (hh, hp) = netx::split_host_port(host).unwrap_or((host, ""));
    normalize_host(u.hostname()) == normalize_host(hh) && u.port() == hp
}

/// Go `matchHostPattern`: `*.` 접미사 와일드카드 하나만 안다.
fn match_host_pattern(pattern: &str, host: &str) -> bool {
    let p = go_trim_space(pattern).to_lowercase();
    if p.is_empty() {
        return false;
    }
    match p.strip_prefix("*.") {
        Some(suffix) => host.ends_with(&format!(".{suffix}")),
        None => p == host,
    }
}

/// Go `gateExempt`: 문서·자산 GET 과 `/api/ping` 은 게이트를 지나지 않는다.
pub(crate) fn gate_exempt(method: &Method, path: &str) -> bool {
    if method != Method::GET && method != Method::HEAD {
        return false;
    }
    if path == "/api/ping" {
        return true;
    }
    !path.starts_with("/api/") && path != "/ws" && path != "/channel"
}

fn is_state_changing(method: &Method) -> bool {
    matches!(
        *method,
        Method::POST | Method::PUT | Method::PATCH | Method::DELETE
    )
}

/// Go `requestGate` 의 판정. 거절이면 응답을 돌려준다.
pub(crate) fn request_gate(allow: &HostAllow, r: &Req) -> Option<Response> {
    if gate_exempt(&r.method, &r.path) {
        return None;
    }
    if !r.host.is_empty() && !allow.ok(&normalize_host(&r.host)) {
        return Some(gate_deny(
            r,
            StatusCode::MISDIRECTED_REQUEST,
            "host",
            "허용되지 않은 Host 입니다 — 설정 ▸ 접속 의 '이 컴퓨터의 별명' 에 이 이름을 추가하세요",
        ));
    }
    let origin = r.header("Origin");
    if !origin.is_empty() {
        if !allow.ok(&normalize_host(&origin)) {
            return Some(gate_deny(r, StatusCode::FORBIDDEN, "origin", "forbidden"));
        }
        if !same_authority(&origin, &r.host) {
            return Some(gate_deny(
                r,
                StatusCode::FORBIDDEN,
                "origin-authority",
                "forbidden",
            ));
        }
    }
    if !is_state_changing(&r.method) {
        return None;
    }
    match r.header("Sec-Fetch-Site").as_str() {
        "" | "same-origin" | "same-site" | "none" => {}
        _ => {
            return Some(gate_deny(
                r,
                StatusCode::FORBIDDEN,
                "sec-fetch-site",
                "forbidden",
            ));
        }
    }
    if !gate_content_type_ok(&r.header("Content-Type")) {
        return Some(gate_deny(
            r,
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "content-type",
            "application/json 또는 multipart/form-data 여야 합니다",
        ));
    }
    None
}

fn gate_content_type_ok(ct: &str) -> bool {
    let ct = ct.split(';').next().unwrap_or_default();
    matches!(
        go_trim_space(ct).to_lowercase().as_str(),
        "application/json" | "multipart/form-data"
    )
}

fn gate_deny(r: &Req, code: StatusCode, why: &str, msg: &str) -> Response {
    REQUEST_DENIES.fetch_add(1, Ordering::Relaxed);
    infof!(
        r.rid(),
        "request denied why={why} addr={} host={} origin={} {} {}",
        r.remote_addr,
        otter_gocompat::strconv::quote(&r.host),
        otter_gocompat::strconv::quote(&r.header("Origin")),
        r.method,
        r.path
    );
    let code_name = if why == "host" {
        apierr::CODE_HOST_REJECTED
    } else {
        apierr::CODE_FORBIDDEN
    };
    http_err(msg, code, code_name)
}
