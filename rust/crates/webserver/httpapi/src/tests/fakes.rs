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

use crate::agent_render_env::agent_render_env;
use crate::{
    SandboxReaper, SettingsStore, StatsSnapshotter, ToolError, ToolHub, ToolIdentity, Unsubscribe,
    WorkspaceStore,
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
    fn subscribe(&self, _: &str, _: Sender<OutChunk>) -> (CancellationToken, Unsubscribe) {
        (CancellationToken::new(), Box::new(|| {}))
    }
    fn snapshot_tool_since(&self, _: &str, _: i64) -> Result<ToolSnapshot, ToolError> {
        Ok(ToolSnapshot::default())
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
    fn input_notify(&self, _: &str, _: &[u8]) {}
    fn resize_notify(&self, _: &str, _: u16, _: u16) {}
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
        let id = format!("new-{n}");
        let name = format!("Shell #{n}");
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

impl WorkspaceStore for FakeWork {
    fn raw(&self) -> Vec<u8> {
        self.raw.lock().unwrap().clone()
    }
    fn current_rev(&self) -> u64 {
        *self.rev.lock().unwrap()
    }
    fn load_err(&self) -> String {
        String::new()
    }
    fn persist_err(&self) -> String {
        String::new()
    }
    fn snapshot(&self) -> (Vec<u8>, u64) {
        (self.raw(), self.current_rev())
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
    fn coordinate_of(&self, id: &str) -> Result<String, WorkspaceError> {
        Ok(id.to_owned())
    }
    fn is_known_tab_id(&self, _: &str) -> bool {
        false
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
