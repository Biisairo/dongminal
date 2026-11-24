//! workspace.json 을 읽는 일 — 트리의 모양과 그것에서 만드는 색인.

use std::collections::{HashMap, HashSet};

use otter_gocompat::json;
use serde::Deserialize;

use crate::Error;

/// 이 코드가 읽고 쓰는 workspace.json 스키마 버전이다.
pub const SCHEMA_VERSION: i64 = 2;

/// 탭을 담는 레이아웃 노드의 `type` 값이다. 브라우저가 쓰는 값과 같아야 한다.
pub const LAYOUT_TYPE_PANE: &str = "pane";
pub const LAYOUT_TYPE_SPLIT: &str = "split";

otter_gocompat::go_type!(GoTabs = "[]workspace.WsTab");
otter_gocompat::go_type!(GoLayouts = "[]*workspace.WsLayout");
otter_gocompat::go_type!(GoWindows = "[]workspace.WsWindow");
otter_gocompat::go_type!(GoGroups = "[]workspace.WsGroup");

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename = "workspace.WsLayout")]
pub struct WsLayout {
    #[serde(rename = "type")]
    pub kind: String,
    pub id: String,
    #[serde(deserialize_with = "json::with_go_type::<GoTabs, _, _>")]
    pub tabs: Vec<WsTab>,
    #[serde(rename = "activeTab")]
    pub active_tab: String,
    pub direction: String,
    /// Go `[]*WsLayout` — 원소가 `null` 일 수 있다.
    #[serde(deserialize_with = "json::with_go_type::<GoLayouts, _, _>")]
    pub children: Vec<Option<WsLayout>>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename = "workspace.WsTab")]
pub struct WsTab {
    pub id: String,
    pub name: String,
    #[serde(rename = "toolId")]
    pub tool_id: String,
    /// 이 탭의 도구를 소유한 Run (FR-EM-17). 비어 있으면 어느 Run 에도 속하지 않는다.
    #[serde(rename = "runId")]
    pub run_id: String,
    /// otterctl 의 표시 이름 규칙이 읽는다 (CONVENIENCE_SRS FR-TAN-1/3). 서버는 읽지 않는다.
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(rename = "nameSource")]
    pub name_source: String,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename = "workspace.WsWindow")]
pub struct WsWindow {
    pub id: String,
    pub name: String,
    pub layout: Option<WsLayout>,
    #[serde(rename = "focusedPane")]
    pub focused_pane: String,
    /// 이 Window 를 전용으로 만든 Run. 비어 있으면 사용자 소유다 (FR-EM-17).
    #[serde(rename = "ownerRunId")]
    pub owner_run_id: String,
    /// 샌드박스 프로파일 이름. 비어 있으면 일반 Window 다 (SANDBOX_WINDOW_SRS FR-SBX-18/19).
    pub sandbox: String,
    /// 있으면(git·editor) 그룹·순서 목록 밖이다 (ISSUE_AGENT_TREE_SRS FR-WGR-7).
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(rename = "groupId")]
    pub group_id: String,
}

/// Window 그룹이다 (ISSUE_AGENT_TREE_SRS FR-WGR-2).
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename = "workspace.WsGroup")]
pub struct WsGroup {
    pub id: String,
    pub name: String,
    pub tree: Option<WsGroupTree>,
}

/// 이슈 트리의 격리 단위 표지다 (FR-WGR-8).
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename = "workspace.WsGroupTree")]
pub struct WsGroupTree {
    pub repo: String,
    pub root: i64,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename = "workspace.WsState")]
pub struct WsState {
    #[serde(rename = "schemaVersion")]
    pub schema_version: i64,
    #[serde(deserialize_with = "json::with_go_type::<GoWindows, _, _>")]
    pub windows: Vec<WsWindow>,
    #[serde(rename = "activeWindow")]
    pub active_window: String,
    #[serde(
        rename = "windowGroups",
        deserialize_with = "json::with_go_type::<GoGroups, _, _>"
    )]
    pub window_groups: Vec<WsGroup>,
}

/// Window 하나의 배치 정보다.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WindowInfo {
    pub uuid: String,
    pub sandbox: String,
}

/// 색인의 항목 하나다.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TabEntry {
    pub tool_id: String,
    pub label: String,
    pub window_name: String,
    pub tab_name: String,
    pub is_active: bool,
    pub window_uuid: String,
    pub pane_uuid: String,
    pub tab_uuid: String,
    pub short_code: String,
}

#[derive(Debug, Default)]
pub(crate) struct Index {
    pub(crate) entries: Vec<TabEntry>,
    pub(crate) labels: HashMap<String, String>,
    pub(crate) label_to_id: HashMap<String, String>,
    pub(crate) tab_ids: HashSet<String>,
    /// 탭 uuid(소문자) → toolId. 라벨이 다시 계산돼도 바뀌지 않는다 (TC-UID-2).
    pub(crate) uuid_to_id: HashMap<String, String>,
}

/// 저장된 blob 을 상태로 되돌린다. 파싱과 스키마 버전 판정의 유일한 자리다 (FR-EM-2a).
/// 빈 blob 은 `None` 이다 — 상태가 아직 없다.
pub fn decode_state(blob: &[u8]) -> Result<Option<WsState>, Error> {
    if blob.is_empty() {
        return Ok(None);
    }
    let s: WsState = json::unmarshal(blob).map_err(Error::Json)?;
    if s.schema_version > SCHEMA_VERSION {
        return Err(Error::SchemaTooNew);
    }
    if s.schema_version < SCHEMA_VERSION {
        return Err(Error::SchemaTooOld);
    }
    Ok(Some(s))
}

/// blob 에서 Window 목록을 뽑는다. 탭의 유무를 보지 않는다. 해석할 수 없으면 빈 목록이다 —
/// 호출자는 그것을 "판단 근거가 없다" 로 다룬다.
pub(crate) fn windows_of(blob: &[u8]) -> Vec<WindowInfo> {
    let Ok(Some(st)) = decode_state(blob) else {
        return Vec::new();
    };
    st.windows
        .into_iter()
        .filter(|w| !w.id.is_empty())
        .map(|w| WindowInfo {
            uuid: w.id,
            sandbox: w.sandbox,
        })
        .collect()
}

pub(crate) fn build_index(blob: &[u8]) -> Result<Index, Error> {
    let mut ix = Index::default();
    let Some(s) = decode_state(blob)? else {
        return Ok(ix);
    };
    for (si, sess) in s.windows.iter().enumerate() {
        let mut regions = Vec::new();
        collect_panes(sess.layout.as_ref(), &mut regions);
        for (pi, rg) in regions.iter().enumerate() {
            for (ti, tab) in rg.tabs.iter().enumerate() {
                let is_active = sess.id == s.active_window
                    && sess.focused_pane == rg.id
                    && rg.active_tab == tab.id;
                let label = format!("W{}.P{}.T{}", si + 1, pi + 1, ti + 1);
                ix.entries.push(TabEntry {
                    tool_id: tab.tool_id.clone(),
                    label: label.clone(),
                    window_name: sess.name.clone(),
                    tab_name: tab.name.clone(),
                    is_active,
                    window_uuid: sess.id.clone(),
                    pane_uuid: rg.id.clone(),
                    tab_uuid: tab.id.clone(),
                    short_code: short_code(&tab.id).to_owned(),
                });
                ix.labels.insert(tab.tool_id.clone(), label.clone());
                ix.label_to_id.insert(label, tab.tool_id.clone());
                if !tab.id.is_empty() {
                    ix.tab_ids.insert(tab.id.clone());
                    ix.uuid_to_id
                        .insert(crate::gocase::to_lower(&tab.id), tab.tool_id.clone());
                }
            }
        }
    }
    Ok(ix)
}

/// 정규 UUID 의 앞 8바이트다 (NFR-UID-4). 8바이트보다 짧으면 그대로다.
pub fn short_code(uuid: &str) -> &str {
    match uuid.get(..8) {
        Some(s) => s,
        None if uuid.len() >= 8 => short_code_bytes(uuid),
        None => uuid,
    }
}

// Go 는 바이트로 자른다. 8바이트 경계가 문자 중간이면 그 앞까지를 낸다(Rust 문자열은
// 잘린 UTF-8 을 담을 수 없다).
fn short_code_bytes(uuid: &str) -> &str {
    let mut end = 8;
    while !uuid.is_char_boundary(end) {
        end -= 1;
    }
    &uuid[..end]
}

/// 레이아웃 트리를 걸으며 모든 `pane` 노드를 out 에 담는다.
pub fn collect_panes<'a>(n: Option<&'a WsLayout>, out: &mut Vec<&'a WsLayout>) {
    let Some(n) = n else { return };
    if n.kind == LAYOUT_TYPE_PANE {
        out.push(n);
        return;
    }
    if n.kind == LAYOUT_TYPE_SPLIT {
        for c in &n.children {
            collect_panes(c.as_ref(), out);
        }
    }
}

/// blob 의 탭이 가리키는 toolId 집합이다 (FR-EM-14). 구 스키마는 빈 집합이 아니라 오류다 —
/// 모든 도구를 고아로 오판하지 않게 한다.
pub fn referenced_tool_ids(blob: &[u8]) -> Result<HashSet<String>, Error> {
    let mut out = HashSet::new();
    let Some(s) = decode_state(blob)? else {
        return Ok(out);
    };
    for win in &s.windows {
        let mut tools = Vec::new();
        collect_panes(win.layout.as_ref(), &mut tools);
        for pn in tools {
            for tab in &pn.tabs {
                if !tab.tool_id.is_empty() {
                    out.insert(tab.tool_id.clone());
                }
            }
        }
    }
    Ok(out)
}
