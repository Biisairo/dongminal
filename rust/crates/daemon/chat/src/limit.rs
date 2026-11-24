use std::collections::HashMap;
use std::time::Duration;

use time::OffsetDateTime;

/// 키가 이만큼 쌓이면 창을 지난 키를 지우는 문턱이다. 받는 쪽의 키는 상대가 고른다.
const SWEEP_AT: usize = 1024;

/// 키마다 창(window) 안의 횟수를 센다 (FR-PCH-55). 잠금은 부르는 쪽이 쥔다.
pub(crate) struct Limiter {
    max: usize,
    window: Duration,
    hits: HashMap<String, Vec<OffsetDateTime>>,
}

impl Limiter {
    pub fn new(max: usize, window: Duration) -> Self {
        Self {
            max,
            window,
            hits: HashMap::new(),
        }
    }

    pub fn allow(&mut self, key: &str, now: OffsetDateTime) -> bool {
        let cut = now - self.window;
        if self.hits.len() >= SWEEP_AT {
            self.hits
                .retain(|_, ts| ts.last().is_some_and(|last| *last > cut));
        }
        let kept = self.hits.entry(key.to_string()).or_default();
        kept.retain(|t| *t > cut);
        if kept.len() >= self.max {
            return false;
        }
        kept.push(now);
        true
    }
}

/// 보낸 노드마다 기억하는 순서 번호의 폭이다.
const REPLAY_WINDOW: u64 = 1024;

/// 보낸 노드 하나의 글 순서 창이다. 같은 글과 창보다 오래된 글, 지난 epoch 의 글을 거른다
/// (FR-PCH-4). 글 id 를 기억하는 집합과 달리 오래 지나도 잊지 않는다.
#[derive(Clone)]
pub(crate) struct SeqWindow {
    pub epoch: i64,
    pub max: u64,
    bits: Box<[bool; REPLAY_WINDOW as usize]>,
}

impl Default for SeqWindow {
    fn default() -> Self {
        Self::new(0, 0, false)
    }
}

impl SeqWindow {
    /// fill 이 참이면 max 까지를 모두 본 것으로 친다.
    pub fn new(epoch: i64, max: u64, fill: bool) -> Self {
        Self {
            epoch,
            max,
            bits: Box::new([fill; REPLAY_WINDOW as usize]),
        }
    }

    fn bit(seq: u64) -> usize {
        (seq % REPLAY_WINDOW) as usize
    }

    pub fn accept(&mut self, epoch: i64, seq: u64) -> bool {
        if epoch < self.epoch || seq == 0 {
            return false;
        }
        if epoch > self.epoch {
            *self = Self::new(epoch, 0, false);
        }
        if seq > self.max {
            if seq - self.max >= REPLAY_WINDOW {
                self.bits.fill(false);
            } else {
                for i in self.max + 1..seq {
                    self.bits[Self::bit(i)] = false;
                }
            }
            self.max = seq;
        } else if self.max - seq >= REPLAY_WINDOW || self.bits[Self::bit(seq)] {
            return false;
        }
        self.bits[Self::bit(seq)] = true;
        true
    }
}
