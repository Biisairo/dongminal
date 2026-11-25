//! 데몬 안의 도구 등록부 (manager*.go·persist.go·foreground.go·bracketpaste.go·handover.go·freeze.go).

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fmt;
use std::io;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering::SeqCst};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, RwLock, RwLockReadGuard, RwLockWriteGuard, Weak};
use std::thread;
use std::time::{Duration, Instant};

use otter_gocompat::filepath;
use otter_gocompat::json::{self, RawMessage};
use otter_shared_activity as activity;
use otter_shared_otterenv as otterenv;
use otter_shared_otterlog::{errorf, infof, warnf};
use otter_shared_outbuf::Stream;
use otter_shared_platform::{ProcInfo, ProcSpec, Terminal};
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

use crate::tool::{ActivityFn, AttentionFn, ClearFn, ExitFn, SizeFn, attn_busy_many, attn_now};
use crate::{
    ActivitySnap, AgentState, BUF_MAX, BackgroundEntry, HISTORY_CAP, ShellState, Tool, ToolHistory,
    ToolHooks, ToolInfo, ToolScreen, ToolSnapshot, attention_allow_bell, attention_idle_threshold,
    judge_shell,
};

/// 도구 수 상한이다 (M8 D-A-16).
pub const TOOL_CAP: usize = 256;
pub const DEFAULT_COLS: u16 = 120;
pub const DEFAULT_ROWS: u16 = 40;
pub const MAX_TERMINAL_DIM: u64 = 4096;
const DEFAULT_TOOL_NAME: &str = "Shell";
/// 봉인 뒤 진행 중인 생성이 끝나기를 기다리는 상한과 주기다.
const SEAL_WAIT: Duration = Duration::from_secs(5);
const SEAL_POLL: Duration = Duration::from_millis(10);
/// 붙여넣기와 제출(CR) 사이의 간격이다 (BRACKETED_PASTE_SRS).
pub const PASTE_SUBMIT_DELAY: Duration = Duration::from_millis(120);
/// 도구별 전경 이름 재조회 주기다 (FR-TAN-8).
pub const FOREGROUND_REFRESH_INTERVAL: Duration = Duration::from_secs(2);
const FG_NAME_MAX: usize = 16;
const FG_SHELL_NAMES: [&str; 5] = ["sh", "bash", "zsh", "fish", "dash"];
const PASTE_BEGIN: &[u8] = b"\x1b[200~";
const PASTE_END: &[u8] = b"\x1b[201~";

/// 등록부의 실패다. 문구는 Go 의 오류 값과 같다.
#[derive(Debug)]
pub enum ManagerError {
    /// `ErrToolNotFound`.
    NotFound,
    /// `ErrToolCap`.
    ToolCap,
    /// `ErrSealed`.
    Sealed,
    Other(io::Error),
}

impl fmt::Display for ManagerError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotFound => f.write_str("toolhub: tool not found"),
            Self::ToolCap => f.write_str("도구 수가 상한에 이르렀다"),
            Self::Sealed => f.write_str("데몬 교체 중이라 도구를 만들 수 없다"),
            Self::Other(e) => e.fmt(f),
        }
    }
}

impl std::error::Error for ManagerError {}

impl From<io::Error> for ManagerError {
    fn from(e: io::Error) -> Self {
        Self::Other(e)
    }
}

/// 도구를 어디에 어떻게 띄울지다 (FR-SBX-10, FR-ARE-5).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Placement {
    pub window_uuid: String,
    /// 비어 있지 않으면 샌드박스 창이다.
    pub profile: String,
    pub work: String,
    /// 셸 대신 띄울 명령이다.
    pub command: String,
    pub extra_env: Vec<String>,
    /// Create 가 채운다.
    pub host_dir: String,
    pub tool_id: String,
}

/// tools.json 의 한 줄이다.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "toolhub.ToolState")]
pub struct ToolState {
    pub id: String,
    pub name: String,
    pub cwd: String,
    #[serde(skip_serializing_if = "json::is_empty")]
    pub pid: i64,
}

/// 데몬 교체 때 넘기는 도구 하나다 (`d --handover-fd`, FR-RSP-22). JSON 은 Go 와 같다.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "toolhub.HandoverTool")]
pub struct HandoverTool {
    pub id: String,
    pub name: String,
    pub fd: u64,
    pub pid: i64,
    pub cols: u16,
    pub rows: u16,
    #[serde(skip_serializing_if = "json::is_empty")]
    pub background: bool,
    #[serde(skip_serializing_if = "json::is_empty")]
    pub sandboxed: bool,
    #[serde(with = "json::bytes", skip_serializing_if = "json::is_empty")]
    pub screen: Vec<u8>,
    pub offset: i64,
    /// 화면 상태 스냅숏(PERF D-27, 인계 판 2).
    #[serde(rename = "screenState", with = "json::bytes")]
    pub screen_state: Vec<u8>,
    /// 스냅숏이 싣지 않은 끝나지 않은 바이트 수다. 링의 마지막 그만큼을 이어 넣는다.
    #[serde(rename = "screenBack")]
    pub screen_back: u64,
    /// 줄 저장소 그림(블록과 절대 줄 번호).
    #[serde(with = "json::bytes")]
    pub history: Vec<u8>,
    #[serde(skip_serializing_if = "json::is_empty")]
    pub modes: u64,
    #[serde(skip_serializing_if = "json::is_empty")]
    pub cwd: String,
    pub agent: AgentState,
    #[serde(skip_serializing_if = "json::is_empty")]
    pub records: BTreeMap<String, RawMessage>,
}

/// 도구 하나를 띄우는 요청이다. 검사가 시작 함수를 갈아 끼울 때 받는다.
pub struct StartReq<'a> {
    pub id: &'a str,
    pub name: &'a str,
    pub cwd: &'a str,
    pub cols: u16,
    pub rows: u16,
    pub on_exit: Option<ExitFn>,
    pub hooks: Option<ToolHooks>,
    pub place: Option<&'a ProcSpec>,
    pub extra_env: &'a [String],
}

pub type StartFn = Arc<dyn Fn(StartReq<'_>) -> io::Result<Arc<Tool>> + Send + Sync>;
pub type PlacerFn = Arc<dyn Fn(&Placement) -> io::Result<ProcSpec> + Send + Sync>;
pub type InvalidatorFn = Arc<dyn Fn(&str) + Send + Sync>;
pub type OwnedFn = Arc<dyn Fn() -> HashSet<String> + Send + Sync>;
pub type ForegroundFn = Arc<dyn Fn(&str, &str) + Send + Sync>;
/// 전경 이름 조회(도구 id 들 → id 별 이름)를 갈아 끼우는 자리다.
pub type ForegroundProbeFn = Arc<dyn Fn(&[String]) -> HashMap<String, String> + Send + Sync>;

struct State {
    tools: HashMap<String, Arc<Tool>>,
    pending: usize,
    sealed: bool,
    start: StartFn,
    invalidator: Option<InvalidatorFn>,
    owned: Option<OwnedFn>,
    placer: Option<PlacerFn>,
    idle_threshold: i64,
    allow_bell: bool,
    /// 줄 저장소 상한(D-25 `termHistoryLines`). 도구를 등록할 때마다 얹는다.
    history_lines: usize,
    attn_notify: Option<AttentionFn>,
    attn_clear: Option<ClearFn>,
    activity_notify: Option<ActivityFn>,
    background: HashMap<String, i64>,
}

#[derive(Default)]
struct SaveState {
    no_save: bool,
    running: bool,
    queued: bool,
}

#[derive(Default)]
struct FgState {
    cache: HashMap<String, (String, Instant)>,
    notify: Option<ForegroundFn>,
    probe: Option<ForegroundProbeFn>,
}

struct Inner {
    st: RwLock<State>,
    data_dir: String,
    info: &'static dyn ProcInfo,
    mutated: AtomicBool,
    save: Mutex<SaveState>,
    save_cv: Condvar,
    save_file: Mutex<()>,
    fg: Mutex<FgState>,
    fg_flight: Mutex<()>,
    sz_notify: Arc<Mutex<Option<SizeFn>>>,
}

/// 데몬 안의 도구 등록부다. 값을 복제해 나눠 쓴다.
#[derive(Clone)]
pub struct ToolManager {
    inner: Arc<Inner>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn now_nanos() -> i64 {
    attn_now()
}

impl ToolManager {
    /// 빈 등록부다. data_dir 은 tools.json 의 자리이고 비어 있으면 저장하지 않는다.
    /// invalidator 는 도구가 죽을 때마다 불린다.
    pub fn new(data_dir: &str, invalidator: Option<InvalidatorFn>) -> Self {
        Self::with_proc_info(data_dir, invalidator, otter_shared_platform::current().info)
    }

    /// 프로세스 정보 조회를 정해 만든다(검사).
    pub fn with_proc_info(
        data_dir: &str,
        invalidator: Option<InvalidatorFn>,
        info: &'static dyn ProcInfo,
    ) -> Self {
        let start: StartFn = Arc::new(|r: StartReq<'_>| {
            Tool::start(
                r.id,
                r.name,
                r.cwd,
                r.cols,
                r.rows,
                r.on_exit,
                r.hooks,
                r.place,
                r.extra_env,
            )
        });
        Self {
            inner: Arc::new(Inner {
                st: RwLock::new(State {
                    tools: HashMap::new(),
                    pending: 0,
                    sealed: false,
                    start,
                    invalidator,
                    owned: None,
                    placer: None,
                    idle_threshold: i64::try_from(attention_idle_threshold().as_nanos())
                        .unwrap_or(i64::MAX),
                    allow_bell: attention_allow_bell(),
                    history_lines: HISTORY_CAP,
                    attn_notify: None,
                    attn_clear: None,
                    activity_notify: None,
                    background: HashMap::new(),
                }),
                data_dir: data_dir.to_string(),
                info,
                mutated: AtomicBool::new(false),
                save: Mutex::new(SaveState::default()),
                save_cv: Condvar::new(),
                save_file: Mutex::new(()),
                fg: Mutex::new(FgState::default()),
                fg_flight: Mutex::new(()),
                sz_notify: Arc::new(Mutex::new(None)),
            }),
        }
    }

    fn rd(&self) -> RwLockReadGuard<'_, State> {
        self.inner.st.read().unwrap_or_else(|e| e.into_inner())
    }

    fn wr(&self) -> RwLockWriteGuard<'_, State> {
        self.inner.st.write().unwrap_or_else(|e| e.into_inner())
    }

    /// 이 등록부가 띄우는 도구 셸의 환경을 프로세스 환경 위에 덮는다. Go 는 홈(`OTTERMINAL_HOME`)·
    /// 도구 홈을 `os.Setenv` 로 넘겼다 — Rust 는 프로세스 환경을 바꾸지 않고 여기로 넘긴다. 셸
    /// 환경뿐 아니라 bin 자리·PATH·HOME·히스토리 자리도 이 값으로 정한다. 이후 띄우는 도구부터
    /// 적용되며 [`ToolManager::set_start`] 를 덮어쓴다.
    pub fn set_env_overlay(&self, vars: Vec<(String, String)>) {
        let vars = Arc::new(vars);
        self.set_start(Arc::new(move |r: StartReq<'_>| {
            let g = |k: &str| crate::env::overlay_getenv(&vars, k);
            Tool::start_with(
                &g,
                &vars,
                r.id,
                r.name,
                r.cwd,
                (r.cols, r.rows),
                r.on_exit,
                r.hooks,
                r.place,
                r.extra_env,
            )
        }));
    }

    /// 도구를 띄우는 함수를 갈아 끼운다(검사).
    pub fn set_start(&self, f: StartFn) {
        self.wr().start = f;
    }

    pub fn data_dir(&self) -> &str {
        &self.inner.data_dir
    }

    fn data_path(&self, name: &str) -> String {
        if self.inner.data_dir.is_empty() {
            return String::new();
        }
        filepath::join(&[self.inner.data_dir.as_str(), name])
    }

    pub fn get(&self, id: &str) -> Option<Arc<Tool>> {
        self.rd().tools.get(id).cloned()
    }

    pub fn is_live(&self, id: &str) -> bool {
        self.get(id).is_some()
    }

    /// 살아 있는 도구 전부다.
    pub fn snapshot(&self) -> Vec<Arc<Tool>> {
        self.rd().tools.values().cloned().collect()
    }

    fn mark_mutated(&self) {
        self.inner.mutated.store(true, SeqCst);
    }

    /// 목록이다. id 순이다. 비었으면 빈 Vec 이며 Go 는 이것을 nil(와이어 `null`)로 싣는다.
    pub fn list(&self) -> Vec<ToolInfo> {
        let fg = self.foreground_names();
        self.list_with(&fg)
    }

    /// 전경 이름을 새로 묻지 않는 목록이다.
    pub fn list_cached(&self) -> Vec<ToolInfo> {
        let fg = self.cached_foreground_names();
        self.list_with(&fg)
    }

    fn list_with(&self, fg: &HashMap<String, String>) -> Vec<ToolInfo> {
        let st = self.rd();
        let mut out: Vec<ToolInfo> = st
            .tools
            .values()
            .map(|p| {
                let (cols, rows) = p.size().unwrap_or((0, 0));
                ToolInfo {
                    id: p.id.clone(),
                    name: p.name.clone(),
                    pid: i64::from(p.cmd_process_pid()),
                    cols: i64::from(cols),
                    rows: i64::from(rows),
                    fg_name: fg.get(&p.id).cloned().unwrap_or_default(),
                    ..Default::default()
                }
            })
            .collect();
        out.sort_by(|a, b| a.id.cmp(&b.id));
        out
    }

    // ── 생성·삭제 ──

    fn attn_hooks(&self, st: &State) -> ToolHooks {
        let slot = Arc::clone(&self.inner.sz_notify);
        let on_size: SizeFn = Arc::new(move |id, c, r| {
            let f = lock(&slot).clone();
            if let Some(f) = f {
                f(id, c, r);
            }
        });
        if st.attn_notify.is_none() && st.attn_clear.is_none() && st.activity_notify.is_none() {
            return ToolHooks {
                on_size: Some(on_size),
                ..Default::default()
            };
        }
        ToolHooks {
            on_attention: st.attn_notify.clone(),
            on_attention_clear: st.attn_clear.clone(),
            on_activity: st.activity_notify.clone(),
            allow_bell: st.allow_bell,
            on_size: Some(on_size),
        }
    }

    fn exit_hook(&self) -> ExitFn {
        let w: Weak<Inner> = Arc::downgrade(&self.inner);
        Arc::new(move |id: &str| {
            if let Some(inner) = w.upgrade() {
                ToolManager { inner }.tool_exited(id);
            }
        })
    }

    /// 새 도구를 띄운다. 상한(`TOOL_CAP`)·봉인을 지키고, 샌드박스 배치가 실패하면 호스트로 내려가지 않는다 (FR-SBX-21).
    pub fn create(
        &self,
        cwd: &str,
        cols: u16,
        rows: u16,
        mut place: Placement,
    ) -> Result<Arc<Tool>, ManagerError> {
        let id = otter_shared_uuid::new_string();
        place.host_dir = cwd.to_string();
        place.tool_id.clone_from(&id);
        let spec = self.placement(&place)?;
        let (hooks, start) = {
            let mut st = self.wr();
            if st.tools.len() + st.pending >= TOOL_CAP {
                drop(st);
                infof!(None, "[tool] 상한 초과로 생성을 거절한다 (cap={TOOL_CAP})");
                return Err(ManagerError::ToolCap);
            }
            if st.sealed {
                return Err(ManagerError::Sealed);
            }
            st.pending += 1;
            (self.attn_hooks(&st), st.start.clone())
        };
        let res = start(StartReq {
            id: &id,
            name: DEFAULT_TOOL_NAME,
            cwd,
            cols,
            rows,
            on_exit: Some(self.exit_hook()),
            hooks: Some(hooks),
            place: spec.as_ref(),
            extra_env: &place.extra_env,
        });
        let mut st = self.wr();
        st.pending -= 1;
        let p = match res {
            Ok(p) => p,
            Err(e) => {
                errorf!(None, "[tool {id}] create error: {e}");
                return Err(e.into());
            }
        };
        p.set_sandboxed(!place.profile.is_empty());
        st.tools.insert(id.clone(), Arc::clone(&p));
        infof!(None, "[tool {id}] registered total={}", st.tools.len());
        let cap = st.history_lines;
        drop(st);
        p.set_history_lines(cap);
        self.mark_mutated();
        self.save_async();
        // 등록보다 먼저 끝난 프로세스는 종료 경로를 한 번 더 지나게 한다.
        self.reap_if_exited(&p);
        Ok(p)
    }

    fn reap_if_exited(&self, p: &Arc<Tool>) {
        if p.done().is_cancelled() {
            let m = self.clone();
            let id = p.id.clone();
            thread::spawn(move || m.tool_exited(&id));
        }
    }

    fn tool_exited(&self, id: &str) {
        let _ = self.delete(id);
        let f = self.rd().invalidator.clone();
        if let Some(f) = f {
            f(id);
        }
    }

    pub fn set_placer(&self, f: PlacerFn) {
        self.wr().placer = Some(f);
    }

    fn placement(&self, place: &Placement) -> Result<Option<ProcSpec>, ManagerError> {
        if place.profile.is_empty() {
            if place.command.is_empty() {
                return Ok(None);
            }
            let argv = otter_shared_platform::current()
                .shell
                .run_command(&place.command);
            let Some(path) = argv.first().cloned() else {
                return Err(io::Error::other(
                    "이 호스트의 셸에서 명령을 실행할 방법을 알지 못합니다",
                )
                .into());
            };
            return Ok(Some(ProcSpec {
                path,
                args: argv,
                env: vec![],
                dir: String::new(),
            }));
        }
        let f = self.rd().placer.clone();
        let Some(f) = f else {
            return Err(io::Error::other(format!(
                "샌드박스 창({})이지만 컨테이너 배치가 구성되지 않았습니다",
                place.profile
            ))
            .into());
        };
        Ok(Some(f(place)?))
    }

    /// 저장된 도구를 같은 id 로 다시 띄운다.
    pub fn restore(
        &self,
        id: &str,
        name: &str,
        cwd: &str,
        cols: u16,
        rows: u16,
    ) -> Result<(), ManagerError> {
        let (hooks, start) = {
            let mut st = self.wr();
            if st.sealed {
                return Err(ManagerError::Sealed);
            }
            st.pending += 1;
            (self.attn_hooks(&st), st.start.clone())
        };
        let res = start(StartReq {
            id,
            name,
            cwd,
            cols,
            rows,
            on_exit: Some(self.exit_hook()),
            hooks: Some(hooks),
            place: None,
            extra_env: &[],
        });
        let mut st = self.wr();
        st.pending -= 1;
        let p = res?;
        st.tools.insert(id.to_string(), Arc::clone(&p));
        infof!(None, "[tool {id}] restored total={}", st.tools.len());
        let cap = st.history_lines;
        drop(st);
        p.set_history_lines(cap);
        self.reap_if_exited(&p);
        Ok(())
    }

    /// 이미 만든 도구를 등록한다.
    pub fn adopt(&self, p: Arc<Tool>) {
        if p.id.is_empty() {
            return;
        }
        let cap = {
            let mut st = self.wr();
            st.tools.insert(p.id.clone(), Arc::clone(&p));
            st.history_lines
        };
        p.set_history_lines(cap);
    }

    /// 프로세스 없는 도구를 만들어 등록한다.
    pub fn adopt_detached(&self, id: &str) -> Arc<Tool> {
        let hooks = self.attn_hooks(&self.rd());
        let p = Tool::new_detached(id, Some(hooks));
        self.adopt(Arc::clone(&p));
        p
    }

    /// 정중히 끝내기를 청하고 grace 안에 끝나기를 기다린 뒤 지운다 (FR-BGK-7).
    pub async fn terminate(&self, id: &str, grace: Duration) -> Result<(), ManagerError> {
        let Some(p) = self.get(id) else {
            return Err(ManagerError::NotFound);
        };
        p.terminate_wait(grace).await;
        let m = self.clone();
        let id = id.to_string();
        let _ = tokio::task::spawn_blocking(move || m.delete(&id)).await;
        Ok(())
    }

    /// 도구를 지운다. 없으면 `NotFound` 다. kill 을 기다리므로 블로킹이다.
    pub fn delete(&self, id: &str) -> Result<(), ManagerError> {
        let (p, remaining) = {
            let mut st = self.wr();
            let p = st.tools.remove(id);
            st.background.remove(id);
            (p, st.tools.len())
        };
        if let Some(p) = &p {
            p.kill();
            infof!(None, "[tool {id}] deleted remaining={remaining}");
        }
        self.mark_mutated();
        self.save_async();
        p.map(|_| ()).ok_or(ManagerError::NotFound)
    }

    // ── 저장 ──

    fn save_async(&self) {
        {
            let mut s = lock(&self.inner.save);
            if s.no_save {
                return;
            }
            if s.running {
                s.queued = true;
                return;
            }
            s.running = true;
        }
        let m = self.clone();
        thread::spawn(move || {
            loop {
                m.save_all();
                let mut s = lock(&m.inner.save);
                if !s.queued {
                    s.running = false;
                    m.inner.save_cv.notify_all();
                    return;
                }
                s.queued = false;
            }
        });
    }

    /// 저장을 멈추고 진행 중인 저장을 기다린다.
    pub fn stop_saving(&self) {
        let mut s = lock(&self.inner.save);
        s.no_save = true;
        while s.running {
            s = self
                .inner
                .save_cv
                .wait(s)
                .unwrap_or_else(|e| e.into_inner());
        }
    }

    /// tools.json 을 쓴다. 바뀐 것이 없으면 쓰지 않는다. 샌드박스 도구와 남의 백그라운드 도구는 빼고 id 순이다.
    pub fn save_all(&self) {
        let path = self.data_path(otterenv::TOOLS_FILE);
        if path.is_empty() || !self.inner.mutated.load(SeqCst) {
            return;
        }
        let _g = lock(&self.inner.save_file);
        let snap = self.snapshot();
        let owned = self.owned_tools();
        let pids: Vec<i32> = snap
            .iter()
            .map(|p| p.cmd_process_pid())
            .filter(|&p| p > 0)
            .collect();
        let cwds = self.inner.info.cwds(&pids);
        let mut states: Vec<ToolState> = snap
            .iter()
            .filter(|p| {
                !self.is_background(&p.id) || owned.as_ref().is_some_and(|o| o.contains(&p.id))
            })
            .filter(|p| !p.sandboxed())
            .map(|p| ToolState {
                id: p.id.clone(),
                name: p.name.clone(),
                cwd: p.cwd_or_server(&cwds),
                pid: i64::from(p.cmd_process_pid()),
            })
            .collect();
        states.sort_by(|a, b| a.id.cmp(&b.id));
        let data = match json::marshal(&states) {
            Ok(d) => d,
            Err(e) => {
                infof!(None, "saveTools marshal: {e}");
                return;
            }
        };
        if let Err(e) = otter_shared_platform::write_state_file(Path::new(&path), &data, 0o644) {
            infof!(None, "saveTools: {e}");
        }
    }

    /// tools.json 의 도구 중 referenced 에 있는 것만 되살린다.
    pub fn load_all(&self, referenced: &HashSet<String>) {
        self.load_all_with(referenced, |id, name, cwd, c, r| {
            self.restore(id, name, cwd, c, r)
        });
    }

    pub fn load_all_with<E: fmt::Display>(
        &self,
        referenced: &HashSet<String>,
        mut restore: impl FnMut(&str, &str, &str, u16, u16) -> Result<(), E>,
    ) {
        let path = self.data_path(otterenv::TOOLS_FILE);
        if path.is_empty() {
            return;
        }
        let data = match std::fs::read(&path) {
            Ok(d) => d,
            Err(e) => {
                if e.kind() != io::ErrorKind::NotFound {
                    infof!(
                        None,
                        "loadTools: {}",
                        otter_gocompat::oserr::path_error("open", &path, e)
                    );
                }
                return;
            }
        };
        let states: Option<Vec<ToolState>> = match json::unmarshal(&data) {
            Ok(s) => s,
            Err(e) => {
                infof!(None, "loadTools unmarshal: {e}");
                return;
            }
        };
        let (mut restored, mut skipped) = (0, 0);
        for s in states.unwrap_or_default() {
            if !referenced.contains(&s.id) {
                skipped += 1;
                continue;
            }
            if let Err(e) = restore(&s.id, &s.name, &s.cwd, DEFAULT_COLS, DEFAULT_ROWS) {
                errorf!(None, "[tool {}] restore error: {e}", s.id);
                continue;
            }
            restored += 1;
        }
        if skipped > 0 {
            warnf!(None, "tools: 미참조 {skipped}개 폐기");
        }
        self.mark_mutated();
        infof!(None, "tools restored count={restored}");
    }

    pub fn set_owned_tools(&self, f: OwnedFn) {
        self.wr().owned = Some(f);
    }

    fn owned_tools(&self) -> Option<HashSet<String>> {
        let f = self.rd().owned.clone();
        f.map(|f| f())
    }

    pub fn set_invalidator(&self, f: Option<InvalidatorFn>) {
        self.wr().invalidator = f;
    }

    // ── 허브 표면 ──

    pub fn write(&self, id: &str, data: &[u8]) -> Result<(), ManagerError> {
        let p = self.get(id).ok_or(ManagerError::NotFound)?;
        Ok(p.write(data)?)
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), ManagerError> {
        let p = self.get(id).ok_or(ManagerError::NotFound)?;
        Ok(p.resize(cols, rows)?)
    }

    /// 도구의 지금 자리다. 없으면 "".
    pub fn cwd(&self, id: &str) -> String {
        self.get(id).map(|p| p.cwd()).unwrap_or_default()
    }

    pub fn busy(&self, id: &str) -> bool {
        self.get(id).is_some_and(|p| p.is_busy())
    }

    /// ids 전부의 바쁨을 한 번에 묻는다 (FR-OPT-2-4). 없는 도구는 거짓이다.
    pub fn busy_many(&self, ids: &[String]) -> HashMap<String, bool> {
        let found: Vec<(String, Option<Arc<Tool>>)> = {
            let st = self.rd();
            ids.iter()
                .map(|id| (id.clone(), st.tools.get(id).cloned()))
                .collect()
        };
        let live: Vec<Arc<Tool>> = found.iter().filter_map(|(_, p)| p.clone()).collect();
        let busy = crate::busy_of(self.inner.info, &live);
        let by_id: HashMap<&str, bool> = live.iter().map(|p| p.id.as_str()).zip(busy).collect();
        found
            .iter()
            .map(|(id, p)| {
                (
                    id.clone(),
                    p.is_some() && by_id.get(id.as_str()).copied().unwrap_or(false),
                )
            })
            .collect()
    }

    /// Run 복구의 셸 판정이다 (FR-RRC-10).
    pub fn shell_probe(&self, id: &str, cands: &[i32]) -> ShellState {
        let Some(p) = self.get(id) else {
            return ShellState::Unknown;
        };
        let parents = self.inner.info.parents();
        judge_shell(parents.as_ref(), p.cmd_process_pid(), cands)
    }

    pub fn snapshot_tool(&self, id: &str) -> ToolSnapshot {
        self.snapshot_tool_since(id, -1)
    }

    /// since 에서 이어 붙일 수 있으면 그 뒤만, 아니면 전량이다 (FR-TRS-2~4). 없는 도구는 빈 값이다.
    /// 화면 상태 스냅숏이다 (PERF FR-TRM-4). 없는 도구·터미널 없는 도구는 `None`.
    pub fn screen_tool(&self, id: &str, history: usize) -> Option<ToolScreen> {
        self.get(id)?.screen(history)
    }

    /// 줄 저장소의 기록 구간이다 (PERF FR-TRM-5). 없는 도구·터미널 없는 도구는 `None`.
    pub fn history_tool(&self, id: &str, before: u64, count: usize) -> Option<ToolHistory> {
        self.get(id)?.history(before, count)
    }

    pub fn snapshot_tool_since(&self, id: &str, since: i64) -> ToolSnapshot {
        let Some(p) = self.get(id) else {
            return ToolSnapshot::default();
        };
        let Some(s) = p.stream() else {
            return ToolSnapshot::default();
        };
        let (cols, rows) = p.size().unwrap_or((0, 0));
        if since >= 0
            && let (Some(data), end) = s.since(since)
        {
            return ToolSnapshot {
                retained: i64::try_from(data.len()).unwrap_or(i64::MAX),
                data,
                total_bytes_in: end,
                end,
                resumed: true,
                cols,
                rows,
                modes: p.term_modes(),
                ..Default::default()
            };
        }
        let (data, stats) = s.snapshot();
        ToolSnapshot {
            data,
            total_bytes_in: stats.total_bytes_in,
            total_bytes_drop: stats.total_bytes_drop,
            retained: i64::try_from(stats.retained).unwrap_or(i64::MAX),
            end: stats.total_bytes_in,
            resumed: false,
            cols,
            rows,
            modes: p.term_modes(),
        }
    }

    /// 탭에서 떼거나(bg) 되돌린다. 없는 도구, 샌드박스 도구의 떼기는 거짓이다 (FR-BG-2/4/7).
    pub fn set_background(&self, id: &str, bg: bool) -> bool {
        let mut st = self.wr();
        let Some(t) = st.tools.get(id) else {
            return false;
        };
        if bg && t.sandboxed() {
            return false;
        }
        if bg {
            st.background
                .entry(id.to_string())
                .or_insert_with(now_nanos);
        } else {
            st.background.remove(id);
        }
        drop(st);
        self.mark_mutated();
        true
    }

    pub fn is_background(&self, id: &str) -> bool {
        self.rd().background.contains_key(id)
    }

    /// 백그라운드 도구들이다. 오래된 것이 먼저다 (FR-BG-6).
    pub fn background_list(&self) -> Vec<BackgroundEntry> {
        let pairs: Vec<(Arc<Tool>, i64)> = {
            let st = self.rd();
            st.background
                .iter()
                .filter_map(|(id, &since)| st.tools.get(id).map(|t| (Arc::clone(t), since)))
                .collect()
        };
        let pids: Vec<i32> = pairs.iter().map(|(t, _)| t.cmd_process_pid()).collect();
        let cwds = self.inner.info.cwds(&pids);
        let mut out: Vec<BackgroundEntry> = pairs
            .iter()
            .map(|(t, since)| BackgroundEntry {
                tool_id: t.id.clone(),
                name: t.name.clone(),
                cwd: t.cwd_or_server(&cwds),
                since: *since,
            })
            .collect();
        out.sort_by_key(|e| e.since);
        out
    }

    /// 텍스트를 넣고 submit 이면 120ms 뒤 CR 로 제출한다. 셸이 bracketed paste 를 켰으면 감싼다 (FR-BPW-4/5).
    pub async fn send_paste(&self, id: &str, text: &[u8], submit: bool) -> io::Result<()> {
        let Some(p) = self.get(id) else {
            return Err(io::Error::other(format!("tool 없음: {id}")));
        };
        p.write(&wrap_paste(text, p.bracketed_paste()))
            .map_err(|e| io::Error::other(format!("터미널 쓰기 (paste): {e}")))?;
        if !submit {
            return Ok(());
        }
        tokio::select! {
            () = tokio::time::sleep(PASTE_SUBMIT_DELAY) => {}
            () = p.done().cancelled() => {
                return Err(io::Error::other("터미널 쓰기 (submit): 도구가 끝났다"));
            }
        }
        p.write(b"\r")
            .map_err(|e| io::Error::other(format!("터미널 쓰기 (submit): {e}")))
    }

    // ── 주의·활동 알림 ──

    pub fn set_attention_notifier(&self, notify: Option<AttentionFn>, clear: Option<ClearFn>) {
        let mut st = self.wr();
        st.attn_notify = notify;
        st.attn_clear = clear;
    }

    pub fn set_activity_notifier(&self, notify: Option<ActivityFn>) {
        self.wr().activity_notify = notify;
    }

    /// PTY 크기 변경 알림이다. 이미 만든 도구에도 걸린다 (M9_SRS FR-M9-3).
    pub fn set_resize_notifier(&self, notify: Option<SizeFn>) {
        *lock(&self.inner.sz_notify) = notify;
    }

    /// 활동 카드들이다. `working` 인데 바쁘지 않은 도구는 뺀다. id 순이다.
    pub fn activity_snapshot(&self) -> Vec<ActivitySnap> {
        let items: Vec<(String, crate::ActivityState, Arc<Tool>)> = {
            let st = self.rd();
            st.tools
                .iter()
                .filter_map(|(id, p)| p.activity().map(|a| (id.clone(), a, Arc::clone(p))))
                .collect()
        };
        let working: Vec<Arc<Tool>> = items
            .iter()
            .filter(|(_, a, _)| a.state == activity::WORKING)
            .map(|(_, _, p)| Arc::clone(p))
            .collect();
        let busy: HashSet<String> = working
            .iter()
            .zip(attn_busy_many(self.inner.info, &working))
            .filter(|(_, b)| *b)
            .map(|(p, _)| p.id.clone())
            .collect();
        let mut out: Vec<ActivitySnap> = items
            .into_iter()
            .filter(|(id, a, _)| a.state != activity::WORKING || busy.contains(id))
            .map(|(id, a, _)| ActivitySnap {
                tool_id: id,
                state: a.state,
                tool: a.tool,
                detail: a.detail,
                updated_at: a.updated_at,
            })
            .collect();
        out.sort_by(|a, b| a.tool_id.cmp(&b.tool_id));
        out
    }

    /// 모든 도구에 L2 유휴 판정을 한 번 돌린다.
    pub fn sweep_idle(&self, now: i64) {
        let (tools, th) = {
            let st = self.rd();
            (
                st.tools.values().cloned().collect::<Vec<_>>(),
                st.idle_threshold,
            )
        };
        for p in tools {
            p.maybe_idle(now, th);
        }
    }

    /// period 마다 sweep_idle 을 돈다. cancel 로 멈춘다.
    pub fn spawn_attention_sweeper(
        &self,
        cancel: CancellationToken,
        period: Duration,
    ) -> tokio::task::JoinHandle<()> {
        let m = self.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval_at(tokio::time::Instant::now() + period, period);
            loop {
                tokio::select! {
                    _ = tick.tick() => {
                        let m = m.clone();
                        let _ = tokio::task::spawn_blocking(move || m.sweep_idle(attn_now())).await;
                    }
                    () = cancel.cancelled() => return,
                }
            }
        })
    }

    /// 판정 설정을 바꾼다. allow_bell 은 이미 있는 도구에도 반영된다.
    pub fn set_attention_config(&self, idle: Duration, allow_bell: bool) {
        let tools: Vec<Arc<Tool>> = {
            let mut st = self.wr();
            st.idle_threshold = i64::try_from(idle.as_nanos()).unwrap_or(i64::MAX);
            st.allow_bell = allow_bell;
            st.tools.values().cloned().collect()
        };
        for p in tools {
            p.set_allow_bell(allow_bell);
        }
    }

    pub fn history_lines(&self) -> usize {
        self.rd().history_lines
    }

    /// 기록 줄 수 설정(D-25)을 모든 도구의 줄 저장소 상한으로 얹는다. 뒤에 등록되는 도구도 따른다.
    pub fn set_history_lines(&self, lines: usize) {
        let tools: Vec<Arc<Tool>> = {
            let mut st = self.wr();
            st.history_lines = lines;
            st.tools.values().cloned().collect()
        };
        for p in tools {
            p.set_history_lines(lines);
        }
    }

    /// 주의가 선 도구 전부를 주목 처리하고 그 수를 돌려준다.
    pub fn clear_all_attention(&self) -> i64 {
        let mut n = 0;
        for p in self.snapshot() {
            if p.attention() {
                p.attend();
                n += 1;
            }
        }
        n
    }

    // ── 전경 이름 (FR-TAN-7·8) ──

    pub fn set_foreground_notifier(&self, notify: Option<ForegroundFn>) {
        lock(&self.inner.fg).notify = notify;
    }

    /// 전경 이름 조회를 갈아 끼운다(검사).
    pub fn set_foreground_probe(&self, probe: Option<ForegroundProbeFn>) {
        lock(&self.inner.fg).probe = probe;
    }

    pub fn foreground_names(&self) -> HashMap<String, String> {
        self.refresh_foreground_at(Instant::now());
        self.cached_foreground_names()
    }

    pub fn refresh_foreground(&self) {
        self.refresh_foreground_at(Instant::now());
    }

    /// period 마다 전경 이름을 갱신한다. cancel 로 멈춘다.
    pub fn spawn_foreground_refresh(
        &self,
        cancel: CancellationToken,
        period: Duration,
    ) -> tokio::task::JoinHandle<()> {
        let m = self.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval_at(tokio::time::Instant::now() + period, period);
            loop {
                tokio::select! {
                    _ = tick.tick() => {
                        let m = m.clone();
                        let _ = tokio::task::spawn_blocking(move || m.refresh_foreground()).await;
                    }
                    () = cancel.cancelled() => return,
                }
            }
        })
    }

    fn cached_foreground_names(&self) -> HashMap<String, String> {
        lock(&self.inner.fg)
            .cache
            .iter()
            .filter(|(_, (n, _))| !n.is_empty())
            .map(|(id, (n, _))| (id.clone(), n.clone()))
            .collect()
    }

    fn refresh_foreground_at(&self, now: Instant) {
        let _flight = lock(&self.inner.fg_flight);
        let live = self.snapshot();
        let (stale, notify, probe) = {
            let mut fg = lock(&self.inner.fg);
            let alive: HashSet<&str> = live.iter().map(|p| p.id.as_str()).collect();
            fg.cache.retain(|id, _| alive.contains(id.as_str()));
            let stale: Vec<Arc<Tool>> = live
                .iter()
                .filter(|p| {
                    fg.cache.get(&p.id).is_none_or(|(_, at)| {
                        now.saturating_duration_since(*at) >= FOREGROUND_REFRESH_INTERVAL
                    })
                })
                .cloned()
                .collect();
            (stale, fg.notify.clone(), fg.probe.clone())
        };
        if stale.is_empty() {
            return;
        }
        let mut names = match probe {
            Some(f) => f(&stale.iter().map(|p| p.id.clone()).collect::<Vec<_>>()),
            None => self.foreground_probe(&stale),
        };
        let idle: Vec<&Arc<Tool>> = stale
            .iter()
            .filter(|p| names.get(&p.id).is_none_or(String::is_empty))
            .collect();
        if !idle.is_empty() {
            let home = std::env::var(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
                .unwrap_or_default();
            let cwds = self.foreground_cwds(&idle);
            for p in idle {
                let n = cwd_tab_name(cwds.get(&p.id).map_or("", String::as_str), &home);
                if !n.is_empty() {
                    names.insert(p.id.clone(), n);
                }
            }
        }
        let mut changed = Vec::new();
        {
            let mut fg = lock(&self.inner.fg);
            for p in &stale {
                let name = names.get(&p.id).cloned().unwrap_or_default();
                let prev = fg
                    .cache
                    .get(&p.id)
                    .map(|(n, _)| n.clone())
                    .unwrap_or_default();
                if prev != name {
                    changed.push((p.id.clone(), name.clone()));
                }
                fg.cache.insert(p.id.clone(), (name, now));
            }
        }
        if let Some(f) = notify {
            for (id, name) in changed {
                f(&id, &name);
            }
        }
    }

    fn foreground_probe(&self, reqs: &[Arc<Tool>]) -> HashMap<String, String> {
        let mut hits = Vec::new();
        for p in reqs {
            let Some(term) = p.terminal() else { continue };
            if p.cmd_process_pid() <= 0 {
                continue;
            }
            if let Some(pgid) = term.foreground_pgid() {
                hits.push((p.id.clone(), pgid));
            }
        }
        let pids: Vec<i32> = hits.iter().map(|(_, pid)| *pid).collect();
        let names = self.inner.info.names(&pids);
        hits.into_iter()
            .filter_map(|(id, pid)| {
                let n = derived_name(names.get(&pid).map_or("", String::as_str));
                (!n.is_empty()).then_some((id, n))
            })
            .collect()
    }

    fn foreground_cwds(&self, reqs: &[&Arc<Tool>]) -> HashMap<String, String> {
        let mut out = HashMap::new();
        let mut pids = Vec::new();
        for p in reqs {
            let r = p.reported_cwd();
            if !r.is_empty() {
                out.insert(p.id.clone(), r);
            } else if p.cmd_process_pid() > 0 {
                pids.push(p.cmd_process_pid());
            }
        }
        if pids.is_empty() {
            return out;
        }
        let by_pid = self.inner.info.cwds(&pids);
        for p in reqs {
            if out.contains_key(&p.id) {
                continue;
            }
            if let Some(c) = by_pid.get(&p.cmd_process_pid()).filter(|c| !c.is_empty()) {
                out.insert(p.id.clone(), c.clone());
            }
        }
        out
    }

    // ── 데몬 교체 (handover, freeze) ──

    /// 생성을 봉인하고 모든 도구의 읽기를 멈춘다. 하나라도 못 멈추면 되돌리고 거짓이다.
    pub async fn freeze_all(&self) -> bool {
        if !self.seal().await {
            return false;
        }
        let m = self.clone();
        tokio::task::spawn_blocking(move || {
            let tools = m.snapshot();
            let mut frozen: Vec<Arc<Tool>> = Vec::new();
            for p in tools {
                if !p.freeze() {
                    for q in &frozen {
                        q.thaw();
                    }
                    m.unseal();
                    return false;
                }
                frozen.push(p);
            }
            true
        })
        .await
        .unwrap_or(false)
    }

    pub fn thaw_all(&self) {
        for p in self.snapshot() {
            p.thaw();
        }
        self.unseal();
    }

    async fn seal(&self) -> bool {
        self.wr().sealed = true;
        let never = CancellationToken::new();
        let ok =
            otter_shared_pollwait::until(&never, SEAL_WAIT, SEAL_POLL, || self.rd().pending == 0)
                .await
                .is_ok();
        if !ok {
            self.unseal();
        }
        ok
    }

    fn unseal(&self) {
        self.wr().sealed = false;
    }

    /// 멈춘 도구들을 넘길 모양으로 담는다. 끝난 도구는 빼고, 멈추지 않은 도구가 있으면 실패다.
    pub fn export_handover(&self) -> io::Result<Vec<HandoverTool>> {
        let mut out = Vec::new();
        for p in self.snapshot() {
            if p.exited_now() {
                continue;
            }
            let h = p.terminal().and_then(|t| t.handover().map(|h| (t, h)));
            let (Some((term, h)), true) = (h, p.parked()) else {
                return Err(io::Error::other(format!(
                    "[tool {}] 멈추지 않은 도구가 있다 — FreezeAll 뒤에 담는다",
                    p.id
                )));
            };
            let (cols, rows) = term
                .size()
                .map_err(|e| io::Error::other(format!("[tool {}] 크기: {e}", p.id)))?;
            let (screen, offset) = p
                .stream()
                .map_or((Vec::new(), 0), |s| (s.snapshot().0, s.offset()));
            let sh = p.screen_handover().unwrap_or_default();
            out.push(HandoverTool {
                id: p.id.clone(),
                name: p.name.clone(),
                fd: h.master_fd() as u64,
                pid: i64::from(term.pid()),
                cols,
                rows,
                background: self.is_background(&p.id),
                sandboxed: p.sandboxed(),
                screen,
                offset,
                screen_state: sh.snapshot,
                screen_back: sh.back as u64,
                history: sh.store,
                modes: p.modes_packed(),
                cwd: p.reported_cwd(),
                agent: p.agent_state(),
                records: p.records(),
            });
        }
        Ok(out)
    }

    /// 넘겨받은 도구 하나를 되세우고 읽기를 시작한다 (FR-RSP-22).
    pub fn adopt_handover(&self, ht: HandoverTool) -> io::Result<()> {
        if ht.id.is_empty() {
            return Err(io::Error::other("도구 id 가 비었다"));
        }
        let fd = usize::try_from(ht.fd)
            .map_err(|e| io::Error::other(format!("[tool {}] {e}", ht.id)))?;
        let pid =
            i32::try_from(ht.pid).map_err(|e| io::Error::other(format!("[tool {}] {e}", ht.id)))?;
        let term: Box<dyn Terminal> = otter_shared_platform::adopt_terminal(fd, pid)
            .map_err(|e| io::Error::other(format!("[tool {}] {e}", ht.id)))?;
        let hooks = {
            let st = self.rd();
            if st.tools.contains_key(&ht.id) {
                return Err(io::Error::other(format!(
                    "[tool {}] 이미 있는 도구다",
                    ht.id
                )));
            }
            self.attn_hooks(&st)
        };
        let stream = Stream::restore(BUF_MAX, &ht.screen, ht.offset);
        let p = Tool::on_term(
            &ht.id,
            &ht.name,
            term,
            ht.sandboxed,
            Some(self.exit_hook()),
            Some(hooks),
            stream,
        );
        p.adopt_screen(
            &ht.screen,
            &ht.screen_state,
            usize::try_from(ht.screen_back).unwrap_or(0),
            &ht.history,
            self.history_lines(),
        );
        p.set_modes_packed(ht.modes);
        p.note_cwd_report(&ht.cwd);
        p.restore_agent_state(&ht.agent);
        p.set_last_output_at(ht.agent.last_output_at);
        for (kind, v) in &ht.records {
            p.set_record(kind, &v.0);
        }
        let cap = {
            let mut st = self.wr();
            st.tools.insert(ht.id.clone(), Arc::clone(&p));
            if ht.background {
                st.background.insert(ht.id.clone(), now_nanos());
            }
            st.history_lines
        };
        p.set_history_lines(cap);
        self.mark_mutated();
        p.spawn_reader();
        infof!(
            None,
            "[tool {}] 넘겨받음 pid={} cols={} rows={}",
            ht.id,
            ht.pid,
            ht.cols,
            ht.rows
        );
        Ok(())
    }

    /// 도구들이 쥔 PTY 마스터 fd 들이다.
    pub fn master_fds(&self) -> HashSet<usize> {
        self.snapshot()
            .iter()
            .filter_map(|p| {
                p.terminal()
                    .and_then(|t| t.handover())
                    .map(|h| h.master_fd())
            })
            .collect()
    }
}

/// 셸이 bracketed paste 를 켰으면 본문 안의 끝 표시를 지우고 감싼다.
///
/// FR-RSP-6: Go 는 한 번만 지워서 `ESC[20` `ESC[201~` `1~` 처럼 지운 자리에서 끝 표시가 다시
/// 생겼다(붙여넣기 탈출 → 명령 실행). 여기서는 남지 않을 때까지 지운다. 끝 표시가 겹치지
/// 않은 본문의 결과는 Go 와 같다.
pub fn wrap_paste(text: &[u8], bracketed: bool) -> Vec<u8> {
    if !bracketed {
        return text.to_vec();
    }
    let mut body = strip_once(text);
    while contains(&body, PASTE_END) {
        body = strip_once(&body);
    }
    let mut out = Vec::with_capacity(PASTE_BEGIN.len() + body.len() + PASTE_END.len());
    out.extend_from_slice(PASTE_BEGIN);
    out.extend_from_slice(&body);
    out.extend_from_slice(PASTE_END);
    out
}

fn contains(hay: &[u8], needle: &[u8]) -> bool {
    hay.windows(needle.len()).any(|w| w == needle)
}

/// Go `bytes.ReplaceAll(text, PASTE_END, nil)` 한 번이다.
fn strip_once(text: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len());
    let mut i = 0;
    while i < text.len() {
        if text[i..].starts_with(PASTE_END) {
            i += PASTE_END.len();
        } else {
            out.push(text[i]);
            i += 1;
        }
    }
    out
}

/// `?cols=&rows=` 의 값이다. 0·상한 초과·숫자 아님이면 기본값이다 (Go `ParseSize`).
pub fn parse_size(cols: Option<&str>, rows: Option<&str>) -> (u16, u16) {
    let parse = |v: Option<&str>, def: u16| {
        v.filter(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()))
            .and_then(|s| s.parse::<u16>().ok())
            .filter(|&n| n > 0 && u64::from(n) <= MAX_TERMINAL_DIM)
            .unwrap_or(def)
    };
    (parse(cols, DEFAULT_COLS), parse(rows, DEFAULT_ROWS))
}

fn truncate_chars(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

/// 도구의 자리에서 탭 이름을 짓는다. 홈이면 `~` 다 (FR-TAN-13).
pub(crate) fn cwd_tab_name(cwd: &str, home: &str) -> String {
    if cwd.is_empty() {
        return String::new();
    }
    let clean = filepath::clean(cwd);
    if !home.is_empty() && clean == filepath::clean(home) {
        return "~".to_string();
    }
    let name = filepath::base(&clean);
    if name == "." || name.is_empty() {
        return String::new();
    }
    truncate_chars(&name, FG_NAME_MAX)
}

/// 전경 프로세스 이름을 다듬는다. 셸이면 "" 다.
pub(crate) fn derived_name(raw: &str) -> String {
    let name = raw.trim();
    if name.is_empty() {
        return String::new();
    }
    let base = filepath::base(name);
    let name = base.strip_prefix('-').unwrap_or(&base);
    let sep = if cfg!(windows) { "\\" } else { "/" };
    if name.is_empty() || name == "." || name == sep || FG_SHELL_NAMES.contains(&name) {
        return String::new();
    }
    truncate_chars(name, FG_NAME_MAX)
}

#[cfg(test)]
mod tests;
