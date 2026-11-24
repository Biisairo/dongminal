//! Go 기준선 `otterminal/internal/ctl/migrate` 의 Rust 포팅. RUST_PORT_SRS 참고.
//!
//! 엔티티 모델 재정비(ENTITY_MODEL_RESTRUCTURE_SRS)의 1회성 데이터 변환이다. workspace.json 을
//! v2 스키마로 옮기고 panes.json 을 tools.json 으로 바꾸며, 고아 도구와 유령 참조를 제거한다.
//! 미지 필드를 보존하려고 타입 구조체가 아닌 일반 맵을 걷는다.

mod apply;
mod identity;
mod legacy_home;
mod settings;
mod tree;

pub use apply::apply;
pub use identity::{IdentityReport, Rewritten, rewrite_identifiers};
pub use legacy_home::{LEGACY_HOME_DIR, LegacyHome, migrate_legacy_home};
pub use settings::settings;

use std::collections::HashSet;
use std::fmt;

use otter_gocompat::json;
use serde_json::Value;

use tree::{Obj, as_str, convert_layout, decode_obj, decode_vec, rename_key};

/// 이 SRS 가 도입하는 workspace.json 스키마 버전이다 (FR-EM-2a).
pub const SCHEMA_VERSION: i64 = 2;

const ERR_DAEMON_RUNNING: &str =
    "otterminald 가 실행 중입니다 — `otterminal stop --all` 로 정지한 뒤 다시 실행하세요";

/// 변환 오류. `Display` 는 Go 의 `err.Error()` 와 같다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    /// otterminald 가 살아 있다. 값은 pid 다.
    DaemonRunning(i64),
    Msg(String),
}

impl Error {
    /// Go `errors.Is(err, ErrDaemonRunning)`.
    pub fn is_daemon_running(&self) -> bool {
        matches!(self, Error::DaemonRunning(_))
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::DaemonRunning(pid) => write!(f, "{ERR_DAEMON_RUNNING} (pid={pid})"),
            Error::Msg(m) => f.write_str(m),
        }
    }
}

impl std::error::Error for Error {}

/// 변환 결과의 보고다.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Report {
    /// 변환할 입력이 없었다 (신규 사용자).
    pub empty: bool,
    /// 입력이 이미 v2 스키마였다.
    pub already_migrated: bool,
    pub windows: usize,
    pub tools: usize,
    /// 어떤 탭도 참조하지 않아 tools.json 에서 제외된 도구 id.
    pub orphans: Vec<String>,
    /// 존재하지 않는 도구를 가리켜 agentsOrder 에서 제거된 id.
    pub ghost_refs: Vec<String>,
    /// settings.json 에서 개명된 단축키 action id 목록.
    pub shortcuts_renamed: Vec<String>,
    /// 탭이 참조하지만 도구 컬렉션에 없는 id. 보고만 한다 (FR-EM-14).
    pub broken_refs: Vec<String>,
    /// 구 식별자 재작성의 결과 (FR-MGU-10).
    pub identity: IdentityReport,
}

/// [`run`] 의 산출물. 입력이 없던 쪽은 `None` 이다.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RunResult {
    pub workspace: Option<Vec<u8>>,
    pub tools: Option<Vec<u8>>,
    pub report: Report,
}

pub(crate) fn is_blank(b: &[u8]) -> bool {
    String::from_utf8_lossy(b).trim().is_empty()
}

pub(crate) fn marshal(v: &impl serde::Serialize, what: &str) -> Result<Vec<u8>, Error> {
    json::marshal(v).map_err(|e| Error::Msg(format!("{what} 직렬화: {e}")))
}

/// v1 workspace.json 과 panes.json 블롭을 받아 v2 산출물을 낸다. 멱등하다.
pub fn run(workspace_blob: &[u8], panes_blob: &[u8]) -> Result<RunResult, Error> {
    let mut res = RunResult::default();
    let ws_empty = is_blank(workspace_blob);
    let pn_empty = is_blank(panes_blob);
    if ws_empty && pn_empty {
        res.report.empty = true;
        return Ok(res);
    }

    // FR-RSP-7: Go 는 `null` 을 nil map 으로 읽고 schemaVersion 을 쓰다 패닉한다. 빈 객체로 다룬다.
    let mut ws: Obj = if ws_empty {
        Obj::new()
    } else {
        decode_obj(workspace_blob, "workspace")?.unwrap_or_default()
    };
    let panes: Vec<Value> = if pn_empty {
        Vec::new()
    } else {
        decode_vec(panes_blob, "panes")?.unwrap_or_default()
    };

    let already = schema_version_of(&ws) >= SCHEMA_VERSION;
    res.report.already_migrated = already;
    if !already {
        rename_key(&mut ws, "sessions", "windows");
        rename_key(&mut ws, "activeSession", "activeWindow");
    }

    let mut refs = Vec::new();
    if let Some(Value::Array(windows)) = ws.get_mut("windows") {
        res.report.windows = windows.len();
        for raw in windows.iter_mut() {
            let Value::Object(win) = raw else { continue };
            if !already {
                rename_key(win, "focusedRegion", "focusedPane");
            }
            if let Some(Value::Object(layout)) = win.get_mut("layout") {
                convert_layout(layout, already);
            }
        }
        refs = collect_tool_refs(windows);
    }

    let ref_set: HashSet<&str> = refs.iter().map(String::as_str).collect();
    let mut tools = Vec::with_capacity(panes.len());
    let mut have = HashSet::new();
    for raw in panes {
        let Value::Object(item) = raw else { continue };
        let id = as_str(item.get("id")).to_owned();
        if !ref_set.contains(id.as_str()) {
            res.report.orphans.push(id);
            continue;
        }
        have.insert(id);
        tools.push(Value::Object(item));
    }
    res.report.tools = tools.len();
    res.report.broken_refs = refs
        .iter()
        .filter(|id| !have.contains(*id))
        .cloned()
        .collect();

    if let Some(Value::Array(order)) = ws.get_mut("agentsOrder") {
        let mut kept = Vec::with_capacity(order.len());
        for raw in order.drain(..) {
            let id = as_str(Some(&raw)).to_owned();
            if have.contains(&id) {
                kept.push(raw);
            } else {
                res.report.ghost_refs.push(id);
            }
        }
        *order = kept;
    }

    ws.insert("schemaVersion".into(), Value::from(SCHEMA_VERSION));

    if !ws_empty {
        res.workspace = Some(marshal(&ws, "workspace")?);
    }
    if !pn_empty {
        res.tools = Some(marshal(&tools, "tools")?);
    }
    Ok(res)
}

/// Go `ws["schemaVersion"].(float64)` 를 int 로 자른 값. 숫자가 아니면 0.
fn schema_version_of(ws: &Obj) -> i64 {
    ws.get("schemaVersion")
        .and_then(Value::as_f64)
        .map_or(0, |v| v as i64)
}

/// 문서 순서대로 탭이 참조하는 도구 id 를 중복 없이 모은다. v1(paneId)·v2(toolId) 를 모두 본다.
fn collect_tool_refs(windows: &[Value]) -> Vec<String> {
    fn walk(node: &Obj, out: &mut Vec<String>, seen: &mut HashSet<String>) {
        if let Some(Value::Array(tabs)) = node.get("tabs") {
            for raw in tabs {
                let Value::Object(tab) = raw else { continue };
                let mut id = as_str(tab.get("toolId"));
                if id.is_empty() {
                    id = as_str(tab.get("paneId"));
                }
                if !id.is_empty() && seen.insert(id.to_owned()) {
                    out.push(id.to_owned());
                }
            }
        }
        if let Some(Value::Array(children)) = node.get("children") {
            for c in children {
                if let Value::Object(c) = c {
                    walk(c, out, seen);
                }
            }
        }
    }
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for raw in windows {
        if let Value::Object(win) = raw
            && let Some(Value::Object(layout)) = win.get("layout")
        {
            walk(layout, &mut out, &mut seen);
        }
    }
    out
}

#[cfg(test)]
mod tests;
