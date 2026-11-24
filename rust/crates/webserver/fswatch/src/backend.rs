//! notify 위의 감시 계층 (FR-ELR-50). 관측 이벤트는 Go fsnotify 와 같게 맞춘다.
//!
//! - inotify(Linux) 는 비재귀 디렉터리 감시가 곧 자식 이벤트다. 그대로 옮긴다.
//! - kqueue(macOS) 는 fsnotify 처럼 디렉터리 안 항목마다 감시를 걸고, 디렉터리가 바뀌면 다시
//!   읽어 새 항목을 Create 로 알린다. notify 의 비재귀 kqueue 감시는 자식을 보지 않는다.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};

use notify::event::{EventKind, ModifyKind, RenameMode};
use notify::{RecursiveMode, Watcher};
use otter_gocompat::filepath;

use crate::os::KQUEUE_ENTRIES_MAX;
use crate::pipeline::{OP_CHMOD, OP_CREATE, OP_REMOVE, OP_RENAME, OP_WRITE, Op, RawEvent};

/// 백엔드가 멎은 이유.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BackendError {
    /// 이벤트를 놓쳤다. 감시자는 멀쩡하다.
    Overflow,
    /// 자원 고갈(EMFILE·ENOSPC). 다시 세우지 않는다.
    Exhausted(String),
    Other(String),
}

impl std::fmt::Display for BackendError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            BackendError::Overflow => f.write_str("fsnotify: queue or buffer overflow"),
            BackendError::Exhausted(s) | BackendError::Other(s) => f.write_str(s),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BackendMsg {
    Event(RawEvent),
    Error(BackendError),
}

/// OS 감시 계층. 메시지 수신자는 만들 때 함께 낸다 — 백엔드가 닫히면 수신이 끝난다.
pub trait Backend: Send {
    fn add(&mut self, path: &str) -> Result<(), String>;
    fn remove(&mut self, path: &str) -> Result<(), String>;
    fn close(&mut self);
}

pub type NewBackend =
    Arc<dyn Fn() -> Result<(Box<dyn Backend>, Receiver<BackendMsg>), String> + Send + Sync>;

#[cfg(target_os = "macos")]
type Inner = notify::KqueueWatcher;
#[cfg(not(target_os = "macos"))]
type Inner = notify::RecommendedWatcher;

/// kqueue 에서 fsnotify 처럼 항목마다 감시하는가.
const PER_ENTRY: bool = cfg!(target_os = "macos");

struct Core {
    w: Inner,
    /// 감시 중인 디렉터리 → 감시를 건 항목들 (PER_ENTRY 일 때만).
    dirs: HashMap<String, HashSet<String>>,
}

struct NotifyBackend {
    core: Option<Arc<Mutex<Core>>>,
}

fn lock(c: &Mutex<Core>) -> std::sync::MutexGuard<'_, Core> {
    c.lock().unwrap_or_else(|p| p.into_inner())
}

fn err_text(e: &notify::Error) -> BackendError {
    if let notify::ErrorKind::MaxFilesWatch = e.kind {
        return BackendError::Exhausted("too many open files".into());
    }
    if let notify::ErrorKind::Io(io) = &e.kind {
        let text = otter_gocompat::oserr::go_error_string(io);
        #[cfg(unix)]
        if matches!(io.raw_os_error(), Some(libc::EMFILE) | Some(libc::ENOSPC)) {
            return BackendError::Exhausted(text);
        }
        return BackendError::Other(text);
    }
    BackendError::Other(e.to_string())
}

impl Core {
    fn watch_entries(&mut self, dir: &str) -> Vec<String> {
        let mut fresh = Vec::new();
        let Ok(rd) = std::fs::read_dir(dir) else {
            return fresh;
        };
        for ent in rd.flatten() {
            let p = filepath::join(&[dir, &ent.file_name().to_string_lossy()]);
            let known = self.dirs.get(dir).is_some_and(|s| s.contains(&p));
            if known {
                continue;
            }
            let room = self.dirs.get(dir).map_or(0, HashSet::len) < KQUEUE_ENTRIES_MAX;
            if room
                && openable(&p)
                && self
                    .w
                    .watch(Path::new(&p), RecursiveMode::NonRecursive)
                    .is_ok()
            {
                self.dirs
                    .entry(dir.to_owned())
                    .or_default()
                    .insert(p.clone());
            }
            fresh.push(p);
        }
        fresh
    }

    fn forget_entry(&mut self, p: &str) -> Option<String> {
        let dir = filepath::dir(p);
        let s = self.dirs.get_mut(&dir)?;
        s.remove(p).then_some(dir)
    }
}

/// kqueue 감시는 대상을 블로킹 `open(O_RDONLY)` 로 연다. FIFO·장치를 열면 감시 스레드가 멈출 수
/// 있으므로 일반 파일·디렉터리(링크는 대상 기준)만 감시한다. 디렉터리마다 감시 항목은
/// KQUEUE_ENTRIES_MAX 까지다. 둘 다 보안 강화이고 특수 파일·상한 밖 항목의 이벤트만 빠진다.
fn openable(p: &str) -> bool {
    std::fs::metadata(p).is_ok_and(|m| m.is_file() || m.is_dir())
}

/// notify 이벤트 하나를 fsnotify 의 op 로. 알 수 없는 것은 0 이다.
fn op_of(kind: &EventKind) -> Op {
    match kind {
        EventKind::Create(_) => OP_CREATE,
        EventKind::Remove(_) => OP_REMOVE,
        EventKind::Modify(ModifyKind::Metadata(_)) => OP_CHMOD,
        EventKind::Modify(ModifyKind::Name(RenameMode::To)) => OP_CREATE,
        EventKind::Modify(ModifyKind::Name(RenameMode::Both)) => 0,
        EventKind::Modify(ModifyKind::Name(_)) => OP_RENAME,
        EventKind::Modify(ModifyKind::Data(_)) => OP_WRITE,
        EventKind::Modify(ModifyKind::Any) | EventKind::Modify(ModifyKind::Other) => {
            if PER_ENTRY {
                0 // kqueue 의 NOTE_LINK — fsnotify 는 구독하지 않는다.
            } else {
                OP_WRITE
            }
        }
        _ => 0,
    }
}

fn translate(core: &Mutex<Core>, ev: notify::Event, out: &Sender<BackendMsg>) {
    if ev.need_rescan() {
        let _ = out.send(BackendMsg::Error(BackendError::Overflow));
        return;
    }
    let op = op_of(&ev.kind);
    for p in &ev.paths {
        let name = p.to_string_lossy().into_owned();
        if !PER_ENTRY {
            if op != 0 {
                let _ = out.send(BackendMsg::Event(RawEvent { name, op }));
            }
            continue;
        }
        let mut c = lock(core);
        let is_dir = c.dirs.contains_key(&name);
        if is_dir && op == OP_WRITE {
            // 디렉터리의 항목이 바뀌었다 — 새 항목을 Create 로 알린다.
            for f in c.watch_entries(&name) {
                let _ = out.send(BackendMsg::Event(RawEvent {
                    name: f,
                    op: OP_CREATE,
                }));
            }
            continue;
        }
        if op == OP_WRITE && Path::new(&name).is_dir() {
            // 하위 디렉터리의 항목 변화. fsnotify 는 그 디렉터리의 Write 를 내지 않는다.
            continue;
        }
        let parent = if op & (OP_REMOVE | OP_RENAME) != 0 {
            c.forget_entry(&name)
        } else {
            None
        };
        if op != 0 {
            let _ = out.send(BackendMsg::Event(RawEvent { name, op }));
        }
        // 지워진 자리를 다른 파일이 덮었을 수 있다(mv f1 f2). 부모를 다시 읽는다.
        if let Some(dir) = parent {
            for f in c.watch_entries(&dir) {
                let _ = out.send(BackendMsg::Event(RawEvent {
                    name: f,
                    op: OP_CREATE,
                }));
            }
        }
    }
}

/// 기본 백엔드를 세운다.
pub fn new_notify_backend() -> Result<(Box<dyn Backend>, Receiver<BackendMsg>), String> {
    let (raw_tx, raw_rx) = mpsc::channel::<notify::Result<notify::Event>>();
    let w = Inner::new(
        move |r| {
            let _ = raw_tx.send(r);
        },
        notify::Config::default(),
    )
    .map_err(|e| err_text(&e).to_string())?;
    let core = Arc::new(Mutex::new(Core {
        w,
        dirs: HashMap::new(),
    }));
    let (tx, rx) = mpsc::channel();
    // 감시자를 다시 부르는 일은 notify 의 이벤트 스레드 밖에서 한다 — 안에서 부르면 서로 기다린다.
    let weak = Arc::downgrade(&core);
    std::thread::spawn(move || {
        for r in raw_rx {
            let Some(core) = weak.upgrade() else {
                return;
            };
            match r {
                Ok(ev) => translate(&core, ev, &tx),
                Err(e) => {
                    let _ = tx.send(BackendMsg::Error(err_text(&e)));
                }
            }
        }
    });
    Ok((Box::new(NotifyBackend { core: Some(core) }), rx))
}

impl Backend for NotifyBackend {
    fn add(&mut self, path: &str) -> Result<(), String> {
        let Some(core) = &self.core else {
            return Err("fsnotify: watcher already closed".into());
        };
        let mut c = lock(core);
        c.w.watch(Path::new(path), RecursiveMode::NonRecursive)
            .map_err(|e| err_text(&e).to_string())?;
        c.dirs.insert(path.to_owned(), HashSet::new());
        if PER_ENTRY {
            c.watch_entries(path);
        }
        Ok(())
    }

    fn remove(&mut self, path: &str) -> Result<(), String> {
        let Some(core) = &self.core else {
            return Ok(());
        };
        let mut c = lock(core);
        for f in c.dirs.remove(path).unwrap_or_default() {
            let _ = c.w.unwatch(Path::new(&f));
        }
        c.w.unwatch(Path::new(path))
            .map_err(|e| err_text(&e).to_string())
    }

    fn close(&mut self) {
        // 감시자를 버리면 notify 의 송신이 끊기고, 번역 스레드가 끝나며 수신이 닫힌다.
        self.core = None;
    }
}
