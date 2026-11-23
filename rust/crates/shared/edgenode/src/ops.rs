//! 로컬 API(`/api/edges/*`)의 동작이다. 서버와 데몬이 같은 함수를 부른다 (PEER_DAEMON_SRS §3.5a).

use std::time::Duration;

use dm_gocompat::json;
use dm_shared_edge::{self as edge, CallError, Config, Edge, Error as EdgeError, Target};
use http::StatusCode;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use time::OffsetDateTime;

use crate::mesh::{InvitedRow, MeshView};
use crate::{
    CODE_BAD_REQUEST, CODE_INTERNAL, CODE_INVALID_JSON, CODE_NOT_FOUND, CODE_SAVE_FAILED,
    CODE_STALE_REV, Change, Empty, Node, PAIR_PATH, PROTO, Ref, UNPAIR_PATH, audit, codes,
};

/// 지울 때 상대에게 알리는 시한이다.
const UNPAIR_TIMEOUT: Duration = Duration::from_secs(3);
/// 상대가 보낸 문장의 바이트 상한이다.
const REMOTE_TEXT_MAX: usize = 512;
/// ETag 로 쓰는 해시의 앞 바이트 수다.
const TAG_BYTES: usize = 8;

/// 동작 하나의 요청이다. args 는 JSON 원문이다.
#[derive(Debug, Clone, Default)]
pub struct Request {
    pub op: String,
    pub args: Vec<u8>,
    pub if_match: String,
}

/// 동작 하나의 답이다. code 가 비면 성공이고 body 가 JSON 원문이다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Response {
    pub status: StatusCode,
    pub code: String,
    pub message: String,
    pub body: Vec<u8>,
    pub etag: String,
}

pub(crate) fn fail(status: StatusCode, code: &str, msg: &str) -> Response {
    Response {
        status,
        code: code.to_string(),
        message: msg.to_string(),
        body: Vec::new(),
        etag: String::new(),
    }
}

pub(crate) fn ok<T: Serialize + ?Sized>(v: &T) -> Response {
    match json::marshal(v) {
        Ok(body) => Response {
            status: StatusCode::OK,
            code: String::new(),
            message: String::new(),
            body,
            etag: String::new(),
        },
        Err(_) => fail(StatusCode::INTERNAL_SERVER_ERROR, CODE_INTERNAL, "encode"),
    }
}

/// args 를 푼다. 비었거나 `null` 이면 `{}` 다.
pub(crate) fn decode<T: DeserializeOwned>(raw: &[u8]) -> Result<T, Response> {
    let raw: &[u8] = if raw.is_empty() || raw == b"null" {
        b"{}"
    } else {
        raw
    };
    json::unmarshal(raw)
        .map_err(|_| fail(StatusCode::BAD_REQUEST, CODE_INVALID_JSON, "invalid json"))
}

/// 설정의 판이다. 알림 대기 표시는 빼고 본다 — 그것은 사람이 바꾼 것이 아니다.
fn tag(mut c: Config) -> String {
    for e in &mut c.edges {
        e.pending = false;
    }
    match json::marshal(&c) {
        Ok(b) => hex::encode(&Sha256::digest(&b)[..TAG_BYTES]),
        Err(_) => String::new(),
    }
}

#[derive(Serialize)]
struct NodeView {
    enabled: bool,
    port: i64,
    bind: String,
    name: String,
    tag: String,
    advertise: String,
    fingerprint: String,
    listening: bool,
    #[serde(skip_serializing_if = "String::is_empty")]
    addr: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    error: String,
}

#[derive(Serialize)]
struct InviteView {
    #[serde(with = "dm_gocompat::time::json_time")]
    expires: OffsetDateTime,
}

/// Go 의 `edgeView{edge.Edge; Tag; Linked; Outdated}` 와 같은 필드 순서다.
#[derive(Serialize)]
struct EdgeView {
    name: String,
    addr: String,
    port: i64,
    fp: String,
    #[serde(rename = "helperKey", skip_serializing_if = "String::is_empty")]
    helper_key: String,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pending: bool,
    tag: String,
    linked: bool,
    outdated: bool,
}

#[derive(Serialize)]
struct View {
    node: NodeView,
    edges: Vec<EdgeView>,
    invite: Option<InviteView>,
    mesh: Option<MeshView>,
    invites: Vec<InvitedRow>,
}

#[derive(Serialize)]
struct ProfileView {
    name: String,
    tag: String,
    handle: String,
    fingerprint: String,
}

impl Node {
    /// 동작 하나를 한다 (Go `Do`).
    pub async fn do_op(&self, req: Request) -> Response {
        match req.op.as_str() {
            "get" => self.tagged(ok(&self.view())),
            "node" => self.op_node(&req).await,
            "profile" => self.tagged(ok(&self.profile())),
            "profile_name" => self.op_profile_name(&req).await,
            "invite" => self.op_invite(&req),
            "add" => self.op_add(&req).await,
            "remove" => self.op_remove(&req).await,
            "address" => self.op_address(&req),
            "notify" => self.op_notify(&req).await,
            "invite_send" => self.op_invite_send(&req),
            "invite_accept" => self.op_invite_accept(&req).await,
            "invite_reject" => self.op_invite_reject(&req),
            _ => fail(StatusCode::NOT_FOUND, CODE_NOT_FOUND, "unknown op"),
        }
    }

    fn tagged(&self, mut r: Response) -> Response {
        r.etag = tag(self.store.config());
        r
    }

    fn profile(&self) -> ProfileView {
        let (name, fp) = (self.store.config().name, self.id.fingerprint.clone());
        ProfileView {
            tag: edge::tag(&fp),
            handle: edge::handle(&name, &fp),
            name,
            fingerprint: fp,
        }
    }

    /// `이름#번호` 다.
    pub fn handle(&self) -> String {
        self.profile().handle
    }

    fn view(&self) -> View {
        let cfg = self.store.config();
        let st = self.port_status();
        let node = NodeView {
            enabled: cfg.enabled,
            port: cfg.port,
            bind: cfg.bind,
            name: cfg.name,
            tag: edge::tag(&self.id.fingerprint),
            advertise: cfg.advertise,
            fingerprint: self.id.fingerprint.clone(),
            listening: st.listening,
            addr: st.addr,
            error: st.err,
        };
        let edges = cfg
            .edges
            .into_iter()
            .map(|e| {
                let (linked, outdated) = self.mesh.as_ref().map_or((false, false), |m| {
                    (m.linked(&e.fingerprint), m.outdated(&e.fingerprint))
                });
                EdgeView {
                    tag: edge::tag(&e.fingerprint),
                    name: e.name,
                    addr: e.addr,
                    port: e.port,
                    fp: e.fingerprint,
                    helper_key: e.helper_key,
                    pending: e.pending,
                    linked,
                    outdated,
                }
            })
            .collect();
        View {
            node,
            edges,
            invite: self
                .pairing
                .invite_expires()
                .map(|expires| InviteView { expires }),
            mesh: self.mesh_view(),
            invites: self.invited_rows(),
        }
    }

    /// 설정을 바꾸는 동작의 공통 틀: If-Match 대조 → f 로 저장 → 알림.
    async fn change_config(
        &self,
        req: &Request,
        f: impl FnOnce(&Self) -> Result<(), EdgeError>,
    ) -> Result<Config, Response> {
        let guard = self.mu.lock().await;
        let cur = tag(self.store.config());
        if !req.if_match.is_empty() && req.if_match != cur {
            let mut r = fail(StatusCode::CONFLICT, CODE_STALE_REV, "stale revision");
            r.etag = cur;
            return Err(r);
        }
        let before = self.store.config();
        if let Err(e) = f(self) {
            if e == EdgeError::SaveFailed {
                return Err(fail(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    CODE_SAVE_FAILED,
                    &e.to_string(),
                ));
            }
            return Err(fail(
                StatusCode::BAD_REQUEST,
                edge::CODE_CONFIG_INVALID,
                &e.to_string(),
            ));
        }
        let cfg = self.store.config();
        drop(guard);
        self.announce_change(&before, &cfg).await;
        Ok(cfg)
    }

    async fn op_node(&self, req: &Request) -> Response {
        let input: NodeIn = match decode(&req.args) {
            Ok(v) => v,
            Err(r) => return r,
        };
        let c = Config {
            enabled: input.enabled,
            port: input.port,
            bind: input.bind,
            name: input.name,
            advertise: input.advertise,
            edges: Vec::new(),
        };
        let cfg = match self.change_config(req, |n| n.store.set_node(&c)).await {
            Ok(c) => c,
            Err(r) => return r,
        };
        if let Some(f) = &self.opts.on_config {
            f(&cfg);
        }
        self.changed(Change::default());
        let mut r = ok(&self.view());
        r.etag = tag(cfg);
        r
    }

    async fn op_profile_name(&self, req: &Request) -> Response {
        #[derive(Deserialize, Default)]
        #[serde(default)]
        struct In {
            name: String,
        }
        let input: In = match decode(&req.args) {
            Ok(v) => v,
            Err(r) => return r,
        };
        let cfg = match self
            .change_config(req, |n| n.store.set_name(&input.name))
            .await
        {
            Ok(c) => c,
            Err(r) => return r,
        };
        self.changed(Change::default());
        let mut r = ok(&self.profile());
        r.etag = tag(cfg);
        r
    }

    fn op_invite(&self, req: &Request) -> Response {
        #[derive(Deserialize, Default)]
        #[serde(default)]
        struct In {
            addr: String,
        }
        let input: In = match decode(&req.args) {
            Ok(v) => v,
            Err(r) => return r,
        };
        if !self.port_status().listening {
            return fail(
                StatusCode::CONFLICT,
                edge::CODE_PORT_CLOSED,
                "node port is not listening",
            );
        }
        let cfg = self.store.config();
        let addr = if input.addr.is_empty() {
            cfg.advertise
        } else {
            input.addr
        };
        if addr.is_empty() {
            return fail(
                StatusCode::BAD_REQUEST,
                edge::CODE_ADDR_REQUIRED,
                "addr required",
            );
        }
        if !edge::valid_addr(&addr) {
            return fail(StatusCode::BAD_REQUEST, edge::CODE_CONFIG_INVALID, "addr");
        }
        let (token, expires) = self.pairing.new_invite();
        let code = edge::encode_invite(&edge::InviteCode {
            addr,
            port: cfg.port,
            fingerprint: self.id.fingerprint.clone(),
            token,
        });
        self.changed(Change::default());
        #[derive(Serialize)]
        struct Out {
            code: String,
            #[serde(with = "dm_gocompat::time::json_time")]
            expires: OffsetDateTime,
        }
        ok(&Out { code, expires })
    }

    async fn op_add(&self, req: &Request) -> Response {
        #[derive(Deserialize, Default)]
        #[serde(default)]
        struct In {
            code: String,
        }
        match decode::<In>(&req.args) {
            Ok(v) => self.add_code(&v.code).await,
            Err(r) => r,
        }
    }

    /// 초대 코드로 상대에게 짝 맺기를 걸고, 받아들여지면 간선을 더한다.
    pub(crate) async fn add_code(&self, code: &str) -> Response {
        let ic = match edge::decode_invite(code) {
            Ok(c) => c,
            Err(e) => {
                return fail(
                    StatusCode::BAD_REQUEST,
                    edge::CODE_INVITE_INVALID,
                    &e.to_string(),
                );
            }
        };
        if let Err(e) = self.store.can_add(&ic.fingerprint) {
            return store_fail(&e);
        }
        let cfg = self.store.config();
        let listening = cfg.enabled && self.port_status().listening;
        let body = PairBody {
            addr: listening.then(|| cfg.advertise.clone()),
            name: cfg.name.clone(),
            port: listening.then_some(cfg.port),
            proto: PROTO,
            token: ic.token.clone(),
        };
        #[derive(Deserialize, Default)]
        #[serde(default)]
        struct Out {
            name: String,
        }
        let t = Target {
            addr: ic.addr.clone(),
            port: ic.port,
            fingerprint: ic.fingerprint.clone(),
        };
        let resp: Out = match self.client.call(&t, PAIR_PATH, &body).await {
            Ok(v) => v,
            Err(e) => {
                audit("out", "-", "pair", StatusCode::BAD_GATEWAY);
                return call_fail(&e);
            }
        };
        let name = edge::display_name(&resp.name);
        let e = Edge {
            name: name.clone(),
            addr: ic.addr,
            port: ic.port,
            fingerprint: ic.fingerprint.clone(),
            ..Edge::default()
        };
        if let Err(e) = self.store.add_edge(e) {
            return store_fail(&e);
        }
        audit("out", &name, "pair", StatusCode::OK);
        self.changed(Change {
            paired: Some(Ref {
                fp: ic.fingerprint.clone(),
                name: name.clone(),
            }),
            ..Change::default()
        });
        #[derive(Serialize)]
        struct Added {
            fp: String,
            name: String,
            tag: String,
        }
        ok(&Added {
            tag: edge::tag(&ic.fingerprint),
            fp: ic.fingerprint,
            name,
        })
    }

    async fn op_remove(&self, req: &Request) -> Response {
        let e = match self.resolve_arg(req) {
            Ok(e) => e,
            Err(r) => return r,
        };
        let mut notified = false;
        if !e.addr.is_empty() {
            let t = Target {
                addr: e.addr.clone(),
                port: e.port,
                fingerprint: e.fingerprint.clone(),
            };
            let call = self.client.call_raw(&t, UNPAIR_PATH, &Empty {});
            notified = matches!(tokio::time::timeout(UNPAIR_TIMEOUT, call).await, Ok(Ok(_)));
        }
        let status = if notified {
            StatusCode::OK
        } else {
            StatusCode::BAD_GATEWAY
        };
        audit("out", &e.name, "unpair", status);
        if let Err(err) = self.store.remove(&e.fingerprint) {
            return store_fail(&err);
        }
        self.pairing.revoke(&e.fingerprint);
        self.drop_link(&e.fingerprint);
        self.changed(Change {
            removed: Some(Ref {
                fp: e.fingerprint.clone(),
                name: e.name.clone(),
            }),
            ..Change::default()
        });
        #[derive(Serialize)]
        struct Out {
            fp: String,
            name: String,
            notified: bool,
        }
        ok(&Out {
            fp: e.fingerprint,
            name: e.name,
            notified,
        })
    }

    fn resolve_arg(&self, req: &Request) -> Result<Edge, Response> {
        #[derive(Deserialize, Default)]
        #[serde(default)]
        struct In {
            fp: String,
        }
        let input: In = decode(&req.args)?;
        self.store.resolve(&input.fp).map_err(|e| store_fail(&e))
    }

    fn op_address(&self, req: &Request) -> Response {
        #[derive(Deserialize, Default)]
        #[serde(default)]
        struct In {
            fp: String,
            addr: String,
            port: i64,
        }
        let input: In = match decode(&req.args) {
            Ok(v) => v,
            Err(r) => return r,
        };
        let e = match self.store.resolve(&input.fp) {
            Ok(e) => e,
            Err(err) => return store_fail(&err),
        };
        if let Err(err) = self
            .store
            .set_address(&e.fingerprint, &input.addr, input.port)
        {
            return store_fail(&err);
        }
        self.changed(Change::default());
        #[derive(Serialize)]
        struct Out {
            addr: String,
            fp: String,
            name: String,
            port: i64,
        }
        ok(&Out {
            addr: input.addr,
            fp: e.fingerprint,
            name: e.name,
            port: input.port,
        })
    }
}

/// `node` 동작의 입력이다. Go 는 `edge.Config` 로 푼다.
#[derive(Deserialize, Default)]
#[serde(default)]
struct NodeIn {
    enabled: bool,
    port: i64,
    bind: String,
    name: String,
    advertise: String,
}

/// 짝 맺기 요청 본문이다. Go `map[string]any` 와 같이 키 순서로 쓰고, 노드 포트가 닫혀 있으면
/// addr·port 를 싣지 않는다.
#[derive(Serialize)]
struct PairBody {
    #[serde(skip_serializing_if = "Option::is_none")]
    addr: Option<String>,
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    port: Option<i64>,
    proto: i64,
    token: String,
}

/// 상대 부르기의 실패를 로컬 API 의 답으로 옮긴다.
pub(crate) fn call_fail(err: &CallError) -> Response {
    match err {
        CallError::FingerprintMismatch => fail(
            StatusCode::BAD_GATEWAY,
            edge::CODE_FP_MISMATCH,
            &err.to_string(),
        ),
        CallError::Rejected => fail(
            StatusCode::BAD_GATEWAY,
            edge::CODE_REJECTED,
            &err.to_string(),
        ),
        CallError::Remote(re) if !re.code.is_empty() => fail(
            remote_status(re.status),
            remote_code(&re.code),
            &clean_remote_text(&re.message),
        ),
        _ => fail(
            StatusCode::BAD_GATEWAY,
            edge::CODE_UNREACHABLE,
            &err.to_string(),
        ),
    }
}

pub(crate) fn store_fail(err: &EdgeError) -> Response {
    let msg = err.to_string();
    match err {
        EdgeError::EdgeNotFound => fail(StatusCode::NOT_FOUND, edge::CODE_NOT_FOUND, &msg),
        EdgeError::Ambiguous => fail(StatusCode::BAD_REQUEST, edge::CODE_AMBIGUOUS, &msg),
        EdgeError::EdgeLimit => fail(StatusCode::BAD_REQUEST, CODE_BAD_REQUEST, &msg),
        EdgeError::SaveFailed => fail(StatusCode::INTERNAL_SERVER_ERROR, CODE_SAVE_FAILED, &msg),
        _ => fail(StatusCode::BAD_REQUEST, edge::CODE_CONFIG_INVALID, &msg),
    }
}

/// 상대의 4xx 는 그대로, 그 밖은 502 다.
fn remote_status(st: u16) -> StatusCode {
    match StatusCode::from_u16(st) {
        Ok(s) if s.is_client_error() => s,
        _ => StatusCode::BAD_GATEWAY,
    }
}

/// 아는 코드만 그대로 옮긴다. 모르는 코드는 거절이다.
fn remote_code(code: &str) -> &'static str {
    codes()
        .into_iter()
        .find(|c| *c == code)
        .unwrap_or(edge::CODE_REJECTED)
}

fn clean_remote_text(s: &str) -> String {
    dm_shared_termtext::cut(&dm_shared_termtext::strip(s), REMOTE_TEXT_MAX).to_string()
}
