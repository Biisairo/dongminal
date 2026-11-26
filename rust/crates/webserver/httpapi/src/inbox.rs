//! 에이전트 메시지의 전달 대기열이다 (AGENT_MSG_REWAKE_SRS 묶음 Q·H·S).
//!
//! claude 에게 가는 에이전트 메시지는 입력창에 넣지 않고 이 대기열에 둔다. 깨움 훅
//! (`otterctl chat-wait`)이 `GET /api/tools/inbox/wait` 로 열어 둔 대기에, 그 탭이 일하는 중이
//! 아닐 때만 건넨다 — 일하는 중에 건네면 claude 는 그것을 지시가 아닌 알림으로 받아 무시한다
//! (§2.3b). 메모리에만 둔다 (NFR-AMW-3).

use std::collections::{HashMap, VecDeque};
use std::sync::{Mutex, MutexGuard};

use otter_shared_activity as activity;
use otter_shared_otterlog::infof;
use tokio::sync::oneshot;

/// 훅 대기에 건넬 메시지 묶음이다. 온 순서다.
pub(crate) type Batch = Vec<String>;

/// 훅 대기를 열었을 때의 결말이다.
pub(crate) enum Attach {
    /// 곧바로 답한다. 비어 있을 수 있다(`now`).
    Ready(Batch),
    /// 건넬 것이 생길 때까지 기다린다. 앞의 것은 대기 번호다 — 끊기면 `detach` 에 넘긴다.
    Wait(u64, oneshot::Receiver<Batch>),
}

#[derive(Default)]
struct Slot {
    /// 훅 대기가 알린 세션이다. 바뀌면 대기열을 버린다 (FR-AMW-5).
    session: String,
    /// 이 세션에서 훅 대기가 한 번이라도 열렸다 — 깨움 대상이다 (FR-AMW-1).
    hooked: bool,
    /// 활동 보고로 본 턴이 열려 있다(`working`·`waiting`). 열려 있으면 건네지 않는다 (FR-AMW-12).
    turn_open: bool,
    queue: VecDeque<String>,
    waiter: Option<(u64, oneshot::Sender<Batch>)>,
}

impl Slot {
    /// 건넬 수 있으면 건넨다. 받는 쪽이 이미 사라졌으면 메시지를 되돌린다.
    fn flush(&mut self) {
        if self.turn_open || self.queue.is_empty() {
            return;
        }
        let Some((_, tx)) = self.waiter.take() else {
            return;
        };
        let batch: Batch = self.queue.drain(..).collect();
        if let Err(back) = tx.send(batch) {
            self.queue.extend(back);
        }
    }

    fn drop_queue(&mut self, tool: &str, why: &str) {
        if !self.queue.is_empty() {
            // FR-AMW-6: 본문은 남기지 않는다.
            infof!(
                None,
                "[inbox] 대기열을 버린다 tool={tool} n={} why={why}",
                self.queue.len()
            );
            self.queue.clear();
        }
    }
}

#[derive(Default)]
pub(crate) struct Inbox {
    m: Mutex<(u64, HashMap<String, Slot>)>,
}

impl Inbox {
    fn lock(&self) -> MutexGuard<'_, (u64, HashMap<String, Slot>)> {
        self.m
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// 깨움 대상이면 대기열에 넣고 true 다 (FR-AMW-1·2·4). 아니면 false — 부르는 쪽이 붙여넣는다.
    pub(crate) fn enqueue(&self, tool: &str, msg: &str) -> bool {
        let mut g = self.lock();
        let Some(s) = g.1.get_mut(tool).filter(|s| s.hooked) else {
            return false;
        };
        s.queue.push_back(msg.to_owned());
        s.flush();
        true
    }

    /// 훅 대기를 연다 (FR-AMW-12·25). 앞의 대기는 빈 답으로 끝난다. `now` 면 기다리지 않는다.
    pub(crate) fn attach(&self, tool: &str, session: &str, now: bool) -> Attach {
        let mut g = self.lock();
        g.0 += 1;
        let n = g.0;
        let s = g.1.entry(tool.to_owned()).or_default();
        if !session.is_empty() && s.session != session {
            s.drop_queue(tool, "새 세션");
            s.session = session.to_owned();
        }
        s.hooked = true;
        s.waiter = None;
        if !s.turn_open && !s.queue.is_empty() {
            return Attach::Ready(s.queue.drain(..).collect());
        }
        if now {
            return Attach::Ready(Batch::new());
        }
        let (tx, rx) = oneshot::channel();
        s.waiter = Some((n, tx));
        Attach::Wait(n, rx)
    }

    /// 끊긴 훅 대기를 거둔다. 그 사이에 새 대기가 섰으면 건드리지 않는다.
    pub(crate) fn detach(&self, tool: &str, n: u64) {
        let mut g = self.lock();
        if let Some(s) = g.1.get_mut(tool)
            && s.waiter.as_ref().is_some_and(|(k, _)| *k == n)
        {
            s.waiter = None;
        }
    }

    /// 활동 보고 하나를 본다. 보고할 상태를 돌려준다 — 턴이 끝났는데 건넬 메시지가 남았으면
    /// `done`·`idle` 대신 `working` 이다 (FR-AMW-17 · D-AMW-5).
    pub(crate) fn on_activity<'a>(&self, tool: &str, state: &'a str) -> &'a str {
        let mut g = self.lock();
        if matches!(state, activity::WORKING | activity::WAITING) {
            // 훅 대기가 열리기 전의 턴도 기억한다 — 열린 턴에는 건네지 않는다.
            g.1.entry(tool.to_owned()).or_default().turn_open = true;
            return state;
        }
        let Some(s) = g.1.get_mut(tool) else {
            return state;
        };
        match state {
            activity::DONE | activity::IDLE => {
                s.turn_open = false;
                if s.queue.is_empty() {
                    return state;
                }
                s.flush();
                activity::WORKING
            }
            activity::ENDED => {
                if let Some(mut s) = g.1.remove(tool) {
                    s.drop_queue(tool, "세션 끝");
                }
                state
            }
            _ => state,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // 받는 쪽이 사라진 대기에 건네면 메시지를 되돌리고, 다음 대기가 받는다.
    #[test]
    fn flush_to_dropped_waiter_requeues() {
        let ib = Inbox::default();
        let Attach::Wait(_, rx) = ib.attach("t", "s", false) else {
            panic!("기다려야 한다");
        };
        drop(rx);
        assert!(ib.enqueue("t", "m"));
        let Attach::Ready(b) = ib.attach("t", "s", true) else {
            panic!("곧바로 답해야 한다");
        };
        assert_eq!(b, vec!["m".to_owned()]);
    }

    // 끊긴 대기를 거둘 때 그 사이에 선 새 대기는 건드리지 않는다.
    #[test]
    fn detach_keeps_newer_waiter() {
        let ib = Inbox::default();
        let Attach::Wait(old, _rx1) = ib.attach("t", "s", false) else {
            panic!();
        };
        let Attach::Wait(_, mut rx2) = ib.attach("t", "s", false) else {
            panic!();
        };
        ib.detach("t", old);
        assert!(ib.enqueue("t", "m"));
        assert_eq!(rx2.try_recv().unwrap(), vec!["m".to_owned()]);
    }

    // 모르는 탭의 활동 보고는 그대로 지난다.
    #[test]
    fn unknown_tool_activity_passes() {
        let ib = Inbox::default();
        assert_eq!(ib.on_activity("t", activity::DONE), activity::DONE);
        assert!(!ib.enqueue("t", "m"));
    }
}
