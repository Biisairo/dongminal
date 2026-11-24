//! 요청 한 번 (Go `*http.Request` 에서 핸들러가 읽는 것).

// 다른 하위 이슈(5.5.2~)의 종단이 쓰는 공용 도우미가 있다.
#![allow(dead_code)]

use std::future::Future;
use std::pin::Pin;
use std::sync::Mutex;

use bytes::Bytes;
use http::HeaderMap;
use http_body_util::BodyExt;
use http_body_util::combinators::UnsyncBoxBody;
use otter_gocompat::neturl::{self, Values};
use otter_shared_httpreq::{self as httpreq, DecodeError, Empty, ReadError};
use otter_shared_httpresp::Response;
use otter_shared_otterlog::ReqCtx;
use serde::de::DeserializeOwned;
use tokio_util::sync::CancellationToken;

use crate::Server;

/// 핸들러가 받는 요청 본문이다.
pub type ReqBody = UnsyncBoxBody<Bytes, BodyError>;

/// 본문 읽기 오류. 원래 오류의 문구만 담는다.
#[derive(Debug)]
pub struct BodyError(pub(crate) String);

impl std::fmt::Display for BodyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for BodyError {}

pub(crate) type BoxFut<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// 핸들러 하나. Go `func(*Server, http.ResponseWriter, *http.Request)`.
pub(crate) type Handler = for<'a> fn(&'a Server, &'a mut Req) -> BoxFut<'a, Response>;

/// 요청 하나.
pub(crate) struct Req {
    pub(crate) method: http::Method,
    /// Go `r.URL.Path`(퍼센트 디코딩한 경로).
    pub(crate) path: String,
    /// 요청 대상 그대로(퍼센트 인코딩 유지).
    pub(crate) uri: http::Uri,
    /// Go `r.URL.RawQuery`.
    pub(crate) raw_query: String,
    pub(crate) headers: HeaderMap,
    /// Go `r.Host`.
    pub(crate) host: String,
    /// Go `r.RemoteAddr`(`ip:port`, IPv6 는 대괄호).
    pub(crate) remote_addr: String,
    /// 업그레이드(`hyper::upgrade::OnUpgrade`) 같은 연결 쪽 값이다.
    pub(crate) extensions: http::Extensions,
    /// `Mutex` 는 `Req` 를 `Sync` 로 두기 위해서다 — 핸들러 future 가 `&Req` 를 await 너머로 든다.
    body: Mutex<Option<ReqBody>>,
    /// Go `r.Context()`. 응답을 기다리던 쪽이 떠나면 취소된다.
    pub(crate) ctx: CancellationToken,
    req_id: Option<String>,
}

impl Req {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn new(
        method: http::Method,
        path: String,
        uri: http::Uri,
        headers: HeaderMap,
        host: String,
        remote_addr: String,
        extensions: http::Extensions,
        body: ReqBody,
        req_id: Option<String>,
    ) -> Req {
        let raw_query = uri.query().unwrap_or_default().to_owned();
        Req {
            method,
            path,
            uri,
            raw_query,
            headers,
            host,
            remote_addr,
            extensions,
            body: Mutex::new(Some(body)),
            ctx: CancellationToken::new(),
            req_id,
        }
    }

    /// Go `r.URL.Query()`.
    pub(crate) fn query(&self) -> Values {
        neturl::parse_query(&self.raw_query).0
    }

    /// Go `r.URL.Query().Get(key)`.
    pub(crate) fn q(&self, key: &str) -> String {
        self.query().get_or_empty(key)
    }

    /// Go `r.Header.Get(name)`. 값이 UTF-8 이 아니면 바이트를 그대로 문자로 본다.
    pub(crate) fn header(&self, name: &str) -> String {
        self.headers
            .get(name)
            .map(|v| String::from_utf8_lossy(v.as_bytes()).into_owned())
            .unwrap_or_default()
    }

    pub(crate) fn rid(&self) -> ReqCtx<'_> {
        self.req_id.as_deref()
    }

    pub(crate) fn take_body(&self) -> ReqBody {
        self.body
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take()
            .unwrap_or_else(|| {
                http_body_util::Empty::new()
                    .map_err(|e| match e {})
                    .boxed_unsync()
            })
    }

    /// Go `httpreq.Read`. `limit` 이 0 이하이면 기본 상한이다.
    pub(crate) fn read_body(&self, limit: i64) -> BoxFut<'_, Result<Bytes, ReadError>> {
        let body = self.take_body();
        Box::pin(async move { httpreq::read(body, limit).await })
    }

    /// Go `httpreq.DecodeJSON`.
    pub(crate) fn decode_json<T: DeserializeOwned + Send + 'static>(
        &self,
        limit: i64,
        empty: Empty,
    ) -> BoxFut<'_, Result<T, DecodeError>> {
        let body = self.take_body();
        Box::pin(async move { httpreq::decode_json::<T, ReqBody>(body, limit, empty).await })
    }

    #[cfg(test)]
    pub(crate) fn for_test(method: http::Method, target: &str, body: &str) -> Req {
        let path = target.split_once('?').map_or(target, |(p, _)| p);
        Req::new(
            method,
            path.to_owned(),
            target.parse().unwrap_or_default(),
            HeaderMap::new(),
            "localhost".to_owned(),
            "127.0.0.1:50000".to_owned(),
            http::Extensions::new(),
            http_body_util::Full::new(Bytes::from(body.to_owned()))
                .map_err(|e| match e {})
                .boxed_unsync(),
            None,
        )
    }
}
