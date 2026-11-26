//! PEER_CHAT_SRS §3.10 — 채팅 소켓 (TC-PCH-6, Go chatsock_test.go·clean_test.go).

use std::sync::mpsc::{Receiver, RecvTimeoutError, channel};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use otter_daemon_chat::{self as chat, Service};
use otter_gocompat::json::{self, RawMessage};
use otter_shared_chatwire::{self as chatwire, Frame, Scanner};
use otter_shared_edge::load_or_create_identity;
use otter_shared_edgemesh::Mesh;
use otter_shared_platform::IpcStream;
use serde::Serialize;
use tempfile::TempDir;

use super::*;

const WAIT: Duration = Duration::from_secs(3);

pub(crate) struct Harness {
    pub srv: Arc<Server>,
    pub svc: Arc<Service>,
    pub path: PathBuf,
    mesh: Mesh,
    _rt: tokio::runtime::Runtime,
    _dirs: (TempDir, TempDir),
}

impl Drop for Harness {
    fn drop(&mut self) {
        self.srv.close();
        self.svc.close();
        self.mesh.close();
    }
}

pub(crate) fn new_harness(f: impl FnOnce(&mut Options)) -> Harness {
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .unwrap();
    let _g = rt.enter();
    let idir = TempDir::new().unwrap();
    let id = load_or_create_identity(idir.path()).unwrap();
    let sdir = tempfile::Builder::new()
        .prefix("ottercs")
        .tempdir()
        .unwrap();
    let path = sdir.path().join("c.sock");
    let mut mo = otter_shared_edgemesh::Options::new(id.clone());
    mo.name = Some(Arc::new(|| "mac".to_string()));
    let mesh = Mesh::new(mo);
    let slot: Arc<Mutex<Option<Arc<Server>>>> = Arc::default();
    let s2 = slot.clone();
    let mut co = chat::Options::new(id);
    co.mesh = Some(mesh.clone());
    co.deliver = Some(Arc::new(move |pid, m| {
        let srv = s2.lock().unwrap().clone();
        if let Some(srv) = srv {
            srv.deliver(pid, m);
        }
    }));
    let svc = Service::new(co);
    let mut o = Options::new(svc.clone());
    o.name = Some(Arc::new(|| "mac".to_string()));
    o.count_wait = Duration::from_millis(100);
    f(&mut o);
    let srv = Server::new(o);
    *slot.lock().unwrap() = Some(srv.clone());
    srv.listen(&path).unwrap();
    let s3 = srv.clone();
    std::thread::spawn(move || s3.serve());
    drop(_g);
    Harness {
        srv,
        svc,
        path,
        mesh,
        _rt: rt,
        _dirs: (idir, sdir),
    }
}

pub(crate) struct Client {
    pub c: Arc<IpcStream>,
    pub n: u64,
    pub inbox: Receiver<Frame>,
}

impl Harness {
    pub fn dial(&self) -> Client {
        let c = Arc::new(
            otter_shared_platform::current()
                .ipc
                .dial(&self.path, Duration::from_secs(1))
                .unwrap(),
        );
        let (tx, rx) = channel();
        let r = c.clone();
        std::thread::spawn(move || {
            let mut sc = Scanner::new(&*r);
            while let Some(line) = sc.next_line() {
                if let Ok(f) = json::unmarshal::<Frame>(&line) {
                    let _ = tx.send(f);
                }
            }
        });
        Client { c, n: 0, inbox: rx }
    }

    pub fn agent(&self, session: &str, tool: &str, tab: &str) -> (Client, Frame) {
        let mut cl = self.dial();
        cl.send(&Frame {
            t: chatwire::TYPE_HELLO.into(),
            session: session.into(),
            tool: tool.into(),
            tab: tab.into(),
            ..Frame::default()
        });
        let hello = cl.next(chatwire::TYPE_HELLO);
        (cl, hello)
    }
}

impl Client {
    pub fn send(&self, f: &Frame) {
        (&*self.c).write_all(&chatwire::encode(f).unwrap()).unwrap();
    }

    pub fn next(&mut self, want: &str) -> Frame {
        match self.inbox.recv_timeout(WAIT) {
            Ok(f) => {
                assert_eq!(f.t, want, "frame {f:?}");
                f
            }
            Err(RecvTimeoutError::Disconnected) => panic!("{want} 를 기다리는데 연결이 닫혔다"),
            Err(RecvTimeoutError::Timeout) => panic!("{want} 가 오지 않는다"),
        }
    }

    pub fn closed(&self) -> bool {
        matches!(
            self.inbox.recv_timeout(WAIT),
            Err(RecvTimeoutError::Disconnected)
        )
    }

    pub fn call<T: Serialize>(&mut self, op: &str, args: &T) -> Frame {
        self.n += 1;
        self.send(&Frame {
            t: chatwire::TYPE_CALL.into(),
            n: self.n,
            op: op.into(),
            args: RawMessage(json::marshal(args).unwrap()),
            ..Frame::default()
        });
        let f = self.next(chatwire::TYPE_REPLY);
        assert_eq!(f.n, self.n, "reply n");
        f
    }
}

pub(crate) fn must_room(f: &Frame) -> chatwire::Room {
    assert!(f.error.is_none(), "error {:?}", f.error);
    json::unmarshal::<chatwire::RoomResult>(&f.result.0)
        .unwrap()
        .room
}

pub(crate) fn eventually(what: &str, mut cond: impl FnMut() -> bool) {
    let deadline = Instant::now() + WAIT;
    while Instant::now() < deadline {
        if cond() {
            return;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    panic!("{what}: 시간 초과");
}

#[derive(Serialize)]
struct Empty {}

#[test]
fn hello_registers_participant() {
    let h = new_harness(|_| {});
    let (_a, hello) = h.agent("s1", "01a1e8ee-e475-7000", "review");
    assert!(
        hello.label == "mac/review" && hello.id.contains('-'),
        "{hello:?}"
    );
    let (_b, anon) = h.agent("s2", "01a1e8ee-e475-7000", "");
    assert_eq!(anon.label, "mac/tool-01a1e8ee");
    assert_eq!(h.svc.online().participants.len(), 2);
}

#[test]
fn hello_sanitizes_tab() {
    let h = new_harness(|_| {});
    let tab = format!("a\x1b[31mb{}", "x".repeat(100));
    let (_c, hello) = h.agent("s1", "t1", &tab);
    assert!(
        !hello.label.contains('\x1b') && hello.label.len() <= MAX_LABEL,
        "{}",
        hello.label
    );
}

// 에이전트는 사람 참가자의 이름 `<노드>/User` 로 보이지 않는다.
#[test]
fn agent_cannot_take_user_label() {
    let h = new_harness(|_| {});
    for tab in ["User", " user ", "uſer"] {
        let (_c, hello) = h.agent(&format!("s-{tab}"), "t1", tab);
        assert!(
            !is_user_tab(hello.label.trim_start_matches("mac/")),
            "{tab:?}: {}",
            hello.label
        );
    }
}

#[test]
fn hello_requires_session_and_tool() {
    let h = new_harness(|_| {});
    for f in [
        Frame {
            t: chatwire::TYPE_HELLO.into(),
            tool: "t1".into(),
            ..Frame::default()
        },
        Frame {
            t: chatwire::TYPE_HELLO.into(),
            session: "s1".into(),
            ..Frame::default()
        },
        Frame {
            t: chatwire::TYPE_CALL.into(),
            op: chatwire::OP_ONLINE.into(),
            ..Frame::default()
        },
    ] {
        let mut cl = h.dial();
        cl.send(&f);
        let e = cl.next(chatwire::TYPE_ERROR);
        assert_eq!(e.error.unwrap().code, chatwire::CODE_BAD_REQUEST);
        assert!(cl.closed(), "연결이 닫히지 않았다");
    }
}

#[test]
fn participant_cap() {
    let h = new_harness(|o| o.max_agents = 1);
    let _a = h.agent("s1", "t1", "a");
    let mut cl = h.dial();
    cl.send(&Frame {
        t: chatwire::TYPE_HELLO.into(),
        session: "s2".into(),
        tool: "t2".into(),
        ..Frame::default()
    });
    let e = cl.next(chatwire::TYPE_ERROR).error.unwrap();
    assert_eq!(e.code, chatwire::CODE_FULL);
    assert_eq!(e.message, "참가자 상한 1");
}

#[test]
fn calls_and_delivery() {
    let h = new_harness(|_| {});
    let (mut a, _) = h.agent("sa", "ta", "a");
    let (mut b, hb) = h.agent("sb", "tb", "b");
    let room = must_room(&a.call(
        chatwire::OP_CREATE,
        &chatwire::CreateArgs {
            name: "auth".into(),
            purpose: "리뷰".into(),
        },
    ));
    assert!(
        room.name == "auth" && room.joined && room.members == 1,
        "{room:?}"
    );
    let f = b.call(
        chatwire::OP_SEND,
        &chatwire::SendArgs {
            room: room.id.clone(),
            text: "x".into(),
            call: None,
        },
    );
    let e = f.error.unwrap();
    assert_eq!(e.code, chat::CODE_NOT_IN_ROOM);
    assert_eq!(e.message, format!("not_in_room: {}", room.id));
    must_room(&b.call(
        chatwire::OP_JOIN,
        &chatwire::RoomArgs {
            room: room.id.clone(),
        },
    ));
    let f = a.call(
        chatwire::OP_SEND,
        &chatwire::SendArgs {
            room: room.id.clone(),
            text: "안녕".into(),
            call: None,
        },
    );
    assert!(f.error.is_none());
    let m = b.next(chatwire::TYPE_MSG).msg.unwrap();
    assert!(
        m.text == "안녕"
            && m.room_name == "auth"
            && m.room_purpose == "리뷰"
            && m.from_label == "mac/a"
            && m.at != 0,
        "{m:?}"
    );
    let rooms: chatwire::Rooms =
        json::unmarshal(&b.call(chatwire::OP_ROOMS, &Empty {}).result.0).unwrap();
    let rooms = rooms.rooms.unwrap();
    assert!(rooms.len() == 1 && rooms[0].members == 2, "{rooms:?}");
    let on: chatwire::Online =
        json::unmarshal(&a.call(chatwire::OP_ONLINE, &Empty {}).result.0).unwrap();
    let nodes = on.nodes.unwrap();
    assert!(
        on.participants.unwrap().len() == 2 && nodes.len() == 1 && nodes[0].fp.len() == FP_SHOWN,
        "{nodes:?}"
    );
    let direct = must_room(&a.call(
        chatwire::OP_DIRECT,
        &chatwire::DirectArgs {
            participant: hb.id.clone(),
            purpose: String::new(),
        },
    ));
    assert_eq!(direct.kind, chat::KIND_DIRECT);
    let f = a.call(
        chatwire::OP_LEAVE,
        &chatwire::RoomArgs {
            room: room.id.clone(),
        },
    );
    assert!(f.error.is_none());
    assert_eq!(String::from_utf8(f.result.0).unwrap(), r#"{"ok":true}"#);
    let e = a.call("bogus", &Empty {}).error.unwrap();
    assert_eq!(e.code, chatwire::CODE_BAD_REQUEST);
    assert_eq!(e.message, "모르는 op: \"bogus\"");
}

// REFACTOR3_GO_STRUCT_SRS FR-RGS-44 · DM-28: hello 를 보내기 전의 연결도 close 가 닫는다.
#[test]
fn close_closes_pre_hello_conn() {
    let h = new_harness(|_| {});
    let cl = h.dial();
    eventually("연결 받음", || h.srv.lock().pending.len() == 1);
    h.srv.close();
    match cl.inbox.recv_timeout(Duration::from_secs(1)) {
        Err(RecvTimeoutError::Disconnected) => {}
        Ok(f) => panic!("닫히기 전에 프레임이 왔다: {f:?}"),
        Err(RecvTimeoutError::Timeout) => panic!("close 뒤 1초 안에 hello 전 연결이 닫히지 않았다"),
    }
}

// FR-PCH-43: 연결이 끊기면 바로 모든 방에서 퇴장한다.
#[test]
fn disconnect_unregisters() {
    let h = new_harness(|_| {});
    let (mut a, _) = h.agent("sa", "ta", "a");
    let (mut b, _) = h.agent("sb", "tb", "b");
    must_room(&a.call(
        chatwire::OP_CREATE,
        &chatwire::CreateArgs {
            name: "auth".into(),
            purpose: "p".into(),
        },
    ));
    a.c.shutdown(Shutdown::Both).unwrap();
    eventually("퇴장", || h.svc.online().participants.len() == 1);
    let rooms: chatwire::Rooms =
        json::unmarshal(&b.call(chatwire::OP_ROOMS, &Empty {}).result.0).unwrap();
    assert!(rooms.rooms.unwrap().is_empty(), "방이 남았다");
}

// FR-PCH-60: 훅 질의는 그 세션의 MCP 에 물어 그대로 전한다.
#[test]
fn unread_relays_to_session() {
    let h = new_harness(|_| {});
    let (old, _) = h.agent("s1", "t1", "a");
    let (mut mcp, _) = h.agent("s1", "t2", "b");
    let t = std::thread::spawn(move || {
        let ask = mcp.next(chatwire::TYPE_COUNT_ASK);
        mcp.send(&Frame {
            t: chatwire::TYPE_COUNT.into(),
            n: ask.n,
            total: 3,
            ..Frame::default()
        });
        mcp
    });
    let mut hook = h.dial();
    hook.send(&Frame {
        t: chatwire::TYPE_UNREAD.into(),
        session: "s1".into(),
        ..Frame::default()
    });
    assert_eq!(hook.next(chatwire::TYPE_UNREAD).total, 3);
    let _mcp = t.join().unwrap();
    assert!(old.inbox.try_recv().is_err(), "먼저 연결에 물었다");
}

#[test]
fn unread_without_answer_is_zero() {
    let h = new_harness(|_| {});
    let _a = h.agent("s1", "t1", "a");
    for s in ["s1", "nobody"] {
        let mut hook = h.dial();
        hook.send(&Frame {
            t: chatwire::TYPE_UNREAD.into(),
            session: s.into(),
            ..Frame::default()
        });
        assert_eq!(hook.next(chatwire::TYPE_UNREAD).total, 0, "{s}");
    }
}

// PEER_CHAT_SRS §3.11 — 사람 참가자 (FR-PCH-41·85). 노드마다 하나이고 글은 on_user 로만 나간다.
#[test]
fn user_participant() {
    let got: Arc<Mutex<Vec<chatwire::Message>>> = Arc::default();
    let g = got.clone();
    let h = new_harness(|o| o.on_user = Some(Arc::new(move |m| g.lock().unwrap().push(m))));
    let me = h.srv.start_user();
    assert!(
        me.label == "mac/User" && me.kind == chat::KIND_USER,
        "{me:?}"
    );
    assert_eq!(h.srv.start_user().id, me.id, "사람 참가자가 둘이 됐다");
    let raw = h
        .srv
        .user_call(
            chatwire::OP_CREATE,
            &RawMessage(r#"{"name":"ops","purpose":"배포"}"#.as_bytes().to_vec()),
        )
        .unwrap();
    let rr: chatwire::RoomResult = json::unmarshal(&raw.0).unwrap();
    let (mut a, _) = h.agent("sa", "ta", "a");
    must_room(&a.call(
        chatwire::OP_JOIN,
        &chatwire::RoomArgs {
            room: rr.room.id.clone(),
        },
    ));
    let f = a.call(
        chatwire::OP_SEND,
        &chatwire::SendArgs {
            room: rr.room.id.clone(),
            text: "배포함".into(),
            call: None,
        },
    );
    assert!(f.error.is_none());
    eventually("사람이 글을 받는다", || {
        got.lock().unwrap().len() == 1
    });
    let m = got.lock().unwrap()[0].clone();
    assert!(
        m.text == "배포함" && m.room_name == "ops" && m.from_kind == chat::KIND_AGENT,
        "{m:?}"
    );
    let args = format!(r#"{{"room":"{}","text":"확인"}}"#, rr.room.id);
    h.srv
        .user_call(chatwire::OP_SEND, &RawMessage(args.into_bytes()))
        .unwrap();
    let m = a.next(chatwire::TYPE_MSG).msg.unwrap();
    assert!(
        m.from_label == "mac/User" && m.from_kind == chat::KIND_USER,
        "사람의 글이 에이전트에 가지 않았다"
    );
    let raw = h
        .srv
        .user_call(chatwire::OP_STATE, &RawMessage::default())
        .unwrap();
    let st: chatwire::State = json::unmarshal(&raw.0).unwrap();
    let rooms = st.rooms.unwrap();
    assert!(
        st.me.id == me.id && rooms.len() == 1 && st.online.participants.unwrap().len() == 2,
        "state {}",
        String::from_utf8_lossy(&raw.0)
    );
    // state 만 방마다 참가자 목록을 싣는다 (§3.11 채팅 탭의 참가자 목록).
    let p = rooms[0].people.clone().unwrap();
    assert!(
        p.len() == 2 && !p[0].id.is_empty() && !p[0].label.is_empty() && !p[0].kind.is_empty(),
        "{p:?}"
    );
    let f = a.call(chatwire::OP_ROOMS, &None::<()>);
    assert!(
        !String::from_utf8_lossy(&f.result.0).contains(r#""people""#),
        "rooms 에 people 이 실렸다"
    );
    let e = h
        .srv
        .user_call("bogus", &RawMessage::default())
        .unwrap_err();
    assert_eq!(e.code, chatwire::CODE_BAD_REQUEST);
}

#[test]
fn user_call_without_user() {
    let h = new_harness(|_| {});
    let e = h
        .srv
        .user_call(chatwire::OP_STATE, &RawMessage::default())
        .unwrap_err();
    assert_eq!(e.code, chatwire::CODE_BAD_REQUEST);
}

// 인자 없는 호출은 args 가 없다는 bad_request 다.
#[test]
fn call_without_args() {
    let h = new_harness(|_| {});
    let (mut a, _) = h.agent("sa", "ta", "a");
    a.n += 1;
    a.send(&Frame {
        t: chatwire::TYPE_CALL.into(),
        n: a.n,
        op: chatwire::OP_JOIN.into(),
        ..Frame::default()
    });
    let e = a.next(chatwire::TYPE_REPLY).error.unwrap();
    assert_eq!(
        (e.code.as_str(), e.message.as_str()),
        (chatwire::CODE_BAD_REQUEST, "args 가 없다")
    );
}

// REFACTOR3_DEFECTS_SRS TC-RD3-70: bidi 재정렬·zero-width(Cf)도 지운다.
#[test]
fn clean_strips_format_chars() {
    assert_eq!(clean("a\u{202e}b\u{200b}c\x07d\u{fffd}"), "abcd");
}

// 10.5b: 소켓 폴더를 만들 수 없으면 Go os.MkdirAll 처럼 막힌 칸의 경로로 낸다.
#[test]
fn create_dir_error_matches_go() {
    let dir = tempfile::tempdir().unwrap();
    let blocker = dir.path().join("f");
    std::fs::write(&blocker, b"x").unwrap();
    let e = create_dir(&blocker.join("a")).unwrap_err();
    assert_eq!(
        e.to_string(),
        format!("mkdir {}: not a directory", blocker.display())
    );
}

fn send_with(cl: &mut Client, room: &str, text: &str, call: &[&str]) -> Frame {
    cl.call(
        chatwire::OP_SEND,
        &chatwire::SendArgs {
            room: room.into(),
            text: text.into(),
            call: Some(call.iter().map(|s| s.to_string()).collect()),
        },
    )
}

fn join(cl: &mut Client, room: &str) {
    must_room(&cl.call(chatwire::OP_JOIN, &chatwire::RoomArgs { room: room.into() }));
}

// ISSUE_TREE_CHAT_SRS FR-CAL-1·4 (결정 I-2): call 의 도구 id 는 이 노드의 참가자 id 로 바뀐다.
// 참가자 id 와 user 는 그대로 쓰고, 방에 없는 상대는 bad_request 다.
#[test]
fn send_call_maps_tool_id() {
    let h = new_harness(|_| {});
    let (mut a, _) = h.agent("sa", "ta", "a");
    let (mut b, _) = h.agent("sb", "tb", "b");
    let (mut c, hc) = h.agent("sc", "tc", "c");
    let room = must_room(&a.call(
        chatwire::OP_CREATE,
        &chatwire::CreateArgs {
            name: "r".into(),
            purpose: String::new(),
        },
    ));
    join(&mut b, &room.id);
    join(&mut c, &room.id);

    assert!(send_with(&mut a, &room.id, "to-b", &["tb"]).error.is_none());
    assert!(
        b.next(chatwire::TYPE_MSG).msg.unwrap().called,
        "도구 id 로 부른 b"
    );
    assert!(!c.next(chatwire::TYPE_MSG).msg.unwrap().called);

    assert!(
        send_with(&mut a, &room.id, "to-c", &[&hc.id])
            .error
            .is_none()
    );
    assert!(!b.next(chatwire::TYPE_MSG).msg.unwrap().called);
    let mc = c.next(chatwire::TYPE_MSG).msg.unwrap();
    assert!(mc.called, "참가자 id 로 부른 c");
    // FR-CUX-7: 받은 글은 부른 상대를 싣는다.
    assert_eq!(mc.call, vec![hc.id.clone()]);

    assert!(
        send_with(&mut a, &room.id, "to-user", &["user"])
            .error
            .is_none()
    );
    assert!(!b.next(chatwire::TYPE_MSG).msg.unwrap().called);
    c.next(chatwire::TYPE_MSG);

    for bad in ["nobody", "tz"] {
        let e = send_with(&mut a, &room.id, "x", &[bad]).error.unwrap();
        assert_eq!(e.code, chatwire::CODE_BAD_REQUEST, "{bad}");
    }
    let (_out, _) = h.agent("so", "tout", "out");
    let e = send_with(&mut a, &room.id, "x", &["tout"]).error.unwrap();
    assert_eq!(e.code, chatwire::CODE_BAD_REQUEST, "방 밖의 도구");
}

// FR-CAL-5·6: notify 로 내 단계를 바꾸고 rooms 가 방마다 내 단계를 싣는다.
#[test]
fn notify_op_sets_my_level() {
    let h = new_harness(|_| {});
    let (mut a, _) = h.agent("sa", "ta", "a");
    let (mut b, _) = h.agent("sb", "tb", "b");
    let room = must_room(&a.call(
        chatwire::OP_CREATE,
        &chatwire::CreateArgs {
            name: "r".into(),
            purpose: String::new(),
        },
    ));
    assert_eq!(room.notify, chatwire::NOTIFY_CALLED);
    join(&mut b, &room.id);
    let f = a.call(
        chatwire::OP_NOTIFY,
        &chatwire::NotifyArgs {
            room: room.id.clone(),
            level: chatwire::NOTIFY_ALL.into(),
        },
    );
    assert!(f.error.is_none(), "{:?}", f.error);
    let level = |cl: &mut Client| {
        let rs: chatwire::Rooms =
            json::unmarshal(&cl.call(chatwire::OP_ROOMS, &Empty {}).result.0).unwrap();
        rs.rooms.unwrap()[0].notify.clone()
    };
    assert_eq!(level(&mut a), chatwire::NOTIFY_ALL);
    assert_eq!(level(&mut b), chatwire::NOTIFY_CALLED);
    let e = a
        .call(
            chatwire::OP_NOTIFY,
            &chatwire::NotifyArgs {
                room: room.id.clone(),
                level: "loud".into(),
            },
        )
        .error
        .unwrap();
    assert_eq!(e.code, chatwire::CODE_BAD_REQUEST);
}

// FR-CAL-7 (결정 I-1): 사람 참가자의 단계도 데몬 메모리에 두고 state 로 읽는다.
#[test]
fn user_notify_in_state() {
    let h = new_harness(|_| {});
    h.srv.start_user();
    let raw = h
        .srv
        .user_call(
            chatwire::OP_CREATE,
            &RawMessage(br#"{"name":"ops","purpose":""}"#.to_vec()),
        )
        .unwrap();
    let rr: chatwire::RoomResult = json::unmarshal(&raw.0).unwrap();
    let state = || {
        let raw = h
            .srv
            .user_call(chatwire::OP_STATE, &RawMessage::default())
            .unwrap();
        let st: chatwire::State = json::unmarshal(&raw.0).unwrap();
        st.rooms.unwrap()[0].notify.clone()
    };
    assert_eq!(state(), chatwire::NOTIFY_CALLED);
    let args = format!(r#"{{"room":"{}","level":"off"}}"#, rr.room.id);
    h.srv
        .user_call(chatwire::OP_NOTIFY, &RawMessage(args.into_bytes()))
        .unwrap();
    assert_eq!(state(), chatwire::NOTIFY_OFF);
}

fn waiter(h: &Harness, session: &str) -> Client {
    let w = h.dial();
    w.send(&Frame {
        t: chatwire::TYPE_WAIT.into(),
        session: session.into(),
        ..Frame::default()
    });
    w
}

// AGENT_MSG_REWAKE_SRS FR-AMW-24: 그 세션의 MCP 연결이 아직 없으면 생길 때까지 기다리고, 생기면 그 연결에
// 묻는다. 이전: 곧바로 0건으로 끝냈다 / 이유: SessionStart 의 훅은 MCP 연결보다 먼저 뜰 수 있다.
#[test]
fn wait_before_session_waits_for_mcp() {
    let h = new_harness(|_| {});
    let _a = h.agent("s1", "t1", "a");
    let mut w = waiter(&h, "s2");
    assert!(
        matches!(
            w.inbox.recv_timeout(Duration::from_millis(700)),
            Err(RecvTimeoutError::Timeout)
        ),
        "MCP 연결 전에 끝났다"
    );
    let (mut mcp, _) = h.agent("s2", "t2", "b");
    let ask = mcp.next(chatwire::TYPE_WAKE_ASK);
    mcp.send(&Frame {
        t: chatwire::TYPE_WAKE.into(),
        n: ask.n,
        total: 2,
        called: 0,
        ..Frame::default()
    });
    let f = w.next(chatwire::TYPE_WAIT);
    assert_eq!((f.total, f.called), (2, 0));
    assert!(w.closed());
}

// FR-AMW-24·25: MCP 연결을 기다리던 대기도 같은 세션의 새 대기가 오면 0건으로 끝난다.
#[test]
fn newer_wait_supersedes_pending_wait() {
    let h = new_harness(|_| {});
    let mut old = waiter(&h, "s3");
    std::thread::sleep(Duration::from_millis(200));
    let _new = waiter(&h, "s3");
    let f = old.next(chatwire::TYPE_WAIT);
    assert_eq!((f.total, f.called), (0, 0));
    assert!(old.closed());
}

// FR-CAL-9·10: 대기는 그 세션의 가장 나중 MCP 에 묻고, MCP 가 깨울 글을 답하면 개수만 전한다.
// 답이 올 때까지 시한 없이 기다린다.
#[test]
fn wait_relays_wake() {
    let h = new_harness(|_| {});
    let (old, _) = h.agent("s1", "t1", "a");
    let (mut mcp, _) = h.agent("s1", "t2", "b");
    let mut w = waiter(&h, "s1");
    let ask = mcp.next(chatwire::TYPE_WAKE_ASK);
    assert!(
        matches!(
            w.inbox.recv_timeout(Duration::from_millis(700)),
            Err(RecvTimeoutError::Timeout)
        ),
        "MCP 의 답 전에 끝났다"
    );
    mcp.send(&Frame {
        t: chatwire::TYPE_WAKE.into(),
        n: ask.n,
        total: 4,
        called: 1,
        ..Frame::default()
    });
    let f = w.next(chatwire::TYPE_WAIT);
    assert_eq!((f.total, f.called), (4, 1));
    assert!(w.closed());
    assert!(old.inbox.try_recv().is_err(), "먼저 연결에 물었다");
}

// FR-CAL-9: 기다리는 동안 MCP 연결이 끊기면 0건으로 끝낸다.
#[test]
fn wait_ends_when_mcp_leaves() {
    let h = new_harness(|_| {});
    let (mut mcp, _) = h.agent("s1", "t1", "a");
    let mut w = waiter(&h, "s1");
    mcp.next(chatwire::TYPE_WAKE_ASK);
    mcp.c.shutdown(Shutdown::Both).unwrap();
    let f = w.next(chatwire::TYPE_WAIT);
    assert_eq!((f.total, f.called), (0, 0));
}

// 대기하던 훅이 먼저 사라지면 MCP 에 그 대기를 거둔다고 알린다 — 글에 표식을 붙이지 않게 한다.
#[test]
fn wait_gone_drops_ask() {
    let h = new_harness(|_| {});
    let (mut mcp, _) = h.agent("s1", "t1", "a");
    let w = waiter(&h, "s1");
    let ask = mcp.next(chatwire::TYPE_WAKE_ASK);
    w.c.shutdown(Shutdown::Both).unwrap();
    let d = mcp.next(chatwire::TYPE_WAKE_DROP);
    assert_eq!(d.n, ask.n);
}

// FR-CAL-13: rise 는 없어진 프레임이다. 모르는 프레임이라 연결을 끊는다.
#[test]
fn rise_is_gone() {
    let h = new_harness(|_| {});
    let (a, _) = h.agent("s1", "t1", "a");
    a.send(&Frame {
        t: "rise".into(),
        total: 1,
        ..Frame::default()
    });
    assert!(a.closed());
}

// 같은 세션의 새 대기는 앞선 대기를 0건으로 끝낸다 — 쉴 때마다 훅이 하나씩 쌓이지 않게 한다.
#[test]
fn newer_wait_supersedes_older() {
    let h = new_harness(|_| {});
    let (mut mcp, _) = h.agent("s1", "t1", "a");
    let mut old = waiter(&h, "s1");
    let first = mcp.next(chatwire::TYPE_WAKE_ASK);
    let mut new = waiter(&h, "s1");
    let f = old.next(chatwire::TYPE_WAIT);
    assert_eq!((f.total, f.called), (0, 0));
    let mut asks = Vec::new();
    for _ in 0..2 {
        asks.push(mcp.inbox.recv_timeout(WAIT).unwrap());
    }
    assert!(
        asks.iter()
            .any(|f| f.t == chatwire::TYPE_WAKE_DROP && f.n == first.n),
        "{asks:?}"
    );
    let second = asks
        .iter()
        .find(|f| f.t == chatwire::TYPE_WAKE_ASK)
        .unwrap()
        .n;
    mcp.send(&Frame {
        t: chatwire::TYPE_WAKE.into(),
        n: second,
        total: 1,
        called: 1,
        ..Frame::default()
    });
    assert_eq!(new.next(chatwire::TYPE_WAIT).total, 1);
}

// FR-CUX-12 (결정 I-10): 사람 화면의 state 는 방 참가자마다 단계를, 이 노드의 에이전트에는 도구 id 를 싣는다.
#[test]
fn state_people_carry_notify_and_tool() {
    let h = new_harness(|_| {});
    let me = h.srv.start_user();
    let (mut a, ha) = h.agent("sa", "tool-a", "a");
    let room = must_room(&a.call(
        chatwire::OP_CREATE,
        &chatwire::CreateArgs {
            name: "r".into(),
            purpose: String::new(),
        },
    ));
    a.call(
        chatwire::OP_NOTIFY,
        &chatwire::NotifyArgs {
            room: room.id.clone(),
            level: chatwire::NOTIFY_ALL.into(),
        },
    );
    let join = format!(r#"{{"room":"{}"}}"#, room.id);
    h.srv
        .user_call(chatwire::OP_JOIN, &RawMessage(join.into_bytes()))
        .unwrap();
    let raw = h
        .srv
        .user_call(chatwire::OP_STATE, &RawMessage::default())
        .unwrap();
    let st: chatwire::State = json::unmarshal(&raw.0).unwrap();
    let people = st.rooms.unwrap()[0].people.clone().unwrap();
    let of = |id: &str| people.iter().find(|p| p.id == id).unwrap().clone();
    let (ag, hu) = (of(&ha.id), of(&me.id));
    assert_eq!(
        (ag.notify.as_str(), ag.tool.as_str()),
        (chatwire::NOTIFY_ALL, "tool-a")
    );
    assert_eq!(
        (hu.notify.as_str(), hu.tool.as_str()),
        (chatwire::NOTIFY_CALLED, "")
    );
}
