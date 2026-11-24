//! 클라이언트마다의 감시 집합을 합쳐 디렉터리를 한 번씩 감시한다 (FR-ELR-51~55·60).

use std::collections::{BTreeSet, HashMap, HashSet};
use std::fmt;
use std::sync::mpsc::Receiver;
use std::sync::{Arc, Mutex};

use otter_gocompat::filepath;
use otter_shared_otterlog::infof;

use crate::backend::{Backend, BackendError, BackendMsg, NewBackend, new_notify_backend};
use crate::coalesce::Change;
use crate::os::{FS_CASE_SENSITIVE, FS_NFC, watchable};
use crate::pipeline::{Clock, ExistsFn, OutFn, Pipeline, PipelineOptions, RawEvent, RealClock};

/// 감시자를 다시 세우는 상한 (VS Code `AbstractWatcherClient.MAX_RESTARTS`).
pub const MAX_RESTARTS: u32 = 5;

/// SSE 구독이 없는 신원의 등록 (FR-ELR-51·52).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct NotAttached;

impl fmt::Display for NotAttached {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("fswatch: client not attached")
    }
}

impl std::error::Error for NotAttached {}

/// 등록할 디렉터리 하나. path 는 클라이언트의 철자, real 은 실제 경로다.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Dir {
    pub path: String,
    pub real: String,
}

pub type WatchableFn = Arc<dyn Fn(&str) -> bool + Send + Sync>;

pub struct ManagerOptions {
    pub new_backend: NewBackend,
    pub clock: Arc<dyn Clock>,
    pub case_sensitive: bool,
    pub nfc: bool,
    pub watchable: WatchableFn,
    pub exists: ExistsFn,
    pub emit: OutFn,
}

impl ManagerOptions {
    /// 이 OS 의 기본값.
    pub fn defaults(emit: OutFn) -> Self {
        ManagerOptions {
            new_backend: Arc::new(new_notify_backend),
            clock: Arc::new(RealClock),
            case_sensitive: FS_CASE_SENSITIVE,
            nfc: FS_NFC,
            watchable: Arc::new(watchable),
            exists: Arc::new(|p| std::fs::symlink_metadata(p).is_ok()),
            emit,
        }
    }
}

struct Client {
    epoch: u64,
    /// 철자 → 실제 경로.
    dirs: HashMap<String, String>,
}

#[derive(Default)]
struct State {
    clients: HashMap<String, Client>,
    seq: u64,
    /// 실제 경로 → 참조 수.
    refs: HashMap<String, u32>,
    /// 실제 경로 → 철자 → 참조 수.
    spell: HashMap<String, HashMap<String, u32>>,
    backend: Option<Box<dyn Backend>>,
    /// 지금 백엔드의 세대. 멎은 백엔드가 지금 것인지 가른다.
    generation: u64,
    restarts: u32,
    dead: bool,
    closed: bool,
}

struct Shared {
    new_backend: NewBackend,
    watchable: WatchableFn,
    emit: OutFn,
    pipe: Mutex<Option<Pipeline>>,
    st: Mutex<State>,
}

/// 감시 관리자.
#[derive(Clone)]
pub struct Manager(Arc<Shared>);

impl Manager {
    pub fn new(opt: ManagerOptions) -> Self {
        let sh = Arc::new(Shared {
            new_backend: opt.new_backend,
            watchable: opt.watchable,
            emit: Arc::clone(&opt.emit),
            pipe: Mutex::new(None),
            st: Mutex::new(State::default()),
        });
        let weak = Arc::downgrade(&sh);
        let pipe = Pipeline::new(PipelineOptions {
            clock: opt.clock,
            exists: opt.exists,
            case_sensitive: opt.case_sensitive,
            nfc: opt.nfc,
            out: Arc::new(move |cs, overflow| {
                if let Some(sh) = weak.upgrade() {
                    Manager(sh).out(cs, overflow);
                }
            }),
        });
        *sh.pipe.lock().unwrap_or_else(|p| p.into_inner()) = Some(pipe);
        Manager(sh)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.0.st.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// SSE 구독이 열렸음을 알린다. 돌려준 epoch 로 detach 한다.
    pub fn attach(&self, cid: &str) -> u64 {
        let mut g = self.lock();
        g.seq += 1;
        let seq = g.seq;
        g.clients
            .entry(cid.to_owned())
            .or_insert_with(|| Client {
                epoch: 0,
                dirs: HashMap::new(),
            })
            .epoch = seq;
        seq
    }

    /// 구독이 끊겼음을 알린다. 그 사이 다시 붙은 구독의 등록은 지우지 않는다.
    pub fn detach(&self, cid: &str, epoch: u64) {
        let mut g = self.lock();
        if g.clients.get(cid).is_none_or(|c| c.epoch != epoch) {
            return;
        }
        if let Some(c) = g.clients.remove(cid) {
            for (sp, real) in c.dirs {
                release(&mut g, &sp, &real);
            }
        }
    }

    /// cid 의 감시 집합을 통째로 바꾸고, 실제로 감시하게 된 철자를 정렬해 돌려준다.
    pub fn set(&self, cid: &str, dirs: &[Dir]) -> Result<Vec<String>, NotAttached> {
        let mut g = self.lock();
        if cid.is_empty() || !g.clients.contains_key(cid) {
            return Err(NotAttached);
        }
        if g.backend.is_none() && !g.dead && !g.closed {
            self.start(&mut g);
        }
        let old = g
            .clients
            .get(cid)
            .map(|c| c.dirs.clone())
            .unwrap_or_default();
        let mut next: HashMap<String, String> = HashMap::new();
        for d in dirs {
            if next.contains_key(&d.path) {
                continue;
            }
            if old.get(&d.path) == Some(&d.real) || self.acquire(&mut g, &d.path, &d.real) {
                next.insert(d.path.clone(), d.real.clone());
            }
        }
        for (sp, real) in &old {
            if next.get(sp) != Some(real) {
                release(&mut g, sp, real);
            }
        }
        let out: BTreeSet<String> = next.keys().cloned().collect();
        if let Some(c) = g.clients.get_mut(cid) {
            c.dirs = next;
        }
        Ok(out.into_iter().collect())
    }

    /// 감시를 모두 걷는다.
    pub fn close(&self) {
        let mut g = self.lock();
        g.closed = true;
        if let Some(mut b) = g.backend.take() {
            b.close();
        }
    }

    fn acquire(&self, g: &mut State, sp: &str, real: &str) -> bool {
        if g.backend.is_none() || !(self.0.watchable)(real) {
            return false;
        }
        if g.refs.get(real).copied().unwrap_or(0) == 0 {
            let ok = g.backend.as_mut().is_some_and(|b| b.add(real).is_ok());
            if !ok {
                return false;
            }
        }
        *g.refs.entry(real.to_owned()).or_default() += 1;
        *g.spell
            .entry(real.to_owned())
            .or_default()
            .entry(sp.to_owned())
            .or_default() += 1;
        true
    }

    fn start(&self, g: &mut State) {
        match (self.0.new_backend)() {
            Err(e) => {
                infof!(
                    None,
                    "[fswatch] 감시자를 세우지 못했다 — 폴링이 맡는다: {e}"
                );
                g.dead = true;
            }
            Ok((b, rx)) => {
                g.backend = Some(b);
                g.generation += 1;
                let (m, gen_) = (self.clone(), g.generation);
                std::thread::spawn(move || m.run(rx, gen_));
            }
        }
    }

    fn run(&self, rx: Receiver<BackendMsg>, generation: u64) {
        for msg in rx.iter() {
            match msg {
                BackendMsg::Event(e) => self.handle_raw(e),
                BackendMsg::Error(BackendError::Overflow) => (self.0.emit)(&[], true),
                BackendMsg::Error(e) => {
                    self.fail(generation, Some(e));
                    return;
                }
            }
        }
        self.fail(generation, None);
    }

    /// 감시자가 멎었을 때 다시 세운다 (FR-ELR-60). 자원 고갈이면 세우지 않는다.
    fn fail(&self, generation: u64, err: Option<BackendError>) {
        let mut g = self.lock();
        if g.closed || generation != g.generation || g.backend.is_none() {
            return;
        }
        if let Some(mut b) = g.backend.take() {
            b.close();
        }
        let exhausted = matches!(err, Some(BackendError::Exhausted(_)));
        if exhausted || g.restarts >= MAX_RESTARTS {
            let text = err.map_or_else(|| "<nil>".to_owned(), |e| e.to_string());
            infof!(None, "[fswatch] 감시자가 멎었다 — 폴링이 맡는다: {text}");
            g.dead = true;
            return;
        }
        g.restarts += 1;
        self.start(&mut g);
        let reals: Vec<String> = g.refs.keys().cloned().collect();
        if let Some(b) = g.backend.as_mut() {
            for real in reals {
                let _ = b.add(&real);
            }
        }
    }

    /// 감시 중인 디렉터리의 이벤트만 파이프라인에 넣는다.
    pub(crate) fn handle_raw(&self, e: RawEvent) {
        let pass = {
            let g = self.lock();
            g.refs.contains_key(&filepath::dir(&e.name)) || g.refs.contains_key(&e.name)
        };
        if !pass {
            return;
        }
        let pipe = self
            .0
            .pipe
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone();
        if let Some(p) = pipe {
            p.push(e);
        }
    }

    /// 실제 경로의 변화를 등록한 철자로 되돌려 내보낸다 (FR-ELR-54).
    fn out(&self, cs: &[Change], overflow: bool) {
        if overflow {
            (self.0.emit)(&[], true);
            return;
        }
        let mut seen: HashSet<String> = HashSet::new();
        let mut res: Vec<Change> = Vec::new();
        {
            let g = self.lock();
            for c in cs {
                for p in spellings(&g, &c.path) {
                    if seen.insert(p.clone()) {
                        res.push(Change::new(p, c.kind));
                    }
                }
            }
        }
        if !res.is_empty() {
            res.sort_by(|a, b| a.path.cmp(&b.path));
            (self.0.emit)(&res, false);
        }
    }
}

fn release(g: &mut State, sp: &str, real: &str) {
    if g.refs.get(real).copied().unwrap_or(0) == 0 {
        return;
    }
    if let Some(s) = g.spell.get_mut(real)
        && let Some(n) = s.get_mut(sp)
    {
        *n = n.saturating_sub(1);
        if *n == 0 {
            s.remove(sp);
        }
    }
    let left = g.refs.get_mut(real).map(|n| {
        *n -= 1;
        *n
    });
    if left.is_some_and(|n| n > 0) {
        return;
    }
    g.refs.remove(real);
    g.spell.remove(real);
    if let Some(b) = g.backend.as_mut() {
        let _ = b.remove(real);
    }
}

fn spellings(g: &State, real: &str) -> Vec<String> {
    let base = filepath::base(real);
    let mut out: Vec<String> = Vec::new();
    if let Some(s) = g.spell.get(&filepath::dir(real)) {
        out.extend(
            s.keys()
                .map(|sp| filepath::join(&[sp.as_str(), base.as_str()])),
        );
    }
    if let Some(s) = g.spell.get(real) {
        out.extend(s.keys().cloned());
    }
    out
}

#[cfg(test)]
mod tests;
