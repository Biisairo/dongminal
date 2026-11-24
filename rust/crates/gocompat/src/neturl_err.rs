//! Go `net/http` 클라이언트 오류 문구 (`*url.Error` 와 본문 읽기 오류). 기준선은 go1.27.2 실측이다.
//!
//! - 요청 오류: [`UrlError::from_reqwest`] → `Get "https://x/y": dial tcp 127.0.0.1:1: connect: connection refused`
//! - 본문 읽기 오류: [`body_error`] → `unexpected EOF`. Go 는 본문 오류를 `*url.Error` 로 감싸지 않는다.

use std::error::Error as StdError;
use std::fmt;
use std::io;
use std::net::{IpAddr, ToSocketAddrs};

use crate::oserr;
use crate::strconv::quote;

/// Go `http.Client` 의 리다이렉트 상한.
pub const MAX_REDIRECTS: usize = 10;

const HEADER_TIMEOUT: &str =
    "context deadline exceeded (Client.Timeout exceeded while awaiting headers)";
const BODY_TIMEOUT: &str =
    "context deadline exceeded (Client.Timeout or context cancellation while reading body)";
const CONTEXT_CANCELED: &str = "context canceled";
const UNKNOWN_AUTHORITY: &str =
    "tls: failed to verify certificate: x509: certificate signed by unknown authority";
const HTTP_RESPONSE_TO_HTTPS: &str = "http: server gave HTTP response to HTTPS client";
const BAD_CHUNK_LENGTH: &str = "invalid byte in chunk length";
const MALFORMED_CHUNKED: &str = "malformed chunked encoding";
const MALFORMED_RESPONSE: &str =
    "net/http: HTTP/1.x transport connection broken: malformed HTTP response";

/// Go `*url.Error`. `Display` 는 `Op "URL": Err` 다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UrlError {
    pub op: String,
    pub url: String,
    pub err: String,
}

impl fmt::Display for UrlError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} {}: {}", self.op, quote(&self.url), self.err)
    }
}

impl StdError for UrlError {}

impl UrlError {
    /// `method url` 요청이 `err` 로 실패했을 때 Go `Client.Do` 가 돌려주는 오류.
    pub fn new(method: &str, url: &str, err: impl Into<String>) -> Self {
        Self {
            op: op(method),
            url: strip_password(url),
            err: err.into(),
        }
    }

    /// `send()` 가 낸 reqwest 오류를 Go 문구로 옮긴다.
    pub fn from_reqwest(method: &str, url: &str, err: &reqwest::Error) -> Self {
        if err.is_redirect() {
            let target = match find::<TooManyRedirects>(err) {
                Some(t) => Some(&t.0),
                None => err.url(),
            }
            .map(|u| redirect_location(url, u));
            let mut e = Self::new(
                method,
                url,
                format!("stopped after {MAX_REDIRECTS} redirects"),
            );
            if let Some(t) = target {
                e.url = t;
            }
            return e;
        }
        Self::new(method, url, send_cause(url, err))
    }

    /// 요청 중 컨텍스트가 취소되었을 때의 오류.
    pub fn canceled(method: &str, url: &str) -> Self {
        Self::new(method, url, CONTEXT_CANCELED)
    }
}

/// Go `http.Client` 와 같은 리다이렉트 정책: 요청 [`MAX_REDIRECTS`] 번 뒤 멈추고, 오류에
/// 마지막 Location 을 싣는다. reqwest 기본값(`limited(10)`)은 한 번 더 따라간다.
pub fn redirect_policy() -> reqwest::redirect::Policy {
    reqwest::redirect::Policy::custom(|attempt| {
        if attempt.previous().len() >= MAX_REDIRECTS {
            let next = attempt.url().clone();
            attempt.error(TooManyRedirects(next))
        } else {
            attempt.follow()
        }
    })
}

#[derive(Debug)]
struct TooManyRedirects(reqwest::Url);

impl fmt::Display for TooManyRedirects {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "stopped after {MAX_REDIRECTS} redirects")
    }
}

impl StdError for TooManyRedirects {}

/// 응답 본문을 읽다 난 reqwest 오류의 Go 문구.
pub fn body_error(err: &reqwest::Error) -> String {
    if err.is_timeout() || chain_has_timeout(err) {
        return BODY_TIMEOUT.to_owned();
    }
    if find::<hyper::Error>(err).is_some_and(hyper::Error::is_incomplete_message) {
        return "unexpected EOF".to_owned();
    }
    if let Some(e) = find::<io::Error>(err) {
        if e.kind() == io::ErrorKind::UnexpectedEof {
            return "unexpected EOF".to_owned();
        }
        if let Some(code) = oserr::raw_os_error(e) {
            return oserr::errno_string(code);
        }
    }
    let inner = innermost(err);
    // hyper 의 청크 해석 오류(`Invalid chunk size line: ...`, `Invalid chunk end CR` 등).
    if inner.to_ascii_lowercase().contains("chunk") {
        return if inner.contains("size") {
            BAD_CHUNK_LENGTH.to_owned()
        } else {
            MALFORMED_CHUNKED.to_owned()
        };
    }
    inner
}

/// Go 의 `Op`: 메서드의 첫 글자만 대문자다 (`GET` → `Get`).
pub fn op(method: &str) -> String {
    let mut cs = method.chars();
    match cs.next() {
        Some(c) => c
            .to_uppercase()
            .chain(cs.as_str().to_lowercase().chars())
            .collect(),
        None => String::new(),
    }
}

/// Go `stripPassword`: URL 의 비밀번호를 `***` 로 가린다.
fn strip_password(url: &str) -> String {
    let Ok(mut u) = reqwest::Url::parse(url) else {
        return url.to_owned();
    };
    if u.password().is_none() {
        return url.to_owned();
    }
    if u.set_password(Some("***")).is_err() {
        return url.to_owned();
    }
    u.to_string()
}

/// Go 는 마지막 응답의 Location 값을 그대로 싣는다. reqwest 는 절대 URL 만 주므로,
/// 처음 요청과 출처가 같으면 경로(+질의)로, 다르면 절대 URL 로 적는다.
fn redirect_location(orig: &str, target: &reqwest::Url) -> String {
    let same_origin = reqwest::Url::parse(orig)
        .map(|o| o.origin() == target.origin())
        .unwrap_or(false);
    if !same_origin {
        return target.to_string();
    }
    match target.query() {
        Some(q) => format!("{}?{q}", target.path()),
        None => target.path().to_owned(),
    }
}

fn send_cause(url: &str, err: &reqwest::Error) -> String {
    if err.is_builder()
        && let Ok(u) = reqwest::Url::parse(url)
        && !matches!(u.scheme(), "http" | "https")
    {
        return format!("unsupported protocol scheme {}", quote(u.scheme()));
    }
    if err.is_timeout() || chain_has_timeout(err) {
        return HEADER_TIMEOUT.to_owned();
    }
    if let Some(t) = find::<rustls::Error>(err) {
        return tls_cause(t);
    }
    if err.is_connect() {
        if chain_any(err, |e| e.to_string() == "dns error") {
            let host = reqwest::Url::parse(url)
                .ok()
                .and_then(|u| u.host_str().map(str::to_owned))
                .unwrap_or_default();
            return format!("dial tcp: lookup {}: no such host", unbracket(&host));
        }
        if let Some(code) = find::<io::Error>(err).and_then(oserr::raw_os_error) {
            let errno = oserr::errno_string(code);
            return match dial_addr(url) {
                Some(addr) => format!("dial tcp {addr}: connect: {errno}"),
                None => format!("dial tcp: connect: {errno}"),
            };
        }
    }
    if let Some(h) = find::<hyper::Error>(err) {
        if h.is_incomplete_message() {
            return "EOF".to_owned();
        }
        if h.is_parse() {
            return MALFORMED_RESPONSE.to_owned();
        }
    }
    if let Some(code) = find::<io::Error>(err).and_then(oserr::raw_os_error) {
        return oserr::errno_string(code);
    }
    innermost(err)
}

fn tls_cause(e: &rustls::Error) -> String {
    use rustls::{CertificateError, Error, InvalidMessage};
    match e {
        Error::InvalidCertificate(CertificateError::UnknownIssuer) => UNKNOWN_AUTHORITY.to_owned(),
        Error::InvalidMessage(InvalidMessage::InvalidContentType) => {
            HTTP_RESPONSE_TO_HTTPS.to_owned()
        }
        Error::InvalidCertificate(CertificateError::Other(o))
            if o.to_string().contains("UnknownIssuer") || o.to_string().contains("not trusted") =>
        {
            UNKNOWN_AUTHORITY.to_owned()
        }
        other => format!("tls: {other}"),
    }
}

/// Go 가 `dial tcp` 뒤에 적는 주소: IP 면 그대로, 이름이면 해석한 첫 주소.
fn dial_addr(url: &str) -> Option<String> {
    let u = reqwest::Url::parse(url).ok()?;
    let port = u.port_or_known_default()?;
    let host = unbracket(u.host_str()?).to_owned();
    let ip = match host.parse::<IpAddr>() {
        Ok(ip) => ip,
        Err(_) => (host.as_str(), port).to_socket_addrs().ok()?.next()?.ip(),
    };
    Some(match ip {
        IpAddr::V4(v4) => format!("{v4}:{port}"),
        IpAddr::V6(v6) => format!("[{v6}]:{port}"),
    })
}

fn unbracket(h: &str) -> &str {
    h.strip_prefix('[')
        .and_then(|s| s.strip_suffix(']'))
        .unwrap_or(h)
}

/// 원인 사슬. `io::Error::source()` 는 감싼 오류 자체를 건너뛰므로 `get_ref()` 로 들어간다.
fn sources<'a>(
    err: &'a (dyn StdError + 'static),
) -> impl Iterator<Item = &'a (dyn StdError + 'static)> {
    std::iter::successors(Some(err), |&e| match e.downcast_ref::<io::Error>() {
        Some(io) => io.get_ref().map(|i| i as &(dyn StdError + 'static)),
        None => e.source(),
    })
}

fn find<T: StdError + 'static>(err: &reqwest::Error) -> Option<&T> {
    sources(err).find_map(|e| e.downcast_ref::<T>())
}

fn chain_any(err: &reqwest::Error, f: impl Fn(&(dyn StdError + 'static)) -> bool) -> bool {
    sources(err).any(f)
}

fn chain_has_timeout(err: &reqwest::Error) -> bool {
    chain_any(err, |e| {
        e.downcast_ref::<hyper::Error>()
            .is_some_and(hyper::Error::is_timeout)
            || e.downcast_ref::<io::Error>()
                .is_some_and(|io| io.kind() == io::ErrorKind::TimedOut)
    })
}

fn innermost(err: &reqwest::Error) -> String {
    sources(err)
        .last()
        .map(|e| e.to_string())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests;
