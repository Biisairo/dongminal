//! 서버(dongminal) 연결 하나 — 요청 읽기, 응답·push 쓰기 큐, 느린 요청의 분리 (DAEMON_SPLIT_SRS FR-14).

use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Write};
use std::net::Shutdown;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender, TrySendError};
use std::sync::{Arc, Mutex, Weak};
use std::thread;

use dm_gocompat::json;
use dm_shared_dmlog::warnf;
use dm_shared_platform::IpcStream;
use dm_shared_toolhub::ToolManager;
use dm_shared_toolipc::{self as ipc, PanedRequest};
use serde::Serialize;
use tokio::runtime::Handle;
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;

use crate::handlers::{self, Line};
use crate::server::Inner;

/// 쓰기 큐의 길이다. 출력 push 는 가득 차면 버리고, 응답은 기다린다.
pub const PANED_OUT_QUEUE: usize = 1024;
/// create·restore 를 동시에 돌리는 상한이다 (FR-OPT-2-3).
pub const PANED_SLOW_MAX: usize = 4;
/// edge·chat(kill/kick) 을 동시에 돌리는 상한이다.
pub const PANED_EDGE_SLOW_MAX: usize = 2;
/// 도구별 입력 줄의 상한이다.
pub const SERIAL_QUEUE_MAX: usize = 256;
/// output 떨어뜨림은 첫 건과 이 수의 배수마다 한 줄 적는다.
const DROP_LOG_EVERY: i64 = 256;

pub(crate) type Task = Box<dyn FnOnce() + Send>;

pub(crate) struct Conn {
    stream: Arc<IpcStream>,
    pub pm: Arc<ToolManager>,
    pub rt: Handle,
    out: Mutex<Option<SyncSender<Vec<u8>>>>,
    pub done: CancellationToken,
    stopped: AtomicBool,
    dropped: AtomicI64,
    slow: Arc<Semaphore>,
    edge_slow: Arc<Semaphore>,
    tool_queue: Arc<SerialQueue>,
    pub build: String,
    pub reports: AtomicBool,
    pub attention: AtomicBool,
    pub edge: AtomicBool,
    pub chat: AtomicBool,
    pub srv: Weak<Inner>,
}

pub(crate) fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

impl Conn {
    pub fn new(
        stream: IpcStream,
        pm: Arc<ToolManager>,
        rt: Handle,
        build: String,
        srv: Weak<Inner>,
    ) -> Arc<Self> {
        let (tx, rx) = mpsc::sync_channel(PANED_OUT_QUEUE);
        let c = Arc::new(Self {
            stream: Arc::new(stream),
            pm,
            rt,
            out: Mutex::new(Some(tx)),
            done: CancellationToken::new(),
            stopped: AtomicBool::new(false),
            dropped: AtomicI64::new(0),
            slow: Arc::new(Semaphore::new(PANED_SLOW_MAX)),
            edge_slow: Arc::new(Semaphore::new(PANED_EDGE_SLOW_MAX)),
            tool_queue: Arc::default(),
            build,
            reports: AtomicBool::new(false),
            attention: AtomicBool::new(false),
            edge: AtomicBool::new(false),
            chat: AtomicBool::new(false),
            srv,
        });
        let w = Arc::clone(&c);
        if thread::Builder::new()
            .name("paned-write".into())
            .spawn(move || w.write_loop(rx))
            .is_err()
        {
            c.stop();
        }
        c
    }

    fn write_loop(&self, rx: Receiver<Vec<u8>>) {
        while let Ok(b) = rx.recv() {
            if (&*self.stream).write_all(&b).is_err() {
                self.stop();
                return;
            }
        }
    }

    /// 연결을 한 번만 끝낸다. 쓰기 큐를 닫아 쓰기 스레드와 기다리는 쪽을 깨운다.
    pub fn stop(&self) {
        if self.stopped.swap(true, Ordering::SeqCst) {
            return;
        }
        self.done.cancel();
        lock(&self.out).take();
        let _ = self.stream.shutdown(Shutdown::Both);
    }

    pub fn is_done(&self) -> bool {
        self.done.is_cancelled()
    }

    /// 한 줄을 쓰기 큐에 넣는다. droppable(출력 push)은 가득 차면 버리고 센다. 나머지는 자리가 날
    /// 때까지 기다리되, 연결이 끝나면 그만둔다.
    pub fn enqueue<T: Serialize + ?Sized>(&self, v: &T, droppable: bool) {
        if self.stopped.load(Ordering::SeqCst) {
            return;
        }
        let Ok(b) = json::Encoder::new().encode(v) else {
            return;
        };
        self.enqueue_line(b, droppable);
    }

    pub fn enqueue_line(&self, b: Line, droppable: bool) {
        let Some(tx) = lock(&self.out).clone() else {
            return;
        };
        if !droppable {
            let _ = tx.send(b);
            return;
        }
        if let Err(TrySendError::Full(_)) = tx.try_send(b) {
            let n = self.dropped.fetch_add(1, Ordering::SeqCst) + 1;
            if n == 1 || n % DROP_LOG_EVERY == 0 {
                warnf!(
                    None,
                    "paned: output backpressure — dropped {n} chunks (slow dongminal?)"
                );
            }
        }
    }

    /// 요청을 읽어 차례로 나눈다. 읽기 오류(형식 오류 포함)면 연결을 끝낸다.
    pub fn handle(self: &Arc<Self>) -> std::io::Result<()> {
        let mut r = BufReader::new(&*self.stream);
        let mut line = Vec::new();
        let res = loop {
            line.clear();
            match r.read_until(b'\n', &mut line) {
                Ok(0) => break Err(std::io::Error::from(std::io::ErrorKind::UnexpectedEof)),
                Ok(_) => {}
                Err(e) => break Err(e),
            }
            if line
                .iter()
                .all(|&c| matches!(c, b' ' | b'\t' | b'\r' | b'\n'))
            {
                continue;
            }
            let req: PanedRequest = match json::Decoder::new().decode(&line) {
                Ok(r) => r,
                Err(e) => break Err(std::io::Error::new(std::io::ErrorKind::InvalidData, e)),
            };
            if self.is_done() {
                break Ok(());
            }
            self.dispatch(req);
        };
        self.stop();
        res
    }

    fn dispatch(self: &Arc<Self>, req: PanedRequest) {
        let resp = match req.method.as_str() {
            ipc::METHOD_HELLO => handlers::hello(self, &req),
            ipc::METHOD_CREATE => {
                return self.go_slow(false, move |c| handlers::create(c, &req));
            }
            ipc::METHOD_RESTORE => {
                return self.go_slow(false, move |c| handlers::restore(c, &req));
            }
            ipc::METHOD_EDGE => {
                let c = Arc::clone(self);
                return self.go_edge(async move { handlers::edge_op(&c, &req).await });
            }
            ipc::METHOD_EDGE_PORT => handlers::edge_port(self, &req),
            ipc::METHOD_CHAT => {
                if handlers::chat_slow(&req) {
                    return self.go_slow(true, move |c| handlers::chat_op(c, &req));
                }
                handlers::chat_op(self, &req)
            }
            ipc::METHOD_KILL => handlers::kill(self, &req),
            ipc::METHOD_TERMINATE => {
                let c = Arc::clone(self);
                self.rt.spawn(async move {
                    let line = handlers::terminate(&c, &req).await;
                    let c2 = Arc::clone(&c);
                    let _ = tokio::task::spawn_blocking(move || c2.enqueue_line(line, false)).await;
                });
                return;
            }
            ipc::METHOD_WRITE => {
                let id = handlers::tool_of(&req);
                if !id.is_empty() && self.tool_queue.busy(&id) {
                    let c = Arc::clone(self);
                    let r = req.clone();
                    if self.run_queued(&id, move || {
                        if !c.is_done() {
                            c.enqueue_line(handlers::write(&c, &r), false);
                        }
                    }) {
                        return;
                    }
                    handlers::queue_full(&req)
                } else {
                    handlers::write(self, &req)
                }
            }
            ipc::METHOD_PASTE => match handlers::decode::<ipc::PasteParams>(&req) {
                Err(line) => line,
                Ok(p) => {
                    let c = Arc::clone(self);
                    let id = p.id.clone();
                    let r = req.clone();
                    if self.run_queued(&id, move || {
                        if !c.is_done() {
                            let line = c.rt.block_on(handlers::paste_with(&c, &r, &p));
                            c.enqueue_line(line, false);
                        }
                    }) {
                        return;
                    }
                    handlers::queue_full(&req)
                }
            },
            ipc::METHOD_RESIZE => handlers::resize(self, &req),
            ipc::METHOD_INPUT => {
                let id = handlers::tool_of(&req);
                if !id.is_empty() && self.tool_queue.busy(&id) {
                    let c = Arc::clone(self);
                    self.run_queued(&id, move || {
                        if !c.is_done() {
                            handlers::input(&c, &req);
                        }
                    });
                    return;
                }
                handlers::input(self, &req);
                return;
            }
            ipc::METHOD_RESIZE_NOTIFY => {
                handlers::resize_notify(self, &req);
                return;
            }
            ipc::METHOD_LIST => handlers::list(self, &req),
            ipc::METHOD_SNAPSHOT => handlers::snapshot(self, &req),
            ipc::METHOD_CWD => handlers::cwd(self, &req),
            ipc::METHOD_BUSY => handlers::busy(self, &req),
            ipc::METHOD_BUSY_MANY => handlers::busy_many(self, &req),
            ipc::METHOD_SHELL_PROBE => handlers::shell_probe(self, &req),
            ipc::METHOD_SET_BACKGROUND => handlers::set_background(self, &req),
            ipc::METHOD_BACKGROUND_LIST => handlers::background_list(self, &req),
            ipc::METHOD_RECORD_SET => handlers::record_set(self, &req),
            ipc::METHOD_RECORDS => handlers::records_snapshot(self, &req),
            ipc::METHOD_ATTN_CONFIG => handlers::attn_config(self, &req),
            ipc::METHOD_ATTEND => handlers::attend(self, &req),
            ipc::METHOD_ATTEND_ALL => handlers::ok(
                req.id,
                &ipc::AttendAllResult {
                    cleared: self.pm.clear_all_attention(),
                },
            ),
            ipc::METHOD_REPORT => handlers::report(self, &req),
            _ => handlers::err_msg(
                req.id,
                ipc::CODE_METHOD_NOT_FOUND,
                &format!("unknown method: {}", req.method),
            ),
        };
        self.enqueue_line(resp, false);
    }

    /// 느린 요청을 읽기 루프 밖에서 돌린다. 동시 수는 상한까지이고, 자리를 기다리다 연결이 끝나면
    /// 그만둔다.
    fn go_slow(self: &Arc<Self>, edge: bool, f: impl FnOnce(&Arc<Self>) -> Line + Send + 'static) {
        let sem = Arc::clone(if edge { &self.edge_slow } else { &self.slow });
        let c = Arc::clone(self);
        self.rt.spawn(async move {
            let permit = tokio::select! {
                p = sem.acquire_owned() => p,
                () = c.done.cancelled() => return,
            };
            let _ = tokio::task::spawn_blocking(move || {
                let line = f(&c);
                c.enqueue_line(line, false);
                drop(permit);
            })
            .await;
        });
    }

    fn go_edge(self: &Arc<Self>, fut: impl std::future::Future<Output = Line> + Send + 'static) {
        let sem = Arc::clone(&self.edge_slow);
        let c = Arc::clone(self);
        self.rt.spawn(async move {
            let permit = tokio::select! {
                p = sem.acquire_owned() => p,
                () = c.done.cancelled() => return,
            };
            let line = fut.await;
            let _ = tokio::task::spawn_blocking(move || {
                c.enqueue_line(line, false);
                drop(permit);
            })
            .await;
        });
    }

    fn run_queued(&self, key: &str, f: impl FnOnce() + Send + 'static) -> bool {
        SerialQueue::run(&self.tool_queue, key, Box::new(f))
    }

    #[cfg(test)]
    pub fn dropped(&self) -> i64 {
        self.dropped.load(Ordering::SeqCst)
    }

    #[cfg(test)]
    pub fn tool_busy(&self, key: &str) -> bool {
        self.tool_queue.busy(key)
    }
}

/// 도구별 직렬 큐다. 도구 하나의 입력이 순서를 지키고, 한 도구가 밀려도 다른 도구는 서지 않는다.
#[derive(Default)]
pub(crate) struct SerialQueue {
    q: Mutex<HashMap<String, VecDeque<Task>>>,
}

impl SerialQueue {
    /// fn 을 key 의 줄 끝에 넣는다. 줄이 가득 차면 거짓이다.
    pub fn run(me: &Arc<Self>, key: &str, f: Task) -> bool {
        let mut q = lock(&me.q);
        let busy = q.contains_key(key);
        let pending = q.entry(key.to_owned()).or_default();
        if pending.len() >= SERIAL_QUEUE_MAX {
            if !busy {
                q.remove(key);
            }
            return false;
        }
        pending.push_back(f);
        drop(q);
        if !busy {
            let m = Arc::clone(me);
            let k = key.to_owned();
            thread::spawn(move || m.drain(&k));
        }
        true
    }

    pub fn busy(&self, key: &str) -> bool {
        lock(&self.q).contains_key(key)
    }

    fn drain(&self, key: &str) {
        loop {
            let f = {
                let mut q = lock(&self.q);
                match q.get_mut(key).and_then(VecDeque::pop_front) {
                    Some(f) => f,
                    None => {
                        q.remove(key);
                        return;
                    }
                }
            };
            f();
        }
    }
}
