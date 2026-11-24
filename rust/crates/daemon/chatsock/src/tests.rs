//! PEER_CHAT_SRS §3.10 — 채팅 소켓 (TC-PCH-6, Go chatsock_test.go·clean_test.go).

use std::collections::HashMap;
use std::sync::mpsc::{Receiver, RecvTimeoutError, channel};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use dm_daemon_chat::{self as chat, Service};
use dm_gocompat::json::{self, RawMessage};
use dm_shared_chatwire::{self as chatwire, Frame, Scanner};
use dm_shared_edge::load_or_create_identity;
use dm_shared_edgemesh::Mesh;
use dm_shared_platform::IpcStream;
use serde::Serialize;
use tempfile::TempDir;

use super::*;

const WAIT: Duration = Duration::from_secs(3);

#[derive(Default)]
pub(crate) struct FakeTools {
    pub resting: Mutex<HashMap<String, bool>>,
    pub pasted: Mutex<Vec<String>>,
}

impl Tools for FakeTools {
    fn resting(&self, id: &str) -> bool {
        self.resting
            .lock()
            .unwrap()
            .get(id)
            .copied()
            .unwrap_or(false)
    }
    fn paste(&self, id: &str, text: &str) -> Result<(), BoxError> {
        self.pasted.lock().unwrap().push(format!("{id}|{text}"));
        Ok(())
    }
}

pub(crate) struct Harness {
    pub srv: Arc<Server>,
    pub svc: Arc<Service>,
    pub tools: Arc<FakeTools>,
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
    let sdir = tempfile::Builder::new().prefix("dmcs").tempdir().unwrap();
    let path = sdir.path().join("c.sock");
    let mut mo = dm_shared_edgemesh::Options::new(id.clone());
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
    let tools = Arc::new(FakeTools::default());
    let mut o = Options::new(svc.clone());
    o.tools = Some(tools.clone());
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
        tools,
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
            dm_shared_platform::current()
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

// FR-PCH-61·62: 0→1 알림은 쉬는 중일 때만 붙여 넣는다.
#[test]
fn rise_pastes_only_when_resting() {
    let h = new_harness(|_| {});
    h.tools.resting.lock().unwrap().insert("rest".into(), true);
    let (rest, _) = h.agent("s1", "rest", "a");
    let (busy, _) = h.agent("s2", "busy", "b");
    rest.send(&Frame {
        t: chatwire::TYPE_RISE.into(),
        total: 2,
        ..Frame::default()
    });
    busy.send(&Frame {
        t: chatwire::TYPE_RISE.into(),
        total: 1,
        ..Frame::default()
    });
    eventually("붙여넣기", || h.tools.pasted.lock().unwrap().len() == 1);
    std::thread::sleep(Duration::from_millis(50));
    let ps = h.tools.pasted.lock().unwrap().clone();
    // 방 이름은 망에서 온 값이라 붙여 넣지 않는다.
    assert_eq!(
        ps,
        ["rest|[dongminal chat] 새 글 2건. chat_read 로 확인한다."]
    );
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
