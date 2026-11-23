//! Go edgenode 시험(node·pairing·mesh·profile·fail·edge_limit)을 옮긴다.

use std::collections::BTreeMap;
use std::ops::Deref;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use dm_gocompat::json::{self, RawMessage};
use dm_shared_edge::{CallError, Client, Config, Edge, Listener, MAX_EDGES, Target, tag};
use dm_shared_edgemesh::{Invite, PATH, PROTO};
use http::StatusCode;
use serde::Deserialize;
use tempfile::TempDir;

use super::*;

const PORT_MIN: u16 = 60147;
const PORT_MAX: u16 = 64999;

/// 이 프로세스가 이미 내준 포트는 다시 내주지 않는다 — 같은 프로세스의 병렬 시험이 같은 포트를
/// 고르지 않게 한다.
static HANDED_OUT: Mutex<Vec<u16>> = Mutex::new(Vec::new());

/// 빈 것으로 보이는 포트다. 확인과 실제 열기 사이에 다른 프로세스가 가져갈 수 있다 — 그 경우는
/// [`new_test_node`] 가 다른 포트로 다시 세운다.
fn free_port() -> i64 {
    let span = PORT_MAX - PORT_MIN;
    let start = rand::random::<u16>() % span;
    let mut used = HANDED_OUT.lock().unwrap();
    let p = (0..span)
        .map(|i| PORT_MIN + (start + i) % span)
        .find(|p| !used.contains(p) && std::net::TcpListener::bind(("127.0.0.1", *p)).is_ok())
        .expect("빈 포트가 없다");
    used.push(p);
    i64::from(p)
}

/// 포트를 빼앗겼을 때 다시 세우는 횟수다.
const NODE_TRIES: usize = 20;

struct TestNode {
    node: Arc<Node>,
    ln: Arc<OnceLock<Listener>>,
    notes: Arc<Mutex<Vec<Change>>>,
    _home: TempDir,
}

impl Deref for TestNode {
    type Target = Node;
    fn deref(&self) -> &Node {
        &self.node
    }
}

impl Drop for TestNode {
    fn drop(&mut self) {
        self.node.close();
        if let Some(l) = self.ln.get() {
            l.close();
        }
    }
}

/// 노드와 그 포트의 듣는 자리를 세운다. 고른 포트를 다른 프로세스가 먼저 열었으면(부하 아래
/// 워크스페이스 전체 시험) 다른 포트로 다시 세운다.
fn new_test_node(name: &str, mesh: bool) -> TestNode {
    let mut last = None;
    for _ in 0..NODE_TRIES {
        match try_test_node(name, mesh) {
            Ok(n) => return n,
            Err(st) => last = Some(st),
        }
    }
    panic!("노드 포트를 열지 못했다: {last:?}");
}

fn try_test_node(name: &str, mesh: bool) -> Result<TestNode, dm_shared_edge::Status> {
    let home = TempDir::new().unwrap();
    let cfg = Config {
        enabled: true,
        port: free_port(),
        bind: "127.0.0.1".into(),
        name: name.into(),
        advertise: "127.0.0.1".into(),
        edges: Vec::new(),
    };
    std::fs::write(
        home.path().join(dmenv::EDGES_FILE),
        json::marshal(&cfg).unwrap(),
    )
    .unwrap();
    let ln: Arc<OnceLock<Listener>> = Arc::default();
    let notes: Arc<Mutex<Vec<Change>>> = Arc::default();
    let (l1, l2, n1) = (ln.clone(), ln.clone(), notes.clone());
    let node = Node::new(Options {
        home: home.path().to_path_buf(),
        hostname: name.into(),
        mesh,
        port_status: Some(Arc::new(move || {
            l1.get().map(Listener::status).unwrap_or_default()
        })),
        on_config: Some(Arc::new(move |c: &Config| {
            if let Some(l) = l2.get() {
                l.apply(c);
            }
        })),
        notify: Some(Arc::new(move |c| n1.lock().unwrap().push(c))),
        ..Options::default()
    })
    .unwrap();
    let l = Listener::new(node.identity(), node.admission(), node.handler()).unwrap();
    l.apply(&node.config());
    let st = l.status();
    let _ = ln.set(l);
    let n = TestNode {
        node,
        ln,
        notes,
        _home: home,
    };
    if st.listening { Ok(n) } else { Err(st) }
}

fn plain(name: &str) -> TestNode {
    new_test_node(name, false)
}

fn meshed(name: &str) -> TestNode {
    new_test_node(name, true)
}

impl TestNode {
    async fn op<A: serde::Serialize>(&self, op: &str, args: &A) -> OpResponse {
        self.do_op(OpRequest {
            op: op.into(),
            args: json::marshal(args).unwrap(),
            if_match: String::new(),
        })
        .await
    }

    fn changes(&self) -> Vec<Change> {
        self.notes.lock().unwrap().clone()
    }

    fn last_with(&self, f: impl Fn(&Change) -> bool) -> Option<Change> {
        self.changes().into_iter().rev().find(f)
    }

    fn fp(&self) -> String {
        self.identity().fingerprint.clone()
    }

    fn target(&self) -> Target {
        let addr = self.ln.get().unwrap().status().addr;
        let (h, p) = addr.rsplit_once(':').unwrap();
        Target {
            addr: h.into(),
            port: p.parse().unwrap(),
            fingerprint: self.fp(),
        }
    }

    fn port_listening(&self) -> bool {
        self.ln.get().unwrap().status().listening
    }
}

type Map = BTreeMap<String, RawMessage>;

fn body(r: &OpResponse) -> Map {
    json::unmarshal(&r.body)
        .unwrap_or_else(|e| panic!("body {:?}: {e}", String::from_utf8_lossy(&r.body)))
}

fn s(m: &Map, k: &str) -> String {
    m.get(k)
        .and_then(|v| json::unmarshal::<String>(&v.0).ok())
        .unwrap_or_default()
}

fn b(m: &Map, k: &str) -> Option<bool> {
    m.get(k).and_then(|v| json::unmarshal::<bool>(&v.0).ok())
}

fn args(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
    pairs
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
}

async fn invite_code(n: &TestNode) -> String {
    let inv = n.op("invite", &args(&[])).await;
    assert_eq!(inv.status, StatusCode::OK, "{inv:?}");
    s(&body(&inv), "code")
}

async fn pair_nodes(a: &TestNode, b: &TestNode) {
    let code = invite_code(b).await;
    let add = a.op("add", &args(&[("code", &code)])).await;
    assert_eq!(add.status, StatusCode::OK, "{add:?}");
}

async fn close_port(n: &TestNode) {
    let mut cfg = n.config();
    cfg.enabled = false;
    let r = n.op("node", &cfg).await;
    assert_eq!(r.status, StatusCode::OK, "{r:?}");
}

async fn eventually(what: &str, mut cond: impl AsyncFnMut() -> bool) {
    for _ in 0..500 {
        if cond().await {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("{what}: 시간 안에 이뤄지지 않았다");
}

#[derive(Deserialize, Default, Debug)]
#[serde(default)]
struct MeshGet {
    edges: Vec<EdgeRow>,
    mesh: Option<MeshRows>,
    invites: Option<Vec<InviteRow>>,
}

#[derive(Deserialize, Default, Debug)]
#[serde(default)]
struct EdgeRow {
    fp: String,
    name: String,
    pending: bool,
    linked: bool,
    outdated: bool,
    tag: String,
}

#[derive(Deserialize, Default, Debug)]
#[serde(default)]
struct MeshRows {
    nodes: Vec<NodeRow>,
    links: Vec<[String; 2]>,
}

#[derive(Deserialize, Default, Debug)]
#[serde(default)]
struct NodeRow {
    fp: String,
    name: String,
    tag: String,
    online: bool,
    #[serde(rename = "self")]
    self_: bool,
    edge: bool,
}

#[derive(Deserialize, Default, Debug)]
#[serde(default)]
struct InviteRow {
    id: String,
    from: String,
    name: String,
    tag: String,
}

async fn get_view(n: &TestNode) -> MeshGet {
    let r = n.op("get", &()).await;
    json::unmarshal(&r.body).unwrap()
}

async fn edge_state(n: &TestNode, fp: &str) -> EdgeRow {
    get_view(n)
        .await
        .edges
        .into_iter()
        .find(|e| e.fp == fp)
        .unwrap_or_default()
}

async fn notify(from: &TestNode, to: &TestNode) -> OpResponse {
    from.op("notify", &args(&[("fp", &to.fp())])).await
}

// ---- node_test.go ----

#[tokio::test(flavor = "multi_thread")]
async fn pair_via_do() {
    let (a, b) = (plain("node-a"), plain("node-b"));
    pair_nodes(&a, &b).await;
    assert!(a.store().is_edge(&b.fp()) && b.store().is_edge(&a.fp()));
    let e = b.store().resolve(&a.fp()).unwrap();
    assert!(e.addr == "127.0.0.1" && e.port == a.config().port, "{e:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn get_and_stale_node() {
    let n = plain("node-a");
    let g = n.op("get", &()).await;
    assert!(g.status == StatusCode::OK && !g.etag.is_empty());
    let mut cfg = n.config();
    cfg.name = "renamed".into();
    let raw = json::marshal(&cfg).unwrap();
    let req = OpRequest {
        op: "node".into(),
        args: raw,
        if_match: g.etag.clone(),
    };
    assert_eq!(n.do_op(req.clone()).await.status, StatusCode::OK);
    let r = n.do_op(req).await;
    assert!(
        r.status == StatusCode::CONFLICT && r.code == CODE_STALE_REV && !r.etag.is_empty(),
        "{r:?}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn unknown_op_and_bad_json() {
    let n = plain("node-a");
    let r = n
        .do_op(OpRequest {
            op: "nope".into(),
            ..OpRequest::default()
        })
        .await;
    assert!(r.status == StatusCode::NOT_FOUND && r.code == CODE_NOT_FOUND);
    let r = n
        .do_op(OpRequest {
            op: "add".into(),
            args: b"{".to_vec(),
            ..OpRequest::default()
        })
        .await;
    assert!(r.status == StatusCode::BAD_REQUEST && r.code == CODE_INVALID_JSON);
    for op in ["pending", "approve", "reject"] {
        assert_eq!(
            n.op(op, &args(&[])).await.status,
            StatusCode::NOT_FOUND,
            "{op}"
        );
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn config_applies_port() {
    let n = plain("node-a");
    close_port(&n).await;
    assert!(!n.port_listening());
}

/// 노드 포트는 `/edge/v1/*` 의 맺기·지우기·간선 연결만 받는다. 나머지는 404 `{code,message}` 다.
#[tokio::test(flavor = "multi_thread")]
async fn handler_only_edge_paths() {
    let (a, b) = (plain("node-a"), plain("node-b"));
    pair_nodes(&a, &b).await;
    let cl = Client::new(a.identity().clone());
    for p in [
        "/",
        "/index.html",
        "/api/tools",
        "/api/edges",
        "/ws",
        "/edge",
        "/edge/v2/node.info",
        "/peer/v1/pair",
        "/edge/v1/nope",
    ] {
        let err = cl.call_raw(&b.target(), p, &()).await.unwrap_err();
        let CallError::Remote(re) = err else {
            panic!("{p}: {err:?}")
        };
        assert!(
            re.status == 404 && re.code == CODE_NOT_FOUND && !re.message.is_empty(),
            "{p}: {re:?}"
        );
    }
    // GET 의 pair 도 404 다(POST 만 받는다).
    let err = cl
        .upgrade(&b.target(), "/edge/v1/pair", "x")
        .await
        .err()
        .unwrap();
    assert!(
        matches!(err, CallError::Remote(ref re) if re.status == 404),
        "{err:?}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn new_migrates_legacy_file() {
    let home = TempDir::new().unwrap();
    std::fs::write(
        home.path().join(dmenv::LEGACY_PEERS_FILE),
        br#"{"name":"moved"}"#,
    )
    .unwrap();
    std::fs::write(home.path().join(LEGACY_SPAWNS_FILE), b"{}").unwrap();
    let n = Node::new(Options {
        home: home.path().to_path_buf(),
        hostname: "h".into(),
        ..Options::default()
    })
    .unwrap();
    assert!(!home.path().join(dmenv::LEGACY_PEERS_FILE).exists());
    assert!(!home.path().join(LEGACY_SPAWNS_FILE).exists());
    assert_eq!(n.config().name, "moved");
}

// ---- pairing_test.go ----

#[tokio::test(flavor = "multi_thread")]
async fn pair_in_one_step() {
    let (a, b) = (plain("node-a"), plain("node-b"));
    close_port(&a).await;
    let add = a
        .op("add", &args(&[("code", &invite_code(&b).await)]))
        .await;
    assert_eq!(add.status, StatusCode::OK, "{add:?}");
    let got = body(&add);
    assert!(
        s(&got, "fp") == b.fp() && s(&got, "name") == "node-b" && s(&got, "tag") == tag(&b.fp())
    );
    assert!(a.store().is_edge(&b.fp()) && b.store().is_edge(&a.fp()));
    let p = b.last_with(|c| c.paired.is_some()).unwrap().paired.unwrap();
    assert!(p.fp == a.fp() && p.name == "node-a");
    assert_eq!(
        a.last_with(|c| c.paired.is_some())
            .unwrap()
            .paired
            .unwrap()
            .fp,
        b.fp()
    );
    let e = b.store().resolve(&a.fp()).unwrap();
    assert!(
        e.addr.is_empty() && e.port == 0,
        "닫힌 포트의 주소를 알았다: {e:?}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn pair_retry_and_stranger() {
    let (a, b, c) = (plain("node-a"), plain("node-b"), plain("node-c"));
    let code = invite_code(&b).await;
    assert_eq!(
        a.op("add", &args(&[("code", &code)])).await.status,
        StatusCode::OK
    );
    assert_eq!(
        a.op("add", &args(&[("code", &code)])).await.status,
        StatusCode::OK
    );
    let r = c.op("add", &args(&[("code", &code)])).await;
    assert!(
        r.status == StatusCode::FORBIDDEN && r.code == edge::CODE_NO_INVITE,
        "{r:?}"
    );
    assert_eq!(b.config().edges.len(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn repair_keeps_helper_key() {
    let (a, b) = (plain("node-a"), plain("node-b"));
    pair_nodes(&a, &b).await;
    a.store().pin_helper(&b.fp(), "K").unwrap();
    pair_nodes(&a, &b).await;
    let e = a.store().resolve(&b.fp()).unwrap();
    assert!(e.helper_key == "K" && a.config().edges.len() == 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn remove_both_sides() {
    let (a, b) = (plain("node-a"), plain("node-b"));
    pair_nodes(&a, &b).await;
    let r = a.op("remove", &args(&[("fp", &b.fp()[..12])])).await;
    assert!(
        r.status == StatusCode::OK && b_(&r, "notified") == Some(true),
        "{r:?}"
    );
    assert!(!a.store().is_edge(&b.fp()) && !b.store().is_edge(&a.fp()));
    let rm = b.last_with(|c| c.removed.is_some()).unwrap();
    assert!(rm.removed.unwrap().fp == a.fp() && rm.by_peer);
    assert!(!a.last_with(|c| c.removed.is_some()).unwrap().by_peer);
}

fn b_(r: &OpResponse, k: &str) -> Option<bool> {
    b(&body(r), k)
}

fn is_not_edge_err(r: Result<impl Sized, CallError>) -> bool {
    matches!(r, Err(ref e) if is_not_edge(e))
}

#[tokio::test(flavor = "multi_thread")]
async fn remove_while_off_then_reconcile() {
    let (a, b) = (meshed("node-a"), plain("node-b"));
    pair_nodes(&a, &b).await;
    close_port(&b).await;
    let r = a.op("remove", &args(&[("fp", &b.fp())])).await;
    assert!(
        r.status == StatusCode::OK && b_(&r, "notified") == Some(false),
        "{r:?}"
    );
    assert!(b.store().is_edge(&a.fp()));
    let up = Client::new(b.identity().clone())
        .upgrade(&a.target(), PATH, PROTO)
        .await;
    assert!(is_not_edge_err(up));
    b.forget(&a.fp());
    assert!(!b.store().is_edge(&a.fp()));
    let rm = b.last_with(|c| c.removed.is_some()).unwrap();
    assert!(rm.by_peer && rm.removed.unwrap().fp == a.fp());
}

#[tokio::test(flavor = "multi_thread")]
async fn non_edge_gets_not_edge() {
    let (b, stranger) = (meshed("node-b"), plain("stranger"));
    let cl = Client::new(stranger.identity().clone());
    assert!(is_not_edge_err(cl.upgrade(&b.target(), PATH, PROTO).await));
    assert!(is_not_edge_err(
        cl.call_raw(&b.target(), UNPAIR_PATH, &args(&[])).await
    ));
    let err = cl
        .call_raw(
            &b.target(),
            PAIR_PATH,
            &args(&[("token", "x"), ("name", "s")]),
        )
        .await
        .unwrap_err();
    assert!(
        matches!(err, CallError::Remote(ref re) if re.code == edge::CODE_NO_INVITE),
        "{err:?}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn removed_edge_cannot_replay_code() {
    let (a, b) = (plain("node-a"), plain("node-b"));
    let code = invite_code(&b).await;
    assert_eq!(
        a.op("add", &args(&[("code", &code)])).await.status,
        StatusCode::OK
    );
    assert_eq!(
        b.op("remove", &args(&[("fp", &a.fp())])).await.status,
        StatusCode::OK
    );
    let r = a.op("add", &args(&[("code", &code)])).await;
    assert!(
        r.status == StatusCode::FORBIDDEN && r.code == edge::CODE_NO_INVITE,
        "{r:?}"
    );
    assert!(!b.store().is_edge(&a.fp()));
}

// ---- fail_test.go ----

#[test]
fn store_fail_codes() {
    for (err, want) in [
        (edge::Error::Ambiguous, edge::CODE_AMBIGUOUS),
        (edge::Error::SaveFailed, CODE_SAVE_FAILED),
        (edge::Error::EdgeNotFound, edge::CODE_NOT_FOUND),
    ] {
        assert_eq!(ops::store_fail(&err).code, want, "{err}");
    }
}

#[test]
fn call_fail_sanitizes_remote() {
    let re = |status, code: &str, message: &str| {
        CallError::Remote(edge::RemoteError {
            status,
            code: code.into(),
            message: message.into(),
        })
    };
    for (input, st, code) in [
        (
            re(403, "edge_token_invalid", "x"),
            StatusCode::FORBIDDEN,
            "edge_token_invalid",
        ),
        (
            re(500, "internal_error", "x"),
            StatusCode::BAD_GATEWAY,
            "internal_error",
        ),
        (
            re(302, "edge_token_invalid", "x"),
            StatusCode::BAD_GATEWAY,
            "edge_token_invalid",
        ),
        (
            re(404, "made_up\x1b[31m", "x"),
            StatusCode::NOT_FOUND,
            "edge_rejected",
        ),
    ] {
        let r = ops::call_fail(&input);
        assert!(r.status == st && r.code == code, "{input:?} → {r:?}");
    }
    let r = ops::call_fail(&re(
        400,
        "bad_request",
        &format!("a\x1b[2J\r\nb{}", "z".repeat(2000)),
    ));
    assert!(
        !r.message.contains(['\x1b', '\r', '\n']) && r.message.len() <= 600,
        "{:?}",
        r.message
    );
}

// ---- edge_limit_test.go ----

fn fill_edges(n: &TestNode) {
    for i in 0..MAX_EDGES {
        let e = Edge {
            name: format!("n{i}"),
            fingerprint: format!("{:064x}", i + 1),
            ..Edge::default()
        };
        n.store().add_edge(e).unwrap();
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn add_rejected_when_full() {
    let (a, b) = (plain("node-a"), plain("node-b"));
    fill_edges(&a);
    let add = a
        .op("add", &args(&[("code", &invite_code(&b).await)]))
        .await;
    assert!(
        add.status == StatusCode::BAD_REQUEST && add.code == CODE_BAD_REQUEST,
        "{add:?}"
    );
    assert!(a.config().edges.len() == MAX_EDGES && b.config().edges.is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn pair_rejected_when_peer_full() {
    let (a, b) = (plain("node-a"), plain("node-b"));
    fill_edges(&b);
    let code = invite_code(&b).await;
    let add = a.op("add", &args(&[("code", &code)])).await;
    assert!(
        add.status == StatusCode::BAD_REQUEST && add.code == CODE_BAD_REQUEST,
        "{add:?}"
    );
    assert!(a.config().edges.is_empty() && b.config().edges.len() == MAX_EDGES);
    b.store().remove(&format!("{:064x}", 1)).unwrap();
    assert_eq!(
        a.op("add", &args(&[("code", &code)])).await.status,
        StatusCode::OK
    );
}

// ---- profile_test.go ----

#[tokio::test(flavor = "multi_thread")]
async fn profile_get_and_set_name() {
    let n = plain("node-a");
    let r = n.op("profile", &()).await;
    assert!(r.status == StatusCode::OK && !r.etag.is_empty());
    let m = body(&r);
    assert_eq!(s(&m, "name"), "node-a");
    assert_eq!(s(&m, "tag"), tag(&n.fp()));
    assert_eq!(s(&m, "handle"), format!("node-a#{}", tag(&n.fp())));
    assert_eq!(s(&m, "fingerprint"), n.fp());
    assert_eq!(n.handle(), s(&m, "handle"));
    let r = n.op("profile_name", &args(&[("name", "동민")])).await;
    assert!(
        r.status == StatusCode::OK && s(&body(&r), "name") == "동민",
        "{r:?}"
    );
    assert_eq!(n.config().name, "동민");
    let r = n.op("profile_name", &args(&[("name", "동 민")])).await;
    assert!(
        r.status == StatusCode::BAD_REQUEST && r.code == edge::CODE_CONFIG_INVALID,
        "{r:?}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn view_has_tags() {
    let (a, b) = (plain("node-a"), plain("node-b"));
    pair_nodes(&a, &b).await;
    let r = a.op("get", &()).await;
    let raw = String::from_utf8(r.body).unwrap();
    assert!(
        raw.contains(&format!(r#""tag":"{}""#, tag(&a.fp()))),
        "{raw}"
    );
    assert_eq!(edge_state(&a, &b.fp()).await.tag, tag(&b.fp()));
    assert!(
        raw.contains(r#""mesh":null"#)
            && raw.contains(r#""invites":[]"#)
            && raw.contains(r#""invite":null"#)
    );
}

// ---- mesh_test.go ----

#[tokio::test(flavor = "multi_thread")]
async fn link_path_without_mesh_is_404() {
    let (a, b) = (plain("node-a"), plain("node-b"));
    pair_nodes(&a, &b).await;
    let err = Client::new(a.identity().clone())
        .upgrade(&b.target(), PATH, PROTO)
        .await
        .err()
        .unwrap();
    assert!(
        matches!(err, CallError::Remote(ref re) if re.status == 404),
        "{err:?}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn link_path_rejects_non_edge() {
    let (b, stranger) = (meshed("node-b"), plain("stranger"));
    assert!(is_not_edge_err(
        Client::new(stranger.identity().clone())
            .upgrade(&b.target(), PATH, PROTO)
            .await
    ));
}

#[tokio::test(flavor = "multi_thread")]
async fn legacy_chat_path_marks_outdated() {
    let (a, b) = (plain("node-a"), meshed("node-b"));
    pair_nodes(&a, &b).await;
    let err = Client::new(a.identity().clone())
        .upgrade(&b.target(), LEGACY_CHAT_PATH, "dmchat1")
        .await
        .err()
        .unwrap();
    assert!(
        matches!(err, CallError::Remote(ref re) if re.status == 404),
        "{err:?}"
    );
    eventually("B 가 A 를 옛 판으로 본다", async || {
        edge_state(&b, &a.fp()).await.outdated
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn notify_links_and_exchanges_hello() {
    let (a, b) = (meshed("node-a"), meshed("node-b"));
    pair_nodes(&a, &b).await;
    b.store().set_name("node-b2").unwrap();
    let r = notify(&a, &b).await;
    assert_eq!(r.status, StatusCode::OK, "{r:?}");
    eventually("A 가 B 의 새 이름을 안다", async || {
        edge_state(&a, &b.fp()).await.name == "node-b2"
    })
    .await;
    assert!(edge_state(&a, &b.fp()).await.linked);
    let v = get_view(&a).await.mesh.unwrap();
    assert!(v.nodes.len() == 2 && v.links.len() == 1, "{v:?}");
    let nb = v.nodes.iter().find(|n| n.fp == b.fp()).unwrap();
    assert!(
        nb.online && nb.edge && nb.tag == tag(&b.fp()) && nb.name == "node-b2" && !nb.self_,
        "{nb:?}"
    );
    assert!(v.nodes.iter().any(|n| n.self_ && n.fp == a.fp()));
}

#[tokio::test(flavor = "multi_thread")]
async fn rename_marks_pending_until_sent() {
    let (a, b, c) = (meshed("node-a"), meshed("node-b"), meshed("node-c"));
    pair_nodes(&a, &b).await;
    pair_nodes(&a, &c).await;
    assert_eq!(notify(&a, &b).await.status, StatusCode::OK);
    assert_eq!(
        a.op("profile_name", &args(&[("name", "node-a2")]))
            .await
            .status,
        StatusCode::OK
    );
    eventually("B 는 받았다", async || {
        !edge_state(&a, &b.fp()).await.pending
    })
    .await;
    assert!(
        edge_state(&a, &c.fp()).await.pending,
        "연결 없는 C 는 알림 대기여야 한다"
    );
    eventually("B 가 새 이름을 안다", async || {
        edge_state(&b, &a.fp()).await.name == "node-a2"
    })
    .await;
    assert_eq!(notify(&a, &c).await.status, StatusCode::OK);
    eventually("C 도 받았다", async || {
        !edge_state(&a, &c.fp()).await.pending
    })
    .await;
    eventually("C 가 새 이름을 안다", async || {
        edge_state(&c, &a.fp()).await.name == "node-a2"
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn port_off_is_not_notified() {
    let (a, b) = (meshed("node-a"), meshed("node-b"));
    pair_nodes(&a, &b).await;
    close_port(&a).await;
    assert!(!edge_state(&a, &b.fp()).await.pending);
}

#[tokio::test(flavor = "multi_thread")]
async fn port_change_updates_peer() {
    let (a, b) = (meshed("node-a"), meshed("node-b"));
    pair_nodes(&b, &a).await;
    assert_eq!(notify(&b, &a).await.status, StatusCode::OK);
    let mut cfg = a.config();
    cfg.port = free_port();
    assert_eq!(a.op("node", &cfg).await.status, StatusCode::OK);
    eventually("B 가 A 의 새 포트를 안다", async || {
        let e = b.store().resolve(&a.fp()).unwrap();
        e.port == cfg.port && e.addr == "127.0.0.1"
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn notify_failures() {
    let (a, b) = (meshed("node-a"), meshed("node-b"));
    close_port(&a).await;
    pair_nodes(&a, &b).await;
    let r = notify(&b, &a).await;
    assert!(
        r.status == StatusCode::CONFLICT && r.code == edge::CODE_ADDR_UNKNOWN,
        "{r:?}"
    );
    let old = plain("node-old");
    pair_nodes(&a, &old).await;
    let r = notify(&a, &old).await;
    assert!(
        r.status == StatusCode::BAD_GATEWAY && r.code == edge::CODE_PEER_OUTDATED,
        "{r:?}"
    );
    assert!(edge_state(&a, &old.fp()).await.outdated);
    b.ln.get().unwrap().close();
    let r = notify(&a, &b).await;
    assert!(
        r.status == StatusCode::BAD_GATEWAY && r.code == edge::CODE_UNREACHABLE,
        "{r:?}"
    );
    assert_eq!(
        a.op("notify", &args(&[("fp", "zzzzzzzzzz")])).await.status,
        StatusCode::NOT_FOUND
    );
}

async fn three_with_b_between() -> (TestNode, TestNode, TestNode) {
    let (a, b, c) = (meshed("node-a"), meshed("node-b"), meshed("node-c"));
    pair_nodes(&a, &b).await;
    pair_nodes(&c, &b).await;
    assert_eq!(notify(&a, &b).await.status, StatusCode::OK);
    assert_eq!(notify(&c, &b).await.status, StatusCode::OK);
    let cfp = c.fp();
    eventually("A 가 C 를 온라인으로 안다", async || {
        get_view(&a)
            .await
            .mesh
            .unwrap()
            .nodes
            .iter()
            .any(|n| n.fp == cfp && n.online && !n.edge)
    })
    .await;
    (a, b, c)
}

#[tokio::test(flavor = "multi_thread")]
async fn invite_send_and_accept() {
    let (a, b, c) = three_with_b_between().await;
    assert_eq!(
        a.op("invite_send", &args(&[("to", &a.fp())])).await.status,
        StatusCode::BAD_REQUEST
    );
    let r = a.op("invite_send", &args(&[("to", &b.fp())])).await;
    assert!(
        r.status == StatusCode::CONFLICT && r.code == edge::CODE_ALREADY_EDGE,
        "{r:?}"
    );
    let r = a.op("invite_send", &args(&[("to", "ff")])).await;
    assert!(
        r.status == StatusCode::NOT_FOUND && r.code == edge::CODE_NOT_FOUND,
        "{r:?}"
    );
    let r = a.op("invite_send", &args(&[("to", &c.fp())])).await;
    assert_eq!(r.status, StatusCode::OK, "{r:?}");
    let got = body(&r);
    assert!(
        s(&got, "to") == c.fp() && s(&got, "name") == "node-c" && got.contains_key("expires"),
        "{got:?}"
    );
    eventually("C 가 초대를 받는다", async || {
        get_view(&c).await.invites.unwrap_or_default().len() == 1
    })
    .await;
    let inv = get_view(&c).await.invites.unwrap().remove(0);
    assert!(
        inv.from == a.fp() && inv.name == "node-a" && inv.tag == tag(&a.fp()),
        "{inv:?}"
    );
    assert!(get_view(&b).await.invites.unwrap().is_empty());
    assert!(
        c.changes()
            .iter()
            .any(|ch| ch.invited.as_ref().is_some_and(|r| r.fp == a.fp()))
    );
    let acc = c.op("invite_accept", &args(&[("id", &inv.id)])).await;
    assert_eq!(acc.status, StatusCode::OK, "{acc:?}");
    assert!(a.store().is_edge(&c.fp()) && c.store().is_edge(&a.fp()));
    assert!(get_view(&c).await.invites.unwrap().is_empty());
    assert_eq!(
        c.op("invite_accept", &args(&[("id", &inv.id)]))
            .await
            .status,
        StatusCode::NOT_FOUND
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn invite_reject() {
    let (a, _b, c) = three_with_b_between().await;
    assert_eq!(
        a.op("invite_send", &args(&[("to", &c.fp())])).await.status,
        StatusCode::OK
    );
    eventually("C 가 초대를 받는다", async || {
        get_view(&c).await.invites.unwrap_or_default().len() == 1
    })
    .await;
    let id = get_view(&c).await.invites.unwrap().remove(0).id;
    assert_eq!(
        c.op("invite_reject", &args(&[("id", &id)])).await.status,
        StatusCode::OK
    );
    assert!(get_view(&c).await.invites.unwrap().is_empty() && !c.store().is_edge(&a.fp()));
    assert_eq!(
        c.op("invite_reject", &args(&[("id", &id)])).await.status,
        StatusCode::NOT_FOUND
    );
    let expires = dm_gocompat::time::now_local() + Duration::from_secs(60);
    c.on_invite(Invite {
        id,
        from: a.fp(),
        name: "node-a".into(),
        code: String::new(),
        expires,
    });
    assert!(
        get_view(&c).await.invites.unwrap().is_empty(),
        "거절한 초대가 다시 들어왔다"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn invite_needs_open_port() {
    let (a, _b, c) = three_with_b_between().await;
    close_port(&a).await;
    let r = a.op("invite_send", &args(&[("to", &c.fp())])).await;
    assert!(
        r.status == StatusCode::CONFLICT && r.code == edge::CODE_PORT_CLOSED,
        "{r:?}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn mesh_ops_without_mesh() {
    let (a, b) = (plain("node-a"), plain("node-b"));
    pair_nodes(&a, &b).await;
    for op in ["notify", "invite_send"] {
        let r = a.op(op, &args(&[("fp", &b.fp()), ("to", &b.fp())])).await;
        assert!(
            r.status == StatusCode::SERVICE_UNAVAILABLE && r.code == edge::CODE_UNAVAILABLE,
            "{op}: {r:?}"
        );
    }
    let v = get_view(&a).await;
    assert!(v.mesh.is_none() && v.invites.is_some());
}

// ---- relay_test.go ----

/// 데몬 모드의 노드 하나다: 서버 쪽 통로(노드 포트·발신 소켓)와 데몬 쪽 노드(노드 소켓을 듣는
/// 리스너, 발신 소켓을 지나는 클라이언트).
struct RelayNode {
    node: Arc<Node>,
    _ln: Listener,
    _port: Arc<dm_shared_edgerelay::Port>,
    _dial: dm_shared_edgerelay::DialServer,
    _home: TempDir,
}

fn relay_node(name: &str) -> RelayNode {
    use dm_shared_edgerelay as relay;
    let home = tempfile::Builder::new()
        .prefix("en")
        .tempdir_in("/tmp")
        .unwrap();
    let cfg = Config {
        enabled: true,
        port: free_port(),
        bind: "127.0.0.1".into(),
        name: name.into(),
        advertise: "127.0.0.1".into(),
        edges: Vec::new(),
    };
    std::fs::write(
        home.path().join(dmenv::EDGES_FILE),
        json::marshal(&cfg).unwrap(),
    )
    .unwrap();
    let dial_sock = relay::dial_socket_path(home.path());
    let node_sock = relay::node_socket_path(home.path());
    let dial = relay::serve_dial(&dial_sock).unwrap();
    let port = Arc::new(relay::Port::new(&node_sock));
    let p = port.clone();
    let node = Node::new(Options {
        home: home.path().to_path_buf(),
        hostname: name.into(),
        dial: Some(relay::dialer(&dial_sock)),
        port_status: Some(Arc::new(move || p.status())),
        ..Options::default()
    })
    .unwrap();
    let ln = Listener::new(node.identity(), node.admission(), node.handler()).unwrap();
    ln.use_listen(Box::new(move |_, _| {
        relay::listen_node(&node_sock).map(|n| Box::new(n) as Box<dyn dm_shared_edge::Acceptor>)
    }));
    ln.apply(&node.config());
    let c = node.config();
    port.apply(c.enabled, &c.bind, c.port);
    assert!(ln.status().listening && port.status().listening);
    RelayNode {
        node,
        _ln: ln,
        _port: port,
        _dial: dial,
        _home: home,
    }
}

/// 서버는 바이트만 잇고 TLS·판정은 노드가 한다. 통로를 지나도 맺기 전 과정이 같다 (TC-PDM-4).
#[tokio::test(flavor = "multi_thread")]
async fn relay_pair_full_flow() {
    let (a, b) = (relay_node("node-a"), relay_node("node-b"));
    let op = |n: &Arc<Node>, op: &str, a: &BTreeMap<String, String>| {
        let req = OpRequest {
            op: op.into(),
            args: json::marshal(a).unwrap(),
            if_match: String::new(),
        };
        let n = n.clone();
        async move { n.do_op(req).await }
    };
    let inv = op(&b.node, "invite", &args(&[])).await;
    assert_eq!(inv.status, StatusCode::OK, "{inv:?}");
    let add = op(&a.node, "add", &args(&[("code", &s(&body(&inv), "code"))])).await;
    assert_eq!(add.status, StatusCode::OK, "{add:?}");
    let (fa, fb) = (
        a.node.identity().fingerprint.clone(),
        b.node.identity().fingerprint.clone(),
    );
    assert!(a.node.store().is_edge(&fb) && b.node.store().is_edge(&fa));
}

// Go callFail(err): notify 실패는 감싼 원인으로 가린다. 원격 거절은 그 코드로, 원격 문구가 고정
// 문구로 끝나도 Rejected 로 오인하지 않는다. 문구는 감싼 오류 전체다.
#[test]
fn mesh_call_fail_uses_wrapped_cause() {
    use dm_shared_edgemesh::{ErrorKind, MeshError};
    let rejected_text = CallError::Rejected.to_string();
    let not_edge = CallError::Remote(edge::RemoteError {
        status: 403,
        code: edge::CODE_NOT_EDGE.into(),
        message: rejected_text.clone(),
    });
    let r = crate::mesh::mesh_call_fail(&MeshError::with_call(ErrorKind::NotEdge, not_edge));
    assert!(
        r.status == StatusCode::FORBIDDEN && r.code == edge::CODE_NOT_EDGE,
        "{r:?}"
    );
    let err = MeshError::with_call(ErrorKind::Unreachable, CallError::Rejected);
    let r = crate::mesh::mesh_call_fail(&err);
    assert!(
        r.status == StatusCode::BAD_GATEWAY
            && r.code == edge::CODE_REJECTED
            && r.message == err.to_string(),
        "{r:?}"
    );
    let err = MeshError::with_call(ErrorKind::Unreachable, CallError::FingerprintMismatch);
    assert_eq!(
        crate::mesh::mesh_call_fail(&err).code,
        edge::CODE_FP_MISMATCH
    );
    let err = MeshError::with_call(ErrorKind::Unreachable, CallError::Unreachable("x".into()));
    let r = crate::mesh::mesh_call_fail(&err);
    assert!(
        r.code == edge::CODE_UNREACHABLE && r.message == err.to_string(),
        "{r:?}"
    );
}
