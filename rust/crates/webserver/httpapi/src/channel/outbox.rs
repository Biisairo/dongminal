//! 채널 하나의 보낼 것 — 차선 셋과 합치기, 상한 (`perf/CHANNEL_PROTOCOL.md` §6).

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};

use otter_shared_toolhub::{OP_OUTPUT, OP_SEQ};
use tokio::sync::Notify;

use super::topics::{Item, ItemKind};

/// 토픽 하나에 밀린 변화가 이보다 많으면 full 하나로 바꾼다.
pub(crate) const TOPIC_PENDING_MAX: usize = 64;
/// 채널 하나에 밀린 양이 이보다 많으면 채널을 닫는다.
pub(crate) const CHANNEL_PENDING_MAX: usize = 8 << 20;
/// 터미널 프레임 머리: op 1바이트 + sid 4바이트.
const TERM_HEAD: usize = 5;

/// 쓰기 태스크가 꺼내는 것.
pub(crate) enum Out {
    Text(Arc<str>),
    Binary(Vec<u8>),
    /// 이 토픽의 지금 상태로 full 을 만들어 보내라. 보낸 뒤 `drop_upto` 를 부른다.
    NeedFull(String),
    Close,
}

enum Pending {
    Items(VecDeque<Arc<Item>>),
    NeedFull,
}

/// sid 하나의 밀린 양과, 꺼낸 프레임으로 따라간 브라우저의 좌표 (TC-CH5-11).
///
/// 좌표는 브라우저 `TerminalTool` 과 같은 규칙으로 센다: `SEQ` 가 세우고, 그 뒤의 `OUTPUT` 길이를
/// 더한다. `SEQ` 전의 `OUTPUT` 은 재생분이라 세지 않는다.
#[derive(Default)]
struct TermMirror {
    pending: usize,
    delivered: Option<i64>,
    /// 이 sid 의 지금 세션 번호. 다른 번호로 온 프레임은 끝난 세션의 것이라 버린다.
    session: u64,
}

#[derive(Default)]
struct Inner {
    control: VecDeque<Arc<str>>,
    term: VecDeque<(u32, Vec<u8>)>,
    terms: HashMap<u32, TermMirror>,
    order: VecDeque<String>,
    state: HashMap<String, Pending>,
    bytes: usize,
    closed: bool,
}

impl Inner {
    fn add(&mut self, n: usize) {
        self.bytes += n;
        if self.bytes > CHANNEL_PENDING_MAX {
            self.closed = true;
            self.control.clear();
            self.term.clear();
            self.terms.clear();
            self.order.clear();
            self.state.clear();
            self.bytes = 0;
        }
    }
}

#[derive(Default)]
pub(crate) struct Outbox {
    inner: Mutex<Inner>,
    ready: Notify,
}

fn items_bytes(q: &VecDeque<Arc<Item>>) -> usize {
    q.iter().map(|it| it.frame.len()).sum()
}

impl Outbox {
    pub(crate) fn new() -> Arc<Outbox> {
        Arc::new(Outbox::default())
    }

    fn inner(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub(crate) fn is_closed(&self) -> bool {
        self.inner().closed
    }

    pub(crate) fn push_control(&self, frame: String) {
        let mut g = self.inner();
        if g.closed {
            return;
        }
        let n = frame.len();
        g.control.push_back(Arc::from(frame));
        g.add(n);
        drop(g);
        self.ready.notify_one();
    }

    /// 터미널 프레임 `[op][sid u32 빅엔디언][payload]` (§4.2).
    pub(crate) fn push_term(&self, op: u8, sid: u32, payload: &[u8]) {
        let mut g = self.inner();
        if g.closed {
            return;
        }
        Self::push_term_locked(&mut g, op, sid, payload);
        drop(g);
        self.ready.notify_one();
    }

    /// 세션 `session` 의 프레임. 그 sid 의 지금 세션이 아니면 버린다 — 바뀐 세션이 늦게 낸 프레임이
    /// 새 세션의 재생 사이에 끼지 않는다.
    pub(crate) fn push_term_as(&self, session: u64, op: u8, sid: u32, payload: &[u8]) {
        let mut g = self.inner();
        if g.closed || g.terms.get(&sid).map(|m| m.session) != Some(session) {
            return;
        }
        Self::push_term_locked(&mut g, op, sid, payload);
        drop(g);
        self.ready.notify_one();
    }

    /// sid 의 새 세션을 연다: 밀린 프레임과 좌표를 잊고 새 세션 번호를 돌려준다.
    pub(crate) fn term_begin(&self, sid: u32) -> u64 {
        let mut g = self.inner();
        Self::drop_term_locked(&mut g, sid);
        let m = g.terms.entry(sid).or_default();
        m.session += 1;
        m.delivered = None;
        m.session
    }

    /// `session` 이 sid 의 지금 세션인가.
    pub(crate) fn term_current(&self, sid: u32, session: u64) -> bool {
        self.inner().terms.get(&sid).map(|m| m.session) == Some(session)
    }

    fn push_term_locked(g: &mut Inner, op: u8, sid: u32, payload: &[u8]) {
        let mut b = Vec::with_capacity(TERM_HEAD + payload.len());
        b.push(op);
        b.extend_from_slice(&sid.to_be_bytes());
        b.extend_from_slice(payload);
        let n = b.len();
        g.term.push_back((sid, b));
        g.terms.entry(sid).or_default().pending += n;
        g.add(n);
    }

    pub(crate) fn push_state(&self, it: Arc<Item>) {
        let mut g = self.inner();
        if g.closed {
            return;
        }
        let n = it.frame.len();
        let topic = it.topic.clone();
        let mut freed = 0;
        let mut added = 0;
        match g.state.get_mut(&topic) {
            None => {
                g.state
                    .insert(topic.clone(), Pending::Items(VecDeque::from([it])));
                g.order.push_back(topic);
                added = n;
            }
            // full 을 보낼 때 지금 상태를 쓰므로 이것도 거기 들어간다.
            Some(Pending::NeedFull) => {}
            Some(p @ Pending::Items(_)) => {
                let Pending::Items(q) = p else { return };
                if matches!(it.kind, ItemKind::Full | ItemKind::Reset) {
                    freed = items_bytes(q);
                    q.clear();
                    q.push_back(it);
                    added = n;
                } else {
                    q.push_back(it);
                    added = n;
                    if q.len() > TOPIC_PENDING_MAX {
                        freed = items_bytes(q);
                        added = 0;
                        *p = Pending::NeedFull;
                    }
                }
            }
        }
        g.bytes -= freed.min(g.bytes);
        g.add(added);
        drop(g);
        self.ready.notify_one();
    }

    /// 우선순위대로 하나 꺼낸다: 제어 > 터미널 > 상태.
    pub(crate) fn pop(&self) -> Option<Out> {
        let mut g = self.inner();
        if g.closed {
            return Some(Out::Close);
        }
        if let Some(f) = g.control.pop_front() {
            g.bytes -= f.len().min(g.bytes);
            return Some(Out::Text(f));
        }
        if let Some((sid, b)) = g.term.pop_front() {
            g.bytes -= b.len().min(g.bytes);
            let m = g.terms.entry(sid).or_default();
            m.pending -= b.len().min(m.pending);
            let body = &b[TERM_HEAD..];
            match b[0] {
                OP_SEQ if body.len() >= 8 => {
                    let mut off = [0u8; 8];
                    off.copy_from_slice(&body[..8]);
                    m.delivered = Some(i64::from_be_bytes(off));
                }
                OP_OUTPUT => {
                    if let Some(d) = m.delivered.as_mut() {
                        *d += body.len() as i64;
                    }
                }
                _ => {}
            }
            return Some(Out::Binary(b));
        }
        while let Some(topic) = g.order.pop_front() {
            match g.state.remove(&topic) {
                Some(Pending::NeedFull) => return Some(Out::NeedFull(topic)),
                Some(Pending::Items(mut q)) => {
                    let Some(it) = q.pop_front() else { continue };
                    if !q.is_empty() {
                        g.state.insert(topic.clone(), Pending::Items(q));
                        g.order.push_front(topic);
                    }
                    g.bytes -= it.frame.len().min(g.bytes);
                    return Some(Out::Text(it.frame.clone()));
                }
                None => {}
            }
        }
        None
    }

    /// sid 의 (밀린 바이트, 브라우저가 가진 좌표).
    pub(crate) fn term_state(&self, sid: u32) -> (usize, Option<i64>) {
        let g = self.inner();
        g.terms
            .get(&sid)
            .map_or((0, None), |m| (m.pending, m.delivered))
    }

    /// sid 의 밀린 프레임만 버린다. 버린 바이트 수를 돌려준다. 좌표는 꺼낸 것까지 그대로다.
    pub(crate) fn drop_term(&self, sid: u32) -> usize {
        Self::drop_term_locked(&mut self.inner(), sid)
    }

    fn drop_term_locked(g: &mut Inner, sid: u32) -> usize {
        let before = g.term.len();
        let mut freed = 0;
        g.term.retain(|(s, b)| {
            let keep = *s != sid;
            if !keep {
                freed += b.len();
            }
            keep
        });
        if g.term.len() != before {
            g.bytes -= freed.min(g.bytes);
        }
        if let Some(m) = g.terms.get_mut(&sid) {
            m.pending = 0;
        }
        freed
    }

    /// sid 의 밀린 프레임과 좌표를 잊는다 (`term.close`). 세션 번호는 남긴다 — 닫힌 세션의 늦은
    /// 프레임을 계속 버리려면 번호가 올라 있어야 한다.
    pub(crate) fn forget_term(&self, sid: u32) {
        let mut g = self.inner();
        Self::drop_term_locked(&mut g, sid);
        if let Some(m) = g.terms.get_mut(&sid) {
            m.session += 1;
            m.delivered = None;
        }
    }

    /// full(순번 `seq`)을 보낸 뒤, 그 안에 이미 든 밀린 변화를 버린다.
    pub(crate) fn drop_upto(&self, topic: &str, seq: u64) {
        let mut g = self.inner();
        let mut freed = 0;
        if let Some(Pending::Items(q)) = g.state.get_mut(topic) {
            q.retain(|it| {
                let keep = it.seq > seq;
                if !keep {
                    freed += it.frame.len();
                }
                keep
            });
        }
        g.bytes -= freed.min(g.bytes);
    }

    /// 꺼낼 것이 생길 때까지 기다린다.
    pub(crate) async fn next(&self) -> Out {
        loop {
            if let Some(o) = self.pop() {
                return o;
            }
            self.ready.notified().await;
        }
    }
}
