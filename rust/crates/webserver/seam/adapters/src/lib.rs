//! Go 기준선 `otterminal/internal/webserver/seam/adapters` 의 Rust 포팅. RUST_PORT_SRS 참고.
//!
//! 도구 허브(데몬)·`workspace::Manager` 를 `seam/toolaccess` 접합면으로 잇는 어댑터들이다.

use std::collections::HashMap;
use std::sync::Arc;

use otter_shared_platform::ProcInfo;
use otter_shared_toolhub::{ToolInfo as HubToolInfo, ToolSnapshot};
use otter_shared_workspace::Manager;
use otter_webserver_seam_toolaccess::{
    ClientToolResolver, Error, ToolInfo, ToolReader, WorkspaceEntry, WorkspaceReader,
};

/// 어댑터가 쓰는 도구 허브의 부분이다 (Go `toolhub.ToolHub` 중 이 패키지가 부르는 것).
/// 구현은 데몬 클라이언트(toolclient)가 준다.
pub trait ToolSource: Send + Sync {
    fn list(&self) -> Vec<HubToolInfo>;
    /// Go `Get(id) != nil`.
    fn has(&self, id: &str) -> bool;
    fn snapshot_tool(&self, id: &str) -> Result<ToolSnapshot, Error>;
    fn screen_text(&self, id: &str, bytes: usize) -> Result<String, Error>;
    fn send_paste(&self, id: &str, text: &[u8], submit: bool) -> Result<(), Error>;
}

/// 도구 허브(데몬)를 [`ToolReader`] 로 어댑트한다. 도구는 데몬에 있다 (FR-DMR-12).
#[derive(Clone, Default)]
pub struct Tool {
    pub hub: Option<Arc<dyn ToolSource>>,
}

impl ToolReader for Tool {
    fn list(&self) -> Vec<ToolInfo> {
        // 셸 PID 는 hub 목록 응답에 실린 값이다 — whoami 의 PID 대조(FR-16)가 이 값에 기댄다 (FR-TAN-7).
        let Some(hub) = &self.hub else {
            return Vec::new();
        };
        hub.list()
            .into_iter()
            .map(|t| ToolInfo {
                id: t.id,
                name: t.name,
                shell_pid: t.pid,
                foreground_name: t.fg_name,
            })
            .collect()
    }

    fn has(&self, tool_id: &str) -> bool {
        self.hub.as_ref().is_some_and(|h| h.has(tool_id))
    }

    fn snapshot(&self, tool_id: &str) -> Option<(Vec<u8>, i64)> {
        let snap = self.hub.as_ref()?.snapshot_tool(tool_id).ok()?;
        Some((snap.data, snap.total_bytes_drop))
    }

    fn screen_text(&self, tool_id: &str, bytes: usize) -> Option<String> {
        self.hub.as_ref()?.screen_text(tool_id, bytes).ok()
    }

    /// 감싸기·제출 판단은 도구가 사는 곳(데몬)에 맡긴다 (FR-BPW-1).
    fn send_paste(&self, tool_id: &str, text: &[u8], submit: bool) -> Result<(), Error> {
        match &self.hub {
            Some(h) => h.send_paste(tool_id, text, submit),
            None => Err(format!("tool 없음: {tool_id}").into()),
        }
    }

    /// 목록의 cols/rows 다 — 허브는 터미널을 내놓지 않는다.
    fn size(&self, tool_id: &str) -> String {
        if let Some(hub) = &self.hub
            && let Some(t) = hub
                .list()
                .into_iter()
                .find(|t| t.id == tool_id && t.cols > 0 && t.rows > 0)
        {
            return format!("{}x{}", t.cols, t.rows);
        }
        "?".into()
    }
}

/// 원격 TCP 연결(remoteAddr)의 클라이언트 PID 에서 조상 사슬을 거슬러 올라가며 도구의
/// 셸 PID 와 맞는 toolID 를 찾는다. `/api/whoami` 의 toolId 폴백 경로가 쓴다.
#[derive(Clone, Default)]
pub struct Client {
    pub hub: Option<Arc<dyn ToolSource>>,
}

const ANCESTOR_WALK_MAX: usize = 32;

impl ClientToolResolver for Client {
    fn resolve_client_pane(&self, remote_addr: &str) -> Result<(String, i64), Error> {
        self.resolve_with(otter_shared_platform::current().info, remote_addr)
    }
}

impl Client {
    /// 클라이언트 pid 역추적과 부모 거슬러 오르기는 platform.ProcInfo 뒤에 있다 (FR-XPI-7).
    fn resolve_with(&self, info: &dyn ProcInfo, remote_addr: &str) -> Result<(String, i64), Error> {
        let Some(client_pid) = info.connection_owner_pid(remote_addr) else {
            return Err(format!("클라이언트 PID를 찾을 수 없음 (remoteAddr={remote_addr})").into());
        };
        let tools = Tool {
            hub: self.hub.clone(),
        };
        let shell_pids: HashMap<i64, String> = tools
            .list()
            .into_iter()
            .filter(|p| p.shell_pid > 0)
            .map(|p| (p.shell_pid, p.id))
            .collect();
        // 부모 표는 한 번만 읽는다 — 조상마다 묻지 않는다 (M4 설계 §2).
        let parents = info.parents().unwrap_or_default();
        let mut current = client_pid;
        for _ in 0..ANCESTOR_WALK_MAX {
            if let Some(id) = shell_pids.get(&i64::from(current)) {
                return Ok((id.clone(), i64::from(current)));
            }
            match parents.get(&current) {
                Some(&parent) if parent > 1 => current = parent,
                _ => break,
            }
        }
        Err(format!("clientPID={client_pid} 가 어느 도구에도 속하지 않음").into())
    }
}

/// `workspace::Manager` 를 [`WorkspaceReader`] 로 어댑트한다.
#[derive(Clone)]
pub struct Workspace {
    pub ws: Arc<Manager>,
}

impl WorkspaceReader for Workspace {
    fn resolve(&self, label_or_id: &str) -> Result<String, Error> {
        Ok(self.ws.resolve(label_or_id)?)
    }

    fn resolve_strict(&self, id: &str) -> Result<String, Error> {
        Ok(self.ws.resolve_strict(id)?)
    }

    fn entries(&self) -> Vec<WorkspaceEntry> {
        self.ws
            .entries()
            .into_iter()
            .map(|e| WorkspaceEntry {
                tool_id: e.tool_id,
                label: e.label,
                window_name: e.window_name,
                tab_name: e.tab_name,
                is_active: e.is_active,
                window_uuid: e.window_uuid,
                pane_uuid: e.pane_uuid,
                tab_uuid: e.tab_uuid,
                short_code: e.short_code,
            })
            .collect()
    }

    fn coordinate_of(&self, id: &str) -> Result<String, Error> {
        Ok(self.ws.coordinate_of(id)?)
    }

    fn is_known_tab_id(&self, id: &str) -> bool {
        self.ws.is_known_tab_id(id)
    }

    fn changes(&self) -> otter_shared_pollwait::Changed {
        self.ws.changes()
    }
}

#[cfg(test)]
mod tests;
