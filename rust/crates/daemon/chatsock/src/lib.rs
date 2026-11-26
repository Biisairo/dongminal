//! Go 기준선 `otterminal/internal/daemon/chatsock` 의 Rust 포팅. RUST_PORT_SRS 참고.
//!
//! 데몬의 채팅 소켓이다 (PEER_CHAT_SRS §3.10). MCP 연결 하나가 참가자 하나이고(FR-PCH-43), 훅
//! 질의(FR-PCH-60)와 깨움 대기(ISSUE_TREE_CHAT_SRS FR-CAL-9)를 그 세션의 MCP 에 중계한다. 개수와
//! 글은 저장하지 않는다(NFR-PCH-1).

mod human;

use std::collections::{HashMap, VecDeque};
use std::io::{self, Write};
use std::net::Shutdown;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{SyncSender, sync_channel};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, Weak};
use std::time::Duration;

use otter_daemon_chat::{self as chat, Participant, Service};
use otter_gocompat::json::{self, RawMessage};
use otter_shared_chatwire::{self as chatwire, Frame, Scanner};
use otter_shared_platform::{IpcListener, IpcStream};
use otter_shared_termtext::{self as termtext, FP_SHORT};
use serde::Serialize;
use serde::de::DeserializeOwned;

pub use human::Helper;

/// 표시 이름의 바이트 상한이다.
const MAX_LABEL: usize = 64;
/// 사람 참가자의 표시 이름 뒤쪽이다 (FR-PCH-46).
const USER_TAB: &str = "User";
/// 온라인 목록에 보이는 지문 앞자리 수다.
const FP_SHOWN: usize = FP_SHORT;
/// 첫 프레임을 기다리는 시한이다.
const HELLO_WAIT: Duration = Duration::from_secs(5);
/// 프레임 하나를 쓰는 시한이다.
const WRITE_WAIT: Duration = Duration::from_secs(2);
/// 연결마다 쌓아 둘 보낼 프레임 수다. 넘치면 연결을 끊는다.
const OUT_QUEUE: usize = 1024;
/// 훅 질의에 MCP 의 답을 기다리는 시한이다.
const DEFAULT_COUNT_WAIT: Duration = Duration::from_millis(500);
/// close 가 막힌 accept 를 깨우려 스스로 거는 연결의 시한이다.
const WAKE_DIAL_WAIT: Duration = Duration::from_millis(500);
const DIR_PERM: u32 = 0o700;
const TOOL_PREFIX_RUNES: usize = 8;

pub type NameFn = Arc<dyn Fn() -> String + Send + Sync>;
pub type OnUserFn = Arc<dyn Fn(chatwire::Message) + Send + Sync>;

/// 채팅 소켓을 세우는 값이다.
#[derive(Clone)]
pub struct Options {
    pub chat: Arc<Service>,
    /// 이 노드의 표시 이름이다. 표시 이름 `<노드>/<탭>` 의 앞쪽이다.
    pub name: Option<NameFn>,
    /// 훅 질의에 MCP 의 답을 기다리는 시한이다. 0 이면 500ms 다.
    pub count_wait: Duration,
    /// 에이전트 참가자 상한이다. 0 이면 노드 상한에서 사람 하나를 뺀 값이다.
    pub max_agents: usize,
    /// 사람 명령의 도우미다. `None` 이면 kill·kick 은 no_helper 다 (§3.12).
    pub helper: Option<Arc<dyn Helper>>,
    /// 사람 참가자에게 온 글을 넘긴다. 데몬은 사람의 글을 들지 않는다 (FR-PCH-85).
    pub on_user: Option<OnUserFn>,
}

impl Options {
    pub fn new(chat: Arc<Service>) -> Self {
        Self {
            chat,
            name: None,
            count_wait: Duration::ZERO,
            max_agents: 0,
            helper: None,
            on_user: None,
        }
    }
}

/// 보낼 프레임 줄이다. 가득 차면 연결을 끊는다.
#[derive(Default)]
struct OutQueue {
    q: Mutex<(VecDeque<Vec<u8>>, bool)>,
    cv: Condvar,
}

struct Conn {
    c: Arc<IpcStream>,
    pid: String,
    session: String,
    tool: String,
    out: OutQueue,
    asks: Mutex<(u64, HashMap<u64, SyncSender<Frame>>)>,
}

fn relock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl Conn {
    fn close(&self) {
        let first = {
            let mut q = relock(&self.out.q);
            let first = !q.1;
            q.1 = true;
            first
        };
        self.out.cv.notify_all();
        relock(&self.asks).1.clear();
        if first {
            let _ = self.c.shutdown(Shutdown::Both);
        }
    }

    fn push(&self, f: &Frame) {
        let Ok(b) = chatwire::encode(f) else {
            return;
        };
        let full = {
            let mut q = relock(&self.out.q);
            if q.1 {
                return;
            }
            if q.0.len() >= OUT_QUEUE {
                true
            } else {
                q.0.push_back(b);
                false
            }
        };
        if full {
            otter_shared_otterlog::warnf!(None, "chat: MCP 연결이 밀려 끊는다 ({})", self.pid);
            self.close();
            return;
        }
        self.out.cv.notify_one();
    }

    fn write_loop(&self) {
        let _ = self.c.set_write_timeout(Some(WRITE_WAIT));
        loop {
            let b = {
                let mut q = relock(&self.out.q);
                loop {
                    if q.1 {
                        return;
                    }
                    if let Some(b) = q.0.pop_front() {
                        break b;
                    }
                    q = self.out.cv.wait(q).unwrap_or_else(|e| e.into_inner());
                }
            };
            if (&*self.c).write_all(&b).is_err() {
                self.close();
                return;
            }
        }
    }

    /// 답을 받을 자리를 만들고 그 번호를 돌려준다.
    fn enlist(&self, tx: SyncSender<Frame>) -> u64 {
        let mut a = relock(&self.asks);
        a.0 += 1;
        let n = a.0;
        a.1.insert(n, tx);
        n
    }

    fn ask(&self, wait: Duration) -> Option<Frame> {
        let (tx, rx) = sync_channel(1);
        let n = self.enlist(tx);
        self.push(&Frame {
            t: chatwire::TYPE_COUNT_ASK.into(),
            n,
            ..Frame::default()
        });
        let got = rx.recv_timeout(wait).ok();
        relock(&self.asks).1.remove(&n);
        got
    }

    fn answer(&self, f: Frame) {
        let tx = relock(&self.asks).1.get(&f.n).cloned();
        if let Some(tx) = tx {
            let _ = tx.try_send(f);
        }
    }
}

struct State {
    ln: Option<Arc<IpcListener>>,
    path: PathBuf,
    by_pid: HashMap<String, Arc<Conn>>,
    /// hello 를 기다리는 연결이다. close 가 이것도 닫는다 (FR-RGS-44 · DM-28).
    pending: HashMap<u64, Arc<IpcStream>>,
    next_pending: u64,
    sessions: HashMap<String, Vec<Arc<Conn>>>,
    /// 세션마다 살아 있는 깨움 대기다: (물은 연결, 물음 번호).
    waits: HashMap<String, (Arc<Conn>, u64)>,
    closed: bool,
    user: Participant,
}

/// 채팅 소켓이다.
pub struct Server {
    o: Options,
    st: Mutex<State>,
    me: Weak<Server>,
}

/// 호출의 실패다. 채팅 오류는 그 코드를, 그 밖은 bad_request 를 낸다.
enum CallError {
    Chat(chat::Error),
    Plain(String),
}

impl From<chat::Error> for CallError {
    fn from(e: chat::Error) -> Self {
        CallError::Chat(e)
    }
}

impl CallError {
    fn wire(self) -> chatwire::Error {
        match self {
            CallError::Chat(e) => chatwire::Error {
                code: match e.code() {
                    "" => chatwire::CODE_BAD_REQUEST.into(),
                    c => c.into(),
                },
                message: e.to_string(),
            },
            CallError::Plain(m) => chatwire::Error {
                code: chatwire::CODE_BAD_REQUEST.into(),
                message: m,
            },
        }
    }
}

fn marshal_raw<T: Serialize>(v: &T) -> Result<RawMessage, CallError> {
    json::marshal(v)
        .map(RawMessage)
        .map_err(|e| CallError::Plain(e.to_string()))
}

fn decode<T: DeserializeOwned>(args: &RawMessage) -> Result<T, CallError> {
    if args.0.is_empty() {
        return Err(CallError::Plain("args 가 없다".into()));
    }
    json::unmarshal(&args.0).map_err(|e| CallError::Plain(e.to_string()))
}

fn room_of(r: &chat::RoomInfo) -> chatwire::Room {
    chatwire::Room {
        id: r.id.clone(),
        kind: r.kind.clone(),
        name: r.name.clone(),
        purpose: r.purpose.clone(),
        creator: r.creator.clone(),
        creator_name: r.creator_name.clone(),
        members: r.members.len() as i64,
        joined: r.joined,
        notify: r.notify.clone(),
        ..chatwire::Room::default()
    }
}

fn members_of(ms: &[chat::Member]) -> Vec<chatwire::Member> {
    ms.iter()
        .map(|m| chatwire::Member {
            id: m.id.clone(),
            label: m.label.clone(),
            kind: m.kind.clone(),
            node: termtext::cut(&m.node, FP_SHOWN).to_string(),
            online: m.online,
            notify: m.notify.clone(),
            ..chatwire::Member::default()
        })
        .collect()
}

fn online_of(v: &chat::OnlineView) -> chatwire::Online {
    chatwire::Online {
        nodes: Some(
            v.nodes
                .iter()
                .map(|n| chatwire::Node {
                    fp: termtext::cut(&n.fp, FP_SHOWN).to_string(),
                    name: n.name.clone(),
                    online: n.online,
                    self_: n.self_,
                })
                .collect(),
        ),
        participants: Some(members_of(&v.participants)),
    }
}

fn room_result(r: Result<chat::RoomInfo, chat::Error>) -> Result<RawMessage, CallError> {
    marshal_raw(&chatwire::RoomResult { room: room_of(&r?) })
}

fn ok_result(r: Result<(), chat::Error>) -> Result<RawMessage, CallError> {
    r?;
    marshal_raw(&chatwire::Ok { ok: true })
}

/// 제어 문자와 서식 문자(Cf — bidi 재정렬·zero-width)를 지운다. 표시 이름과 붙여넣기는 터미널에
/// 찍힌다 (REFACTOR3_DEFECTS_SRS FR-RD3-70). U+FFFD 도 지우는 것은 이 자리만의 규칙이다 — 잘못된
/// UTF-8 바이트를 대체 글자로 남기지 않고 버린다.
fn clean(s: &str) -> String {
    s.chars()
        .filter(|&r| !termtext::hidden(r) && r != char::REPLACEMENT_CHARACTER)
        .collect()
}

fn trunc_runes(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

/// Go `strings.EqualFold(tab, "User")`. "user" 의 글자 가운데 ASCII 밖으로 접히는 것은 `ſ`(→s)뿐이다.
fn is_user_tab(tab: &str) -> bool {
    let folded: String = tab
        .chars()
        .map(|c| {
            if c == 'ſ' {
                's'
            } else {
                c.to_ascii_lowercase()
            }
        })
        .collect();
    folded == USER_TAB.to_ascii_lowercase()
}

fn create_dir(dir: &Path) -> io::Result<()> {
    otter_gocompat::oserr::mkdir_all(&dir.to_string_lossy(), DIR_PERM)
}

fn write_once(nc: &IpcStream, f: &Frame) {
    if let Ok(b) = chatwire::encode(f) {
        let _ = nc.set_write_timeout(Some(WRITE_WAIT));
        let _ = (&*nc).write_all(&b);
    }
}

fn refuse(nc: &IpcStream, code: &str, msg: &str) {
    write_once(
        nc,
        &Frame {
            t: chatwire::TYPE_ERROR.into(),
            error: Some(chatwire::Error {
                code: code.into(),
                message: msg.into(),
            }),
            ..Frame::default()
        },
    );
    let _ = nc.shutdown(Shutdown::Both);
}

impl Server {
    /// 채팅 소켓을 만든다. listen·serve 로 받기 시작한다.
    pub fn new(mut o: Options) -> Arc<Server> {
        if o.count_wait.is_zero() {
            o.count_wait = DEFAULT_COUNT_WAIT;
        }
        if o.max_agents == 0 {
            o.max_agents = chat::MAX_PARTICIPANTS - 1;
        }
        Arc::new_cyclic(|me| Server {
            o,
            st: Mutex::new(State {
                ln: None,
                path: PathBuf::new(),
                by_pid: HashMap::new(),
                pending: HashMap::new(),
                next_pending: 0,
                sessions: HashMap::new(),
                waits: HashMap::new(),
                closed: false,
                user: Participant::default(),
            }),
            me: me.clone(),
        })
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        relock(&self.st)
    }

    /// path 에 채팅 소켓을 연다. 폴더는 0700 이다.
    pub fn listen(&self, path: &Path) -> io::Result<()> {
        let ipc = &otter_shared_platform::current().ipc;
        let _ = ipc.remove(path);
        create_dir(Path::new(&otter_gocompat::filepath::dir(
            &path.to_string_lossy(),
        )))?;
        let ln = ipc.listen(path)?;
        let mut st = self.lock();
        st.ln = Some(Arc::new(ln));
        st.path = path.to_path_buf();
        Ok(())
    }

    /// 연결을 받는다. 리스너가 닫히면 돌아온다.
    pub fn serve(&self) {
        let Some(ln) = self.lock().ln.clone() else {
            return;
        };
        loop {
            let Ok(c) = ln.accept() else {
                return;
            };
            if self.lock().closed {
                return;
            }
            if let Some(me) = self.me.upgrade() {
                std::thread::spawn(move || me.serve_conn(c));
            }
        }
    }

    /// 리스너와 모든 연결(hello 전 연결 포함)을 닫는다. 연결의 참가자는 퇴장한다.
    pub fn close(&self) {
        let (ln, path, conns, pending) = {
            let mut st = self.lock();
            st.closed = true;
            (
                st.ln.take(),
                st.path.clone(),
                st.by_pid.values().cloned().collect::<Vec<_>>(),
                st.pending.values().cloned().collect::<Vec<_>>(),
            )
        };
        if ln.is_some() {
            // 막혀 있는 accept 를 깨운다. serve 는 closed 를 보고 리스너를 놓는다.
            let _ = otter_shared_platform::current()
                .ipc
                .dial(&path, WAKE_DIAL_WAIT);
        }
        drop(ln);
        for c in conns {
            c.close();
        }
        for nc in pending {
            let _ = nc.shutdown(Shutdown::Both);
        }
    }

    /// 이 노드의 참가자에게 온 글을 그 MCP 연결로 넘긴다 (FR-PCH-54). 사람 참가자의 글은 on_user 로
    /// 넘긴다.
    pub fn deliver(&self, pid: &str, m: chat::Message) {
        let wm = chatwire::Message {
            id: m.id,
            room: m.room,
            room_kind: m.room_kind,
            room_name: m.room_name,
            room_purpose: m.room_purpose,
            from: m.from,
            from_label: m.from_label,
            from_kind: m.from_kind,
            node: m.node,
            text: m.text,
            call: m.call,
            called: m.called,
            at: i64::try_from(m.at.unix_timestamp_nanos().div_euclid(1_000_000))
                .unwrap_or(i64::MAX),
        };
        let (c, to_user) = {
            let st = self.lock();
            (
                st.by_pid.get(pid).cloned(),
                !st.user.id.is_empty() && pid == st.user.id,
            )
        };
        if to_user {
            if let Some(f) = &self.o.on_user {
                f(wm);
            }
            return;
        }
        if let Some(c) = c {
            c.push(&Frame {
                t: chatwire::TYPE_MSG.into(),
                msg: Some(wm),
                ..Frame::default()
            });
        }
    }

    /// 이 노드의 사람 참가자를 세운다. 노드마다 하나이며 데몬이 사는 동안 남는다 (FR-PCH-41).
    /// 이미 있으면 그것을 돌려준다.
    pub fn start_user(&self) -> Participant {
        let mut st = self.lock();
        if st.user.id.is_empty() {
            let name = self
                .o
                .name
                .as_ref()
                .map(|f| clean(&f()))
                .unwrap_or_default();
            st.user = self.o.chat.register(
                termtext::cut(&format!("{name}/{USER_TAB}"), MAX_LABEL),
                chat::KIND_USER,
            );
        }
        st.user.clone()
    }

    /// 사람 화면의 연산 하나다 (§3.11). op 는 채팅 소켓의 call 과 같고, state 를 더한다.
    pub fn user_call(&self, op: &str, args: &RawMessage) -> Result<RawMessage, chatwire::Error> {
        let me = self.lock().user.clone();
        if me.id.is_empty() {
            return Err(chatwire::Error {
                code: chatwire::CODE_BAD_REQUEST.into(),
                message: "사람 참가자가 없다".into(),
            });
        }
        if op == chatwire::OP_KILL || op == chatwire::OP_KICK {
            return self.human(op, args);
        }
        if op == chatwire::OP_STATE {
            let svc = &self.o.chat;
            let tools: HashMap<String, String> = self
                .lock()
                .by_pid
                .iter()
                .map(|(pid, c)| (pid.clone(), c.tool.clone()))
                .collect();
            let rooms = svc
                .rooms(&me.id)
                .iter()
                .map(|r| {
                    let mut people = members_of(&r.members);
                    for p in &mut people {
                        p.tool = tools.get(&p.id).cloned().unwrap_or_default();
                    }
                    chatwire::Room {
                        people: Some(people),
                        ..room_of(r)
                    }
                })
                .collect();
            let st = chatwire::State {
                me: chatwire::Member {
                    id: me.id.clone(),
                    label: me.label.clone(),
                    kind: me.kind.clone(),
                    node: String::new(),
                    online: true,
                    ..chatwire::Member::default()
                },
                online: online_of(&svc.online()),
                rooms: Some(rooms),
                helper: !svc.helper_key().is_empty(),
            };
            return marshal_raw(&st).map_err(CallError::wire);
        }
        let f = self.call(
            &me.id,
            &Frame {
                op: op.into(),
                args: args.clone(),
                ..Frame::default()
            },
        );
        match f.error {
            Some(e) => Err(e),
            None => Ok(f.result),
        }
    }

    fn serve_conn(&self, nc: IpcStream) {
        let nc = Arc::new(nc);
        let Some(key) = self.track(&nc) else {
            let _ = nc.shutdown(Shutdown::Both);
            return;
        };
        self.serve_tracked(&nc);
        self.lock().pending.remove(&key);
    }

    fn serve_tracked(&self, nc: &Arc<IpcStream>) {
        let mut sc = Scanner::new(&**nc);
        let _ = nc.set_read_timeout(Some(HELLO_WAIT));
        let Some(line) = sc.next_line() else {
            let _ = nc.shutdown(Shutdown::Both);
            return;
        };
        let Ok(first) = json::unmarshal::<Frame>(&line) else {
            refuse(nc, chatwire::CODE_BAD_REQUEST, "frame");
            return;
        };
        if first.t == chatwire::TYPE_UNREAD {
            self.answer_unread(nc, &first.session);
            return;
        }
        if first.t == chatwire::TYPE_WAIT {
            self.answer_wait(nc, &first.session);
            return;
        }
        if first.t != chatwire::TYPE_HELLO || first.session.is_empty() || first.tool.is_empty() {
            refuse(
                nc,
                chatwire::CODE_BAD_REQUEST,
                "hello 에 session·tool 이 필요하다",
            );
            return;
        }
        let c = match self.admit(nc, &first) {
            Ok(c) => c,
            Err(msg) => {
                refuse(nc, chatwire::CODE_FULL, &msg);
                return;
            }
        };
        let _ = nc.set_read_timeout(None);
        let w = c.clone();
        std::thread::spawn(move || w.write_loop());
        while let Some(line) = sc.next_line() {
            let Ok(f) = json::unmarshal::<Frame>(&line) else {
                break;
            };
            match f.t.as_str() {
                chatwire::TYPE_CALL => c.push(&self.call(&c.pid, &f)),
                chatwire::TYPE_COUNT | chatwire::TYPE_WAKE => c.answer(f),
                _ => break,
            }
        }
        self.drop_conn(&c);
    }

    /// hello 전 연결을 pending 에 넣는다. 이미 닫힌 서버면 `None` 이다.
    fn track(&self, nc: &Arc<IpcStream>) -> Option<u64> {
        let mut st = self.lock();
        if st.closed {
            return None;
        }
        st.next_pending += 1;
        let key = st.next_pending;
        st.pending.insert(key, nc.clone());
        Some(key)
    }

    /// 참가자를 만들고 hello 답을 줄에 넣는다.
    fn admit(&self, nc: &Arc<IpcStream>, h: &Frame) -> Result<Arc<Conn>, String> {
        let mut st = self.lock();
        if st.closed {
            return Err("닫혔다".into());
        }
        if st.by_pid.len() >= self.o.max_agents {
            return Err(format!("참가자 상한 {}", self.o.max_agents));
        }
        let label = self.label(&h.tab, &h.tool);
        let p = self.o.chat.register(&label, chat::KIND_AGENT);
        let c = Arc::new(Conn {
            c: nc.clone(),
            pid: p.id.clone(),
            session: h.session.clone(),
            tool: h.tool.clone(),
            out: OutQueue::default(),
            asks: Mutex::new((0, HashMap::new())),
        });
        st.by_pid.insert(p.id.clone(), c.clone());
        st.pending.retain(|_, x| !Arc::ptr_eq(x, nc));
        st.sessions
            .entry(h.session.clone())
            .or_default()
            .push(c.clone());
        c.push(&Frame {
            t: chatwire::TYPE_HELLO.into(),
            id: p.id,
            label: p.label,
            ..Frame::default()
        });
        Ok(c)
    }

    /// `<노드 이름>/<탭 이름>` 이다. 탭 이름이 없으면 도구 id 앞 8자다 (§3.10).
    fn label(&self, tab: &str, tool: &str) -> String {
        let mut tab = clean(tab).trim().to_string();
        if tab.is_empty() {
            tab = format!("tool-{}", trunc_runes(&clean(tool), TOOL_PREFIX_RUNES));
        }
        // `<노드>/User` 는 사람 참가자의 이름이다. 에이전트가 그 이름으로 보이지 않게 한다.
        if is_user_tab(&tab) {
            tab = format!("tab-{tab}");
        }
        let name = self
            .o
            .name
            .as_ref()
            .map(|f| clean(&f()))
            .unwrap_or_default();
        termtext::cut(&format!("{name}/{tab}"), MAX_LABEL).to_string()
    }

    fn drop_conn(&self, c: &Arc<Conn>) {
        c.close();
        {
            let mut st = self.lock();
            st.by_pid.remove(&c.pid);
            if let Some(list) = st.sessions.get_mut(&c.session) {
                if let Some(i) = list.iter().position(|x| Arc::ptr_eq(x, c)) {
                    list.remove(i);
                }
                if list.is_empty() {
                    st.sessions.remove(&c.session);
                }
            }
        }
        self.o.chat.unregister(&c.pid);
    }

    /// MCP 도구 호출 하나를 채팅 핵심에 넘긴다.
    fn call(&self, pid: &str, f: &Frame) -> Frame {
        let mut r = Frame {
            t: chatwire::TYPE_REPLY.into(),
            n: f.n,
            ..Frame::default()
        };
        match self.dispatch(pid, &f.op, &f.args) {
            Ok(raw) => r.result = raw,
            Err(e) => r.error = Some(e.wire()),
        }
        r
    }

    fn dispatch(&self, pid: &str, op: &str, args: &RawMessage) -> Result<RawMessage, CallError> {
        let svc = &self.o.chat;
        match op {
            chatwire::OP_ONLINE => marshal_raw(&online_of(&svc.online())),
            chatwire::OP_ROOMS => marshal_raw(&chatwire::Rooms {
                rooms: Some(svc.rooms(pid).iter().map(room_of).collect()),
            }),
            chatwire::OP_CREATE => {
                let a: chatwire::CreateArgs = decode(args)?;
                room_result(svc.create(pid, &a.name, &a.purpose))
            }
            chatwire::OP_DIRECT => {
                let a: chatwire::DirectArgs = decode(args)?;
                room_result(svc.direct(pid, &a.participant, &a.purpose))
            }
            chatwire::OP_JOIN => {
                let a: chatwire::RoomArgs = decode(args)?;
                room_result(svc.join(pid, &a.room))
            }
            chatwire::OP_LEAVE => {
                let a: chatwire::RoomArgs = decode(args)?;
                ok_result(svc.leave(pid, &a.room))
            }
            chatwire::OP_SEND => {
                let a: chatwire::SendArgs = decode(args)?;
                let call = self.resolve_call(a.call.as_deref().unwrap_or_default());
                ok_result(svc.send_call(pid, &a.room, &a.text, &call))
            }
            chatwire::OP_NOTIFY => {
                let a: chatwire::NotifyArgs = decode(args)?;
                ok_result(svc.set_notify(pid, &a.room, &a.level))
            }
            _ => Err(CallError::Plain(format!(
                "모르는 op: {}",
                otter_gocompat::strconv::quote(op)
            ))),
        }
    }

    /// call 의 도구 id 를 이 노드 연결의 참가자 id 로 바꾼다. 도구 id 는 노드 로컬이라 보내는
    /// 노드에서 바꾼다 (ISSUE_TREE_CHAT_SRS 결정 I-2). 그 밖의 항목(참가자 id·user)은 그대로다.
    fn resolve_call(&self, call: &[String]) -> Vec<String> {
        let st = self.lock();
        call.iter()
            .map(|c| {
                st.by_pid
                    .values()
                    .find(|x| x.tool == *c)
                    .map_or_else(|| c.clone(), |x| x.pid.clone())
            })
            .collect()
    }

    /// 훅 질의다. 그 세션의 가장 나중 연결에 묻고 답을 그대로 전한다 (FR-PCH-60).
    fn answer_unread(&self, nc: &IpcStream, session: &str) {
        let c = self
            .lock()
            .sessions
            .get(session)
            .and_then(|l| l.last().cloned());
        let mut reply = Frame {
            t: chatwire::TYPE_UNREAD.into(),
            ..Frame::default()
        };
        if let Some(got) = c.and_then(|c| c.ask(self.o.count_wait)) {
            reply.total = got.total;
        }
        write_once(nc, &reply);
        let _ = nc.shutdown(Shutdown::Both);
    }

    /// 깨울 글을 MCP 연결 c 에 묻고 답(wake)을 시한 없이 기다린다 (FR-CAL-9). MCP 가 끊기거나 훅
    /// 연결 w 가 닫히거나 같은 세션의 새 대기가 오면 None 이다. 그때는 MCP 에 물음을 거둔다고
    /// 알린다 — MCP 가 아무도 받지 않을 답에 표식을 붙이지 않게 한다. 세션마다 대기는 하나만 살아
    /// 있다 — 쉴 때마다 거는 훅이 쌓이지 않는다.
    fn wait_wake(&self, c: &Arc<Conn>, w: &Arc<IpcStream>, session: &str) -> Option<Frame> {
        let (tx, rx) = sync_channel(1);
        let n = c.enlist(tx);
        if relock(&c.out.q).1 {
            relock(&c.asks).1.remove(&n);
            return None;
        }
        let prev = self
            .lock()
            .waits
            .insert(session.to_string(), (Arc::clone(c), n));
        if let Some((pc, pn)) = prev {
            relock(&pc.asks).1.remove(&pn);
        }
        c.push(&Frame {
            t: chatwire::TYPE_WAKE_ASK.into(),
            n,
            ..Frame::default()
        });
        {
            let (me, w) = (Arc::clone(c), Arc::clone(w));
            std::thread::spawn(move || {
                let mut sc = Scanner::new(&*w);
                while sc.next_line().is_some() {}
                relock(&me.asks).1.remove(&n);
            });
        }
        let got = rx.recv().ok();
        relock(&c.asks).1.remove(&n);
        {
            let mut st = self.lock();
            if st
                .waits
                .get(session)
                .is_some_and(|(x, k)| Arc::ptr_eq(x, c) && *k == n)
            {
                st.waits.remove(session);
            }
        }
        if got.is_none() {
            c.push(&Frame {
                t: chatwire::TYPE_WAKE_DROP.into(),
                n,
                ..Frame::default()
            });
        }
        got
    }

    /// 깨움 대기다 (FR-CAL-9·10). 그 세션의 가장 나중 연결에 깨울 글을 묻고, 답의 개수만 전한다.
    /// 연결이 없거나 끊기면 0건으로 끝낸다.
    fn answer_wait(&self, nc: &Arc<IpcStream>, session: &str) {
        let _ = nc.set_read_timeout(None);
        let c = self
            .lock()
            .sessions
            .get(session)
            .and_then(|l| l.last().cloned());
        let mut reply = Frame {
            t: chatwire::TYPE_WAIT.into(),
            ..Frame::default()
        };
        if let Some(got) = c.and_then(|c| self.wait_wake(&c, nc, session)) {
            reply.total = got.total;
            reply.called = got.called;
        }
        write_once(nc, &reply);
        let _ = nc.shutdown(Shutdown::Both);
    }
}

#[cfg(test)]
mod tests;
#[cfg(test)]
mod tests_human;
