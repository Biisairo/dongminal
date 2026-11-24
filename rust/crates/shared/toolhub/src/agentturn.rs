use std::sync::atomic::{AtomicBool, Ordering::SeqCst};

use otter_shared_activity as activity;
use serde::{Deserialize, Serialize};

/// 에이전트 훅이 말한 턴의 상태다 (ATTENTION_FIRING_SRS 묶음 N). 데몬의 Tool 과 서버의
/// 추적기가 이 한 벌을 공유한다 (FR-ATN-14).
#[derive(Debug, Default)]
pub struct AgentTurn {
    in_progress: AtomicBool,
    /// 마지막 done 알람 뒤 턴이 시작되었다 (FR-ATN-1·4, D-12).
    turn_ran: AtomicBool,
    /// 이 턴에서 waiting 알람을 이미 냈다 (FR-ATN-15).
    waiting_signaled: AtomicBool,
}

/// AgentTurn 의 표시 셋을 옮기는 모양이다 (AGENT_RECORD_DAEMON_SRS FR-ARD-10).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "toolhub.TurnState")]
pub struct TurnState {
    #[serde(rename = "inProgress")]
    pub in_progress: bool,
    #[serde(rename = "waitingSignaled")]
    pub waiting_signaled: bool,
    #[serde(rename = "turnRan")]
    pub turn_ran: bool,
}

impl AgentTurn {
    /// 활동 보고를 진행 표시에 반영한다 (FR-ATN-7·8). waiting·idle 은 표시를 건드리지 않는다.
    pub fn note_activity(&self, state: &str) {
        match state {
            activity::WORKING => {
                self.in_progress.store(true, SeqCst);
                self.turn_ran.store(true, SeqCst);
                self.waiting_signaled.store(false, SeqCst);
            }
            activity::DONE => self.in_progress.store(false, SeqCst),
            activity::ENDED => {
                self.in_progress.store(false, SeqCst);
                self.waiting_signaled.store(false, SeqCst);
                self.turn_ran.store(false, SeqCst);
            }
            _ => {}
        }
    }

    pub fn in_progress(&self) -> bool {
        self.in_progress.load(SeqCst)
    }

    /// 활동 이벤트에서 파생한 알람의 판정이다 (FR-AEV-10·12). 턴 시작을 알릴 수 없는
    /// 에이전트(`turn_known=false`)의 done 은 판정 없이 울린다.
    pub fn allow_activity_signal(&self, state: &str, turn_known: bool) -> bool {
        if state == activity::DONE && !turn_known {
            return true;
        }
        self.allow_signal(state)
    }

    /// 명시 신호가 알람이 되는지 판정한다. done·waiting 의 표시는 소비된다. 그 밖은 언제나 알람이다.
    pub fn allow_signal(&self, reason: &str) -> bool {
        match reason {
            activity::DONE => self
                .turn_ran
                .compare_exchange(true, false, SeqCst, SeqCst)
                .is_ok(),
            activity::WAITING => {
                self.in_progress.load(SeqCst)
                    && self
                        .waiting_signaled
                        .compare_exchange(false, true, SeqCst, SeqCst)
                        .is_ok()
            }
            _ => true,
        }
    }

    pub fn state(&self) -> TurnState {
        TurnState {
            in_progress: self.in_progress.load(SeqCst),
            waiting_signaled: self.waiting_signaled.load(SeqCst),
            turn_ran: self.turn_ran.load(SeqCst),
        }
    }

    /// 표시를 st 로 되세운다. turnRan 이 없는 옛 스냅샷도 진행 중이던 턴의 종료를 울린다.
    pub fn restore(&self, st: TurnState) {
        self.in_progress.store(st.in_progress, SeqCst);
        self.waiting_signaled.store(st.waiting_signaled, SeqCst);
        self.turn_ran.store(st.turn_ran || st.in_progress, SeqCst);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn working_marks_turn_start() {
        let t = AgentTurn::default();
        t.note_activity("working");
        assert!(t.in_progress());
        assert!(t.state().turn_ran);
    }

    #[test]
    fn done_fires_once_per_turn() {
        let t = AgentTurn::default();
        assert!(!t.allow_signal("done"));
        t.note_activity("working");
        assert!(t.allow_signal("done"));
        assert!(!t.state().turn_ran);
        assert!(!t.allow_signal("done"));
        for _ in 0..3 {
            t.note_activity("working");
            assert!(t.allow_signal("done"));
        }
    }

    #[test]
    fn waiting_fires_only_while_in_progress() {
        let t = AgentTurn::default();
        assert!(!t.allow_signal("waiting"));
        t.note_activity("working");
        assert!(t.allow_signal("waiting"));
        t.note_activity("done");
        assert!(!t.allow_signal("waiting"));
    }

    #[test]
    fn waiting_and_idle_do_not_move_the_mark() {
        let t = AgentTurn::default();
        t.note_activity("working");
        for s in ["waiting", "idle"] {
            t.note_activity(s);
            assert!(t.in_progress(), "{s}");
        }
        t.note_activity("done");
        for s in ["waiting", "idle"] {
            t.note_activity(s);
            assert!(!t.in_progress(), "{s}");
        }
    }

    #[test]
    fn other_labels_bypass_the_gate() {
        let t = AgentTurn::default();
        for r in ["signaled", "codex", "attention", ""] {
            assert!(t.allow_signal(r), "{r}");
        }
    }

    #[test]
    fn ended_drops_marks() {
        let t = AgentTurn::default();
        t.note_activity("working");
        t.note_activity("ended");
        assert!(!t.in_progress());
        assert!(!t.allow_signal("done"));

        let t = AgentTurn::default();
        t.note_activity("working");
        t.allow_signal("waiting");
        t.note_activity("ended");
        t.note_activity("working");
        assert!(t.allow_signal("waiting"));
    }

    #[test]
    fn waiting_mark_consumed_once_and_cleared_on_new_work() {
        let t = AgentTurn::default();
        t.note_activity("working");
        assert!(t.allow_signal("waiting"));
        for _ in 0..3 {
            assert!(!t.allow_signal("waiting"));
        }
        t.note_activity("working");
        assert!(t.allow_signal("waiting"));
    }

    #[test]
    fn activity_signal_done_without_turn_known() {
        let t = AgentTurn::default();
        assert!(t.allow_activity_signal("done", false));
        assert!(!t.allow_activity_signal("done", true));
    }

    #[test]
    fn restore_old_snapshot_sets_turn_ran() {
        let t = AgentTurn::default();
        t.restore(TurnState {
            in_progress: true,
            ..Default::default()
        });
        assert!(t.allow_signal("done"));
    }
}
