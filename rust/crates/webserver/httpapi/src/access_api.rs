//! 접근 게이트와 `/api/access` 종단 (Go `access_api.go`).

use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};

use dm_shared_dmlog::infof;
use dm_shared_httpresp::{self as httpresp, Response};
use dm_webserver_action::{self as action, Answer};
use dm_webserver_apierr as apierr;
use http::{HeaderValue, StatusCode};
use serde::Serialize;
use tokio_util::sync::CancellationToken;

use crate::Server;
use crate::access::{AccessConfig, AccessStore, DEFAULT_ACCESS_REFRESH, SaveError};
use crate::access_denied::{wants_denied_page, write_denied_page};
use crate::httperr::{fail, http_err, read_body_err};
use crate::netx::{self, Addr};
use crate::req::Req;
use crate::reqgate::normalize_host;
use crate::settings_etag::{settings_stale, settings_tag};

/// 접근 게이트가 거절한 수다 (Go `accessDenies`, `/api/diag` 가 읽는다).
pub(crate) static ACCESS_DENIES: AtomicI64 = AtomicI64::new(0);

/// Go `remoteIP`: `RemoteAddr` 에서 주소를 꺼낸다. zone 은 버리고 4in6 은 푼다.
pub(crate) fn remote_ip(remote_addr: &str) -> Option<Addr> {
    let mut host = netx::split_host_port(remote_addr).map_or(remote_addr, |(h, _)| h);
    if let Some(i) = host.find('%') {
        host = &host[..i];
    }
    netx::parse_addr(host).map(|a| a.unmap())
}

/// Go `accessGate` 의 판정. 거절이면 응답을 돌려준다.
pub(crate) fn access_gate(store: Option<&Arc<AccessStore>>, r: &Req) -> Option<Response> {
    let store = store?;
    let addr = remote_ip(&r.remote_addr);
    if let Some(a) = &addr {
        if store.allowed(a) {
            return None;
        }
    } else if !store.matcher().enabled {
        return None;
    }
    ACCESS_DENIES.fetch_add(1, Ordering::Relaxed);
    infof!(
        r.rid(),
        "access denied addr={} {} {}",
        r.remote_addr,
        r.method,
        r.path
    );
    if wants_denied_page(r) {
        let shown = addr.map_or_else(|| r.remote_addr.clone(), |a| a.to_string());
        return Some(write_denied_page(&shown));
    }
    Some(http_err(
        "forbidden",
        StatusCode::FORBIDDEN,
        apierr::CODE_FORBIDDEN,
    ))
}

fn access_unready() -> Response {
    http_err(
        "access store unavailable",
        StatusCode::SERVICE_UNAVAILABLE,
        apierr::CODE_ACCESS_UNREADY,
    )
}

fn with_etag(mut res: Response, tag: &str) -> Response {
    if let Ok(v) = HeaderValue::from_str(tag) {
        res.headers_mut().insert(http::header::ETAG, v);
    }
    res
}

/// 본문을 읽어 구성으로 푼다. 실패면 이미 만든 응답이다.
async fn read_access_config(r: &Req) -> Result<AccessConfig, Response> {
    let body = r.read_body(0).await.map_err(|e| read_body_err(&e))?;
    dm_gocompat::json::unmarshal::<AccessConfig>(&body).map_err(|_| {
        http_err(
            "invalid json",
            StatusCode::BAD_REQUEST,
            apierr::CODE_INVALID_JSON,
        )
    })
}

#[derive(Serialize)]
struct CheckBody {
    actions: BTreeMap<&'static str, Answer>,
    #[serde(skip_serializing_if = "Option::is_none")]
    you: Option<String>,
}

impl Server {
    /// GET /api/access (FR-ACL-19).
    pub(crate) async fn api_access_get(&self, r: &mut Req) -> Response {
        let Some(store) = &self.access else {
            return access_unready();
        };
        let mut v = store.view();
        if let Some(a) = remote_ip(&r.remote_addr) {
            v.you = a.to_string();
        }
        v.hostname = self.hosts.hostname.clone();
        v.host = normalize_host(&r.host);
        let tag = settings_tag(&store.config());
        with_etag(httpresp::json(StatusCode::OK, &v), &tag)
    }

    /// PUT /api/access (FR-ACL-20).
    pub(crate) async fn api_access_put(&self, r: &mut Req) -> Response {
        let Some(store) = &self.access else {
            return access_unready();
        };
        let cfg = match read_access_config(r).await {
            Ok(c) => c,
            Err(res) => return res,
        };
        if let Err(res) = self.access_save(store, r, cfg).await {
            return res;
        }
        let s = Arc::clone(store);
        let _ = tokio::task::spawn_blocking(move || s.refresh()).await;
        if let Some(c) = self.commands() {
            c.broadcast(&access_changed_payload());
        }
        let tag = settings_tag(&store.config());
        let mut res = http::Response::new(httpresp::empty());
        *res.status_mut() = StatusCode::OK;
        with_etag(res, &tag)
    }

    async fn access_save(
        &self,
        store: &AccessStore,
        r: &Req,
        cfg: AccessConfig,
    ) -> Result<(), Response> {
        let _g = store.put_mu.lock().await;
        let cur = settings_tag(&store.config());
        if settings_stale(r, &cur) {
            return Err(with_etag(
                http_err(
                    "stale revision",
                    StatusCode::CONFLICT,
                    apierr::CODE_STALE_REV,
                ),
                &cur,
            ));
        }
        match store.save(cfg) {
            Ok(()) => Ok(()),
            Err(e @ SaveError::Failed) => Err(fail(
                StatusCode::INTERNAL_SERVER_ERROR,
                &e.to_string(),
                None,
            )),
            Err(e @ SaveError::Invalid(_)) => {
                Err(fail(StatusCode::BAD_REQUEST, &e.to_string(), None))
            }
        }
    }

    /// POST /api/access/check (FR-ACL-22): 저장하면 요청자가 스스로 잠기는가.
    pub(crate) async fn api_access_check(&self, r: &mut Req) -> Response {
        let Some(store) = &self.access else {
            return access_unready();
        };
        let cfg = match read_access_config(r).await {
            Ok(c) => c,
            Err(res) => return res,
        };
        let Some(you) = remote_ip(&r.remote_addr) else {
            let mut actions = BTreeMap::new();
            actions.insert(action::ACCESS_SAVE, action::allow());
            return httpresp::json(StatusCode::OK, &CheckBody { actions, you: None });
        };
        match store.check_save(&cfg, &you) {
            Ok(a) => {
                let mut actions = BTreeMap::new();
                actions.insert(action::ACCESS_SAVE, a);
                httpresp::json(
                    StatusCode::OK,
                    &CheckBody {
                        actions,
                        you: Some(you.unmap().to_string()),
                    },
                )
            }
            Err(msg) => fail(StatusCode::BAD_REQUEST, &msg, None),
        }
    }

    /// Go `StartAccessRefresh`: 합성 루트가 부른다. `done` 이 취소되면 멈춘다.
    pub fn start_access_refresh(&self, done: CancellationToken) {
        if let Some(store) = &self.access {
            store.start_refresh(done, DEFAULT_ACCESS_REFRESH);
        }
    }
}

/// SSE `access_changed`.
pub(crate) fn access_changed_payload() -> Vec<u8> {
    dm_webserver_sse::payload("access_changed", Some(&serde_json::Map::new()))
}
