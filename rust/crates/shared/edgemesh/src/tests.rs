//! EDGE_MESH_SRS 묶음 L·N·H·I — 간선 계층의 연결·망 정보·직접 정보·초대 (Go mesh_test.go,
//! backoff_test.go).

use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use dm_gocompat::json::RawMessage;
use dm_shared_edge::{
    CODE_NOT_EDGE, CallError, Edge, INVITE_TTL, Identity, InviteCode, RemoteError, encode_invite,
    load_or_create_identity,
};
use tempfile::TempDir;
use time::OffsetDateTime;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader, DuplexStream};
use tokio_util::sync::CancellationToken;

use crate::frame::{random_hex, sign_frame};
use crate::invite::{
    INVITE_ID_BYTES, InviteBody, MAX_SEEN_INVITES, MAX_SEEN_PER_SENDER, MAX_SENT_INVITES,
    SeenInvite, open, seal,
};
use crate::mesh::{MAX_LINE, REDIAL_MAX, REDIAL_MIN};
use crate::net::{NetBody, open_links};
use crate::*;

const PIPE_BUF: usize = 64 << 10;
const EVENTUALLY: Duration = Duration::from_secs(3);
const NEVER: Duration = Duration::from_millis(200);
const POLL: Duration = Duration::from_millis(5);
const HELLO_HOOK_DELAY: Duration = Duration::from_millis(50);

fn new_identity() -> (Identity, TempDir) {
    let dir = TempDir::new().unwrap();
    let id = load_or_create_identity(dir.path()).unwrap();
    (id, dir)
}

/// 두 끝을 잇는 메모리 연결이다. 돌려준 토큰을 끊으면 양쪽이 EOF 를 본다 (Go `net.Pipe` 를 닫기).
fn pipe() -> (DuplexStream, DuplexStream, CancellationToken) {
    let (a1, mut a2) = tokio::io::duplex(PIPE_BUF);
    let (b1, mut b2) = tokio::io::duplex(PIPE_BUF);
    let kill = CancellationToken::new();
    let k = kill.clone();
    tokio::spawn(async move {
        tokio::select! {
            _ = k.cancelled() => {}
            _ = tokio::io::copy_bidirectional(&mut a2, &mut b2) => {}
        }
    });
    (a1, b1, kill)
}

fn conn(io: DuplexStream) -> Conn {
    Conn::new(Box::new(io))
}

async fn eventually(what: &str, mut cond: impl FnMut() -> bool) {
    let deadline = tokio::time::Instant::now() + EVENTUALLY;
    while tokio::time::Instant::now() < deadline {
        if cond() {
            return;
        }
        tokio::time::sleep(POLL).await;
    }
    panic!("시간 안에 이루어지지 않았다: {what}");
}

async fn never(what: &str, mut cond: impl FnMut() -> bool) {
    let deadline = tokio::time::Instant::now() + NEVER;
    while tokio::time::Instant::now() < deadline {
        if cond() {
            panic!("일어나면 안 되는 일이 일어났다: {what}");
        }
        tokio::time::sleep(POLL).await;
    }
}

type NotEdgeFn = Arc<dyn Fn(&str) + Send + Sync>;

#[derive(Default)]
struct Recorded {
    hellos: HashMap<String, Hello>,
    sent: HashMap<String, usize>,
    inv: Vec<Invite>,
    name: String,
    edges: Vec<Edge>,
}

#[derive(Default)]
struct Hooks {
    rec: Mutex<Recorded>,
    dial: Mutex<Option<DialFn>>,
    not_edge: Mutex<Option<NotEdgeFn>>,
    hello_delay: Mutex<Duration>,
}

struct TestMesh {
    m: Mesh,
    id: Identity,
    hooks: Arc<Hooks>,
    _dir: TempDir,
}

impl Drop for TestMesh {
    fn drop(&mut self) {
        self.m.close();
    }
}

impl std::ops::Deref for TestMesh {
    type Target = Mesh;
    fn deref(&self) -> &Mesh {
        &self.m
    }
}

fn new_test_mesh(name: &str) -> TestMesh {
    let (id, dir) = new_identity();
    let hooks = Arc::new(Hooks::default());
    hooks.rec.lock().unwrap().name = name.to_string();
    let mut o = Options::new(id.clone());
    let h = hooks.clone();
    o.name = Some(Arc::new(move || h.rec.lock().unwrap().name.clone()));
    let h = hooks.clone();
    o.hello = Some(Arc::new(move || Hello {
        name: h.rec.lock().unwrap().name.clone(),
        ..Hello::default()
    }));
    let h = hooks.clone();
    o.edges = Some(Arc::new(move || h.rec.lock().unwrap().edges.clone()));
    let h = hooks.clone();
    o.dial = Some(Arc::new(move |t| {
        let d = h.dial.lock().unwrap().clone();
        match d {
            Some(d) => d(t),
            None => Box::pin(async { Err(CallError::Unreachable("no dial".into())) }),
        }
    }));
    let h = hooks.clone();
    o.on_hello = Some(Arc::new(move |fp, hello, _| {
        h.rec.lock().unwrap().hellos.insert(fp.to_string(), hello);
    }));
    let h = hooks.clone();
    o.on_hello_sent = Some(Arc::new(move |fp| {
        let delay = *h.hello_delay.lock().unwrap();
        if !delay.is_zero() {
            std::thread::sleep(delay);
        }
        *h.rec
            .lock()
            .unwrap()
            .sent
            .entry(fp.to_string())
            .or_insert(0) += 1;
    }));
    let h = hooks.clone();
    o.on_invite = Some(Arc::new(move |inv| h.rec.lock().unwrap().inv.push(inv)));
    let h = hooks.clone();
    o.on_not_edge = Some(Arc::new(move |fp| {
        let f = h.not_edge.lock().unwrap().clone();
        if let Some(f) = f {
            f(fp);
        }
    }));
    TestMesh {
        m: Mesh::new(o),
        id,
        hooks,
        _dir: dir,
    }
}

impl TestMesh {
    fn fp(&self) -> String {
        self.id.fingerprint.clone()
    }

    fn hello_of(&self, fp: &str) -> Option<Hello> {
        self.hooks.rec.lock().unwrap().hellos.get(fp).cloned()
    }

    fn sent_count(&self, fp: &str) -> usize {
        self.hooks
            .rec
            .lock()
            .unwrap()
            .sent
            .get(fp)
            .copied()
            .unwrap_or(0)
    }

    fn invites(&self) -> Vec<Invite> {
        self.hooks.rec.lock().unwrap().inv.clone()
    }

    fn set_name(&self, name: &str) {
        self.hooks.rec.lock().unwrap().name = name.to_string();
    }

    fn set_edges(&self, edges: Vec<Edge>) {
        self.hooks.rec.lock().unwrap().edges = edges;
    }

    fn set_dial(&self, d: DialFn) {
        *self.hooks.dial.lock().unwrap() = Some(d);
    }

    fn online(&self, fp: &str) -> bool {
        self.nodes().iter().any(|n| n.fp == fp && n.online)
    }

    fn name_in_nodes(&self, fp: &str) -> String {
        self.nodes()
            .into_iter()
            .find(|n| n.fp == fp)
            .map(|n| n.name)
            .unwrap_or_default()
    }

    fn dial_wait(&self, fp: &str) -> Option<(Duration, bool)> {
        let st = self.inner.lock();
        let d = st.dialing.get(fp)?;
        let g = d.lock().unwrap();
        Some((g.wait, g.running))
    }

    fn dial_edges(&self, now: OffsetDateTime) {
        self.inner.dial_edges(&CancellationToken::new(), now);
    }
}

/// a(건 쪽)와 b 를 메모리 연결로 잇는다. 돌려준 토큰이 끊는다.
fn connect(a: &TestMesh, b: &TestMesh) -> CancellationToken {
    let (p1, p2, kill) = pipe();
    a.attach(&b.fp(), conn(p1), true);
    b.attach(&a.fp(), conn(p2), false);
    kill
}

fn edge_to(fp: &str, addr: &str, port: i64) -> Edge {
    Edge {
        name: "b".into(),
        addr: addr.into(),
        port,
        fingerprint: fp.into(),
        ..Edge::default()
    }
}

/// 손으로 프레임을 쓰는 상대다.
struct FakePeer {
    id: Identity,
    wr: tokio::io::WriteHalf<DuplexStream>,
    rd: Option<BufReader<tokio::io::ReadHalf<DuplexStream>>>,
    kill: CancellationToken,
    seq: u64,
    _dir: TempDir,
}

impl Drop for FakePeer {
    fn drop(&mut self) {
        self.kill.cancel();
    }
}

fn new_fake_peer(target: &TestMesh, read: bool) -> FakePeer {
    let (id, dir) = new_identity();
    let (p1, p2, kill) = pipe();
    let (rd, wr) = tokio::io::split(p2);
    let rd = if read {
        Some(BufReader::new(rd))
    } else {
        tokio::spawn(async move {
            let mut rd = rd;
            let mut buf = vec![0u8; PIPE_BUF];
            while matches!(rd.read(&mut buf).await, Ok(n) if n > 0) {}
        });
        None
    };
    target.attach(&id.fingerprint, conn(p1), false);
    FakePeer {
        id,
        wr,
        rd,
        kill,
        seq: 0,
        _dir: dir,
    }
}

impl FakePeer {
    fn fp(&self) -> String {
        self.id.fingerprint.clone()
    }

    async fn write(&mut self, fr: &Frame) {
        self.wr.write_all(&encode(fr)).await.unwrap();
    }

    async fn next(&mut self) -> Frame {
        let rd = self.rd.as_mut().unwrap();
        loop {
            let mut line = String::new();
            let n = tokio::time::timeout(EVENTUALLY, rd.read_line(&mut line))
                .await
                .expect("읽기 시간 초과")
                .unwrap();
            assert!(n > 0, "읽기: EOF");
            let fr: Frame = dm_gocompat::json::unmarshal(line.trim_end().as_bytes()).unwrap();
            if fr.t == FRAME_PING {
                continue;
            }
            return fr;
        }
    }

    /// skip 종류를 건너뛴 다음 줄이다. 위층이 연결을 열면 간선 계층이 새 net 을 낸다 (FR-EGM-6).
    async fn next_not(&mut self, skip: &str) -> Frame {
        loop {
            let fr = self.next().await;
            if fr.t != skip {
                return fr;
            }
        }
    }

    fn net(&mut self, name: &str, links: &[String]) -> Frame {
        self.seq += 1;
        net_frame(&self.id, name, 1, self.seq, links)
    }
}

fn net_frame(id: &Identity, name: &str, epoch: i64, seq: u64, links: &[String]) -> Frame {
    sign_frame(
        id,
        FRAME_NET,
        &NetBody {
            node: id.fingerprint.clone(),
            key: public_key(id),
            name: name.into(),
            epoch,
            seq,
            links: Some(links.to_vec()),
        },
    )
    .unwrap()
}

fn millis(t: OffsetDateTime) -> i64 {
    (t.unix_timestamp_nanos() / 1_000_000) as i64
}

fn invite_code(fp: &str, token: &str) -> String {
    encode_invite(&InviteCode {
        addr: "10.0.0.1".into(),
        port: 7001,
        fingerprint: fp.into(),
        token: token.into(),
    })
}

/// f 가 c 에게 보내는 바른 초대다.
fn invite_from(
    f: &Identity,
    c: &TestMesh,
    id: &str,
    at: OffsetDateTime,
    exp: OffsetDateTime,
    code_fp: &str,
) -> Frame {
    let code = invite_code(code_fp, "t");
    let sealed = seal(
        f,
        &public_key(&c.id),
        id,
        &f.fingerprint,
        &c.fp(),
        code.as_bytes(),
    )
    .unwrap();
    sign_frame(
        f,
        FRAME_INVITE,
        &InviteBody {
            id: id.into(),
            from: f.fingerprint.clone(),
            to: c.fp(),
            at: millis(at),
            exp: millis(exp),
            sealed,
        },
    )
    .unwrap()
}

fn mt() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .unwrap()
}

// --- 프레임 ---

#[test]
fn encode_matches_go() {
    let fr = Frame {
        t: "hello".into(),
        b: RawMessage(br#"{"name":"a<b>&"}"#.to_vec()),
        s: String::new(),
    };
    assert_eq!(
        encode(&fr),
        b"{\"t\":\"hello\",\"b\":{\"name\":\"a\\u003cb\\u003e\\u0026\"}}\n".to_vec()
    );
    assert_eq!(
        encode(&Frame {
            t: FRAME_PING.into(),
            ..Frame::default()
        }),
        b"{\"t\":\"ping\"}\n".to_vec()
    );
    let h = Hello {
        name: "n".into(),
        addr: String::new(),
        port: 0,
    };
    assert_eq!(dm_gocompat::json::marshal(&h).unwrap(), br#"{"name":"n"}"#);
}

#[test]
fn sign_verify_round_trip() {
    let (id, _d) = new_identity();
    let (other, _d2) = new_identity();
    let s = sign(&id, "net", b"{}").unwrap();
    let key = parse_key(&id.fingerprint, &public_key(&id)).unwrap();
    assert!(verify(&key, "net", b"{}", &s));
    assert!(!verify(&key, "invite", b"{}", &s));
    assert!(!verify(&key, "net", b"{ }", &s));
    assert!(parse_key(&id.fingerprint, &public_key(&other)).is_none());
    assert!(parse_key(&id.fingerprint, "!!").is_none());
}

// --- 망 정보 ---

// TC-EGM-1 (FR-EGM-10·12): A-B-C 에서 A 는 간선이 아닌 C 를 온라인으로 안다. B-C 가 끊기면
// C 는 연결 끊김이 되고 이름은 남는다.
#[test]
fn neighbor_online_follows_links() {
    mt().block_on(async {
        let (a, b, c) = (new_test_mesh("a"), new_test_mesh("b"), new_test_mesh("c"));
        let _ab = connect(&a, &b);
        let cut = connect(&b, &c);
        eventually("A 가 C 를 온라인으로 안다", || a.online(&c.fp())).await;
        assert_eq!(a.name_in_nodes(&c.fp()), "c");
        assert!(a.mutual(&b.fp(), &c.fp()) && !a.mutual(&a.fp(), &c.fp()));
        assert_eq!(a.view().links.len(), 2);
        cut.cancel();
        eventually("C 가 연결 끊김이 된다", || !a.online(&c.fp())).await;
        assert_eq!(a.name_in_nodes(&c.fp()), "c", "끊긴 노드도 목록에 남는다");
    });
}

// FR-EGM-10: 이름을 바꾸고 알리면 망 이웃이 새 이름을 본다.
#[test]
fn announce_spreads_name() {
    mt().block_on(async {
        let (a, b, c) = (new_test_mesh("a"), new_test_mesh("b"), new_test_mesh("c"));
        let _ab = connect(&a, &b);
        let _bc = connect(&b, &c);
        eventually("C 를 안다", || a.online(&c.fp())).await;
        c.set_name("c2");
        c.announce();
        eventually("새 이름이 퍼진다", || {
            a.name_in_nodes(&c.fp()) == "c2"
        })
        .await;
    });
}

// TC-EGM-2 (FR-EGM-11): 서명을 바꾼 net, 남의 키를 단 net, 옛 번호의 net 은 버린다.
#[test]
fn net_validation() {
    mt().block_on(async {
        let a = new_test_mesh("a");
        let mut f = new_fake_peer(&a, false);
        let ffp = f.fp();
        let good = f.net("fake", &[a.fp()]);
        let mut bad = good.clone();
        let mut body = good.b.0[..good.b.0.len() - 1].to_vec();
        body.extend_from_slice(br#" ,"x":1}"#);
        bad.b = RawMessage(body);
        f.write(&bad).await;
        never("바꾼 net 을 받는다", || a.name_of(&ffp).is_some()).await;

        let (other, _d) = new_identity();
        let forged = sign_frame(
            &other,
            FRAME_NET,
            &NetBody {
                node: ffp.clone(),
                key: public_key(&other),
                name: "forged".into(),
                epoch: 1,
                seq: 9,
                links: None,
            },
        )
        .unwrap();
        f.write(&forged).await;
        never("남의 키를 단 net 을 받는다", || {
            a.name_of(&ffp).is_some()
        })
        .await;

        f.write(&good).await;
        eventually("바른 net 을 받는다", || {
            a.name_of(&ffp).as_deref() == Some("fake")
        })
        .await;
        assert!(a.online(&ffp), "서로 이어진 가짜 상대는 온라인이다");
        let newer = f.net("newer", &[a.fp()]);
        f.write(&newer).await;
        eventually("새 net", || a.name_of(&ffp).as_deref() == Some("newer")).await;
        f.write(&good).await;
        never("옛 net 이 덮는다", || {
            a.name_of(&ffp).as_deref() == Some("fake")
        })
        .await;
    });
}

// TC-EGM-3 (FR-EGM-13): 아는 노드 상한을 넘으면 닿지 않는 오래된 노드부터 잊고, 잊은 노드의
// 옛 net 은 다시 받지 않는다.
#[test]
fn known_nodes_capped() {
    mt().block_on(async {
        let a = new_test_mesh("a");
        a.inner.lock().max_nodes = 2;
        let mut f = new_fake_peer(&a, false);
        let mut frames = Vec::new();
        let mut ids = Vec::new();
        for i in 0..3 {
            let (id, d) = new_identity();
            let fr = net_frame(&id, "n", 1, 1, &[]);
            f.write(&fr).await;
            frames.push(fr);
            let fp = id.fingerprint.clone();
            ids.push((id, d));
            if i < 2 {
                eventually("받는다", || a.name_of(&fp).as_deref() == Some("n")).await;
            }
        }
        let third = ids[2].0.fingerprint.clone();
        eventually("셋째를 받는다", || {
            a.name_of(&third).as_deref() == Some("n")
        })
        .await;
        let first = ids[0].0.fingerprint.clone();
        assert!(
            a.name_of(&first).is_none(),
            "가장 오래된 노드를 잊어야 한다"
        );
        f.write(&frames[0]).await;
        never("잊은 노드의 옛 net 을 다시 받는다", || {
            a.name_of(&first).is_some()
        })
        .await;
    });
}

// --- 위층 ---

struct FakeUpper {
    m: Mesh,
    first: Vec<Vec<u8>>,
    got: Mutex<Vec<(String, Frame)>>,
}

impl Upper for FakeUpper {
    fn frame(&self, from: &str, fr: Frame) {
        self.got.lock().unwrap().push((from.to_string(), fr));
    }
    fn linked(&self, fp: &str) {
        self.m.open(fp, self.first.clone());
    }
    fn changed(&self) {}
}

// TC-EGM-4 (FR-EGM-4·5·6): 새 연결의 첫 줄은 hello → net → 위층의 첫 줄 순서다. 모르는 종류는
// 위층에 가고, 간선 계층의 종류는 가지 않는다.
#[test]
fn upper_frames_and_first_lines() {
    mt().block_on(async {
        let a = new_test_mesh("a");
        let up = Arc::new(FakeUpper {
            m: a.m.clone(),
            first: vec![encode(&Frame {
                t: "state".into(),
                b: RawMessage(br#"{"x":1}"#.to_vec()),
                s: String::new(),
            })],
            got: Mutex::new(Vec::new()),
        });
        a.set_upper(up.clone());
        let mut f = new_fake_peer(&a, true);
        assert_eq!(f.next().await.t, FRAME_HELLO);
        assert_eq!(f.next().await.t, FRAME_NET);
        assert_eq!(f.next().await.t, "state");
        f.write(&Frame {
            t: "msg".into(),
            b: RawMessage(br#"{"y":2}"#.to_vec()),
            s: String::new(),
        })
        .await;
        let n = f.net("fake", &[a.fp()]);
        f.write(&n).await;
        let count = || up.got.lock().unwrap().len();
        eventually("위층이 msg 를 받는다", || count() == 1).await;
        never("net 이 위층에 간다", || count() > 1).await;
        let (from, got) = up.got.lock().unwrap()[0].clone();
        assert_eq!(got.t, "msg");
        assert_eq!(from, f.fp(), "위층은 받은 연결의 상대를 안다");
        a.broadcast(
            &Frame {
                t: "msg".into(),
                b: RawMessage(br#"{"z":3}"#.to_vec()),
                s: String::new(),
            },
            "",
        );
        assert_eq!(f.next_not(FRAME_NET).await.t, "msg");
    });
}

struct BlockingUpper {
    m: Mesh,
    gate: Mutex<std::sync::mpsc::Receiver<()>>,
    called: Mutex<bool>,
}

impl Upper for BlockingUpper {
    fn frame(&self, _: &str, _: Frame) {}
    fn changed(&self) {}
    fn linked(&self, fp: &str) {
        *self.called.lock().unwrap() = true;
        let _ = self.gate.lock().unwrap().recv();
        self.m.open(
            fp,
            vec![encode(&Frame {
                t: "state".into(),
                ..Frame::default()
            })],
        );
    }
}

// FR-EGM-6: 위층이 첫 줄을 넣기 전의 연결은 위층의 broadcast 가 건너뛴다.
#[test]
fn broadcast_skips_unopened() {
    mt().block_on(async {
        let a = new_test_mesh("a");
        let (tx, rx) = std::sync::mpsc::channel();
        let up = Arc::new(BlockingUpper {
            m: a.m.clone(),
            gate: Mutex::new(rx),
            called: Mutex::new(false),
        });
        a.set_upper(up.clone());
        let mut f = new_fake_peer(&a, true);
        eventually("linked 가 불린다", || *up.called.lock().unwrap()).await;
        let opened = || open_links(&a.inner.lock()).len();
        assert_eq!(
            opened(),
            0,
            "열기 전의 연결이 망 정보에 들어갔다 — 온라인으로 보이면 글이 사라진다"
        );
        let msg = Frame {
            t: "msg".into(),
            ..Frame::default()
        };
        a.broadcast(&msg, "");
        tx.send(()).unwrap();
        eventually("열면 망 정보에 든다", || opened() == 1).await;
        for want in [FRAME_HELLO, FRAME_NET, "state"] {
            assert_eq!(f.next().await.t, want);
        }
        a.broadcast(&msg, "");
        assert_eq!(f.next_not(FRAME_NET).await.t, "msg");
    });
}

// --- 직접 정보 ---

// TC-EGM-5 (FR-EGM-20): 연결이 열리면 양쪽이 hello 를 주고받고, 다 쓴 것을 알린다.
#[test]
fn hello_on_connect() {
    mt().block_on(async {
        let (a, b) = (new_test_mesh("a"), new_test_mesh("b"));
        let _k = connect(&a, &b);
        eventually("A 가 B 의 hello 를 받는다", || {
            a.hello_of(&b.fp()).is_some_and(|h| h.name == "b")
        })
        .await;
        eventually("B 가 A 의 hello 를 받는다", || {
            b.hello_of(&a.fp()).is_some_and(|h| h.name == "a")
        })
        .await;
        eventually("보낸 것을 안다", || a.sent_count(&b.fp()) == 1).await;
    });
}

// TC-EGM-6 (FR-EGM-23): hello_all 은 열린 연결마다 한 번 보내고, 다 쓸 때까지 기다린다.
#[test]
fn hello_all() {
    mt().block_on(async {
        let (a, b, c) = (new_test_mesh("a"), new_test_mesh("b"), new_test_mesh("c"));
        let _ab = connect(&a, &b);
        let _ac = connect(&a, &c);
        eventually("연결", || {
            a.sent_count(&b.fp()) == 1 && a.sent_count(&c.fp()) == 1
        })
        .await;
        let h = Hello {
            name: "a2".into(),
            addr: "10.0.0.1".into(),
            port: 7001,
        };
        a.hello_all(&h, Duration::from_secs(1)).await;
        assert!(
            a.sent_count(&b.fp()) == 2 && a.sent_count(&c.fp()) == 2,
            "hello_all 은 돌아오기 전에 다 쓴다"
        );
        eventually("B 가 새 hello 를 받는다", || {
            b.hello_of(&a.fp())
                .is_some_and(|h| h.port == 7001 && h.addr == "10.0.0.1")
        })
        .await;
    });
}

// TC-EGM-6 (FR-EGM-23): hello_all 이 돌아오면 보낸 기록(on_hello_sent)도 끝나 있다.
#[test]
fn hello_all_returns_after_sent_hook() {
    mt().block_on(async {
        let (a, b) = (new_test_mesh("a"), new_test_mesh("b"));
        *a.hooks.hello_delay.lock().unwrap() = HELLO_HOOK_DELAY;
        let _k = connect(&a, &b);
        eventually("연결", || a.sent_count(&b.fp()) == 1).await;
        a.hello_all(
            &Hello {
                name: "a2".into(),
                ..Hello::default()
            },
            Duration::from_secs(1),
        )
        .await;
        assert_eq!(a.sent_count(&b.fp()), 2);
    });
}

fn fail_dial(err: CallError) -> DialFn {
    Arc::new(move |_| {
        let err = err.clone();
        Box::pin(async move { Err(err) })
    })
}

// TC-EGM-7·8 (FR-EGM-7·26): 연결이 없을 때 notify 는 바로 건다. 주소를 모르면 AddrUnknown,
// 상대가 404 면 옛 판으로 표시하고 Outdated 다.
#[test]
fn notify_dials_now() {
    mt().block_on(async {
        let (a, b) = (new_test_mesh("a"), new_test_mesh("b"));
        let bg = CancellationToken::new();
        a.set_edges(vec![edge_to(&b.fp(), "", 0)]);
        let err = a.notify(&bg, &b.fp()).await.unwrap_err();
        assert_eq!(err.kind(), ErrorKind::AddrUnknown);
        a.set_edges(vec![edge_to(&b.fp(), "127.0.0.1", 1)]);
        a.set_dial(fail_dial(CallError::Remote(RemoteError {
            status: 404,
            code: "not_found".into(),
            message: String::new(),
        })));
        let err = a.notify(&bg, &b.fp()).await.unwrap_err();
        assert_eq!(err.kind(), ErrorKind::Outdated);
        assert!(a.outdated(&b.fp()), "옛 판 표시");
        a.set_dial(fail_dial(CallError::Unreachable("refused".into())));
        let err = a.notify(&bg, &b.fp()).await.unwrap_err();
        assert_eq!(err.kind(), ErrorKind::Unreachable);
        let (bm, afp) = (b.m.clone(), a.fp());
        a.set_dial(Arc::new(move |_| {
            let (p1, p2, k) = pipe();
            std::mem::forget(k);
            bm.attach(&afp, conn(p2), false);
            Box::pin(async move { Ok(conn(p1)) })
        }));
        a.notify(&bg, &b.fp()).await.unwrap();
        assert!(!a.outdated(&b.fp()), "연결되면 옛 판 표시를 지운다");
        assert!(a.linked(&b.fp()), "연결이 남는다");
        a.notify(&bg, &b.fp()).await.unwrap();
        assert!(a.sent_count(&b.fp()) >= 2, "열린 연결로 다시 보냈다");
    });
}

// --- 초대 ---

// TC-EGM-10 (FR-EGM-32~36): A-B-C 에서 A 가 C 에 초대를 보낸다. C 만 열고, B 는 넘기기만 한다.
#[test]
fn invite_reaches_only_target() {
    mt().block_on(async {
        let (a, b, c) = (new_test_mesh("a"), new_test_mesh("b"), new_test_mesh("c"));
        let _ab = connect(&a, &b);
        let _bc = connect(&b, &c);
        eventually("A 가 C 를 안다", || a.online(&c.fp())).await;
        let code = invite_code(&a.fp(), "tok");
        let exp = OffsetDateTime::now_utc() + INVITE_TTL;
        a.send_invite(&c.fp(), &code, exp).unwrap();
        eventually("C 가 초대를 받는다", || c.invites().len() == 1).await;
        let got = &c.invites()[0];
        assert!(
            got.from == a.fp() && got.code == code && got.name == "a",
            "{got:?}"
        );
        never("B 가 초대를 연다", || !b.invites().is_empty()).await;
        let err = a.send_invite("ff", &code, exp).unwrap_err();
        assert_eq!(err.kind(), ErrorKind::UnknownNode);
    });
}

/// m 의 받은 초대 기억을 서로 다른 보낸 노드의 만료 전 항목으로 가득 채운다.
fn fill_seen(m: &TestMesh, exp: OffsetDateTime) {
    let mut st = m.inner.lock();
    while st.inv.seen.len() < MAX_SEEN_INVITES {
        let from = random_hex(INVITE_ID_BYTES);
        st.inv.seen.insert(
            random_hex(INVITE_ID_BYTES),
            SeenInvite {
                exp,
                from: from.clone(),
            },
        );
        *st.inv.per_sender.entry(from).or_insert(0) += 1;
    }
}

// TC-ATF-51 (FR-ATF-51): 받은 초대 기억이 만료 전 항목으로 가득 차면 새 초대를 받지 않는다.
// 만료된 항목이 하나라도 있으면 그 자리를 쓴다. 이 노드의 보내기는 받은 기억과 따로 센다.
#[test]
fn invite_memory_full_rejects() {
    mt().block_on(async {
        let (a, c) = (new_test_mesh("a"), new_test_mesh("c"));
        let _k = connect(&a, &c);
        eventually("A 가 C 를 안다", || a.online(&c.fp())).await;
        let code = invite_code(&a.fp(), "tok");
        let exp = OffsetDateTime::now_utc() + INVITE_TTL;
        fill_seen(&a, exp);
        a.send_invite(&c.fp(), &code, exp)
            .expect("받은 기억이 가득 차도 보낸다");
        eventually("C 가 받는다", || c.invites().len() == 1).await;
        {
            let mut st = a.inner.lock();
            while st.inv.mine.len() < MAX_SENT_INVITES {
                st.inv.mine.insert(random_hex(INVITE_ID_BYTES), exp);
            }
        }
        let err = a.send_invite(&c.fp(), &code, exp).unwrap_err();
        assert_eq!(err.kind(), ErrorKind::InviteFull);
        a.inner.lock().inv.mine.clear();
        fill_seen(&c, exp);
        a.send_invite(&c.fp(), &code, exp).unwrap();
        never("가득 찬 C 가 초대를 받는다", || {
            c.invites().len() > 1
        })
        .await;
        {
            let afp = a.fp();
            let mut st = c.inner.lock();
            if let Some(e) = st.inv.seen.values_mut().find(|e| e.from != afp) {
                e.exp = OffsetDateTime::now_utc() - Duration::from_secs(1);
            }
        }
        a.send_invite(&c.fp(), &code, exp).unwrap();
        eventually("만료된 자리로 받는다", || c.invites().len() == 2).await;
    });
}

// TC-ATF-51 (FR-ATF-51, 보안 검토): 한 노드가 제 몫까지 초대를 쏟아도 다른 노드의 초대는 받는다.
// 보낸 이를 거짓으로 적은 초대는 기억을 차지하지 않는다. 만료 전 초대를 다시 보내면 여전히 버린다.
#[test]
fn invite_flood_per_sender() {
    mt().block_on(async {
        let c = new_test_mesh("c");
        let (mut f1, mut f2) = (new_fake_peer(&c, false), new_fake_peer(&c, false));
        let n1 = f1.net("f1", &[c.fp()]);
        f1.write(&n1).await;
        let n2 = f2.net("f2", &[c.fp()]);
        f2.write(&n2).await;
        eventually("가짜들을 안다", || {
            c.online(&f1.fp()) && c.online(&f2.fp())
        })
        .await;
        let now = OffsetDateTime::now_utc();
        let later = now + Duration::from_secs(60);
        let mk = |f: &Identity| {
            invite_from(
                f,
                &c,
                &random_hex(INVITE_ID_BYTES),
                now,
                later,
                &f.fingerprint,
            )
        };
        let first = mk(&f1.id);
        f1.write(&first).await;
        for _ in 0..MAX_SEEN_PER_SENDER + 4 {
            let fr = mk(&f1.id);
            f1.write(&fr).await;
        }
        eventually("f1 의 몫까지 받는다", || {
            c.invites().len() == MAX_SEEN_PER_SENDER
        })
        .await;
        never("f1 이 몫을 넘는다", || {
            c.invites().len() > MAX_SEEN_PER_SENDER
        })
        .await;
        // 보낸 노드를 거짓으로 적은 초대(모르는 지문, 남의 지문)는 서명이 맞지 않아 기억에 들지 않는다.
        let f1id = f1.id.clone();
        let forge = |from: &str| {
            sign_frame(
                &f1id,
                FRAME_INVITE,
                &InviteBody {
                    id: random_hex(INVITE_ID_BYTES),
                    from: from.into(),
                    to: c.fp(),
                    at: millis(now),
                    exp: millis(later),
                    sealed: "x".into(),
                },
            )
            .unwrap()
        };
        let f2fp = f2.fp();
        for _ in 0..2 * MAX_SEEN_PER_SENDER {
            let a = forge(&random_hex(32));
            let b = forge(&f2fp);
            f1.write(&a).await;
            f1.write(&b).await;
        }
        never("거짓 보낸 이가 기억을 차지한다", || {
            let st = c.inner.lock();
            st.inv.seen.len() != MAX_SEEN_PER_SENDER || st.inv.per_sender.len() != 1
        })
        .await;
        let fr = mk(&f2.id);
        f2.write(&fr).await;
        eventually("f2 의 초대는 받는다", || {
            c.invites().len() == MAX_SEEN_PER_SENDER + 1
        })
        .await;
        f1.write(&first).await;
        never("만료 전 초대를 다시 받는다", || {
            c.invites().len() > MAX_SEEN_PER_SENDER + 1
        })
        .await;
    });
}

// TC-ATF-51 (FR-ATF-51, 보안 검토): 노드가 몫까지 초대를 보낸 뒤 잊혀도 그 몫은 남지 않는다.
// 받은 초대 기억은 아는 노드 수 × 몫을 넘지 않고, 새 노드의 초대는 받는다.
#[test]
fn invite_quota_forgotten_with_node() {
    mt().block_on(async {
        let c = new_test_mesh("c");
        c.inner.lock().max_nodes = 1;
        let now = OffsetDateTime::now_utc();
        let later = now + Duration::from_secs(60);
        let seen = || {
            let st = c.inner.lock();
            (st.inv.seen.len(), st.inv.per_sender.len())
        };
        for i in 0..4 {
            let mut f = new_fake_peer(&c, false);
            let n = f.net("f", &[c.fp()]);
            f.write(&n).await;
            let ffp = f.fp();
            eventually("새 노드를 안다", || c.online(&ffp)).await;
            for _ in 0..MAX_SEEN_PER_SENDER {
                let fr = invite_from(&f.id, &c, &random_hex(INVITE_ID_BYTES), now, later, &ffp);
                f.write(&fr).await;
            }
            eventually("새 노드의 초대를 몫까지 받는다", || {
                c.invites().len() == (i + 1) * MAX_SEEN_PER_SENDER
            })
            .await;
            assert_eq!(seen(), (MAX_SEEN_PER_SENDER, 1), "{i} 번째");
            f.kill.cancel();
            eventually("끊긴 노드는 닿지 않는다", || !c.online(&ffp)).await;
        }
    });
}

// FR-EGM-32: 상자는 받을 노드만 연다.
#[test]
fn invite_box_only_for_recipient() {
    let (a, _d1) = new_identity();
    let (b, _d2) = new_identity();
    let (c, _d3) = new_identity();
    let (afp, cfp) = (a.fingerprint.clone(), c.fingerprint.clone());
    let sealed = seal(&a, &public_key(&c), "id1", &afp, &cfp, b"secret").unwrap();
    assert_eq!(
        open(&c, &public_key(&a), "id1", &afp, &cfp, &sealed).as_deref(),
        Some(&b"secret"[..]),
        "받는 노드는 연다"
    );
    assert!(
        open(&b, &public_key(&a), "id1", &afp, &cfp, &sealed).is_none(),
        "다른 노드는 열지 못한다"
    );
    assert!(
        open(&c, &public_key(&a), "id2", &afp, &cfp, &sealed).is_none(),
        "id 를 바꾸면 열리지 않는다"
    );
}

// FR-EGM-33·34: 서명을 바꾼 초대, 만료된 초대, 같은 id 의 초대, 코드의 지문이 보낸 노드가 아닌
// 초대는 받지 않는다.
#[test]
fn invite_validation() {
    mt().block_on(async {
        let c = new_test_mesh("c");
        let mut f = new_fake_peer(&c, false);
        let n = f.net("fake", &[c.fp()]);
        f.write(&n).await;
        let ffp = f.fp();
        eventually("가짜를 안다", || c.online(&ffp)).await;
        let now = OffsetDateTime::now_utc();
        let (min, hour) = (Duration::from_secs(60), Duration::from_secs(3600));
        let id = |n: u8| format!("{:032x}", n);
        let frames = [
            invite_from(&f.id, &c, &id(1), now - hour, now - min, &ffp),
            invite_from(&f.id, &c, &id(2), now, now + hour, &ffp),
            invite_from(&f.id, &c, &id(3), now, now + min, &c.fp()),
        ];
        for fr in &frames {
            f.write(fr).await;
        }
        let mut tampered = invite_from(&f.id, &c, &id(4), now, now + min, &ffp);
        tampered.s = invite_from(&f.id, &c, &id(5), now, now + min, &ffp).s;
        f.write(&tampered).await;
        never("틀린 초대를 받는다", || !c.invites().is_empty()).await;
        let good = invite_from(&f.id, &c, &id(6), now, now + min, &ffp);
        f.write(&good).await;
        eventually("바른 초대", || c.invites().len() == 1).await;
        f.write(&good).await;
        never("같은 초대를 두 번 받는다", || {
            c.invites().len() > 1
        })
        .await;
    });
}

// --- 연결 ---

// FR-EGM-3: 지운 간선의 연결은 drop_link 로 바로 닫힌다.
#[test]
fn drop_closes_link() {
    mt().block_on(async {
        let (a, b) = (new_test_mesh("a"), new_test_mesh("b"));
        let _k = connect(&a, &b);
        eventually("연결", || a.linked(&b.fp())).await;
        a.drop_link(&b.fp());
        assert!(!a.linked(&b.fp()), "drop_link 뒤에도 연결이 있다");
        eventually("상대도 끊긴다", || !b.linked(&a.fp())).await;
    });
}

// FR-EGM-3: 같은 상대와의 연결이 둘이면 하나만 남는다.
#[test]
fn duplicate_links_collapse() {
    mt().block_on(async {
        let (a, b) = (new_test_mesh("a"), new_test_mesh("b"));
        let _k1 = connect(&a, &b);
        let _k2 = connect(&b, &a);
        eventually("하나만 남는다", || {
            a.link_count() == 1 && b.link_count() == 1
        })
        .await;
        eventually("서로 온라인", || {
            a.online(&b.fp()) && b.online(&a.fp())
        })
        .await;
    });
}

// FR-EGM-3: 조용한 연결은 끊는다.
#[test]
fn silent_link_dropped() {
    mt().block_on(async {
        let a = new_test_mesh("a");
        a.inner.lock().dead_after = Duration::from_millis(50);
        let f = new_fake_peer(&a, false);
        let ffp = f.fp();
        eventually("연결", || a.linked(&ffp)).await;
        tokio::time::sleep(Duration::from_millis(80)).await;
        a.inner.ping_all(OffsetDateTime::now_utc());
        assert!(!a.linked(&ffp), "조용한 연결이 남았다");
    });
}

// NFR-EGM-2: 프레임 한 줄의 상한을 넘으면 연결을 끊는다.
#[test]
fn oversized_line_drops_link() {
    mt().block_on(async {
        let a = new_test_mesh("a");
        let mut f = new_fake_peer(&a, false);
        let ffp = f.fp();
        eventually("연결", || a.linked(&ffp)).await;
        let mut big = vec![b'x'; MAX_LINE + 1];
        big.push(b'\n');
        tokio::spawn(async move {
            let _ = f.wr.write_all(&big).await;
            f
        });
        eventually("끊긴다", || !a.linked(&ffp)).await;
    });
}

// NFR-EGM-2: 상한보다 한 바이트 짧은 줄은 받는다(줄바꿈 포함 MAX_LINE).
#[test]
fn line_just_under_limit_is_read() {
    mt().block_on(async {
        let a = new_test_mesh("a");
        let up = Arc::new(FakeUpper {
            m: a.m.clone(),
            first: Vec::new(),
            got: Mutex::new(Vec::new()),
        });
        a.set_upper(up.clone());
        let mut f = new_fake_peer(&a, false);
        let ffp = f.fp();
        eventually("연결", || a.linked(&ffp)).await;
        let head = br#"{"t":"msg","b":""#;
        let tail = br#""}"#;
        let mut line = head.to_vec();
        line.extend(std::iter::repeat_n(
            b'x',
            MAX_LINE - 1 - head.len() - tail.len(),
        ));
        line.extend_from_slice(tail);
        assert_eq!(line.len(), MAX_LINE - 1);
        line.push(b'\n');
        f.wr.write_all(&line).await.unwrap();
        eventually("위층이 받는다", || up.got.lock().unwrap().len() == 1).await;
        assert!(a.linked(&ffp));
    });
}

// FR-EGM-3: 다시 걸 때 상대가 edge_not_edge 로 답하면 간선을 지우라고 알린다. 다른 실패는 간선을
// 그대로 둔다. 주소를 모르는 간선에는 걸지 않는다.
#[test]
fn redial_outcomes() {
    mt().block_on(async {
        let peer = edge_to(&"ab".repeat(32), "127.0.0.1", 1);
        let remote = |status, code: &str| {
            CallError::Remote(RemoteError {
                status,
                code: code.into(),
                message: String::new(),
            })
        };
        for (err, forget) in [
            (remote(403, CODE_NOT_EDGE), true),
            (CallError::Unreachable("x".into()), false),
            (CallError::Rejected, false),
            (remote(404, "not_found"), false),
            (CallError::Unreachable("boom".into()), false),
        ] {
            let a = new_test_mesh("a");
            a.set_edges(vec![peer.clone()]);
            let gone = Arc::new(AtomicI64::new(0));
            let dials = Arc::new(AtomicI64::new(0));
            let g = gone.clone();
            *a.hooks.not_edge.lock().unwrap() = Some(Arc::new(move |_| {
                g.fetch_add(1, Ordering::SeqCst);
            }));
            let (d2, e2) = (dials.clone(), err.clone());
            a.set_dial(Arc::new(move |_| {
                d2.fetch_add(1, Ordering::SeqCst);
                let e = e2.clone();
                Box::pin(async move { Err(e) })
            }));
            a.dial_edges(OffsetDateTime::now_utc());
            eventually("다시 걸기가 끝난다", || {
                dials.load(Ordering::SeqCst) == 1
                    && a.dial_wait(&peer.fingerprint).is_some_and(|(_, r)| !r)
            })
            .await;
            assert_eq!(gone.load(Ordering::SeqCst) == 1, forget, "{err}");
        }
        let a = new_test_mesh("a");
        a.set_edges(vec![edge_to(&peer.fingerprint, "", 0)]);
        let dials = Arc::new(AtomicI64::new(0));
        let d2 = dials.clone();
        a.set_dial(Arc::new(move |_| {
            d2.fetch_add(1, Ordering::SeqCst);
            Box::pin(async { Err(CallError::Unreachable("x".into())) })
        }));
        a.dial_edges(OffsetDateTime::now_utc());
        assert_eq!(dials.load(Ordering::SeqCst), 0, "주소 없는 간선에 걸었다");
    });
}

// TC-ATF-50 (FR-ATF-50): notify 의 걸기와 자동 재연결은 같은 걸기 상태를 거쳐 겹치지 않는다.
#[test]
fn notify_shares_dial_state() {
    mt().block_on(async {
        for notify_first in [true, false] {
            let a = new_test_mesh("a");
            let peer = edge_to(&"cd".repeat(32), "127.0.0.1", 1);
            a.set_edges(vec![peer.clone()]);
            let dials = Arc::new(AtomicI64::new(0));
            let release = CancellationToken::new();
            let (d2, r2) = (dials.clone(), release.clone());
            a.set_dial(Arc::new(move |_| {
                d2.fetch_add(1, Ordering::SeqCst);
                let r = r2.clone();
                Box::pin(async move {
                    r.cancelled().await;
                    Err(CallError::Unreachable("refused".into()))
                })
            }));
            let m = a.m.clone();
            let fp = peer.fingerprint.clone();
            let spawn_notify =
                move || tokio::spawn(async move { m.notify(&CancellationToken::new(), &fp).await });
            let notified = if notify_first {
                let h = spawn_notify();
                eventually("notify 가 건다", || dials.load(Ordering::SeqCst) == 1).await;
                a.dial_edges(OffsetDateTime::now_utc());
                h
            } else {
                a.dial_edges(OffsetDateTime::now_utc());
                eventually("다시 걸기가 건다", || {
                    dials.load(Ordering::SeqCst) == 1
                })
                .await;
                spawn_notify()
            };
            never("두 번째 걸기", || dials.load(Ordering::SeqCst) > 1).await;
            release.cancel();
            let err = notified.await.unwrap().unwrap_err();
            assert_eq!(
                err.kind(),
                ErrorKind::Unreachable,
                "notify_first={notify_first}"
            );
            assert_eq!(dials.load(Ordering::SeqCst), 1);
        }
    });
}

// --- 다시 걸기 간격 ---

/// 붙자마자 끊기는 연결을 주는 걸기다. keep 이 참이면 그 회차의 상대 끝을 kept 로 넘긴다.
fn short_dial(dials: Arc<AtomicI64>) -> DialFn {
    Arc::new(move |_| {
        dials.fetch_add(1, Ordering::SeqCst);
        let (p1, _p2, kill) = pipe();
        kill.cancel();
        Box::pin(async move { Ok(conn(p1)) })
    })
}

// TC-ATF-77 (FR-ATF-77 · AT-MESH-1): 붙자마자 끊기는 상대에는 걸 때마다 간격이 늘어난다.
#[test]
fn redial_backoff_grows_on_short_link() {
    mt().block_on(async {
        let a = new_test_mesh("a");
        let peer = edge_to(&"ef".repeat(32), "127.0.0.1", 1);
        a.set_edges(vec![peer.clone()]);
        let dials = Arc::new(AtomicI64::new(0));
        a.set_dial(short_dial(dials.clone()));
        let mut at = OffsetDateTime::now_utc();
        let mut want = REDIAL_MIN;
        for i in 1..=3 {
            a.dial_edges(at);
            eventually("걸고 끊긴다", || {
                a.dial_wait(&peer.fingerprint).is_some_and(|(w, running)| {
                    dials.load(Ordering::SeqCst) == i
                        && !running
                        && !a.linked(&peer.fingerprint)
                        && w == want * 2
                })
            })
            .await;
            want *= 2;
            at += REDIAL_MAX;
        }
    });
}

// TC-ATF-77: 생존 판정 시간 동안 유지된 연결이 끊기면 간격을 처음 값으로 되돌린다.
#[test]
fn redial_backoff_resets_after_long_link() {
    mt().block_on(async {
        let a = new_test_mesh("a");
        a.inner.lock().dead_after = Duration::from_millis(50);
        let peer = edge_to(&"ef".repeat(32), "127.0.0.1", 1);
        a.set_edges(vec![peer.clone()]);
        let dials = Arc::new(AtomicI64::new(0));
        let kept: Arc<Mutex<Option<CancellationToken>>> = Arc::default();
        let (d2, k2) = (dials.clone(), kept.clone());
        a.set_dial(Arc::new(move |_| {
            let (p1, p2, kill) = pipe();
            if d2.fetch_add(1, Ordering::SeqCst) == 0 {
                kill.cancel();
            } else {
                *k2.lock().unwrap() = Some(kill);
                // 상대 끝은 읽기만 하고 닫지 않는다.
                tokio::spawn(async move {
                    let mut p2 = p2;
                    let mut buf = vec![0u8; PIPE_BUF];
                    while matches!(p2.read(&mut buf).await, Ok(n) if n > 0) {}
                });
            }
            Box::pin(async move { Ok(conn(p1)) })
        }));
        a.dial_edges(OffsetDateTime::now_utc());
        eventually("첫 연결이 끊긴다", || {
            a.dial_wait(&peer.fingerprint).is_some_and(|(w, running)| {
                !running && !a.linked(&peer.fingerprint) && w == 2 * REDIAL_MIN
            })
        })
        .await;
        a.dial_edges(OffsetDateTime::now_utc() + REDIAL_MAX);
        eventually("두 번째 연결", || a.linked(&peer.fingerprint)).await;
        tokio::time::sleep(Duration::from_millis(80)).await;
        kept.lock().unwrap().take().unwrap().cancel();
        eventually("간격이 처음 값", || {
            !a.linked(&peer.fingerprint)
                && a.dial_wait(&peer.fingerprint)
                    .is_some_and(|(w, _)| w == REDIAL_MIN)
        })
        .await;
    });
}

// TC-ATF-77: attach 가 중복으로 버린 연결은 실패로 센다.
#[test]
fn redial_duplicate_counts_as_failure() {
    mt().block_on(async {
        let a = new_test_mesh("a");
        // 지문이 작은 쪽이 건 연결을 남긴다 — 상대가 건 연결이 먼저 있으면 이쪽이 건 것은 버려진다.
        let peer = edge_to(&"00".repeat(32), "127.0.0.1", 1);
        a.set_edges(vec![peer.clone()]);
        let (am, pfp) = (a.m.clone(), peer.fingerprint.clone());
        a.set_dial(Arc::new(move |_| {
            // Go 처럼 상대 끝을 닫지 않고 둔다.
            let (inc, o, k1) = pipe();
            std::mem::forget((o, k1));
            am.attach(&pfp, conn(inc), false);
            let (p1, o2, k2) = pipe();
            std::mem::forget((o2, k2));
            Box::pin(async move { Ok(conn(p1)) })
        }));
        a.dial_edges(OffsetDateTime::now_utc());
        eventually("걸기가 끝난다", || {
            let st = a.inner.lock();
            st.dialing.get(&peer.fingerprint).is_some_and(|d| {
                let g = d.lock().unwrap();
                !g.running && g.done.is_some()
            })
        })
        .await;
        let (err, wait) = {
            let st = a.inner.lock();
            let g = st.dialing[&peer.fingerprint].lock().unwrap();
            (g.err.clone(), g.wait)
        };
        assert!(
            err.is_some() && wait == 2 * REDIAL_MIN,
            "중복 연결: err={err:?} wait={wait:?}"
        );
        assert!(a.linked(&peer.fingerprint), "먼저 있던 연결이 사라졌다");
    });
}

#[test]
fn error_display_matches_go() {
    assert_eq!(
        MeshError::from(ErrorKind::Unreachable).to_string(),
        "상대에 닿지 못했다"
    );
    assert_eq!(
        crate::error::MeshError::wrap(
            ErrorKind::Unreachable,
            CallError::Unreachable("boom".into())
        )
        .to_string(),
        "상대에 닿지 못했다: 상대 노드에 닿지 못했습니다: boom"
    );
}

#[test]
fn remote_host_matches_go() {
    use crate::mesh::remote_host;
    assert_eq!(remote_host("127.0.0.1:5".parse().unwrap()), "127.0.0.1");
    assert_eq!(
        remote_host("[::ffff:10.0.0.1]:5".parse().unwrap()),
        "10.0.0.1"
    );
    assert_eq!(remote_host("[::1]:5".parse().unwrap()), "::1");
}

// notify 의 걸기 실패는 원인 CallError 를 그대로 든다 (Go `%w`): 노드가 RemoteError 코드나
// Rejected·FingerprintMismatch 를 가려 오류 코드로 옮긴다.
#[test]
fn notify_failure_keeps_call_error() {
    mt().block_on(async {
        let a = new_test_mesh("a");
        let fp = "ab".repeat(32);
        a.set_edges(vec![edge_to(&fp, "127.0.0.1", 1)]);
        let bg = CancellationToken::new();
        let not_edge = CallError::Remote(RemoteError {
            status: 403,
            code: CODE_NOT_EDGE.into(),
            message: "간선이 아닌 노드입니다".into(),
        });
        for (cause, kind) in [
            (not_edge, ErrorKind::NotEdge),
            (CallError::Rejected, ErrorKind::Unreachable),
            (CallError::FingerprintMismatch, ErrorKind::Unreachable),
            (
                CallError::Unreachable("refused".into()),
                ErrorKind::Unreachable,
            ),
        ] {
            a.set_dial(fail_dial(cause.clone()));
            a.inner.lock().dialing.clear();
            let err = a.notify(&bg, &fp).await.unwrap_err();
            assert_eq!(err.kind(), kind, "{cause}");
            assert_eq!(err.call_error(), Some(&cause));
            assert_eq!(
                err.to_string(),
                format!("{}: {cause}", MeshError::from(kind))
            );
            assert!(std::error::Error::source(&err).is_some());
        }
        let err = MeshError::from(ErrorKind::Outdated);
        assert!(err.call_error().is_none());
    });
}
