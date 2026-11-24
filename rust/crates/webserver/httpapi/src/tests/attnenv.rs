//! 주의·활동·상태 시험의 공용 환경 (Go `trackedServer`·`statusServer`·`fakeToolIO`·`fakeWorkIndex`).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use dm_webserver_hub::{AttnTracker, CommandBroker, CommandHub};
use dm_webserver_seam_toolaccess::{Error, ToolInfo, ToolReader, WorkspaceEntry, WorkspaceReader};

use super::fakes::*;
use super::support::*;
use crate::{Deps, Server};

/// Go `fakeToolIO` 중 생존(`Has`)만.
#[derive(Default)]
pub(crate) struct LiveIo {
    pub(crate) has: Mutex<HashMap<String, bool>>,
}

impl LiveIo {
    pub(crate) fn set_has(&self, id: &str, v: bool) {
        self.has.lock().unwrap().insert(id.to_owned(), v);
    }
}

impl ToolReader for LiveIo {
    fn list(&self) -> Vec<ToolInfo> {
        Vec::new()
    }
    fn has(&self, id: &str) -> bool {
        self.has.lock().unwrap().get(id).copied().unwrap_or(false)
    }
    fn snapshot(&self, _: &str) -> Option<(Vec<u8>, i64)> {
        None
    }
    fn send_paste(&self, _: &str, _: &[u8], _: bool) -> Result<(), Error> {
        Ok(())
    }
    fn size(&self, _: &str) -> String {
        String::new()
    }
}

/// Go `fakeWorkIndex`: 정해 둔 식별자만 푼다.
#[derive(Default)]
pub(crate) struct IdIndex {
    pub(crate) resolve: HashMap<String, String>,
    pub(crate) sig: dm_shared_pollwait::Signal,
}

impl WorkspaceReader for IdIndex {
    fn resolve(&self, id: &str) -> Result<String, Error> {
        self.resolve_strict(id)
    }
    fn resolve_strict(&self, id: &str) -> Result<String, Error> {
        self.resolve
            .get(id)
            .cloned()
            .ok_or_else(|| format!("not found: {id}").into())
    }
    fn entries(&self) -> Vec<WorkspaceEntry> {
        Vec::new()
    }
    fn coordinate_of(&self, id: &str) -> Result<String, Error> {
        Ok(id.to_owned())
    }
    fn is_known_tab_id(&self, _: &str) -> bool {
        false
    }
    fn changes(&self) -> dm_shared_pollwait::Changed {
        self.sig.c()
    }
}

/// 추적기 서버 한 벌이다.
pub(crate) struct Env {
    pub(crate) _dir: tempfile::TempDir,
    pub(crate) srv: Arc<Server>,
    pub(crate) tr: Arc<AttnTracker>,
    pub(crate) cmds: Arc<FakeBroker>,
    pub(crate) io: Arc<LiveIo>,
}

impl Env {
    /// 방송 중 action 이 맞는 것들의 JSON 이다 (Go `publishedActions`).
    pub(crate) fn published(&self, action: &str) -> Vec<serde_json::Value> {
        self.cmds
            .published()
            .iter()
            .filter_map(|b| serde_json::from_str::<serde_json::Value>(b).ok())
            .filter(|v| v["action"] == action)
            .collect()
    }
}

/// Go `attnServer`: ids 의 도구를 가진, 방송을 FakeBroker 로 받는 추적기 서버다. 도구는 살아 있고
/// 자기 id 로 풀린다.
pub(crate) fn tracked(ids: &[&str]) -> Env {
    tracked_with(ids, |_| {})
}

pub(crate) fn tracked_with(ids: &[&str], f: impl FnOnce(&mut Deps)) -> Env {
    let hub = Arc::new(FakeHub::default());
    let io = Arc::new(LiveIo::default());
    let mut index = IdIndex::default();
    for id in ids {
        hub.seed(id, id);
        io.set_has(id, true);
        index.resolve.insert((*id).to_owned(), (*id).to_owned());
    }
    let cmds = Arc::new(FakeBroker::default());
    let tr = AttnTracker::new(cmds.clone() as Arc<dyn CommandBroker>, 0);
    let mut deps = Deps {
        tools: Some(hub.clone()),
        tool_io: Some(io.clone()),
        work_index: Some(Arc::new(index)),
        commands: Some(cmds.clone()),
        attn_tracker: Some(tr.clone()),
        ..Deps::default()
    };
    f(&mut deps);
    let dir = tempfile::tempdir().unwrap();
    let srv = server(dir.path(), deps);
    Env {
        _dir: dir,
        srv,
        tr,
        cmds,
        io,
    }
}

/// 방송이 실제 허브로 가는 추적기다 (Go `hub.NewAttnTracker(hub.NewCommandHub(), idle)`).
pub(crate) fn real_tracker(idle_ms: i64) -> Arc<AttnTracker> {
    let h: Arc<dyn CommandBroker> = CommandHub::new();
    AttnTracker::new(h, idle_ms)
}

/// 게이트가 변경 요청에 JSON 형식을 요구한다.
pub(crate) async fn post(s: &Arc<Server>, target: &str, body: &str) -> Resp {
    post_json(s, target, body).await
}
