//! PEER_CHAT_SRS §3.12 단계 4 — 사람 명령 프레임과 도우미 키 신뢰 (Go human_test.go).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use dm_shared_edge::Edge;
use dm_shared_edgemesh::{Conn, Frame, encode, sign_frame};
use dm_shared_humancmd::{self as humancmd, Body, Kick, OP_KICK, OP_KILL, Signed};
use ed25519_dalek::SigningKey;
use time::OffsetDateTime;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::frame::{FRAME_CMD, FRAME_STATE, StateBody};
use crate::human::{agreed, valid_helper_key};
use crate::tests::*;
use crate::*;

struct HumanNode {
    n: TestNode,
    name: String,
    helper: SigningKey,
    edges: Arc<Mutex<Vec<Edge>>>,
    /// 참이면 pin 이 아무것도 적지 않는다(고정하지 못한 노드 흉내).
    no_pin: Arc<AtomicBool>,
}

impl std::ops::Deref for HumanNode {
    type Target = TestNode;
    fn deref(&self) -> &TestNode {
        &self.n
    }
}

fn new_key() -> SigningKey {
    let mut seed = [0u8; 32];
    rand::fill(&mut seed);
    SigningKey::from_bytes(&seed)
}

/// 도우미 키와 간선 목록을 가진 시험 노드다. pin 은 간선 항목에 적는다.
fn new_human_node(name: &str) -> HumanNode {
    let edges: Arc<Mutex<Vec<Edge>>> = Arc::default();
    let no_pin = Arc::new(AtomicBool::new(false));
    let (e1, e2, np) = (edges.clone(), edges.clone(), no_pin.clone());
    let n = new_test_node_with(name, |o| {
        o.edges = Some(Arc::new(move || e1.lock().unwrap().clone()));
        o.pin = Some(Arc::new(move |fp, key| {
            if np.load(Ordering::SeqCst) {
                return;
            }
            for e in e2.lock().unwrap().iter_mut() {
                if e.fingerprint == fp && e.helper_key.is_empty() {
                    e.helper_key = key.to_string();
                }
            }
        }));
    });
    let helper = new_key();
    n.set_helper(&humancmd::public_key(&helper));
    HumanNode {
        n,
        name: name.into(),
        helper,
        edges,
        no_pin,
    }
}

impl HumanNode {
    fn pin_of(&self, fp: &str) -> String {
        self.edges
            .lock()
            .unwrap()
            .iter()
            .find(|e| e.fingerprint == fp)
            .map(|e| e.helper_key.clone())
            .unwrap_or_default()
    }

    fn add_edge(&self, name: &str, fp: &str, helper_key: &str) {
        self.edges.lock().unwrap().push(Edge {
            name: name.into(),
            fingerprint: fp.into(),
            helper_key: helper_key.into(),
            ..Edge::default()
        });
    }

    fn trusted_key(&self, node: &str) -> Option<String> {
        let mut st = self.lock();
        self.svc.trusted_key_locked(&mut st, node)
    }

    fn in_room(&self, pid: &str, room: &str) -> bool {
        self.rooms(pid).iter().any(|r| r.id == room && r.joined)
    }

    fn own(&self) -> Frame {
        self.lock().own.clone()
    }
}

/// 두 노드를 간선으로 등록하고 메모리 연결로 잇는다.
fn edge_link(a: &HumanNode, b: &HumanNode) -> tokio_util::sync::CancellationToken {
    a.add_edge(&b.name, &b.fp(), "");
    b.add_edge(&a.name, &a.fp(), "");
    link(a, b)
}

fn sign_cmd(
    key: &SigningKey,
    node: &str,
    op: &str,
    rooms: &[String],
    kicks: Vec<Kick>,
    at: OffsetDateTime,
) -> Signed {
    humancmd::sign(
        key,
        Body {
            id: humancmd::new_id(),
            node: node.into(),
            op: op.into(),
            rooms: rooms.to_vec(),
            kicks,
            at: (at.unix_timestamp_nanos() / 1_000_000) as i64,
            key: String::new(),
        },
    )
    .unwrap()
}

fn kick(room: &str, pid: &str) -> Vec<Kick> {
    vec![Kick {
        room: room.into(),
        participant: pid.into(),
    }]
}

fn cmd_frame(s: &Signed) -> Frame {
    Frame {
        t: FRAME_CMD.into(),
        b: s.b.clone(),
        s: s.s.clone(),
    }
}

fn now() -> OffsetDateTime {
    OffsetDateTime::now_utc()
}

struct Triangle {
    a: HumanNode,
    b: HumanNode,
    c: HumanNode,
    pa: Participant,
    pb: Participant,
    pc: Participant,
    room: String,
    _links: Vec<tokio_util::sync::CancellationToken>,
}

/// A-B-C(A·C 는 간선 아님)와 C 가 만든 방에 셋이 든 상태다.
async fn triangle() -> Triangle {
    let (a, b, c) = (
        new_human_node("a"),
        new_human_node("b"),
        new_human_node("c"),
    );
    let links = vec![edge_link(&a, &b), edge_link(&b, &c)];
    let (pa, pb, pc) = (
        a.register("a/x", KIND_AGENT),
        b.register("b/x", KIND_AGENT),
        c.register("c/x", KIND_AGENT),
    );
    let room = c.create(&pc.id, "ops", "").unwrap().id;
    eventually("A·B 가 방을 본다", || {
        a.room_visible(&pa.id, &room) && b.room_visible(&pb.id, &room)
    })
    .await;
    a.join(&pa.id, &room).unwrap();
    b.join(&pb.id, &room).unwrap();
    // 간선 상대의 도우미 키가 고정되고, B 의 고정값이 C 에 퍼질 때까지 기다린다.
    eventually("고정", || {
        a.pin_of(&b.fp()) == b.helper_key()
            && b.pin_of(&a.fp()) == a.helper_key()
            && b.pin_of(&c.fp()) == c.helper_key()
            && c.pin_of(&b.fp()) == b.helper_key()
    })
    .await;
    eventually("C 가 A 의 키를 B 의 고정값으로 안다", || {
        c.trusted_key(&a.fp()) == Some(a.helper_key())
    })
    .await;
    Triangle {
        a,
        b,
        c,
        pa,
        pb,
        pc,
        room,
        _links: links,
    }
}

// 간선 상대가 낸 강제 삭제: 모든 노드의 참가자가 나가고 방이 사라진다.
#[test]
fn kill_by_edge_peer() {
    rt().block_on(async {
        let t = triangle().await;
        let room = t.room.clone();
        t.b.command(&sign_cmd(
            &t.b.helper,
            &t.b.fp(),
            OP_KILL,
            std::slice::from_ref(&room),
            vec![],
            now(),
        ))
        .unwrap();
        eventually("셋 모두 방에서 나간다", || {
            !t.a.in_room(&t.pa.id, &room)
                && !t.b.in_room(&t.pb.id, &room)
                && !t.c.in_room(&t.pc.id, &room)
        })
        .await;
        eventually("방이 사라진다", || {
            !t.a.room_visible(&t.pa.id, &room) && !t.c.room_visible(&t.pc.id, &room)
        })
        .await;
    });
}

// 망 이웃이 낸 강퇴: C 는 A 의 키를 B 의 고정값으로 믿는다. 대상만 빠진다.
#[test]
fn kick_by_neighbor() {
    rt().block_on(async {
        let t = triangle().await;
        let room = t.room.clone();
        t.a.command(&sign_cmd(
            &t.a.helper,
            &t.a.fp(),
            OP_KICK,
            &[],
            kick(&room, &t.pc.id),
            now(),
        ))
        .unwrap();
        eventually("C 의 참가자가 빠진다", || {
            !t.c.in_room(&t.pc.id, &room)
        })
        .await;
        never("다른 참가자가 빠진다", || {
            !t.a.in_room(&t.pa.id, &room) || !t.b.in_room(&t.pb.id, &room)
        })
        .await;
    });
}

// 낸 노드는 자기 도우미 키로 서명된 것만 낸다.
#[test]
fn command_own_node_only() {
    rt().block_on(async {
        let t = triangle().await;
        let r = t.a.command(&sign_cmd(
            &t.a.helper,
            &t.b.fp(),
            OP_KILL,
            std::slice::from_ref(&t.room),
            vec![],
            now(),
        ));
        assert!(r.is_err(), "다른 노드 이름의 명령을 냈다");
    });
}

// §3.12a R-3: command 는 서명 본문의 키를 이 노드의 도우미 키로 싣고 같은 잠금 안에서 적용한다.
#[test]
fn command_adopts_signed_key() {
    rt().block_on(async {
        let t = triangle().await;
        t.a.set_helper("");
        let fresh = new_key();
        t.a.command(&sign_cmd(
            &fresh,
            &t.a.fp(),
            OP_KILL,
            std::slice::from_ref(&t.room),
            vec![],
            now(),
        ))
        .unwrap();
        assert_eq!(
            t.a.helper_key(),
            humancmd::public_key(&fresh),
            "서명 본문의 키를 싣지 않았다"
        );
        assert!(!t.a.in_room(&t.pa.id, &t.room), "적용되지 않았다");
    });
}

// 고정 키와 다른 키, 시각 밖, 같은 명령 두 번은 받지 않는다.
#[test]
fn command_rejected() {
    rt().block_on(async {
        let t = triangle().await;
        let room = t.room.clone();
        let other = new_key();
        let kick_a = kick(&room, &t.pa.id);
        t.a.handle(
            "",
            cmd_frame(&sign_cmd(
                &other,
                &t.b.fp(),
                OP_KICK,
                &[],
                kick_a.clone(),
                now(),
            )),
        );
        never("고정과 다른 키의 강퇴", || {
            !t.a.in_room(&t.pa.id, &room)
        })
        .await;
        t.a.handle(
            "",
            cmd_frame(&sign_cmd(
                &t.b.helper,
                &t.b.fp(),
                OP_KICK,
                &[],
                kick_a,
                now() - Duration::from_secs(6 * 60),
            )),
        );
        never("오래된 강퇴", || !t.a.in_room(&t.pa.id, &room)).await;
        let once = sign_cmd(
            &t.a.helper,
            &t.a.fp(),
            OP_KICK,
            &[],
            kick(&room, &t.pb.id),
            now(),
        );
        t.b.handle("", cmd_frame(&once));
        eventually("첫 강퇴", || !t.b.in_room(&t.pb.id, &room)).await;
        t.b.join(&t.pb.id, &room).unwrap();
        t.b.handle("", cmd_frame(&once));
        never("같은 명령의 두 번째 강퇴", || {
            !t.b.in_room(&t.pb.id, &room)
        })
        .await;
    });
}

// 이미 고정한 키는 바꾸지 않는다. 다른 키를 알리는 간선 상대의 명령은 받지 않는다.
#[test]
fn pin_not_replaced() {
    rt().block_on(async {
        let (a, b) = (new_human_node("a"), new_human_node("b"));
        let stale = new_key();
        a.add_edge("b", &b.fp(), &humancmd::public_key(&stale));
        b.add_edge("a", &a.fp(), "");
        let _k = link(&a, &b);
        let (pa, pb) = (a.register("a/x", KIND_AGENT), b.register("b/x", KIND_AGENT));
        let r = b.create(&pb.id, "ops", "").unwrap();
        eventually("A 가 방을 본다", || a.room_visible(&pa.id, &r.id)).await;
        a.join(&pa.id, &r.id).unwrap();
        b.command(&sign_cmd(
            &b.helper,
            &b.fp(),
            OP_KICK,
            &[],
            kick(&r.id, &pa.id),
            now(),
        ))
        .unwrap();
        never("고정과 다른 키의 강퇴", || {
            !a.in_room(&pa.id, &r.id)
        })
        .await;
        assert_eq!(
            a.pin_of(&b.fp()),
            humancmd::public_key(&stale),
            "고정이 바뀌었다"
        );
    });
}

// 망 이웃의 키는 고정값이 하나 이상이고 모두 같을 때만 믿는다.
#[test]
fn agreed_pins() {
    let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
    assert_eq!(agreed(&s(&[])), None);
    assert_eq!(agreed(&s(&["k"])), Some("k".into()));
    assert_eq!(agreed(&s(&["k", "k"])), Some("k".into()));
    assert_eq!(agreed(&s(&["k", "j"])), None);
}

// 보증은 대상 노드와 서로 이어진 간선 상대의 고정값만 센다. 간선이 아닌 노드가 실은 다른 키는
// 믿음을 바꾸지 못한다 (보안 검토).
#[test]
fn non_adjacent_pin_ignored() {
    rt().block_on(async {
        let t = triangle().await;
        let mut f = new_fake_peer(&t.a);
        let other = new_key();
        f.state(vec![], vec![], Some(&[t.a.fp()])).await;
        let st = StateBody {
            node: f.fp(),
            key: dm_shared_edgemesh::public_key(&f.id),
            epoch: 1,
            seq: 2,
            pins: Some([(t.c.fp(), humancmd::public_key(&other))].into()),
            ..StateBody::default()
        };
        let fr = sign_frame(&f.id, FRAME_STATE, &st).unwrap();
        f.write(&fr).await;
        let ffp = f.fp();
        eventually("A 가 가짜 노드를 온라인으로 본다", || {
            t.a.node_online(&ffp)
        })
        .await;
        assert_eq!(
            t.a.trusted_key(&t.c.fp()),
            Some(t.c.helper_key()),
            "간선이 아닌 노드의 고정값에 흔들렸다"
        );
    });
}

// 대상 노드 자신이 알린 helper 와 다른 보증은 믿지 않는다.
#[test]
fn pin_must_match_own_helper() {
    rt().block_on(async {
        let t = triangle().await;
        t.c.set_helper(&humancmd::public_key(&new_key()));
        eventually("A 가 C 를 믿지 않는다", || {
            t.a.trusted_key(&t.c.fp()).is_none()
        })
        .await;
    });
}

#[test]
fn helper_key_shape() {
    assert!(valid_helper_key(&humancmd::public_key(&new_key())));
    assert!(valid_helper_key(""));
    assert!(!valid_helper_key("abc"));
    assert!(!valid_helper_key(&format!("{}x", "A".repeat(44))));
}

// §3.12a R-6: 간선 상대의 같은 상태가 다른 길로 먼저 와도, 직접 연결로 온 상태로 고정한다.
#[test]
fn pin_after_relayed_state() {
    rt().block_on(async {
        let (a, b) = (new_human_node("a"), new_human_node("b"));
        a.add_edge("b", &b.fp(), "");
        let own = b.own();
        a.handle("", own.clone()); // 다른 노드를 거쳐 먼저 온 것처럼
        let (p1, p2, _kill) = pipe();
        let (mut rd, mut wr) = tokio::io::split(p2);
        tokio::spawn(async move {
            let mut buf = vec![0u8; 64 << 10];
            while matches!(rd.read(&mut buf).await, Ok(n) if n > 0) {}
        });
        a.mesh.attach(&b.fp(), Conn::new(Box::new(p1)), true);
        wr.write_all(&encode(&own)).await.unwrap(); // 같은 상태가 직접 연결로 늦게 온다
        eventually("A 가 B 의 도우미 키를 고정한다", || {
            a.pin_of(&b.fp()) == b.helper_key()
        })
        .await;
    });
}

// ATTIC_FIX_SRS TC-ATF-79 (FR-ATF-79 · AT-CHAT-9): 믿지 못하는 노드는 사람 명령을 넘기지 않는다.
// C 는 D 의 고정값으로 A 를 믿지만, A 와 C 사이에는 A 를 믿지 못하는 B 뿐이라 닿지 않는다.
#[test]
fn untrusted_command_not_relayed() {
    rt().block_on(async {
        let (a, b, c, d) = (
            new_human_node("a"),
            new_human_node("b"),
            new_human_node("c"),
            new_human_node("d"),
        );
        b.no_pin.store(true, Ordering::SeqCst);
        let _k = [edge_link(&a, &b), edge_link(&b, &c), edge_link(&a, &d)];
        let (pa, pb, pc) = (
            a.register("a/x", KIND_AGENT),
            b.register("b/x", KIND_AGENT),
            c.register("c/x", KIND_AGENT),
        );
        let r = c.create(&pc.id, "ops", "").unwrap();
        eventually("방이 보인다", || {
            a.room_visible(&pa.id, &r.id) && b.room_visible(&pb.id, &r.id)
        })
        .await;
        b.join(&pb.id, &r.id).unwrap();
        eventually("C 가 D 의 고정값으로 A 를 믿는다", || {
            c.trusted_key(&a.fp()) == Some(a.helper_key())
        })
        .await;
        assert!(
            b.trusted_key(&a.fp()).is_none(),
            "B 가 A 를 믿는다 — 시험 전제가 틀렸다"
        );
        a.command(&sign_cmd(
            &a.helper,
            &a.fp(),
            OP_KILL,
            std::slice::from_ref(&r.id),
            vec![],
            now(),
        ))
        .unwrap();
        never("B 가 넘겨 C 가 적용한다", || {
            !c.in_room(&pc.id, &r.id) || !b.in_room(&pb.id, &r.id)
        })
        .await;
        assert_eq!(b.lock().cmds.len(), 0, "믿지 못한 명령을 기억했다");
    });
}

// 보안 검토: 같은 id 를 단 가짜(다른 키) 명령이 먼저 와도 진짜 명령을 막지 못한다.
#[test]
fn forged_same_id_does_not_suppress() {
    rt().block_on(async {
        let t = triangle().await;
        let real = sign_cmd(
            &t.a.helper,
            &t.a.fp(),
            OP_KICK,
            &[],
            kick(&t.room, &t.pb.id),
            now(),
        );
        let rb = humancmd::open(&real).unwrap();
        let forged = humancmd::sign(
            &new_key(),
            Body {
                id: rb.id.clone(),
                node: t.a.fp(),
                op: rb.op.clone(),
                rooms: vec![],
                kicks: rb.kicks.clone(),
                at: rb.at,
                key: String::new(),
            },
        )
        .unwrap();
        t.b.handle("", cmd_frame(&forged));
        t.b.handle("", cmd_frame(&real));
        eventually("진짜 강퇴가 적용된다", || {
            !t.b.in_room(&t.pb.id, &t.room)
        })
        .await;
    });
}

// 같은 서명을 비정규 base64 로 바꿔 다시 보내도 두 번 적용되지 않는다 (§3.12a R-10).
#[test]
fn non_canonical_replay_ignored() {
    rt().block_on(async {
        let t = triangle().await;
        let real = sign_cmd(
            &t.a.helper,
            &t.a.fp(),
            OP_KICK,
            &[],
            kick(&t.room, &t.pb.id),
            now(),
        );
        t.b.handle("", cmd_frame(&real));
        eventually("강퇴가 적용된다", || !t.b.in_room(&t.pb.id, &t.room)).await;
        t.b.join(&t.pb.id, &t.room).unwrap();
        let replay = Signed {
            b: real.b.clone(),
            s: format!("{}\n{}", &real.s[..10], &real.s[10..]),
        };
        t.b.handle("", cmd_frame(&replay));
        assert!(
            t.b.in_room(&t.pb.id, &t.room),
            "비정규 표기 재전송이 다시 적용됐다"
        );
    });
}

// §3.12a R-6: 간선 목록 캐시가 새 간선을 모르는 채로 그 상대의 직접 연결 상태가 와도 고정한다.
#[test]
fn pin_with_stale_edge_cache() {
    rt().block_on(async {
        let (a, b) = (new_human_node("a"), new_human_node("b"));
        {
            let mut st = a.lock();
            let _ = a.svc.edges_locked(&mut st); // 간선이 없을 때의 목록을 캐시에 둔다
        }
        a.add_edge("b", &b.fp(), "");
        a.handle(&b.fp(), b.own());
        assert_eq!(
            a.pin_of(&b.fp()),
            b.helper_key(),
            "낡은 간선 캐시로 고정을 놓쳤다"
        );
    });
}
