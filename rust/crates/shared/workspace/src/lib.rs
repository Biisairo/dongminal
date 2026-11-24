//! Go 기준선 `otterminal/internal/shared/workspace` 의 Rust 포팅. RUST_PORT_SRS 참고.
//!
//! workspace.json 의 영속화(latest-wins 비동기 저장, 개정 번호, 세대 복구)와 식별자 해석이다.

mod gocase;
mod parse;
mod recover;
mod resolve;
mod runmarks;

pub use parse::{
    LAYOUT_TYPE_PANE, LAYOUT_TYPE_SPLIT, SCHEMA_VERSION, TabEntry, WindowInfo, WsGroup,
    WsGroupTree, WsLayout, WsState, WsTab, WsWindow, collect_panes, decode_state,
    referenced_tool_ids, short_code,
};
pub use recover::{FilePersister, LOAD_EMPTY, LOAD_RESTORED, PERSIST_FAILED, Recoverable};
pub use runmarks::apply_run_marks;

use std::collections::{HashMap, HashSet};
use std::fmt;
use std::io;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError, RwLock};
use std::thread::JoinHandle;

use otter_gocompat::json;
use otter_gocompat::oserr::go_error_string;
use otter_shared_otterlog::infof;
use otter_shared_pollwait::{Changed, Signal};

use parse::{Index, build_index, windows_of};

/// ResolveStrict 가 좌표 라벨 형태의 입력을 거부한 진단의 마지막 줄이다 (FR-IDU-2).
pub const LABEL_IDENTIFIER_MSG: &str = "uuid 는 `otterctl list-workspace` 의 uuid= 컬럼, 또는 생성 명령(new-tab/split-*)의 응답에 있다.";

const STALE_MSG: &str = "workspace: stale revision";
const SCHEMA_TOO_OLD_MSG: &str =
    "workspace: schemaVersion 이 2 미만입니다 — `otterminal migrate` 를 먼저 실행하세요";
const SCHEMA_TOO_NEW_MSG: &str = "workspace: schemaVersion 이 이 판보다 높습니다 — otterminal 을 최신으로 올리거나 백업 세대(.bak.1)에서 되돌리세요";

/// workspace 오류. `Display` 는 Go 의 `err.Error()` 와 같다.
#[derive(Debug)]
pub enum Error {
    /// If-Match 가 지금 개정과 다르다.
    Stale,
    /// v2 미만이다 (FR-EM-2a). 빈 workspace 와 구별할 수 없으므로 명시적으로 실패한다.
    SchemaTooOld,
    /// 이 판보다 높다 (FR-SFD-15). 손상이 아니므로 격리하지 않는다.
    SchemaTooNew,
    /// 기동 시 읽기 실패 (`workspace read: …`).
    Read(io::Error),
    /// JSON 디코딩 실패.
    Json(json::Error),
    /// Save 의 해석 실패 (`workspace parse: …`).
    Parse(Box<Error>),
    /// 좌표 라벨을 받지 않는 해석기에 라벨이 왔다 (FR-IDU-2). 값은 입력이다.
    LabelRejected(String),
    /// 그 밖의 해석 실패. 값은 문구 전체다.
    Resolve(String),
}

impl Error {
    fn root(&self) -> &Error {
        match self {
            Error::Parse(inner) => inner.root(),
            e => e,
        }
    }

    pub fn is_stale(&self) -> bool {
        matches!(self.root(), Error::Stale)
    }

    pub fn is_schema_too_old(&self) -> bool {
        matches!(self.root(), Error::SchemaTooOld)
    }

    pub fn is_schema_too_new(&self) -> bool {
        matches!(self.root(), Error::SchemaTooNew)
    }

    /// Go `errors.Is(err, ErrLabelIdentifier)`. 호출자가 400 과 404 를 가르는 근거다.
    pub fn is_label_identifier(&self) -> bool {
        matches!(self.root(), Error::LabelRejected(_))
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Stale => f.write_str(STALE_MSG),
            Error::SchemaTooOld => f.write_str(SCHEMA_TOO_OLD_MSG),
            Error::SchemaTooNew => f.write_str(SCHEMA_TOO_NEW_MSG),
            Error::Read(e) => write!(f, "workspace read: {}", go_error_string(e)),
            Error::Json(e) => write!(f, "{e}"),
            Error::Parse(e) => write!(f, "workspace parse: {e}"),
            Error::LabelRejected(id) => write!(
                f,
                "좌표 라벨({id})은 이 명령에서 쓸 수 없다 — uuid 를 쓴다.\n라벨은 창·분할 칸이 닫히면 다시 계산돼 다른 탭을 가리킨다.\n{LABEL_IDENTIFIER_MSG}"
            ),
            Error::Resolve(msg) => f.write_str(msg),
        }
    }
}

impl std::error::Error for Error {}

/// 도구가 살아 있는지 묻는다.
pub trait Liveness: Send + Sync {
    fn is_live(&self, tool_id: &str) -> bool;
}

/// workspace.json 의 저장소다. 파일이 없으면 `read` 는 `NotFound` 를 돌려주고,
/// [`Manager::new`] 는 그것을 빈 상태로 친다.
pub trait Persister: Send + Sync {
    fn read(&self) -> io::Result<Vec<u8>>;
    fn write(&self, data: &[u8]) -> io::Result<()>;
    /// 손상 격리·세대 복구 능력. 없으면 종전 동작(빈 인덱스로 지나감)이다.
    fn recoverable(&self) -> Option<&dyn Recoverable> {
        None
    }
}

type Hook = Arc<dyn Fn() + Send + Sync>;

#[derive(Default)]
struct WriteQueue {
    pending: Option<Arc<Vec<u8>>>,
    closed: bool,
}

struct Writer {
    queue: Mutex<WriteQueue>,
    wake: Condvar,
    store: Arc<dyn Persister>,
    /// 마지막 비동기 쓰기가 실패했는가 (`GO-10`). 성공하면 걷힌다.
    persist_failed: AtomicBool,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Writer {
    /// 큐를 한 칸씩 비운다. 닫힌 뒤에도 남은 한 칸은 쓰고 끝난다.
    fn run(&self) {
        let mut q = lock(&self.queue);
        loop {
            if let Some(blob) = q.pending.take() {
                drop(q);
                let flushing = lock(&self.queue).closed;
                let res = self.store.write(&blob);
                if let Err(e) = &res {
                    let e = go_error_string(e);
                    if flushing {
                        infof!(None, "workspace async write (flush): {e}");
                    } else {
                        infof!(None, "workspace async write: {e}");
                    }
                }
                self.persist_failed.store(res.is_err(), Ordering::SeqCst);
                q = lock(&self.queue);
                continue;
            }
            if q.closed {
                return;
            }
            q = self.wake.wait(q).unwrap_or_else(PoisonError::into_inner);
        }
    }

    /// latest-wins: 막지 않고, 아직 집히지 않은 앞 blob 은 버린다.
    fn enqueue(&self, blob: Arc<Vec<u8>>) {
        lock(&self.queue).pending = Some(blob);
        self.wake.notify_one();
    }
}

struct Snap {
    raw: Arc<Vec<u8>>,
    rev: u64,
}

/// workspace.json 의 메모리 판과 색인을 들고, 저장을 비동기로 디스크에 내린다.
pub struct Manager {
    live: Arc<dyn Liveness>,
    mu: Mutex<()>,
    snap: RwLock<Arc<Snap>>,
    idx: RwLock<Arc<Index>>,
    /// 색인이 바뀔 때마다 울린다 (FR-OPT-8-4).
    changed: Signal,
    hook: Mutex<Option<Hook>>,
    hook_mu: Mutex<()>,
    writer: Arc<Writer>,
    writer_thread: Mutex<Option<JoinHandle<()>>>,
    /// 기동 시 적재의 분류다 (FR-SFD-14). `""` 이 정상이다.
    load_err: &'static str,
}

impl Manager {
    pub fn new(live: Arc<dyn Liveness>, store: Arc<dyn Persister>) -> Result<Self, Error> {
        let data = match store.read() {
            Ok(d) => d,
            Err(e) if e.kind() == io::ErrorKind::NotFound => Vec::new(),
            Err(e) => return Err(Error::Read(e)),
        };
        let (raw, ix, load_err) = match build_index(&data) {
            Ok(ix) => (data, ix, ""),
            // 스키마가 어긋나면 치명적이다 — 계속하면 브라우저가 빈 상태로 덮어쓴다.
            // 위아래 모두 거부하며 격리하지 않는다 (FR-EM-2a·FR-SFD-15).
            Err(e) if e.is_schema_too_old() || e.is_schema_too_new() => return Err(e),
            // FR-SFD-10·12: 격리하고 세대에서 되살린다.
            Err(_) => recover::recover_corrupt(store.as_ref()),
        };
        let writer = Arc::new(Writer {
            queue: Mutex::new(WriteQueue::default()),
            wake: Condvar::new(),
            store,
            persist_failed: AtomicBool::new(false),
        });
        let w = Arc::clone(&writer);
        let handle = std::thread::Builder::new()
            .name("workspace-writer".into())
            .spawn(move || w.run())
            .map_err(Error::Read)?;
        Ok(Self {
            live,
            mu: Mutex::new(()),
            snap: RwLock::new(Arc::new(Snap {
                raw: Arc::new(raw),
                rev: 0,
            })),
            idx: RwLock::new(Arc::new(ix)),
            changed: Signal::default(),
            hook: Mutex::new(None),
            hook_mu: Mutex::new(()),
            writer,
            writer_thread: Mutex::new(Some(handle)),
            load_err,
        })
    }

    /// 색인이 바뀐 뒤(매 Save) 동기로 부를 훅을 건다. 훅은 내부 잠금 밖에서 rev 순서로 불린다.
    /// 훅 안에서 Save 를 부르면 막힌다.
    pub fn set_on_index_update(&self, hook: impl Fn() + Send + Sync + 'static) {
        *lock(&self.hook) = Some(Arc::new(hook));
    }

    /// 마지막 비동기 쓰기의 분류다 — `""`(정상) 또는 [`PERSIST_FAILED`] (FR-VHL-10).
    pub fn persist_err(&self) -> &'static str {
        if self.writer.persist_failed.load(Ordering::SeqCst) {
            PERSIST_FAILED
        } else {
            ""
        }
    }

    /// 기동 시 적재가 어땠는지다 — `""` · [`LOAD_RESTORED`] · [`LOAD_EMPTY`]. 경로를 담지 않는다.
    pub fn load_err(&self) -> &'static str {
        self.load_err
    }

    /// 남은 쓰기를 내린 뒤 쓰기 스레드를 멈춘다. 여러 번 불러도 된다. 그 뒤의 Save 는
    /// 메모리 판만 바꾸고 디스크에 닿지 않는다.
    pub fn close(&self) {
        let Some(handle) = lock(&self.writer_thread).take() else {
            return;
        };
        lock(&self.writer.queue).closed = true;
        self.writer.wake.notify_one();
        let _ = handle.join();
    }

    fn snap(&self) -> Arc<Snap> {
        Arc::clone(&self.snap.read().unwrap_or_else(PoisonError::into_inner))
    }

    pub(crate) fn index(&self) -> Arc<Index> {
        Arc::clone(&self.idx.read().unwrap_or_else(PoisonError::into_inner))
    }

    /// 같은 Save 트랜잭션의 (raw, rev) 짝이다. rev=0 은 Save 가 없었다는 뜻이다.
    pub fn snapshot(&self) -> (Arc<Vec<u8>>, u64) {
        let s = self.snap();
        (Arc::clone(&s.raw), s.rev)
    }

    pub fn current_rev(&self) -> u64 {
        self.snap().rev
    }

    pub fn raw(&self) -> Arc<Vec<u8>> {
        Arc::clone(&self.snap().raw)
    }

    /// blob 을 새 판으로 삼는다. `if_match` 가 비어 있지 않으면 지금 rev 와 같아야 한다.
    /// 디스크 쓰기는 기다리지 않는다.
    pub fn save(&self, blob: &[u8], if_match: &str) -> Result<u64, Error> {
        let g = lock(&self.mu);
        let cur_snap = self.snap();
        let cur = cur_snap.rev;
        if !if_match.is_empty() && parse_uint(if_match) != Some(cur) {
            return Err(Error::Stale);
        }
        // FR-OPT-5-1: 바이트가 같으면 무동작이다 — rev 도, 쓰기도, 훅도 없다. 단 메모리 판이
        // 디스크에 있다고 믿을 수 있을 때만이다 (세대에서 되살린 판, 마지막 쓰기 실패는 제외).
        if !cur_snap.raw.is_empty()
            && cur_snap.raw.as_slice() == blob
            && (cur > 0 || self.load_err.is_empty())
            && self.persist_err().is_empty()
        {
            return Ok(cur);
        }
        let ix = build_index(blob).map_err(|e| Error::Parse(Box::new(e)))?;
        let buf = Arc::new(blob.to_vec());
        let new_rev = cur + 1;
        *self.snap.write().unwrap_or_else(PoisonError::into_inner) = Arc::new(Snap {
            raw: Arc::clone(&buf),
            rev: new_rev,
        });
        *self.idx.write().unwrap_or_else(PoisonError::into_inner) = Arc::new(ix);
        self.changed.notify();
        self.writer.enqueue(buf);
        let Some(hook) = lock(&self.hook).clone() else {
            return Ok(new_rev);
        };
        // 잠금 순서는 mu → hook_mu 다. rev 순서가 곧 훅 호출 순서이고, mu 는 훅이 도는
        // 동안 풀려 있다 (M8 `GO-34`).
        let hg = lock(&self.hook_mu);
        drop(g);
        hook();
        drop(hg);
        Ok(new_rev)
    }

    /// 다음 색인 교체에 울릴 구독이다 (FR-OPT-8-4).
    pub fn changes(&self) -> Changed {
        self.changed.c()
    }

    pub fn entries(&self) -> Vec<TabEntry> {
        self.index().entries.clone()
    }

    /// 지금 저장된 Window 들이다 (FR-SBX-9).
    pub fn windows(&self) -> Vec<WindowInfo> {
        windows_of(&self.raw())
    }

    /// toolId → 좌표 라벨. 복사본이다.
    pub fn labels(&self) -> HashMap<String, String> {
        self.index().labels.clone()
    }

    /// 지금 workspace 에 있는 탭 id 집합이다. 복사본이다.
    pub fn tab_ids(&self) -> HashSet<String> {
        self.index().tab_ids.clone()
    }
}

/// Go `strconv.ParseUint(s, 10, 64)`: 부호를 받지 않는다.
fn parse_uint(s: &str) -> Option<u64> {
    if s.bytes().all(|b| b.is_ascii_digit()) {
        s.parse().ok()
    } else {
        None
    }
}

impl Drop for Manager {
    fn drop(&mut self) {
        self.close();
    }
}

#[cfg(test)]
mod tests;
