//! 이사하는 화면의 localStorage 를 새 주소로 넘기는 일회용 보관이다 (Go `carry.go`,
//! HOT_REBIND_SRS FR-HRB-26). 서버 메모리에만 있다.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use bytes::Bytes;
use dm_shared_httpreq as httpreq;
use dm_shared_httpresp::{self as httpresp, Response};
use dm_webserver_apierr as apierr;
use http::{HeaderValue, StatusCode, header};
use rand::TryRng;
use rand::rngs::SysRng;

use crate::Server;
use crate::httperr::{code_fail, mark, write_json};
use crate::req::Req;

pub(crate) const CARRY_TTL: Duration = Duration::from_secs(60);
pub(crate) const CARRY_MAX: usize = 16;
/// REFACTOR3_DEDUP_GO_SRS FR-RDG-6.
pub(crate) const CARRY_BODY_LIMIT: i64 = httpreq::DEFAULT_LIMIT;
pub(crate) const CARRY_PREFIX: &str = "/api/server/carry/";

struct CarryItem {
    data: Bytes,
    exp: Instant,
}

/// Go `carryStore`.
#[derive(Default)]
pub(crate) struct CarryStore {
    items: Mutex<HashMap<String, CarryItem>>,
    /// 시험이 시계를 정한다. `None` 이면 지금이다.
    #[cfg(test)]
    pub(crate) now: Mutex<Option<Instant>>,
}

impl CarryStore {
    fn now(&self) -> Instant {
        #[cfg(test)]
        if let Some(t) = *self.now.lock().unwrap_or_else(|e| e.into_inner()) {
            return t;
        }
        Instant::now()
    }

    /// 지난 것을 지운다.
    fn sweep(items: &mut HashMap<String, CarryItem>, now: Instant) {
        items.retain(|_, it| now < it.exp);
    }

    /// 맡기고 토큰을 준다. 가득 찼거나 토큰을 만들지 못하면 `None` 이다.
    pub(crate) fn put(&self, data: Bytes) -> Option<String> {
        let mut raw = [0u8; 16];
        SysRng.try_fill_bytes(&mut raw).ok()?;
        let token = hex::encode(raw);
        let now = self.now();
        let mut items = self.items.lock().unwrap_or_else(|e| e.into_inner());
        Self::sweep(&mut items, now);
        if items.len() >= CARRY_MAX {
            return None;
        }
        items.insert(
            token.clone(),
            CarryItem {
                data,
                exp: now + CARRY_TTL,
            },
        );
        Some(token)
    }

    /// 한 번만 꺼낸다.
    pub(crate) fn take(&self, token: &str) -> Option<Bytes> {
        let now = self.now();
        let mut items = self.items.lock().unwrap_or_else(|e| e.into_inner());
        Self::sweep(&mut items, now);
        items.remove(token).map(|it| it.data)
    }
}

impl Server {
    /// POST /api/server/carry.
    pub(crate) async fn api_server_carry_post(&self, r: &mut Req) -> Response {
        let raw = match r.read_body(CARRY_BODY_LIMIT).await {
            Ok(b) => b,
            Err(e) => {
                return mark(
                    &e,
                    code_fail(httpreq::status(&e), apierr::body_read_code(&e), "read body"),
                );
            }
        };
        if !dm_gocompat::json::valid(&raw) {
            return code_fail(
                StatusCode::BAD_REQUEST,
                apierr::CODE_BAD_REQUEST,
                "body is not json",
            );
        }
        let Some(token) = self.rebind.carry.put(raw) else {
            return code_fail(
                StatusCode::SERVICE_UNAVAILABLE,
                apierr::CODE_BUSY,
                "carry full",
            );
        };
        let mut m = std::collections::BTreeMap::new();
        m.insert("token", token);
        write_json(&m)
    }

    /// GET /api/server/carry/<token>.
    pub(crate) async fn api_server_carry_get(&self, r: &mut Req) -> Response {
        let token = r.path.strip_prefix(CARRY_PREFIX).unwrap_or(&r.path);
        let Some(data) = self.rebind.carry.take(token) else {
            return code_fail(
                StatusCode::NOT_FOUND,
                apierr::CODE_NOT_FOUND,
                "no such carry",
            );
        };
        let mut res = Response::new(httpresp::full(data));
        res.headers_mut().insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/json"),
        );
        res
    }
}
