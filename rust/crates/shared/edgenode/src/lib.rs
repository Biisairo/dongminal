//! Go 기준선 `dongminal/internal/shared/edgenode` 의 Rust 포팅. RUST_PORT_SRS 참고.
//!
//! 노드 하나: 설정 저장소, 신원, 짝 맺기, 노드 포트 HTTP(`/edge/v1/*`), 로컬 API 의 동작(`do_op`),
//! 간선 계층 결선이다.

mod mesh;
mod ops;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};

use dm_shared_dmenv as dmenv;
use dm_shared_dmlog as dmlog;
use dm_shared_edge::{
    self as edge, CallError, Client, Config, Dial, Edge, Error as EdgeError, Handler, Identity,
    IdentityError, Pairing, RateLimiter, Status, Store,
};
use dm_shared_edgemesh::{Invite, Mesh};
use http::{Method, Request, StatusCode};
use hyper::body::Incoming;
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;

pub use ops::{Request as OpRequest, Response as OpResponse};

const PAIR_PATH: &str = "/edge/v1/pair";
const UNPAIR_PATH: &str = "/edge/v1/unpair";
/// 채팅이 간선 계층 위로 옮기기 전의 경로다. 옛 판 상대가 건다.
const LEGACY_CHAT_PATH: &str = "/edge/v1/chat";
const PAIR_RATE_KEY: &str = "pair-addr:";
/// 짝 맺기 요청에 싣는 판이다.
const PROTO: i64 = 1;
const LEGACY_SPAWNS_FILE: &str = "peer-spawns.json";
const BODY_LIMIT: i64 = dm_shared_httpreq::SMALL_LIMIT;

pub const CODE_BAD_REQUEST: &str = "bad_request";
pub const CODE_NOT_FOUND: &str = "not_found";
pub const CODE_INTERNAL: &str = "internal_error";
pub const CODE_INVALID_JSON: &str = "invalid_json";
pub const CODE_BODY_TOO_BIG: &str = "body_too_large";
pub const CODE_STALE_REV: &str = "stale_revision";
pub const CODE_SAVE_FAILED: &str = "save_failed";

/// 이 패키지와 edge 의 오류 코드 전부다 (Go `Codes()`).
pub fn codes() -> Vec<&'static str> {
    let mut v = vec![
        CODE_BAD_REQUEST,
        CODE_NOT_FOUND,
        CODE_INTERNAL,
        CODE_INVALID_JSON,
        CODE_BODY_TOO_BIG,
        CODE_STALE_REV,
        CODE_SAVE_FAILED,
    ];
    v.extend_from_slice(edge::CODES);
    v
}

pub type NowFn = Arc<dyn Fn() -> OffsetDateTime + Send + Sync>;
pub type PortStatusFn = Arc<dyn Fn() -> Status + Send + Sync>;
pub type OnConfigFn = Arc<dyn Fn(&Config) + Send + Sync>;
pub type NotifyFn = Arc<dyn Fn(Change) + Send + Sync>;

/// 노드를 세우는 값이다.
#[derive(Clone, Default)]
pub struct Options {
    pub home: PathBuf,
    pub hostname: String,
    /// 나가는 연결의 다이얼이다. `None` 이면 TCP 다(데몬은 발신 소켓을 쓴다).
    pub dial: Option<Dial>,
    /// 노드 포트의 지금 상태다.
    pub port_status: Option<PortStatusFn>,
    /// 노드 설정이 바뀐 뒤 부른다(노드 포트 다시 열기).
    pub on_config: Option<OnConfigFn>,
    /// 화면에 알릴 바뀜이다.
    pub notify: Option<NotifyFn>,
    /// 간선 계층을 세운다.
    pub mesh: bool,
    pub now: Option<NowFn>,
}

/// 간선 하나의 지문과 이름이다.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Ref {
    pub fp: String,
    pub name: String,
}

/// 화면에 알릴 바뀜이다. 모두 비면 다시 읽으라는 뜻이다.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Change {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub paired: Option<Ref>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub removed: Option<Ref>,
    #[serde(rename = "byPeer", skip_serializing_if = "std::ops::Not::not")]
    pub by_peer: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub invited: Option<Ref>,
}

#[derive(Default)]
struct InviteState {
    invites: Vec<Invite>,
    rejected: HashMap<String, OffsetDateTime>,
}

/// 노드 하나다.
pub struct Node {
    opts: Options,
    now: NowFn,
    store: Store,
    id: Identity,
    client: Client,
    pairing: Pairing,
    limiter: RateLimiter,
    /// 노드 설정 바꾸기를 한 줄로 세운다(ETag 대조와 저장 사이).
    mu: tokio::sync::Mutex<()>,
    mesh: Option<Mesh>,
    inv: Mutex<InviteState>,
}

impl Node {
    /// 홈의 설정과 신원으로 노드를 세운다. 신원을 읽지 못하면 오류다.
    pub fn new(o: Options) -> Result<Arc<Node>, IdentityError> {
        let now: NowFn = o
            .now
            .clone()
            .unwrap_or_else(|| Arc::new(dm_gocompat::time::now_local));
        if let Err(e) = edge::migrate_legacy_files(&o.home) {
            dmlog::info(
                None,
                &format!(
                    "edge config: 옛 홈 파일을 정리하지 못했다: {}",
                    dm_gocompat::oserr::go_error_string(&e)
                ),
                &[],
            );
        }
        let spawns = o.home.join(LEGACY_SPAWNS_FILE);
        if let Err(e) = std::fs::remove_file(&spawns)
            && e.kind() != std::io::ErrorKind::NotFound
        {
            let e = dm_gocompat::oserr::path_error("remove", &spawns.to_string_lossy(), e);
            dmlog::info(
                None,
                &format!(
                    "peer-spawns.json 을 지우지 못했다: {}",
                    dm_gocompat::oserr::go_error_string(&e)
                ),
                &[],
            );
        }
        let store = Store::open(o.home.join(dmenv::EDGES_FILE), &o.hostname);
        let id = edge::load_or_create_identity(&o.home)?;
        let client = match &o.dial {
            Some(d) => Client::via(id.clone(), d.clone()),
            None => Client::new(id.clone()),
        };
        let clock = |now: &NowFn| -> edge::Clock {
            let n = now.clone();
            Box::new(move || n())
        };
        let with_mesh = o.mesh;
        Ok(Arc::new_cyclic(|weak: &Weak<Node>| Node {
            pairing: Pairing::new(clock(&now)),
            limiter: RateLimiter::new(clock(&now)),
            mesh: with_mesh.then(|| mesh::new_mesh(weak.clone(), id.clone(), now.clone())),
            opts: o,
            now,
            store,
            id,
            client,
            mu: tokio::sync::Mutex::new(()),
            inv: Mutex::default(),
        }))
    }

    pub fn identity(&self) -> &Identity {
        &self.id
    }

    pub fn config(&self) -> Config {
        self.store.config()
    }

    pub fn store(&self) -> &Store {
        &self.store
    }

    pub fn pairing(&self) -> &Pairing {
        &self.pairing
    }

    fn inv(&self) -> MutexGuard<'_, InviteState> {
        self.inv.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn port_status(&self) -> Status {
        self.opts
            .port_status
            .as_ref()
            .map(|f| f())
            .unwrap_or_default()
    }

    fn changed(&self, c: Change) {
        if let Some(f) = &self.opts.notify {
            f(c);
        }
    }

    /// 노드 포트에 누가 들어오는가다. TLS 단계는 누구나 받는다 — 짝 맺기 요청은 아직 간선이
    /// 아닌 노드가 보낸다. 요청 단계가 짝 맺기 밖은 간선만 들인다 (I-1).
    pub fn admission(self: &Arc<Self>) -> edge::Admission {
        let me = Arc::downgrade(self);
        edge::Admission {
            tls: Arc::new(|_| true),
            request: Arc::new(move |fp, path| {
                path == PAIR_PATH || me.upgrade().is_some_and(|n| n.store.is_edge(fp))
            }),
        }
    }

    /// 노드 포트의 요청 처리기다.
    pub fn handler(self: &Arc<Self>) -> Handler {
        let me = Arc::downgrade(self);
        Arc::new(move |req| {
            let me = me.clone();
            Box::pin(async move {
                match me.upgrade() {
                    Some(n) => n.route(req).await,
                    None => write_fail(StatusCode::NOT_FOUND, CODE_NOT_FOUND, "not found"),
                }
            })
        })
    }

    async fn route(self: Arc<Self>, req: Request<Incoming>) -> dm_shared_httpresp::Response {
        let path = req.uri().path().to_string();
        let post = req.method() == Method::POST;
        match path.as_str() {
            PAIR_PATH if post => self.pair(req).await,
            UNPAIR_PATH if post => self.unpair(&req),
            dm_shared_edgemesh::PATH if self.mesh.is_some() => match &self.mesh {
                Some(m) => m.handler()(req).await,
                None => write_fail(StatusCode::NOT_FOUND, CODE_NOT_FOUND, "not found"),
            },
            LEGACY_CHAT_PATH if self.mesh.is_some() => {
                if let Some(m) = &self.mesh {
                    m.mark_outdated(edge::client_fingerprint(&req));
                }
                write_fail(StatusCode::NOT_FOUND, CODE_NOT_FOUND, "not found")
            }
            _ => write_fail(StatusCode::NOT_FOUND, CODE_NOT_FOUND, "not found"),
        }
    }

    /// 짝 맺기를 받는다 (FR-EPR-3·6·7). 출발지마다 상한을 둔다.
    async fn pair(&self, req: Request<Incoming>) -> dm_shared_httpresp::Response {
        #[derive(Deserialize, Default)]
        #[serde(default)]
        struct In {
            token: String,
            name: String,
            addr: String,
            port: i64,
            #[allow(dead_code)]
            proto: i64,
        }
        let host = edge::client_addr(&req)
            .map(|a| a.ip().to_string())
            .unwrap_or_default();
        if !self
            .limiter
            .allow(&format!("{PAIR_RATE_KEY}{}", edge::addr_rate_key(&host)))
        {
            return write_fail(
                StatusCode::TOO_MANY_REQUESTS,
                edge::CODE_RATE_LIMITED,
                "rate limited",
            );
        }
        let fp = edge::client_fingerprint(&req).to_string();
        let input: In = match read_json(req).await {
            Ok(v) => v,
            Err(resp) => return *resp,
        };
        let (mut addr, mut port) = (String::new(), 0);
        if input.port != 0 {
            if !edge::valid_port(input.port) {
                return write_fail(StatusCode::BAD_REQUEST, CODE_BAD_REQUEST, "port");
            }
            (addr, port) = (input.addr, input.port);
            if !edge::valid_addr(&addr) {
                addr = host;
            }
            if !edge::valid_addr(&addr) {
                audit("in", "-", "pair", StatusCode::BAD_REQUEST);
                return write_fail(
                    StatusCode::BAD_REQUEST,
                    edge::CODE_CONFIG_INVALID,
                    "addr: set advertise on the requesting node",
                );
            }
        }
        if let Err(e) = self.store.can_add(&fp) {
            audit("in", "-", "pair", StatusCode::BAD_REQUEST);
            return write_fail(StatusCode::BAD_REQUEST, CODE_BAD_REQUEST, &e.to_string());
        }
        match self.pairing.redeem(&input.token, &fp) {
            Ok(()) => {}
            Err(e @ EdgeError::NoInvite) => {
                audit("in", "-", "pair", StatusCode::FORBIDDEN);
                return write_fail(StatusCode::FORBIDDEN, edge::CODE_NO_INVITE, &e.to_string());
            }
            Err(e) => {
                audit("in", "-", "pair", StatusCode::FORBIDDEN);
                return write_fail(
                    StatusCode::FORBIDDEN,
                    edge::CODE_TOKEN_INVALID,
                    &e.to_string(),
                );
            }
        }
        let name = edge::display_name(&input.name);
        let e = Edge {
            name: name.clone(),
            addr,
            port,
            fingerprint: fp.clone(),
            ..Edge::default()
        };
        if self.store.add_edge(e).is_err() {
            audit("in", &name, "pair", StatusCode::INTERNAL_SERVER_ERROR);
            return write_fail(
                StatusCode::INTERNAL_SERVER_ERROR,
                CODE_SAVE_FAILED,
                "save failed",
            );
        }
        audit("in", &name, "pair", StatusCode::OK);
        self.changed(Change {
            paired: Some(Ref { fp, name }),
            ..Change::default()
        });
        #[derive(Serialize)]
        struct Out {
            name: String,
        }
        dm_shared_httpresp::json(
            StatusCode::OK,
            &Out {
                name: self.store.config().name,
            },
        )
    }

    /// 상대가 이 노드와의 간선을 지웠다는 알림이다.
    fn unpair(&self, req: &Request<Incoming>) -> dm_shared_httpresp::Response {
        let fp = edge::client_fingerprint(req).to_string();
        let resolved = self.store.resolve(&fp);
        let name = resolved
            .as_ref()
            .map(|e| e.name.clone())
            .unwrap_or_default();
        match resolved.and_then(|_| self.store.remove(&fp)) {
            Ok(()) => {}
            Err(EdgeError::EdgeNotFound) => {
                return write_fail(StatusCode::FORBIDDEN, edge::CODE_NOT_EDGE, "not an edge");
            }
            Err(_) => {
                audit("in", &name, "unpair", StatusCode::INTERNAL_SERVER_ERROR);
                return write_fail(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    CODE_SAVE_FAILED,
                    "save failed",
                );
            }
        }
        self.pairing.revoke(&fp);
        self.drop_link(&fp);
        audit("in", &name, "unpair", StatusCode::OK);
        self.changed(Change {
            removed: Some(Ref { fp, name }),
            by_peer: true,
            ..Change::default()
        });
        dm_shared_httpresp::json(StatusCode::OK, &serde_json_empty())
    }

    /// 상대가 이 노드를 간선이 아니라고 답했다. 이 쪽에서도 지운다 (FR-EPR-22·41).
    pub fn forget(&self, fp: &str) {
        let Ok(e) = self.store.resolve(fp) else {
            return;
        };
        if e.fingerprint != fp {
            return;
        }
        if let Err(err) = self.store.remove(fp) {
            dmlog::info(None, &format!("edge forget: {err}"), &[]);
            return;
        }
        self.pairing.revoke(fp);
        self.drop_link(fp);
        audit("out", &e.name, "forget", StatusCode::OK);
        self.changed(Change {
            removed: Some(Ref {
                fp: fp.to_string(),
                name: e.name,
            }),
            by_peer: true,
            ..Change::default()
        });
    }
}

/// 상대가 `edge_not_edge` 로 거절했는가다.
pub fn is_not_edge(err: &CallError) -> bool {
    matches!(err, CallError::Remote(re) if re.code == edge::CODE_NOT_EDGE)
}

/// 빈 JSON 객체(`{}`)다.
#[derive(Serialize)]
struct Empty {}

fn serde_json_empty() -> Empty {
    Empty {}
}

fn write_fail(status: StatusCode, code: &str, msg: &str) -> dm_shared_httpresp::Response {
    dm_shared_httpresp::fail_code(status, code, msg)
}

/// 본문을 JSON 으로 읽는다. 실패하면 답할 응답이다.
async fn read_json<T: serde::de::DeserializeOwned>(
    req: Request<Incoming>,
) -> Result<T, Box<dm_shared_httpresp::Response>> {
    use dm_shared_httpreq::{DecodeError, Empty as EmptyBody, ReadError};
    match dm_shared_httpreq::decode_json(req.into_body(), BODY_LIMIT, EmptyBody::AsObject).await {
        Ok(v) => Ok(v),
        Err(DecodeError::Read(e)) => {
            let code = if matches!(e, ReadError::TooLarge) {
                CODE_BODY_TOO_BIG
            } else {
                CODE_BAD_REQUEST
            };
            let mut resp = write_fail(dm_shared_httpreq::status(&e), code, "read body");
            dm_shared_httpreq::mark_response(&e, &mut resp);
            Err(Box::new(resp))
        }
        Err(DecodeError::NotJson(_)) => Err(Box::new(write_fail(
            StatusCode::BAD_REQUEST,
            CODE_INVALID_JSON,
            "invalid json",
        ))),
    }
}

fn audit(dir: &str, name: &str, op: &str, status: StatusCode) {
    let name = if name.is_empty() { "-" } else { name };
    dmlog::info(
        None,
        &format!(
            "edge audit dir={dir} edge={name} op={op} status={}",
            status.as_u16()
        ),
        &[],
    );
}

#[cfg(test)]
mod tests;
