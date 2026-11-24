//! 채널 하나의 보낼 것 — 차선 셋과 합치기, 상한 (`perf/CHANNEL_PROTOCOL.md` §6).

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};

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

#[derive(Default)]
struct Inner {
    control: VecDeque<Arc<str>>,
    term: VecDeque<Vec<u8>>,
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
        let mut b = Vec::with_capacity(TERM_HEAD + payload.len());
        b.push(op);
        b.extend_from_slice(&sid.to_be_bytes());
        b.extend_from_slice(payload);
        let n = b.len();
        g.term.push_back(b);
        g.add(n);
        drop(g);
        self.ready.notify_one();
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
        if let Some(b) = g.term.pop_front() {
            g.bytes -= b.len().min(g.bytes);
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
