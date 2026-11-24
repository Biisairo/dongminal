//! PTY 하나를 소유하는 도구 한 개의 수명 (tool.go·tool_control.go·tool_cwd.go·freeze.go 의 Tool 부분).

use std::collections::{BTreeMap, HashMap};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering::SeqCst};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, Once, RwLock};
use std::time::Duration;
use std::{io, thread};

use otter_gocompat::json::RawMessage;
use otter_shared_activity as activity;
use otter_shared_otterlog::{errorf, infof};
use otter_shared_outbuf::Stream;
use otter_shared_platform::{ProcSpec, Terminal};
use otter_shared_termstate::{HISTORY_CAP, Screen};
use tokio_util::sync::CancellationToken;

use crate::env::{Getenv, tool_bin_dir, tool_env, tool_start_dir};
use crate::{
    ATTN_MAX_CARRY, ActivityState, AgentState, AgentTurn, DEFAULT_COLS, DEFAULT_ROWS, EscClass,
    ExitInfo, ModeObserver, TermModes, ToolScreen, activity_still_working, classify_esc,
    detect_attention_signal, detect_cwd_report,
};

/// 출력 링버퍼의 크기다(1MB).
pub const BUF_MAX: usize = 1 << 20;
/// kill 이 SIGTERM 뒤 SIGKILL 까지 기다리는 시간이다.
pub const TERMINATE_GRACE: Duration = Duration::from_millis(50);
const READ_BUF: usize = 8192;

pub type AttentionFn = Arc<dyn Fn(&str, &str) + Send + Sync>;
pub type ClearFn = Arc<dyn Fn(&str) + Send + Sync>;
pub type ActivityFn = Arc<dyn Fn(&str, &str, &str, &str) + Send + Sync>;
pub type SizeFn = Arc<dyn Fn(&str, u16, u16) + Send + Sync>;
pub type OutputFn = Arc<dyn Fn(&str, &[u8], i64) + Send + Sync>;
pub type ExitFn = Arc<dyn Fn(&str) + Send + Sync>;

/// 도구에 거는 알림이다. 만들 때 한 번 정해진다.
#[derive(Clone, Default)]
pub struct ToolHooks {
    pub on_attention: Option<AttentionFn>,
    pub on_attention_clear: Option<ClearFn>,
    pub on_activity: Option<ActivityFn>,
    pub allow_bell: bool,
    /// PTY 크기가 바뀌었다 (M9_SRS FR-M9-3).
    pub on_size: Option<SizeFn>,
}

#[derive(Default)]
struct Relay {
    on_output: Option<OutputFn>,
    on_exit: Option<ExitFn>,
}

/// readPTY 스레드만 만지는 이월 상태다.
#[derive(Default)]
struct ReadState {
    attn_carry: Vec<u8>,
    modes: ModeObserver,
    scratch: Vec<u8>,
}

/// `cmu` 가 지키는 것이다. 링과 화면 상태는 이 잠금 아래에서 함께 나아간다.
#[derive(Default)]
struct Cmu {
    exited: bool,
    screen: Option<Screen>,
}

#[derive(Default)]
struct FreezeState {
    frozen: bool,
    parked: bool,
    read_done: bool,
}

/// 검사가 갈아 끼우는 시계·바쁨 판정이다 (Go `setAttnNow`·`SetAttnBusyProbe`).
type ClockFn = Arc<dyn Fn() -> i64 + Send + Sync>;
pub type BusyProbeFn = Arc<dyn Fn(&Tool) -> bool + Send + Sync>;
static ATTN_NOW: RwLock<Option<ClockFn>> = RwLock::new(None);
static ATTN_BUSY: RwLock<Option<BusyProbeFn>> = RwLock::new(None);

/// 지금을 unix-nanos 로 답한다.
pub(crate) fn attn_now() -> i64 {
    if let Some(f) = read_lock(&ATTN_NOW).as_ref() {
        return f();
    }
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_nanos()).unwrap_or(i64::MAX))
}

/// 시계를 갈아 끼운다(검사 전용). 돌려준 값을 버리면 이전 시계로 돌아간다.
pub fn set_attn_now(f: impl Fn() -> i64 + Send + Sync + 'static) -> Restore {
    let prev = write_lock(&ATTN_NOW).replace(Arc::new(f));
    Restore(Some(Box::new(move || *write_lock(&ATTN_NOW) = prev)))
}

/// 유휴 알람의 "바쁜가" 판정을 갈아 끼운다(검사 전용).
pub fn set_attn_busy_probe(f: impl Fn(&Tool) -> bool + Send + Sync + 'static) -> Restore {
    let prev = write_lock(&ATTN_BUSY).replace(Arc::new(f));
    Restore(Some(Box::new(move || *write_lock(&ATTN_BUSY) = prev)))
}

/// 갈아 끼운 것을 drop 때 되돌린다.
pub struct Restore(Option<Box<dyn FnOnce() + Send>>);

impl Drop for Restore {
    fn drop(&mut self) {
        if let Some(f) = self.0.take() {
            f();
        }
    }
}

fn read_lock<T>(l: &RwLock<T>) -> std::sync::RwLockReadGuard<'_, T> {
    l.read().unwrap_or_else(|e| e.into_inner())
}

fn write_lock<T>(l: &RwLock<T>) -> std::sync::RwLockWriteGuard<'_, T> {
    l.write().unwrap_or_else(|e| e.into_inner())
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn proc_info() -> &'static dyn otter_shared_platform::ProcInfo {
    otter_shared_platform::current().info
}

/// PTY 하나와 그 위의 셸을 소유하는 도구다. `Arc` 로 나눠 쓴다.
pub struct Tool {
    pub id: String,
    pub name: String,
    term: Option<Arc<dyn Terminal>>,
    stream: Option<Stream>,
    sandboxed: AtomicBool,
    /// exited 표시와 화면 상태. 출력 공급(feed)도 이 잠금 아래에서 한다.
    cmu: Mutex<Cmu>,
    done: CancellationToken,
    killed: Once,
    last_output_at: AtomicI64,
    attn_armed: AtomicBool,
    attention: AtomicBool,
    attn_rearm_locked: AtomicBool,
    agent_seen: AtomicBool,
    turn: AgentTurn,
    allow_bell: AtomicBool,
    hooks: ToolHooks,
    relay: Mutex<Arc<Relay>>,
    wired: AtomicBool,
    term_closed: Mutex<bool>,
    activity: Mutex<Option<ActivityState>>,
    records: Mutex<BTreeMap<String, RawMessage>>,
    exit_code: AtomicI64,
    modes: AtomicU64,
    read: Mutex<ReadState>,
    frz: Mutex<FreezeState>,
    frz_cv: Condvar,
    reported_cwd: Mutex<String>,
}

impl Tool {
    fn bare(
        id: &str,
        name: &str,
        term: Option<Arc<dyn Terminal>>,
        stream: Option<Stream>,
        hooks: ToolHooks,
    ) -> Self {
        let screen = term.as_ref().map(|t| {
            let (c, r) = t.size().unwrap_or((DEFAULT_COLS, DEFAULT_ROWS));
            Screen::new(c, r, HISTORY_CAP)
        });
        Self {
            id: id.to_string(),
            name: name.to_string(),
            term,
            stream,
            sandboxed: AtomicBool::new(false),
            cmu: Mutex::new(Cmu {
                exited: false,
                screen,
            }),
            done: CancellationToken::new(),
            killed: Once::new(),
            last_output_at: AtomicI64::new(0),
            attn_armed: AtomicBool::new(false),
            attention: AtomicBool::new(false),
            attn_rearm_locked: AtomicBool::new(false),
            agent_seen: AtomicBool::new(false),
            turn: AgentTurn::default(),
            allow_bell: AtomicBool::new(hooks.allow_bell),
            hooks,
            relay: Mutex::new(Arc::new(Relay::default())),
            wired: AtomicBool::new(false),
            term_closed: Mutex::new(false),
            activity: Mutex::new(None),
            records: Mutex::new(BTreeMap::new()),
            exit_code: AtomicI64::new(0),
            modes: AtomicU64::new(0),
            read: Mutex::new(ReadState::default()),
            frz: Mutex::new(FreezeState::default()),
            frz_cv: Condvar::new(),
            reported_cwd: Mutex::new(String::new()),
        }
    }

    /// 프로세스 없는 도구다. 주의 판정·기록만 쓴다 (데몬 밖 거울, 검사). on_size 는 걸지 않는다.
    pub fn new_detached(id: &str, hooks: Option<ToolHooks>) -> Arc<Self> {
        let mut h = hooks.unwrap_or_default();
        h.on_size = None;
        Arc::new(Self::bare(id, "", None, None, h))
    }

    /// 주의가 선 채로 시작하는 detached 도구다.
    pub fn new_attending(id: &str, hooks: Option<ToolHooks>, armed: bool) -> Arc<Self> {
        let p = Self::new_detached(id, hooks);
        p.attention.store(true, SeqCst);
        p.attn_armed.store(armed, SeqCst);
        p
    }

    /// 열린 터미널 위의 도구다. 읽기 스레드는 부르는 쪽이 [`Tool::spawn_reader`] 로 띄운다.
    pub fn on_term(
        id: &str,
        name: &str,
        term: Box<dyn Terminal>,
        sandboxed: bool,
        on_exit: Option<ExitFn>,
        hooks: Option<ToolHooks>,
        stream: Stream,
    ) -> Arc<Self> {
        let p = Self::bare(
            id,
            name,
            Some(Arc::from(term)),
            Some(stream),
            hooks.unwrap_or_default(),
        );
        p.sandboxed.store(sandboxed, SeqCst);
        *lock(&p.relay) = Arc::new(Relay {
            on_output: None,
            on_exit,
        });
        Arc::new(p)
    }

    /// 셸을 PTY 안에 띄운다. `place` 가 있으면 그 실행 파일·인자로 바꾼다(샌드박스).
    #[allow(clippy::too_many_arguments)]
    pub fn start(
        id: &str,
        name: &str,
        cwd: &str,
        cols: u16,
        rows: u16,
        on_exit: Option<ExitFn>,
        hooks: Option<ToolHooks>,
        place: Option<&ProcSpec>,
        extra_env: &[String],
    ) -> io::Result<Arc<Self>> {
        Self::start_with(
            &crate::env::os_getenv,
            &[],
            id,
            name,
            cwd,
            (cols, rows),
            on_exit,
            hooks,
            place,
            extra_env,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn start_with(
        g: Getenv,
        overlay: &[(String, String)],
        id: &str,
        name: &str,
        cwd: &str,
        (cols, rows): (u16, u16),
        on_exit: Option<ExitFn>,
        hooks: Option<ToolHooks>,
        place: Option<&ProcSpec>,
        extra_env: &[String],
    ) -> io::Result<Arc<Self>> {
        let plat = otter_shared_platform::current();
        let bin_dir = tool_bin_dir(g);
        let sh = plat.shell.shell(std::path::Path::new(&bin_dir));
        let env = tool_env(g, id, &sh.path, &bin_dir, &sh.env, extra_env, overlay);
        let start_dir = tool_start_dir(g, cwd);
        let mut spec = ProcSpec {
            path: sh.path.clone(),
            args: std::iter::once(sh.path.clone())
                .chain(sh.args.iter().cloned())
                .collect(),
            env,
            dir: start_dir.clone(),
        };
        if let Some(pl) = place {
            spec.path.clone_from(&pl.path);
            spec.args.clone_from(&pl.args);
        }
        let term = plat.pty.start(spec.clone(), cols, rows)?;
        let pid = term.pid();
        let p = Self::on_term(
            id,
            name,
            term,
            place.is_some(),
            on_exit,
            hooks,
            Stream::new(BUF_MAX),
        );
        p.note_cwd_report(&start_dir);
        p.spawn_reader();
        infof!(
            None,
            "[tool {id}] started shell={} pid={pid} cwd={start_dir} cols={cols} rows={rows}",
            spec.path
        );
        Ok(p)
    }

    /// PTY 읽기 스레드를 띄운다 (FR-RSP-33: 블로킹 읽기는 전용 스레드).
    pub fn spawn_reader(self: &Arc<Self>) {
        let p = Arc::clone(self);
        let spawned = thread::Builder::new()
            .name(format!("tool-{}", self.id))
            .spawn(move || p.read_pty());
        if let Err(e) = spawned {
            errorf!(None, "[tool {}] readPTY spawn: {e}", self.id);
            self.exit_after_read();
        }
    }

    fn read_pty(self: Arc<Self>) {
        let res = catch_unwind(AssertUnwindSafe(|| self.read_loop()));
        self.mark_read_done();
        if let Err(r) = res {
            let msg = r
                .downcast_ref::<&str>()
                .map(|s| (*s).to_string())
                .or_else(|| r.downcast_ref::<String>().cloned())
                .unwrap_or_default();
            errorf!(None, "[tool {}] readPTY panic: {msg}", self.id);
            self.exit_after_read();
        }
    }

    fn read_loop(self: &Arc<Self>) {
        let Some(term) = self.term.clone() else {
            return;
        };
        let mut raw = vec![0u8; READ_BUF];
        loop {
            match term.read(&mut raw) {
                Err(e) if otter_shared_platform::is_frozen(&e) => self.park_while_frozen(),
                Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
                Ok(0) => {
                    infof!(None, "[tool {}] readPTY: shell exited normally", self.id);
                    self.exit_after_read();
                    return;
                }
                Err(e) if is_eio(&e) => {
                    infof!(None, "[tool {}] readPTY: shell exited normally", self.id);
                    self.exit_after_read();
                    return;
                }
                Err(e) => {
                    errorf!(None, "[tool {}] readPTY unexpected error: {e}", self.id);
                    self.exit_after_read();
                    return;
                }
                Ok(n) => self.handle_chunk(&raw[..n]),
            }
        }
    }

    /// 출력 한 조각의 처리다: 버퍼에 넣고 중계한 뒤 주의·모드를 관측한다.
    pub(crate) fn handle_chunk(&self, chunk: &[u8]) {
        let r = Arc::clone(&lock(&self.relay));
        let end = self.feed(chunk);
        if let Some(f) = &r.on_output {
            f(&self.id, chunk, end);
        }
        let c = classify_esc(chunk, self.allow_bell.load(SeqCst));
        let mut rs = lock(&self.read);
        self.observe_output_classified(&mut rs, chunk, attn_now(), c);
        self.observe_modes_classified(&mut rs, chunk, c.modes);
    }

    fn feed(&self, chunk: &[u8]) -> i64 {
        let mut g = lock(&self.cmu);
        if let Some(s) = g.screen.as_mut() {
            s.feed(chunk);
        }
        self.stream.as_ref().map_or(0, |s| s.feed(chunk).1)
    }

    /// 화면 상태 스냅숏과 그 뒤를 이을 출력 오프셋이다. 링과 같은 잠금 안에서 만들어 한 순간을 맞춘다.
    /// 터미널이 없는 도구는 `None` 이다.
    pub fn screen(&self, history: usize) -> Option<ToolScreen> {
        let mut g = lock(&self.cmu);
        let end = self.stream.as_ref().map_or(0, Stream::offset);
        let sc = g.screen.as_mut()?;
        let s = sc.snapshot(history);
        let (cols, rows) = sc.size();
        let alt = sc.modes().alt_screen;
        drop(g);
        Some(ToolScreen {
            data: s.bytes,
            end: end - i64::try_from(s.back).unwrap_or(0),
            cols,
            rows,
            alt,
            first_line: s.first_line,
            cwd: self.reported_cwd(),
        })
    }

    /// 화면 상태와 그 화면이 반영한 누적 오프셋(`end`)을 한 잠금 안에서 읽는다.
    /// 터미널이 없는 도구는 `None` 이다.
    pub fn with_screen<R>(&self, f: impl FnOnce(&Screen, i64) -> R) -> Option<R> {
        let g = lock(&self.cmu);
        let end = self.stream.as_ref().map_or(0, Stream::offset);
        g.screen.as_ref().map(|s| f(s, end))
    }

    fn exit_after_read(self: &Arc<Self>) {
        self.kill();
        let r = Arc::clone(&lock(&self.relay));
        if let Some(f) = r.on_exit.clone() {
            let id = self.id.clone();
            thread::spawn(move || f(&id));
        }
    }

    /// 도구가 끝나면 취소되는 토큰이다 (Go `Wait()` 의 채널).
    pub fn done(&self) -> &CancellationToken {
        &self.done
    }

    /// 출력·종료 중계를 한 번만 건다. build 는 이전 종료 알림을 받아 새 (출력, 종료) 알림을 만든다.
    pub fn wire_relay_once(
        &self,
        build: impl FnOnce(Option<ExitFn>) -> (Option<OutputFn>, Option<ExitFn>),
    ) -> bool {
        if self
            .wired
            .compare_exchange(false, true, SeqCst, SeqCst)
            .is_err()
        {
            return false;
        }
        let base = lock(&self.relay).on_exit.clone();
        let (on_output, on_exit) = build(base);
        *lock(&self.relay) = Arc::new(Relay { on_output, on_exit });
        true
    }

    /// PTY 크기다. 모르면 `None`.
    pub fn size(&self) -> Option<(u16, u16)> {
        self.term.as_ref()?.size().ok()
    }

    pub fn stream(&self) -> Option<&Stream> {
        self.stream.as_ref()
    }

    pub fn sandboxed(&self) -> bool {
        self.sandboxed.load(SeqCst)
    }

    pub(crate) fn set_sandboxed(&self, v: bool) {
        self.sandboxed.store(v, SeqCst);
    }

    /// 셸 훅이 보고한 자리다. 없으면 "".
    pub fn reported_cwd(&self) -> String {
        lock(&self.reported_cwd).clone()
    }

    /// 셸 프로세스의 pid. 없으면 0.
    pub fn cmd_process_pid(&self) -> i32 {
        self.term.as_ref().map_or(0, |t| t.pid())
    }

    pub fn terminal(&self) -> Option<&Arc<dyn Terminal>> {
        self.term.as_ref()
    }

    /// 전경 자식 프로세스가 있는가다.
    pub fn is_busy(&self) -> bool {
        let pid = self.cmd_process_pid();
        pid > 0 && proc_info().has_children(pid)
    }

    pub fn exit_info(&self) -> ExitInfo {
        ExitInfo {
            code: self.exit_code.load(SeqCst),
        }
    }

    pub fn exited_now(&self) -> bool {
        lock(&self.cmu).exited
    }

    // ── 제어 ──

    /// SIGTERM 을 보내고 grace 안에 끝나기를 기다린다. 신호를 못 보내면 곧바로 돌아온다.
    pub async fn terminate_wait(&self, grace: Duration) {
        let pid = self.cmd_process_pid();
        if pid <= 0
            || otter_shared_platform::current()
                .process
                .terminate(pid)
                .is_err()
        {
            return;
        }
        let _ = tokio::time::timeout(grace, self.done.cancelled()).await;
    }

    /// 도구를 끝낸다(한 번만). 터미널을 닫고 TERM, 50ms 뒤 KILL 하고 수확한다.
    pub fn kill(&self) {
        self.killed.call_once(|| self.kill_once());
    }

    fn kill_once(&self) {
        lock(&self.cmu).exited = true;
        infof!(
            None,
            "[tool {}] killing pid={}",
            self.id,
            self.cmd_process_pid()
        );
        self.done.cancel();
        if let Some(term) = &self.term {
            {
                let mut closed = lock(&self.term_closed);
                *closed = true;
                let _ = term.close();
            }
            let _ = term.terminate();
            let (tx, rx) = std::sync::mpsc::channel();
            let t = Arc::clone(term);
            thread::spawn(move || {
                let _ = tx.send(t.wait());
            });
            let res = match rx.recv_timeout(TERMINATE_GRACE) {
                Ok(r) => r,
                Err(_) => {
                    let _ = term.kill();
                    rx.recv().unwrap_or_else(|_| Err(io::Error::other("wait")))
                }
            };
            self.record_exit(res);
        }
        if let Some(s) = &self.stream {
            s.close();
        }
        if lock(&self.activity).is_some() {
            self.set_activity(activity::ENDED, "", "");
        }
        self.attn_armed.store(false, SeqCst);
        self.attn_rearm_locked.store(false, SeqCst);
        self.clear_attention();
    }

    /// Go 는 `Wait` 오류(0 아닌 종료·신호)일 때만 코드를 적는다. 신호면 -1.
    fn record_exit(&self, res: io::Result<std::process::ExitStatus>) {
        match res {
            Ok(st) if st.success() => {}
            Ok(st) => {
                infof!(
                    None,
                    "[tool {}] wait: {}",
                    self.id,
                    otter_shared_platform::exit_status_text(&st)
                );
                self.exit_code
                    .store(st.code().map_or(-1, i64::from), SeqCst);
            }
            Err(e) => {
                infof!(None, "[tool {}] wait: {e}", self.id);
                self.exit_code.store(-1, SeqCst);
            }
        }
    }

    pub fn write(&self, data: &[u8]) -> io::Result<()> {
        let Some(term) = &self.term else {
            return Err(io::Error::other(format!("tool {}: 터미널이 없다", self.id)));
        };
        term.write(data).map(|_| ())
    }

    /// 크기를 바꾸고, 실제로 바뀌었으면 on_size 로 알린다.
    pub fn resize(&self, cols: u16, rows: u16) -> io::Result<()> {
        if self.resize_inner(cols, rows)? {
            self.notify_size(cols, rows);
        }
        Ok(())
    }

    pub(crate) fn notify_size(&self, cols: u16, rows: u16) {
        if let Some(h) = &self.hooks.on_size {
            h(&self.id, cols, rows);
        }
    }

    fn resize_inner(&self, c: u16, r: u16) -> io::Result<bool> {
        let Some(term) = &self.term else {
            return Err(io::Error::other(format!("tool {}: 터미널이 없다", self.id)));
        };
        let closed = lock(&self.term_closed);
        if *closed {
            return Err(io::Error::other(format!(
                "tool {}: 터미널이 닫혔다",
                self.id
            )));
        }
        let old = term.size().ok();
        let mut g = lock(&self.cmu);
        if let Err(e) = term.resize(c, r) {
            errorf!(
                None,
                "[tool {}] resize error cols={c} rows={r}: {e}",
                self.id
            );
            return Err(e);
        }
        if let Some(s) = g.screen.as_mut() {
            s.resize(c, r);
        }
        Ok(old != Some((c, r)))
    }

    // ── cwd ──

    /// 셸의 지금 자리다. 프로세스에서 읽고, 못 읽으면 셸 훅이 보고한 값이다.
    pub fn cwd(&self) -> String {
        let pid = self.cmd_process_pid();
        if pid > 0
            && let Some(c) = proc_info().cwd(pid)
        {
            return c;
        }
        lock(&self.reported_cwd).clone()
    }

    /// 보고된 자리를 적는다. 빈 보고는 아는 것을 덮지 않는다 (FR-WTC-5).
    pub fn note_cwd_report(&self, cwd: &str) {
        if !cwd.is_empty() {
            *lock(&self.reported_cwd) = cwd.to_string();
        }
    }

    /// 일괄 조회 결과에서 자리를 고른다. 없으면 보고값, 그것도 없으면 서버의 cwd 다.
    pub fn cwd_or_server(&self, by_pid: &HashMap<i32, String>) -> String {
        let pid = self.cmd_process_pid();
        if pid > 0
            && let Some(c) = by_pid.get(&pid).filter(|c| !c.is_empty())
        {
            return c.clone();
        }
        let r = lock(&self.reported_cwd).clone();
        if !r.is_empty() {
            return r;
        }
        std::env::current_dir()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default()
    }

    // ── 터미널 모드 ──

    /// 앱이 지금 켜 둔 모드다.
    pub fn term_modes(&self) -> TermModes {
        TermModes::unpack(self.modes.load(SeqCst))
    }

    pub fn bracketed_paste(&self) -> bool {
        self.modes.load(SeqCst) & (1 << 32) != 0
    }

    pub fn modes_packed(&self) -> u64 {
        self.modes.load(SeqCst)
    }

    pub fn set_modes_packed(&self, v: u64) {
        self.modes.store(v, SeqCst);
    }

    /// 청크 하나의 모드 관측이다 (검사·PTY 없는 도구).
    pub fn observe_modes(&self, chunk: &[u8]) {
        let mut rs = lock(&self.read);
        self.observe_modes_classified(&mut rs, chunk, classify_esc(chunk, false).modes);
    }

    fn observe_modes_classified(&self, rs: &mut ReadState, chunk: &[u8], need: bool) {
        let cur = self.term_modes();
        let next = rs.modes.observe_classified(cur, chunk, need);
        if next != cur {
            self.modes.store(next.pack(), SeqCst);
        }
    }

    // ── 주의·활동 ──

    /// readPTY 가 청크마다 하는 관측 그대로다 (모드 제외).
    pub fn observe_output(&self, chunk: &[u8]) {
        self.observe_output_at(chunk, attn_now());
    }

    pub fn observe_output_at(&self, chunk: &[u8], now: i64) {
        let c = classify_esc(chunk, self.allow_bell.load(SeqCst));
        let mut rs = lock(&self.read);
        self.observe_output_classified(&mut rs, chunk, now, c);
    }

    fn observe_output_classified(&self, rs: &mut ReadState, chunk: &[u8], now: i64, c: EscClass) {
        self.last_output_at.store(now, SeqCst);
        if !self.attn_rearm_locked.load(SeqCst) {
            self.attn_armed.store(true, SeqCst);
        }
        if rs.attn_carry.is_empty() && !c.osc {
            return;
        }
        let ReadState {
            attn_carry,
            scratch,
            ..
        } = rs;
        let scan: &[u8] = if attn_carry.is_empty() {
            chunk
        } else {
            scratch.clear();
            scratch.extend_from_slice(attn_carry);
            scratch.extend_from_slice(chunk);
            scratch
        };
        // cwd 보고는 알람 배선과 무관하게 읽는다 (FR-WTC-2).
        self.note_cwd_report(&detect_cwd_report(scan));
        if self.hooks.on_attention.is_none() {
            return;
        }
        let (sig, carry) =
            detect_attention_signal(scan, self.allow_bell.load(SeqCst), ATTN_MAX_CARRY);
        *attn_carry = carry.unwrap_or_default();
        // FR-ATN-22: 에이전트 도구의 알림 시퀀스는 알람이 아니다.
        if sig && !self.agent_seen.load(SeqCst) {
            self.set_attention("signaled");
        }
    }

    fn set_attention(&self, reason: &str) -> bool {
        if self
            .attention
            .compare_exchange(false, true, SeqCst, SeqCst)
            .is_ok()
        {
            if let Some(f) = &self.hooks.on_attention {
                f(&self.id, reason);
            }
            return true;
        }
        false
    }

    /// 명시 신호(`otterctl notify`)다. 판정(묶음 N)을 통과하면 이미 서 있어도 다시 알린다.
    pub fn signal_attention(&self, reason: &str) {
        if !self.turn.allow_signal(reason) {
            return;
        }
        self.attention.store(true, SeqCst);
        if let Some(f) = &self.hooks.on_attention {
            f(&self.id, reason);
        }
    }

    /// 활동 이벤트에서 파생한 알람이다 (FR-AEV-10).
    pub fn signal_agent_event(&self, state: &str, turn_known: bool) {
        if !self.turn.allow_activity_signal(state, turn_known) {
            return;
        }
        self.attention.store(true, SeqCst);
        if let Some(f) = &self.hooks.on_attention {
            f(&self.id, state);
        }
    }

    fn clear_attention(&self) -> bool {
        if self
            .attention
            .compare_exchange(true, false, SeqCst, SeqCst)
            .is_ok()
        {
            if let Some(f) = &self.hooks.on_attention_clear {
                f(&self.id);
            }
            return true;
        }
        false
    }

    /// 사용자가 봤다. 다음 출력이 재무장하지 못하게 잠근다.
    pub fn attend(&self) {
        self.attn_armed.store(false, SeqCst);
        self.attn_rearm_locked.store(true, SeqCst);
        self.clear_attention();
    }

    /// 사용자가 키를 눌렀다. 재무장 잠금을 푼다.
    pub fn attend_typed(&self) {
        self.attn_armed.store(false, SeqCst);
        self.attn_rearm_locked.store(false, SeqCst);
        self.clear_attention();
    }

    pub fn attention(&self) -> bool {
        self.attention.load(SeqCst)
    }

    pub fn set_allow_bell(&self, v: bool) {
        self.allow_bell.store(v, SeqCst);
    }

    pub fn last_output_at(&self) -> i64 {
        self.last_output_at.load(SeqCst)
    }

    pub fn set_last_output_at(&self, v: i64) {
        self.last_output_at.store(v, SeqCst);
    }

    /// L2 유휴 판정이다. threshold 는 나노초이고 0 이하면 끈다.
    pub fn maybe_idle(&self, now: i64, threshold: i64) {
        self.maybe_idle_with(now, threshold, |p| p.attn_busy())
    }

    /// 바쁨 판정을 미리 구한 maybe_idle 이다 (sweeper 의 일괄 조회).
    pub fn maybe_idle_with(&self, now: i64, threshold: i64, busy: impl FnOnce(&Self) -> bool) {
        if threshold <= 0 || !self.attn_armed.load(SeqCst) {
            return;
        }
        if now - self.last_output_at.load(SeqCst) < threshold {
            return;
        }
        self.attn_armed.store(false, SeqCst);
        if !self.agent_seen.load(SeqCst) || !self.turn.in_progress() {
            return;
        }
        if activity_still_working(lock(&self.activity).as_ref(), now) {
            return;
        }
        if !busy(self) {
            return;
        }
        self.set_attention("idle");
    }

    /// 유휴 알람의 바쁨 판정이다. 검사가 갈아 끼운 것이 있으면 그것이다.
    pub fn attn_busy(&self) -> bool {
        if let Some(f) = read_lock(&ATTN_BUSY).as_ref() {
            return f(self);
        }
        self.is_busy()
    }

    pub fn set_activity(&self, state: &str, tool: &str, detail: &str) {
        self.agent_seen.store(state != activity::ENDED, SeqCst);
        self.turn.note_activity(state);
        *lock(&self.activity) = (state != activity::ENDED).then(|| ActivityState {
            state: state.to_string(),
            tool: tool.to_string(),
            detail: detail.to_string(),
            updated_at: attn_now(),
        });
        if let Some(f) = &self.hooks.on_activity {
            f(&self.id, state, tool, detail);
        }
    }

    /// main 활동 보고 하나의 반영이다 — 활동, done·waiting 이면 알람 파생 (FR-AEV-10).
    pub fn report_activity(&self, state: &str, tool: &str, detail: &str, turn_known: bool) {
        self.set_activity(state, tool, detail);
        if activity::alarms(state) {
            self.signal_agent_event(state, turn_known);
        }
    }

    pub fn activity(&self) -> Option<ActivityState> {
        lock(&self.activity).clone()
    }

    pub fn agent_state(&self) -> AgentState {
        AgentState {
            activity: self.activity(),
            agent_seen: self.agent_seen.load(SeqCst),
            armed: self.attn_armed.load(SeqCst),
            attention: self.attention.load(SeqCst),
            last_output_at: self.last_output_at.load(SeqCst),
            rearm_locked: self.attn_rearm_locked.load(SeqCst),
            turn: self.turn.state(),
        }
    }

    /// 상태를 st 로 되세운다. 알림은 부르지 않는다. 마지막 출력 시각은 그대로 둔다.
    pub fn restore_agent_state(&self, st: &AgentState) {
        *lock(&self.activity) = st.activity.clone();
        self.agent_seen.store(st.agent_seen, SeqCst);
        self.attn_armed.store(st.armed, SeqCst);
        self.attention.store(st.attention, SeqCst);
        self.attn_rearm_locked.store(st.rearm_locked, SeqCst);
        self.turn.restore(st.turn);
    }

    // ── 기록 ──

    /// kind 의 값을 바꾼다. 비었거나 `null` 이면 지운다.
    pub fn set_record(&self, kind: &str, v: &[u8]) {
        let mut r = lock(&self.records);
        if v.is_empty() || v == b"null" {
            r.remove(kind);
            return;
        }
        r.insert(kind.to_string(), RawMessage(v.to_vec()));
    }

    pub fn records(&self) -> BTreeMap<String, RawMessage> {
        lock(&self.records).clone()
    }

    // ── freeze (데몬 교체) ──

    /// 읽기를 멈추고 읽기 스레드가 멈춘 자리에 설 때까지 기다린다. handover 능력이 없으면 거짓.
    pub fn freeze(&self) -> bool {
        let Some(h) = self.term.as_ref().and_then(|t| t.handover()) else {
            return false;
        };
        lock(&self.frz).frozen = true;
        h.freeze();
        let mut f = lock(&self.frz);
        while !f.parked && !f.read_done {
            f = self.frz_cv.wait(f).unwrap_or_else(|e| e.into_inner());
        }
        true
    }

    pub fn thaw(&self) {
        let Some(h) = self.term.as_ref().and_then(|t| t.handover()) else {
            return;
        };
        lock(&self.frz).frozen = false;
        h.thaw();
        let _g = lock(&self.frz);
        self.frz_cv.notify_all();
    }

    /// 읽기 스레드가 멈춘 자리에 섰는가다.
    pub fn parked(&self) -> bool {
        lock(&self.frz).parked
    }

    fn park_while_frozen(&self) {
        let mut f = lock(&self.frz);
        f.parked = true;
        self.frz_cv.notify_all();
        while f.frozen {
            f = self.frz_cv.wait(f).unwrap_or_else(|e| e.into_inner());
        }
        f.parked = false;
    }

    fn mark_read_done(&self) {
        lock(&self.frz).read_done = true;
        self.frz_cv.notify_all();
    }
}

impl std::fmt::Debug for Tool {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Tool")
            .field("id", &self.id)
            .field("name", &self.name)
            .field("pid", &self.cmd_process_pid())
            .finish()
    }
}

/// 여러 도구의 바쁨을 한 번에 묻는다. 순서는 ps 와 같다. pid 가 없으면 거짓이다.
pub fn busy_of(info: &dyn otter_shared_platform::ProcInfo, ps: &[Arc<Tool>]) -> Vec<bool> {
    let pids: Vec<i32> = ps
        .iter()
        .map(|p| p.cmd_process_pid())
        .filter(|&p| p > 0)
        .collect();
    let children = info.children_of(&pids);
    ps.iter()
        .map(|p| {
            let pid = p.cmd_process_pid();
            pid > 0 && children.get(&pid).copied().unwrap_or(false)
        })
        .collect()
}

/// 유휴 알람의 일괄 바쁨 판정이다. 검사가 갈아 끼운 것이 있으면 그것이다.
pub(crate) fn attn_busy_many(
    info: &dyn otter_shared_platform::ProcInfo,
    ps: &[Arc<Tool>],
) -> Vec<bool> {
    if let Some(f) = read_lock(&ATTN_BUSY).as_ref() {
        return ps.iter().map(|p| f(p)).collect();
    }
    busy_of(info, ps)
}

#[cfg(unix)]
fn is_eio(e: &io::Error) -> bool {
    e.raw_os_error() == Some(nix::libc::EIO)
}

#[cfg(not(unix))]
fn is_eio(_: &io::Error) -> bool {
    false
}

#[cfg(test)]
mod tests;
