//! 주입 trait 의 가짜 (Go `fakes_test.go`·`sandbox_handlers_test.go`·`handlers_stats_test.go`).

use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use dm_shared_sandbox::{self as sandbox, ProfileInfo};
use dm_shared_toolhub::{
    BackgroundEntry, DaemonInfo, OutChunk, Placement, ShellState, ToolInfo, ToolSnapshot,
};
use dm_shared_workspace::{Error as WorkspaceError, TabEntry, WindowInfo};
use dm_webserver_domain_sysstat::Snapshot;
use tokio::sync::mpsc::Sender;
use tokio_util::sync::CancellationToken;

use dm_webserver_hub::{CmdResult, CmdSub, CommandBroker};
use futures_util::future::BoxFuture;
use std::sync::Arc;

use crate::agent_render_env::agent_render_env;
use crate::{
    SandboxReaper, SettingsStore, StatsSnapshotter, ToolError, ToolHub, ToolIdentity, Unsubscribe,
    UpdateService, WorkspaceStore,
};

/// Go `fakePaneHub` 중 이 종단들이 쓰는 것.
#[derive(Default)]
pub(crate) struct FakeHub {
    pub(crate) tools: Mutex<Vec<ToolInfo>>,
    pub(crate) busy: Mutex<HashMap<String, bool>>,
    pub(crate) cwds: Mutex<HashMap<String, String>>,
    /// 마지막 Create 의 인자 (cwd, cols, rows, place).
    pub(crate) last: Mutex<Option<(String, u16, u16, Placement)>>,
    pub(crate) created: AtomicUsize,
    pub(crate) deleted: Mutex<Vec<String>>,
    pub(crate) terminated: Mutex<Vec<(String, Duration)>>,
    /// `list_ok` 가 모른다고 답한다 (Go `fakeUnknownHub`).
    pub(crate) unknown: bool,
    /// `busy_many` 가 답하지 못한다.
    pub(crate) busy_many_fails: bool,
    pub(crate) cap: bool,
    pub(crate) create_err: Option<String>,
    /// 도구마다 구독 (출력 송신자, 종료 신호).
    pub(crate) subs: Mutex<HashMap<String, (Sender<OutChunk>, CancellationToken)>>,
    pub(crate) snaps: Mutex<HashMap<String, ToolSnapshot>>,
    pub(crate) inputs: Mutex<Vec<(String, Vec<u8>)>>,
    pub(crate) resizes: Mutex<Vec<(String, u16, u16)>>,
}

impl FakeHub {
    pub(crate) fn seed(&self, id: &str, name: &str) {
        self.tools.lock().unwrap().push(ToolInfo {
            id: id.to_owned(),
            name: name.to_owned(),
            ..ToolInfo::default()
        });
    }

    fn has(&self, id: &str) -> bool {
        self.tools.lock().unwrap().iter().any(|t| t.id == id)
    }
}

impl ToolHub for FakeHub {
    fn subscribe(&self, tool_id: &str, tx: Sender<OutChunk>) -> (CancellationToken, Unsubscribe) {
        let exit = CancellationToken::new();
        self.subs
            .lock()
            .unwrap()
            .insert(tool_id.to_owned(), (tx, exit.clone()));
        (exit, Box::new(|| {}))
    }
    fn snapshot_tool_since(&self, id: &str, since: i64) -> Result<ToolSnapshot, ToolError> {
        if !self.has(id) {
            return Err(ToolError::NotFound(format!("tool {id} not found")));
        }
        let mut snap = self
            .snaps
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .unwrap_or_default();
        if since >= 0 && since <= snap.end {
            let keep = crate::ws::trim_overlap(&snap.data, snap.end, since).to_vec();
            snap.data = keep;
            snap.resumed = true;
        }
        Ok(snap)
    }
    fn daemon_info(&self) -> DaemonInfo {
        DaemonInfo::default()
    }
    fn reconnects(&self) -> i64 {
        0
    }
    fn has_feature(&self, _: &str) -> bool {
        false
    }
    fn input_notify(&self, id: &str, data: &[u8]) {
        self.inputs
            .lock()
            .unwrap()
            .push((id.to_owned(), data.to_vec()));
    }
    fn resize_notify(&self, id: &str, cols: u16, rows: u16) {
        self.resizes
            .lock()
            .unwrap()
            .push((id.to_owned(), cols, rows));
    }
    fn list(&self) -> Vec<ToolInfo> {
        self.tools.lock().unwrap().clone()
    }
    fn list_ok(&self) -> Option<Vec<ToolInfo>> {
        if self.unknown {
            return None;
        }
        Some(self.list())
    }
    fn connected(&self) -> bool {
        true
    }
    fn create(
        &self,
        cwd: &str,
        cols: u16,
        rows: u16,
        place: &Placement,
    ) -> Result<ToolIdentity, ToolError> {
        *self.last.lock().unwrap() = Some((cwd.to_owned(), cols, rows, place.clone()));
        if self.cap {
            return Err(ToolError::ToolCap("도구 상한(2)에 닿았습니다".to_owned()));
        }
        if let Some(e) = &self.create_err {
            return Err(ToolError::Other(e.clone()));
        }
        let n = self.created.fetch_add(1, Ordering::SeqCst) + 1;
        let id = format!("fake{n}");
        let name = format!("Fake {id}");
        self.seed(&id, &name);
        Ok(ToolIdentity { id, name })
    }
    fn get(&self, id: &str) -> Option<ToolIdentity> {
        self.tools
            .lock()
            .unwrap()
            .iter()
            .find(|t| t.id == id)
            .map(|t| ToolIdentity {
                id: t.id.clone(),
                name: t.name.clone(),
            })
    }
    fn cwd(&self, id: &str) -> String {
        self.cwds
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .unwrap_or_default()
    }
    fn busy(&self, id: &str) -> bool {
        self.busy.lock().unwrap().get(id).copied().unwrap_or(false)
    }
    fn busy_many(&self, ids: &[String]) -> Option<HashMap<String, bool>> {
        if self.busy_many_fails {
            return None;
        }
        Some(ids.iter().map(|id| (id.clone(), self.busy(id))).collect())
    }
    fn shell_probe(&self, _: &str, _: Option<&[i64]>) -> ShellState {
        ShellState::Idle
    }
    fn delete(&self, id: &str) -> Result<(), ToolError> {
        self.deleted.lock().unwrap().push(id.to_owned());
        let had = self.has(id);
        self.tools.lock().unwrap().retain(|t| t.id != id);
        if had {
            Ok(())
        } else {
            Err(ToolError::NotFound(format!("tool {id} not found")))
        }
    }
    fn terminate(&self, id: &str, grace: Duration) -> Result<(), ToolError> {
        self.terminated.lock().unwrap().push((id.to_owned(), grace));
        self.delete(id)
    }
    fn write(&self, _: &str, _: &[u8]) -> Result<(), ToolError> {
        Ok(())
    }
    fn send_paste(&self, _: &str, _: &[u8], _: bool) -> Result<(), ToolError> {
        Ok(())
    }
    fn resize(&self, _: &str, _: u16, _: u16) -> Result<(), ToolError> {
        Ok(())
    }
    fn snapshot_tool(&self, _: &str) -> Result<ToolSnapshot, ToolError> {
        Ok(ToolSnapshot::default())
    }
    fn is_live(&self, id: &str) -> bool {
        self.has(id)
    }
    fn set_background(&self, id: &str, _: bool) -> bool {
        self.has(id)
    }
    fn background_list(&self) -> Vec<BackgroundEntry> {
        Vec::new()
    }
}

/// Go `fakeWorkspaceStore`: 실물의 조건 계약(If-Match·같은 바이트 무동작)을 흉내 낸다.
#[derive(Default)]
pub(crate) struct FakeWork {
    pub(crate) raw: Mutex<Vec<u8>>,
    pub(crate) rev: Mutex<u64>,
    pub(crate) stale: bool,
    pub(crate) windows: Option<Vec<WindowInfo>>,
    pub(crate) saves: AtomicUsize,
    pub(crate) coord_map: HashMap<String, String>,
    pub(crate) coord_err: HashMap<String, String>,
}

impl FakeWork {
    pub(crate) fn with(raw: &str, rev: u64) -> FakeWork {
        FakeWork {
            raw: Mutex::new(raw.as_bytes().to_vec()),
            rev: Mutex::new(rev),
            ..FakeWork::default()
        }
    }
}

impl dm_webserver_domain_wsentry::WorkspaceStore for FakeWork {
    fn snapshot(&self) -> (Arc<Vec<u8>>, u64) {
        (
            Arc::new(self.raw.lock().unwrap().clone()),
            *self.rev.lock().unwrap(),
        )
    }
    fn save(&self, blob: &[u8], if_match: &str) -> Result<u64, WorkspaceError> {
        let mut rev = self.rev.lock().unwrap();
        if self.stale {
            return Err(WorkspaceError::Stale);
        }
        if !if_match.is_empty() && if_match.parse::<u64>().ok() != Some(*rev) {
            return Err(WorkspaceError::Stale);
        }
        let mut raw = self.raw.lock().unwrap();
        if !raw.is_empty() && raw.as_slice() == blob {
            return Ok(*rev);
        }
        *raw = blob.to_vec();
        *rev += 1;
        self.saves.fetch_add(1, Ordering::SeqCst);
        Ok(*rev)
    }
}

impl WorkspaceStore for FakeWork {
    fn current_rev(&self) -> u64 {
        *self.rev.lock().unwrap()
    }
    fn load_err(&self) -> String {
        String::new()
    }
    fn persist_err(&self) -> String {
        String::new()
    }
    fn coordinate_of(&self, id: &str) -> Result<String, WorkspaceError> {
        if let Some(e) = self.coord_err.get(id) {
            return Err(WorkspaceError::Resolve(e.clone()));
        }
        Ok(self
            .coord_map
            .get(id)
            .cloned()
            .unwrap_or_else(|| id.to_owned()))
    }
    fn is_known_tab_id(&self, id: &str) -> bool {
        !id.is_empty() && self.coord_map.contains_key(id)
    }
    fn entries(&self) -> Vec<TabEntry> {
        Vec::new()
    }
    fn windows(&self) -> Option<Vec<WindowInfo>> {
        self.windows.clone()
    }
}

/// Go `fakeSettingsStore`: blob 을 들고 Go 와 같은 해석으로 답한다.
#[derive(Default)]
pub(crate) struct FakeSettings {
    pub(crate) blob: Mutex<Vec<u8>>,
}

impl SettingsStore for FakeSettings {
    fn render_env(&self) -> Vec<String> {
        agent_render_env(&self.blob.lock().unwrap())
    }
    fn fg_tab_names(&self) -> bool {
        #[derive(serde::Deserialize, Default)]
        #[serde(default)]
        struct Cfg {
            #[serde(rename = "fgTabNames")]
            fg_tab_names: Option<bool>,
        }
        dm_gocompat::json::unmarshal::<Cfg>(&self.blob.lock().unwrap())
            .ok()
            .and_then(|c| c.fg_tab_names)
            .unwrap_or(true)
    }
    /// Go `parseContextPolicy` 와 같은 해석이다(실물은 5.5.5 가 옮긴다).
    fn context_policy(&self) -> dm_webserver_domain_run::ContextPolicy {
        #[derive(serde::Deserialize, Default)]
        #[serde(default)]
        struct Orch {
            #[serde(rename = "contextBytesPerToken")]
            bpt: f64,
            #[serde(rename = "contextLimitTokens")]
            limit: f64,
            #[serde(rename = "contextWarnRatio")]
            warn: f64,
            #[serde(rename = "contextCriticalRatio")]
            critical: f64,
        }
        #[derive(serde::Deserialize, Default)]
        #[serde(default)]
        struct Cfg {
            orchestration: Orch,
        }
        match dm_gocompat::json::unmarshal::<Cfg>(&self.blob.lock().unwrap()) {
            Ok(c) => dm_webserver_domain_run::ContextPolicy {
                bytes_per_token: c.orchestration.bpt,
                limit_tokens: c.orchestration.limit,
                warn_ratio: c.orchestration.warn,
                critical_ratio: c.orchestration.critical,
            },
            Err(_) => dm_webserver_domain_run::ContextPolicy::default_policy(),
        }
    }
    fn migration(&self) -> crate::MigrationConf {
        crate::parse_migration_conf(&self.blob.lock().unwrap())
    }
}

/// Go `fakeReaper`.
#[derive(Default)]
pub(crate) struct FakeReaper {
    pub(crate) calls: Mutex<Vec<Vec<String>>>,
    pub(crate) profiles: Vec<ProfileInfo>,
    pub(crate) cfg: Option<sandbox::Config>,
    pub(crate) cfg_err: Option<sandbox::Error>,
    pub(crate) saved: Mutex<Vec<String>>,
    pub(crate) save_err: Option<sandbox::Error>,
}

impl SandboxReaper for FakeReaper {
    fn reap(&self, live: &[String]) {
        self.calls.lock().unwrap().push(live.to_vec());
    }
    fn profiles(&self) -> Vec<ProfileInfo> {
        self.profiles.clone()
    }
    fn config(&self) -> Result<sandbox::Config, sandbox::Error> {
        if let Some(e) = &self.cfg_err {
            return Err(e.clone());
        }
        Ok(self.cfg.clone().unwrap_or_default())
    }
    fn save_config(&self, blob: &[u8]) -> Result<(), sandbox::Error> {
        if let Some(e) = &self.save_err {
            return Err(e.clone());
        }
        self.saved
            .lock()
            .unwrap()
            .push(String::from_utf8_lossy(blob).into_owned());
        Ok(())
    }
}

/// Go `fakeStats`.
#[derive(Default)]
pub(crate) struct FakeStats {
    pub(crate) snap: Snapshot,
    pub(crate) calls: AtomicUsize,
}

impl StatsSnapshotter for FakeStats {
    fn snapshot(&self) -> Snapshot {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.snap
    }
}

/// Go `fakeCommandBroker`: 방송을 적고 기다리는 명령에는 정해 둔 결과를 곧바로 준다.
#[derive(Default)]
pub(crate) struct FakeBroker {
    pub(crate) published: Mutex<Vec<String>>,
    pub(crate) await_result: CmdResult,
    pub(crate) await_delivered: usize,
    pub(crate) delivered: Mutex<Vec<(String, CmdResult)>>,
}

impl FakeBroker {
    pub(crate) fn published(&self) -> Vec<String> {
        self.published.lock().unwrap().clone()
    }
}

impl CommandBroker for FakeBroker {
    fn add(&self) -> Option<Arc<CmdSub>> {
        Some(CmdSub::new())
    }
    fn remove(&self, _: &Arc<CmdSub>) {}
    fn broadcast(&self, payload: &[u8]) -> usize {
        self.published
            .lock()
            .unwrap()
            .push(String::from_utf8_lossy(payload).into_owned());
        1
    }
    fn broadcast_and_await<'a>(
        &'a self,
        payload: &'a [u8],
        _: &'a str,
        _: Duration,
    ) -> BoxFuture<'a, (CmdResult, usize, bool)> {
        self.broadcast(payload);
        Box::pin(async move { (self.await_result.clone(), self.await_delivered, false) })
    }
    fn deliver_result(&self, req_id: &str, res: CmdResult) {
        self.delivered
            .lock()
            .unwrap()
            .push((req_id.to_owned(), res));
    }
}

/// Go `fakeUpdates`.
#[derive(Default)]
pub(crate) struct FakeUpdates {
    pub(crate) triggers: AtomicUsize,
}

impl UpdateService for FakeUpdates {
    fn trigger(&self) {
        self.triggers.fetch_add(1, Ordering::SeqCst);
    }
}
