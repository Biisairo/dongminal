//! httpapi `Deps` 의 이음매 어댑터다. Go 는 구체 타입이 인터페이스를 바로 만족했다 — Rust 는 남의
//! crate 의 trait 을 남의 타입에 달 수 없어 여기서 감싼다.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use futures_util::future::BoxFuture;
use otter_gocompat::json::RawMessage;
use otter_shared_sandbox as sandbox;
use otter_shared_sandboxplace::Placer;
use otter_shared_toolhub::{
    BackgroundEntry, DaemonInfo, OutChunk, Placement, ShellState, ToolHistory, ToolInfo,
    ToolScreen, ToolSnapshot,
};
use otter_shared_toolipc::{
    ChatParams, ChatResult, EdgeParams, EdgePortParams, EdgeResult, RecordsResult,
};
use otter_shared_updatecheck::Checker;
use otter_shared_workspace::{Error as WorkspaceError, Manager, TabEntry, WindowInfo};
use otter_webserver_domain_ext as ext;
use otter_webserver_domain_lsp::{
    self as lsp, FileEvent, FileNotifier, OpenError, PathsError, Tunnel,
};
use otter_webserver_domain_sysstat::{Sampler, Snapshot as StatsSnapshot};
use otter_webserver_httpapi::{
    ChatDaemon, DaemonCallError, EdgeDaemon, LspService, RecordSink, SandboxReaper, ScreenDaemon,
    Server, StatsSnapshotter, ToolError, ToolHub, ToolIdentity, Unsubscribe, UpdateService,
    WorkspaceStore,
};
use otter_webserver_hub::ForegroundSource;
use otter_webserver_recordsync::Writer;
use otter_webserver_seam_adapters::ToolSource;
use otter_webserver_toolclient::{Error as ClientError, ToolClient};
use tokio::sync::mpsc::Sender;
use tokio_util::sync::CancellationToken;

use super::records::RecordMirror;

/// 데몬 클라이언트다. 도구 허브·전경 조회·생존·toolaccess 의 원천이 모두 이것이다 (FR-DMR-12).
#[derive(Clone)]
pub(crate) struct Hub(pub(crate) Arc<ToolClient>);

fn tool_err(e: ClientError) -> ToolError {
    match e {
        ClientError::ToolCap(_) => ToolError::ToolCap(e.to_string()),
        ClientError::ToolNotFound(_) => ToolError::NotFound(e.to_string()),
        _ => ToolError::Other(e.to_string()),
    }
}

impl ToolHub for Hub {
    fn subscribe(&self, tool_id: &str, tx: Sender<OutChunk>) -> (CancellationToken, Unsubscribe) {
        let (exit, unsub) = self.0.subscribe(tool_id, tx);
        (exit, Box::new(move || unsub.unsubscribe()))
    }
    fn snapshot_tool_since(&self, id: &str, since: i64) -> Result<ToolSnapshot, ToolError> {
        self.0.snapshot_tool_since(id, since).map_err(tool_err)
    }
    fn screen_tool(&self, id: &str, history: usize) -> Result<ToolScreen, ToolError> {
        self.0.screen_tool(id, history).map_err(tool_err)
    }
    fn history_tool(&self, id: &str, before: u64, count: usize) -> Result<ToolHistory, ToolError> {
        self.0.history_tool(id, before, count).map_err(tool_err)
    }
    fn seat_tool(&self, id: &str, held: bool) -> Result<i64, ToolError> {
        self.0.seat_tool(id, held).map_err(tool_err)
    }
    fn search_tool(
        &self,
        p: &otter_shared_toolipc::SearchParams,
    ) -> Result<Vec<otter_shared_toolipc::SearchHit>, ToolError> {
        self.0.search_tool(p).map_err(tool_err)
    }
    fn daemon_info(&self) -> DaemonInfo {
        self.0.daemon_info()
    }
    fn reconnects(&self) -> i64 {
        self.0.reconnects()
    }
    fn has_feature(&self, name: &str) -> bool {
        self.0.has_feature(name)
    }
    fn input_notify(&self, id: &str, data: &[u8]) {
        self.0.input_notify(id, data)
    }
    fn resize_notify(&self, id: &str, cols: u16, rows: u16) {
        self.0.resize_notify(id, cols, rows)
    }
    fn list(&self) -> Vec<ToolInfo> {
        self.0.list()
    }
    fn list_ok(&self) -> Option<Vec<ToolInfo>> {
        self.0.list_ok()
    }
    fn connected(&self) -> bool {
        self.0.connected()
    }
    fn create(
        &self,
        cwd: &str,
        cols: u16,
        rows: u16,
        place: &Placement,
    ) -> Result<ToolIdentity, ToolError> {
        self.0
            .create(cwd, cols, rows, place)
            .map(|t| ToolIdentity {
                id: t.id,
                name: t.name,
            })
            .map_err(tool_err)
    }
    fn get(&self, id: &str) -> Option<ToolIdentity> {
        self.0.get(id).map(|t| ToolIdentity {
            id: t.id,
            name: t.name,
        })
    }
    fn cwd(&self, id: &str) -> String {
        self.0.cwd(id)
    }
    fn busy(&self, id: &str) -> bool {
        self.0.busy(id)
    }
    fn busy_many(&self, ids: &[String]) -> Option<HashMap<String, bool>> {
        self.0.busy_many(ids)
    }
    fn shell_probe(&self, id: &str, pids: Option<&[i64]>) -> ShellState {
        self.0.shell_probe(id, pids)
    }
    fn delete(&self, id: &str) -> Result<(), ToolError> {
        self.0.delete(id).map_err(tool_err)
    }
    fn terminate(&self, id: &str, grace: Duration) -> Result<(), ToolError> {
        self.0.terminate(id, grace).map_err(tool_err)
    }
    fn write(&self, id: &str, data: &[u8]) -> Result<(), ToolError> {
        self.0.write(id, data).map_err(tool_err)
    }
    fn send_paste(&self, id: &str, text: &[u8], submit: bool) -> Result<(), ToolError> {
        self.0.send_paste(id, text, submit).map_err(tool_err)
    }
    fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), ToolError> {
        self.0.resize(id, cols, rows).map_err(tool_err)
    }
    fn snapshot_tool(&self, id: &str) -> Result<ToolSnapshot, ToolError> {
        self.0.snapshot_tool(id).map_err(tool_err)
    }
    fn is_live(&self, id: &str) -> bool {
        self.0.is_live(id)
    }
    fn set_background(&self, id: &str, bg: bool) -> bool {
        self.0.set_background(id, bg)
    }
    fn background_list(&self) -> Vec<BackgroundEntry> {
        self.0.background_list()
    }
}

impl ToolSource for Hub {
    fn list(&self) -> Vec<ToolInfo> {
        self.0.list()
    }
    fn has(&self, id: &str) -> bool {
        self.0.get(id).is_some()
    }
    fn snapshot_tool(
        &self,
        id: &str,
    ) -> Result<ToolSnapshot, otter_webserver_seam_toolaccess::Error> {
        Ok(self.0.snapshot_tool(id)?)
    }
    fn screen_text(
        &self,
        id: &str,
        bytes: usize,
    ) -> Result<String, otter_webserver_seam_toolaccess::Error> {
        Ok(self.0.screen_text_tool(id, bytes)?)
    }
    fn send_paste(
        &self,
        id: &str,
        text: &[u8],
        submit: bool,
    ) -> Result<(), otter_webserver_seam_toolaccess::Error> {
        Ok(self.0.send_paste(id, text, submit)?)
    }
}

impl ForegroundSource for Hub {
    fn has_feature(&self, name: &str) -> bool {
        self.0.has_feature(name)
    }
    fn list(&self) -> Vec<ToolInfo> {
        self.0.list()
    }
}

impl otter_shared_workspace::Liveness for Hub {
    fn is_live(&self, tool_id: &str) -> bool {
        self.0.is_live(tool_id)
    }
}

/// workspace.json 저장소다 (Go `Deps.Work` = `*workspace.Manager`).
#[derive(Clone)]
pub(crate) struct Work(pub(crate) Arc<Manager>);

/// Go `Manager.Windows()` 는 해석할 수 없는 blob 이면 nil 이다 — "판단 근거 없음" 이 빈 목록과
/// 갈려야 회수가 모든 컨테이너를 지우지 않는다 (FR-SBX-9).
pub(crate) fn known_windows(m: &Manager) -> Option<Vec<WindowInfo>> {
    match otter_shared_workspace::decode_state(&m.raw()) {
        Ok(Some(_)) => Some(m.windows()),
        _ => None,
    }
}

impl otter_webserver_domain_wsentry::WorkspaceStore for Work {
    fn snapshot(&self) -> (Arc<Vec<u8>>, u64) {
        self.0.snapshot()
    }
    fn save(&self, blob: &[u8], if_match: &str) -> Result<u64, WorkspaceError> {
        self.0.save(blob, if_match)
    }
}

impl WorkspaceStore for Work {
    fn current_rev(&self) -> u64 {
        self.0.current_rev()
    }
    fn load_err(&self) -> String {
        self.0.load_err().to_owned()
    }
    fn persist_err(&self) -> String {
        self.0.persist_err().to_owned()
    }
    fn coordinate_of(&self, id: &str) -> Result<String, WorkspaceError> {
        self.0.coordinate_of(id)
    }
    fn is_known_tab_id(&self, id: &str) -> bool {
        self.0.is_known_tab_id(id)
    }
    fn changes(&self) -> otter_shared_pollwait::Changed {
        self.0.changes()
    }
    fn entries(&self) -> Vec<TabEntry> {
        self.0.entries()
    }
    fn windows(&self) -> Option<Vec<WindowInfo>> {
        known_windows(&self.0)
    }
}

/// 최신 판 캐시다 (Go `Deps.Updates` = `*updatecheck.Checker`).
pub(crate) struct Updates(pub(crate) Checker);

impl UpdateService for Updates {
    fn trigger(&self) {
        self.0.trigger()
    }
    fn snapshot(&self) -> otter_shared_updatecheck::Snapshot {
        self.0.snapshot()
    }
    fn set_enabled(&self, on: bool) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        Ok(self.0.set_enabled(on)?)
    }
}

/// 샌드박스 회수자다 (Go `Deps.Sandbox` = `*sandboxplace.Placer`).
pub(crate) struct Sandbox(pub(crate) Arc<Placer>);

impl SandboxReaper for Sandbox {
    fn reap(&self, live: &[String]) {
        self.0.reap(Some(live))
    }
    fn profiles(&self) -> Vec<sandbox::ProfileInfo> {
        self.0.profiles()
    }
    fn config(&self) -> Result<sandbox::Config, sandbox::Error> {
        self.0.config()
    }
    fn save_config(&self, blob: &[u8]) -> Result<(), sandbox::Error> {
        self.0.save_config(blob)
    }
}

/// 상태바 지표다 (Go `Deps.Stats` = `*sysstat.Sampler`).
pub(crate) struct Stats(pub(crate) Arc<Sampler>);

impl StatsSnapshotter for Stats {
    fn snapshot(&self) -> StatsSnapshot {
        self.0.snapshot()
    }
}

/// 편집기의 언어 서버다 (Go `Deps.LSP` = `*lsp.Service`).
pub(crate) struct Lsp(pub(crate) Arc<lsp::Service>);

impl LspService for Lsp {
    fn notify_files(&self, events: Vec<FileEvent>) {
        FileNotifier::notify_files(&*self.0, &events)
    }
    fn status(&self) -> (Vec<ext::Status>, Vec<String>) {
        self.0.status()
    }
    fn open_tunnel(&self, root: &str, desc_id: &str) -> Result<Arc<dyn Tunnel>, OpenError> {
        self.0.open_tunnel(root, desc_id)
    }
    fn paths(&self) -> HashMap<String, String> {
        self.0.paths()
    }
    fn set_paths(
        &self,
        next: HashMap<String, String>,
    ) -> Result<HashMap<String, String>, PathsError> {
        self.0.set_paths(&next)
    }
    fn install<'a>(&'a self, ctx: &'a ext::Ctx, pack_id: &'a str) -> BoxFuture<'a, ext::Outcome> {
        Box::pin(self.0.install(ctx, pack_id))
    }
}

/// 에이전트 기록을 데몬에 쓰는 큐다 (Go `Deps.Records` = `*recordsync.Writer`).
pub(crate) struct Records(pub(crate) Arc<Writer>);

impl RecordSink for Records {
    fn put(&self, kind: &str, tool: &str, v: Option<Vec<u8>>) {
        self.0.put(kind, tool, &v.map(RawMessage))
    }
}

/// 데몬의 노드·채팅 사람 참가자다 (Go `Deps.EdgeDaemon`·`ChatDaemon` = `*toolclient.ToolClient`).
#[derive(Clone)]
pub(crate) struct Daemon(pub(crate) Arc<ToolClient>);

impl EdgeDaemon for Daemon {
    fn edge_ready(&self) -> bool {
        self.0.edge_ready()
    }
    fn edge(&self, p: EdgeParams) -> Result<EdgeResult, String> {
        self.0.edge(&p).map_err(|e| e.to_string())
    }
    fn edge_port(&self, p: EdgePortParams) -> Result<(), String> {
        self.0.edge_port(&p).map_err(|e| e.to_string())
    }
}

impl ChatDaemon for Daemon {
    fn chat_ready(&self) -> bool {
        self.0.chat_ready()
    }
    fn chat(&self, p: ChatParams) -> Result<ChatResult, String> {
        self.0.chat(&p).map_err(|e| e.to_string())
    }
}

impl ScreenDaemon for Daemon {
    fn set_history_lines(&self, lines: usize) -> Result<(), DaemonCallError> {
        self.0.screen_config(lines).map_err(call_err)
    }
}

/// 데몬 오류를 httpapi 의 갈래로 옮긴다 — 데몬이 답한 오류는 코드를 남긴다.
pub(crate) fn call_err(e: ClientError) -> DaemonCallError {
    match e.rpc() {
        Some(r) => DaemonCallError::Rpc(r.clone()),
        None => DaemonCallError::Other(e.to_string()),
    }
}

impl RecordMirror for Server {
    fn apply_records(&self, res: &RecordsResult) {
        Server::apply_records(self, res)
    }
}
