//! 컨텍스트 관측·등급과 승계·인수인계 (ORCHESTRATION_V2_SRS 묶음 C, ALERT_MOBILE_CONTEXT_SRS).

use std::fmt::Write as _;

use crate::store::{find_by_tool, index_of_member, sender_member};
use crate::{ContextState, Error, Member, OPEN, Record, STARTING, SUCCEEDED, Store};

pub const LEVEL_OK: &str = "ok";
pub const LEVEL_WARN: &str = "warn";
pub const LEVEL_CRITICAL: &str = "critical";

/// 정책 기본 창. 관측이 넘으면 넓힌다 (FR-CTX-6).
pub const DEFAULT_WINDOW_TOKENS: f64 = 200_000.0;

/// 넓히기가 딛는 사다리.
const CONTEXT_WINDOWS: &[f64] = &[DEFAULT_WINDOW_TOKENS, 1_000_000.0];

/// 에이전트가 모델 이름으로 말하는 창 크기. 말하지 않으면 `None` (FR-AAC-20).
pub fn window_for_model(agent: &str, model: &str) -> Option<f64> {
    let a = dm_shared_agentadapter::get(agent.trim()).ok()?;
    (a.context_window?)(model)
}

/// 관측 토큰이 창을 넘으면 사다리의 다음 단계로, 그것도 넘으면 관측값으로 넓힌다.
pub fn widen_window(limit: f64, tokens: f64) -> f64 {
    if tokens <= limit {
        return limit;
    }
    CONTEXT_WINDOWS
        .iter()
        .copied()
        .find(|&w| w >= tokens)
        .unwrap_or(tokens)
}

/// 바이트에서 토큰을 어림하고 등급을 매기는 정책. 0 이하인 값은 기본값을 쓴다.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct ContextPolicy {
    pub bytes_per_token: f64,
    pub limit_tokens: f64,
    pub warn_ratio: f64,
    pub critical_ratio: f64,
}

impl ContextPolicy {
    pub fn default_policy() -> Self {
        Self {
            bytes_per_token: 3.6,
            limit_tokens: DEFAULT_WINDOW_TOKENS,
            warn_ratio: 0.70,
            critical_ratio: 0.85,
        }
    }

    fn with_defaults(mut self) -> Self {
        let d = Self::default_policy();
        if self.bytes_per_token <= 0.0 {
            self.bytes_per_token = d.bytes_per_token;
        }
        if self.limit_tokens <= 0.0 {
            self.limit_tokens = d.limit_tokens;
        }
        if self.warn_ratio <= 0.0 {
            self.warn_ratio = d.warn_ratio;
        }
        if self.critical_ratio <= 0.0 {
            self.critical_ratio = d.critical_ratio;
        }
        if self.critical_ratio < self.warn_ratio {
            std::mem::swap(&mut self.warn_ratio, &mut self.critical_ratio);
        }
        self
    }

    pub fn ratio(self, bytes: i64) -> f64 {
        let p = self.with_defaults();
        (bytes as f64 / p.bytes_per_token) / p.limit_tokens
    }

    pub fn estimate_tokens(self, bytes: i64) -> f64 {
        bytes as f64 / self.with_defaults().bytes_per_token
    }

    /// 압축이 한 번이라도 있었으면 critical 이다 — 정보는 이미 유실됐다 (FR-CBG-1).
    pub fn grade(self, ratio: f64, compact_count: i64) -> &'static str {
        if compact_count > 0 {
            return LEVEL_CRITICAL;
        }
        let d = self.with_defaults();
        if ratio >= d.critical_ratio {
            LEVEL_CRITICAL
        } else if ratio >= d.warn_ratio {
            LEVEL_WARN
        } else {
            LEVEL_OK
        }
    }

    pub fn level(self, bytes: i64, compact_count: i64) -> &'static str {
        self.grade(self.ratio(bytes), compact_count)
    }
}

/// 훅 한 번이 실어 온 컨텍스트 관측. `has_*` 가 거짓이면 그 값은 모른다.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ContextObservation {
    pub bytes: i64,
    pub has_bytes: bool,
    pub session_id: String,
    pub compacted: bool,
    pub tokens: i64,
    pub has_tokens: bool,
    pub model: String,
    pub agent: String,
    /// statusLine 이 말한 공식 창. 0 이면 없다.
    pub window: f64,
}

fn level_rank(level: &str) -> u8 {
    match level {
        LEVEL_OK => 1,
        LEVEL_WARN => 2,
        LEVEL_CRITICAL => 3,
        _ => 0,
    }
}

fn only_context_at_changed(before: &ContextState, after: &ContextState) -> bool {
    let mut a = after.clone();
    a.context_at = before.context_at;
    a == *before
}

/// 관측 하나를 반영한다. 등급이 올라 warn·critical 에 들어섰으면 그 등급을 돌려준다.
fn apply_observation(
    cs: &mut ContextState,
    obs: &ContextObservation,
    policy: ContextPolicy,
    now: i64,
) -> String {
    let mut entered = String::new();
    if obs.compacted {
        cs.compact_count += 1;
    }
    if !obs.session_id.is_empty() {
        cs.session_id.clone_from(&obs.session_id);
    }
    if obs.has_bytes {
        cs.context_bytes = obs.bytes;
    }
    if obs.has_tokens {
        cs.context_tokens = obs.tokens;
    }
    if obs.window > 0.0 {
        cs.context_limit = obs.window;
        cs.window_official = true;
    } else if let Some(w) = window_for_model(&obs.agent, &obs.model).filter(|_| !cs.window_official)
    {
        cs.context_limit = w;
    }
    if cs.context_limit <= 0.0 {
        cs.context_limit = policy.with_defaults().limit_tokens;
    }
    let mut tokens = cs.context_tokens as f64;
    if tokens <= 0.0 {
        tokens = policy.estimate_tokens(cs.context_bytes);
    }
    if tokens > 0.0 {
        cs.context_limit = widen_window(cs.context_limit, tokens);
        cs.context_ratio = tokens / cs.context_limit;
    }
    if cs.context_bytes > 0 || cs.context_tokens > 0 || cs.compact_count > 0 {
        let level = policy.grade(cs.context_ratio, cs.compact_count);
        if level_rank(level) > level_rank(&cs.context_level) && level != LEVEL_OK {
            entered = level.to_owned();
        }
        cs.context_level = level.to_owned();
    }
    cs.context_at = now;
    entered
}

/// 승계 값 (FR-CBG-8).
#[derive(Debug, Clone, Default)]
pub struct SucceedSpec {
    pub id: String,
    pub prev_member_id: String,
    pub tool_id: String,
    pub tab_id: String,
    pub headless: bool,
    pub summary: String,
    pub handoff_asked: bool,
}

impl Store {
    /// 도구의 컨텍스트 관측을 기록한다. 멤버가 아니면 열린 Run 의 조정자로 찾는다.
    /// 찾으면 (멤버, 새로 들어선 등급)이다. 조정자면 멤버는 run_id 와 context 만 채운다.
    /// 관측 시각만 바뀌었으면 쓰지 않는다.
    pub fn observe_context(
        &self,
        tool_id: &str,
        obs: &ContextObservation,
        policy: ContextPolicy,
    ) -> Option<(Member, String)> {
        let mut g = self.lock();
        let now = self.now();
        let Some((ri, mi)) = find_by_tool(&g.runs, tool_id) else {
            return self.observe_coordinator(&mut g, tool_id, obs, policy, now);
        };
        let cur = &mut g.runs[ri].members[mi];
        let before = cur.context.clone();
        let entered = apply_observation(&mut cur.context, obs, policy, now);
        let out = cur.clone();
        if !only_context_at_changed(&before, &out.context) {
            let _ = self.save(&mut g);
        }
        Some((out, entered))
    }

    fn observe_coordinator(
        &self,
        g: &mut crate::store::Inner,
        tool_id: &str,
        obs: &ContextObservation,
        policy: ContextPolicy,
        now: i64,
    ) -> Option<(Member, String)> {
        if tool_id.is_empty() {
            return None;
        }
        let r = g
            .runs
            .iter_mut()
            .find(|r| r.coordinator_tool_id == tool_id && r.state == OPEN)?;
        let cs = r.coordinator.get_or_insert_with(ContextState::default);
        let before = cs.clone();
        apply_observation(cs, obs, policy, now);
        let out = Member {
            run_id: r.id.clone(),
            context: cs.clone(),
            ..Member::default()
        };
        let agent_changed = !obs.agent.is_empty() && obs.agent != r.coordinator_agent;
        if agent_changed {
            r.coordinator_agent.clone_from(&obs.agent);
        }
        if agent_changed || !only_context_at_changed(&before, &out.context) {
            let _ = self.save(g);
        }
        Some((out, String::new()))
    }

    /// 멤버를 새 도구의 새 멤버로 승계한다 (FR-CBG-8). 작업 트리·배정을 물려받는다.
    pub fn succeed(&self, spec: SucceedSpec) -> Result<(Member, Member), Error> {
        if spec.prev_member_id.trim().is_empty() {
            return Err(Error::invalid("승계 대상 멤버가 필요하다"));
        }
        if spec.tool_id.trim().is_empty() {
            return Err(Error::invalid("새 멤버가 들어앉을 도구가 필요하다"));
        }
        let mut g = self.lock();
        let (ri, mi) =
            index_of_member(&g.runs, &spec.prev_member_id).ok_or(Error::UnknownMember)?;
        if g.runs[ri].state != OPEN {
            return Err(Error::RunClosed);
        }
        if find_by_tool(&g.runs, &spec.tool_id).is_some() {
            return Err(Error::ToolAlreadyMember);
        }
        let old = &g.runs[ri].members[mi];
        if !old.succeeded_by.is_empty() {
            return Err(Error::invalid(format!(
                "이미 승계된 멤버다 (승계자 {})",
                old.succeeded_by
            )));
        }
        let mut id = spec.id.trim().to_owned();
        if id.is_empty() {
            id = self.new_id();
        }
        let next = Member {
            id: id.clone(),
            run_id: g.runs[ri].id.clone(),
            role: old.role.clone(),
            agent: old.agent.clone(),
            brief: old.brief.clone(),
            tool_id: spec.tool_id,
            tab_id: spec.tab_id,
            headless: spec.headless,
            worktree: old.worktree.clone(),
            state: STARTING.to_owned(),
            succeeded_from: old.id.clone(),
            assign: old.assign.clone(),
            created_at: self.now(),
            ..Member::default()
        };
        let old_id = old.id.clone();
        let has_assign = old.assign.is_some();
        let old = &mut g.runs[ri].members[mi];
        old.state = SUCCEEDED.to_owned();
        old.succeeded_by.clone_from(&id);
        let sum = spec.summary.trim();
        if sum.is_empty() {
            old.handoff_pending = spec.handoff_asked;
        } else {
            old.handoff_summary = sum.to_owned();
            old.handoff_pending = false;
        }
        let prev = old.clone();
        let tree = g.runs[ri].tree.clone();
        if has_assign && !tree.is_empty() {
            let open: Vec<usize> = g
                .runs
                .iter()
                .enumerate()
                .filter(|(_, r)| r.state == OPEN && r.tree == tree)
                .map(|(i, _)| i)
                .collect();
            for i in open {
                for m in &mut g.runs[i].members {
                    if let Some(a) = m.assign.as_mut().filter(|a| a.parent == old_id) {
                        a.parent.clone_from(&id);
                    }
                }
            }
        }
        g.runs[ri].members.push(next.clone());
        self.save(&mut g)?;
        Ok((prev, next))
    }

    /// 멤버가 남기는 인수인계 요약 (FR-CBG-9).
    pub fn handoff(
        &self,
        sender_tool_id: &str,
        claimed_member_id: &str,
        summary: &str,
    ) -> Result<Member, Error> {
        if summary.trim().is_empty() {
            return Err(Error::invalid(
                "summary 는 비어 있을 수 없다 — 후임이 먼저 읽는 것이다",
            ));
        }
        let mut g = self.lock();
        let (ri, mi) = sender_member(&g.runs, sender_tool_id)?;
        let m = &mut g.runs[ri].members[mi];
        if !claimed_member_id.is_empty() && claimed_member_id != m.id {
            return Err(Error::RunMemberMismatch);
        }
        m.handoff_summary = summary.trim().to_owned();
        m.handoff_pending = false;
        let out = m.clone();
        self.save(&mut g)?;
        Ok(out)
    }

    fn open_predecessor(runs: &[Record], member_id: &str) -> Option<(usize, usize)> {
        let (ri, mi) = index_of_member(runs, member_id)?;
        if runs[ri].state != OPEN {
            return None;
        }
        runs[ri]
            .predecessor_index(&runs[ri].members[mi])
            .map(|pi| (ri, pi))
    }

    /// 이 멤버가 앞선 멤버의 인수인계를 기다리는 중인가.
    pub fn handoff_waiting(&self, member_id: &str) -> bool {
        let g = self.lock();
        Self::open_predecessor(&g.runs, member_id).is_some_and(|(ri, pi)| {
            let p = &g.runs[ri].members[pi];
            p.handoff_pending && p.handoff_summary.trim().is_empty()
        })
    }

    /// 인수인계 기다림을 접는다.
    pub fn give_up_handoff(&self, member_id: &str) {
        let mut g = self.lock();
        let Some((ri, pi)) = Self::open_predecessor(&g.runs, member_id) else {
            return;
        };
        let p = &mut g.runs[ri].members[pi];
        if !p.handoff_pending {
            return;
        }
        p.handoff_pending = false;
        let _ = self.save(&mut g);
    }
}

/// 승계 멤버의 프리앰블에 붙는 인수인계 절 (FR-CBG-9). 승계가 아니면 빈 값이다.
pub fn handoff_clause(rec: &Record, m: &Member) -> String {
    if m.succeeded_from.is_empty() {
        return String::new();
    }
    let summary = rec
        .predecessor_index(m)
        .map(|pi| rec.members[pi].handoff_summary.trim().to_owned())
        .unwrap_or_default();
    let mut b = String::new();
    let mut w = |s: &str| {
        let _ = writeln!(b, "{s}");
    };
    w("[인수인계] 이것은 **승계**다. 너는 앞선 멤버가 하던 일을 이어받는다.");
    w(&format!("  이전 멤버 {}", m.succeeded_from));
    if summary.is_empty() {
        w("  요약 없음 — 이전 멤버가 인수인계를 남기지 못했다. 작업 트리와 저장소");
        w("  기록에서 현재 상태를 직접 확인하고 시작해라. 진행 상황을 추측하지 마라.");
    } else {
        w("");
        w(&summary);
    }
    if m.worktree.as_ref().is_some_and(|w| !w.path.is_empty()) {
        w("");
        w("  작업 트리는 새로 만들지 않았다 — 이전 멤버가 쓰던 그 트리다.");
        w("  진행 중이던 변경이 그대로 있으니 먼저 읽어라.");
    }
    b
}
