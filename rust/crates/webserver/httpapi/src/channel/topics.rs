//! 토픽의 상태·순번·링·구독 (`perf/CHANNEL_PROTOCOL.md` §5.1·§11.1).

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::sync::{Arc, LazyLock, Mutex, Weak};

use futures_util::future::BoxFuture;
use serde_json::{Map, Value, json};

use super::outbox::Outbox;

/// 토픽마다 기억하는 최근 변화의 수다 (§5.1).
pub(crate) const TOPIC_RING: usize = 64;
/// seed 와 발행이 겹치면 seed 를 다시 부르는 횟수의 상한이다.
const SEED_TRIES: usize = 3;

/// 서버 프로세스마다 하나다. 순번은 이 값 안에서만 뜻이 있다.
static EPOCH: LazyLock<String> = LazyLock::new(|| hex::encode(rand::random::<[u8; 8]>()));

pub(crate) enum DeltaOp {
    Put { id: String, v: Value },
    Del { id: String },
}

/// 처음 상태. `Event` 는 상태 없는 사건 토픽이라는 뜻이다.
pub(crate) enum Seed {
    Full(Value),
    Map(BTreeMap<String, Value>),
    Event,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum ItemKind {
    Full,
    Delta,
    Event,
    Reset,
}

/// 보낼 프레임 하나. 직렬화는 발행할 때 한 번만 한다 (FR-SRV-1).
pub(crate) struct Item {
    pub(crate) topic: String,
    pub(crate) seq: u64,
    pub(crate) kind: ItemKind,
    pub(crate) frame: Arc<str>,
}

#[derive(Debug)]
pub(crate) enum SubError {
    UnknownTopic,
}

enum State {
    Full(Value),
    Map(BTreeMap<String, Value>),
    Event,
}

#[derive(Default)]
struct Topic {
    seq: u64,
    state: Option<State>,
    /// 지금 순번의 full(사건 토픽은 reset). 순번이 같으면 다시 직렬화하지 않고 나눈다 (M4 §4).
    full: Option<Arc<Item>>,
    ring: VecDeque<Arc<Item>>,
    subs: HashMap<u64, Weak<Outbox>>,
}

type SeedFn = Arc<dyn Fn(String) -> BoxFuture<'static, Option<Seed>> + Send + Sync>;
type DemandFn = Arc<dyn Fn(&str, bool) + Send + Sync>;

#[derive(Default)]
pub(crate) struct TopicHub {
    topics: Mutex<HashMap<String, Topic>>,
    seeds: Mutex<Vec<(String, SeedFn)>>,
    demand: Mutex<Vec<(String, DemandFn)>>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// `prefix` 가 `:` 로 끝나면 그 아래 전부, 아니면 정확히 같은 이름이다.
fn matches(prefix: &str, topic: &str) -> bool {
    if prefix.ends_with(':') {
        topic.starts_with(prefix)
    } else {
        prefix == topic
    }
}

fn frame(v: &Value) -> Arc<str> {
    Arc::from(v.to_string())
}

fn item(topic: &str, seq: u64, kind: ItemKind, v: Value) -> Arc<Item> {
    Arc::new(Item {
        topic: topic.to_owned(),
        seq,
        kind,
        frame: frame(&v),
    })
}

fn reset_item(topic: &str, seq: u64) -> Arc<Item> {
    item(
        topic,
        seq,
        ItemKind::Reset,
        json!({"t":"reset","topic":topic}),
    )
}

fn state_value(st: &State) -> Option<Value> {
    match st {
        State::Full(v) => Some(v.clone()),
        State::Map(m) => Some(Value::Object(
            m.iter()
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect::<Map<_, _>>(),
        )),
        State::Event => None,
    }
}

impl Topic {
    fn full_item(&mut self, name: &str) -> Option<Arc<Item>> {
        if let Some(it) = self.full.as_ref().filter(|it| it.seq == self.seq) {
            return Some(it.clone());
        }
        let it = match self.state.as_ref()? {
            State::Event => reset_item(name, self.seq),
            st => {
                let data = state_value(st)?;
                item(
                    name,
                    self.seq,
                    ItemKind::Full,
                    json!({"t":"full","topic":name,"seq":self.seq,"data":data}),
                )
            }
        };
        self.full = Some(it.clone());
        Some(it)
    }

    /// 순번을 올리고 링과 구독자에게 보낸다.
    fn emit(&mut self, it: Arc<Item>) {
        self.ring.push_back(it.clone());
        while self.ring.len() > TOPIC_RING {
            self.ring.pop_front();
        }
        self.subs.retain(|_, w| match w.upgrade() {
            Some(o) => {
                o.push_state(it.clone());
                true
            }
            None => false,
        });
    }

    /// 재구독 판정 (§5.1). 보낼 것들을 순서대로 돌려준다. 못 이으면 full(사건 토픽은 reset)이다.
    fn catch_up(&mut self, name: &str, seq: Option<u64>, epoch: Option<&str>) -> Vec<Arc<Item>> {
        let Some(s) = seq else {
            if matches!(self.state, Some(State::Event)) {
                return Vec::new();
            }
            return self.full_item(name).into_iter().collect();
        };
        if epoch == Some(EPOCH.as_str()) && s <= self.seq {
            if s == self.seq {
                return Vec::new();
            }
            let oldest = self.ring.front().map_or(self.seq + 1, |it| it.seq);
            if s + 1 >= oldest {
                return self.ring.iter().filter(|it| it.seq > s).cloned().collect();
            }
        }
        self.full_item(name).into_iter().collect()
    }
}

impl TopicHub {
    pub(crate) fn epoch(&self) -> &str {
        EPOCH.as_str()
    }

    pub(crate) fn register_seed(
        &self,
        prefix: &str,
        f: impl Fn(String) -> BoxFuture<'static, Option<Seed>> + Send + Sync + 'static,
    ) {
        lock(&self.seeds).push((prefix.to_owned(), Arc::new(f)));
    }

    pub(crate) fn on_demand(&self, prefix: &str, f: impl Fn(&str, bool) + Send + Sync + 'static) {
        lock(&self.demand).push((prefix.to_owned(), Arc::new(f)));
    }

    pub(crate) fn publish_full(&self, topic: &str, data: Value) {
        let mut ts = lock(&self.topics);
        let t = ts.entry(topic.to_owned()).or_default();
        t.seq += 1;
        let it = item(
            topic,
            t.seq,
            ItemKind::Full,
            json!({"t":"full","topic":topic,"seq":t.seq,"data":data}),
        );
        t.state = Some(State::Full(data));
        t.full = Some(it.clone());
        t.emit(it);
    }

    /// 상태를 아직 모르는 토픽(seed 전)에는 상태에 적용하지 않는다 — 부분 상태를 full 로
    /// 내보내지 않으려는 것이다. 순번과 링은 그대로 오른다.
    pub(crate) fn publish_delta(&self, topic: &str, ops: Vec<DeltaOp>) {
        let mut ts = lock(&self.topics);
        let t = ts.entry(topic.to_owned()).or_default();
        t.seq += 1;
        let wire: Vec<Value> = ops
            .iter()
            .map(|op| match op {
                DeltaOp::Put { id, v } => json!({"op":"put","id":id,"v":v}),
                DeltaOp::Del { id } => json!({"op":"del","id":id}),
            })
            .collect();
        if let Some(State::Map(m)) = &mut t.state {
            for op in ops {
                match op {
                    DeltaOp::Put { id, v } => {
                        m.insert(id, v);
                    }
                    DeltaOp::Del { id } => {
                        m.remove(&id);
                    }
                }
            }
        }
        let it = item(
            topic,
            t.seq,
            ItemKind::Delta,
            json!({"t":"delta","topic":topic,"seq":t.seq,"ops":wire}),
        );
        t.emit(it);
    }

    pub(crate) fn publish_event(&self, topic: &str, data: Value) {
        let mut ts = lock(&self.topics);
        let t = ts.entry(topic.to_owned()).or_default();
        t.seq += 1;
        if t.state.is_none() {
            t.state = Some(State::Event);
        }
        let it = item(
            topic,
            t.seq,
            ItemKind::Event,
            json!({"t":"event","topic":topic,"seq":t.seq,"data":data}),
        );
        t.emit(it);
    }

    /// 지금 상태로 만든 full(사건 토픽은 reset). 상태가 없으면 `None`.
    pub(crate) fn full_item(&self, topic: &str) -> Option<Arc<Item>> {
        lock(&self.topics).get_mut(topic)?.full_item(topic)
    }

    fn seed_fn(&self, topic: &str) -> Option<SeedFn> {
        lock(&self.seeds)
            .iter()
            .find(|(p, _)| matches(p, topic))
            .map(|(_, f)| f.clone())
    }

    /// 상태가 없으면 seed 로 채운다. seed 하는 사이에 발행이 끼면 다시 부른다.
    async fn ensure_state(&self, topic: &str) -> Result<(), SubError> {
        for _ in 0..SEED_TRIES {
            let before = {
                let ts = lock(&self.topics);
                match ts.get(topic) {
                    Some(t) if t.state.is_some() => return Ok(()),
                    Some(t) => t.seq,
                    None => 0,
                }
            };
            let f = self.seed_fn(topic).ok_or(SubError::UnknownTopic)?;
            let seed = f(topic.to_owned()).await.ok_or(SubError::UnknownTopic)?;
            let mut ts = lock(&self.topics);
            let t = ts.entry(topic.to_owned()).or_default();
            if t.state.is_some() {
                return Ok(());
            }
            if t.seq == before {
                t.state = Some(match seed {
                    Seed::Full(v) => State::Full(v),
                    Seed::Map(m) => State::Map(m),
                    Seed::Event => State::Event,
                });
                return Ok(());
            }
        }
        Err(SubError::UnknownTopic)
    }

    pub(crate) async fn subscribe(
        &self,
        chan: u64,
        out: &Arc<Outbox>,
        topic: &str,
        seq: Option<u64>,
        epoch: Option<&str>,
    ) -> Result<(), SubError> {
        self.ensure_state(topic).await?;
        let first = {
            let mut ts = lock(&self.topics);
            let t = ts.entry(topic.to_owned()).or_default();
            t.subs.retain(|_, w| w.strong_count() > 0);
            let first = t.subs.is_empty();
            // 판정과 등록을 한 락 안에서 한다 — 사이에 발행이 끼면 빠지거나 겹친다.
            for it in t.catch_up(topic, seq, epoch) {
                out.push_state(it);
            }
            t.subs.insert(chan, Arc::downgrade(out));
            first
        };
        if first {
            self.notify_demand(topic, true);
        }
        Ok(())
    }

    pub(crate) fn unsubscribe(&self, chan: u64, topic: &str) {
        let last = {
            let mut ts = lock(&self.topics);
            match ts.get_mut(topic) {
                Some(t) => t.subs.remove(&chan).is_some() && t.subs.is_empty(),
                None => false,
            }
        };
        if last {
            self.notify_demand(topic, false);
        }
    }

    pub(crate) fn unsubscribe_all(&self, chan: u64) {
        let idle: Vec<String> = {
            let mut ts = lock(&self.topics);
            ts.iter_mut()
                .filter_map(|(name, t)| {
                    (t.subs.remove(&chan).is_some() && t.subs.is_empty()).then(|| name.clone())
                })
                .collect()
        };
        for topic in idle {
            self.notify_demand(&topic, false);
        }
    }

    /// 구독자가 없으면 상태를 비우고 순번을 올린 뒤 true 다. 부르는 쪽은 본문을 만들지 않는다 —
    /// 다음 구독이 seed 로 새 상태를 받고, 올린 순번 때문에 옛 순번의 재구독도 full 을 받는다.
    pub(crate) fn stale_if_idle(&self, topic: &str) -> bool {
        let mut ts = lock(&self.topics);
        let Some(t) = ts.get_mut(topic) else {
            return true;
        };
        t.subs.retain(|_, w| w.strong_count() > 0);
        if !t.subs.is_empty() {
            return false;
        }
        if t.state.take().is_some() {
            t.seq += 1;
            t.ring.clear();
            t.full = None;
        }
        true
    }

    /// 구독자가 없는 토픽을 잊는다 — 끝난 잡처럼 다시 오지 않을 토픽의 링을 놓는다.
    pub(crate) fn forget_idle(&self, topic: &str) {
        let mut ts = lock(&self.topics);
        if ts.get(topic).is_some_and(|t| t.subs.is_empty()) {
            ts.remove(topic);
        }
    }

    fn notify_demand(&self, topic: &str, active: bool) {
        let fs: Vec<DemandFn> = lock(&self.demand)
            .iter()
            .filter(|(p, _)| matches(p, topic))
            .map(|(_, f)| f.clone())
            .collect();
        for f in fs {
            f(topic, active);
        }
    }
}
