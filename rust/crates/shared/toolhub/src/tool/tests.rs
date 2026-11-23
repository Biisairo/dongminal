use std::sync::Mutex as StdMutex;

use super::*;
use crate::ATTN_WORKING_STALE;

#[derive(Default)]
struct Log {
    attn: StdMutex<Vec<String>>,
    clear: StdMutex<Vec<String>>,
}

impl Log {
    fn attn(&self) -> Vec<String> {
        self.attn.lock().unwrap().clone()
    }
    fn clear(&self) -> Vec<String> {
        self.clear.lock().unwrap().clone()
    }
}

fn attn_pane(id: &str) -> (Arc<Tool>, Arc<Log>) {
    let log = Arc::new(Log::default());
    let (a, c) = (Arc::clone(&log), Arc::clone(&log));
    let p = Tool::new_detached(
        id,
        Some(ToolHooks {
            on_attention: Some(Arc::new(move |pid, reason| {
                a.attn.lock().unwrap().push(format!("{pid}:{reason}"))
            })),
            on_attention_clear: Some(Arc::new(move |pid| {
                c.clear.lock().unwrap().push(pid.to_string())
            })),
            ..Default::default()
        }),
    );
    (p, log)
}

/// Go `SetActivity` 를 `attnNow()=at` 으로 부른 것과 같다(전역 시계를 바꾸지 않는다).
fn set_activity_at(p: &Tool, state: &str, at: i64) {
    p.set_activity(state, "Bash", "make");
    if let Some(a) = lock(&p.activity).as_mut() {
        a.updated_at = at;
    }
}

fn start_stale_work(p: &Tool) {
    set_activity_at(p, "working", -ATTN_WORKING_STALE);
}

fn start_turn(p: &Tool) {
    p.turn.note_activity(activity::WORKING);
}

fn arm(p: &Tool) {
    p.last_output_at.store(0, SeqCst);
    p.attn_armed.store(true, SeqCst);
}

const TH: i64 = 1000;

fn idle(p: &Tool, now: i64, busy: bool) {
    p.maybe_idle_with(now, TH, |_| busy);
}

#[test]
fn maybe_idle_fires_once_per_quiet_edge() {
    let (p, log) = attn_pane("1");
    start_stale_work(&p);
    arm(&p);
    idle(&p, TH - 1, true);
    assert!(log.attn().is_empty());
    idle(&p, TH, true);
    idle(&p, TH + 5, true);
    assert_eq!(log.attn(), ["1:idle"]);
    p.clear_attention();
    p.observe_output_at(b"x", TH + 5);
    idle(&p, TH + 5 + TH, true);
    assert_eq!(log.attn().len(), 2);
}

#[test]
fn maybe_idle_gates() {
    let (p, log) = attn_pane("1");
    p.maybe_idle_with(1_000_000, TH, |_| true);
    assert!(log.attn().is_empty(), "무장하지 않은 도구");

    let (p, log) = attn_pane("1");
    start_stale_work(&p);
    arm(&p);
    idle(&p, TH + 1, false);
    assert!(log.attn().is_empty(), "바쁘지 않은 도구");

    let (p, log) = attn_pane("1");
    p.attn_armed.store(true, SeqCst);
    p.maybe_idle_with(1_000_000, 0, |_| true);
    assert!(log.attn().is_empty(), "임계값 0");

    let (p, log) = attn_pane("plain");
    arm(&p);
    idle(&p, TH + 1, true);
    assert!(log.attn().is_empty(), "에이전트가 아닌 도구");

    let (p, log) = attn_pane("agent");
    start_stale_work(&p);
    p.set_activity("ended", "", "");
    arm(&p);
    idle(&p, TH + 1, true);
    assert!(log.attn().is_empty(), "세션이 끝난 도구");
}

#[test]
fn maybe_idle_suppressed_while_working() {
    let (p, log) = attn_pane("1");
    arm(&p);
    set_activity_at(&p, "working", 0);
    idle(&p, TH + 1, true);
    assert!(log.attn().is_empty());
    p.set_activity("waiting", "", "");
    arm(&p);
    idle(&p, TH + 1, true);
    assert_eq!(log.attn(), ["1:idle"]);
    p.clear_attention();
    p.set_activity("done", "", "");
    arm(&p);
    idle(&p, TH + 1, true);
    assert_eq!(log.attn().len(), 1);
}

#[test]
fn maybe_idle_agent_tool_fires_on_idle_or_waiting() {
    for state in ["idle", "waiting"] {
        let (p, log) = attn_pane("agent");
        start_stale_work(&p);
        p.set_activity(state, "", "");
        arm(&p);
        idle(&p, TH + 1, true);
        assert_eq!(log.attn(), ["agent:idle"], "{state}");
    }
}

#[test]
fn maybe_idle_stale_working_does_not_suppress() {
    let (p, log) = attn_pane("agent");
    set_activity_at(&p, "working", 0);
    arm(&p);
    idle(&p, TH + 1, true);
    assert!(log.attn().is_empty());
    p.attn_armed.store(true, SeqCst);
    idle(&p, ATTN_WORKING_STALE + 1, true);
    assert_eq!(log.attn(), ["agent:idle"]);

    let (p, log) = attn_pane("agent");
    set_activity_at(&p, "working", 0);
    p.set_activity("done", "", "");
    arm(&p);
    idle(&p, ATTN_WORKING_STALE + 1, true);
    assert!(log.attn().is_empty(), "종결 뒤의 정적");
}

#[test]
fn rearm_requires_user_input() {
    let (p, log) = attn_pane("agent");
    start_stale_work(&p);
    arm(&p);
    idle(&p, TH, true);
    assert_eq!(log.attn().len(), 1);
    p.attend();
    p.observe_output_at(b"tui redraw", TH + 1);
    assert!(!p.attn_armed.load(SeqCst));
    idle(&p, TH + 1 + TH, true);
    assert_eq!(log.attn().len(), 1);
    p.attend_typed();
    p.observe_output_at(b"agent works", TH + 2);
    assert!(p.attn_armed.load(SeqCst));
    idle(&p, TH + 2 + TH, true);
    assert_eq!(log.attn().len(), 2);
}

#[test]
fn rearm_lock_does_not_silence_l1() {
    let (p, log) = attn_pane("agent");
    p.attend();
    p.observe_output_at(b"\x1b]9;done\x07", 1);
    assert_eq!(log.attn(), ["agent:signaled"]);
    p.clear_attention();
    start_turn(&p);
    p.signal_attention("done");
    assert_eq!(log.attn(), ["agent:signaled", "agent:done"]);
}

#[test]
fn set_attention_edge_only_and_attend_clears_once() {
    let (p, log) = attn_pane("2");
    assert!(p.set_attention("signaled"));
    assert!(!p.set_attention("signaled"));
    assert_eq!(log.attn().len(), 1);

    let (p, log) = attn_pane("3");
    p.set_attention("idle");
    p.attn_armed.store(true, SeqCst);
    p.attend();
    assert_eq!(log.clear(), ["3"]);
    assert!(!p.attention() && !p.attn_armed.load(SeqCst));
    p.attend();
    assert_eq!(log.clear().len(), 1);
}

#[test]
fn kill_cleans_attention() {
    let (p, log) = attn_pane("1");
    start_turn(&p);
    p.signal_attention("done");
    assert!(p.attention());
    p.kill();
    p.kill();
    assert!(!p.attention());
    assert_eq!(log.clear(), ["1"]);
    assert!(p.done().is_cancelled());

    let (p, log) = attn_pane("1");
    p.kill();
    assert!(log.clear().is_empty(), "주의가 없었는데 해제");

    let (p, log) = attn_pane("1");
    p.observe_output_at(b"x", 0);
    p.kill();
    p.maybe_idle_with(10_000, 1_000, |_| true);
    assert!(log.attn().is_empty(), "죽은 도구의 idle");

    let (p, _) = attn_pane("agent");
    p.attend();
    assert!(p.attn_rearm_locked.load(SeqCst));
    p.kill();
    assert!(!p.attn_rearm_locked.load(SeqCst));
}

const CLAUDE_IDLE_OSC: &str = "\x1b]777;notify;Claude Code;Claude is waiting for your input\x07";

#[test]
fn agent_osc_rules() {
    let (p, log) = attn_pane("agent");
    start_turn(&p);
    p.set_activity("working", "", "");
    p.set_activity("done", "", "");
    p.observe_output_at(CLAUDE_IDLE_OSC.as_bytes(), 1);
    assert!(log.attn().is_empty() && !p.attention());

    let (p, log) = attn_pane("plain");
    p.observe_output_at(CLAUDE_IDLE_OSC.as_bytes(), 1);
    assert_eq!(log.attn(), ["plain:signaled"]);

    let (p, log) = attn_pane("agent");
    p.set_activity("working", "", "");
    p.set_activity("ended", "", "");
    p.observe_output_at(CLAUDE_IDLE_OSC.as_bytes(), 1);
    assert_eq!(log.attn(), ["agent:signaled"]);

    let (p, log) = attn_pane("agent");
    let half = CLAUDE_IDLE_OSC.len() / 2;
    p.set_activity("working", "", "");
    p.observe_output_at(&CLAUDE_IDLE_OSC.as_bytes()[..half], 1);
    p.set_activity("ended", "", "");
    p.observe_output_at(&CLAUDE_IDLE_OSC.as_bytes()[half..], 2);
    assert_eq!(log.attn(), ["agent:signaled"], "이월이 버려졌다");
}

#[test]
fn signal_rules() {
    let (p, log) = attn_pane("agent");
    p.set_activity("working", "Bash", "make");
    p.signal_attention("done");
    assert_eq!(log.attn(), ["agent:done"]);
    assert!(p.attention());
    start_turn(&p);
    p.set_activity("working", "Bash", "make");
    p.signal_attention("done");
    assert_eq!(log.attn().len(), 2);

    let (p, log) = attn_pane("agent");
    start_turn(&p);
    p.signal_attention("done");
    p.clear_attention();
    for _ in 0..4 {
        p.set_activity("working", "Bash", "");
        p.signal_attention("done");
    }
    assert_eq!(log.attn().len(), 5);

    let (p, log) = attn_pane("fresh");
    p.set_activity("idle", "", "startup");
    p.signal_attention("waiting");
    assert!(log.attn().is_empty());
    let (q, log) = attn_pane("busy");
    q.set_activity("working", "Bash", "rm -rf");
    q.signal_attention("waiting");
    assert_eq!(log.attn(), ["busy:waiting"]);
    let (r, log) = attn_pane("settled");
    r.set_activity("working", "Bash", "");
    r.set_activity("done", "", "");
    r.signal_attention("waiting");
    assert!(log.attn().is_empty());

    let (p, log) = attn_pane("agent");
    p.signal_attention("codex");
    p.clear_attention();
    p.observe_output_at(b"\x1b]9;done\x07", 1);
    assert_eq!(log.attn(), ["agent:codex", "agent:signaled"]);
}

#[test]
fn report_activity() {
    let fired = Arc::new(StdMutex::new(Vec::<String>::new()));
    let f = Arc::clone(&fired);
    let p = Tool::new_detached(
        "r1",
        Some(ToolHooks {
            on_attention: Some(Arc::new(move |_, r| f.lock().unwrap().push(r.to_string()))),
            ..Default::default()
        }),
    );
    p.report_activity(activity::WORKING, "Bash", "ls", true);
    let a = p.activity().unwrap();
    assert_eq!(
        (a.state.as_str(), a.tool.as_str()),
        (activity::WORKING, "Bash")
    );
    p.report_activity(activity::DONE, "", "", true);
    assert!(p.attention());
    assert_eq!(*fired.lock().unwrap(), [activity::DONE]);

    let p = Tool::new_detached("r2", None);
    p.report_activity(activity::WORKING, "", "", true);
    assert!(!p.attention() && p.agent_state().agent_seen);
    p.report_activity(activity::ENDED, "", "", true);
    assert!(p.activity().is_none() && !p.agent_state().agent_seen);
}

#[test]
fn agent_state_round_trip() {
    let src = Tool::new_detached("a", None);
    src.set_activity(activity::WORKING, "Bash", "ls");
    start_turn(&src);
    src.signal_attention(activity::WAITING);
    src.attend();
    src.last_output_at.store(42, SeqCst);
    let st = src.agent_state();
    assert!(st.agent_seen && st.turn.turn_ran && st.turn.in_progress && st.turn.waiting_signaled);
    assert!(!st.attention && !st.armed && st.rearm_locked && st.last_output_at == 42);

    let dst = Tool::new_detached("b", None);
    dst.last_output_at.store(7, SeqCst);
    dst.restore_agent_state(&st);
    let mut want = st.clone();
    want.last_output_at = 7;
    assert_eq!(
        dm_gocompat::json::marshal(&dst.agent_state()).unwrap(),
        dm_gocompat::json::marshal(&want).unwrap()
    );
    assert!(dst.turn.allow_signal(activity::DONE) && !dst.turn.allow_signal(activity::DONE));
}

#[test]
fn restore_agent_state_no_notify() {
    let calls = Arc::new(AtomicI64::new(0));
    let (a, b, c) = (Arc::clone(&calls), Arc::clone(&calls), Arc::clone(&calls));
    let p = Tool::new_detached(
        "a",
        Some(ToolHooks {
            on_attention: Some(Arc::new(move |_, _| {
                a.fetch_add(1, SeqCst);
            })),
            on_attention_clear: Some(Arc::new(move |_| {
                b.fetch_add(1, SeqCst);
            })),
            on_activity: Some(Arc::new(move |_, _, _, _| {
                c.fetch_add(1, SeqCst);
            })),
            ..Default::default()
        }),
    );
    p.restore_agent_state(&AgentState {
        attention: true,
        activity: Some(ActivityState {
            state: activity::DONE.into(),
            ..Default::default()
        }),
        ..Default::default()
    });
    assert_eq!(calls.load(SeqCst), 0);
    assert!(p.attention() && p.activity().unwrap().state == activity::DONE);
}

#[test]
fn records_set_delete_copy() {
    let p = Tool::new_detached("a", None);
    assert!(p.records().is_empty());
    p.set_record("usage", br#"{"x":1}"#);
    p.set_record("subagents", b"[1]");
    p.set_record("subagents", b"");
    p.set_record("usage", b"null");
    p.set_record("migrationTold", b"true");
    let mut r = p.records();
    assert_eq!(r.len(), 1);
    assert_eq!(r["migrationTold"].0, b"true");
    r.insert("migrationTold".into(), RawMessage(b"false".to_vec()));
    assert_eq!(p.records()["migrationTold"].0, b"true");
}

#[test]
fn cwd_report_and_modes_on_detached() {
    let p = Tool::new_detached("t1", None);
    p.observe_output(b"\x1b]777;Cwd;/known\x07");
    p.observe_output(b"\x1b]777;Cwd;\x07");
    assert_eq!(p.cwd(), "/known");
    p.observe_modes(b"\x1b[?2004h");
    assert!(p.bracketed_paste());
    p.observe_modes(b"\x1b[?20");
    p.observe_modes(b"04l");
    assert!(!p.bracketed_paste());
}

#[test]
fn detached_tool_has_no_terminal() {
    let p = Tool::new_detached("d", None);
    assert_eq!(p.cmd_process_pid(), 0);
    assert!(p.size().is_none());
    assert!(p.write(b"x").is_err());
    assert_eq!(
        p.resize(1, 1).unwrap_err().to_string(),
        "tool d: 터미널이 없다"
    );
    assert!(!p.freeze());
    assert!(!p.is_busy());
    assert_eq!(p.exit_info().to_string(), "");
}
