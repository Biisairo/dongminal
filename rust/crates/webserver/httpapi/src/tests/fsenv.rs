//! 파일·탐색기 종단 시험의 환경 (Go `fsTestServer`·`newFileBoundaryEnv`·`fakePaneHub`).

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use otter_shared_toolhub::{
    BackgroundEntry, DaemonInfo, OutChunk, Placement, ShellState, ToolHistory, ToolInfo,
    ToolScreen, ToolSnapshot,
};
use otter_webserver_domain_wsentry::{self as wsentry, WorkspaceStore, normalize_path};
use tokio::sync::mpsc::Sender;
use tokio_util::sync::CancellationToken;

use super::support::{LOCAL, TEST_HOST};
use crate::{Config, Deps, Server, ToolError, ToolHub, ToolIdentity, Unsubscribe};

#[derive(Default)]
struct WorkState {
    raw: Vec<u8>,
    rev: u64,
    saves: usize,
}

/// Go `fakeWorkspaceStore`.
#[derive(Default)]
pub(crate) struct FakeWork(Mutex<WorkState>);

impl FakeWork {
    pub(crate) fn set(&self, raw: &str) {
        let mut s = self.0.lock().unwrap();
        s.raw = raw.as_bytes().to_vec();
        s.rev += 1;
    }
    pub(crate) fn saves(&self) -> usize {
        self.0.lock().unwrap().saves
    }
}

impl WorkspaceStore for FakeWork {
    fn snapshot(&self) -> (Arc<Vec<u8>>, u64) {
        let s = self.0.lock().unwrap();
        (Arc::new(s.raw.clone()), s.rev)
    }
    fn save(&self, blob: &[u8], _: &str) -> Result<u64, otter_shared_workspace::Error> {
        let mut s = self.0.lock().unwrap();
        s.raw = blob.to_vec();
        s.rev += 1;
        s.saves += 1;
        Ok(s.rev)
    }
}

/// httpapi 의 나머지 표면은 이 시험들이 쓰지 않는다 — 기본 답이다.
impl crate::WorkspaceStore for FakeWork {
    fn current_rev(&self) -> u64 {
        self.0.lock().unwrap().rev
    }
    fn load_err(&self) -> String {
        String::new()
    }
    fn persist_err(&self) -> String {
        String::new()
    }
    fn coordinate_of(&self, id: &str) -> Result<String, otter_shared_workspace::Error> {
        Ok(id.to_owned())
    }
    fn is_known_tab_id(&self, _: &str) -> bool {
        false
    }
    fn entries(&self) -> Vec<otter_shared_workspace::TabEntry> {
        Vec::new()
    }
    fn windows(&self) -> Option<Vec<otter_shared_workspace::WindowInfo>> {
        None
    }
}

/// Go `seedRoot`.
pub(crate) fn seed_root(ws: &FakeWork, root: &str) {
    let q = String::from_utf8(otter_gocompat::json::marshal(&root).unwrap()).unwrap();
    ws.set(&format!(
        r#"{{"schemaVersion":2,"editors":{{"list":[{q}]}}}}"#
    ));
}

/// 임시 디렉터리(링크를 푼 꼴, Go `uploadRoot`).
pub(crate) fn temp_dir() -> (tempfile::TempDir, String) {
    let d = tempfile::tempdir().unwrap();
    let p = normalize_path(&d.path().to_string_lossy());
    (d, p)
}

/// 시험 서버 하나와 그 자리들이다.
pub(crate) struct Env {
    pub(crate) srv: Arc<Server>,
    pub(crate) ws: Arc<FakeWork>,
    pub(crate) home: String,
    _keep: Vec<tempfile::TempDir>,
}

/// Go `fsTestServer`: 홈은 임시 디렉터리다.
pub(crate) fn fs_env() -> Env {
    fs_env_with(Deps::default(), |_| {})
}

pub(crate) fn fs_env_with(mut deps: Deps, f: impl FnOnce(&mut Server)) -> Env {
    let (h, home) = temp_dir();
    let data = tempfile::tempdir().unwrap();
    let ws = Arc::new(FakeWork::default());
    deps.work = Some(ws.clone());
    let hh = home.clone();
    let srv = Server::new_with(
        Config {
            data_dir: data.path().to_path_buf(),
            ..Config::default()
        },
        deps,
        |s| {
            set_home(s, &hh);
            f(s);
        },
    );
    Env {
        srv,
        ws,
        home,
        _keep: vec![h, data],
    }
}

pub(crate) fn set_home(s: &mut Server, home: &str) {
    let home = home.to_owned();
    Arc::get_mut(&mut s.entries).unwrap().home_fn = Some(Arc::new(move || Ok(home.clone())));
}

/// Go `newFileBoundaryEnv`: Editor 목록에 든 루트 하나(홈이기도 하다)를 가진 서버.
pub(crate) struct FileEnv {
    pub(crate) srv: Arc<Server>,
    pub(crate) root: String,
    _keep: Vec<tempfile::TempDir>,
}

pub(crate) fn file_env() -> FileEnv {
    file_env_with(|_| {})
}

pub(crate) fn file_env_with(f: impl FnOnce(&mut Server)) -> FileEnv {
    let (b, base) = temp_dir();
    let root = format!("{base}/proj");
    std::fs::create_dir_all(&root).unwrap();
    let data = tempfile::tempdir().unwrap();
    let ws = Arc::new(FakeWork::default());
    let r = root.clone();
    let srv = Server::new_with(
        Config {
            data_dir: data.path().to_path_buf(),
            ..Config::default()
        },
        Deps {
            work: Some(ws.clone()),
            ..Deps::default()
        },
        |s| {
            set_home(s, &r);
            f(s);
        },
    );
    srv.entries
        .mutate(|mut cur: wsentry::Lists| {
            cur.editors.push(root.clone());
            cur
        })
        .unwrap();
    FileEnv {
        srv,
        root,
        _keep: vec![b, data],
    }
}

/// 응답 하나(본문은 바이트).
pub(crate) struct Res {
    pub(crate) status: u16,
    pub(crate) headers: http::HeaderMap,
    pub(crate) body: Vec<u8>,
}

impl Res {
    pub(crate) fn header(&self, k: &str) -> String {
        self.headers
            .get(k)
            .map(|v| v.to_str().unwrap_or_default().to_owned())
            .unwrap_or_default()
    }
    pub(crate) fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
    pub(crate) fn json(&self) -> serde_json::Value {
        serde_json::from_slice(&self.body).unwrap_or(serde_json::Value::Null)
    }
}

/// 요청 하나를 서버에 바로 넣는다.
pub(crate) async fn req(
    srv: &Arc<Server>,
    method: &str,
    target: &str,
    content_type: &str,
    body: impl Into<Bytes>,
) -> Res {
    let mut b = http::Request::builder()
        .method(method)
        .uri(target)
        .header("Host", TEST_HOST);
    if !content_type.is_empty() {
        b = b.header("Content-Type", content_type);
    }
    let req = b.body(Full::new(body.into())).unwrap();
    let res = srv.serve_addr(req, LOCAL.to_owned()).await;
    let status = res.status().as_u16();
    let headers = res.headers().clone();
    let body = res.into_body().collect().await.unwrap().to_bytes().to_vec();
    Res {
        status,
        headers,
        body,
    }
}

pub(crate) async fn get(srv: &Arc<Server>, target: &str) -> Res {
    req(srv, "GET", target, "", Bytes::new()).await
}

pub(crate) async fn post(srv: &Arc<Server>, target: &str, body: &str) -> Res {
    req(srv, "POST", target, "application/json", body.to_owned()).await
}

/// Go `url.QueryEscape`.
pub(crate) fn qe(s: &str) -> String {
    let mut out = String::new();
    for &c in s.as_bytes() {
        if c.is_ascii_alphanumeric() || b"-_.~".contains(&c) {
            out.push(c as char);
        } else if c == b' ' {
            out.push('+');
        } else {
            out.push_str(&format!("%{c:02X}"));
        }
    }
    out
}

/// JSON 문자열 하나.
pub(crate) fn jq(s: &str) -> String {
    String::from_utf8(otter_gocompat::json::marshal(&s).unwrap()).unwrap()
}

/// Go `multipart.Writer` 의 본문 하나(`file` 하나와 값들).
pub(crate) fn multipart(name: &str, content: &[u8], values: &[(&str, &str)]) -> (Vec<u8>, String) {
    let boundary = "dmtestboundary7c1f";
    let mut b = Vec::new();
    for (k, v) in values {
        b.extend_from_slice(
            format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n")
                .as_bytes(),
        );
    }
    b.extend_from_slice(
        format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{name}\"\r\nContent-Type: application/octet-stream\r\n\r\n"
        )
        .as_bytes(),
    );
    b.extend_from_slice(content);
    b.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    (b, format!("multipart/form-data; boundary={boundary}"))
}

pub(crate) async fn upload(
    srv: &Arc<Server>,
    target: &str,
    name: &str,
    content: &[u8],
    values: &[(&str, &str)],
) -> Res {
    let (body, ct) = multipart(name, content, values);
    req(srv, "POST", target, &ct, body).await
}

pub(crate) fn write(p: &str, b: &[u8]) {
    std::fs::write(p, b).unwrap();
}

pub(crate) fn exists(p: impl AsRef<Path>) -> bool {
    std::fs::metadata(p).is_ok()
}

/// Go `fakePaneHub` 중 cwd 만 쓰는 것.
#[derive(Default)]
pub(crate) struct FakeHub {
    pub(crate) cwds: Mutex<HashMap<String, String>>,
}

impl FakeHub {
    pub(crate) fn with_cwd(id: &str, cwd: &str) -> Arc<FakeHub> {
        let h = FakeHub::default();
        h.cwds.lock().unwrap().insert(id.to_owned(), cwd.to_owned());
        Arc::new(h)
    }
}

impl ToolHub for FakeHub {
    fn subscribe(&self, _: &str, _: Sender<OutChunk>) -> (CancellationToken, Unsubscribe) {
        (CancellationToken::new(), Box::new(|| {}))
    }
    fn snapshot_tool_since(&self, _: &str, _: i64) -> Result<ToolSnapshot, ToolError> {
        Err(ToolError::NotFound(String::new()))
    }
    fn history_tool(&self, _: &str, _: u64, _: usize) -> Result<ToolHistory, ToolError> {
        Err(ToolError::NotFound(String::new()))
    }
    fn screen_tool(&self, _: &str, _: usize) -> Result<ToolScreen, ToolError> {
        Err(ToolError::NotFound(String::new()))
    }
    fn seat_tool(&self, _: &str, _: bool) -> Result<i64, ToolError> {
        Err(ToolError::NotFound(String::new()))
    }
    fn search_tool(
        &self,
        _: &otter_shared_toolipc::SearchParams,
    ) -> Result<Vec<otter_shared_toolipc::SearchHit>, ToolError> {
        Err(ToolError::NotFound(String::new()))
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
        Vec::new()
    }
    fn list_ok(&self) -> Option<Vec<ToolInfo>> {
        Some(Vec::new())
    }
    fn connected(&self) -> bool {
        true
    }
    fn create(&self, _: &str, _: u16, _: u16, _: &Placement) -> Result<ToolIdentity, ToolError> {
        Err(ToolError::NotFound(String::new()))
    }
    fn get(&self, _: &str) -> Option<ToolIdentity> {
        None
    }
    fn cwd(&self, id: &str) -> String {
        self.cwds
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .unwrap_or_default()
    }
    fn busy(&self, _: &str) -> bool {
        false
    }
    fn busy_many(&self, _: &[String]) -> Option<HashMap<String, bool>> {
        None
    }
    fn shell_probe(&self, _: &str, _: Option<&[i64]>) -> ShellState {
        ShellState::Idle
    }
    fn delete(&self, _: &str) -> Result<(), ToolError> {
        Ok(())
    }
    fn terminate(&self, _: &str, _: Duration) -> Result<(), ToolError> {
        Ok(())
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
        Err(ToolError::NotFound(String::new()))
    }
    fn is_live(&self, _: &str) -> bool {
        false
    }
    fn set_background(&self, _: &str, _: bool) -> bool {
        false
    }
    fn background_list(&self) -> Vec<BackgroundEntry> {
        Vec::new()
    }
}
