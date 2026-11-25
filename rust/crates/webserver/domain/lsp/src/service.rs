//! 언어 서버 세션 계층: 터널(프레이밍된 stdio 중계), 동시 실행 상한, 유휴 정리, 사용자 경로 표.

use std::collections::{BTreeMap, HashMap};
use std::fmt;
use std::io::{self, BufReader, Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{SyncSender, TrySendError, sync_channel};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, SystemTime};

use otter_gocompat::filepath;
use otter_gocompat::json;
use otter_gocompat::strconv::quote;
use otter_webserver_domain_ext as ext;
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

use crate::codec::{read_frame, write_frame};
use crate::process::{Conn, Starter, start_process};

/// 쓰지 않은 세션을 닫기까지의 시간.
pub const IDLE_AFTER: Duration = Duration::from_secs(20 * 60);
/// 동시에 띄우는 서버 수의 상한.
pub const MAX_SESSIONS: usize = 6;
/// 서버가 다루는 텍스트의 상한 — 편집기 파일 상한과 같다.
pub const MAX_TEXT_BYTES: i64 = otter_shared_editorlimit::FILE_MAX_BYTES;
pub use otter_shared_cadence::LSP_SWEEP_EVERY as SWEEP_EVERY;
/// 끼워 넣기(파일 변경 알림) 줄의 길이.
const TUNNEL_INJECT_QUEUE: usize = 16;

/// 지금 시각. 검사가 바꿔 끼운다.
pub type NowFn = Arc<dyn Fn() -> SystemTime + Send + Sync>;

/// 브라우저와 언어 서버 사이의 중계 하나. 블로킹 API 다 — 소비자는 스레드에서 돌린다.
pub trait Tunnel: Send + Sync {
    /// 프레임 하나를 보낸다.
    fn send(&self, body: &[u8]) -> io::Result<()>;
    /// 프레임 하나를 받는다. 서버가 끝나면 오류다.
    fn recv(&self) -> io::Result<Vec<u8>>;
    /// 서버를 멈추고 세션을 놓는다. 여러 번 불러도 된다.
    fn close(&self);
    /// 마지막으로 주고받은 시각.
    fn last_use(&self) -> SystemTime;
}

/// 터널을 열지 못한 이유.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OpenError {
    /// 동시 실행 상한 (Go `ErrLimit`).
    Limit,
    Other(String),
}

impl fmt::Display for OpenError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            OpenError::Limit => f.write_str("lsp: 동시 실행 상한"),
            OpenError::Other(s) => f.write_str(s),
        }
    }
}

impl std::error::Error for OpenError {}

/// 경로 표를 고치지 못한 이유.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PathsError {
    /// 절대경로가 아니다 (Go `ErrPathNotAbsolute`). 값은 그 경로다.
    NotAbsolute(String),
    /// 저장하지 못했다 (Go `ErrPathsSave`). 값은 원인 문구다.
    Save(String),
}

impl fmt::Display for PathsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            PathsError::NotAbsolute(p) => write!(f, "lsp: 절대경로가 아니다: {}", quote(p)),
            PathsError::Save(e) => write!(f, "lsp: 경로 표를 저장하지 못했다: {e}"),
        }
    }
}

impl std::error::Error for PathsError {}

#[derive(Default, Serialize, Deserialize)]
#[serde(default)]
struct PathsFileBody {
    paths: BTreeMap<String, String>,
}

#[derive(Default)]
struct Inner {
    tunnels: HashMap<u64, Arc<LspTunnel>>,
    next_id: u64,
    pending: usize,
    paths: HashMap<String, String>,
    paths_file: String,
}

#[derive(Default)]
pub(crate) struct State {
    inner: Mutex<Inner>,
}

impl State {
    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub(crate) fn tunnels(&self) -> Vec<Arc<LspTunnel>> {
        self.lock().tunnels.values().cloned().collect()
    }
}

/// LSP 서비스.
pub struct Service {
    pub ext: Option<Arc<ext::Service>>,
    /// 비면 [`start_process`].
    pub start: Option<Starter>,
    /// 비면 실제 시계.
    pub now: Option<NowFn>,
    /// 0 이면 [`IDLE_AFTER`].
    pub idle_after: Duration,
    /// 0 이면 [`MAX_SESSIONS`].
    pub max_sessions: usize,
    /// 0 이면 [`crate::DEFAULT_WATCH_MAX`].
    pub watch_max: usize,
    pub(crate) state: Arc<State>,
    paths_mu: Mutex<()>,
}

impl Service {
    pub fn new(ext: Option<Arc<ext::Service>>) -> Self {
        Self {
            ext,
            start: None,
            now: None,
            idle_after: Duration::ZERO,
            max_sessions: 0,
            watch_max: 0,
            state: Arc::new(State::default()),
            paths_mu: Mutex::new(()),
        }
    }

    fn now_fn(&self) -> NowFn {
        self.now
            .clone()
            .unwrap_or_else(|| Arc::new(SystemTime::now))
    }

    fn limit(&self) -> usize {
        if self.max_sessions == 0 {
            MAX_SESSIONS
        } else {
            self.max_sessions
        }
    }

    /// 서버마다의 관측. 사용자 경로 표를 실어 판정한다 (FR-LSP-4b).
    pub fn status(&self) -> (Vec<ext::Status>, Vec<String>) {
        match &self.ext {
            Some(e) => e.status(&self.paths()),
            None => (Vec::new(), Vec::new()),
        }
    }

    /// 팩 하나를 조달한다.
    pub async fn install(&self, ctx: &ext::Ctx, pack_id: &str) -> ext::Outcome {
        match &self.ext {
            Some(e) => e.install(ctx, pack_id).await,
            None => ext::Outcome {
                reason: "플러그인 계층이 배선되지 않았습니다".to_owned(),
                ..ext::Outcome::default()
            },
        }
    }

    /// 서술자 id(팩/서버)의 서버를 root 에서 띄우고 터널을 연다.
    pub fn open_tunnel(&self, root: &str, desc_id: &str) -> Result<Arc<dyn Tunnel>, OpenError> {
        let other = |s: String| Err(OpenError::Other(s));
        if root.is_empty() {
            return other("루트가 없습니다".to_owned());
        }
        let Some(e) = &self.ext else {
            return other("플러그인 계층이 배선되지 않았습니다".to_owned());
        };
        let Some((srv, st)) = e.resolve_id(desc_id, &self.paths()) else {
            return other(format!("모르는 언어 서버입니다: {}", quote(desc_id)));
        };
        if !st.found {
            return other(format!(
                "{} 가 없어 코드 탐색을 할 수 없습니다 — {} (설정 ▸ Code)",
                srv.exe,
                ext::missing_text(&st)
            ));
        }
        {
            let mut g = self.state.lock();
            if g.tunnels.len() + g.pending >= self.limit() {
                return Err(OpenError::Limit);
            }
            g.pending += 1;
        }
        let started = match &self.start {
            Some(s) => s(&st.exe, &srv.args, root),
            None => start_process(&st.exe, &srv.args, root),
        };
        let mut g = self.state.lock();
        g.pending -= 1;
        let conn = match started {
            Ok(c) => c,
            Err(err) => {
                return other(format!(
                    "lsp: {desc_id} 를 띄우지 못했습니다: {}",
                    otter_gocompat::oserr::go_error_string(&err)
                ));
            }
        };
        let id = g.next_id;
        g.next_id += 1;
        let t = LspTunnel::new(
            id,
            Arc::clone(&self.state),
            root,
            desc_id,
            self.now_fn(),
            conn,
        );
        g.tunnels.insert(id, Arc::clone(&t));
        Ok(t)
    }

    /// 유휴 세션을 닫는다.
    pub fn sweep(&self) {
        let after = if self.idle_after.is_zero() {
            IDLE_AFTER
        } else {
            self.idle_after
        };
        let cut = (self.now_fn())() - after;
        for t in self.state.tunnels() {
            if t.last_use() < cut {
                t.close();
            }
        }
    }

    /// [`SWEEP_EVERY`] 마다 [`Service::sweep`] 한다. token 이 취소되면 끝난다.
    pub async fn run_sweeper(self: Arc<Self>, token: CancellationToken) {
        let mut tick =
            tokio::time::interval_at(tokio::time::Instant::now() + SWEEP_EVERY, SWEEP_EVERY);
        loop {
            tokio::select! {
                _ = token.cancelled() => return,
                _ = tick.tick() => {
                    let me = Arc::clone(&self);
                    let _ = tokio::task::spawn_blocking(move || me.sweep()).await;
                }
            }
        }
    }

    /// 모든 세션을 닫는다.
    pub fn shutdown(&self) {
        for t in self.state.tunnels() {
            t.close();
        }
    }

    /// 경로 표 파일을 읽는다. 없으면 빈 표다. 절대경로가 아닌 값은 경고하고 버린다.
    pub fn load_paths(&self, file: &str) -> Result<(), String> {
        let _g = self.paths_mu.lock().unwrap_or_else(|e| e.into_inner());
        self.state.lock().paths_file = file.to_owned();
        let raw = match std::fs::read(file) {
            Ok(r) => r,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(e) => {
                let e = otter_gocompat::oserr::path_error("open", file, e);
                return Err(otter_gocompat::oserr::go_error_string(&e));
            }
        };
        let body: Option<PathsFileBody> =
            json::unmarshal(&raw).map_err(|e| format!("{file}: {e}"))?;
        let mut paths = HashMap::new();
        for (k, v) in body.unwrap_or_default().paths {
            if !filepath::is_abs(&v) {
                otter_shared_otterlog::warnf!(
                    None,
                    "lsp: 경로 표 {file} 의 {} 값 {} 는 절대경로가 아니어서 무시한다",
                    quote(&k),
                    quote(&v)
                );
                continue;
            }
            paths.insert(k, v);
        }
        self.state.lock().paths = paths;
        Ok(())
    }

    /// 지금 경로 표의 사본.
    pub fn paths(&self) -> HashMap<String, String> {
        self.state.lock().paths.clone()
    }

    /// 경로 표를 바꾼다. 모르는 키와 빈 값은 버리고, 절대경로가 아니면 거절한다. 바뀐 서술자의
    /// 세션은 닫는다 — 다음 열기가 새 경로로 뜬다.
    pub fn set_paths(
        &self,
        next: &HashMap<String, String>,
    ) -> Result<HashMap<String, String>, PathsError> {
        let known = self
            .ext
            .as_ref()
            .map(|e| e.server_ids())
            .unwrap_or_default();
        let mut clean = BTreeMap::new();
        for (k, v) in next {
            if !known.contains(k) || v.is_empty() {
                continue;
            }
            if !filepath::is_abs(v) {
                return Err(PathsError::NotAbsolute(v.clone()));
            }
            clean.insert(k.clone(), v.clone());
        }
        let _g = self.paths_mu.lock().unwrap_or_else(|e| e.into_inner());
        let file = self.state.lock().paths_file.clone();
        if !file.is_empty() {
            let body = PathsFileBody {
                paths: clean.clone(),
            };
            let saved = json::marshal_indent(&body, "", "  ")
                .map_err(|e| e.to_string())
                .and_then(|data| {
                    otter_shared_platform::write_state_file(
                        std::path::Path::new(&file),
                        &data,
                        0o644,
                    )
                    .map_err(|e| otter_gocompat::oserr::go_error_string(&e))
                });
            saved.map_err(PathsError::Save)?;
        }
        let stop: Vec<Arc<LspTunnel>> = {
            let mut g = self.state.lock();
            let mut changed: Vec<&String> = clean
                .iter()
                .filter(|(k, v)| g.paths.get(*k) != Some(*v))
                .map(|(k, _)| k)
                .collect();
            let removed: Vec<String> = g
                .paths
                .keys()
                .filter(|k| !clean.contains_key(*k))
                .cloned()
                .collect();
            changed.extend(removed.iter());
            let stop = g
                .tunnels
                .values()
                .filter(|t| changed.iter().any(|k| **k == t.desc))
                .cloned()
                .collect();
            g.paths = clean.into_iter().collect();
            stop
        };
        for t in stop {
            t.close();
        }
        Ok(self.paths())
    }
}

/// 루트 아래(같거나 안)인가.
pub(crate) fn under_root(root: &str, path: &str) -> bool {
    if path.is_empty() {
        return false;
    }
    let mut r = filepath::clean(root);
    let p = filepath::clean(path);
    if p == r {
        return true;
    }
    let sep = filepath::SEPARATOR.to_string();
    if !r.ends_with(&sep) {
        r.push_str(&sep);
    }
    p.starts_with(&r)
}

pub(crate) struct LspTunnel {
    id: u64,
    state: Arc<State>,
    pub(crate) root: String,
    pub(crate) desc: String,
    now: NowFn,
    writer: Arc<Mutex<Option<Box<dyn Write + Send>>>>,
    reader: Mutex<BufReader<Box<dyn Read + Send>>>,
    stop: Mutex<Option<Box<dyn FnOnce() + Send>>>,
    last_use: Mutex<SystemTime>,
    pub(crate) ready: AtomicBool,
    injq: Mutex<Option<SyncSender<Vec<u8>>>>,
}

fn closed_pipe() -> io::Error {
    io::Error::new(io::ErrorKind::BrokenPipe, "file already closed")
}

impl LspTunnel {
    fn new(
        id: u64,
        state: Arc<State>,
        root: &str,
        desc: &str,
        now: NowFn,
        conn: Conn,
    ) -> Arc<Self> {
        let (tx, rx) = sync_channel::<Vec<u8>>(TUNNEL_INJECT_QUEUE);
        let writer = Arc::new(Mutex::new(Some(conn.writer)));
        let t = Arc::new(Self {
            id,
            state,
            root: root.to_owned(),
            desc: desc.to_owned(),
            last_use: Mutex::new(now()),
            now,
            writer: Arc::clone(&writer),
            reader: Mutex::new(BufReader::new(conn.reader)),
            stop: Mutex::new(Some(conn.stop)),
            ready: AtomicBool::new(false),
            injq: Mutex::new(Some(tx)),
        });
        let root = t.root.clone();
        std::thread::spawn(move || {
            // 닫히면 보내는 쪽이 사라져 끝난다.
            while let Ok(b) = rx.recv() {
                let mut w = writer.lock().unwrap_or_else(|e| e.into_inner());
                let r = match w.as_mut() {
                    Some(w) => write_frame(w.as_mut(), &b).and_then(|()| w.flush()),
                    None => Err(closed_pipe()),
                };
                if let Err(e) = r {
                    otter_shared_otterlog::warnf!(
                        None,
                        "lsp: 끼워 넣기 실패 ({root}): {}",
                        otter_gocompat::oserr::go_error_string(&e)
                    );
                }
            }
        });
        t
    }

    fn touch(&self) {
        let now = (self.now)();
        *self.last_use.lock().unwrap_or_else(|e| e.into_inner()) = now;
    }

    /// 초기화가 끝난 서버에만, 줄이 차지 않았을 때만 넣는다.
    pub(crate) fn enqueue(&self, body: Vec<u8>) -> bool {
        if !self.ready.load(Ordering::SeqCst) {
            return false;
        }
        match self.injq.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
            Some(tx) => match tx.try_send(body) {
                Ok(()) => true,
                Err(TrySendError::Full(_) | TrySendError::Disconnected(_)) => false,
            },
            None => false,
        }
    }
}

/// 브라우저가 보낸 `initialized` 알림인가 (id 가 없거나 null).
fn is_initialized(body: &[u8]) -> bool {
    #[derive(Deserialize, Default)]
    #[serde(default)]
    struct M {
        method: String,
        id: Option<json::RawMessage>,
    }
    matches!(json::unmarshal::<M>(body), Ok(m) if m.id.is_none() && m.method == "initialized")
}

impl Tunnel for LspTunnel {
    fn send(&self, body: &[u8]) -> io::Result<()> {
        let r = {
            let mut w = self.writer.lock().unwrap_or_else(|e| e.into_inner());
            let r = match w.as_mut() {
                Some(w) => write_frame(w.as_mut(), body).and_then(|()| w.flush()),
                None => Err(closed_pipe()),
            };
            if r.is_ok() && !self.ready.load(Ordering::SeqCst) && is_initialized(body) {
                self.ready.store(true, Ordering::SeqCst);
            }
            r
        };
        if r.is_ok() {
            self.touch();
        }
        r
    }

    fn recv(&self) -> io::Result<Vec<u8>> {
        let mut rd = self.reader.lock().unwrap_or_else(|e| e.into_inner());
        let b = read_frame(&mut *rd)?;
        self.touch();
        Ok(b)
    }

    fn close(&self) {
        let Some(stop) = self.stop.lock().unwrap_or_else(|e| e.into_inner()).take() else {
            return;
        };
        self.injq.lock().unwrap_or_else(|e| e.into_inner()).take();
        self.writer.lock().unwrap_or_else(|e| e.into_inner()).take();
        stop();
        self.state.lock().tunnels.remove(&self.id);
    }

    fn last_use(&self) -> SystemTime {
        *self.last_use.lock().unwrap_or_else(|e| e.into_inner())
    }
}
