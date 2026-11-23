use std::collections::{BTreeMap, HashMap};
use std::io::{self, BufRead, BufReader, Write};
use std::net::Shutdown;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, SyncSender};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, RwLock};
use std::thread;
use std::time::{Duration, Instant};

use dm_gocompat::json::{self, ErrorKind, RawMessage};
use dm_shared_dmlog::{errorf, infof, warnf};
use dm_shared_platform::IpcStream;
use dm_shared_toolhub::{DaemonInfo, ExitInfo};
use dm_shared_toolipc::{
    AttnEvent, ChatEvent, EdgesEvent, HelloParams, METHOD_HELLO, PROTOCOL_VERSION, ReportEvent,
    RpcError, SERVER_FEATURES,
};
use serde::Serialize;
use serde::de::DeserializeOwned;

use crate::error::Error;
use crate::hub::ListState;
use crate::push::{FgState, Sub};
use crate::wire::{HelloReply, NotifyRequest, OutRequest, WireMsg, probe};

/// RPC 하나의 상한이다. 넘기면 연결을 끊고 감독이 다시 붙는다 (DAEMON_SPLIT_SRS FR-14).
pub const TOOL_CALL_TIMEOUT: Duration = Duration::from_secs(5);
/// create 하나의 상한이다 (FR-OPT-2-3).
pub const TOOL_CREATE_TIMEOUT: Duration = Duration::from_secs(60);
/// 데몬 종단에 붙는 시도의 상한이다.
pub const TOOL_DIAL_TIMEOUT: Duration = Duration::from_secs(2);
/// 연결이 끊긴 뒤 첫 재접속까지의 대기다. 실패마다 두 배로 늘어 [`TOOL_MAX_BACKOFF`] 에서 멈춘다 (FR-13).
pub const TOOL_RECONNECT_BACKOFF: Duration = Duration::from_secs(1);
pub const TOOL_MAX_BACKOFF: Duration = Duration::from_secs(30);
/// 연이은 재접속 실패가 이 수의 배수가 될 때마다 데몬을 다시 띄운다.
pub const TOOL_RESPAWN_EVERY: u32 = 3;
/// 생존 확인 hello 의 주기다 (FR-OPT-2-1).
pub const TOOL_HEARTBEAT_EVERY: Duration = Duration::from_secs(15);

pub type OutputCallback = Arc<dyn Fn(&str, &[u8], i64) + Send + Sync>;
pub type ExitCallback = Arc<dyn Fn(&str, ExitInfo) + Send + Sync>;
pub type ForegroundCallback = Arc<dyn Fn(&str, &str) + Send + Sync>;
pub type ReportCallback = Arc<dyn Fn(ReportEvent) + Send + Sync>;
pub type AttnCallback = Arc<dyn Fn(AttnEvent) + Send + Sync>;
pub type EdgesCallback = Arc<dyn Fn(EdgesEvent) + Send + Sync>;
pub type ChatCallback = Arc<dyn Fn(ChatEvent) + Send + Sync>;
#[cfg(test)]
pub(crate) type SleepHook = Arc<dyn Fn(Duration) + Send + Sync>;
pub type ResyncCallback = Arc<dyn Fn() + Send + Sync>;
/// 재접속이 거듭 실패할 때 데몬을 다시 띄운다. 결과는 버린다.
pub type SpawnDaemon = Box<dyn Fn() -> io::Result<()> + Send + Sync>;

/// 감독의 시간 계약이다 — 생존 확인의 주기·시한과 재접속 백오프. 배선은 위 상수이고 시험이 줄인다.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Timing {
    pub every: Duration,
    pub within: Duration,
    pub backoff: Duration,
    pub max_backoff: Duration,
}

const DEFAULT_TIMING: Timing = Timing {
    every: TOOL_HEARTBEAT_EVERY,
    within: TOOL_CALL_TIMEOUT,
    backoff: TOOL_RECONNECT_BACKOFF,
    max_backoff: TOOL_MAX_BACKOFF,
};

/// 실패마다 두 배, max 에서 멈춘다 (FR-13).
pub(crate) fn next_backoff(b: Duration, max: Duration) -> Duration {
    if b < max { (b * 2).min(max) } else { b }
}

/// 연결 하나. `dropped` 는 이쪽이 닫았다는 표시다 — 읽기 오류 문구를 Go 의 것과 맞춘다.
pub(crate) struct Conn {
    stream: IpcStream,
    dropped: AtomicBool,
}

impl Conn {
    fn close(&self) {
        self.dropped.store(true, Ordering::SeqCst);
        let _ = self.stream.shutdown(Shutdown::Both);
    }
}

pub(crate) enum Reply {
    Done(RawMessage, Option<Error>),
    Closed,
}

#[derive(Default)]
pub(crate) struct Callbacks {
    pub on_output: Option<OutputCallback>,
    pub on_exit: Option<ExitCallback>,
    pub on_foreground: Option<ForegroundCallback>,
    pub on_report: Option<ReportCallback>,
    pub on_attn: Option<AttnCallback>,
    pub on_edges: Option<EdgesCallback>,
    pub on_edge_resync: Option<ResyncCallback>,
    pub on_chat: Option<ChatCallback>,
    pub on_chat_resync: Option<ResyncCallback>,
    pub on_resync: Option<ResyncCallback>,
}

#[derive(Default)]
pub(crate) struct State {
    pub conn: Option<Arc<Conn>>,
    /// 연결의 세대. 연결마다 하나 오른다.
    pub generation: u64,
    /// 지금 연결이 아직 살아 있는가 (Go 의 connDone 이 닫히지 않음).
    pub alive: bool,
    pub closed: bool,
    pub pending: HashMap<i64, SyncSender<Reply>>,
    pub next_id: i64,
    pub cbs: Callbacks,
    /// 배선 전에 도착한 exit 다 — exit 만 버퍼한다.
    pub early_exits: Vec<(String, ExitInfo)>,
    pub daemon_info: DaemonInfo,
    pub features: Vec<String>,
}

pub(crate) struct Inner {
    sock_path: PathBuf,
    spawn_daemon: Option<SpawnDaemon>,
    timing: Timing,
    pub st: Mutex<State>,
    /// 닫힘·연결 끊김을 감독에게 알린다.
    wake: Condvar,
    /// 소켓 쓰기만 지킨다 (IPC-22). 쓰기가 막혀도 `st` 를 쥐지 않는다.
    write_mu: Mutex<()>,
    pub stopped: AtomicBool,
    pub reconnects: AtomicI64,
    pub fg: Mutex<FgState>,
    pub subs: RwLock<HashMap<String, HashMap<u64, Sub>>>,
    pub next_sub: AtomicU64,
    pub dropped: AtomicI64,
    pub list: Mutex<ListState>,
    /// 시험이 재접속 백오프의 실제 대기를 대신한다. 받은 대기 시간을 기록하고 곧바로 돌아온다.
    #[cfg(test)]
    pub sleep_hook: Mutex<Option<SleepHook>>,
}

pub(crate) fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

/// 웹 서버 쪽의 데몬 클라이언트다. 데몬 소켓에 붙어 줄 단위 JSON RPC 로 도구를 다루고,
/// 끊기면 지수 백오프로 다시 붙는다 (DAEMON_SPLIT_SRS Phase 3).
///
/// 동기 API 다 (FR-RSP-33). 비동기 쪽은 `spawn_blocking` 으로 부른다. Drop 하면 닫는다.
pub struct ToolClient {
    pub(crate) inner: Arc<Inner>,
}

impl ToolClient {
    /// 데몬 소켓에 붙고 hello 를 마친다. 끊기면 다시 붙지만 데몬을 다시 띄우지는 않는다.
    pub fn dial(sock_path: impl AsRef<Path>) -> Result<Self, Error> {
        Self::dial_with_reconnect(sock_path, None)
    }

    /// [`ToolClient::dial`] 에 재접속이 거듭 실패할 때 데몬을 다시 띄우는 함수를 더한다 (FR-13).
    pub fn dial_with_reconnect(
        sock_path: impl AsRef<Path>,
        spawn_daemon: Option<SpawnDaemon>,
    ) -> Result<Self, Error> {
        Self::dial_with(sock_path.as_ref(), spawn_daemon, DEFAULT_TIMING)
    }

    pub(crate) fn dial_with(
        sock_path: &Path,
        spawn_daemon: Option<SpawnDaemon>,
        timing: Timing,
    ) -> Result<Self, Error> {
        let inner = Arc::new(Inner {
            sock_path: sock_path.to_path_buf(),
            spawn_daemon,
            timing,
            st: Mutex::new(State::default()),
            wake: Condvar::new(),
            write_mu: Mutex::new(()),
            stopped: AtomicBool::new(false),
            reconnects: AtomicI64::new(0),
            fg: Mutex::new(FgState::default()),
            subs: RwLock::new(HashMap::new()),
            next_sub: AtomicU64::new(0),
            dropped: AtomicI64::new(0),
            list: Mutex::new(ListState::default()),
            #[cfg(test)]
            sleep_hook: Mutex::new(None),
        });
        inner.connect().map_err(|e| Error::Dial(Box::new(e)))?;
        let sup = Arc::clone(&inner);
        let spawned = thread::Builder::new()
            .name("toolclient-supervise".to_owned())
            .spawn(move || sup.supervise());
        if let Err(e) = spawned {
            inner.close();
            return Err(Error::Dial(Box::new(Error::Io(e))));
        }
        Ok(Self { inner })
    }

    /// 지금 연결된 데몬이 hello 에서 name 기능을 말했는가다 (D-OPT-1).
    pub fn has_feature(&self, name: &str) -> bool {
        dm_shared_toolipc::has_feature(&lock(&self.inner.st).features, name)
    }

    /// 마지막 hello 가 말한 데몬의 판이다 (FR-VHL-2).
    pub fn daemon_info(&self) -> DaemonInfo {
        lock(&self.inner.st).daemon_info.clone()
    }

    /// 연결을 닫고 감독을 멈춘다. 여러 번 불러도 된다.
    pub fn close(&self) {
        self.inner.close();
    }

    /// 지금 데몬에 닿는가다. 재접속 창에서는 거짓이다.
    pub fn connected(&self) -> bool {
        let st = lock(&self.inner.st);
        st.conn.is_some() && st.alive && !st.closed
    }

    /// 연결을 되살린 횟수다 (OBSERVABILITY_SRS FR-OBS-12).
    pub fn reconnects(&self) -> i64 {
        self.inner.reconnects.load(Ordering::SeqCst)
    }

    pub fn set_on_output(&self, cb: Option<OutputCallback>) {
        lock(&self.inner.st).cbs.on_output = cb;
    }

    /// exit 콜백을 걸고, 배선 전에 도착해 버퍼된 exit 를 그 자리에서 재생한다.
    pub fn set_on_exit(&self, cb: Option<ExitCallback>) {
        let early = {
            let mut st = lock(&self.inner.st);
            st.cbs.on_exit.clone_from(&cb);
            std::mem::take(&mut st.early_exits)
        };
        if let Some(cb) = cb {
            for (tool, info) in early {
                cb(&tool, info);
            }
        }
    }

    pub fn set_on_foreground(&self, cb: Option<ForegroundCallback>) {
        lock(&self.inner.st).cbs.on_foreground = cb;
    }

    pub(crate) fn call<R: DeserializeOwned + Default, P: Serialize + ?Sized>(
        &self,
        method: &str,
        params: &P,
    ) -> Result<R, Error> {
        self.inner.call_t(method, params, TOOL_CALL_TIMEOUT)
    }

    pub(crate) fn call_within<R: DeserializeOwned + Default, P: Serialize + ?Sized>(
        &self,
        method: &str,
        params: &P,
        within: Duration,
    ) -> Result<R, Error> {
        self.inner.call_t(method, params, within)
    }

    pub(crate) fn call_raw<P: Serialize + ?Sized>(
        &self,
        method: &str,
        params: &P,
    ) -> Result<RawMessage, Error> {
        self.inner.call_raw(method, params, TOOL_CALL_TIMEOUT)
    }

    pub(crate) fn notify<P: Serialize + ?Sized>(&self, method: &str, params: &P) {
        self.inner.notify(method, params);
    }
}

impl Drop for ToolClient {
    fn drop(&mut self) {
        self.inner.close();
    }
}

fn hello_params() -> HelloParams {
    HelloParams {
        features: SERVER_FEATURES.iter().map(|s| (*s).to_owned()).collect(),
    }
}

/// 말하지 않은 것은 지어내지 않는다 (FR-VHL-5). 판 키가 없으면 현재 판으로 읽고 빌드는 비운다.
fn parse_hello(res: &HelloReply) -> DaemonInfo {
    DaemonInfo {
        protocol: res.version.unwrap_or(PROTOCOL_VERSION),
        build: res.build.clone(),
    }
}

impl Inner {
    /// 연결 하나를 세우고 읽기 루프를 띄운 뒤 hello 를 마친다. 첫 연결과 재접속마다 부른다.
    fn connect(self: &Arc<Self>) -> Result<(), Error> {
        let stream = dm_shared_platform::current()
            .ipc
            .dial(&self.sock_path, TOOL_DIAL_TIMEOUT)
            .map_err(Error::Io)?;
        let conn = Arc::new(Conn {
            stream,
            dropped: AtomicBool::new(false),
        });
        let generation = {
            let mut st = lock(&self.st);
            st.generation += 1;
            st.conn = Some(Arc::clone(&conn));
            st.alive = true;
            st.generation
        };
        let me = Arc::clone(self);
        let rc = Arc::clone(&conn);
        if let Err(e) = thread::Builder::new()
            .name("toolclient-read".to_owned())
            .spawn(move || me.read_loop(&rc, generation))
        {
            conn.close();
            self.conn_lost(generation);
            return Err(Error::Io(e));
        }

        let res: HelloReply = match self.call_t(METHOD_HELLO, &hello_params(), TOOL_CALL_TIMEOUT) {
            Ok(r) => r,
            Err(e) => {
                conn.close();
                return Err(Error::Hello(Box::new(e)));
            }
        };
        let info = parse_hello(&res);
        // 프로토콜이 다르면 거부한다 (FR-VHL-3). 빌드 불일치로는 끊지 않는다 (FR-VHL-4).
        if info.protocol != PROTOCOL_VERSION {
            conn.close();
            return Err(Error::ProtocolMismatch {
                daemon: info.protocol,
            });
        }
        let mut st = lock(&self.st);
        st.daemon_info = info;
        st.features = res.features.unwrap_or_default();
        Ok(())
    }

    pub(crate) fn close(&self) {
        if self.stopped.swap(true, Ordering::SeqCst) {
            return;
        }
        let (conn, pending) = {
            let mut st = lock(&self.st);
            st.closed = true;
            (st.conn.clone(), std::mem::take(&mut st.pending))
        };
        for tx in pending.values() {
            let _ = tx.try_send(Reply::Closed);
        }
        self.wake.notify_all();
        if let Some(c) = conn {
            c.close();
        }
    }

    /// 한 연결의 응답과 push 를 읽는다. 연결이 죽으면 대기 중인 호출을 모두 실패시킨다.
    fn read_loop(&self, conn: &Conn, generation: u64) {
        let mut r = BufReader::new(&conn.stream);
        let mut line = Vec::new();
        let why = loop {
            line.clear();
            match r.read_until(b'\n', &mut line) {
                Ok(0) => break self.read_end(conn, "EOF".to_owned()),
                Ok(_) => {}
                Err(e) => break self.read_end(conn, e.to_string()),
            }
            if line
                .iter()
                .all(|&c| matches!(c, b' ' | b'\t' | b'\r' | b'\n'))
            {
                continue;
            }
            match json::Decoder::new().decode::<WireMsg>(&line) {
                Ok(m) => {
                    if !m.event.is_empty() {
                        self.handle_push(&m);
                    } else if let Some(id) = m.id {
                        let err = m.error.map(|e| {
                            Error::Rpc(RpcError {
                                code: e.code,
                                message: e.message,
                            })
                        });
                        self.handle_response(id, m.result, err);
                    }
                }
                // 값 오류는 그 줄만 틀린 것이다. 응답이면 호출자에게 오류를 주고, push 면 버린다.
                Err(e) if matches!(e.kind(), ErrorKind::Type { .. }) => {
                    let (id, event) = probe(&line);
                    if let (true, Some(id)) = (event.is_empty(), id) {
                        self.handle_response(id, RawMessage::default(), Some(Error::Json(e)));
                    }
                }
                Err(e) => break e.to_string(),
            }
        };
        if !self.stopped.load(Ordering::SeqCst) {
            infof!(None, "toolclient read: {why}");
        }
        self.conn_lost(generation);
    }

    /// 이쪽이 닫은 연결의 읽기 끝은 Go 의 `use of closed network connection` 문구로 적는다.
    fn read_end(&self, conn: &Conn, why: String) -> String {
        if conn.dropped.load(Ordering::SeqCst) {
            format!(
                "read unix ->{}: use of closed network connection",
                self.sock_path.display()
            )
        } else {
            why
        }
    }

    fn handle_response(&self, id: i64, result: RawMessage, err: Option<Error>) {
        let tx = lock(&self.st).pending.remove(&id);
        if let Some(tx) = tx {
            let _ = tx.try_send(Reply::Done(result, err));
        }
    }

    /// 지금 연결의 끝을 한 번만 처리한다. 대기 중인 호출은 채널이 닫혀 곧바로 돌아온다.
    fn conn_lost(&self, generation: u64) {
        let pending = {
            let mut st = lock(&self.st);
            if st.generation != generation || !st.alive {
                return;
            }
            st.alive = false;
            std::mem::take(&mut st.pending)
        };
        drop(pending);
        self.wake.notify_all();
    }

    /// 살아 있는 연결이 아직 generation 일 때만 닫는다 — 읽기 루프가 끝나고 감독이 다시 붙는다.
    fn drop_if_current(&self, generation: u64) {
        let st = lock(&self.st);
        if st.generation == generation
            && let Some(c) = &st.conn
        {
            c.close();
        }
    }

    pub(crate) fn notify<P: Serialize + ?Sized>(&self, method: &str, params: &P) {
        let Some(conn) = lock(&self.st).conn.clone() else {
            return;
        };
        let Ok(b) = json::Encoder::new().encode(&NotifyRequest { method, params }) else {
            return;
        };
        let _w = lock(&self.write_mu);
        let _ = (&conn.stream).write_all(&b);
    }

    pub(crate) fn call_t<R: DeserializeOwned + Default, P: Serialize + ?Sized>(
        &self,
        method: &str,
        params: &P,
        within: Duration,
    ) -> Result<R, Error> {
        let raw = self.call_raw(method, params, within)?;
        if raw.0.is_empty() {
            return Ok(R::default());
        }
        json::unmarshal(&raw.0).map_err(Error::Json)
    }

    /// 요청을 보내고 응답·연결 끊김·시한·닫힘 가운데 먼저 오는 것을 기다린다.
    pub(crate) fn call_raw<P: Serialize + ?Sized>(
        &self,
        method: &str,
        params: &P,
        within: Duration,
    ) -> Result<RawMessage, Error> {
        let (tx, rx) = mpsc::sync_channel(1);
        let (id, generation, conn, dead) = {
            let mut st = lock(&self.st);
            if st.closed {
                return Err(Error::Closed);
            }
            let Some(conn) = st.conn.clone() else {
                return Err(Error::NotConnected);
            };
            let id = st.next_id;
            st.next_id += 1;
            st.pending.insert(id, tx);
            (id, st.generation, conn, !st.alive)
        };
        let sent = match json::Encoder::new().encode(&OutRequest { id, method, params }) {
            Ok(b) => {
                let _w = lock(&self.write_mu);
                (&conn.stream).write_all(&b).map_err(Error::Io)
            }
            Err(e) => Err(Error::Json(e)),
        };
        if let Err(e) = sent {
            lock(&self.st).pending.remove(&id);
            return Err(e);
        }
        if dead {
            lock(&self.st).pending.remove(&id);
            return Err(Error::ConnectionLost);
        }
        match rx.recv_timeout(within) {
            Ok(Reply::Done(raw, None)) => Ok(raw),
            Ok(Reply::Done(_, Some(e))) => Err(e),
            Ok(Reply::Closed) => Err(Error::Closed),
            Err(RecvTimeoutError::Disconnected) => Err(Error::ConnectionLost),
            // 시한 초과에 연결 전체를 끊는 것은 설계다 (FR-RGS-8). ping 은 호출이 걸려 있으면
            // 건너뛰므로 이 시한이 무응답 데몬을 찾는 유일한 수단이다.
            Err(RecvTimeoutError::Timeout) => {
                lock(&self.st).pending.remove(&id);
                self.drop_if_current(generation);
                Err(Error::Timeout {
                    method: method.to_owned(),
                })
            }
        }
    }

    /// 닫히면 참이다. 아니면 d 동안 잔다.
    fn sleep_unless_closed(&self, d: Duration) -> bool {
        #[cfg(test)]
        if let Some(hook) = lock(&self.sleep_hook).clone() {
            hook(d);
            return lock(&self.st).closed;
        }
        let deadline = Instant::now() + d;
        let mut st = lock(&self.st);
        loop {
            if st.closed {
                return true;
            }
            let now = Instant::now();
            if now >= deadline {
                return false;
            }
            st = self
                .wake
                .wait_timeout(st, deadline - now)
                .unwrap_or_else(|p| p.into_inner())
                .0;
        }
    }

    /// 연결이 죽으면 지수 백오프로 다시 붙고, 정상 상태에서는 hello 로 생존을 확인한다.
    fn supervise(self: Arc<Self>) {
        let every = self.timing.every;
        let mut next_beat = Instant::now() + every;
        loop {
            {
                let mut st = lock(&self.st);
                loop {
                    if st.closed {
                        return;
                    }
                    if !st.alive {
                        break;
                    }
                    let now = Instant::now();
                    if now >= next_beat {
                        drop(st);
                        self.ping();
                        let now = Instant::now();
                        while next_beat <= now {
                            next_beat += every;
                        }
                        st = lock(&self.st);
                        continue;
                    }
                    st = self
                        .wake
                        .wait_timeout(st, next_beat - now)
                        .unwrap_or_else(|p| p.into_inner())
                        .0;
                }
            }
            if self.stopped.load(Ordering::SeqCst) {
                return;
            }
            warnf!(None, "toolclient: connection lost, reconnecting...");
            let mut backoff = self.timing.backoff;
            let mut fails: u32 = 0;
            loop {
                if self.stopped.load(Ordering::SeqCst) || self.sleep_unless_closed(backoff) {
                    return;
                }
                if self.connect().is_ok() {
                    self.reconnects.fetch_add(1, Ordering::SeqCst);
                    infof!(None, "toolclient: reconnected");
                    self.resync_after_reconnect();
                    self.run_resync(|c| c.on_resync.clone());
                    self.run_resync(|c| c.on_edge_resync.clone());
                    self.run_resync(|c| c.on_chat_resync.clone());
                    break;
                }
                fails += 1;
                if let Some(spawn) = &self.spawn_daemon
                    && fails.is_multiple_of(TOOL_RESPAWN_EVERY)
                {
                    errorf!(
                        None,
                        "toolclient: respawning dongminald after {fails} failed dials"
                    );
                    let _ = spawn();
                }
                backoff = next_backoff(backoff, self.timing.max_backoff);
            }
        }
    }

    fn run_resync(&self, pick: impl Fn(&Callbacks) -> Option<ResyncCallback>) {
        let cb = pick(&lock(&self.st).cbs);
        if let Some(cb) = cb {
            cb();
        }
    }

    /// 생존 확인이다 (FR-OPT-2-1). 진행 중인 호출이 있으면 건너뛴다 — 그 호출이 자기 시한으로
    /// 무응답을 잡는다. 인자는 접속 때와 같다.
    fn ping(&self) {
        if !lock(&self.st).pending.is_empty() {
            return;
        }
        let _ = self.call_raw(METHOD_HELLO, &hello_params(), self.timing.within);
    }
}

/// 결과의 키 하나를 **없는 것**과 null 을 갈라 꺼낸다. null 은 `null` 네 글자다.
pub(crate) fn result_key(raw: &RawMessage, key: &str) -> Option<RawMessage> {
    if raw.0.is_empty() {
        return None;
    }
    let m: BTreeMap<String, RawMessage> = json::unmarshal(&raw.0).ok()?;
    m.get(key).filter(|v| !v.0.is_empty()).cloned()
}
