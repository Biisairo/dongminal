//! 요청 한 번과 그 처리 (Go `Handle` · `withLease`).

use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};

use bytes::Bytes;
use dm_gocompat::neturl::{self, Values};
use dm_shared_dmlog::ReqCtx;
use dm_shared_httpreq::{self as httpreq, BoxError, DecodeError, Empty};
use dm_shared_httpresp::Response;
use dm_webserver_apierr as apierr;
use dm_webserver_domain_git_core::Ctx;
use http::StatusCode;
use http_body_util::BodyExt;
use http_body_util::combinators::UnsyncBoxBody;
use hyper::body::Body;
use serde::de::DeserializeOwned;

use crate::GitServer;
use crate::lock::{WriteLease, write_lease};
use crate::reply::{ERR_BAD_REQUEST, git_fail};
use crate::routes::ROUTES;

/// 핸들러가 받는 요청 본문이다.
pub type ReqBody = UnsyncBoxBody<Bytes, BodyError>;

/// 본문 읽기 오류. 원래 오류의 문구만 담는다 — 구체 타입이어야 본문 읽기 future 의 `Send` 가
/// 추론된다(`dyn Error` 오류 타입은 rustc 의 고차 수명 추론에 걸린다).
#[derive(Debug)]
pub struct BodyError(String);

impl std::fmt::Display for BodyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for BodyError {}

pub(crate) type BoxFut<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// 핸들러 하나. Go `func(*GitServer, http.ResponseWriter, *http.Request)`.
pub(crate) type Handler = for<'a> fn(&'a GitServer, &'a mut Req) -> BoxFut<'a, Response>;

/// 요청 하나. Go `*http.Request` 에서 핸들러가 읽는 것만 담는다.
pub(crate) struct Req {
    pub(crate) method: http::Method,
    /// Go `r.URL.Path`(퍼센트 디코딩한 경로).
    pub(crate) path: String,
    /// Go `r.URL.Query()`.
    pub(crate) query: Values,
    /// `Mutex` 는 `Req` 를 `Sync` 로 두기 위해서다 — 핸들러 future 가 `&Req` 를 await 너머로 든다.
    body: Mutex<Option<ReqBody>>,
    /// Go `r.Context()`. 응답을 기다리던 쪽이 떠나면 취소된다.
    pub(crate) ctx: Ctx,
    req_id: Option<String>,
    /// 쓰기 종단의 잠금 임대 (REPO_FIX 01 §5.4). 핸들러가 끝난 뒤 반납한다.
    pub(crate) lease: Option<Arc<WriteLease>>,
}

impl Req {
    /// Go `r.URL.Query().Get(key)`.
    pub(crate) fn q(&self, key: &str) -> String {
        self.query.get_or_empty(key)
    }

    pub(crate) fn rid(&self) -> ReqCtx<'_> {
        self.req_id.as_deref()
    }

    fn take_body(&self) -> Option<ReqBody> {
        self.body.lock().unwrap_or_else(|e| e.into_inner()).take()
    }

    /// 본문을 읽어 `T` 로 푼다 (Go `gitDecodeBody`). 실패면 이미 만든 400·413 응답이다.
    ///
    /// future 를 상자에 담아 돌려준다 — 제네릭 본문 읽기의 `Send` 를 여기서 확정해야 핸들러
    /// future 가 `Send` 로 추론된다.
    pub(crate) fn decode_body<T: DeserializeOwned + Send + 'static>(
        &self,
    ) -> BoxFut<'_, Result<T, Response>> {
        let body = self.take_body().unwrap_or_else(|| {
            http_body_util::Empty::new()
                .map_err(|e| match e {})
                .boxed_unsync()
        });
        Box::pin(async move {
            match httpreq::decode_json::<T, ReqBody>(body, 0, Empty::NotJson).await {
                Ok(v) => Ok(v),
                Err(err) => Err(self.decode_fail(&err)),
            }
        })
    }

    #[cfg(test)]
    pub(crate) fn for_test(method: http::Method, target: &str, body: &str) -> Req {
        let (path, query) = target.split_once('?').unwrap_or((target, ""));
        Req {
            method,
            path: path.to_owned(),
            query: neturl::parse_query(query).0,
            body: Mutex::new(Some(
                http_body_util::Full::new(Bytes::from(body.to_owned()))
                    .map_err(|e| match e {})
                    .boxed_unsync(),
            )),
            ctx: Ctx::background(),
            req_id: None,
            lease: None,
        }
    }

    fn decode_fail(&self, err: &DecodeError) -> Response {
        let (code, name, prefix) = match err {
            DecodeError::Read(e) => (
                httpreq::status(e),
                apierr::body_read_code(e),
                "본문을 읽지 못했다",
            ),
            DecodeError::NotJson(_) => (
                StatusCode::BAD_REQUEST,
                ERR_BAD_REQUEST,
                "본문이 JSON 이 아니다",
            ),
        };
        let msg = httpreq::message(self.rid(), self.method.as_str(), &self.path, prefix, err);
        let mut res = git_fail(code, name, &msg);
        if let DecodeError::Read(e) = err {
            httpreq::mark_response(e, &mut res);
        }
        res
    }
}

/// 손을 떼면 요청 문맥을 취소한다 — Go 가 연결이 끊긴 요청의 ctx 를 끝내는 것과 같다.
struct CancelOnDrop(Ctx);

impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.cancel();
    }
}

impl GitServer {
    /// `/api/git/*` 요청을 처리한다. `None` 이면 처리하지 않은 것이다 — 호출자가 404 를 낸다.
    ///
    /// 핸들러는 따로 task 로 돈다. 응답을 기다리던 쪽이 떠나도(이 future 를 버려도) 핸들러는
    /// 끝까지 가고 요청 문맥만 취소된다 — Go 처럼, 시작한 쓰기가 도중에 끊겨 index.lock 을
    /// 남기지 않는다 (REPO_FIX 01 §5.5). 핸들러의 패닉은 이 호출로 다시 던진다.
    ///
    /// `req_id` 는 로그의 요청 ID 다 (FR-RSP-34). 경로의 퍼센트 디코딩이 실패한 요청은 처리하지
    /// 않는다 — Go 서버는 그런 요청을 핸들러 전에 400 으로 끝낸다.
    pub async fn handle<B>(
        self: &Arc<Self>,
        req: http::Request<B>,
        req_id: Option<String>,
    ) -> Option<Response>
    where
        B: Body<Data = Bytes> + Send + 'static,
        B::Error: Into<BoxError>,
    {
        let raw_path = req.uri().path();
        let path = String::from_utf8_lossy(&neturl::path_unescape(raw_path).ok()?).into_owned();
        if !path.starts_with("/api/git/") {
            return None;
        }
        let handler = *dm_webserver_httproute::dispatch(&ROUTES, req.method().as_str(), &path)?;
        let query = neturl::parse_query(req.uri().query().unwrap_or("")).0;
        let lease = write_lease(req.method(), &path).map(Arc::new);
        let (parts, body) = req.into_parts();
        let ctx = Ctx::background();
        let _cancel = CancelOnDrop(ctx.clone());
        let mut r = Req {
            method: parts.method,
            path,
            query,
            body: Mutex::new(Some(
                body.map_err(|e| BodyError(Into::<BoxError>::into(e).to_string()))
                    .boxed_unsync(),
            )),
            ctx,
            req_id,
            lease,
        };
        let me = Arc::clone(self);
        let task = tokio::spawn(async move {
            let res = handler(&me, &mut r).await;
            if let Some(l) = &r.lease {
                l.release();
            }
            res
        });
        match task.await {
            Ok(res) => Some(res),
            Err(e) if e.is_panic() => std::panic::resume_unwind(e.into_panic()),
            Err(_) => None,
        }
    }
}
