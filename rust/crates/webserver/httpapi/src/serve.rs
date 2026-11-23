//! 요청 하나의 길 (Go `Server.Handler` 의 미들웨어 사슬과 `http.ServeMux`, `handleAPI`).
//!
//! 순서가 계약이다: 요청 ID → 접근 로그 → 접근 게이트(출발지) → 출처 게이트 → 패닉 그물 → mux.
//! 요청 ID 가 맨 바깥이라 거절된 요청에도 ID 가 있다 (D-OBS-2).

use std::future::Future;
use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use bytes::Bytes;
use dm_gocompat::neturl;
use dm_shared_dmlog::{errorf, infof};
use dm_shared_httpreq::BoxError;
use dm_shared_httpresp::{self as httpresp, Response};
use dm_webserver_apierr as apierr;
use http::{HeaderValue, Method, StatusCode, header};
use http_body_util::BodyExt;
use hyper::body::Body;

use crate::Server;
use crate::access_api::access_gate;
use crate::access_denied::html_escape;
use crate::httperr::http_err;
use crate::req::{BodyError, Handler, Req, ReqBody};
use crate::reqgate::request_gate;
use crate::routes::API_ROUTES;

/// `/api/git/*` 처리기 (Go `gitapi.GitServer.Handle`). `None` 이면 처리하지 않은 것이다 — 404 다.
pub trait GitHandler: Send + Sync {
    fn handle(
        &self,
        req: http::Request<ReqBody>,
        req_id: Option<String>,
    ) -> Pin<Box<dyn Future<Output = Option<Response>> + Send + '_>>;
}

/// mux 의 패턴 (Go `ServeMux` 의 메서드 없는 패턴).
#[derive(Clone, Copy)]
#[allow(dead_code)]
pub(crate) enum Pattern {
    /// `/ws` 처럼 정확히 같은 경로.
    Exact(&'static str),
    /// `/api/` 처럼 `/` 로 끝나 그 아래 전부.
    Tree(&'static str),
}

/// 서버의 mux 표다 (Go `Handler` 의 `mux.HandleFunc` 들). 하위 이슈가 자기 종단을 더한다.
pub(crate) fn mux_table() -> Vec<(Pattern, Handler)> {
    vec![(Pattern::Tree("/api/"), handle_api_entry as Handler)]
}

fn handle_api_entry<'a>(s: &'a Server, r: &'a mut Req) -> crate::req::BoxFut<'a, Response> {
    Box::pin(s.handle_api(r))
}

/// 응답을 기다리던 쪽이 떠나면 요청 문맥을 취소한다 (Go 가 끊긴 요청의 ctx 를 끝내는 것).
struct CancelOnDrop(tokio_util::sync::CancellationToken);

impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.cancel();
    }
}

impl Server {
    /// 요청 하나를 처리한다. 합성 루트(5.5.8 `Run`)가 연결마다 부른다.
    pub async fn serve<B>(self: &Arc<Self>, req: http::Request<B>, remote: SocketAddr) -> Response
    where
        B: Body<Data = Bytes> + Send + 'static,
        B::Error: Into<BoxError>,
    {
        self.serve_addr(req, remote_addr_string(remote)).await
    }

    pub(crate) async fn serve_addr<B>(
        self: &Arc<Self>,
        req: http::Request<B>,
        remote_addr: String,
    ) -> Response
    where
        B: Body<Data = Bytes> + Send + 'static,
        B::Error: Into<BoxError>,
    {
        // Go 서버는 경로의 퍼센트 인코딩이 틀린 요청을 핸들러 전에 400 으로 끝낸다.
        let Ok(decoded) = neturl::path_unescape(req.uri().path()) else {
            return bad_request();
        };
        let path = String::from_utf8_lossy(&decoded).into_owned();
        let host = request_host(&req);
        let (parts, body) = req.into_parts();
        let hdr_id = parts
            .headers
            .get(dm_shared_dmlog::REQ_ID_HEADER)
            .map(|v| String::from_utf8_lossy(v.as_bytes()).into_owned())
            .unwrap_or_default();
        let mut id = dm_shared_dmlog::sanitize_req_id(&hdr_id).to_owned();
        if id.is_empty() {
            id = dm_shared_dmlog::new_req_id();
        }
        let body = body
            .map_err(|e| BodyError(Into::<BoxError>::into(e).to_string()))
            .boxed_unsync();
        let r = Req::new(
            parts.method,
            path,
            parts.uri,
            parts.headers,
            host,
            remote_addr,
            parts.extensions,
            body,
            Some(id.clone()),
        );
        let mut res = self.logged(r).await;
        if let Ok(v) = HeaderValue::from_str(&id) {
            res.headers_mut().insert(dm_shared_dmlog::REQ_ID_HEADER, v);
        }
        res
    }

    /// Go `loggingMiddlewareFor`.
    async fn logged(self: &Arc<Self>, r: Req) -> Response {
        let start = Instant::now();
        self.conn.last_req.store(unix_nanos(), Ordering::Relaxed);
        let (method, path, addr, rid) = (
            r.method.clone(),
            r.path.clone(),
            r.remote_addr.clone(),
            r.rid().map(str::to_owned),
        );
        let res = finish(self.gated(r).await).await;
        // 업그레이드는 Go 에서 하이재킹이라 기록되는 상태가 200 이다.
        let status = match res.status() {
            StatusCode::SWITCHING_PROTOCOLS => 200,
            s => s.as_u16(),
        };
        if should_log_request(&path, status) {
            infof!(
                rid.as_deref(),
                "http {method} {path} {status} {} addr={addr}",
                dm_gocompat::time::format_std_duration(round_ms(start.elapsed()))
            );
        }
        res
    }

    /// 두 게이트(Go `accessGate`·`requestGate`)와 패닉 그물.
    async fn gated(self: &Arc<Self>, r: Req) -> Response {
        if let Some(res) = access_gate(self.access.as_ref(), &r) {
            return res;
        }
        if let Some(res) = request_gate(&self.hosts, &r) {
            return res;
        }
        self.recovered(r).await
    }

    /// Go `recoverMiddleware`: 핸들러는 따로 task 로 돈다. 패닉이면 기록하고 500 이다
    /// (NFR-RSP-2). 응답을 기다리던 쪽이 떠나도 핸들러는 끝까지 가고 문맥만 취소된다.
    async fn recovered(self: &Arc<Self>, mut r: Req) -> Response {
        let (method, path) = (r.method.clone(), r.path.clone());
        let _cancel = CancelOnDrop(r.ctx.clone());
        let me = Arc::clone(self);
        let task = tokio::spawn(async move { me.mux(&mut r).await });
        match task.await {
            Ok(res) => res,
            Err(e) if e.is_panic() => {
                let p = e.into_panic();
                let msg = p
                    .downcast_ref::<&str>()
                    .map(|s| (*s).to_owned())
                    .or_else(|| p.downcast_ref::<String>().cloned())
                    .unwrap_or_default();
                errorf!(
                    None,
                    "http panic {method} {path}: {msg}\n{}",
                    std::backtrace::Backtrace::force_capture()
                );
                http_err(
                    "internal error",
                    StatusCode::INTERNAL_SERVER_ERROR,
                    apierr::CODE_INTERNAL,
                )
            }
            Err(_) => http_err(
                "internal error",
                StatusCode::INTERNAL_SERVER_ERROR,
                apierr::CODE_INTERNAL,
            ),
        }
    }

    /// Go `http.ServeMux`: 정리되지 않은 경로는 307 로 보내고, 가장 구체적인 패턴을 고른다.
    async fn mux(&self, r: &mut Req) -> Response {
        let escaped = escaped_path(r.uri.path(), &r.path);
        if r.method != Method::CONNECT {
            let cleaned = clean_path(&escaped);
            if cleaned != escaped {
                return redirect(&r.method, &with_query(&cleaned, &r.raw_query));
            }
        }
        let segs = segments(&escaped);
        let table = mux_table();
        let mut best: Option<(usize, Handler)> = None;
        let mut tree_redirect = false;
        for (pat, h) in &table {
            match *pat {
                Pattern::Exact(p) => {
                    if segs_eq(&segs, p) {
                        best = Some((usize::MAX, *h));
                    }
                }
                Pattern::Tree(p) => {
                    let base = p.trim_end_matches('/');
                    if tree_contains(&segs, &escaped, base) {
                        let len = p.len();
                        if best.is_none_or(|(l, _)| l < len) {
                            best = Some((len, *h));
                        }
                    } else if !escaped.ends_with('/') && segs_eq(&segs, base) {
                        tree_redirect = true;
                    }
                }
            }
        }
        match best {
            Some((usize::MAX, h)) => h(self, r).await,
            _ if tree_redirect => {
                redirect(&r.method, &with_query(&format!("{escaped}/"), &r.raw_query))
            }
            Some((_, h)) => h(self, r).await,
            None => httpresp::http_error(StatusCode::NOT_FOUND, "404 page not found"),
        }
    }

    /// Go `handleAPI`: git 표면은 표를 훑지 않고 곧바로 넘긴다 (FR-OPT-8-2).
    pub(crate) async fn handle_api(&self, r: &mut Req) -> Response {
        if r.path.starts_with("/api/git/") {
            if let Some(git) = &self.deps.git {
                let mut b = http::Request::builder()
                    .method(r.method.clone())
                    .uri(r.uri.clone());
                if let Some(h) = b.headers_mut() {
                    *h = r.headers.clone();
                }
                if let Ok(req) = b.body(r.take_body())
                    && let Some(res) = git.handle(req, r.rid().map(str::to_owned)).await
                {
                    return res;
                }
            }
        } else if let Some(h) =
            dm_webserver_httproute::dispatch(&API_ROUTES, r.method.as_str(), &r.path)
        {
            return h(self, r).await;
        }
        http_err("not found", StatusCode::NOT_FOUND, apierr::CODE_NOT_FOUND)
    }

    /// GET·POST… /api/ping.
    pub(crate) async fn api_ping(&self, _r: &mut Req) -> Response {
        let mut res = http::Response::new(httpresp::full("ok"));
        res.headers_mut().insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static(httpresp::CONTENT_TYPE_TEXT),
        );
        res
    }
}

/// Go `shouldLogRequest`: 실패는 늘 남기고, 잦은 폴링 경로의 성공은 뺀다.
pub(crate) fn should_log_request(path: &str, status: u16) -> bool {
    if status >= 400 {
        return true;
    }
    if path == "/api/ping" || path == "/api/stats" {
        return false;
    }
    !(path.starts_with("/api/workspace") || path.starts_with("/api/tools"))
}

/// Go `Duration.Round(time.Millisecond)`.
fn round_ms(d: Duration) -> Duration {
    let ms = (d.as_nanos() + 500_000) / 1_000_000;
    Duration::from_millis(u64::try_from(ms).unwrap_or(u64::MAX))
}

fn unix_nanos() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| i64::try_from(d.as_nanos()).unwrap_or(i64::MAX))
        .unwrap_or_default()
}

/// Go `r.RemoteAddr` 의 모양(`ip:port`, IPv6 는 대괄호).
fn remote_addr_string(a: SocketAddr) -> String {
    a.to_string()
}

/// Go `r.Host`: 절대 형식 요청 대상이면 그 authority, 아니면 `Host` 헤더다.
fn request_host<B>(req: &http::Request<B>) -> String {
    if let Some(a) = req.uri().authority() {
        return a.as_str().to_owned();
    }
    req.headers()
        .get(header::HOST)
        .map(|v| String::from_utf8_lossy(v.as_bytes()).into_owned())
        .unwrap_or_default()
}

/// Go 서버가 요청 줄을 해석하지 못했을 때 쓰는 응답이다.
fn bad_request() -> Response {
    let mut res = http::Response::new(httpresp::full("400 Bad Request"));
    *res.status_mut() = StatusCode::BAD_REQUEST;
    let h = res.headers_mut();
    h.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static(httpresp::CONTENT_TYPE_TEXT),
    );
    h.insert(header::CONNECTION, HeaderValue::from_static("close"));
    res
}

/// Go 서버의 응답 마무리: `Content-Type` 이 없는 본문은 앞 512바이트로 짐작한다
/// (`http.DetectContentType`). 크기를 아는 본문만 본다 — 흐르는 본문은 핸들러가 형식을 정한다.
async fn finish(res: Response) -> Response {
    let st = res.status();
    if res.headers().contains_key(header::CONTENT_TYPE)
        || st.is_informational()
        || st == StatusCode::NO_CONTENT
        || st == StatusCode::NOT_MODIFIED
    {
        return res;
    }
    match res.body().size_hint().exact() {
        Some(n) if n > 0 => {}
        _ => return res,
    }
    let (mut parts, body) = res.into_parts();
    let Ok(c) = body.collect().await else {
        return http::Response::from_parts(parts, httpresp::empty());
    };
    let b = c.to_bytes();
    let n = b.len().min(dm_shared_mimeprobe::SNIFF_LEN);
    if let Ok(v) = HeaderValue::from_str(dm_shared_mimeprobe::detect_content_type(&b[..n])) {
        parts.headers.insert(header::CONTENT_TYPE, v);
    }
    http::Response::from_parts(parts, httpresp::full(b))
}

/// Go `http.Redirect(w, r, url, 307)`. 본문은 `Fprintln` 이라 줄바꿈이 둘이다.
fn redirect(method: &Method, loc: &str) -> Response {
    let body = if method == Method::GET {
        format!(
            "<a href=\"{}\">Temporary Redirect</a>.\n\n",
            html_escape(loc)
        )
    } else {
        String::new()
    };
    let mut res = http::Response::new(httpresp::full(body));
    *res.status_mut() = StatusCode::TEMPORARY_REDIRECT;
    if let Ok(v) = HeaderValue::from_str(loc) {
        res.headers_mut().insert(header::LOCATION, v);
    }
    if method == Method::GET || method == Method::HEAD {
        res.headers_mut().insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("text/html; charset=utf-8"),
        );
    }
    res
}

fn with_query(path: &str, raw_query: &str) -> String {
    if raw_query.is_empty() {
        path.to_owned()
    } else {
        format!("{path}?{raw_query}")
    }
}

/// Go `cleanPath`: `path.Clean` 하되 끝 `/` 는 살린다.
pub(crate) fn clean_path(p: &str) -> String {
    if p.is_empty() {
        return "/".to_owned();
    }
    let p = if p.starts_with('/') {
        p.to_owned()
    } else {
        format!("/{p}")
    };
    let mut np = dm_gocompat::path::clean(&p);
    if p.ends_with('/') && np != "/" {
        if p.len() == np.len() + 1 && p.starts_with(&np) {
            np = p;
        } else {
            np.push('/');
        }
    }
    np
}

/// Go `URL.EscapedPath`: 원래 인코딩이 유효하면 그대로, 아니면 다시 인코딩한다.
pub(crate) fn escaped_path(raw: &str, decoded: &str) -> String {
    if valid_encoded_path(raw) && neturl::path_unescape(raw).is_ok_and(|d| d == decoded.as_bytes())
    {
        return raw.to_owned();
    }
    let mut out = String::with_capacity(decoded.len());
    for &c in decoded.as_bytes() {
        if should_escape_path(c) {
            out.push_str(&format!("%{c:02X}"));
        } else {
            out.push(char::from(c));
        }
    }
    out
}

fn valid_encoded_path(s: &str) -> bool {
    s.bytes().all(|c| {
        matches!(
            c,
            b'!' | b'$'
                | b'&'
                | b'\''
                | b'('
                | b')'
                | b'*'
                | b'+'
                | b','
                | b';'
                | b'='
                | b':'
                | b'@'
                | b'['
                | b']'
                | b'%'
        ) || !should_escape_path(c)
    })
}

/// Go `shouldEscape(c, encodePath)`.
fn should_escape_path(c: u8) -> bool {
    if c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_' | b'.' | b'~') {
        return false;
    }
    !matches!(
        c,
        b'$' | b'&' | b'+' | b',' | b'/' | b':' | b';' | b'=' | b'@'
    )
}

/// 인코딩된 경로의 조각들을 각각 푼다 — `%2F` 는 조각 안의 글자로 남는다.
fn segments(escaped: &str) -> Vec<String> {
    escaped
        .split('/')
        .skip(1)
        .map(|s| {
            neturl::path_unescape(s)
                .map(|b| String::from_utf8_lossy(&b).into_owned())
                .unwrap_or_else(|_| s.to_owned())
        })
        .collect()
}

fn segs_eq(segs: &[String], pattern: &str) -> bool {
    let p: Vec<&str> = pattern.split('/').skip(1).collect();
    segs.len() == p.len() && segs.iter().zip(&p).all(|(a, b)| a == b)
}

/// 패턴 `<base>/` 가 경로를 덮는가. `base` 가 비면 `/` 패턴이라 모두 덮는다.
fn tree_contains(segs: &[String], escaped: &str, base: &str) -> bool {
    let p: Vec<&str> = if base.is_empty() {
        Vec::new()
    } else {
        base.split('/').skip(1).collect()
    };
    if segs.len() < p.len() || !segs.iter().zip(&p).all(|(a, b)| a == b) {
        return false;
    }
    segs.len() > p.len() || (p.is_empty() && escaped == "/")
}
