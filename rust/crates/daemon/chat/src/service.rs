use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, Weak};
use std::time::Duration;

use otter_gocompat::json;
use otter_shared_edge::{Edge, Identity};
use otter_shared_edgemesh::{Frame, Mesh, public_key, sign_frame};
use otter_shared_termtext as termtext;
use time::OffsetDateTime;

use crate::error::{
    CODE_BAD_REQUEST, CODE_NO_SUCH_PARTICIPANT, CODE_NO_SUCH_ROOM, CODE_NOT_IN_ROOM,
    CODE_RATE_LIMITED, CODE_TOO_LARGE, Error,
};
use crate::frame::{
    FRAME_MSG, FRAME_STATE, MsgBody, RecordBody, SignedRecord, StateBody, StatePart, new_record,
    open_record, random_hex, valid_body, valid_id,
};
use crate::limit::{Limiter, SeqWindow};

// 참가자와 방의 종류다.
pub const KIND_AGENT: &str = "agent";
pub const KIND_USER: &str = "user";
pub const KIND_GROUP: &str = "group";
pub const KIND_DIRECT: &str = "direct";

// 상한이다 (FR-PCH-55, §3.9).
/// 노드 하나의 참가자 상한이다. 넘는 노드 상태 알림은 받는 쪽이 버린다.
pub const MAX_PARTICIPANTS: usize = 64;
/// 글 하나의 바이트 상한이다.
pub const MAX_TEXT: usize = 16 << 10;
/// 참가자 하나가 1분에 쓸 수 있는 글 수다.
pub const PER_MINUTE: usize = 30;
pub(crate) const MAX_PARTS: usize = MAX_PARTICIPANTS;
pub(crate) const MAX_PART_ROOMS: usize = 64;
pub(crate) const MAX_NODE_ROOMS: usize = 128;
pub(crate) const MAX_NAME: usize = 64 * 4;
pub(crate) const MAX_PURPOSE: usize = 512;
pub(crate) const MAX_LABEL: usize = 128;
pub(crate) const MAX_ID: usize = 128;
/// 아는 노드의 상한이다. 넘으면 닿지 않는 노드부터 잊는다.
pub(crate) const MAX_NODES: usize = 256;
/// 잊은 노드의 마지막 번호를 기억하는 수다 (재전송 막기).
pub(crate) const MAX_MARKS: usize = 4096;
/// 참가자 id 앞에 붙는 노드 지문의 길이(지문 전체)다. id 를 노드에 묶는다.
pub(crate) const ID_PREFIX: usize = 64;
pub(crate) const ID_BYTES: usize = 16;
/// 지정(call)에서 그 방의 사람 참가자 모두를 뜻하는 별칭이다 (ISSUE_TREE_CHAT_SRS FR-CAL-1).
pub const CALL_USER: &str = "user";

pub use otter_shared_chatwire::{NOTIFY_ALL, NOTIFY_CALLED, NOTIFY_OFF};
const RATE_WINDOW: Duration = Duration::from_secs(60);

/// 이 노드의 참가자 하나다.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Participant {
    pub id: String,
    pub label: String,
    pub kind: String,
}

/// 참가자에게 넘기는 글이다. 방 종류·이름·목적을 함께 싣는다 (FR-PCH-13).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Message {
    pub id: String,
    pub room: String,
    pub room_kind: String,
    pub room_name: String,
    pub room_purpose: String,
    pub from: String,
    pub from_label: String,
    /// 보낸 참가자의 종류(agent·user)다. 표시 이름이 아니라 참가자 기록에서 온다.
    pub from_kind: String,
    pub node: String,
    pub text: String,
    pub at: OffsetDateTime,
    pub epoch: i64,
    pub seq: u64,
    /// 받는 참가자를 부른 글인가 (ISSUE_TREE_CHAT_SRS FR-CAL-3·4). 받는 노드가 참가자마다 정한다.
    pub called: bool,
}

/// 방이나 온라인 목록의 참가자 하나다. online 은 그 노드에 지금 닿는지다.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Member {
    pub id: String,
    pub label: String,
    pub kind: String,
    pub node: String,
    pub online: bool,
    /// 방 보기에서 이 노드의 참가자면 그 방의 알림 단계다. 모르면 비어 있다 (FR-CUX-12).
    pub notify: String,
}

/// 방 하나의 보기다.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RoomInfo {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub purpose: String,
    pub creator: String,
    pub creator_name: String,
    pub members: Vec<Member>,
    pub joined: bool,
    /// 이 방에서 보는 참가자의 알림 단계다 (ISSUE_TREE_CHAT_SRS FR-CAL-5).
    pub notify: String,
}

/// 온라인 목록의 노드 하나다.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct NodeInfo {
    pub fp: String,
    pub name: String,
    pub online: bool,
    pub self_: bool,
}

/// 온라인 목록이다 (FR-PCH-3).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct OnlineView {
    pub nodes: Vec<NodeInfo>,
    pub participants: Vec<Member>,
}

pub type NowFn = Arc<dyn Fn() -> OffsetDateTime + Send + Sync>;
/// 이 노드의 참가자에게 글을 넘긴다: (참가자 id, 글).
pub type DeliverFn = Arc<dyn Fn(&str, Message) + Send + Sync>;
/// 간선 상대 fp 의 도우미 공개키를 고정한다: (fp, key).
pub type PinFn = Arc<dyn Fn(&str, &str) + Send + Sync>;
pub type EdgesFn = Arc<dyn Fn() -> Vec<Edge> + Send + Sync>;
pub type ChangedFn = Arc<dyn Fn() + Send + Sync>;

/// 채팅을 세우는 값이다.
#[derive(Clone)]
pub struct Options {
    pub identity: Identity,
    /// 채팅이 얹힐 간선 계층이다 (EDGE_MESH_SRS FR-EGM-40). 연결·온라인 판정·노드 이름을 여기서
    /// 얻는다. `None` 이면 이 노드 혼자다.
    pub mesh: Option<Mesh>,
    /// 지금의 간선이다. 도우미 키 고정과 신뢰에 쓴다 (§3.12).
    pub edges: Option<EdgesFn>,
    /// 잠금 밖에서 부른다.
    pub deliver: Option<DeliverFn>,
    /// 비었을 때만 고정한다 (§3.12). 잠금 밖에서 부른다. `None` 이면 고정하지 않는다.
    pub pin: Option<PinFn>,
    /// 온라인 목록이나 방이 바뀌었을 수 있다는 알림이다. 잠금 밖의 스레드에서 부르고, 여러 번의
    /// 바뀜을 한 번으로 묶을 수 있다.
    pub changed: Option<ChangedFn>,
    pub now: Option<NowFn>,
}

impl Options {
    pub fn new(identity: Identity) -> Self {
        Self {
            identity,
            mesh: None,
            edges: None,
            deliver: None,
            pin: None,
            changed: None,
            now: None,
        }
    }
}

pub(crate) struct Part {
    pub p: Participant,
    pub rooms: HashSet<String>,
    /// 스스로 나간 개인채팅이다. 다시 자동으로 들어가지 않는다 (FR-PCH-16).
    pub left: HashSet<String>,
    /// 개인채팅 상대가 그 방에 든 것을 본 방이다.
    pub peer_seen: HashSet<String>,
    /// 방마다 정한 알림 단계다. 없으면 [`NOTIFY_CALLED`] 다 (FR-CAL-5·6). 나가면 지운다.
    pub notify: HashMap<String, String>,
}

#[derive(Clone)]
pub(crate) struct Room {
    pub rec: SignedRecord,
    pub body: RecordBody,
}

pub(crate) struct Remote {
    pub st: StateBody,
    pub key: p256::PublicKey,
    pub raw: Frame,
    pub rooms: HashMap<String, Room>,
    /// 이 노드의 상태를 마지막으로 받은 때다.
    pub at: OffsetDateTime,
    /// 이 노드에 닿은 적이 있는가다. 잊은 뒤 그 번호를 밀어내지 않는다.
    pub reached: bool,
}

/// 잊은 노드의 마지막 번호다.
#[derive(Clone)]
pub(crate) struct Mark {
    pub epoch: i64,
    pub state_seq: u64,
    pub msg_max: u64,
    pub at: OffsetDateTime,
    pub reached: bool,
}

impl Mark {
    /// msg_max 까지를 모두 본 것으로 치는 순서 창이다.
    pub fn window(&self) -> SeqWindow {
        SeqWindow::new(self.epoch, self.msg_max, true)
    }
}

pub(crate) struct Pending {
    pub pid: String,
    pub msg: Message,
}

/// 노드 하나가 낸 글의 전달 줄이다. 스레드 하나가 차례로 넘긴다.
#[derive(Default)]
struct DeliveryQueue {
    items: VecDeque<Pending>,
    running: bool,
}

pub(crate) struct State {
    pub epoch: i64,
    pub seq: u64,
    pub msg_seq: u64,
    pub parts: HashMap<String, Part>,
    /// 이 노드의 참가자가 든 방의 기록이다 (FR-PCH-22).
    pub rooms: HashMap<String, Room>,
    pub nodes: HashMap<String, Remote>,
    pub wins: HashMap<String, SeqWindow>,
    pub marks: HashMap<String, Mark>,
    pub own: Frame,
    /// 마지막으로 알린 자기 상태의 내용(순서 번호 제외)이다.
    own_content: Vec<u8>,
    send_rate: Limiter,
    pub recv_rate: Limiter,
    /// 이 노드의 도우미 공개키, cmds 는 본 사람 명령 해시, warned 는 고정과 다른 키를 알린 간선
    /// 상대다 (§3.12).
    pub helper_key: String,
    pub cmds: HashMap<String, OffsetDateTime>,
    pub warned: HashMap<String, String>,
    pub edge_cache: Option<Vec<Edge>>,
    pub edge_at: OffsetDateTime,
    /// 글을 낸 노드마다의 전달 줄이다 (FR-ATF-53).
    queues: HashMap<String, DeliveryQueue>,
    pub deliver: Option<DeliverFn>,
    pub closed: bool,
    pub max_nodes: usize,
}

/// 바뀜을 알리는 신호다. 쌓인 바뀜은 하나로 묶인다.
struct Signal {
    m: Mutex<(bool, bool)>,
    cv: Condvar,
}

impl Signal {
    fn poke(&self) {
        let mut g = self.m.lock().unwrap_or_else(|e| e.into_inner());
        g.0 = true;
        self.cv.notify_one();
    }

    fn close(&self) {
        let mut g = self.m.lock().unwrap_or_else(|e| e.into_inner());
        g.1 = true;
        self.cv.notify_one();
    }

    /// 다음 바뀜을 기다린다. 닫혔으면 거짓이다.
    fn wait(&self) -> bool {
        let mut g = self.m.lock().unwrap_or_else(|e| e.into_inner());
        loop {
            if g.1 {
                return false;
            }
            if g.0 {
                g.0 = false;
                return true;
            }
            g = self.cv.wait(g).unwrap_or_else(|e| e.into_inner());
        }
    }
}

/// 이 노드의 채팅이다.
pub struct Service {
    pub(crate) id: Identity,
    pub(crate) key: String,
    pub(crate) opts: Options,
    now: NowFn,
    st: Mutex<State>,
    signal: Arc<Signal>,
    me: Weak<Service>,
}

fn room_cap(p: &Part, node_rooms: usize) -> Result<(), Error> {
    if p.rooms.len() >= MAX_PART_ROOMS || node_rooms >= MAX_NODE_ROOMS {
        return Err(Error::fail(CODE_BAD_REQUEST, "too many rooms"));
    }
    Ok(())
}

/// 받는 참가자 pid(종류 pkind)를 부른 글인가 (ISSUE_TREE_CHAT_SRS FR-CAL-3).
/// 개인채팅은 언제나 부른다. 지정이 없으면 사람 글만 방의 에이전트를 모두 부른다.
pub(crate) fn is_called(
    room_kind: &str,
    from_kind: &str,
    call: &[String],
    pid: &str,
    pkind: &str,
) -> bool {
    if room_kind == KIND_DIRECT {
        return true;
    }
    if call.is_empty() {
        return from_kind == KIND_USER && pkind == KIND_AGENT;
    }
    call.iter()
        .any(|c| c == pid || (c == CALL_USER && pkind == KIND_USER))
}

/// pid 가 방 room 에 든 참가자인가 — 이 노드의 참가자와 닿은 노드가 알린 참가자를 본다.
pub(crate) fn room_has_member_locked(st: &State, pid: &str, room: &str) -> bool {
    st.parts.get(pid).is_some_and(|q| q.rooms.contains(room))
        || st.nodes.values().any(|r| part_in_room(&r.st, pid, room))
}

pub(crate) fn part_in_room(st: &StateBody, pid: &str, room: &str) -> bool {
    st.parts()
        .iter()
        .any(|sp| sp.id == pid && sp.rooms().iter().any(|r| r == room))
}

/// 노드 node 의 참가자 pid 가 방 rm 에 들 수 있는지다. 개인채팅은 두 참가자가 각자의 노드에
/// 묶인다 — 만든 이는 만든 노드, 상대는 기록에 서명된 상대 노드다.
pub(crate) fn party_ok(rm: &Room, node: &str, pid: &str) -> bool {
    if rm.body.kind != KIND_DIRECT {
        return true;
    }
    pid == rm.body.owner && node == rm.body.creator
        || pid == rm.body.peer && node == rm.body.peer_node
}

pub(crate) fn has_record(
    rooms: &HashMap<String, Room>,
    nodes: &HashMap<String, Remote>,
    id: &str,
) -> bool {
    rooms.contains_key(id) || nodes.values().any(|n| n.rooms.contains_key(id))
}

/// 이 노드의 참가자가 아무도 들지 않은 방의 기록을 지운다.
fn drop_unclaimed(st: &mut State) {
    let parts = &st.parts;
    st.rooms
        .retain(|id, _| parts.values().any(|p| p.rooms.contains(id)));
}

#[derive(PartialEq, Eq)]
enum Whereabouts {
    Absent,
    PresentInRoom,
    Unreachable,
}

impl Service {
    /// 채팅을 세우고 간선 계층의 위층으로 싣는다. 연결 유지는 간선 계층이 한다.
    pub fn new(o: Options) -> Arc<Service> {
        let now: NowFn = o
            .now
            .clone()
            .unwrap_or_else(|| Arc::new(otter_gocompat::time::now_local));
        let start = now();
        let svc = Arc::new_cyclic(|me| Service {
            id: o.identity.clone(),
            key: public_key(&o.identity),
            st: Mutex::new(State {
                epoch: i64::try_from(start.unix_timestamp_nanos()).unwrap_or(i64::MAX),
                seq: 0,
                msg_seq: 0,
                parts: HashMap::new(),
                rooms: HashMap::new(),
                nodes: HashMap::new(),
                wins: HashMap::new(),
                marks: HashMap::new(),
                own: Frame::default(),
                own_content: Vec::new(),
                send_rate: Limiter::new(PER_MINUTE, RATE_WINDOW),
                recv_rate: Limiter::new(PER_MINUTE, RATE_WINDOW),
                helper_key: String::new(),
                cmds: HashMap::new(),
                warned: HashMap::new(),
                edge_cache: None,
                edge_at: start,
                queues: HashMap::new(),
                deliver: o.deliver.clone(),
                closed: false,
                max_nodes: MAX_NODES,
            }),
            signal: Arc::new(Signal {
                m: Mutex::new((false, false)),
                cv: Condvar::new(),
            }),
            me: me.clone(),
            now,
            opts: o,
        });
        {
            let mut st = svc.lock();
            svc.announce_locked(&mut st);
        }
        if let Some(changed) = svc.opts.changed.clone() {
            let signal = svc.signal.clone();
            std::thread::spawn(move || {
                while signal.wait() {
                    changed();
                }
            });
        }
        if let Some(m) = &svc.opts.mesh {
            m.set_upper(svc.clone());
        }
        svc
    }

    pub(crate) fn lock(&self) -> MutexGuard<'_, State> {
        self.st.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub(crate) fn now(&self) -> OffsetDateTime {
        (self.now)()
    }

    /// 간선 계층이 아는 노드 fp 의 이름이다 (EDGE_MESH_SRS FR-EGM-42).
    pub(crate) fn name_of(&self, fp: &str) -> String {
        self.opts
            .mesh
            .as_ref()
            .and_then(|m| m.name_of(fp))
            .unwrap_or_default()
    }

    /// 채팅을 멈춘다. 그 뒤에는 프레임을 받지 않는다. 간선 연결은 간선 계층의 것이다.
    pub fn close(&self) {
        let mut st = self.lock();
        if st.closed {
            return;
        }
        st.closed = true;
        self.signal.close();
    }

    /// 참가자를 만든다. 방이 없는 새 참가자다 (FR-PCH-43·46).
    pub fn register(&self, label: &str, kind: &str) -> Participant {
        let p = Participant {
            id: format!(
                "{}-{}",
                &self.id.fingerprint[..ID_PREFIX],
                random_hex(ID_BYTES)
            ),
            label: label.to_string(),
            kind: kind.to_string(),
        };
        let mut st = self.lock();
        st.parts.insert(
            p.id.clone(),
            Part {
                p: p.clone(),
                rooms: HashSet::new(),
                left: HashSet::new(),
                peer_seen: HashSet::new(),
                notify: HashMap::new(),
            },
        );
        self.changed_locked(&mut st);
        p
    }

    /// 참가자를 없앤다. 모든 방에서 바로 나간다 (FR-PCH-43).
    pub fn unregister(&self, pid: &str) {
        let mut st = self.lock();
        if st.parts.remove(pid).is_none() {
            return;
        }
        drop_unclaimed(&mut st);
        self.changed_locked(&mut st);
    }

    /// 단체채팅 방을 만들고 pid 를 넣는다 (FR-PCH-10·11).
    pub fn create(&self, pid: &str, name: &str, purpose: &str) -> Result<RoomInfo, Error> {
        if name.is_empty()
            || !termtext::line(name, MAX_NAME)
            || !termtext::line(purpose, MAX_PURPOSE)
        {
            return Err(Error::fail(CODE_BAD_REQUEST, "name 또는 purpose"));
        }
        let mut st = self.lock();
        let p = part_locked(&st, pid)?;
        room_cap(p, st.rooms.len())?;
        let rec = new_record(
            &self.id,
            RecordBody {
                kind: KIND_GROUP.into(),
                owner: pid.into(),
                name: name.into(),
                purpose: purpose.into(),
                created: self.now(),
                nonce: random_hex(ID_BYTES),
                ..RecordBody::default()
            },
        )?;
        let id = add_room(&mut st, rec);
        if let Some(p) = st.parts.get_mut(pid) {
            p.rooms.insert(id.clone());
        }
        self.changed_locked(&mut st);
        Ok(self.room_info_locked(&st, pid, &id))
    }

    /// pid 와 온라인 참가자 peer 의 개인채팅을 만든다. 상대는 따로 수락하지 않고 들어간다
    /// (FR-PCH-14·15·17).
    pub fn direct(&self, pid: &str, peer: &str, purpose: &str) -> Result<RoomInfo, Error> {
        if !termtext::line(purpose, MAX_PURPOSE) || !valid_id(peer) {
            return Err(Error::fail(CODE_BAD_REQUEST, "purpose 또는 participant"));
        }
        let mut st = self.lock();
        let p = part_locked(&st, pid)?;
        let peer_node = match self.online_part_locked(&st, peer) {
            Some(n) if peer != pid => n,
            _ => return Err(Error::fail(CODE_NO_SUCH_PARTICIPANT, peer)),
        };
        room_cap(p, st.rooms.len())?;
        // 로컬 상대도 자동으로 들어가는 원격 상대와 같은 방 수 상한을 본다 (FR-ATF-56).
        if let Some(q) = st.parts.get(peer) {
            room_cap(q, st.rooms.len())?;
        }
        let rec = new_record(
            &self.id,
            RecordBody {
                kind: KIND_DIRECT.into(),
                owner: pid.into(),
                peer: peer.into(),
                peer_node,
                purpose: purpose.into(),
                created: self.now(),
                nonce: random_hex(ID_BYTES),
                ..RecordBody::default()
            },
        )?;
        let id = add_room(&mut st, rec);
        for who in [pid, peer] {
            if let Some(q) = st.parts.get_mut(who) {
                q.rooms.insert(id.clone());
            }
        }
        self.changed_locked(&mut st);
        Ok(self.room_info_locked(&st, pid, &id))
    }

    /// 보이는 단체채팅 방에 pid 를 넣는다 (FR-PCH-12).
    pub fn join(&self, pid: &str, room_id: &str) -> Result<RoomInfo, Error> {
        let mut st = self.lock();
        let p = part_locked(&st, pid)?;
        if p.rooms.contains(room_id) {
            return Ok(self.room_info_locked(&st, pid, room_id));
        }
        let r = match self.visible_room_locked(&st, pid, room_id) {
            Some(r) if r.body.kind == KIND_GROUP => r,
            _ => return Err(Error::fail(CODE_NO_SUCH_ROOM, room_id)),
        };
        room_cap(p, st.rooms.len())?;
        st.rooms.insert(room_id.to_string(), r);
        if let Some(p) = st.parts.get_mut(pid) {
            p.rooms.insert(room_id.to_string());
        }
        self.changed_locked(&mut st);
        Ok(self.room_info_locked(&st, pid, room_id))
    }

    /// pid 를 방에서 뺀다. 그 방에 이 노드의 참가자가 없으면 기록을 지운다 (FR-PCH-22).
    pub fn leave(&self, pid: &str, room_id: &str) -> Result<(), Error> {
        let mut st = self.lock();
        if !part_locked(&st, pid)?.rooms.contains(room_id) {
            return Err(Error::fail(CODE_NOT_IN_ROOM, room_id));
        }
        leave_locked(&mut st, pid, room_id);
        self.changed_locked(&mut st);
        Ok(())
    }

    /// pid 의 글을 방에 보낸다. 노드는 글을 들지 않는다 (FR-PCH-24·55).
    pub fn send(&self, pid: &str, room_id: &str, text: &str) -> Result<(), Error> {
        self.send_call(pid, room_id, text, &[])
    }

    /// pid 의 방 room_id 알림 단계를 level 로 정한다 (ISSUE_TREE_CHAT_SRS FR-CAL-5~7).
    pub fn set_notify(&self, pid: &str, room_id: &str, level: &str) -> Result<(), Error> {
        if ![NOTIFY_ALL, NOTIFY_CALLED, NOTIFY_OFF].contains(&level) {
            return Err(Error::fail(CODE_BAD_REQUEST, "level"));
        }
        let mut st = self.lock();
        part_locked(&st, pid)?;
        let Some(p) = st.parts.get_mut(pid).filter(|p| p.rooms.contains(room_id)) else {
            return Err(Error::fail(CODE_NOT_IN_ROOM, room_id));
        };
        p.notify.insert(room_id.into(), level.into());
        Ok(())
    }

    /// pid 의 글을 call 에 든 상대를 지정해 방에 보낸다 (ISSUE_TREE_CHAT_SRS FR-CAL-1).
    /// call 의 항목은 그 방의 참가자 id 이거나 [`CALL_USER`] 다.
    pub fn send_call(
        &self,
        pid: &str,
        room_id: &str,
        text: &str,
        call: &[String],
    ) -> Result<(), Error> {
        let mut st = self.lock();
        let p = part_locked(&st, pid)?;
        if !p.rooms.contains(room_id) {
            return Err(Error::fail(CODE_NOT_IN_ROOM, room_id));
        }
        if text.len() > MAX_TEXT {
            return Err(Error::fail(CODE_TOO_LARGE, "text"));
        }
        if text.is_empty() || !valid_body(text) {
            return Err(Error::fail(CODE_BAD_REQUEST, "text"));
        }
        if call
            .iter()
            .any(|c| c != CALL_USER && !room_has_member_locked(&st, c, room_id))
        {
            return Err(Error::fail(CODE_BAD_REQUEST, "call"));
        }
        let (label, kind) = (p.p.label.clone(), p.p.kind.clone());
        let now = self.now();
        if !st.send_rate.allow(pid, now) {
            return Err(Error::fail(CODE_RATE_LIMITED, pid));
        }
        st.msg_seq += 1;
        let body = MsgBody {
            id: random_hex(ID_BYTES),
            node: self.id.fingerprint.clone(),
            epoch: st.epoch,
            seq: st.msg_seq,
            room: room_id.into(),
            from: pid.into(),
            text: text.into(),
            at: now,
            call: call.to_vec(),
        };
        let fr = sign_frame(&self.id, FRAME_MSG, &body).map_err(Error::plain)?;
        self.broadcast_locked(&fr, "");
        let out = self.local_deliveries_locked(&st, &body, &label, &kind);
        let node = self.id.fingerprint.clone();
        self.enqueue_locked(&mut st, &node, out);
        Ok(())
    }

    /// 노드 node 가 낸 글을 그 노드의 전달 줄에 넣는다. 받은 순서가 넘기는 순서다 — 잠금 밖에서
    /// 넘기면 같은 참가자의 글이 뒤바뀔 수 있다 (FR-ATF-53, FR-PCH-32).
    pub(crate) fn enqueue_locked(&self, st: &mut State, node: &str, out: Vec<Pending>) {
        if out.is_empty() || st.deliver.is_none() || st.closed {
            return;
        }
        let q = st.queues.entry(node.to_string()).or_default();
        q.items.extend(out);
        if q.running {
            return;
        }
        q.running = true;
        if let Some(me) = self.me.upgrade() {
            let node = node.to_string();
            std::thread::spawn(move || me.drain(&node));
        }
    }

    /// 줄이 빌 때까지 잠금 밖에서 deliver 를 부른다. 비거나 채팅이 멈추면 줄을 지우고 끝난다.
    fn drain(&self, node: &str) {
        loop {
            let (d, deliver) = {
                let mut st = self.lock();
                let closed = st.closed;
                let next = st
                    .queues
                    .get_mut(node)
                    .and_then(|q| if closed { None } else { q.items.pop_front() });
                match (next, st.deliver.clone()) {
                    (Some(d), Some(f)) => (d, f),
                    _ => {
                        st.queues.remove(node);
                        return;
                    }
                }
            };
            deliver(&d.pid, d.msg);
        }
    }

    /// 그 방에 든 이 노드의 참가자(보낸 이 제외)에게 넘길 글이다.
    pub(crate) fn local_deliveries_locked(
        &self,
        st: &State,
        b: &MsgBody,
        label: &str,
        kind: &str,
    ) -> Vec<Pending> {
        let r = record_locked(st, &b.room);
        let (rk, rn, rp) = r.map_or((String::new(), String::new(), String::new()), |r| {
            (
                r.body.kind.clone(),
                r.body.name.clone(),
                r.body.purpose.clone(),
            )
        });
        let mut out: Vec<Pending> = st
            .parts
            .values()
            .filter(|q| q.p.id != b.from && q.rooms.contains(&b.room))
            .map(|q| Pending {
                pid: q.p.id.clone(),
                msg: Message {
                    id: b.id.clone(),
                    room: b.room.clone(),
                    room_kind: rk.clone(),
                    room_name: rn.clone(),
                    room_purpose: rp.clone(),
                    from: b.from.clone(),
                    from_label: label.into(),
                    from_kind: kind.into(),
                    node: b.node.clone(),
                    text: b.text.clone(),
                    at: b.at,
                    epoch: b.epoch,
                    seq: b.seq,
                    called: is_called(&rk, kind, &b.call, &q.p.id, &q.p.kind),
                },
            })
            .collect();
        out.sort_by(|a, b| a.pid.cmp(&b.pid));
        out
    }

    /// 개인채팅의 따라 나가기·자동 들어가기를 맞춘 뒤 상태를 알린다.
    pub(crate) fn changed_locked(&self, st: &mut State) {
        self.signal.poke();
        for _ in 0..MAX_PARTS {
            if !self.react_locked(st) {
                break;
            }
        }
        prune_left(st);
        self.announce_locked(st);
    }

    /// 자기 상태의 내용이 바뀌었을 때만 새 노드 상태 알림을 만들어 모든 연결로 보낸다
    /// (FR-PCH-9). 남의 알림을 받을 때마다 알리면 노드끼리 끝없이 주고받는다.
    pub(crate) fn announce_locked(&self, st: &mut State) {
        let mut body = self.own_state_locked(st);
        let content = json::marshal(&body).unwrap_or_default();
        if !st.own.t.is_empty() && content == st.own_content {
            return;
        }
        st.own_content = content;
        st.seq += 1;
        body.epoch = st.epoch;
        body.seq = st.seq;
        let Ok(fr) = sign_frame(&self.id, FRAME_STATE, &body) else {
            return;
        };
        self.broadcast_locked(&fr, "");
        st.own = fr;
    }

    /// 순서 번호를 뺀 자기 상태다.
    fn own_state_locked(&self, st: &mut State) -> StateBody {
        let pins = self.pins_locked(st);
        let mut ids: Vec<&String> = st.parts.keys().collect();
        ids.sort();
        let parts: Vec<StatePart> = ids
            .into_iter()
            .map(|id| {
                let p = &st.parts[id];
                let mut rooms: Vec<String> = p.rooms.iter().cloned().collect();
                rooms.sort();
                StatePart {
                    id: p.p.id.clone(),
                    label: p.p.label.clone(),
                    kind: p.p.kind.clone(),
                    rooms: (!rooms.is_empty()).then_some(rooms),
                }
            })
            .collect();
        let mut room_ids: Vec<&String> = st.rooms.keys().collect();
        room_ids.sort();
        let rooms: Vec<SignedRecord> = room_ids
            .into_iter()
            .map(|id| st.rooms[id].rec.clone())
            .collect();
        StateBody {
            node: self.id.fingerprint.clone(),
            key: self.key.clone(),
            epoch: 0,
            seq: 0,
            parts: (!parts.is_empty()).then_some(parts),
            rooms: (!rooms.is_empty()).then_some(rooms),
            helper: st.helper_key.clone(),
            pins,
        }
    }

    /// 개인채팅을 맞춘다. 바꾼 것이 있으면 참이다 (FR-PCH-15·16).
    fn react_locked(&self, st: &mut State) -> bool {
        let mut changed = false;
        // 도달 가능 집합은 간선 계층의 잠금을 잡으므로 반복 밖에서 한 번 얻는다 (FR-ATF-55).
        let reach = self.reachable();
        let me = self.id.fingerprint.as_str();
        // 상대 노드가 만든 개인채팅에 이 노드의 참가자가 상대로 적혀 있으면 들어간다.
        {
            let State {
                nodes,
                rooms,
                parts,
                ..
            } = &mut *st;
            for r in nodes.values_mut() {
                if !reach.contains(&r.st.node) {
                    continue;
                }
                r.reached = true;
                for (id, rm) in &r.rooms {
                    if rm.body.kind != KIND_DIRECT
                        || rm.body.creator != r.st.node
                        || rm.body.peer_node != me
                    {
                        continue;
                    }
                    let node_rooms = rooms.len();
                    let Some(q) = parts.get_mut(&rm.body.peer) else {
                        continue;
                    };
                    if q.rooms.contains(id)
                        || q.left.contains(id)
                        || !part_in_room(&r.st, &rm.body.owner, id)
                        || room_cap(q, node_rooms).is_err()
                    {
                        continue;
                    }
                    rooms.insert(id.clone(), rm.clone());
                    q.rooms.insert(id.clone());
                    changed = true;
                }
            }
        }
        // 상대를 한 번 본 뒤 상대가 떠났으면 따라 나간다. 상대 노드가 끊긴 것은 떠난 것이 아니다.
        let pids: Vec<String> = st.parts.keys().cloned().collect();
        for pid in pids {
            let ids: Vec<String> = match st.parts.get(&pid) {
                Some(p) => p.rooms.iter().cloned().collect(),
                None => continue,
            };
            for id in ids {
                if !st.parts.get(&pid).is_some_and(|p| p.rooms.contains(&id)) {
                    continue;
                }
                let Some(rm) = st.rooms.get(&id) else {
                    continue;
                };
                if rm.body.kind != KIND_DIRECT {
                    continue;
                }
                let (other, node) = if pid == rm.body.peer {
                    (rm.body.owner.clone(), rm.body.creator.clone())
                } else {
                    (rm.body.peer.clone(), rm.body.peer_node.clone())
                };
                match self.where_locked(st, &reach, &node, &other, &id) {
                    Whereabouts::PresentInRoom => {
                        if let Some(p) = st.parts.get_mut(&pid) {
                            p.peer_seen.insert(id.clone());
                        }
                    }
                    Whereabouts::Absent => {
                        if st
                            .parts
                            .get(&pid)
                            .is_some_and(|p| p.peer_seen.contains(&id))
                        {
                            leave_locked(st, &pid, &id);
                            changed = true;
                        }
                    }
                    Whereabouts::Unreachable => {}
                }
            }
        }
        changed
    }

    /// 노드 node 의 참가자 pid 가 방 room 에 들어 있는지다. 닿지 않는 노드의 참가자는 모른다.
    fn where_locked(
        &self,
        st: &State,
        reach: &HashSet<String>,
        node: &str,
        pid: &str,
        room: &str,
    ) -> Whereabouts {
        if node == self.id.fingerprint {
            return match st.parts.get(pid) {
                Some(q) if q.rooms.contains(room) => Whereabouts::PresentInRoom,
                _ => Whereabouts::Absent,
            };
        }
        match st.nodes.get(node) {
            Some(r) if reach.contains(node) => {
                if part_in_room(&r.st, pid, room) {
                    Whereabouts::PresentInRoom
                } else {
                    Whereabouts::Absent
                }
            }
            _ => Whereabouts::Unreachable,
        }
    }

    /// 온라인 참가자 pid 가 있는 노드다.
    fn online_part_locked(&self, st: &State, pid: &str) -> Option<String> {
        if st.parts.contains_key(pid) {
            return Some(self.id.fingerprint.clone());
        }
        let reach = self.reachable();
        st.nodes
            .iter()
            .find(|(fp, r)| reach.contains(*fp) && r.st.parts().iter().any(|sp| sp.id == pid))
            .map(|(fp, _)| fp.clone())
    }

    /// 프레임을 skip 을 뺀 모든 간선 연결로 보낸다 (FR-PCH-4). 간선 계층의 잠금은 채팅 잠금 안에서
    /// 잡아도 된다 (NFR-EGM-1).
    pub(crate) fn broadcast_locked(&self, fr: &Frame, skip: &str) {
        if let Some(m) = &self.opts.mesh {
            m.broadcast(fr, skip);
        }
    }
}

fn part_locked<'a>(st: &'a State, pid: &str) -> Result<&'a Part, Error> {
    st.parts
        .get(pid)
        .ok_or_else(|| Error::fail(CODE_NO_SUCH_PARTICIPANT, pid))
}

fn add_room(st: &mut State, rec: SignedRecord) -> String {
    let body = open_record(&rec).unwrap_or_default();
    let id = rec.id();
    st.rooms.insert(id.clone(), Room { rec, body });
    id
}

pub(crate) fn leave_locked(st: &mut State, pid: &str, room: &str) {
    let direct = st
        .rooms
        .get(room)
        .is_some_and(|r| r.body.kind == KIND_DIRECT);
    if let Some(p) = st.parts.get_mut(pid) {
        p.rooms.remove(room);
        p.peer_seen.remove(room);
        p.notify.remove(room);
        if direct {
            p.left.insert(room.to_string());
        }
    }
    drop_unclaimed(st);
}

/// 어느 노드의 상태에도 생성 기록이 남지 않은 방을 left 에서 지운다 (FR-ATF-52). 닿지 않는 노드의
/// 상태도 기록을 가진 것으로 친다 — 그 노드가 돌아와 방을 다시 말하면 자동으로 들어가지 않아야 한다.
fn prune_left(st: &mut State) {
    let State {
        parts,
        rooms,
        nodes,
        ..
    } = st;
    for p in parts.values_mut() {
        p.left.retain(|id| has_record(rooms, nodes, id));
    }
}

/// 방의 생성 기록을 이 노드나 아는 노드의 상태에서 찾는다.
pub(crate) fn record_locked<'a>(st: &'a State, id: &str) -> Option<&'a Room> {
    st.rooms
        .get(id)
        .or_else(|| st.nodes.values().find_map(|n| n.rooms.get(id)))
}

#[cfg(test)]
impl State {
    pub(crate) fn queue_count(&self) -> usize {
        self.queues.len()
    }
}
