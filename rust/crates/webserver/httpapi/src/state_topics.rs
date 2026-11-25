//! 채널의 상태 토픽 — delta 토픽(`attention`·`activity`·`background`·`runs`), Run 그래프
//! (`run:<id>`), 지표(`stats:<ms>`) (`docs/internal/perf/CHANNEL_PROTOCOL.md` §10.4 C3).
//!
//! 계기(관련 방송·보고)가 오면 토픽의 맵을 다시 계산해 지난번과 비교하고 다른 id 만 낸다.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use futures_util::future::BoxFuture;
use serde::Serialize;
use serde_json::Value;
use tokio::runtime::Handle;
use tokio_util::sync::CancellationToken;

use crate::Server;
use crate::channel::{DeltaOp, Seed};
use crate::tools_api::off_thread;

/// 계기를 합치는 창이다.
pub(crate) const STATE_TOPIC_DEBOUNCE: Duration = Duration::from_millis(100);
/// `stats:<ms>` 주기의 하한이다.
pub(crate) const STATS_MIN: Duration = Duration::from_secs(1);
/// `activity` 맵에서 리밋 목록이 사는 예약 id 다.
pub(crate) const LIMITS_ID: &str = "_limits";

pub(crate) const T_ATTENTION: u8 = 1;
pub(crate) const T_ACTIVITY: u8 = 1 << 1;
pub(crate) const T_BACKGROUND: u8 = 1 << 2;
pub(crate) const T_RUNS: u8 = 1 << 3;
pub(crate) const T_ALL: u8 = T_ATTENTION | T_ACTIVITY | T_BACKGROUND | T_RUNS;

const MAP_TOPICS: [(u8, &str); 4] = [
    (T_ATTENTION, "attention"),
    (T_ACTIVITY, "activity"),
    (T_BACKGROUND, "background"),
    (T_RUNS, "runs"),
];

type Map = BTreeMap<String, Value>;

#[derive(Default)]
struct Dirty {
    flags: u8,
    scheduled: bool,
}

#[derive(Default)]
struct StatsLoop {
    /// 구독 중인 토픽 → 주기.
    topics: HashMap<String, Duration>,
    every: Option<Duration>,
    stop: Option<CancellationToken>,
}

#[derive(Default)]
pub(crate) struct StateTopics {
    rt: Mutex<Option<Handle>>,
    dirty: Mutex<Dirty>,
    /// 토픽마다 마지막으로 낸 상태. seed 와 계산이 한 줄로 선다.
    last: tokio::sync::Mutex<HashMap<String, Value>>,
    runs_open: Mutex<HashSet<String>>,
    stats: Mutex<StatsLoop>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// GET 과 같은 바이트가 되도록 GET 의 직렬화(Go 호환)를 지난다.
fn to_value<T: Serialize>(v: &T) -> Value {
    otter_gocompat::json::marshal(v)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or(Value::Null)
}

/// 방송 action 하나가 건드릴 수 있는 토픽들.
fn flags_of(action: &str) -> u8 {
    match action {
        "tool_attention" | "tool_attention_clear" => T_ATTENTION,
        "tool_activity" | "tool_subagent_activity" => T_ACTIVITY | T_RUNS,
        "tools_background_changed" => T_BACKGROUND,
        // `working` 항목은 PTY 가 바쁠 때만 보인다(`activity_snapshot` 의 busy 판정). 바쁨이
        // 바뀌는 사건은 전경 이름의 변화다 — 활동·Run 도 다시 계산한다.
        "tool_foreground" => T_BACKGROUND | T_ACTIVITY | T_RUNS,
        "run_changed" => T_RUNS | T_BACKGROUND,
        "workspace_changed" => T_ALL,
        _ => 0,
    }
}

fn stats_every(topic: &str) -> Option<Duration> {
    let ms: u64 = topic.strip_prefix("stats:")?.parse().ok()?;
    Some(Duration::from_millis(ms).max(STATS_MIN))
}

fn diff(old: Option<&Map>, new: &Map) -> Vec<DeltaOp> {
    let empty = Map::new();
    let old = old.unwrap_or(&empty);
    let mut ops: Vec<DeltaOp> = new
        .iter()
        .filter(|(k, v)| old.get(*k) != Some(*v))
        .map(|(k, v)| DeltaOp::Put {
            id: k.clone(),
            v: v.clone(),
        })
        .collect();
    ops.extend(
        old.keys()
            .filter(|k| !new.contains_key(*k))
            .map(|k| DeltaOp::Del { id: k.clone() }),
    );
    ops
}

fn as_map(v: Option<&Value>) -> Option<Map> {
    v.and_then(Value::as_object)
        .map(|o| o.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
}

impl Server {
    /// 상태 토픽의 seed·계기·측정을 단다. `Server::new` 가 한 번 부른다.
    pub(crate) fn wire_state_topics(self: &Arc<Self>) {
        *lock(&self.state_topics.rt) = Handle::try_current().ok();
        for (_, name) in MAP_TOPICS {
            let w = Arc::downgrade(self);
            self.topics.register_seed(name, move |topic| {
                let w = w.clone();
                Box::pin(async move {
                    let s = w.upgrade()?;
                    let mut last = s.state_topics.last.lock().await;
                    let m = s.topic_map(&topic).await?;
                    last.insert(topic, Value::Object(m.clone().into_iter().collect()));
                    Some(Seed::Map(m))
                }) as BoxFuture<'static, Option<Seed>>
            });
        }
        let w = Arc::downgrade(self);
        self.topics.register_seed("run:", move |topic| {
            let w = w.clone();
            Box::pin(async move {
                let s = w.upgrade()?;
                let mut last = s.state_topics.last.lock().await;
                let g = s.run_graph(topic.strip_prefix("run:")?).await?;
                last.insert(topic, g.clone());
                Some(Seed::Full(g))
            }) as BoxFuture<'static, Option<Seed>>
        });
        let w = Arc::downgrade(self);
        self.topics.on_demand("run:", move |topic, active| {
            if let Some(s) = w.upgrade() {
                let mut open = lock(&s.state_topics.runs_open);
                if active {
                    open.insert(topic.to_owned());
                } else {
                    open.remove(topic);
                }
            }
        });
        let w = Arc::downgrade(self);
        self.topics.register_seed("stats:", move |topic| {
            let w = w.clone();
            Box::pin(async move {
                stats_every(&topic)?;
                let s = w.upgrade()?;
                // PERF 4.10: 샘플러를 띄우고 예열을 기다린다 — 첫 프레임에 CPU 가 있다.
                if let Some(st) = s.deps.stats.clone() {
                    st.resume();
                    st.warmed().await;
                }
                Some(Seed::Full(to_value(&s.get_stats())))
            }) as BoxFuture<'static, Option<Seed>>
        });
        let w = Arc::downgrade(self);
        self.topics.on_demand("stats:", move |topic, active| {
            if let Some(s) = w.upgrade() {
                s.stats_demand(topic, active);
            }
        });
        if let Some(c) = self.commands() {
            let w: Weak<Server> = Arc::downgrade(self);
            c.set_broadcast_tap(Some(Arc::new(move |p: &[u8]| {
                if let Some(s) = w.upgrade() {
                    s.on_broadcast(p);
                }
            })));
        }
    }

    fn on_broadcast(&self, payload: &[u8]) {
        #[derive(serde::Deserialize)]
        struct Action {
            #[serde(default)]
            action: String,
        }
        if let Ok(a) = serde_json::from_slice::<Action>(payload) {
            self.mark_state_topics(flags_of(&a.action));
        }
    }

    /// 모든 상태 토픽을 다시 계산하게 한다.
    #[cfg(test)]
    pub(crate) fn state_topics_dirty(&self) {
        self.mark_state_topics(T_ALL);
    }

    /// 토픽들이 바뀌었을 수 있다. `STATE_TOPIC_DEBOUNCE` 안의 계기는 한 번으로 합친다.
    pub(crate) fn mark_state_topics(&self, flags: u8) {
        if flags == 0 {
            return;
        }
        let Some(rt) = lock(&self.state_topics.rt).clone() else {
            return;
        };
        let Some(me) = self.arc() else {
            return;
        };
        {
            let mut d = lock(&self.state_topics.dirty);
            d.flags |= flags;
            if d.scheduled {
                return;
            }
            d.scheduled = true;
        }
        rt.spawn(async move {
            tokio::time::sleep(STATE_TOPIC_DEBOUNCE).await;
            let flags = {
                let mut d = lock(&me.state_topics.dirty);
                d.scheduled = false;
                std::mem::take(&mut d.flags)
            };
            me.refresh_state_topics(flags).await;
        });
    }

    async fn refresh_state_topics(&self, flags: u8) {
        let mut last = self.state_topics.last.lock().await;
        for (bit, name) in MAP_TOPICS {
            if flags & bit == 0 {
                continue;
            }
            let Some(new) = self.topic_map(name).await else {
                continue;
            };
            let ops = diff(as_map(last.get(name)).as_ref(), &new);
            if !ops.is_empty() {
                self.topics.publish_delta(name, ops);
            }
            last.insert(name.to_owned(), Value::Object(new.into_iter().collect()));
        }
        if flags & T_RUNS == 0 {
            return;
        }
        let open: Vec<String> = lock(&self.state_topics.runs_open).iter().cloned().collect();
        for topic in open {
            let Some(id) = topic.strip_prefix("run:") else {
                continue;
            };
            // 저장소에서 물러난 Run 은 null 로 알린다 — 화면은 그것을 "사라짐" 으로 그린다.
            let g = self.run_graph(id).await.unwrap_or(Value::Null);
            if last.get(&topic) != Some(&g) {
                self.topics.publish_full(&topic, g.clone());
                last.insert(topic, g);
            }
        }
    }

    async fn topic_map(&self, name: &str) -> Option<Map> {
        Some(match name {
            "attention" => self
                .attention()
                .attention_ids()
                .unwrap_or_default()
                .into_iter()
                .map(|id| (id, Value::Bool(true)))
                .collect(),
            "activity" => {
                let mut m: Map = self
                    .activity_entries()
                    .iter()
                    .map(to_value)
                    .filter_map(|v| Some((v["toolId"].as_str()?.to_owned(), v)))
                    .collect();
                let limits = self
                    .agents
                    .rate_limits
                    .view(time::OffsetDateTime::now_utc());
                m.insert(LIMITS_ID.to_owned(), to_value(&limits));
                m
            }
            "background" => self
                .background_rows()
                .await
                .iter()
                .map(to_value)
                .filter_map(|v| Some((v["toolId"].as_str()?.to_owned(), v)))
                .collect(),
            "runs" => {
                let st = self.runs()?.clone();
                let me = self.arc()?;
                off_thread(move || {
                    st.list()
                        .iter()
                        .map(|rec| (rec.id.clone(), to_value(&me.view_of(rec))))
                        .collect::<Map>()
                })
                .await?
            }
            _ => return None,
        })
    }

    async fn run_graph(&self, id: &str) -> Option<Value> {
        let st = self.runs()?.clone();
        let me = self.arc()?;
        let id = id.to_owned();
        off_thread(move || st.get(&id).map(|rec| to_value(&me.graph_of(&rec))))
            .await
            .flatten()
    }

    fn stats_demand(&self, topic: &str, active: bool) {
        let Some(every) = stats_every(topic) else {
            return;
        };
        // 다음 구독은 낡은 값이 아니라 예열한 새 값을 seed 로 받는다.
        if !active {
            self.topics.stale_if_idle(topic);
        }
        let mut st = lock(&self.state_topics.stats);
        if active {
            st.topics.insert(topic.to_owned(), every);
        } else {
            st.topics.remove(topic);
        }
        // PERF D-61: 샘플러는 `stats:*` 구독이 있는 동안만 돈다.
        if let Some(sampler) = self.deps.stats.as_ref() {
            if st.topics.is_empty() {
                sampler.pause();
            } else {
                sampler.resume();
            }
        }
        let want = st.topics.values().min().copied();
        if want == st.every {
            return;
        }
        st.every = want;
        if let Some(stop) = st.stop.take() {
            stop.cancel();
        }
        let (Some(every), Some(rt), Some(me)) =
            (want, lock(&self.state_topics.rt).clone(), self.arc())
        else {
            return;
        };
        let stop = CancellationToken::new();
        st.stop = Some(stop.clone());
        rt.spawn(async move {
            let mut iv = tokio::time::interval_at(tokio::time::Instant::now() + every, every);
            loop {
                tokio::select! {
                    _ = stop.cancelled() => return,
                    _ = iv.tick() => {
                        let data = to_value(&me.get_stats());
                        let topics: Vec<String> =
                            lock(&me.state_topics.stats).topics.keys().cloned().collect();
                        for t in topics {
                            me.topics.publish_full(&t, data.clone());
                        }
                    }
                }
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn foreground_change_refreshes_activity() {
        assert_ne!(flags_of("tool_foreground") & T_ACTIVITY, 0);
        assert_ne!(flags_of("tool_foreground") & T_RUNS, 0);
        assert_eq!(flags_of("focus"), 0);
    }
}
