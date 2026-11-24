//! 뷰어 쪽 URL 열기의 판정 (Go `openurl.go`, VIEWER_URL_OPEN_SRS).

use std::collections::BTreeMap;

use http::{Method, StatusCode};
use otter_shared_httpresp::{self as httpresp, Response};
use otter_webserver_apierr as apierr;
use serde::{Deserialize, Serialize};

use crate::Server;
use crate::httperr::http_err;
use crate::req::Req;

pub(crate) const OPEN_URL_ACTION: &str = "openUrl";
/// 서버와 같은 컴퓨터의 뷰어다 — 부른 셸이 연다.
pub(crate) const WHERE_LOCAL: &str = "local";
/// 다른 컴퓨터의 뷰어다 — 브라우저에 보낸다.
pub(crate) const WHERE_REMOTE: &str = "remote";
/// `local`·`viewer` 로 판정을 강제한다.
const ENV_URL_OPEN: &str = "OTTERMINAL_URL_OPEN";

#[derive(Deserialize, Default)]
#[serde(default)]
struct UrlArg {
    url: String,
}

/// Go `openURLTarget`: `args.url` 이 http·https 이고 host 가 있어야 한다.
pub(crate) fn open_url_target(raw: Option<&[u8]>) -> Result<String, String> {
    let raw = raw
        .filter(|r| !r.is_empty())
        .ok_or("openUrl: args.url 필수")?;
    let args: UrlArg =
        otter_gocompat::json::unmarshal(raw).map_err(|_| "openUrl: args 파싱 실패".to_owned())?;
    if args.url.is_empty() {
        return Err("openUrl: args.url 필수".to_owned());
    }
    let u = crate::netx::parse_url(&args.url).ok_or("openUrl: URL 파싱 실패")?;
    if u.scheme != "http" && u.scheme != "https" {
        return Err(format!("openUrl: http/https 만 허용: {}", args.url));
    }
    if u.host.is_empty() {
        return Err(format!("openUrl: host 없음: {}", args.url));
    }
    Ok(args.url)
}

/// Go `isLoopbackAddr`.
pub(crate) fn is_loopback_addr(addr: &str) -> bool {
    if addr.is_empty() {
        return false;
    }
    let host = crate::netx::split_host_port(addr).map_or(addr, |(h, _)| h);
    match host.parse::<std::net::IpAddr>() {
        Ok(ip) => ip.to_canonical().is_loopback(),
        Err(_) => host == "localhost",
    }
}

#[derive(Serialize)]
struct WhereBody {
    forced: String,
    loopback: bool,
    subscribers: usize,
    viewer: String,
    #[serde(rename = "viewerAddr")]
    viewer_addr: String,
    r#where: &'static str,
}

impl Server {
    /// Go `openURLWhere`: (판정, 실행 클라이언트).
    pub(crate) fn open_url_where(&self) -> (String, String) {
        let (cid, addr) = self.focus.executor_addr();
        if cid.is_empty() {
            return (WHERE_LOCAL.to_owned(), String::new());
        }
        match std::env::var(ENV_URL_OPEN).unwrap_or_default().as_str() {
            "local" => return (WHERE_LOCAL.to_owned(), String::new()),
            "viewer" => return (WHERE_REMOTE.to_owned(), cid),
            _ => {}
        }
        if is_loopback_addr(&addr) {
            return (WHERE_LOCAL.to_owned(), String::new());
        }
        (WHERE_REMOTE.to_owned(), cid)
    }

    /// GET /api/open-url/where (FR-VUO-19): 부작용 없는 판정 조회.
    pub(crate) async fn handle_open_url_where(&self, r: &mut Req) -> Response {
        if r.method != Method::GET {
            return http_err(
                "method not allowed",
                StatusCode::METHOD_NOT_ALLOWED,
                apierr::CODE_NOT_ALLOWED,
            );
        }
        let (w, _) = self.open_url_where();
        let (viewer, addr) = self.focus.executor_addr();
        let body = WhereBody {
            forced: std::env::var(ENV_URL_OPEN).unwrap_or_default(),
            loopback: is_loopback_addr(&addr),
            subscribers: self.focus.live_count(),
            viewer,
            viewer_addr: addr,
            r#where: if w == WHERE_LOCAL {
                WHERE_LOCAL
            } else {
                WHERE_REMOTE
            },
        };
        httpresp::json(StatusCode::OK, &body)
    }

    /// Go `broadcastFocusOwners` (focus.go).
    pub(crate) fn broadcast_focus_owners(&self) {
        if let Some(c) = self.commands() {
            let mut m = BTreeMap::new();
            m.insert(
                "owners",
                self.focus
                    .snapshot()
                    .into_iter()
                    .collect::<BTreeMap<_, _>>(),
            );
            c.broadcast(&otter_webserver_sse::payload("window_focus", Some(&m)));
        }
    }

    /// GET /api/focus.
    pub(crate) async fn api_focus_get(&self, _r: &mut Req) -> Response {
        let mut m = BTreeMap::new();
        m.insert(
            "owners",
            self.focus
                .snapshot()
                .into_iter()
                .collect::<BTreeMap<_, _>>(),
        );
        httpresp::json(StatusCode::OK, &m)
    }

    /// POST /api/focus/claim {clientId, windowId}.
    pub(crate) async fn api_focus_claim(&self, r: &mut Req) -> Response {
        #[derive(Deserialize, Default)]
        #[serde(default)]
        struct Body {
            #[serde(rename = "clientId")]
            client_id: String,
            #[serde(rename = "windowId")]
            window_id: String,
        }
        let body = match crate::httperr::read_body_http::<Body>(r).await {
            crate::httperr::BodyRead::Answered(res) => return res,
            crate::httperr::BodyRead::Ok(b) => Some(b),
            crate::httperr::BodyRead::NotJson => None,
        };
        let Some(b) = body.filter(|b| !b.client_id.is_empty() && !b.window_id.is_empty()) else {
            return http_err(
                "clientId·windowId 필요",
                StatusCode::BAD_REQUEST,
                apierr::CODE_MISSING_ARG,
            );
        };
        if self.focus.claim(&b.client_id, &b.window_id) {
            self.broadcast_focus_owners();
        }
        let mut m = BTreeMap::new();
        m.insert("ok", true);
        httpresp::json(StatusCode::OK, &m)
    }
}
