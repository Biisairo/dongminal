//! 저장소 트리의 재귀 감시 (PERF M4 설계 §1 S1, D-61). git 감시가 작업 트리 변화로 status 를
//! 당기는 데 쓴다. 화면 감시(`Manager`)와 달리 디렉터리마다 감시를 걸지 않고 트리 하나를 통째로 본다.
//!
//! - macOS: FSEvents. notify 의 FSEvents 감시자는 이 crate 가 켜는 `macos_kqueue` 기능과 함께 쓸 수
//!   없어(같은 빌드에서 하나만 선다) CoreServices 를 직접 부른다. kqueue 는 파일마다 fd 를 열어
//!   트리 전체 감시에 맞지 않는다.
//! - Linux: notify 의 inotify 재귀 감시. 감시 한도(`max_user_watches`)에 걸리면 세우지 못한다.
//! - 그 밖(Windows 포함): 세우지 않는다 — 감시 핸들이 디렉터리 이름 변경을 막는다 (D-8).
//!
//! 세우지 못하거나 사건을 놓치면(`TreeMsg::Lost`) 쓰는 쪽이 주기로 물러선다.

use std::sync::Arc;
use std::sync::mpsc::{self, Receiver};

/// 감시가 알리는 것이다.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TreeMsg {
    /// 이 경로들이 바뀌었다. 디렉터리 단위일 수 있다.
    Paths(Vec<String>),
    /// 사건을 놓쳤다(넘침) — 감시를 더는 믿을 수 없다.
    Lost,
}

pub type TreeSink = Arc<dyn Fn(TreeMsg) + Send + Sync>;

/// 감시 하나다. 버리면 멈춘다.
pub struct TreeWatch {
    _inner: imp::Inner,
}

/// `root` 아래 전체를 감시한다. 사건은 전용 스레드에서 `sink` 로 간다 — 그 스레드에서 이 감시를
/// 버려도 된다. OS 는 실제 경로(심링크를 푼 것, 예: macOS `/tmp` → `/private/tmp`)로 알리므로
/// 경로를 `root` 아래로 되돌려 넘긴다.
pub fn watch_tree(root: &str, sink: TreeSink) -> Result<TreeWatch, String> {
    let real = std::fs::canonicalize(root)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| root.to_owned());
    let (tx, rx) = mpsc::channel();
    let inner = imp::start(&real, tx)?;
    let root = root.to_owned();
    let sink: TreeSink = if real == root {
        sink
    } else {
        Arc::new(move |m| match m {
            TreeMsg::Paths(p) => sink(TreeMsg::Paths(
                p.into_iter().map(|x| under_root(x, &real, &root)).collect(),
            )),
            TreeMsg::Lost => sink(TreeMsg::Lost),
        })
    };
    std::thread::spawn(move || forward(&rx, &sink));
    Ok(TreeWatch { _inner: inner })
}

/// `real` 아래 경로를 `root` 아래 경로로 바꾼다. 그 밖의 경로는 그대로다.
fn under_root(p: String, real: &str, root: &str) -> String {
    match p.strip_prefix(real) {
        Some(rest) if rest.is_empty() || rest.starts_with(std::path::MAIN_SEPARATOR) => {
            format!("{root}{rest}")
        }
        _ => p,
    }
}

/// 쌓인 사건을 한 번에 넘긴다. 보내는 쪽이 모두 닫히면 끝난다.
fn forward(rx: &Receiver<TreeMsg>, sink: &TreeSink) {
    while let Ok(first) = rx.recv() {
        let mut lost = false;
        let mut paths = Vec::new();
        for m in std::iter::once(first).chain(rx.try_iter()) {
            match m {
                TreeMsg::Lost => lost = true,
                TreeMsg::Paths(p) => paths.extend(p),
            }
        }
        if lost {
            sink(TreeMsg::Lost);
        } else if !paths.is_empty() {
            sink(TreeMsg::Paths(paths));
        }
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use std::ffi::{CStr, c_char, c_void};
    use std::sync::mpsc::Sender;

    use super::TreeMsg;

    type CFIndex = isize;
    type CFRef = *const c_void;
    type StreamRef = *mut c_void;
    type Queue = *mut c_void;
    type Callback =
        extern "C" fn(*const c_void, *mut c_void, usize, *mut c_void, *const u32, *const u64);

    #[repr(C)]
    struct StreamContext {
        version: CFIndex,
        info: *mut c_void,
        retain: Option<extern "C" fn(*const c_void) -> *const c_void>,
        release: Option<extern "C" fn(*const c_void)>,
        copy_description: Option<extern "C" fn(*const c_void) -> CFRef>,
    }

    #[repr(C)]
    struct ArrayCallBacks {
        version: CFIndex,
        retain: *const c_void,
        release: *const c_void,
        copy_description: *const c_void,
        equal: *const c_void,
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        static kCFTypeArrayCallBacks: ArrayCallBacks;
        fn CFStringCreateWithBytes(
            alloc: CFRef,
            bytes: *const u8,
            len: CFIndex,
            encoding: u32,
            external: u8,
        ) -> CFRef;
        fn CFArrayCreate(
            alloc: CFRef,
            values: *const CFRef,
            len: CFIndex,
            callbacks: *const ArrayCallBacks,
        ) -> CFRef;
        fn CFRelease(r: CFRef);
    }

    #[link(name = "CoreServices", kind = "framework")]
    unsafe extern "C" {
        fn FSEventStreamCreate(
            alloc: CFRef,
            callback: Callback,
            context: *mut StreamContext,
            paths: CFRef,
            since: u64,
            latency: f64,
            flags: u32,
        ) -> StreamRef;
        fn FSEventStreamSetDispatchQueue(s: StreamRef, q: Queue);
        fn FSEventStreamStart(s: StreamRef) -> u8;
        fn FSEventStreamStop(s: StreamRef);
        fn FSEventStreamInvalidate(s: StreamRef);
        fn FSEventStreamRelease(s: StreamRef);
    }

    // libdispatch 는 libSystem 에 있다.
    unsafe extern "C" {
        fn dispatch_queue_create(label: *const c_char, attr: *const c_void) -> Queue;
        fn dispatch_release(o: *mut c_void);
    }

    const UTF8: u32 = 0x0800_0100;
    const SINCE_NOW: u64 = u64::MAX;
    /// 사건을 모아 넘기는 창(초)이다. 계기 관측의 debounce(1초)가 그 위에서 다시 모은다.
    const LATENCY_SECS: f64 = 0.3;
    /// 디렉터리 단위 사건이다 — 파일 단위(`FileEvents`)보다 사건이 적고, 계기에는 그것으로 충분하다.
    const CREATE_FLAGS: u32 = 0;
    /// MustScanSubDirs·UserDropped·KernelDropped — 사건을 놓쳤다.
    const LOST_FLAGS: u32 = 0x1 | 0x2 | 0x4;
    const QUEUE_LABEL: &CStr = c"otterminal.gitwatch.fsevents";
    const NETWORK_VOLUME_PREFIX: &str = "/Volumes/";

    pub(super) struct Inner {
        stream: StreamRef,
        queue: Queue,
    }

    // SAFETY: 스트림과 큐는 CoreServices·libdispatch 가 스레드 안전하게 다룬다. 이 값은 멈추고
    // 놓는 데만 쓴다.
    unsafe impl Send for Inner {}

    extern "C" fn on_events(
        _s: *const c_void,
        info: *mut c_void,
        n: usize,
        paths: *mut c_void,
        flags: *const u32,
        _ids: *const u64,
    ) {
        // SAFETY: info 는 start 가 넘긴 Box<Sender> 이고 release_info 전까지 살아 있다. paths 는
        // C 문자열 n 개, flags 는 n 개다 (CreateFlags 에 UseCFTypes 가 없다).
        let (tx, paths, flags) = unsafe {
            (
                &*(info as *const Sender<TreeMsg>),
                std::slice::from_raw_parts(paths as *const *const c_char, n),
                std::slice::from_raw_parts(flags, n),
            )
        };
        if flags.iter().any(|f| f & LOST_FLAGS != 0) {
            let _ = tx.send(TreeMsg::Lost);
            return;
        }
        let out = paths
            .iter()
            // SAFETY: 각 항목은 NUL 로 끝나는 경로다.
            .map(|p| unsafe { CStr::from_ptr(*p) }.to_string_lossy().into_owned())
            .collect();
        let _ = tx.send(TreeMsg::Paths(out));
    }

    extern "C" fn release_info(info: *const c_void) {
        // SAFETY: 스트림이 풀릴 때 한 번 불린다. start 가 Box::into_raw 로 넘긴 값이다.
        drop(unsafe { Box::from_raw(info as *mut Sender<TreeMsg>) });
    }

    pub(super) fn start(root: &str, tx: Sender<TreeMsg>) -> Result<Inner, String> {
        // 네트워크 공유에는 FSEvents 가 오지 않는다 (VS Code `nodejsWatcherLib.ts`).
        if root.starts_with(NETWORK_VOLUME_PREFIX) {
            return Err(format!("fsevents: network volume {root}"));
        }
        let info = Box::into_raw(Box::new(tx)).cast::<c_void>();
        let mut ctx = StreamContext {
            version: 0,
            info,
            retain: None,
            release: Some(release_info),
            copy_description: None,
        };
        // SAFETY: 인자는 모두 이 함수 안에서 만든 유효한 CF 객체·포인터다. 스트림은 ctx 를 복사하고
        // info 는 스트림이 풀릴 때 release_info 가 거둔다. 만들기에 실패하면 info 를 여기서 거둔다.
        unsafe {
            let s = CFStringCreateWithBytes(
                std::ptr::null(),
                root.as_ptr(),
                root.len() as CFIndex,
                UTF8,
                0,
            );
            if s.is_null() {
                release_info(info);
                return Err(format!("fsevents: bad path {root}"));
            }
            let arr = CFArrayCreate(std::ptr::null(), &s, 1, &raw const kCFTypeArrayCallBacks);
            CFRelease(s);
            if arr.is_null() {
                release_info(info);
                return Err("fsevents: CFArrayCreate failed".into());
            }
            let stream = FSEventStreamCreate(
                std::ptr::null(),
                on_events,
                &mut ctx,
                arr,
                SINCE_NOW,
                LATENCY_SECS,
                CREATE_FLAGS,
            );
            CFRelease(arr);
            if stream.is_null() {
                release_info(info);
                return Err(format!("fsevents: cannot watch {root}"));
            }
            let queue = dispatch_queue_create(QUEUE_LABEL.as_ptr(), std::ptr::null());
            FSEventStreamSetDispatchQueue(stream, queue);
            let inner = Inner { stream, queue };
            if FSEventStreamStart(stream) == 0 {
                return Err(format!("fsevents: cannot start {root}"));
            }
            Ok(inner)
        }
    }

    impl Drop for Inner {
        fn drop(&mut self) {
            // SAFETY: start 가 만든 스트림과 큐를 한 번만 멈추고 놓는다. 멈추지 않은 스트림의 Stop 도
            // 허용된다.
            unsafe {
                FSEventStreamStop(self.stream);
                FSEventStreamInvalidate(self.stream);
                FSEventStreamRelease(self.stream);
                dispatch_release(self.queue);
            }
        }
    }
}

#[cfg(target_os = "linux")]
mod imp {
    use std::path::Path;
    use std::sync::mpsc::Sender;

    use notify::{RecursiveMode, Watcher};

    use super::TreeMsg;

    pub(super) struct Inner {
        _w: notify::RecommendedWatcher,
    }

    pub(super) fn start(root: &str, tx: Sender<TreeMsg>) -> Result<Inner, String> {
        let mut w = notify::RecommendedWatcher::new(
            move |r: notify::Result<notify::Event>| {
                let m = match r {
                    Ok(ev) if !ev.need_rescan() => TreeMsg::Paths(
                        ev.paths
                            .iter()
                            .map(|p| p.to_string_lossy().into_owned())
                            .collect(),
                    ),
                    _ => TreeMsg::Lost,
                };
                let _ = tx.send(m);
            },
            notify::Config::default(),
        )
        .map_err(|e| e.to_string())?;
        w.watch(Path::new(root), RecursiveMode::Recursive)
            .map_err(|e| e.to_string())?;
        Ok(Inner { _w: w })
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
mod imp {
    use std::sync::mpsc::Sender;

    use super::TreeMsg;

    pub(super) struct Inner;

    pub(super) fn start(root: &str, _tx: Sender<TreeMsg>) -> Result<Inner, String> {
        Err(format!("tree watch unsupported on this OS: {root}"))
    }
}

#[cfg(test)]
mod tests;
