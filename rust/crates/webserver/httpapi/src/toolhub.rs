//! 도구 허브의 소비자 쪽 계약 (Go `toolhub.ToolHub`)과 요청 ID 를 싣는 감싸개 (Go `toolhub_req.go`).
//!
//! 2.2.3 결정에 따라 trait 은 소비자(httpapi)가 정한다. 구현(데몬 클라이언트·직접 모드)은 합성
//! 루트가 이 trait 으로 감싸 넘긴다.

// 다른 하위 이슈(5.5.2~)의 종단이 쓰는 공용 도우미가 있다.
#![allow(dead_code)]

use std::collections::HashMap;
use std::fmt;
use std::sync::Arc;
use std::time::Duration;

use otter_gocompat::time::format_std_duration;
use otter_shared_otterlog::{ReqCtx, Value};
use otter_shared_toolhub::{
    BackgroundEntry, DaemonInfo, OutChunk, Placement, ShellState, ToolInfo, ToolScreen,
    ToolSnapshot,
};
use tokio::sync::mpsc::Sender;
use tokio_util::sync::CancellationToken;

/// 허브 호출의 오류. 문구는 구현의 `err.Error()` 그대로다.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ToolError {
    /// Go `errors.Is(err, toolhub.ErrToolCap)`.
    ToolCap(String),
    /// Go `errors.Is(err, toolhub.ErrToolNotFound)`.
    NotFound(String),
    Other(String),
}

impl fmt::Display for ToolError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ToolError::ToolCap(m) | ToolError::NotFound(m) | ToolError::Other(m) => f.write_str(m),
        }
    }
}

impl std::error::Error for ToolError {}

/// Go `*toolhub.Tool` 중 핸들러가 읽는 신원이다.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ToolIdentity {
    pub id: String,
    pub name: String,
}

/// 구독 해제 손잡이다 (Go `unsubscribe func()`).
pub type Unsubscribe = Box<dyn FnOnce() + Send>;

/// Go `toolhub.ToolHub`(+ `DaemonHub`). 호출은 블로킹일 수 있다 — 비동기 핸들러는 필요하면
/// `spawn_blocking` 으로 감싼다.
pub trait ToolHub: Send + Sync {
    /// 도구 출력을 `tx` 로 받는다. 토큰은 도구가 끝나면 취소된다.
    fn subscribe(&self, tool_id: &str, tx: Sender<OutChunk>) -> (CancellationToken, Unsubscribe);
    fn snapshot_tool_since(&self, id: &str, since: i64) -> Result<ToolSnapshot, ToolError>;
    /// 화면 상태 스냅숏 — 화면 + 최근 기록 `history` 행 (PERF FR-TRM-4).
    fn screen_tool(&self, id: &str, history: usize) -> Result<ToolScreen, ToolError>;
    fn daemon_info(&self) -> DaemonInfo;
    fn reconnects(&self) -> i64;
    fn has_feature(&self, name: &str) -> bool;
    fn input_notify(&self, id: &str, data: &[u8]);
    fn resize_notify(&self, id: &str, cols: u16, rows: u16);

    fn list(&self) -> Vec<ToolInfo>;
    /// `None` 은 목록을 믿을 수 없다는 뜻이다 (TOOL_LIST_UNKNOWN_SRS FR-TLU-1).
    fn list_ok(&self) -> Option<Vec<ToolInfo>>;
    fn connected(&self) -> bool;
    fn create(
        &self,
        cwd: &str,
        cols: u16,
        rows: u16,
        place: &Placement,
    ) -> Result<ToolIdentity, ToolError>;
    fn get(&self, id: &str) -> Option<ToolIdentity>;
    fn cwd(&self, id: &str) -> String;
    fn busy(&self, id: &str) -> bool;
    /// `None` 은 데몬이 답하지 못했다는 뜻이다.
    fn busy_many(&self, ids: &[String]) -> Option<HashMap<String, bool>>;
    fn shell_probe(&self, id: &str, pids: Option<&[i64]>) -> ShellState;
    fn delete(&self, id: &str) -> Result<(), ToolError>;
    fn terminate(&self, id: &str, grace: Duration) -> Result<(), ToolError>;
    fn write(&self, id: &str, data: &[u8]) -> Result<(), ToolError>;
    fn send_paste(&self, id: &str, text: &[u8], submit: bool) -> Result<(), ToolError>;
    fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), ToolError>;
    fn snapshot_tool(&self, id: &str) -> Result<ToolSnapshot, ToolError>;
    fn is_live(&self, id: &str) -> bool;
    fn set_background(&self, id: &str, bg: bool) -> bool;
    fn background_list(&self) -> Vec<BackgroundEntry>;
}

/// 요청 ID 를 데몬 RPC 로그에 싣는 감싸개다. 판정·흐름은 바꾸지 않는다 (FR-OBS-6).
struct ReqHub {
    hub: Arc<dyn ToolHub>,
    req_id: String,
}

impl ReqHub {
    fn rpc(&self, method: &str, mut attrs: Vec<(&str, Value)>) {
        attrs.insert(0, ("method", Value::Str(method.to_owned())));
        otter_shared_otterlog::debug(Some(&self.req_id), "daemon rpc", &attrs);
    }
}

/// Go `withReq`: 요청 ID 가 없으면 허브를 그대로 돌려준다.
pub(crate) fn with_req(hub: Arc<dyn ToolHub>, req_id: ReqCtx<'_>) -> Arc<dyn ToolHub> {
    match req_id {
        Some(id) if !id.is_empty() => Arc::new(ReqHub {
            hub,
            req_id: id.to_owned(),
        }),
        _ => hub,
    }
}

impl ToolHub for ReqHub {
    fn subscribe(&self, tool_id: &str, tx: Sender<OutChunk>) -> (CancellationToken, Unsubscribe) {
        self.hub.subscribe(tool_id, tx)
    }
    fn snapshot_tool_since(&self, id: &str, since: i64) -> Result<ToolSnapshot, ToolError> {
        self.hub.snapshot_tool_since(id, since)
    }
    fn screen_tool(&self, id: &str, history: usize) -> Result<ToolScreen, ToolError> {
        self.hub.screen_tool(id, history)
    }
    fn daemon_info(&self) -> DaemonInfo {
        self.hub.daemon_info()
    }
    fn reconnects(&self) -> i64 {
        self.hub.reconnects()
    }
    fn has_feature(&self, name: &str) -> bool {
        self.hub.has_feature(name)
    }
    fn input_notify(&self, id: &str, data: &[u8]) {
        self.hub.input_notify(id, data)
    }
    fn resize_notify(&self, id: &str, cols: u16, rows: u16) {
        self.hub.resize_notify(id, cols, rows)
    }
    fn list(&self) -> Vec<ToolInfo> {
        self.hub.list()
    }
    fn list_ok(&self) -> Option<Vec<ToolInfo>> {
        self.hub.list_ok()
    }
    fn connected(&self) -> bool {
        self.hub.connected()
    }
    fn create(
        &self,
        cwd: &str,
        cols: u16,
        rows: u16,
        place: &Placement,
    ) -> Result<ToolIdentity, ToolError> {
        self.rpc("create", vec![("cwd", Value::Str(cwd.to_owned()))]);
        self.hub.create(cwd, cols, rows, place)
    }
    fn get(&self, id: &str) -> Option<ToolIdentity> {
        self.hub.get(id)
    }
    fn cwd(&self, id: &str) -> String {
        self.hub.cwd(id)
    }
    fn busy(&self, id: &str) -> bool {
        self.hub.busy(id)
    }
    fn busy_many(&self, ids: &[String]) -> Option<HashMap<String, bool>> {
        self.hub.busy_many(ids)
    }
    fn shell_probe(&self, id: &str, pids: Option<&[i64]>) -> ShellState {
        self.hub.shell_probe(id, pids)
    }
    fn delete(&self, id: &str) -> Result<(), ToolError> {
        self.rpc("delete", vec![("tool", Value::Str(id.to_owned()))]);
        self.hub.delete(id)
    }
    fn terminate(&self, id: &str, grace: Duration) -> Result<(), ToolError> {
        self.rpc(
            "terminate",
            vec![
                ("tool", Value::Str(id.to_owned())),
                ("grace", Value::Str(format_std_duration(grace))),
            ],
        );
        self.hub.terminate(id, grace)
    }
    fn write(&self, id: &str, data: &[u8]) -> Result<(), ToolError> {
        self.hub.write(id, data)
    }
    fn send_paste(&self, id: &str, text: &[u8], submit: bool) -> Result<(), ToolError> {
        self.rpc(
            "paste",
            vec![
                ("tool", Value::Str(id.to_owned())),
                (
                    "bytes",
                    Value::Int(i64::try_from(text.len()).unwrap_or(i64::MAX)),
                ),
                ("submit", Value::Bool(submit)),
            ],
        );
        self.hub.send_paste(id, text, submit)
    }
    fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), ToolError> {
        self.rpc(
            "resize",
            vec![
                ("tool", Value::Str(id.to_owned())),
                ("cols", Value::Uint(u64::from(cols))),
                ("rows", Value::Uint(u64::from(rows))),
            ],
        );
        self.hub.resize(id, cols, rows)
    }
    fn snapshot_tool(&self, id: &str) -> Result<ToolSnapshot, ToolError> {
        self.hub.snapshot_tool(id)
    }
    fn is_live(&self, id: &str) -> bool {
        self.hub.is_live(id)
    }
    fn set_background(&self, id: &str, bg: bool) -> bool {
        self.rpc(
            "background",
            vec![("tool", Value::Str(id.to_owned())), ("bg", Value::Bool(bg))],
        );
        self.hub.set_background(id, bg)
    }
    fn background_list(&self) -> Vec<BackgroundEntry> {
        self.hub.background_list()
    }
}
