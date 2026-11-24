//! 간선 계층 결선 (EDGE_MESH_SRS FR-EGM-21·23·25·31~33).

use std::sync::{Arc, Weak};

use http::StatusCode;
use otter_shared_edge::{self as edge, Config, Error as EdgeError, Identity, Target};
use otter_shared_edgemesh::{self as edgemesh, Conn, ErrorKind, Hello, Invite, Mesh};
use otter_shared_otterlog as otterlog;
use serde::Serialize;
use time::OffsetDateTime;
use tokio_util::sync::CancellationToken;

use crate::ops::{DEADLINE_EXCEEDED, Request, Response, call_fail, decode, fail, ok, store_fail};

/// Go `context.Canceled` 의 문구다.
const CONTEXT_CANCELED: &str = "context canceled";
use crate::{CODE_BAD_REQUEST, CODE_INTERNAL, Change, Node, NowFn, Ref, audit};

/// 보관할 받은 초대의 수다.
const MAX_INVITES: usize = 16;
/// 거절한 초대 id 를 기억하는 수다.
const MAX_REJECTED: usize = 256;

pub(crate) fn new_mesh(n: Weak<Node>, id: Identity, now: NowFn) -> Mesh {
    let mut o = edgemesh::Options::new(id);
    let w = n.clone();
    o.name = Some(Arc::new(move || {
        w.upgrade()
            .map(|n| n.store.config().name)
            .unwrap_or_default()
    }));
    let w = n.clone();
    o.hello = Some(Arc::new(move || {
        w.upgrade().map(|n| n.connect_hello()).unwrap_or_default()
    }));
    let w = n.clone();
    o.edges = Some(Arc::new(move || {
        w.upgrade()
            .map(|n| n.store.config().edges)
            .unwrap_or_default()
    }));
    let w = n.clone();
    o.dial = Some(Arc::new(move |t: Target| {
        let w = w.clone();
        Box::pin(async move {
            let Some(n) = w.upgrade() else {
                return Err(edge::CallError::Unreachable("node closed".into()));
            };
            let up = n
                .client
                .upgrade(&t, edgemesh::PATH, edgemesh::PROTO)
                .await?;
            Ok(Conn::new(Box::new(up)))
        })
    }));
    let w = n.clone();
    o.on_hello = Some(Arc::new(move |fp: &str, h: Hello, remote: &str| {
        if let Some(n) = w.upgrade() {
            n.on_hello(fp, &h, remote);
        }
    }));
    let w = n.clone();
    o.on_hello_sent = Some(Arc::new(move |fp: &str| {
        if let Some(n) = w.upgrade()
            && n.store.set_pending(fp, false) == Ok(true)
        {
            n.changed(Change::default());
        }
    }));
    let w = n.clone();
    o.on_invite = Some(Arc::new(move |inv: Invite| {
        if let Some(n) = w.upgrade() {
            n.on_invite(inv);
        }
    }));
    let w = n.clone();
    o.on_not_edge = Some(Arc::new(move |fp: &str| {
        if let Some(n) = w.upgrade() {
            n.forget(fp);
        }
    }));
    o.on_changed = Some(Arc::new(move || {
        if let Some(n) = n.upgrade() {
            n.changed(Change::default());
        }
    }));
    o.now = Some(now);
    Mesh::new(o)
}

#[derive(Serialize)]
pub(crate) struct MeshNode {
    fp: String,
    name: String,
    tag: String,
    online: bool,
    #[serde(rename = "self")]
    self_: bool,
    edge: bool,
}

#[derive(Serialize)]
pub(crate) struct MeshView {
    nodes: Vec<MeshNode>,
    links: Vec<[String; 2]>,
}

#[derive(Serialize)]
pub(crate) struct InvitedRow {
    id: String,
    from: String,
    name: String,
    tag: String,
    #[serde(with = "otter_gocompat::time::json_time")]
    expires: OffsetDateTime,
}

impl Node {
    pub fn mesh(&self) -> Option<&Mesh> {
        self.mesh.as_ref()
    }

    /// 간선 계층을 돌린다. cancel 까지 돈다.
    pub async fn run(&self, cancel: CancellationToken) {
        if let Some(m) = &self.mesh {
            m.run(cancel).await;
        }
    }

    pub fn close(&self) {
        if let Some(m) = &self.mesh {
            m.close();
        }
    }

    pub(crate) fn drop_link(&self, fp: &str) {
        if let Some(m) = &self.mesh {
            m.drop_link(fp);
        }
    }

    /// 연결이 열릴 때 보낼 직접 정보다. 노드 포트가 닫혀 있으면 이름만이다.
    fn connect_hello(&self) -> Hello {
        let cfg = self.store.config();
        let mut h = Hello {
            name: cfg.name,
            ..Hello::default()
        };
        if cfg.enabled && self.port_status().listening {
            (h.addr, h.port) = (cfg.advertise, cfg.port);
        }
        h
    }

    fn on_hello(&self, fp: &str, h: &Hello, remote_host: &str) {
        match self
            .store
            .apply_hello(fp, &h.name, &h.addr, h.port, remote_host)
        {
            Ok(true) => self.changed(Change::default()),
            Ok(false) | Err(EdgeError::EdgeNotFound) => {}
            Err(e) => otterlog::info(None, &format!("edge hello: {e}"), &[]),
        }
    }

    /// 이름이나 알릴 주소가 바뀌었으면 간선들에 알린다 (FR-EGM-23).
    pub(crate) async fn announce_change(&self, before: &Config, after: &Config) {
        let Some(m) = &self.mesh else {
            return;
        };
        let renamed = before.name != after.name;
        let moved = after.enabled
            && (!before.enabled
                || before.port != after.port
                || before.advertise != after.advertise);
        if !renamed && !moved {
            return;
        }
        if let Err(e) = self.store.set_pending_all() {
            otterlog::info(None, &format!("edge pending: {e}"), &[]);
        }
        if renamed {
            m.announce();
        }
        let mut h = Hello {
            name: after.name.clone(),
            ..Hello::default()
        };
        if after.enabled {
            (h.addr, h.port) = (after.advertise.clone(), after.port);
        }
        m.hello_all(&h, edgemesh::HELLO_WAIT).await;
        self.changed(Change::default());
    }

    pub(crate) async fn op_notify(&self, req: &Request, deadline: &CancellationToken) -> Response {
        #[derive(serde::Deserialize, Default)]
        #[serde(default)]
        struct In {
            fp: String,
        }
        let input: In = match decode(&req.args) {
            Ok(v) => v,
            Err(r) => return r,
        };
        let Some(m) = &self.mesh else {
            return mesh_unavailable();
        };
        let e = match self.store.resolve(&input.fp) {
            Ok(e) => e,
            Err(err) => return store_fail(&err),
        };
        if let Err(err) = m.notify(deadline, &e.fingerprint).await {
            let err = deadline_cause(err, deadline);
            match err.kind() {
                ErrorKind::AddrUnknown => {
                    return fail(
                        StatusCode::CONFLICT,
                        edge::CODE_ADDR_UNKNOWN,
                        &err.to_string(),
                    );
                }
                ErrorKind::Outdated => {
                    return fail(
                        StatusCode::BAD_GATEWAY,
                        edge::CODE_PEER_OUTDATED,
                        &err.to_string(),
                    );
                }
                _ => {
                    audit("out", &e.name, "notify", StatusCode::BAD_GATEWAY);
                    return mesh_call_fail(&err);
                }
            }
        }
        audit("out", &e.name, "notify", StatusCode::OK);
        #[derive(Serialize)]
        struct Out {
            fp: String,
            name: String,
            notified: bool,
            tag: String,
        }
        ok(&Out {
            tag: edge::tag(&e.fingerprint),
            fp: e.fingerprint,
            name: e.name,
            notified: true,
        })
    }

    pub(crate) fn mesh_view(&self) -> Option<MeshView> {
        let m = self.mesh.as_ref()?;
        let mv = m.view();
        let nodes = mv
            .nodes
            .into_iter()
            .map(|x| MeshNode {
                tag: edge::tag(&x.fp),
                edge: !x.self_ && self.store.is_edge(&x.fp),
                fp: x.fp,
                name: x.name,
                online: x.online,
                self_: x.self_,
            })
            .collect();
        Some(MeshView {
            nodes,
            links: mv.links,
        })
    }

    fn live_invites(&self, st: &mut crate::InviteState) {
        let now = (self.now)();
        st.invites.retain(|inv| now < inv.expires);
        st.rejected.retain(|_, exp| now < *exp);
    }

    pub(crate) fn invited_rows(&self) -> Vec<InvitedRow> {
        let mut st = self.inv();
        self.live_invites(&mut st);
        st.invites
            .iter()
            .map(|inv| InvitedRow {
                id: inv.id.clone(),
                from: inv.from.clone(),
                name: inv.name.clone(),
                tag: edge::tag(&inv.from),
                expires: inv.expires,
            })
            .collect()
    }

    /// 이 노드에게 온 간선 초대다. 이미 간선이거나 거절한 초대는 버린다. 보낸 노드마다 하나만 둔다.
    pub(crate) fn on_invite(&self, inv: Invite) {
        if self.store.is_edge(&inv.from) {
            return;
        }
        let r = Ref {
            fp: inv.from.clone(),
            name: inv.name.clone(),
        };
        {
            let mut st = self.inv();
            self.live_invites(&mut st);
            if st.rejected.contains_key(&inv.id) {
                return;
            }
            st.invites.retain(|x| x.from != inv.from);
            if st.invites.len() >= MAX_INVITES {
                st.invites.remove(0);
            }
            st.invites.push(inv);
        }
        self.changed(Change {
            invited: Some(r),
            ..Change::default()
        });
    }

    fn take_invite(&self, id: &str, remove: bool) -> Option<Invite> {
        let mut st = self.inv();
        self.live_invites(&mut st);
        let i = st.invites.iter().position(|x| x.id == id)?;
        Some(if remove {
            st.invites.remove(i)
        } else {
            st.invites[i].clone()
        })
    }

    pub(crate) fn op_invite_send(&self, req: &Request) -> Response {
        #[derive(serde::Deserialize, Default)]
        #[serde(default)]
        struct In {
            to: String,
        }
        let input: In = match decode(&req.args) {
            Ok(v) => v,
            Err(r) => return r,
        };
        let Some(m) = &self.mesh else {
            return mesh_unavailable();
        };
        if input.to == self.id.fingerprint {
            return fail(
                StatusCode::BAD_REQUEST,
                CODE_BAD_REQUEST,
                "cannot invite this node",
            );
        }
        let Some(target) = m
            .nodes()
            .into_iter()
            .rfind(|x| x.fp == input.to && x.online)
        else {
            return fail(
                StatusCode::NOT_FOUND,
                edge::CODE_NOT_FOUND,
                "no such online node",
            );
        };
        if self.store.is_edge(&input.to) {
            return fail(
                StatusCode::CONFLICT,
                edge::CODE_ALREADY_EDGE,
                "already an edge",
            );
        }
        if !self.port_status().listening {
            return fail(
                StatusCode::CONFLICT,
                edge::CODE_PORT_CLOSED,
                "node port is not listening",
            );
        }
        let cfg = self.store.config();
        if cfg.advertise.is_empty() {
            return fail(
                StatusCode::BAD_REQUEST,
                edge::CODE_ADDR_REQUIRED,
                "addr required",
            );
        }
        let (token, expires) = self.pairing.new_bound_invite(&input.to);
        let code = edge::encode_invite(&edge::InviteCode {
            addr: cfg.advertise,
            port: cfg.port,
            fingerprint: self.id.fingerprint.clone(),
            token,
        });
        if let Err(err) = m.send_invite(&input.to, &code, expires) {
            return match err.kind() {
                ErrorKind::UnknownNode => fail(
                    StatusCode::NOT_FOUND,
                    edge::CODE_NOT_FOUND,
                    &err.to_string(),
                ),
                ErrorKind::InviteFull => fail(
                    StatusCode::TOO_MANY_REQUESTS,
                    edge::CODE_RATE_LIMITED,
                    &err.to_string(),
                ),
                _ => fail(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    CODE_INTERNAL,
                    &err.to_string(),
                ),
            };
        }
        audit("out", &target.name, "invite", StatusCode::OK);
        #[derive(Serialize)]
        struct Out {
            #[serde(with = "otter_gocompat::time::json_time")]
            expires: OffsetDateTime,
            name: String,
            tag: String,
            to: String,
        }
        ok(&Out {
            expires,
            name: target.name,
            tag: edge::tag(&input.to),
            to: input.to,
        })
    }

    pub(crate) async fn op_invite_accept(
        &self,
        req: &Request,
        deadline: &CancellationToken,
    ) -> Response {
        let id = match decode::<IdIn>(&req.args) {
            Ok(v) => v.id,
            Err(r) => return r,
        };
        let Some(inv) = self.take_invite(&id, false) else {
            return fail(
                StatusCode::NOT_FOUND,
                edge::CODE_NOT_FOUND,
                "no such invite",
            );
        };
        let r = self.add_code(&inv.code, deadline).await;
        if r.code.is_empty() {
            self.take_invite(&id, true);
            self.changed(Change::default());
        }
        r
    }

    pub(crate) fn op_invite_reject(&self, req: &Request) -> Response {
        let id = match decode::<IdIn>(&req.args) {
            Ok(v) => v.id,
            Err(r) => return r,
        };
        let Some(inv) = self.take_invite(&id, true) else {
            return fail(
                StatusCode::NOT_FOUND,
                edge::CODE_NOT_FOUND,
                "no such invite",
            );
        };
        {
            let mut st = self.inv();
            if st.rejected.len() < MAX_REJECTED {
                st.rejected.insert(inv.id, inv.expires);
            }
        }
        self.changed(Change::default());
        ok(&crate::Empty {})
    }
}

#[derive(serde::Deserialize, Default)]
#[serde(default)]
struct IdIn {
    id: String,
}

fn mesh_unavailable() -> Response {
    fail(
        StatusCode::SERVICE_UNAVAILABLE,
        edge::CODE_UNAVAILABLE,
        "edge link unavailable",
    )
}

/// 간선 계층의 걸기 실패다. Go `callFail` 처럼 감싼 원인(`%w`)으로 가리고, 문구는 감싼 오류
/// 전체다. 원격 거절은 그 코드와 정리한 상대 문구로 답한다.
/// 간선 계층은 취소된 걸기를 `context canceled` 로 적는다. op 의 취소는 시한 초과뿐이므로 Go 처럼
/// `context deadline exceeded` 로 옮긴다.
fn deadline_cause(err: edgemesh::MeshError, deadline: &CancellationToken) -> edgemesh::MeshError {
    match err.call_error() {
        Some(edge::CallError::Unreachable(c))
            if deadline.is_cancelled() && c == CONTEXT_CANCELED =>
        {
            edgemesh::MeshError::with_call(
                err.kind(),
                edge::CallError::Unreachable(DEADLINE_EXCEEDED.to_string()),
            )
        }
        _ => err,
    }
}

pub(crate) fn mesh_call_fail(err: &edgemesh::MeshError) -> Response {
    let msg = err.to_string();
    match err.call_error() {
        Some(edge::CallError::FingerprintMismatch) => {
            fail(StatusCode::BAD_GATEWAY, edge::CODE_FP_MISMATCH, &msg)
        }
        Some(edge::CallError::Rejected) => fail(StatusCode::BAD_GATEWAY, edge::CODE_REJECTED, &msg),
        Some(ce @ edge::CallError::Remote(re)) if !re.code.is_empty() => call_fail(ce),
        _ => fail(StatusCode::BAD_GATEWAY, edge::CODE_UNREACHABLE, &msg),
    }
}
