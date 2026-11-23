//! PEER_CHAT_SRS §3.9 단계 1 — 데몬의 채팅 핵심 (Go chat_test.go).

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use dm_gocompat::json::RawMessage;
use dm_shared_edge::{Identity, load_or_create_identity};
use dm_shared_edgemesh::{self as edgemesh, Conn, FRAME_NET, Frame, Mesh, encode, sign_frame};
use serde::Serialize;
use tempfile::TempDir;
use time::OffsetDateTime;
use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream};
use tokio_util::sync::CancellationToken;

use crate::frame::{
    FRAME_MSG, FRAME_STATE, MsgBody, RecordBody, SignedRecord, StateBody, StatePart, new_record,
};
use crate::service::{ID_PREFIX, MAX_NODES, MAX_PART_ROOMS};
use crate::*;

const PIPE_BUF: usize = 64 << 10;
const EVENTUALLY: Duration = Duration::from_secs(3);
const NEVER: Duration = Duration::from_millis(200);
const POLL: Duration = Duration::from_millis(5);

pub(crate) fn new_identity() -> (Identity, TempDir) {
    let dir = TempDir::new().unwrap();
    let id = load_or_create_identity(dir.path()).unwrap();
    (id, dir)
}

pub(crate) fn rt() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .unwrap()
}

/// 두 끝을 잇는 메모리 연결이다. 돌려준 토큰을 끊으면 양쪽이 EOF 를 본다 (Go `net.Pipe` 닫기).
pub(crate) fn pipe() -> (DuplexStream, DuplexStream, CancellationToken) {
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

pub(crate) async fn eventually(what: &str, mut cond: impl FnMut() -> bool) {
    let deadline = tokio::time::Instant::now() + EVENTUALLY;
    while tokio::time::Instant::now() < deadline {
        if cond() {
            return;
        }
        tokio::time::sleep(POLL).await;
    }
    panic!("시간 안에 이루어지지 않았다: {what}");
}

pub(crate) async fn never(what: &str, mut cond: impl FnMut() -> bool) {
    let deadline = tokio::time::Instant::now() + NEVER;
    while tokio::time::Instant::now() < deadline {
        if cond() {
            panic!("일어나면 안 되는 일이 일어났다: {what}");
        }
        tokio::time::sleep(POLL).await;
    }
}

pub(crate) type Got = Arc<Mutex<Vec<(String, Message)>>>;

pub(crate) struct TestNode {
    pub svc: Arc<Service>,
    pub mesh: Mesh,
    pub id: Identity,
    pub got: Got,
    _dir: TempDir,
}

impl Drop for TestNode {
    fn drop(&mut self) {
        self.svc.close();
        self.mesh.close();
    }
}

impl std::ops::Deref for TestNode {
    type Target = Service;
    fn deref(&self) -> &Service {
        &self.svc
    }
}

/// 시험 노드의 간선 계층이다. 연결은 link 로 손으로 잇는다.
pub(crate) fn new_mesh(id: &Identity, name: &str) -> Mesh {
    let mut o = edgemesh::Options::new(id.clone());
    let name = name.to_string();
    o.name = Some(Arc::new(move || name.clone()));
    Mesh::new(o)
}

pub(crate) fn recorder(got: &Got) -> DeliverFn {
    let g = got.clone();
    Arc::new(move |pid, m| g.lock().unwrap().push((pid.to_string(), m)))
}

pub(crate) fn new_test_node_with(name: &str, f: impl FnOnce(&mut Options)) -> TestNode {
    let (id, dir) = new_identity();
    let mesh = new_mesh(&id, name);
    let got: Got = Arc::default();
    let mut o = Options::new(id.clone());
    o.mesh = Some(mesh.clone());
    o.deliver = Some(recorder(&got));
    f(&mut o);
    TestNode {
        svc: Service::new(o),
        mesh,
        id,
        got,
        _dir: dir,
    }
}

pub(crate) fn new_test_node(name: &str) -> TestNode {
    new_test_node_with(name, |_| {})
}

impl TestNode {
    pub fn fp(&self) -> String {
        self.id.fingerprint.clone()
    }

    pub fn deliveries(&self, pid: &str) -> Vec<Message> {
        self.got
            .lock()
            .unwrap()
            .iter()
            .filter(|(p, _)| p == pid)
            .map(|(_, m)| m.clone())
            .collect()
    }

    pub fn record_of(&self, id: &str) -> SignedRecord {
        let st = self.lock();
        crate::service::record_locked(&st, id)
            .map(|r| r.rec.clone())
            .unwrap_or_default()
    }

    pub fn record_count(&self) -> usize {
        self.lock().rooms.len()
    }

    pub fn room_visible(&self, pid: &str, room: &str) -> bool {
        self.rooms(pid).iter().any(|r| r.id == room)
    }

    pub fn node_online(&self, fp: &str) -> bool {
        self.online().nodes.iter().any(|n| n.fp == fp && n.online)
    }

    pub fn first_room_members(&self, pid: &str) -> usize {
        self.rooms(pid).first().map_or(0, |r| r.members.len())
    }
}

/// a(건 쪽)와 b 를 메모리 연결로 잇는다. 돌려준 토큰이 끊는다.
pub(crate) fn link(a: &TestNode, b: &TestNode) -> CancellationToken {
    let (p1, p2, kill) = pipe();
    a.mesh.attach(&b.fp(), Conn::new(Box::new(p1)), true);
    b.mesh.attach(&a.fp(), Conn::new(Box::new(p2)), false);
    kill
}

pub(crate) fn must_code(r: Result<impl std::fmt::Debug, Error>, code: &str) {
    match r {
        Err(e) => assert_eq!(e.code(), code, "{e}"),
        Ok(v) => panic!("성공했다: {v:?}, want {code}"),
    }
}

#[derive(Serialize)]
struct NetMsg<'a> {
    node: &'a str,
    key: String,
    name: &'a str,
    epoch: i64,
    seq: u64,
    links: &'a [String],
}

/// 서명한 프레임을 손으로 넣는 상대 노드다.
pub(crate) struct FakePeer {
    pub id: Identity,
    wr: tokio::io::WriteHalf<DuplexStream>,
    pub kill: CancellationToken,
    seq: u64,
    _dir: TempDir,
}

impl Drop for FakePeer {
    fn drop(&mut self) {
        self.kill.cancel();
    }
}

pub(crate) fn new_fake_peer(target: &TestNode) -> FakePeer {
    let (id, dir) = new_identity();
    let (p1, p2, kill) = pipe();
    let (mut rd, wr) = tokio::io::split(p2);
    tokio::spawn(async move {
        let mut buf = vec![0u8; PIPE_BUF];
        while matches!(rd.read(&mut buf).await, Ok(n) if n > 0) {}
    });
    target
        .mesh
        .attach(&id.fingerprint, Conn::new(Box::new(p1)), false);
    FakePeer {
        id,
        wr,
        kill,
        seq: 0,
        _dir: dir,
    }
}

impl FakePeer {
    pub fn fp(&self) -> String {
        self.id.fingerprint.clone()
    }

    /// 이 가짜 노드에 묶인 참가자 id 다.
    pub fn pid(&self, x: &str) -> String {
        format!("{}-{x}", &self.id.fingerprint[..ID_PREFIX])
    }

    pub async fn write(&mut self, fr: &Frame) {
        self.wr.write_all(&encode(fr)).await.unwrap();
    }

    /// 가짜 노드의 채팅 상태를 보낸다. links 가 있으면 간선 계층의 망 정보(net)를 먼저 보낸다 —
    /// 온라인 판정은 간선 계층이 한다 (EDGE_MESH_SRS FR-EGM-42).
    pub async fn state(
        &mut self,
        parts: Vec<StatePart>,
        rooms: Vec<SignedRecord>,
        links: Option<&[String]>,
    ) {
        self.seq += 1;
        if let Some(links) = links {
            let nf = sign_frame(
                &self.id,
                FRAME_NET,
                &NetMsg {
                    node: &self.id.fingerprint,
                    key: edgemesh::public_key(&self.id),
                    name: "fake",
                    epoch: 1,
                    seq: self.seq,
                    links,
                },
            )
            .unwrap();
            self.write(&nf).await;
        }
        let st = StateBody {
            node: self.fp(),
            key: edgemesh::public_key(&self.id),
            epoch: 1,
            seq: self.seq,
            parts: (!parts.is_empty()).then_some(parts),
            rooms: (!rooms.is_empty()).then_some(rooms),
            ..StateBody::default()
        };
        let fr = sign_frame(&self.id, FRAME_STATE, &st).unwrap();
        self.write(&fr).await;
    }

    pub fn msg(&self, id: &str, epoch: i64, seq: u64, room: &str, from: &str, text: &str) -> Frame {
        msg_frame(&self.id, id, epoch, seq, room, from, text)
    }
}

pub(crate) fn msg_frame(
    who: &Identity,
    id: &str,
    epoch: i64,
    seq: u64,
    room: &str,
    from: &str,
    text: &str,
) -> Frame {
    sign_frame(
        who,
        FRAME_MSG,
        &MsgBody {
            id: id.into(),
            node: who.fingerprint.clone(),
            epoch,
            seq,
            room: room.into(),
            from: from.into(),
            text: text.into(),
            at: OffsetDateTime::now_utc(),
        },
    )
    .unwrap()
}

pub(crate) fn part(id: String, label: &str, rooms: &[String]) -> StatePart {
    StatePart {
        id,
        label: label.into(),
        kind: KIND_AGENT.into(),
        rooms: (!rooms.is_empty()).then(|| rooms.to_vec()),
    }
}

fn state_frame(id: &Identity, parts: Option<Vec<StatePart>>) -> Frame {
    sign_frame(
        id,
        FRAME_STATE,
        &StateBody {
            node: id.fingerprint.clone(),
            key: edgemesh::public_key(id),
            epoch: 1,
            seq: 1,
            parts,
            ..StateBody::default()
        },
    )
    .unwrap()
}

fn group_record(id: &Identity, name: &str) -> SignedRecord {
    new_record(
        id,
        RecordBody {
            kind: KIND_GROUP.into(),
            name: name.into(),
            created: OffsetDateTime::now_utc(),
            nonce: "n".into(),
            ..RecordBody::default()
        },
    )
    .unwrap()
}

fn direct_record(
    id: &Identity,
    owner: &str,
    peer: &str,
    peer_node: &str,
    nonce: &str,
) -> SignedRecord {
    new_record(
        id,
        RecordBody {
            kind: KIND_DIRECT.into(),
            owner: owner.into(),
            peer: peer.into(),
            peer_node: peer_node.into(),
            created: OffsetDateTime::now_utc(),
            nonce: nonce.into(),
            ..RecordBody::default()
        },
    )
    .unwrap()
}

fn nonce(i: usize) -> String {
    let c = |n: usize| char::from(b'a' + (n % 26) as u8);
    format!("{}{}", c(i % 26), c(i / 26))
}

// TC-PCH-1 (FR-PCH-1·2·4): A-B-C 에서 간선이 아닌 A 와 C 가 채팅한다. 같은 글은 한 번만 온다.
#[test]
fn chat_across_network_neighbor() {
    rt().block_on(async {
        let (a, b, c) = (new_test_node("a"), new_test_node("b"), new_test_node("c"));
        let _k1 = link(&a, &b);
        let _k2 = link(&b, &c);
        let pa = a.register("a/claude", KIND_AGENT);
        let pc = c.register("c/claude", KIND_AGENT);
        let room = a.create(&pa.id, "auth-review", "리뷰").unwrap();
        eventually("C 가 방을 본다", || c.room_visible(&pc.id, &room.id)).await;
        eventually("A 가 C 를 온라인으로 본다", || {
            a.node_online(&c.fp())
        })
        .await;
        c.join(&pc.id, &room.id).unwrap();
        eventually("A 가 C 의 참가를 본다", || {
            a.rooms(&pa.id)
                .iter()
                .any(|r| r.id == room.id && r.members.len() == 2)
        })
        .await;
        a.send(&pa.id, &room.id, "안녕").unwrap();
        eventually("C 가 글을 받는다", || c.deliveries(&pc.id).len() == 1).await;
        let m = &c.deliveries(&pc.id)[0];
        assert!(
            m.text == "안녕" && m.from == pa.id && m.room == room.id && m.from_label == "a/claude",
            "{m:?}"
        );
        // PEER_CHAT_SRS §3.10: 글에 방 이름·목적을 싣는다 (FR-PCH-13).
        assert!(
            m.room_kind == KIND_GROUP
                && m.room_name == "auth-review"
                && m.room_purpose == "리뷰"
                && m.from_kind == KIND_AGENT,
            "{m:?}"
        );
        never("같은 글이 두 번 온다", || {
            c.deliveries(&pc.id).len() > 1
        })
        .await;
        assert!(a.deliveries(&pa.id).is_empty(), "보낸 이에게 되돌아왔다");
    });
}

// TC-PCH-1 (FR-PCH-4): 고리 모양 망에서도 한 번만 온다.
#[test]
fn chat_ring_delivers_once() {
    rt().block_on(async {
        let (a, b, c) = (new_test_node("a"), new_test_node("b"), new_test_node("c"));
        let _k = [link(&a, &b), link(&b, &c), link(&c, &a)];
        let pa = a.register("a/x", KIND_AGENT);
        let pb = b.register("b/x", KIND_AGENT);
        let room = a.create(&pa.id, "ring", "").unwrap();
        eventually("B 가 방을 본다", || b.room_visible(&pb.id, &room.id)).await;
        b.join(&pb.id, &room.id).unwrap();
        eventually("A 가 B 의 참가를 본다", || {
            a.first_room_members(&pa.id) == 2
        })
        .await;
        a.send(&pa.id, &room.id, "1").unwrap();
        eventually("B 가 받는다", || b.deliveries(&pb.id).len() == 1).await;
        never("두 번 받는다", || b.deliveries(&pb.id).len() > 1).await;
    });
}

// TC-PCH-1 (FR-PCH-5): 서명 뒤에 본문을 바꾼 글은 버려지고, 바른 글은 받는다.
#[test]
fn tampered_message_dropped() {
    rt().block_on(async {
        let a = new_test_node("a");
        let pa = a.register("a/x", KIND_AGENT);
        let room = a.create(&pa.id, "r", "").unwrap();
        let mut f = new_fake_peer(&a);
        let rec = a.record_of(&room.id);
        let from = f.pid("fp1");
        f.state(
            vec![part(from.clone(), "fake/x", std::slice::from_ref(&room.id))],
            vec![rec],
            Some(&[a.fp()]),
        )
        .await;
        eventually("A 가 가짜 노드의 참가자를 본다", || {
            a.first_room_members(&pa.id) == 2
        })
        .await;
        let fr = f.msg("m1", 1, 1, &room.id, &from, "원문");
        let mut tampered = fr.clone();
        let body = String::from_utf8(fr.b.0.clone())
            .unwrap()
            .replacen("원문", "바꿈", 1);
        tampered.b = RawMessage(body.into_bytes());
        f.write(&tampered).await;
        never("바꾼 글이 전달된다", || {
            !a.deliveries(&pa.id).is_empty()
        })
        .await;
        f.write(&fr).await;
        eventually("바른 글이 전달된다", || {
            a.deliveries(&pa.id).len() == 1
        })
        .await;
        assert_eq!(a.deliveries(&pa.id)[0].text, "원문");
    });
}

// FR-PCH-5: 다른 노드인 척한 상태(지문과 키가 맞지 않음)는 버린다.
#[test]
fn state_with_foreign_key_dropped() {
    rt().block_on(async {
        let a = new_test_node("a");
        let mut f = new_fake_peer(&a);
        let (other, _d) = new_identity();
        let fr = sign_frame(
            &f.id,
            FRAME_STATE,
            &StateBody {
                node: other.fingerprint.clone(),
                key: edgemesh::public_key(&f.id),
                epoch: 1,
                seq: 1,
                ..StateBody::default()
            },
        )
        .unwrap();
        f.write(&fr).await;
        never("가짜 노드가 목록에 선다", || {
            a.online().nodes.iter().any(|n| n.fp == other.fingerprint)
        })
        .await;
    });
}

// FR-PCH-21: 방이 있다고 말하는 참가자가 없으면 방은 목록에 서지 않는다.
#[test]
fn room_without_claim_not_listed() {
    rt().block_on(async {
        let a = new_test_node("a");
        let pa = a.register("a/x", KIND_AGENT);
        let mut f = new_fake_peer(&a);
        let rec = group_record(&f.id, "ghost");
        f.state(vec![], vec![rec], Some(&[a.fp()])).await;
        never("주장 없는 방이 보인다", || {
            !a.rooms(&pa.id).is_empty()
        })
        .await;
    });
}

// TC-PCH-2 (FR-PCH-10): 생성 기록을 바꾼 방은 버린다.
#[test]
fn tampered_room_record_dropped() {
    rt().block_on(async {
        let a = new_test_node("a");
        let pa = a.register("a/x", KIND_AGENT);
        let mut f = new_fake_peer(&a);
        let mut rec = group_record(&f.id, "real");
        let room_id = rec.id();
        let body = String::from_utf8(rec.b.0.clone())
            .unwrap()
            .replacen("real", "fake", 1);
        rec.b = RawMessage(body.into_bytes());
        let p = part(f.pid("p"), "f/x", &[room_id]);
        f.state(vec![p], vec![rec], Some(&[a.fp()])).await;
        never("바꾼 방이 보인다", || !a.rooms(&pa.id).is_empty()).await;
    });
}

// TC-PCH-3 (FR-PCH-20~24): 마지막 퇴장에 방이 사라진다. 늦게 들어오면 그 뒤의 글만 받는다.
#[test]
fn last_leave_and_late_join() {
    rt().block_on(async {
        let (a, b) = (new_test_node("a"), new_test_node("b"));
        let _k = link(&a, &b);
        let pa = a.register("a/x", KIND_AGENT);
        let pb = b.register("b/x", KIND_AGENT);
        let room = a.create(&pa.id, "r", "목적").unwrap();
        eventually("B 가 방을 본다", || b.room_visible(&pb.id, &room.id)).await;
        a.send(&pa.id, &room.id, "들어오기 전").unwrap();
        // 같은 연결에서 글 뒤에 오는 상태 알림을 기다려, 글이 B 에 먼저 닿은 것을 확인한다.
        let marker = a.register("a/marker", KIND_AGENT);
        eventually("B 가 글 뒤의 상태를 받는다", || {
            b.online().participants.iter().any(|m| m.id == marker.id)
        })
        .await;
        let info = b.join(&pb.id, &room.id).unwrap();
        assert_eq!(info.purpose, "목적");
        eventually("A 가 B 의 참가를 본다", || {
            a.rooms(&pa.id)
                .iter()
                .any(|r| r.id == room.id && r.members.len() == 2)
        })
        .await;
        a.send(&pa.id, &room.id, "들어온 뒤").unwrap();
        eventually("B 가 받는다", || b.deliveries(&pb.id).len() == 1).await;
        assert_eq!(b.deliveries(&pb.id)[0].text, "들어온 뒤");
        a.leave(&pa.id, &room.id).unwrap();
        eventually("A 에 방 기록이 없다", || a.record_count() == 0).await;
        assert!(
            b.room_visible(&pb.id, &room.id),
            "B 가 남았는데 방이 사라졌다"
        );
        eventually("A 가 아직 방을 본다(B 가 말한다)", || {
            a.room_visible(&pa.id, &room.id)
        })
        .await;
        b.leave(&pb.id, &room.id).unwrap();
        eventually("방이 모두에게서 사라진다", || {
            !a.room_visible(&pa.id, &room.id)
                && !b.room_visible(&pb.id, &room.id)
                && b.record_count() == 0
        })
        .await;
    });
}

// TC-PCH-4 (FR-PCH-30~33): 갈라지면 양쪽이 쓰고, 그동안의 글은 건너가지 않는다. 이어지면 합친다.
#[test]
fn partition_and_merge() {
    rt().block_on(async {
        let (a, b) = (new_test_node("a"), new_test_node("b"));
        let cut = link(&a, &b);
        let pa = a.register("a/x", KIND_AGENT);
        let pb = b.register("b/x", KIND_AGENT);
        let room = a.create(&pa.id, "r", "").unwrap();
        eventually("B 가 방을 본다", || b.room_visible(&pb.id, &room.id)).await;
        b.join(&pb.id, &room.id).unwrap();
        eventually("A 가 B 의 참가를 본다", || {
            a.first_room_members(&pa.id) == 2
        })
        .await;
        cut.cancel();
        eventually("A 가 B 를 연결 끊김으로 본다", || {
            !a.node_online(&b.fp())
        })
        .await;
        eventually("B 가 A 를 연결 끊김으로 본다", || {
            !b.node_online(&a.fp())
        })
        .await;
        a.send(&pa.id, &room.id, "갈라진 동안").unwrap();
        b.send(&pb.id, &room.id, "갈라진 동안 B").unwrap();
        assert!(
            b.room_visible(&pb.id, &room.id),
            "갈라진 B 쪽에서 방이 사라졌다"
        );
        let offline = b.rooms(&pb.id)[0]
            .members
            .iter()
            .any(|m| m.id == pa.id && !m.online);
        assert!(offline, "A 의 참가자가 연결 끊김으로 보이지 않는다");
        let _k = link(&b, &a);
        eventually("다시 온라인", || {
            a.node_online(&b.fp()) && b.node_online(&a.fp())
        })
        .await;
        for i in 0..5 {
            a.send(&pa.id, &room.id, &i.to_string()).unwrap();
        }
        eventually("B 가 다섯 글을 받는다", || {
            b.deliveries(&pb.id).len() == 5
        })
        .await;
        let got: String = b
            .deliveries(&pb.id)
            .iter()
            .map(|m| m.text.as_str())
            .collect();
        assert_eq!(got, "01234", "갈라진 동안의 글이 섞였거나 순서가 틀렸다");
    });
}

// FR-PCH-33: 다른 곳에서 소멸한 방을 돌아온 노드가 말하면 그 참가자만의 방으로 다시 보인다.
#[test]
fn returning_node_revives_room() {
    rt().block_on(async {
        let (a, b) = (new_test_node("a"), new_test_node("b"));
        let cut = link(&a, &b);
        let pa = a.register("a/x", KIND_AGENT);
        let pb = b.register("b/x", KIND_AGENT);
        let room = a.create(&pa.id, "r", "").unwrap();
        eventually("B 가 방을 본다", || b.room_visible(&pb.id, &room.id)).await;
        b.join(&pb.id, &room.id).unwrap();
        eventually("A 가 B 의 참가를 본다", || {
            a.first_room_members(&pa.id) == 2
        })
        .await;
        cut.cancel();
        eventually("끊김", || !a.node_online(&b.fp())).await;
        a.leave(&pa.id, &room.id).unwrap();
        eventually("A 에서 방이 사라진다", || {
            !a.room_visible(&pa.id, &room.id)
        })
        .await;
        let _k = link(&a, &b);
        eventually("A 가 B 만 있는 방을 다시 본다", || {
            a.rooms(&pa.id).iter().any(|r| {
                r.id == room.id && r.members.len() == 1 && r.members[0].id == pb.id && !r.joined
            })
        })
        .await;
    });
}

// TC-PCH-5 (FR-PCH-43·44): 참가자를 없애면 모든 방에서 나가고, 새로 만들면 방이 없다.
#[test]
fn unregister_leaves_all_rooms() {
    rt().block_on(async {
        let (a, b) = (new_test_node("a"), new_test_node("b"));
        let _k = link(&a, &b);
        let pa = a.register("a/x", KIND_AGENT);
        let pb = b.register("b/x", KIND_AGENT);
        let r1 = a.create(&pa.id, "r1", "").unwrap();
        a.create(&pa.id, "r2", "").unwrap();
        eventually("B 가 두 방을 본다", || b.rooms(&pb.id).len() == 2).await;
        a.unregister(&pa.id);
        eventually("두 방이 사라진다", || b.rooms(&pb.id).is_empty()).await;
        must_code(a.send(&pa.id, &r1.id, "x"), CODE_NO_SUCH_PARTICIPANT);
        let again = a.register("a/x", KIND_AGENT);
        assert!(
            again.id != pa.id && a.rooms(&again.id).is_empty(),
            "새 참가자가 이전 참가자를 잇는다"
        );
    });
}

// FR-PCH-44: 들지 않은 방에 쓰면 not_in_room, 없는 방에 들어가면 no_such_room.
#[test]
fn send_not_in_room() {
    rt().block_on(async {
        let a = new_test_node("a");
        let pa = a.register("a/x", KIND_AGENT);
        let pb = a.register("a/y", KIND_AGENT);
        let room = a.create(&pa.id, "r", "").unwrap();
        must_code(a.send(&pb.id, &room.id, "x"), CODE_NOT_IN_ROOM);
        must_code(a.join(&pb.id, "nope"), CODE_NO_SUCH_ROOM);
        // FR-PCH-45: 같은 노드 안에서도 대화한다.
        a.join(&pb.id, &room.id).unwrap();
        a.send(&pa.id, &room.id, "local").unwrap();
        eventually("같은 노드의 참가자가 받는다", || {
            a.deliveries(&pb.id).len() == 1
        })
        .await;
    });
}

// TC-PCH-10 (FR-PCH-14~17): 개인채팅.
#[test]
fn direct_chat() {
    rt().block_on(async {
        let (a, b) = (new_test_node("a"), new_test_node("b"));
        let _k = link(&a, &b);
        let pa = a.register("a/x", KIND_AGENT);
        let pb = b.register("b/x", KIND_AGENT);
        let pc = b.register("b/y", KIND_AGENT);
        eventually("A 가 B 의 참가자를 본다", || {
            a.online().participants.len() == 3
        })
        .await;
        must_code(a.direct(&pa.id, "nobody", ""), CODE_NO_SUCH_PARTICIPANT);
        let room = a.direct(&pa.id, &pb.id, "1대1").unwrap();
        eventually("상대가 자동으로 들어간다", || {
            b.rooms(&pb.id)
                .iter()
                .any(|r| r.id == room.id && r.joined && r.kind == KIND_DIRECT)
        })
        .await;
        assert!(
            !b.room_visible(&pc.id, &room.id),
            "제3자에게 개인채팅이 보인다"
        );
        must_code(b.join(&pc.id, &room.id), CODE_NO_SUCH_ROOM);
        eventually("A 가 상대의 참가를 본다", || {
            a.first_room_members(&pa.id) == 2
        })
        .await;
        a.send(&pa.id, &room.id, "hi").unwrap();
        eventually("상대가 받는다", || b.deliveries(&pb.id).len() == 1).await;
        b.leave(&pb.id, &room.id).unwrap();
        eventually("만든 쪽도 나가 방이 사라진다", || {
            a.rooms(&pa.id).is_empty() && a.record_count() == 0
        })
        .await;
        never("상대가 다시 들어간다", || {
            b.room_visible(&pb.id, &room.id)
        })
        .await;
    });
}

// FR-PCH-16: 개인채팅 상대가 연결 끊김이 된 것은 떠난 것이 아니다.
#[test]
fn direct_survives_disconnect() {
    rt().block_on(async {
        let (a, b) = (new_test_node("a"), new_test_node("b"));
        let cut = link(&a, &b);
        let pa = a.register("a/x", KIND_AGENT);
        let pb = b.register("b/x", KIND_AGENT);
        eventually("참가자를 본다", || a.online().participants.len() == 2).await;
        let room = a.direct(&pa.id, &pb.id, "").unwrap();
        eventually("A 가 상대의 참가를 본다", || {
            a.first_room_members(&pa.id) == 2
        })
        .await;
        cut.cancel();
        eventually("끊김", || !a.node_online(&b.fp())).await;
        never("끊김에 개인채팅이 끝난다", || {
            !a.room_visible(&pa.id, &room.id)
        })
        .await;
    });
}

// TC-PCH-11 (FR-PCH-8·9·10a): 가운데 간선이 끊기면 너머의 노드가 바로 끊김이 된다.
#[test]
fn reachability_follows_links() {
    rt().block_on(async {
        let (a, b, c) = (new_test_node("a"), new_test_node("b"), new_test_node("c"));
        let _k = link(&a, &b);
        let cut = link(&b, &c);
        eventually("A 가 C 를 본다", || a.node_online(&c.fp())).await;
        cut.cancel();
        eventually("A 가 C 를 끊김으로 본다", || {
            !a.node_online(&c.fp())
        })
        .await;
        assert!(a.node_online(&b.fp()), "B 까지 끊김이 됐다");
        let _k2 = link(&c, &b);
        eventually("C 가 돌아온다", || a.node_online(&c.fp())).await;
    });
}

// TC-PCH-12 (FR-PCH-55): 글 크기와 빈도 상한.
#[test]
fn send_limits() {
    rt().block_on(async {
        let clock = Arc::new(Mutex::new(
            OffsetDateTime::from_unix_timestamp(1_000_000).unwrap(),
        ));
        let c = clock.clone();
        let a = new_test_node_with("a", |o| o.now = Some(Arc::new(move || *c.lock().unwrap())));
        let pa = a.register("a/x", KIND_AGENT);
        let room = a.create(&pa.id, "r", "").unwrap();
        must_code(
            a.send(&pa.id, &room.id, &"x".repeat(MAX_TEXT + 1)),
            CODE_TOO_LARGE,
        );
        a.send(&pa.id, &room.id, &"x".repeat(MAX_TEXT))
            .expect("상한 크기");
        for i in 1..PER_MINUTE {
            a.send(&pa.id, &room.id, "x")
                .unwrap_or_else(|e| panic!("{} 번째: {e}", i + 1));
        }
        must_code(a.send(&pa.id, &room.id, "x"), CODE_RATE_LIMITED);
        *clock.lock().unwrap() += Duration::from_secs(61);
        a.send(&pa.id, &room.id, "x").expect("1분 뒤");
    });
}

// FR-PCH-55: 받는 쪽도 보낸 참가자마다 상한을 센다.
#[test]
fn receive_rate_limited() {
    rt().block_on(async {
        let a = new_test_node("a");
        let pa = a.register("a/x", KIND_AGENT);
        let room = a.create(&pa.id, "r", "").unwrap();
        let mut f = new_fake_peer(&a);
        let from = f.pid("fp1");
        let rec = a.record_of(&room.id);
        f.state(
            vec![part(from.clone(), "f/x", std::slice::from_ref(&room.id))],
            vec![rec],
            Some(&[a.fp()]),
        )
        .await;
        eventually("참가자를 본다", || a.first_room_members(&pa.id) == 2).await;
        for i in 0..PER_MINUTE + 5 {
            let fr = f.msg(
                &format!("m{}", nonce(i)),
                1,
                i as u64 + 1,
                &room.id,
                &from,
                "x",
            );
            f.write(&fr).await;
        }
        eventually("상한만큼 받는다", || {
            a.deliveries(&pa.id).len() == PER_MINUTE
        })
        .await;
        never("상한을 넘겨 받는다", || {
            a.deliveries(&pa.id).len() > PER_MINUTE
        })
        .await;
    });
}

// FR-PCH-8: 같은 상대와 연결이 둘이면 하나만 남기고, 채팅은 그대로 된다.
#[test]
fn duplicate_links_collapse() {
    rt().block_on(async {
        let (a, b) = (new_test_node("a"), new_test_node("b"));
        let _k = [link(&a, &b), link(&b, &a)];
        eventually("이어진다", || {
            a.mesh.linked(&b.fp()) && b.mesh.linked(&a.fp())
        })
        .await;
        let pa = a.register("a/x", KIND_AGENT);
        let pb = b.register("b/x", KIND_AGENT);
        let room = a.create(&pa.id, "r", "").unwrap();
        eventually("B 가 방을 본다", || b.room_visible(&pb.id, &room.id)).await;
        b.join(&pb.id, &room.id).unwrap();
        eventually("A 가 참가를 본다", || {
            a.first_room_members(&pa.id) == 2
        })
        .await;
        a.send(&pa.id, &room.id, "x").unwrap();
        eventually("B 가 받는다", || b.deliveries(&pb.id).len() == 1).await;
    });
}

#[test]
fn error_code_of_plain_error() {
    assert_eq!(Error::plain("x").code(), "");
    assert_eq!(Error::plain("x").to_string(), "x");
    assert_eq!(
        Error::fail(CODE_NOT_IN_ROOM, "r1").to_string(),
        "not_in_room: r1"
    );
}

// FR-PCH-9: 상태 알림은 자기 내용이 바뀔 때만 낸다 — 노드끼리 알림을 끝없이 주고받지 않는다.
#[test]
fn state_announcements_settle() {
    rt().block_on(async {
        let (a, b, c) = (new_test_node("a"), new_test_node("b"), new_test_node("c"));
        let _k = [link(&a, &b), link(&b, &c), link(&c, &a)];
        a.register("a/x", KIND_AGENT);
        eventually("C 가 A 의 참가자를 본다", || {
            c.online().participants.len() == 1
        })
        .await;
        tokio::time::sleep(Duration::from_millis(100)).await;
        let seqs = || [a.lock().seq, b.lock().seq, c.lock().seq];
        let before = seqs();
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(before, seqs(), "알림이 멈추지 않는다");
    });
}

// FR-PCH-15·20 (보안 검토): 개인채팅에는 두 참가자만 쓴다. 제3의 노드가 그 방에 참가자를 적거나
// 상대의 id 를 사칭해도 글은 전달되지 않는다.
#[test]
fn direct_rejects_third_node() {
    rt().block_on(async {
        let (a, b) = (new_test_node("a"), new_test_node("b"));
        let _k = link(&a, &b);
        let pa = a.register("a/x", KIND_AGENT);
        let pb = b.register("b/x", KIND_AGENT);
        eventually("참가자를 본다", || a.online().participants.len() == 2).await;
        let room = a.direct(&pa.id, &pb.id, "").unwrap();
        eventually("A 가 상대의 참가를 본다", || {
            a.first_room_members(&pa.id) == 2
        })
        .await;
        let mut f = new_fake_peer(&a);
        let rec = a.record_of(&room.id);
        for (i, from) in [f.pid("evil"), pb.id.clone()].into_iter().enumerate() {
            f.state(
                vec![part(from.clone(), "f/x", std::slice::from_ref(&room.id))],
                vec![rec.clone()],
                Some(&[a.fp()]),
            )
            .await;
            let fr = f.msg(
                &format!("x{}", nonce(i)),
                1,
                i as u64 + 1,
                &room.id,
                &from,
                "끼어들기",
            );
            f.write(&fr).await;
        }
        never("제3의 노드 글이 개인채팅에 들어온다", || {
            !a.deliveries(&pa.id).is_empty()
        })
        .await;
        b.send(&pb.id, &room.id, "진짜").unwrap();
        eventually("진짜 상대의 글은 온다", || {
            a.deliveries(&pa.id).len() == 1
        })
        .await;
    });
}

// FR-PCH-20 (보안 검토): 이 노드의 참가자 id 를 주장하는 남의 상태는 버린다.
#[test]
fn state_claiming_local_participant_dropped() {
    rt().block_on(async {
        let a = new_test_node("a");
        let pa = a.register("a/x", KIND_AGENT);
        let mut f = new_fake_peer(&a);
        f.state(
            vec![part(pa.id.clone(), "spoof", &[])],
            vec![],
            Some(&[a.fp()]),
        )
        .await;
        never("사칭한 참가자가 목록에 선다", || {
            a.online().participants.len() > 1
        })
        .await;
    });
}

// FR-PCH-4 (보안 검토): 지난 글을 다시 보내도 다시 전달되지 않는다 — 보낸 노드가 다시 선 뒤에도.
#[test]
fn replayed_message_dropped() {
    rt().block_on(async {
        let a = new_test_node("a");
        let pa = a.register("a/x", KIND_AGENT);
        let room = a.create(&pa.id, "r", "").unwrap();
        let mut f = new_fake_peer(&a);
        let from = f.pid("fp1");
        let rec = a.record_of(&room.id);
        f.state(
            vec![part(from.clone(), "f/x", std::slice::from_ref(&room.id))],
            vec![rec],
            Some(&[a.fp()]),
        )
        .await;
        eventually("참가자를 본다", || a.first_room_members(&pa.id) == 2).await;
        let old = f.msg("old", 1, 1, &room.id, &from, "1");
        f.write(&old).await;
        eventually("처음 글", || a.deliveries(&pa.id).len() == 1).await;
        f.write(&old).await;
        never("같은 글이 다시 온다", || {
            a.deliveries(&pa.id).len() > 1
        })
        .await;
        let stale = f.msg("stale", 0, 9, &room.id, &from, "2");
        f.write(&stale).await;
        never("지난 epoch 의 글이 온다", || {
            a.deliveries(&pa.id).len() > 1
        })
        .await;
    });
}

// 보안 검토: 줄바꿈·탭 밖의 제어 문자가 든 글은 보내지도 받지도 않는다.
#[test]
fn control_chars_rejected() {
    rt().block_on(async {
        let a = new_test_node("a");
        let pa = a.register("a/x", KIND_AGENT);
        let room = a.create(&pa.id, "r", "").unwrap();
        must_code(a.send(&pa.id, &room.id, "a\x1b[2Jb"), CODE_BAD_REQUEST);
        a.send(&pa.id, &room.id, "줄\n바꿈\t탭").expect("줄바꿈·탭");
        let mut f = new_fake_peer(&a);
        let from = f.pid("fp1");
        let rec = a.record_of(&room.id);
        f.state(
            vec![part(from.clone(), "f/x", std::slice::from_ref(&room.id))],
            vec![rec],
            Some(&[a.fp()]),
        )
        .await;
        eventually("참가자를 본다", || a.first_room_members(&pa.id) == 2).await;
        let fr = f.msg("esc", 1, 1, &room.id, &from, "\x1b]0;x\x07");
        f.write(&fr).await;
        never("제어 문자 글이 온다", || {
            !a.deliveries(&pa.id).is_empty()
        })
        .await;
    });
}

// 보안 검토: 아는 노드 수에 상한이 있다. 가득 차면 닿지 않는 노드부터 잊는다.
#[test]
fn remote_nodes_capped() {
    rt().block_on(async {
        let a = new_test_node("a");
        let mut f = new_fake_peer(&a);
        for _ in 0..MAX_NODES + 10 {
            let (id, _d) = new_identity();
            f.write(&state_frame(&id, None)).await;
        }
        f.state(vec![], vec![], Some(&[a.fp()])).await;
        let ffp = f.fp();
        eventually("직접 이어진 노드는 남는다", || {
            a.node_online(&ffp)
        })
        .await;
        let n = a.lock().nodes.len();
        assert!(n <= MAX_NODES, "아는 노드 {n} > {MAX_NODES}");
    });
}

// 보안 검토: 참가자 id 는 노드에 묶인다. 남의 노드 접두어를 단 주장은 버려지고, 진짜 노드의 상태는
// 막히지 않는다.
#[test]
fn participant_id_bound_to_node() {
    rt().block_on(async {
        let (a, b) = (new_test_node("a"), new_test_node("b"));
        let pb = b.register("b/x", KIND_AGENT);
        assert_eq!(
            &pb.id[..ID_PREFIX],
            &b.fp()[..ID_PREFIX],
            "id 가 노드에 묶이지 않았다"
        );
        let mut f = new_fake_peer(&a);
        f.state(
            vec![part(pb.id.clone(), "squat", &[])],
            vec![],
            Some(&[a.fp()]),
        )
        .await;
        let _k = link(&a, &b);
        eventually("진짜 B 의 참가자가 보인다", || {
            a.online()
                .participants
                .iter()
                .any(|m| m.id == pb.id && m.label == "b/x" && m.node == b.fp())
        })
        .await;
    });
}

// 보안 검토: 잊은 노드의 옛 상태와 옛 글을 다시 보내도 받지 않는다.
#[test]
fn evicted_node_replay_dropped() {
    rt().block_on(async {
        let a = new_test_node("a");
        a.lock().max_nodes = 2;
        let pa = a.register("a/x", KIND_AGENT);
        let room = a.create(&pa.id, "r", "").unwrap();
        let mut f = new_fake_peer(&a);
        f.state(vec![], vec![], Some(&[a.fp()])).await;
        let (x, _dx) = new_identity();
        let xp = format!("{}-x", &x.fingerprint[..ID_PREFIX]);
        let x_state = state_frame(
            &x,
            Some(vec![part(
                xp.clone(),
                "x/x",
                std::slice::from_ref(&room.id),
            )]),
        );
        let x_msg = msg_frame(&x, "xm", 1, 1, &room.id, &xp, "옛 글");
        f.write(&x_state).await;
        f.write(&x_msg).await;
        eventually("X 의 글을 받는다", || a.deliveries(&pa.id).len() == 1).await;
        let (y, _dy) = new_identity();
        f.write(&state_frame(&y, None)).await;
        let xfp = x.fingerprint.clone();
        eventually("X 를 잊는다", || !a.lock().nodes.contains_key(&xfp)).await;
        // 자리를 늘려, X 를 다시 들일지는 상한이 아니라 기억한 번호로만 가르게 한다.
        a.lock().max_nodes = 3;
        f.write(&x_state).await;
        f.write(&x_msg).await;
        never("옛 글이 다시 온다", || {
            a.deliveries(&pa.id).len() > 1
        })
        .await;
    });
}

// 보안 검토: 1대1 채팅 상대의 노드를 잊게 만들어도 채팅이 끝나지 않는다.
#[test]
fn direct_peer_node_not_evicted() {
    rt().block_on(async {
        let (a, b) = (new_test_node("a"), new_test_node("b"));
        let cut = link(&a, &b);
        let pa = a.register("a/x", KIND_AGENT);
        let pb = b.register("b/x", KIND_AGENT);
        eventually("참가자를 본다", || a.online().participants.len() == 2).await;
        let room = a.direct(&pa.id, &pb.id, "").unwrap();
        eventually("A 가 상대의 참가를 본다", || {
            a.first_room_members(&pa.id) == 2
        })
        .await;
        cut.cancel();
        eventually("끊김", || !a.node_online(&b.fp())).await;
        a.lock().max_nodes = 2;
        let mut f = new_fake_peer(&a);
        f.state(vec![], vec![], Some(&[a.fp()])).await;
        let (y, _dy) = new_identity();
        f.write(&state_frame(&y, None)).await;
        never("1대1 채팅이 끝난다", || {
            !a.room_visible(&pa.id, &room.id)
        })
        .await;
    });
}

// 보안 검토: 남이 만든 개인채팅에 자동으로 들어가는 것도 방 상한을 지킨다.
#[test]
fn direct_auto_join_capped() {
    rt().block_on(async {
        let a = new_test_node("a");
        let pa = a.register("a/x", KIND_AGENT);
        let mut f = new_fake_peer(&a);
        let owners = [f.pid("o1"), f.pid("o2")];
        let mut recs = Vec::new();
        let mut by_owner: [Vec<String>; 2] = Default::default();
        for i in 0..MAX_PART_ROOMS + 5 {
            let o = i / MAX_PART_ROOMS;
            let rec = direct_record(&f.id, &owners[o], &pa.id, &a.fp(), &nonce(i));
            by_owner[o].push(rec.id());
            recs.push(rec);
        }
        f.state(
            vec![
                part(owners[0].clone(), "f/o1", &by_owner[0]),
                part(owners[1].clone(), "f/o2", &by_owner[1]),
            ],
            recs,
            Some(&[a.fp()]),
        )
        .await;
        eventually("상한까지 들어간다", || {
            a.rooms(&pa.id).len() >= MAX_PART_ROOMS
        })
        .await;
        never("상한을 넘어 들어간다", || {
            a.rooms(&pa.id).iter().filter(|r| r.joined).count() > MAX_PART_ROOMS
        })
        .await;
    });
}

// PEER_CHAT_SRS §3.11: 상태가 바뀌면 changed 로 알린다. 화면이 다시 읽는 계기다.
#[test]
fn changed_notifies() {
    rt().block_on(async {
        let n = Arc::new(AtomicUsize::new(0));
        let n2 = n.clone();
        let a = new_test_node_with("a", |o| {
            o.changed = Some(Arc::new(move || {
                n2.fetch_add(1, Ordering::SeqCst);
            }))
        });
        let count = || n.load(Ordering::SeqCst);
        let before = count();
        let p = a.register("a/x", KIND_AGENT);
        eventually("참가 알림", || count() > before).await;
        let before = count();
        a.create(&p.id, "r", "p").unwrap();
        eventually("방 알림", || count() > before).await;
        let b = new_test_node("b");
        let before = count();
        let _k = link(&a, &b);
        b.register("b/y", KIND_AGENT);
        eventually("남의 상태 알림", || count() > before + 1).await;
    });
}

pub(crate) fn left_count(s: &TestNode, pid: &str) -> usize {
    s.lock().parts.get(pid).map_or(0, |p| p.left.len())
}

// TC-ATF-52 (FR-ATF-52): 나간 개인채팅은 상대 노드 상태에 남아 있는 동안 다시 들어가지 않고,
// 상대 노드 상태에서 사라지면 left 에서도 지운다.
#[test]
fn left_direct_forgotten_when_gone() {
    rt().block_on(async {
        let a = new_test_node("a");
        let pa = a.register("a/x", KIND_AGENT);
        let mut f = new_fake_peer(&a);
        let owner = f.pid("o");
        let rec = direct_record(&f.id, &owner, &pa.id, &a.fp(), "n1");
        let rid = rec.id();
        let in_room = vec![part(owner.clone(), "f/o", std::slice::from_ref(&rid))];
        f.state(in_room.clone(), vec![rec.clone()], Some(&[a.fp()]))
            .await;
        eventually("자동으로 들어간다", || a.room_visible(&pa.id, &rid)).await;
        a.leave(&pa.id, &rid).unwrap();
        f.state(in_room, vec![rec], None).await;
        never("방이 남은 동안 다시 들어간다", || {
            a.room_visible(&pa.id, &rid)
        })
        .await;
        assert_eq!(left_count(&a, &pa.id), 1, "방이 남은 동안 left 를 지웠다");
        f.state(vec![part(owner, "f/o", &[])], vec![], None).await;
        eventually("사라진 방을 left 에서 지운다", || {
            left_count(&a, &pa.id) == 0
        })
        .await;
    });
}

// TC-ATF-52 (FR-ATF-52): 1:1 방을 만들고 나가기를 되풀이해도 left 가 쌓이지 않는다.
#[test]
fn left_direct_does_not_grow() {
    rt().block_on(async {
        let (a, b) = (new_test_node("a"), new_test_node("b"));
        let _k = link(&a, &b);
        let pa = a.register("a/x", KIND_AGENT);
        let pb = b.register("b/x", KIND_AGENT);
        eventually("참가자를 본다", || a.online().participants.len() == 2).await;
        for _ in 0..3 {
            let room = a.direct(&pa.id, &pb.id, "").unwrap();
            eventually("상대가 들어간다", || {
                b.room_visible(&pb.id, &room.id)
            })
            .await;
            eventually("A 가 상대의 참가를 본다", || {
                a.first_room_members(&pa.id) == 2
            })
            .await;
            b.leave(&pb.id, &room.id).unwrap();
            eventually("방이 사라진다", || a.record_count() == 0).await;
        }
        eventually("left 가 비워진다", || {
            left_count(&a, &pa.id) == 0 && left_count(&b, &pb.id) == 0
        })
        .await;
    });
}

type Gate = Arc<(Mutex<bool>, Condvar)>;

/// 가짜 노드 f 의 참가자와 a 의 참가자가 함께 든 방이다. g 는 f 의 글을 다른 연결로 나르는 두
/// 번째 가짜 상대다. deliver 는 글 "1" 에서 release 가 열릴 때까지 멈춘다.
struct Ordered {
    a: TestNode,
    f: FakePeer,
    g: FakePeer,
    room: String,
    from: String,
    entered: Arc<Mutex<bool>>,
    release: Gate,
    got: Arc<Mutex<Vec<String>>>,
}

async fn ordered_fixture() -> Ordered {
    let a = new_test_node("a");
    let pa = a.register("a/x", KIND_AGENT);
    let room = a.create(&pa.id, "r", "").unwrap();
    let (mut f, g) = (new_fake_peer(&a), new_fake_peer(&a));
    let from = f.pid("fp1");
    let rec = a.record_of(&room.id);
    f.state(
        vec![part(from.clone(), "f/x", std::slice::from_ref(&room.id))],
        vec![rec],
        Some(&[a.fp()]),
    )
    .await;
    eventually("참가자를 본다", || a.first_room_members(&pa.id) == 2).await;
    let entered: Arc<Mutex<bool>> = Arc::default();
    let release: Gate = Arc::default();
    let got: Arc<Mutex<Vec<String>>> = Arc::default();
    let (e2, r2, g2) = (entered.clone(), release.clone(), got.clone());
    a.lock().deliver = Some(Arc::new(move |_, m: Message| {
        if m.text == "1" {
            *e2.lock().unwrap() = true;
            let mut open = r2.0.lock().unwrap();
            while !*open {
                open = r2.1.wait(open).unwrap();
            }
        }
        g2.lock().unwrap().push(m.text);
    }));
    Ordered {
        a,
        f,
        g,
        room: room.id,
        from,
        entered,
        release,
        got,
    }
}

impl Ordered {
    fn msg(&self, seq: u64) -> Frame {
        let text = seq.to_string();
        self.f
            .msg(&format!("m{text}"), 1, seq, &self.room, &self.from, &text)
    }

    fn delivered(&self) -> Vec<String> {
        self.got.lock().unwrap().clone()
    }

    fn open(&self) {
        *self.release.0.lock().unwrap() = true;
        self.release.1.notify_all();
    }
}

// TC-ATF-53 (FR-ATF-53): 같은 노드의 글은 다른 연결로 와도 받은 순서대로 넘긴다.
#[test]
fn delivery_order_per_node() {
    rt().block_on(async {
        let mut x = ordered_fixture().await;
        let m1 = x.msg(1);
        x.f.write(&m1).await;
        eventually("deliver 가 1 에서 멈춘다", || {
            *x.entered.lock().unwrap()
        })
        .await;
        let m2 = x.msg(2);
        x.g.write(&m2).await;
        never("앞 글을 넘기기 전에 뒷 글을 넘긴다", || {
            !x.delivered().is_empty()
        })
        .await;
        x.open();
        eventually("두 글", || x.delivered().len() == 2).await;
        assert_eq!(x.delivered(), ["1", "2"]);
    });
}

// TC-ATF-54 (FR-ATF-54): close 뒤 들어온 프레임과 줄에 남은 글은 넘기지 않고, 전달 스레드는 끝난다.
#[test]
fn closed_service_drops_frames() {
    rt().block_on(async {
        let mut x = ordered_fixture().await;
        let m1 = x.msg(1);
        x.f.write(&m1).await;
        eventually("deliver 가 1 에서 멈춘다", || {
            *x.entered.lock().unwrap()
        })
        .await;
        let m2 = x.msg(2);
        x.g.write(&m2).await;
        tokio::time::sleep(Duration::from_millis(50)).await;
        x.a.close();
        x.open();
        let m3 = x.msg(3);
        x.f.write(&m3).await;
        never("close 뒤 글을 넘긴다", || x.delivered().len() > 1).await;
        let late = x.f.pid("late");
        x.f.state(vec![part(late, "f/late", &[])], vec![], None)
            .await;
        never("close 뒤 상태를 받는다", || {
            x.a.online()
                .participants
                .iter()
                .any(|m| m.label == "f/late")
        })
        .await;
        eventually("전달 줄이 끝난다", || x.a.lock().queue_count() == 0).await;
    });
}

// TC-ATF-56 (FR-ATF-56): 로컬 상대의 1:1 방도 상대의 방 수 상한을 본다.
#[test]
fn direct_local_peer_capped() {
    rt().block_on(async {
        let a = new_test_node("a");
        let pa = a.register("a/x", KIND_AGENT);
        let pb = a.register("a/y", KIND_AGENT);
        for i in 0..MAX_PART_ROOMS {
            a.create(&pb.id, &format!("r{}", nonce(i)), "").unwrap();
        }
        must_code(a.direct(&pa.id, &pb.id, ""), CODE_BAD_REQUEST);
        assert_eq!(a.rooms(&pb.id).len(), MAX_PART_ROOMS);
    });
}

// 와이어: 상태 알림 본문은 Go 와 같은 필드 이름·순서·omitempty·HTML 이스케이프다.
#[test]
fn state_body_wire_matches_go() {
    let body = StateBody {
        node: "n".into(),
        key: "k".into(),
        epoch: 1,
        seq: 2,
        parts: Some(vec![part("p".into(), "a<b>", &[])]),
        ..StateBody::default()
    };
    assert_eq!(
        String::from_utf8(dm_gocompat::json::marshal(&body).unwrap()).unwrap(),
        "{\"node\":\"n\",\"key\":\"k\",\"epoch\":1,\"seq\":2,\"parts\":[{\"id\":\"p\",\"label\":\"a\\u003cb\\u003e\",\"kind\":\"agent\"}]}"
    );
}
