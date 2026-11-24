//! 도구마다의 주의·활동 상태 추적기 (DAEMON_SPLIT_SRS, ATTENTION_FIRING_SRS,
//! AGENT_RECORD_DAEMON_SRS). 판정은 데몬의 `toolhub::Tool` 과 같은 자리, 같은 판정이다
//! (FR-ATF-12·NFR-4).

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering::SeqCst};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use otter_shared_activity as activity;
use otter_shared_toolhub::{
    ATTN_MAX_CARRY, ActivitySnap, ActivityState, AgentState, AgentTurn, activity_still_working,
    attention_allow_bell, attention_idle_threshold, detect_attention_signal,
};
use otter_shared_toolipc::{ATTN_KIND_ACTIVITY, ATTN_KIND_ATTENTION, ATTN_KIND_CLEAR, AttnEvent};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::payloads::{
    tool_activity_payload, tool_attention_clear_payload, tool_attention_payload,
};
use crate::{CommandBroker, lock};

/// ids 의 전경 프로세스 여부를 한 번에 묻는다 (FR-OPT-2-4). `None` 은 "모른다" 이며
/// 호출자는 판정을 보류한다 (IPC-M2). 동기 RPC 다.
pub type BusyManyProbe = Arc<dyn Fn(&[String]) -> Option<HashMap<String, bool>> + Send + Sync>;
/// 그 도구가 아직 있는가 (FR-ATL-6).
pub type LiveProbe = Arc<dyn Fn(&str) -> bool + Send + Sync>;
/// unix-nanos 시계 (NFR-5).
pub type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;
pub type OnChange = Arc<dyn Fn(&str, AgentState) + Send + Sync>;
type MirrorFn = Arc<dyn Fn() -> bool + Send + Sync>;

/// 스위퍼에 주는 틱의 주기다.
pub const SWEEPER_INTERVAL: Duration = Duration::from_secs(1);

/// L2 유휴 임계(ms)다. `OTTERMINAL_ATTENTION_IDLE_MS` 를 따른다 (FR-15).
pub fn default_idle_ms() -> i64 {
    attention_idle_threshold().as_millis() as i64
}

fn wall_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos() as i64)
}

/// 데몬 `toolhub::Tool` 의 주의 관련 필드와 같은 모양이다 (FR-ATF-12·NFR-4).
struct PaneState {
    id: String,
    last_output_at: AtomicI64,
    armed: AtomicBool,
    attention: AtomicBool,
    rearm_locked: AtomicBool,
    agent_seen: AtomicBool,
    turn: AgentTurn,
    carry: Mutex<Option<Vec<u8>>>,
    allow_bell: bool,
    activity: Mutex<Option<ActivityState>>,
}

impl PaneState {
    fn new(id: &str, allow_bell: bool) -> PaneState {
        PaneState {
            id: id.to_owned(),
            last_output_at: AtomicI64::new(0),
            armed: AtomicBool::new(false),
            attention: AtomicBool::new(false),
            rearm_locked: AtomicBool::new(false),
            agent_seen: AtomicBool::new(false),
            turn: AgentTurn::default(),
            carry: Mutex::new(None),
            allow_bell,
            activity: Mutex::new(None),
        }
    }

    fn activity(&self) -> Option<ActivityState> {
        lock(&self.activity).clone()
    }

    fn agent_state(&self) -> AgentState {
        AgentState {
            activity: self.activity(),
            agent_seen: self.agent_seen.load(SeqCst),
            armed: self.armed.load(SeqCst),
            attention: self.attention.load(SeqCst),
            last_output_at: self.last_output_at.load(SeqCst),
            rearm_locked: self.rearm_locked.load(SeqCst),
            turn: self.turn.state(),
        }
    }

    /// st 를 되세우고 활동 카드가 바뀌었는지 돌려준다.
    fn restore(&self, st: &AgentState) -> bool {
        let prev = std::mem::replace(&mut *lock(&self.activity), st.activity.clone());
        self.agent_seen.store(st.agent_seen, SeqCst);
        self.armed.store(st.armed, SeqCst);
        self.attention.store(st.attention, SeqCst);
        self.rearm_locked.store(st.rearm_locked, SeqCst);
        self.last_output_at.store(st.last_output_at, SeqCst);
        self.turn.restore(st.turn);
        !same_card(prev.as_ref(), st.activity.as_ref())
    }
}

fn same_card(a: Option<&ActivityState>, b: Option<&ActivityState>) -> bool {
    match (a, b) {
        (Some(a), Some(b)) => a.state == b.state && a.tool == b.tool && a.detail == b.detail,
        (None, None) => true,
        _ => false,
    }
}

struct Inner {
    tools: HashMap<String, Arc<PaneState>>,
    busy_probe: Option<BusyManyProbe>,
    now_fn: Option<Clock>,
    live_probe: Option<LiveProbe>,
    on_change: Option<OnChange>,
}

/// 도구마다의 주의·활동 상태를 서버 메모리에 든다. 데몬 모드에서 ToolManager 는
/// otterminald 에 있으므로 서버가 자기 판정을 한다.
pub struct AttnTracker {
    mu: Mutex<Inner>,
    hub: Arc<dyn CommandBroker>,
    /// L2 유휴 임계(nanos). 0 이면 끈다.
    idle_threshold: i64,
    /// 맨 BEL 을 알람으로 볼지다 (FR-HPR-17).
    allow_bell: bool,
    /// "데몬이 판정하는가" (§3.3a). 참이면 이 추적기는 거울이다.
    mirror: RwLock<Option<MirrorFn>>,
}

impl AttnTracker {
    /// SSE 허브에 묶인 추적기를 만든다.
    pub fn new(hub: Arc<dyn CommandBroker>, idle_ms: i64) -> Arc<AttnTracker> {
        Arc::new(AttnTracker {
            mu: Mutex::new(Inner {
                tools: HashMap::new(),
                busy_probe: None,
                now_fn: None,
                live_probe: None,
                on_change: None,
            }),
            hub,
            idle_threshold: idle_ms.saturating_mul(1_000_000),
            allow_bell: attention_allow_bell(),
            mirror: RwLock::new(None),
        })
    }

    // ── 방송 (IPC-20). gone 은 방송하지 않고 관찰자에게만 넘긴다. ──

    fn on_attention(&self, id: &str, reason: &str) {
        self.hub.broadcast(&tool_attention_payload(id, reason));
        self.hub.observe_attention(id, reason);
    }

    fn on_attention_clear(&self, id: &str) {
        self.hub.broadcast(&tool_attention_clear_payload(id));
        self.hub.observe_attention_clear(id);
    }

    fn on_activity(&self, id: &str, state: &str, tool: &str, detail: &str) {
        self.hub
            .broadcast(&tool_activity_payload(id, state, tool, detail));
    }

    fn on_gone(&self, id: &str) {
        self.hub.observe_tool_gone(id);
    }

    /// AttentionIDs 가 쓰는 생존 확인을 건다 (FR-ATL-6, FR-ARD-2).
    pub fn set_live_probe(&self, f: Option<LiveProbe>) {
        lock(&self.mu).live_probe = f;
    }

    /// L2 유휴 스위퍼의 전경 프로세스 확인을 건다. 없으면 idle 은 울지 않는다 (FR-15).
    pub fn set_busy_probe(&self, f: Option<BusyManyProbe>) {
        lock(&self.mu).busy_probe = f;
    }

    /// 판정이 상태를 바꾼 뒤의 콜백을 건다 (FR-ARD-11).
    pub fn set_on_change(&self, f: Option<OnChange>) {
        lock(&self.mu).on_change = f;
    }

    /// "데몬이 판정하는가" 를 건다. 부를 때마다 묻는다 (FR-ARD-30).
    pub fn set_mirror(&self, f: impl Fn() -> bool + Send + Sync + 'static) {
        *self.mirror.write().unwrap_or_else(|e| e.into_inner()) = Some(Arc::new(f));
    }

    /// 시험 전용 시계 주입이다 (NFR-5). `None` 이면 벽시계로 돌린다.
    pub fn set_clock_for_testing(&self, now: Option<Clock>) {
        lock(&self.mu).now_fn = now;
    }

    fn mirroring(&self) -> bool {
        let f = self
            .mirror
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        f.is_some_and(|f| f())
    }

    fn state_locked(&self, g: &mut Inner, id: &str) -> Arc<PaneState> {
        g.tools
            .entry(id.to_owned())
            .or_insert_with(|| Arc::new(PaneState::new(id, self.allow_bell)))
            .clone()
    }

    fn state(&self, id: &str) -> Arc<PaneState> {
        let mut g = lock(&self.mu);
        self.state_locked(&mut g, id)
    }

    fn get(&self, id: &str) -> Option<Arc<PaneState>> {
        lock(&self.mu).tools.get(id).cloned()
    }

    fn clock(&self) -> Option<Clock> {
        lock(&self.mu).now_fn.clone()
    }

    fn now(&self) -> i64 {
        self.clock().map_or_else(wall_now, |f| f())
    }

    fn changed(&self, ps: &PaneState) {
        if self.mirroring() {
            return;
        }
        let f = lock(&self.mu).on_change.clone();
        if let Some(f) = f {
            f(&ps.id, ps.agent_state());
        }
    }

    /// 도구의 추적 상태를 모두 버린다 (FR-ATL-4). 주의를 먼저 내리고 가장자리에서만 방송한다
    /// (NFR-PAN-3). 몰랐던 도구도 `gone` 으로 알린다 (GD-12).
    pub fn forget(&self, tool_id: &str) {
        let ps = lock(&self.mu).tools.remove(tool_id);
        if let Some(ps) = ps
            && ps
                .attention
                .compare_exchange(true, false, SeqCst, SeqCst)
                .is_ok()
        {
            self.on_attention_clear(tool_id);
        }
        self.on_gone(tool_id);
    }

    /// PTY 출력에서 알림 시퀀스를 찾는다 (L1 OSC).
    pub fn feed_output(&self, tool_id: &str, data: &[u8]) {
        // 청크당 락은 한 번이다 (FR-OPT-3-4) — 상태와 시계를 같은 구간에서 얻는다.
        let (ps, clock) = {
            let mut g = lock(&self.mu);
            (self.state_locked(&mut g, tool_id), g.now_fn.clone())
        };
        ps.last_output_at
            .store(clock.map_or_else(wall_now, |f| f()), SeqCst);
        if self.mirroring() {
            return;
        }
        // FR-ATF-5: 잠긴 동안 출력은 무장을 세우지 못한다.
        if !ps.rearm_locked.load(SeqCst) {
            ps.armed.store(true, SeqCst);
        }
        let sig = {
            let mut carry = lock(&ps.carry);
            let scan: Vec<u8>;
            let view: &[u8] = match carry.as_deref() {
                Some(c) if !c.is_empty() => {
                    scan = [c, data].concat();
                    &scan
                }
                _ => data,
            };
            if view.contains(&0x1b) || view.contains(&0x07) {
                let (sig, next) = detect_attention_signal(view, ps.allow_bell, ATTN_MAX_CARRY);
                *carry = next;
                sig
            } else {
                *carry = None;
                false
            }
        };
        // FR-ATN-22: 에이전트 도구의 알림 시퀀스는 알람이 아니다 (FR-ATN-25).
        if sig
            && !ps.agent_seen.load(SeqCst)
            && ps
                .attention
                .compare_exchange(false, true, SeqCst, SeqCst)
                .is_ok()
        {
            self.on_attention(tool_id, "signaled");
            self.changed(&ps);
        }
    }

    /// 명시 알람이다 (otterctl notify). 입력 유휴 알림은 되풀이라 걸러 낸다 (FR-ATN-6·15).
    pub fn signal_attention(&self, tool_id: &str, reason: &str) {
        let ps = self.state(tool_id);
        if !ps.turn.allow_signal(reason) {
            return;
        }
        ps.attention.store(true, SeqCst);
        let reason = if reason.is_empty() {
            "signaled"
        } else {
            reason
        };
        self.on_attention(tool_id, reason);
        self.changed(&ps);
    }

    /// 활동 이벤트에서 파생한 알람이다 (FR-AEV-10·14).
    pub fn signal_agent_event(&self, tool_id: &str, state: &str, turn_known: bool) {
        let ps = self.state(tool_id);
        if !ps.turn.allow_activity_signal(state, turn_known) {
            return;
        }
        ps.attention.store(true, SeqCst);
        self.on_attention(tool_id, state);
        self.changed(&ps);
    }

    /// 주의를 내리고 재무장을 잠근다 (FR-ATF-5).
    pub fn attend(&self, tool_id: &str) {
        self.attend_inner(tool_id, false);
    }

    /// 사용자가 키를 누른 주목이다. 재무장을 열어 둔다 (FR-ATF-6).
    pub fn attend_typed(&self, tool_id: &str) {
        self.attend_inner(tool_id, true);
    }

    fn attend_inner(&self, tool_id: &str, typed: bool) {
        let ps = self.state(tool_id);
        ps.armed.store(false, SeqCst);
        ps.rearm_locked.store(!typed, SeqCst);
        if ps
            .attention
            .compare_exchange(true, false, SeqCst, SeqCst)
            .is_ok()
        {
            self.on_attention_clear(tool_id);
        }
        self.changed(&ps);
    }

    pub fn attention(&self, tool_id: &str) -> bool {
        self.get(tool_id)
            .is_some_and(|ps| ps.attention.load(SeqCst))
    }

    /// 주의가 선 도구들이다. 생존 확인이 있으면 죽은 도구를 거른다 (FR-ATL-6). 확인은 락 밖이다.
    pub fn attention_ids(&self) -> Vec<String> {
        let (ids, probe) = {
            let g = lock(&self.mu);
            let ids: Vec<String> = g
                .tools
                .iter()
                .filter(|(_, ps)| ps.attention.load(SeqCst))
                .map(|(id, _)| id.clone())
                .collect();
            (ids, g.live_probe.clone())
        };
        match probe {
            Some(p) => ids.into_iter().filter(|id| p(id)).collect(),
            None => ids,
        }
    }

    /// 모든 도구의 주의를 내린다 (FR-PAN-17). 도구 하나를 주목한 것과 같다 (FR-ATF-13).
    /// 방송은 락을 놓고 한다.
    pub fn clear_all_attention(&self) -> usize {
        let (cleared, all) = {
            let g = lock(&self.mu);
            let mut cleared = Vec::new();
            let mut all = Vec::with_capacity(g.tools.len());
            for ps in g.tools.values() {
                ps.armed.store(false, SeqCst);
                ps.rearm_locked.store(true, SeqCst);
                if ps
                    .attention
                    .compare_exchange(true, false, SeqCst, SeqCst)
                    .is_ok()
                {
                    cleared.push(ps.id.clone());
                }
                all.push(ps.clone());
            }
            (cleared, all)
        };
        for id in &cleared {
            self.on_attention_clear(id);
        }
        for ps in &all {
            self.changed(ps);
        }
        cleared.len()
    }

    /// 활동 상태를 정한다. 보고가 에이전트 표시를 세우고 `ended` 가 내린다 (FR-ATF-2).
    pub fn set_activity(&self, tool_id: &str, state: &str, tool: &str, detail: &str) {
        let ps = self.state(tool_id);
        ps.agent_seen.store(state != activity::ENDED, SeqCst);
        ps.turn.note_activity(state);
        let next = (state != activity::ENDED).then(|| ActivityState {
            state: state.to_owned(),
            tool: tool.to_owned(),
            detail: detail.to_owned(),
            updated_at: self.now(),
        });
        *lock(&ps.activity) = next;
        self.on_activity(tool_id, state, tool, detail);
        self.changed(&ps);
    }

    pub fn activity(&self, tool_id: &str) -> Option<ActivityState> {
        self.get(tool_id)?.activity()
    }

    /// 마지막으로 본 출력 시각(unix nanos)이다. 없으면 0 (FR-STA-4).
    pub fn last_output_at(&self, tool_id: &str) -> i64 {
        self.get(tool_id)
            .map_or(0, |ps| ps.last_output_at.load(SeqCst))
    }

    /// 모든 도구의 지금 활동이다. 전경 프로세스가 사라진 `working` 카드는 거른다
    /// (FR-AAP-20). 확인은 락 밖에서 한 번이고(FR-OPT-2-4), 답을 모르면 남긴다 (IPC-M2).
    pub fn activity_snapshot(&self) -> Vec<ActivitySnap> {
        let (items, probe) = {
            let g = lock(&self.mu);
            let items: Vec<ActivitySnap> = g
                .tools
                .iter()
                .filter_map(|(id, ps)| {
                    ps.activity().map(|a| ActivitySnap {
                        tool_id: id.clone(),
                        state: a.state,
                        tool: a.tool,
                        detail: a.detail,
                        updated_at: a.updated_at,
                    })
                })
                .collect();
            (items, g.busy_probe.clone())
        };
        let working: Vec<String> = items
            .iter()
            .filter(|it| it.state == activity::WORKING)
            .map(|it| it.tool_id.clone())
            .collect();
        let Some(probe) = probe else {
            return items;
        };
        if working.is_empty() {
            return items;
        }
        let Some(busy) = probe(&working) else {
            return items;
        };
        items
            .into_iter()
            .filter(|it| {
                it.state != activity::WORKING || busy.get(&it.tool_id).copied().unwrap_or(false)
            })
            .collect()
    }

    // ── L2 유휴 스위퍼 ──

    /// L2 유휴 스위퍼를 띄운다. 멈추는 길은 `stop` 하나다 (FR-CAF-15). 틱은 주입한다 (TEST-8).
    pub fn start_sweeper(self: &Arc<Self>, stop: CancellationToken, mut tick: mpsc::Receiver<()>) {
        if self.idle_threshold <= 0 {
            return;
        }
        let t = self.clone();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    v = tick.recv() => {
                        if v.is_none() {
                            return;
                        }
                        let t = t.clone();
                        let _ = tokio::task::spawn_blocking(move || t.sweep_idle_at(t.now())).await;
                    }
                    _ = stop.cancelled() => return,
                }
            }
        });
    }

    /// 주어진 시각에 L2 유휴 판정을 한 번 한다 (NFR-5). 판정의 순서와 뜻은 데몬의
    /// `Tool.maybeIdle` 과 같다 (FR-ATF-12): ① 에이전트 도구 ② 턴 진행 중 ③ 일하는 중이 아님
    /// ④ 전경 프로세스. ④ 는 남은 후보 전부를 한 번에 묻는다 (FR-OPT-2-4). 답을 모르면
    /// 무장을 되돌린다 (IPC-M2). 확인은 동기 RPC 이므로 async 문맥에서 부르지 않는다.
    pub fn sweep_idle_at(&self, now: i64) {
        let (snap, probe) = {
            let g = lock(&self.mu);
            (
                g.tools.values().cloned().collect::<Vec<_>>(),
                g.busy_probe.clone(),
            )
        };
        if self.idle_threshold <= 0 || self.mirroring() {
            return;
        }
        let mut disarmed = Vec::new();
        let mut cands = Vec::new();
        for ps in snap {
            if !ps.armed.load(SeqCst) || now - ps.last_output_at.load(SeqCst) < self.idle_threshold
            {
                continue;
            }
            ps.armed.store(false, SeqCst);
            disarmed.push(ps.clone());
            if !ps.agent_seen.load(SeqCst) || probe.is_none() {
                continue;
            }
            // FR-ATN-10: 턴이 진행 중이 아니면 알릴 것이 없다.
            if !ps.turn.in_progress() {
                continue;
            }
            if activity_still_working(ps.activity().as_ref(), now) {
                continue;
            }
            cands.push(ps);
        }
        if let Some(probe) = probe.filter(|_| !cands.is_empty()) {
            let ids: Vec<String> = cands.iter().map(|ps| ps.id.clone()).collect();
            let busy = probe(&ids);
            for ps in &cands {
                let Some(busy) = &busy else {
                    ps.armed.store(true, SeqCst);
                    continue;
                };
                if !busy.get(&ps.id).copied().unwrap_or(false) {
                    continue;
                }
                if ps
                    .attention
                    .compare_exchange(false, true, SeqCst, SeqCst)
                    .is_ok()
                {
                    self.on_attention(&ps.id, "idle");
                }
            }
        }
        // 무장을 내린 도구는 판정이 끝난 뒤의 상태로 알린다 (FR-ARD-11).
        for ps in &disarmed {
            self.changed(ps);
        }
    }

    // ── 데몬 기록의 거울 (FR-ARD-11·13) ──

    /// 도구의 지금 상태다. 모르는 도구는 제로값이다.
    pub fn agent_state_of(&self, tool_id: &str) -> AgentState {
        self.get(tool_id)
            .map(|ps| ps.agent_state())
            .unwrap_or_default()
    }

    /// 데몬 기록 하나를 반영한다. 알람은 울리지 않고, 카드가 바뀌었으면 활동만 방송한다.
    pub fn restore(&self, tool_id: &str, st: &AgentState) {
        if self.state(tool_id).restore(st) {
            self.broadcast_card(tool_id, st.activity.as_ref());
        }
    }

    /// 스냅샷으로 거울을 통째로 바꾼다 (FR-ARD-13). 스냅샷에 없는 도구는 잊는다.
    pub fn restore_all(&self, states: &HashMap<String, AgentState>) {
        let gone: Vec<String> = lock(&self.mu)
            .tools
            .keys()
            .filter(|id| !states.contains_key(*id))
            .cloned()
            .collect();
        for id in gone {
            let had = self.activity(&id).is_some();
            self.forget(&id);
            if had {
                self.broadcast_card(&id, None);
            }
        }
        for (id, st) in states {
            self.restore(id, st);
        }
    }

    fn broadcast_card(&self, tool_id: &str, a: Option<&ActivityState>) {
        match a {
            None => self.on_activity(tool_id, activity::ENDED, "", ""),
            Some(a) => self.on_activity(tool_id, &a.state, &a.tool, &a.detail),
        }
    }

    /// 데몬 판정의 결과 하나다 (FR-ARD-30). 상태를 되세운 뒤 kind 대로 방송한다.
    pub fn apply_attn(&self, ev: &AttnEvent) {
        let ps = self.state(&ev.tool);
        let prev = ps.last_output_at.load(SeqCst);
        ps.restore(&ev.agent);
        // 늦게 온 push 가 마지막 출력 시각을 뒤로 돌리지 않게 한다.
        if prev > ev.agent.last_output_at {
            ps.last_output_at.store(prev, SeqCst);
        }
        match ev.kind.as_str() {
            ATTN_KIND_ATTENTION => {
                let reason = if ev.reason.is_empty() {
                    "signaled"
                } else {
                    &ev.reason
                };
                self.on_attention(&ev.tool, reason);
            }
            ATTN_KIND_CLEAR => self.on_attention_clear(&ev.tool),
            ATTN_KIND_ACTIVITY => self.broadcast_card(&ev.tool, ev.agent.activity.as_ref()),
            _ => {}
        }
    }
}
