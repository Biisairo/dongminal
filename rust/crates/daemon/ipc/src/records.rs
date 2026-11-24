//! 에이전트 기록 — 도구 기록과 전역 기록 (AGENT_RECORD_DAEMON_SRS FR-ARD-11~13).

use std::collections::BTreeMap;
use std::sync::Mutex;

use otter_gocompat::json::{self, RawMessage};
use otter_shared_otterlog::warnf;
use otter_shared_toolhub::{ManagerError, ToolManager};
use otter_shared_toolipc as ipc;
use serde::Serialize;

use crate::conn::lock;
use crate::handlers::agent_from;

/// 기록의 종류와 도구가 맞지 않는다.
pub const ERR_RECORD_SHAPE: &str = "기록의 종류와 도구가 맞지 않는다";

/// 도구 없는 전역 기록이다. 데몬 교체 때 함께 넘어간다.
#[derive(Default)]
pub(crate) struct GlobalRecords {
    m: Mutex<BTreeMap<String, RawMessage>>,
}

impl GlobalRecords {
    /// 비었거나 `null` 이면 지운다.
    pub fn set(&self, kind: &str, v: &RawMessage) {
        let mut m = lock(&self.m);
        if v.0.is_empty() || v.0 == b"null" {
            m.remove(kind);
            return;
        }
        m.insert(kind.to_owned(), v.clone());
    }

    /// 옛 값을 받아 새 값을 만든다. 부호화에 실패하면 그대로 둔다.
    pub fn update<T: Serialize>(&self, kind: &str, f: impl FnOnce(Option<&RawMessage>) -> T) {
        let mut m = lock(&self.m);
        match json::marshal(&f(m.get(kind))) {
            Ok(raw) => {
                m.insert(kind.to_owned(), RawMessage(raw));
            }
            Err(e) => warnf!(None, "records: {kind} 를 쓰지 못했다: {e}"),
        }
    }

    pub fn snapshot(&self) -> BTreeMap<String, RawMessage> {
        lock(&self.m).clone()
    }
}

/// 기록 하나를 쓴다. 실패는 (코드, 문구) 다.
pub(crate) fn apply_record(
    pm: &ToolManager,
    g: &GlobalRecords,
    kind: &str,
    tool: &str,
    v: &RawMessage,
) -> Result<(), (i64, String)> {
    let shape = || (ipc::CODE_INVALID_PARAMS, ERR_RECORD_SHAPE.to_owned());
    let global = ipc::record_is_global(kind).ok_or_else(shape)?;
    if global != tool.is_empty() {
        return Err(shape());
    }
    if global {
        g.set(kind, v);
        return Ok(());
    }
    let Some(p) = pm.get(tool) else {
        return Err((ipc::CODE_NOT_FOUND, ManagerError::NotFound.to_string()));
    };
    if kind != ipc::RECORD_AGENT {
        p.set_record(kind, &v.0);
        return Ok(());
    }
    let st = agent_from(v).map_err(|e| (ipc::CODE_INVALID_PARAMS, e))?;
    p.restore_agent_state(&st);
    Ok(())
}
