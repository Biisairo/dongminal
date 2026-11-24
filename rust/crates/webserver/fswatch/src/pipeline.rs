//! 원시 이벤트를 해석하고(FR-ELR-56) 모아 병합한 뒤(FR-ELR-57) 양을 조절해 내보낸다(FR-ELR-58).

use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

use otter_gocompat::filepath;

use crate::coalesce::{Change, Kind, coalesce};

/// 원시 이벤트를 모으는 시간 (VS Code `FILE_CHANGES_HANDLER_DELAY`).
pub const CHANGES_DELAY: Duration = Duration::from_millis(75);
/// Remove·Rename 뒤 존재를 다시 보기까지의 시간 (VS Code `FILE_DELETE_HANDLER_DELAY`).
/// 원자적 저장을 UPDATED 로 읽는다.
pub const DELETE_RECHECK_DELAY: Duration = Duration::from_millis(100);
/// 내보내는 양의 조절 (VS Code 비재귀 감시자의 `ThrottledWorker` 설정).
pub const CHUNK_SIZE: usize = 100;
pub const CHUNK_PAUSE: Duration = Duration::from_millis(200);
pub const MAX_BUFFERED: usize = 10000;

/// 원시 이벤트의 종류. 값은 fsnotify 의 비트와 같다.
pub type Op = u32;
pub const OP_CREATE: Op = 1;
pub const OP_WRITE: Op = 2;
pub const OP_REMOVE: Op = 4;
pub const OP_RENAME: Op = 8;
pub const OP_CHMOD: Op = 16;

/// 백엔드가 준 원시 이벤트. name 은 실제 경로다.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RawEvent {
    pub name: String,
    pub op: Op,
}

pub type TimerFn = Box<dyn FnOnce() + Send>;

/// 시간을 주입하는 자리. 시험은 가짜 시계로 시간을 결정론적으로 돌린다.
pub trait Clock: Send + Sync {
    fn after_func(&self, d: Duration, f: TimerFn);
}

/// 실제 시계. 타이머 스레드 하나가 마감 순서로 부른다 — 콜백은 그 스레드에서 돈다.
pub struct RealClock;

struct Timers {
    heap: BinaryHeap<Reverse<(Instant, u64)>>,
    fns: HashMap<u64, TimerFn>,
    seq: u64,
}

fn timers() -> &'static (Mutex<Timers>, Condvar) {
    static T: OnceLock<(Mutex<Timers>, Condvar)> = OnceLock::new();
    T.get_or_init(|| {
        std::thread::spawn(timer_loop);
        (
            Mutex::new(Timers {
                heap: BinaryHeap::new(),
                fns: HashMap::new(),
                seq: 0,
            }),
            Condvar::new(),
        )
    })
}

fn timer_loop() {
    let (m, cv) = timers();
    let mut g = m.lock().unwrap_or_else(|p| p.into_inner());
    loop {
        let now = Instant::now();
        match g.heap.peek().copied() {
            Some(Reverse((at, id))) if at <= now => {
                g.heap.pop();
                if let Some(f) = g.fns.remove(&id) {
                    drop(g);
                    f();
                    g = m.lock().unwrap_or_else(|p| p.into_inner());
                }
            }
            Some(Reverse((at, _))) => {
                g = cv
                    .wait_timeout(g, at - now)
                    .unwrap_or_else(|p| p.into_inner())
                    .0;
            }
            None => g = cv.wait(g).unwrap_or_else(|p| p.into_inner()),
        }
    }
}

impl Clock for RealClock {
    fn after_func(&self, d: Duration, f: TimerFn) {
        let (m, cv) = timers();
        let mut g = m.lock().unwrap_or_else(|p| p.into_inner());
        g.seq += 1;
        let id = g.seq;
        g.heap.push(Reverse((Instant::now() + d, id)));
        g.fns.insert(id, f);
        cv.notify_one();
    }
}

/// 변화의 출구. overflow 면 changes 는 비었다.
pub type OutFn = Arc<dyn Fn(&[Change], bool) + Send + Sync>;
pub type ExistsFn = Arc<dyn Fn(&str) -> bool + Send + Sync>;

pub struct PipelineOptions {
    pub clock: Arc<dyn Clock>,
    pub exists: ExistsFn,
    pub case_sensitive: bool,
    pub nfc: bool,
    pub out: OutFn,
}

#[derive(Default)]
struct State {
    pending: Vec<Change>,
    flushing: bool,
    queue: Vec<Change>,
    draining: bool,
    overflown: bool,
}

struct Shared {
    opt: PipelineOptions,
    st: Mutex<State>,
    out_mu: Mutex<()>,
}

/// 원시 이벤트의 해석·병합·양 조절.
#[derive(Clone)]
pub struct Pipeline(Arc<Shared>);

impl Pipeline {
    pub fn new(opt: PipelineOptions) -> Self {
        Pipeline(Arc::new(Shared {
            opt,
            st: Mutex::new(State::default()),
            out_mu: Mutex::new(()),
        }))
    }

    /// 원시 이벤트 하나를 받는다.
    pub fn push(&self, e: RawEvent) {
        let mut name = e.name;
        if self.0.opt.nfc {
            let base: String = icu_normalizer::ComposingNormalizerBorrowed::new_nfc()
                .normalize(&filepath::base(&name))
                .into_owned();
            name = filepath::join(&[filepath::dir(&name), base]);
        }
        if e.op & (OP_REMOVE | OP_RENAME) != 0 {
            let p = self.clone();
            self.0.opt.clock.after_func(
                DELETE_RECHECK_DELAY,
                Box::new(move || {
                    let k = if (p.0.opt.exists)(&name) {
                        Kind::Updated
                    } else {
                        Kind::Deleted
                    };
                    p.add(Change::new(name, k));
                }),
            );
        } else if e.op & OP_CREATE != 0 {
            self.add(Change::new(name, Kind::Added));
        } else if e.op & OP_WRITE != 0 {
            self.add(Change::new(name, Kind::Updated));
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.0.st.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn add(&self, c: Change) {
        let mut g = self.lock();
        g.pending.push(c);
        if g.flushing {
            return;
        }
        g.flushing = true;
        drop(g);
        let p = self.clone();
        self.0
            .opt
            .clock
            .after_func(CHANGES_DELAY, Box::new(move || p.flush()));
    }

    fn flush(&self) {
        let mut g = self.lock();
        let mut batch = coalesce(&g.pending, self.0.opt.case_sensitive);
        g.pending.clear();
        g.flushing = false;
        let mut overflow = false;
        let room = MAX_BUFFERED.saturating_sub(g.queue.len());
        if batch.len() > room {
            batch.truncate(room);
            if !g.overflown {
                g.overflown = true;
                overflow = true;
            }
        }
        g.queue.extend(batch);
        let start = !g.draining && !g.queue.is_empty();
        if start {
            g.draining = true;
        }
        drop(g);
        if overflow {
            self.emit(&[], true);
        }
        if start {
            self.drain();
        }
    }

    /// 묶음 하나를 내보내고, 남았으면 쉰 뒤 다시 부른다.
    fn drain(&self) {
        let mut g = self.lock();
        let n = CHUNK_SIZE.min(g.queue.len());
        let chunk: Vec<Change> = g.queue.drain(..n).collect();
        let more = !g.queue.is_empty();
        if !more {
            g.draining = false;
            g.overflown = false;
        }
        drop(g);
        if !chunk.is_empty() {
            self.emit(&chunk, false);
        }
        if more {
            let p = self.clone();
            self.0
                .opt
                .clock
                .after_func(CHUNK_PAUSE, Box::new(move || p.drain()));
        }
    }

    fn emit(&self, c: &[Change], overflow: bool) {
        let _g = self.0.out_mu.lock().unwrap_or_else(|p| p.into_inner());
        (self.0.opt.out)(c, overflow);
    }
}

#[cfg(test)]
pub(crate) mod tests;
