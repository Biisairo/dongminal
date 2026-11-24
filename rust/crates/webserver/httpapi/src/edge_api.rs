//! 로컬 API `/api/edges/*`·`/api/profile` 과 노드 포트의 통로 (Go `edge_api.go`·`edge_node.go`·
//! `edge_relay.go`·`profile_api.go`, PEER_NETWORK_SRS FR-PNW-70, PEER_DAEMON_SRS §3.5a).
//!
//! 노드는 데몬이다 (DIRECT_MODE_REMOVAL_SRS FR-DMR-20). 요청 하나를 노드의 연산 하나로 넘기고 답을
//! 그대로 쓴다. 서버는 TLS 를 끝내지 않는다 — 노드 포트로 받은 연결은 데몬의 노드 소켓에 잇는다.

use std::sync::{Arc, Mutex, PoisonError};

use http::{HeaderValue, StatusCode};
use otter_gocompat::json::{self, RawMessage};
use otter_shared_edgerelay as edgerelay;
use otter_shared_httpresp::Response;
use otter_shared_otterlog::infof;
use otter_shared_toolipc::{EdgeParams, EdgePortParams, EdgeRef, EdgeResult, EdgesEvent};
use otter_webserver_apierr as apierr;
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::Server;
use crate::chat_api::raw_json;
use crate::httperr::{JSON_BODY_LIMIT, code_fail, mark};
use crate::req::Req;
use crate::tools_api::off_thread;

/// Go `EdgeDaemon`: 데몬 노드의 접합면이다. 합성 루트가 toolclient 를 감싸 구현한다.
pub trait EdgeDaemon: Send + Sync {
    /// 데몬이 노드 기능을 말하는가다. 부를 때마다 묻는다 (FR-PDM-50·51).
    fn edge_ready(&self) -> bool;
    /// 오류 문구는 Go `err.Error()` 다.
    fn edge(&self, p: EdgeParams) -> Result<EdgeResult, String>;
    fn edge_port(&self, p: EdgePortParams) -> Result<(), String>;
}

/// Go `handleCache`: 핸들을 기억한다. 노드 설정이 바뀌면(edges_changed) 버린다. gen 은 묻는 동안
/// 버려졌으면 옛 답을 기억하지 않게 한다 (PROFILE_NAME_SRS NFR-PFN-3).
#[derive(Default)]
pub(crate) struct HandleCache(Mutex<(String, u64)>);

impl HandleCache {
    fn lock(&self) -> std::sync::MutexGuard<'_, (String, u64)> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn invalidate(&self) {
        let mut g = self.lock();
        g.0.clear();
        g.1 += 1;
    }
}

/// 노드 포트를 다시 맞추라는 신호의 자리다 (Go `edgeKick`).
#[derive(Default)]
pub(crate) struct EdgeKick(Mutex<Option<mpsc::Sender<()>>>);

/// Go `edgenode.Ref`.
struct Ref {
    fp: String,
    name: String,
}

/// Go `edgenode.Change`.
#[derive(Default)]
struct Change {
    paired: Option<Ref>,
    removed: Option<Ref>,
    by_peer: bool,
    invited: Option<Ref>,
}

/// Go `taggedRef`: 방송의 간선에 번호를 얹는다. 화면은 번호를 계산하지 않는다 (NFR-PFN-1).
#[derive(Serialize)]
struct TaggedRef {
    fp: String,
    name: String,
    tag: String,
}

fn tagged(r: &Ref) -> TaggedRef {
    TaggedRef {
        fp: r.fp.clone(),
        name: r.name.clone(),
        tag: otter_shared_edge::tag(&r.fp),
    }
}

/// edges_changed 의 인자다. Go 는 map 이라 키가 이름 순이다.
#[derive(Serialize)]
struct ChangedArgs {
    #[serde(rename = "byPeer", skip_serializing_if = "std::ops::Not::not")]
    by_peer: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    invited: Option<TaggedRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    paired: Option<TaggedRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    removed: Option<TaggedRef>,
}

fn to_ref(r: &Option<EdgeRef>) -> Option<Ref> {
    r.as_ref().map(|r| Ref {
        fp: r.fp.clone(),
        name: r.name.clone(),
    })
}

/// Go `writeEdgeResponse`: 노드의 답을 그대로 쓴다. ETag 는 오류(409 포함)에도 싣는다.
fn write_edge_response(res: &EdgeResult) -> Response {
    let status = u16::try_from(res.status)
        .ok()
        .and_then(|s| StatusCode::from_u16(s).ok())
        .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    let mut out = if res.code.is_empty() {
        raw_json(status, &res.body.0)
    } else {
        code_fail(status, &res.code, &res.message)
    };
    if !res.etag.is_empty()
        && let Ok(v) = HeaderValue::from_str(&res.etag)
    {
        out.headers_mut().insert(http::header::ETAG, v);
    }
    out
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct NodeConf {
    node: NodeFields,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct NodeFields {
    enabled: bool,
    bind: String,
    port: i64,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct HandleBody {
    handle: String,
}

impl Server {
    /// Go `edgesChanged`: 간선 상태가 바뀐 **뒤에** 화면에 알린다. 상태는 `edges` 토픽, 알림은
    /// `edges.notice` 사건이다 (FR-PNW-81, CHANNEL_PROTOCOL C2b). 맺거나 지운 간선은 `{fp, name, tag}` 로 싣는다 (EDGE_PAIRING_SRS FR-EPR-5·23).
    fn edges_changed(&self, c: &Change) {
        self.handle.invalidate();
        let args = ChangedArgs {
            by_peer: c.removed.is_some() && c.by_peer,
            invited: c.invited.as_ref().map(tagged),
            paired: c.paired.as_ref().map(tagged),
            removed: c.removed.as_ref().map(tagged),
        };
        self.refresh_state_topic("edges");
        if args.by_peer || args.invited.is_some() || args.paired.is_some() || args.removed.is_some()
        {
            self.topics.publish_event(
                "edges.notice",
                serde_json::to_value(&args).unwrap_or_default(),
            );
        }
    }

    /// Go `edgeDo`: 연산 op 하나를 처리한다. with_body 면 요청 본문을 Args 로 넘긴다.
    async fn edge_do(&self, r: &mut Req, op: &str, with_body: bool) -> Response {
        let Some(d) = self.deps.edge_daemon.clone() else {
            return code_fail(
                StatusCode::SERVICE_UNAVAILABLE,
                apierr::CODE_EDGE_UNAVAILABLE,
                "edge layer unavailable",
            );
        };
        let ready = {
            let d = d.clone();
            off_thread(move || d.edge_ready()).await.unwrap_or(false)
        };
        if !ready {
            return code_fail(
                StatusCode::CONFLICT,
                apierr::CODE_EDGE_DAEMON_RESTART,
                "restart the daemon to use edges",
            );
        }
        let mut p = EdgeParams {
            op: op.to_owned(),
            if_match: r.header("If-Match"),
            ..EdgeParams::default()
        };
        if with_body {
            match r.read_body(JSON_BODY_LIMIT).await {
                Ok(b) => p.args = RawMessage(b.to_vec()),
                Err(e) => {
                    return mark(
                        &e,
                        code_fail(
                            otter_shared_httpreq::status(&e),
                            apierr::body_read_code(&e),
                            "read body",
                        ),
                    );
                }
            }
        }
        match off_thread(move || d.edge(p)).await {
            Some(Ok(res)) => write_edge_response(&res),
            Some(Err(e)) => code_fail(
                StatusCode::BAD_GATEWAY,
                apierr::CODE_EDGE_UNREACHABLE,
                &format!("daemon: {e}"),
            ),
            None => code_fail(
                StatusCode::INTERNAL_SERVER_ERROR,
                apierr::CODE_INTERNAL,
                "internal error",
            ),
        }
    }

    pub(crate) async fn api_edges_get(&self, r: &mut Req) -> Response {
        self.edge_do(r, "get", false).await
    }

    /// 노드 설정을 바꾸고 노드 포트에 바로 적용한다 (FR-PNW-8, I-8).
    pub(crate) async fn api_edges_node_put(&self, r: &mut Req) -> Response {
        self.edge_do(r, "node", true).await
    }

    pub(crate) async fn api_edges_invite(&self, r: &mut Req) -> Response {
        self.edge_do(r, "invite", true).await
    }

    pub(crate) async fn api_edges_add(&self, r: &mut Req) -> Response {
        self.edge_do(r, "add", true).await
    }

    pub(crate) async fn api_edges_remove(&self, r: &mut Req) -> Response {
        self.edge_do(r, "remove", true).await
    }

    pub(crate) async fn api_edges_address(&self, r: &mut Req) -> Response {
        self.edge_do(r, "address", true).await
    }

    /// EDGE_MESH_SRS §3.7 — 수동 알리기와 간선 초대.
    pub(crate) async fn api_edges_notify(&self, r: &mut Req) -> Response {
        self.edge_do(r, "notify", true).await
    }

    pub(crate) async fn api_edges_invite_send(&self, r: &mut Req) -> Response {
        self.edge_do(r, "invite_send", true).await
    }

    pub(crate) async fn api_edges_invite_accept(&self, r: &mut Req) -> Response {
        self.edge_do(r, "invite_accept", true).await
    }

    pub(crate) async fn api_edges_invite_reject(&self, r: &mut Req) -> Response {
        self.edge_do(r, "invite_reject", true).await
    }

    /// `/api/profile` (PROFILE_NAME_SRS §3.2). 이름은 노드 설정에 있으므로 노드의 연산으로 넘긴다.
    pub(crate) async fn api_profile_get(&self, r: &mut Req) -> Response {
        self.edge_do(r, "profile", false).await
    }

    pub(crate) async fn api_profile_put(&self, r: &mut Req) -> Response {
        self.edge_do(r, "profile_name", true).await
    }

    /// Go `profileHandle`: 이 기기의 `이름#번호` 다. 노드가 없거나 답하지 못하면 빈 값이고, 그 결과는
    /// 기억하지 않는다. 데몬 RPC 를 부를 수 있으므로 블로킹이다.
    pub(crate) fn profile_handle(&self) -> String {
        let (v, gen_) = self.handle.lock().clone();
        if !v.is_empty() {
            return v;
        }
        let v = self.ask_handle();
        if !v.is_empty() {
            let mut g = self.handle.lock();
            if g.1 == gen_ {
                g.0 = v.clone();
            }
        }
        v
    }

    /// Go `askHandle`: 노드(데몬)에 핸들을 묻는다. 데몬이 없거나 준비되지 않았으면 빈 값이다
    /// (FR-DMR-23).
    fn ask_handle(&self) -> String {
        let Some(d) = &self.deps.edge_daemon else {
            return String::new();
        };
        if !d.edge_ready() {
            return String::new();
        }
        let res = match d.edge(EdgeParams {
            op: "profile".to_owned(),
            ..EdgeParams::default()
        }) {
            Ok(res) if res.code.is_empty() => res,
            _ => return String::new(),
        };
        json::unmarshal::<HandleBody>(&res.body.0)
            .map(|v| v.handle)
            .unwrap_or_default()
    }

    /// Go `StartEdge`: 노드 포트의 통로를 열고, stop 이 취소되면 닫는다. 돌려준 task 는 닫기가 끝나면
    /// 끝난다. 데몬이 배선되지 않았거나 노드 기능을 모르면 아무것도 열지 않는다. tokio 런타임 안에서
    /// 부른다.
    pub fn start_edge(&self, stop: CancellationToken) -> tokio::task::JoinHandle<()> {
        let Some(d) = self.deps.edge_daemon.clone() else {
            return tokio::spawn(async {});
        };
        let home = self.cfg.data_dir.clone();
        if home.as_os_str().is_empty() || !d.edge_ready() {
            return tokio::spawn(async {});
        }
        let dial = match edgerelay::serve_dial(&edgerelay::dial_socket_path(&home)) {
            Ok(s) => Some(s),
            Err(e) => {
                infof!(None, "edge relay: 발신 소켓을 열지 못했다: {e}");
                None
            }
        };
        let port = Arc::new(edgerelay::Port::new(edgerelay::node_socket_path(&home)));
        let (tx, mut rx) = mpsc::channel::<()>(1);
        let _ = tx.try_send(());
        *self
            .edge_kick
            .0
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = Some(tx);
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = stop.cancelled() => {
                        port.close();
                        if let Some(s) = &dial {
                            s.close();
                        }
                        return;
                    }
                    Some(()) = rx.recv() => apply_edge_port(&d, &port).await,
                }
            }
        })
    }

    /// Go `kickEdge`: 노드 포트를 다시 맞추라고 알린다. 막지 않는다 — push 콜백에서 부른다.
    fn kick_edge(&self) {
        if let Some(tx) = &*self
            .edge_kick
            .0
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
        {
            let _ = tx.try_send(());
        }
    }

    /// Go `EdgePushed`: 데몬의 edges push 다 (FR-PDM-27). 같은 인자로 edges_changed 를 방송하고 노드
    /// 포트를 다시 맞춘다. 데몬 RPC 를 기다리지 않는다.
    pub fn edge_pushed(&self, ev: &EdgesEvent) {
        self.edges_changed(&Change {
            paired: to_ref(&ev.paired),
            removed: to_ref(&ev.removed),
            by_peer: ev.by_peer,
            invited: to_ref(&ev.invited),
        });
        self.kick_edge();
    }

    /// Go `EdgeResync`: 데몬에 다시 붙은 뒤다 (FR-PDM-33). 붙지 않은 동안의 push 는 잃었으므로 화면이
    /// 다시 읽게 하고 노드 포트를 다시 맞춘다.
    pub fn edge_resync(&self) {
        self.edges_changed(&Change::default());
        self.kick_edge();
    }
}

/// Go `applyEdgePort`: 데몬의 노드 설정대로 노드 포트를 열거나 닫고, 그 상태를 데몬에 알린다
/// (FR-PDM-14·33). 데몬에 닿지 않으면 지금 상태를 둔다 — 다시 붙으면 다시 부른다.
async fn apply_edge_port(d: &Arc<dyn EdgeDaemon>, port: &edgerelay::Port) {
    let ask = d.clone();
    let got = off_thread(move || {
        if !ask.edge_ready() {
            return None;
        }
        Some(ask.edge(EdgeParams {
            op: "get".to_owned(),
            ..EdgeParams::default()
        }))
    })
    .await
    .flatten();
    let res = match got {
        None => {
            port.apply(false, "", 0);
            return;
        }
        Some(Ok(res)) if res.code.is_empty() => res,
        Some(Ok(res)) => {
            infof!(
                None,
                "edge relay: 노드 설정을 읽지 못했다: <nil> {}",
                res.code
            );
            return;
        }
        Some(Err(e)) => {
            infof!(None, "edge relay: 노드 설정을 읽지 못했다: {e} ");
            return;
        }
    };
    let v: NodeConf = match json::unmarshal(&res.body.0) {
        Ok(v) => v,
        Err(e) => {
            infof!(None, "edge relay: 노드 설정을 풀지 못했다: {e}");
            return;
        }
    };
    port.apply(v.node.enabled, &v.node.bind, v.node.port);
    let st = port.status();
    let p = EdgePortParams {
        listening: st.listening,
        addr: st.addr,
        error: st.err,
    };
    let tell = d.clone();
    if let Some(Err(e)) = off_thread(move || tell.edge_port(p)).await {
        infof!(None, "edge relay: 노드 포트 상태를 알리지 못했다: {e}");
    }
}
