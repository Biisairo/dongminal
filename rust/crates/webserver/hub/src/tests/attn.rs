use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use dm_shared_activity as activity;
use dm_shared_toolhub::{ATTN_WORKING_STALE, ActivityState, AgentState, TurnState};
use dm_shared_toolipc::{ATTN_KIND_ACTIVITY, ATTN_KIND_ATTENTION, ATTN_KIND_CLEAR, AttnEvent};

use super::FakeBroker;
use crate::*;

fn busy_all(b: bool) -> BusyManyProbe {
    Arc::new(move |ids: &[String]| Some(ids.iter().map(|i| (i.clone(), b)).collect()))
}

fn clock(v: i64) -> Option<Clock> {
    Some(Arc::new(move || v))
}

fn firing(idle_ms: i64) -> (Arc<AttnTracker>, Arc<FakeBroker>) {
    let fb = FakeBroker::new();
    let tr = AttnTracker::new(fb.clone(), idle_ms);
    tr.set_busy_probe(Some(busy_all(true)));
    (tr, fb)
}

/// L2 가 발화할 최소 전제 — 턴이 진행 중이고 그 `working` 보고는 이미 굳었다.
fn start_stale_work(tr: &AttnTracker, id: &str) {
    tr.set_clock_for_testing(clock(-ATTN_WORKING_STALE));
    tr.set_activity(id, "working", "Bash", "make");
    tr.set_clock_for_testing(clock(0));
}

fn fired(fb: &FakeBroker, id: &str, reason: &str) -> usize {
    fb.sent()
        .iter()
        .filter(|p| {
            p.contains(r#""action":"tool_attention""#)
                && p.contains(&format!(r#""toolId":"{id}""#))
                && p.contains(&format!(r#""reason":"{reason}""#))
        })
        .count()
}

fn count(fb: &FakeBroker, sub: &str) -> usize {
    fb.sent().iter().filter(|p| p.contains(sub)).count()
}

const MS: i64 = 1_000_000;

#[test]
fn idle_only_agent_tools() {
    let (tr, fb) = firing(1000);
    tr.set_clock_for_testing(clock(0));
    tr.feed_output("plain", b"x");
    tr.sweep_idle_at(2_000 * MS);
    assert_eq!(fired(&fb, "plain", "idle"), 0);
}

#[test]
fn idle_agent_tool_fires_and_ended_revokes() {
    let (tr, fb) = firing(1000);
    tr.set_clock_for_testing(clock(0));
    start_stale_work(&tr, "agent");
    tr.feed_output("agent", b"x");
    tr.sweep_idle_at(2_000 * MS);
    assert_eq!(fired(&fb, "agent", "idle"), 1);

    let (tr, fb) = firing(1000);
    tr.set_clock_for_testing(clock(0));
    start_stale_work(&tr, "agent");
    tr.set_activity("agent", "ended", "", "");
    tr.feed_output("agent", b"x");
    tr.sweep_idle_at(2_000 * MS);
    assert_eq!(fired(&fb, "agent", "idle"), 0, "세션이 끝난 도구가 울었다");
}

#[test]
fn rearm_requires_user_input() {
    let (tr, fb) = firing(1000);
    tr.set_clock_for_testing(clock(0));
    start_stale_work(&tr, "agent");
    tr.feed_output("agent", b"x");
    tr.sweep_idle_at(2_000 * MS);
    assert_eq!(fired(&fb, "agent", "idle"), 1);
    tr.attend("agent");
    tr.feed_output("agent", b"tui redraw");
    tr.sweep_idle_at(4_000 * MS);
    assert_eq!(
        fired(&fb, "agent", "idle"),
        1,
        "주목 뒤 출력만으로 다시 울었다"
    );
    tr.attend_typed("agent");
    tr.feed_output("agent", b"agent works");
    tr.sweep_idle_at(6_000 * MS);
    assert_eq!(
        fired(&fb, "agent", "idle"),
        2,
        "입력 뒤 정적에서 울지 않았다"
    );
}

#[test]
fn rearm_lock_does_not_silence_l1() {
    let (tr, fb) = firing(1000);
    tr.attend("agent");
    tr.feed_output("agent", b"\x1b]9;done\x07");
    assert_eq!(fired(&fb, "agent", "signaled"), 1);
}

#[test]
fn idle_stale_working_does_not_suppress() {
    let (tr, fb) = firing(1000);
    tr.set_clock_for_testing(clock(0));
    tr.set_activity("agent", "working", "Bash", "make");
    tr.feed_output("agent", b"x");
    tr.sweep_idle_at(2_000 * MS);
    assert_eq!(
        fired(&fb, "agent", "idle"),
        0,
        "신선한 working 이 억제되지 않았다"
    );
    tr.feed_output("agent", b"x");
    tr.sweep_idle_at(ATTN_WORKING_STALE + 1);
    assert_eq!(
        fired(&fb, "agent", "idle"),
        1,
        "굳은 working 이 알람을 막았다"
    );
}

#[test]
fn forget_drops_rearm_lock() {
    let (tr, fb) = firing(1000);
    tr.set_clock_for_testing(clock(0));
    start_stale_work(&tr, "agent");
    tr.attend("agent");
    tr.forget("agent");
    start_stale_work(&tr, "agent");
    tr.feed_output("agent", b"x");
    tr.sweep_idle_at(2_000 * MS);
    assert_eq!(fired(&fb, "agent", "idle"), 1);
}

#[test]
fn clear_all_does_not_resurrect() {
    let (tr, fb) = firing(1000);
    tr.set_clock_for_testing(clock(0));
    start_stale_work(&tr, "agent");
    tr.feed_output("agent", b"x");
    tr.sweep_idle_at(2_000 * MS);
    assert_eq!(fired(&fb, "agent", "idle"), 1);
    assert_eq!(tr.clear_all_attention(), 1);
    tr.sweep_idle_at(4_000 * MS);
    assert!(!tr.attention("agent"));
    tr.feed_output("agent", b"tui redraw");
    tr.sweep_idle_at(6_000 * MS);
    assert!(!tr.attention("agent"));
}

#[test]
fn clear_all_broadcasts_outside_lock() {
    let fb = FakeBroker::new();
    let tr = AttnTracker::new(fb.clone(), 1000);
    let weak = Arc::downgrade(&tr);
    *crate::lock(&fb.on_broadcast) = Some(Box::new(move || {
        if let Some(t) = weak.upgrade() {
            t.attention("agent");
        }
    }));
    tr.set_busy_probe(Some(busy_all(true)));
    tr.set_clock_for_testing(clock(0));
    start_stale_work(&tr, "agent");
    tr.feed_output("agent", b"x");
    tr.sweep_idle_at(2_000 * MS);
    assert!(tr.attention("agent"));
    let (tx, rx) = std::sync::mpsc::channel();
    let t2 = tr.clone();
    std::thread::spawn(move || tx.send(t2.clear_all_attention()));
    assert_eq!(rx.recv_timeout(Duration::from_secs(3)).unwrap(), 1);
}

#[test]
fn attention_clear_broadcasts() {
    let (tr, fb) = firing(0);
    tr.signal_attention("t", "");
    assert_eq!(fired(&fb, "t", "signaled"), 1);
    tr.signal_attention("t", "x");
    tr.attend("t");
    assert_eq!(count(&fb, "tool_attention_clear"), 1);
    tr.attend("t");
    assert_eq!(
        count(&fb, "tool_attention_clear"),
        1,
        "두 번째 주목은 조용하다"
    );
    tr.signal_attention("t", "x");
    tr.attend_typed("t");
    assert_eq!(count(&fb, "tool_attention_clear"), 2);
    tr.signal_attention("a", "x");
    tr.signal_attention("b", "x");
    assert_eq!(tr.clear_all_attention(), 2);
    assert_eq!(count(&fb, "tool_attention_clear"), 4);
}

#[test]
fn forget_clears_edge_and_notifies_gone() {
    let hub = CommandHub::new();
    let gone = Arc::new(Mutex::new(Vec::<String>::new()));
    let g2 = gone.clone();
    hub.set_tool_gone_observer(Some(Arc::new(move |id: &str| {
        crate::lock(&g2).push(id.to_owned());
    })));
    let cleared = Arc::new(AtomicUsize::new(0));
    let c2 = cleared.clone();
    hub.set_attention_clear_observer(Some(Arc::new(move |_: &str| {
        c2.fetch_add(1, Ordering::SeqCst);
    })));
    let attn = Arc::new(Mutex::new(Vec::<String>::new()));
    let a2 = attn.clone();
    hub.set_attention_observer(Some(Arc::new(move |id: &str, r: &str| {
        crate::lock(&a2).push(format!("{id}:{r}"));
    })));
    let tr = AttnTracker::new(hub.clone(), 0);
    tr.signal_attention("t", "x");
    assert_eq!(*crate::lock(&attn), vec!["t:x"]);
    tr.forget("t");
    assert!(!tr.attention("t"));
    assert_eq!(cleared.load(Ordering::SeqCst), 1);
    tr.forget("t");
    tr.forget("unknown");
    assert_eq!(cleared.load(Ordering::SeqCst), 1, "가장자리에서만 해제한다");
    assert_eq!(*crate::lock(&gone), vec!["t", "t", "unknown"]);
}

#[test]
fn attention_ids_filters_dead_tools() {
    let (tr, _) = firing(0);
    tr.signal_attention("live", "x");
    tr.signal_attention("dead", "x");
    let mut ids = tr.attention_ids();
    ids.sort();
    assert_eq!(ids, vec!["dead", "live"]);
    tr.set_live_probe(Some(Arc::new(|id: &str| id == "live")));
    assert_eq!(tr.attention_ids(), vec!["live"]);
}

#[test]
fn activity_snapshot_one_probe() {
    let fb = FakeBroker::new();
    let tr = AttnTracker::new(fb, 0);
    assert!(tr.activity_snapshot().is_empty());
    tr.set_activity("w1", "working", "", "");
    tr.set_activity("w2", "working", "", "");
    tr.set_activity("d", "done", "", "");
    let calls = Arc::new(AtomicUsize::new(0));
    let c2 = calls.clone();
    tr.set_busy_probe(Some(Arc::new(move |ids: &[String]| {
        c2.fetch_add(1, Ordering::SeqCst);
        Some(ids.iter().map(|i| (i.clone(), i == "w1")).collect())
    })));
    let mut ids: Vec<String> = tr
        .activity_snapshot()
        .into_iter()
        .map(|s| s.tool_id)
        .collect();
    ids.sort();
    assert_eq!(ids, vec!["d", "w1"]);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    tr.set_busy_probe(Some(Arc::new(|_: &[String]| None)));
    assert_eq!(tr.activity_snapshot().len(), 3, "모르면 working 을 남긴다");
    tr.set_activity("w1", "ended", "", "");
    tr.set_activity("w2", "ended", "", "");
    let c3 = Arc::new(AtomicUsize::new(0));
    let c4 = c3.clone();
    tr.set_busy_probe(Some(Arc::new(move |_: &[String]| {
        c4.fetch_add(1, Ordering::SeqCst);
        None
    })));
    assert_eq!(tr.activity_snapshot().len(), 1);
    assert_eq!(
        c3.load(Ordering::SeqCst),
        0,
        "working 이 없으면 묻지 않는다"
    );
}

#[test]
fn sweep_one_probe_and_unknown_holds() {
    let (tr, fb) = firing(1000);
    tr.set_clock_for_testing(clock(0));
    let calls = Arc::new(AtomicUsize::new(0));
    let answer = Arc::new(AtomicBool::new(false));
    let (c2, a2) = (calls.clone(), answer.clone());
    tr.set_busy_probe(Some(Arc::new(move |ids: &[String]| {
        c2.fetch_add(1, Ordering::SeqCst);
        a2.load(Ordering::SeqCst)
            .then(|| ids.iter().map(|i| (i.clone(), true)).collect())
    })));
    for id in ["a", "b"] {
        start_stale_work(&tr, id);
        tr.feed_output(id, b"x");
    }
    tr.sweep_idle_at(2_000 * MS);
    assert_eq!(
        calls.load(Ordering::SeqCst),
        1,
        "후보 전부를 한 번에 묻는다"
    );
    assert!(!tr.attention("a"), "모르면 울지 않는다");
    answer.store(true, Ordering::SeqCst);
    tr.sweep_idle_at(3_000 * MS);
    assert!(
        tr.attention("a") && tr.attention("b"),
        "무장을 되돌려 다음 패스에 판정한다"
    );
    assert_eq!(fired(&fb, "a", "idle"), 1);
    tr.sweep_idle_at(4_000 * MS);
    assert_eq!(calls.load(Ordering::SeqCst), 2, "후보가 없으면 묻지 않는다");
}

#[test]
fn bell_follows_setting() {
    let (tr, fb) = firing(0);
    tr.feed_output("t", b"\x07");
    assert_eq!(
        fired(&fb, "t", "signaled"),
        0,
        "맨 BEL 은 기본으로 알람이 아니다"
    );
}

#[test]
fn agent_osc_does_not_fire_but_plain_does() {
    let (tr, fb) = firing(0);
    tr.set_activity("agent", "working", "", "");
    tr.feed_output("agent", b"\x1b]9;hi\x07");
    assert_eq!(fired(&fb, "agent", "signaled"), 0);
    tr.feed_output("plain", b"\x1b]9;hi\x07");
    assert_eq!(fired(&fb, "plain", "signaled"), 1);
    tr.set_activity("agent", "ended", "", "");
    tr.feed_output("agent", b"\x1b]9;hi\x07");
    assert_eq!(fired(&fb, "agent", "signaled"), 1, "ended 뒤 OSC 는 운다");
    // 나뉜 시퀀스는 이월로 잇는다.
    tr.feed_output("split", b"\x1b]9;h");
    tr.feed_output("split", b"i\x07");
    assert_eq!(fired(&fb, "split", "signaled"), 1);
}

fn start_turn(tr: &AttnTracker, id: &str) {
    // Go 시험의 startTurn(내부 접근)과 같은 표시: working 보고 뒤 카드만 되돌린다.
    let mut st = tr.agent_state_of(id);
    st.turn.in_progress = true;
    st.turn.turn_ran = true;
    tr.restore(id, &st);
}

#[test]
fn signal_turn_gates() {
    let (tr, fb) = firing(1000);
    tr.set_activity("agent", "working", "Bash", "make");
    tr.signal_attention("agent", "done");
    assert_eq!(fired(&fb, "agent", "done"), 1);
    assert!(tr.attention("agent"));
    start_turn(&tr, "agent");
    tr.set_activity("agent", "working", "Bash", "make");
    tr.signal_attention("agent", "done");
    assert_eq!(fired(&fb, "agent", "done"), 2);

    tr.set_activity("fresh", "idle", "", "startup");
    tr.signal_attention("fresh", "waiting");
    assert_eq!(fired(&fb, "fresh", "waiting"), 0);
    tr.set_activity("busy", "working", "Bash", "rm -rf");
    tr.signal_attention("busy", "waiting");
    assert_eq!(fired(&fb, "busy", "waiting"), 1);
    tr.set_activity("settled", "working", "Bash", "");
    tr.set_activity("settled", "done", "", "");
    tr.signal_attention("settled", "waiting");
    assert_eq!(fired(&fb, "settled", "waiting"), 0);
    tr.signal_attention("x", "codex");
    assert_eq!(fired(&fb, "x", "codex"), 1);
}

#[test]
fn agent_event_rules() {
    let (tr, _) = firing(0);
    tr.set_activity("1", "working", "", "");
    tr.signal_agent_event("1", "done", true);
    assert!(tr.attention("1"));
    tr.signal_agent_event("2", "done", false);
    assert!(tr.attention("2"), "턴 출처를 모르면 언제나 운다 (FR-CBG-5)");
    tr.signal_agent_event("3", "waiting", true);
    assert!(!tr.attention("3"));
    tr.set_activity("3", "working", "", "");
    tr.signal_agent_event("3", "waiting", true);
    assert!(tr.attention("3"));
    tr.attend("3");
    tr.signal_agent_event("3", "waiting", true);
    assert!(!tr.attention("3"), "같은 대기가 두 번 울었다 (FR-ATN-15)");
}

type Log = Arc<Mutex<HashMap<String, Vec<AgentState>>>>;

fn change_log(tr: &AttnTracker) -> Log {
    let log: Log = Default::default();
    let l2 = log.clone();
    tr.set_on_change(Some(Arc::new(move |id: &str, st: AgentState| {
        crate::lock(&l2).entry(id.to_owned()).or_default().push(st);
    })));
    log
}

fn last_of(log: &Log, id: &str) -> AgentState {
    crate::lock(log)
        .get(id)
        .and_then(|v| v.last().cloned())
        .expect("변화 알림이 없다")
}

#[test]
fn on_change_carries_judged_state() {
    let tr = AttnTracker::new(FakeBroker::new(), 0);
    let log = change_log(&tr);
    tr.set_activity("t1", activity::WORKING, "Bash", "ls");
    let st = last_of(&log, "t1");
    assert!(st.activity.as_ref().is_some_and(|a| a.tool == "Bash"));
    assert!(st.agent_seen && st.turn.in_progress && st.turn.turn_ran);
    tr.signal_attention("t1", activity::DONE);
    let st = last_of(&log, "t1");
    assert!(st.attention && !st.turn.turn_ran);
    tr.attend("t1");
    let st = last_of(&log, "t1");
    assert!(!st.attention && st.rearm_locked);
    tr.attend_typed("t1");
    assert!(!last_of(&log, "t1").rearm_locked);
    tr.signal_agent_event("t1", activity::DONE, false);
    assert!(last_of(&log, "t1").attention);
    let n = crate::lock(&log)["t1"].len();
    tr.clear_all_attention();
    assert_eq!(crate::lock(&log)["t1"].len(), n + 1);
    assert!(!last_of(&log, "t1").attention);
}

#[test]
fn on_change_feed_output_only_on_signal_and_sweep_disarm() {
    let tr = AttnTracker::new(FakeBroker::new(), 1000);
    let log = change_log(&tr);
    tr.feed_output("t1", b"plain");
    assert!(!crate::lock(&log).contains_key("t1"));
    tr.feed_output("t1", b"\x1b]9;hi\x07");
    assert!(last_of(&log, "t1").attention);

    tr.set_busy_probe(Some(busy_all(true)));
    tr.feed_output("t2", b"x");
    tr.sweep_idle_at(tr.last_output_at("t2") + 2_000 * MS);
    assert!(!last_of(&log, "t2").armed);
}

#[test]
fn restore_all_silent_and_restore_one() {
    let fb = FakeBroker::new();
    let tr = AttnTracker::new(fb.clone(), 0);
    let log = change_log(&tr);
    tr.set_activity("gone", activity::WORKING, "", "");
    tr.set_activity("same", activity::WAITING, "", "");
    let before = fb.count();
    let n_changes = crate::lock(&log).values().map(Vec::len).sum::<usize>();
    let states = HashMap::from([
        (
            "t1".to_owned(),
            AgentState {
                activity: Some(ActivityState {
                    state: activity::WORKING.into(),
                    tool: "Bash".into(),
                    updated_at: 9,
                    ..Default::default()
                }),
                agent_seen: true,
                attention: true,
                last_output_at: 77,
                turn: TurnState {
                    in_progress: true,
                    ..Default::default()
                },
                ..Default::default()
            },
        ),
        (
            "same".to_owned(),
            AgentState {
                activity: Some(ActivityState {
                    state: activity::WAITING.into(),
                    ..Default::default()
                }),
                agent_seen: true,
                ..Default::default()
            },
        ),
    ]);
    tr.restore_all(&states);
    assert!(tr.attention("t1") && tr.last_output_at("t1") == 77);
    assert_eq!(tr.activity("t1").unwrap().tool, "Bash");
    assert!(tr.activity("gone").is_none());
    let after: Vec<String> = fb.sent()[before..].to_vec();
    assert!(
        after
            .iter()
            .all(|p| !p.contains(r#""action":"tool_attention""#))
    );
    let acts: Vec<&String> = after
        .iter()
        .filter(|p| p.contains("tool_activity"))
        .collect();
    assert_eq!(acts.len(), 2, "{acts:?}"); // gone 의 ended, t1 의 카드
    assert_eq!(
        crate::lock(&log).values().map(Vec::len).sum::<usize>(),
        n_changes,
        "반영이 데몬에 되썼다"
    );
}

fn mirror(judges: Arc<AtomicBool>) -> (Arc<AttnTracker>, Arc<FakeBroker>, Log) {
    let fb = FakeBroker::new();
    let tr = AttnTracker::new(fb.clone(), 1000);
    tr.set_busy_probe(Some(busy_all(true)));
    let log = change_log(&tr);
    tr.set_mirror(move || judges.load(Ordering::SeqCst));
    (tr, fb, log)
}

#[test]
fn mirror_output_records_time_only_and_sweeper() {
    let judges = Arc::new(AtomicBool::new(true));
    let (tr, fb, log) = mirror(judges.clone());
    tr.set_clock_for_testing(clock(77));
    tr.feed_output("t1", b"\x1b]9;hi\x07");
    assert!(!tr.attention("t1") && fb.count() == 0);
    assert_eq!(tr.last_output_at("t1"), 77);
    assert!(crate::lock(&log).is_empty());

    tr.restore(
        "t2",
        &AgentState {
            agent_seen: true,
            armed: true,
            activity: Some(ActivityState {
                state: activity::IDLE.into(),
                ..Default::default()
            }),
            turn: TurnState {
                in_progress: true,
                ..Default::default()
            },
            ..Default::default()
        },
    );
    let n = fb.count();
    tr.sweep_idle_at(1_000_000_000_000);
    assert!(!tr.attention("t2") && fb.count() == n);
    judges.store(false, Ordering::SeqCst);
    tr.sweep_idle_at(1_000_000_000_000);
    assert!(tr.attention("t2"), "옛 데몬인데 스위퍼가 판정하지 않았다");
}

#[test]
fn mirror_apply_attn_by_kind() {
    let judges = Arc::new(AtomicBool::new(true));
    let (tr, fb, log) = mirror(judges);
    let card = Some(ActivityState {
        state: activity::DONE.into(),
        tool: "Bash".into(),
        ..Default::default()
    });
    let ev = |kind: &str, reason: &str, agent: AgentState| AttnEvent {
        tool: "t1".into(),
        kind: kind.into(),
        reason: reason.into(),
        agent,
        ..Default::default()
    };
    let with_card = AgentState {
        activity: card.clone(),
        agent_seen: true,
        ..Default::default()
    };
    tr.apply_attn(&ev(ATTN_KIND_ACTIVITY, "", with_card.clone()));
    assert_eq!(count(&fb, "tool_activity"), 1);
    assert_eq!(tr.activity("t1").unwrap().tool, "Bash");
    tr.apply_attn(&ev(ATTN_KIND_ACTIVITY, "", with_card));
    assert_eq!(count(&fb, "tool_activity"), 2, "같은 카드도 방송한다");
    tr.apply_attn(&ev(
        ATTN_KIND_ATTENTION,
        activity::DONE,
        AgentState {
            activity: card.clone(),
            attention: true,
            ..Default::default()
        },
    ));
    assert!(tr.attention("t1") && count(&fb, r#""reason":"done""#) == 1);
    tr.apply_attn(&ev(
        ATTN_KIND_CLEAR,
        "",
        AgentState {
            activity: card,
            rearm_locked: true,
            ..Default::default()
        },
    ));
    assert!(!tr.attention("t1") && count(&fb, "tool_attention_clear") == 1);
    assert!(tr.agent_state_of("t1").rearm_locked);
    assert!(crate::lock(&log).is_empty());

    tr.set_clock_for_testing(clock(500));
    tr.feed_output("t1", b"x");
    tr.apply_attn(&ev(
        ATTN_KIND_ATTENTION,
        "",
        AgentState {
            attention: true,
            last_output_at: 100,
            ..Default::default()
        },
    ));
    assert_eq!(tr.last_output_at("t1"), 500);
    assert_eq!(count(&fb, r#""reason":"signaled""#), 1);
}

#[tokio::test]
async fn sweeper_runs_on_injected_tick_and_stops() {
    let (tr, fb) = firing(1000);
    tr.set_clock_for_testing(clock(0));
    start_stale_work(&tr, "agent");
    tr.feed_output("agent", b"x");
    tr.set_clock_for_testing(clock(2_000 * MS));
    let stop = tokio_util::sync::CancellationToken::new();
    let (tx, rx) = tokio::sync::mpsc::channel(1);
    tr.start_sweeper(stop.clone(), rx);
    tx.send(()).await.unwrap();
    for _ in 0..200 {
        if fired(&fb, "agent", "idle") == 1 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert_eq!(fired(&fb, "agent", "idle"), 1);
    stop.cancel();
}
