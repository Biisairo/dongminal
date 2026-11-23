//! `dmctl list-workspace`·`list-groups` 의 행 — 워크스페이스 트리를 도구·그룹 행으로 편다.

use std::collections::{BTreeMap, HashMap};
use std::io::Write;

use dm_gocompat::json::{self, RawMessage};
use dm_shared_apipath as apipath;
use dm_shared_workspace::{self as workspace, WsLayout, WsState, WsTab, WsWindow};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use crate::ctx::{Ctx, errf};
use crate::http::{ExitRule, OnErr, base_url, http_exit, http_get, refuse_with};

#[derive(Default, Deserialize)]
#[serde(default, rename = "runtimebin.toolEntry")]
pub(crate) struct ToolEntry {
    pub id: String,
    pub pid: i64,
    #[serde(rename = "sizeCols")]
    pub size_cols: i64,
    #[serde(rename = "sizeRows")]
    pub size_rows: i64,
    /// 이 도구의 전경 프로세스 이름이다 (FR-TAN-5).
    #[serde(rename = "fgName")]
    pub fg_name: String,
}

const DEFAULT_TAB_NAME: &str = "Shell";
const NAME_SOURCE_AUTO: &str = "auto";
pub(crate) const NAME_SOURCE_MANUAL: &str = "manual";
const FG_TAB_NAMES_SETTING: &str = "fgTabNames";
pub(crate) const WINDOW_CONTAINER_TOP: &str = "top";

/// web/js/core/layout-tree.js 의 같은 이름 함수와 같은 규칙이다 (FR-TAN-1/3/4).
fn tab_name_source(t: &WsTab) -> &str {
    match t.kind.as_str() {
        // FR-TAN-3: 이름이 콘텐츠에서 파생된다.
        "editor" | "run" | "git" => return NAME_SOURCE_MANUAL,
        _ => {}
    }
    if t.name_source == NAME_SOURCE_MANUAL || t.name_source == NAME_SOURCE_AUTO {
        return &t.name_source;
    }
    // FR-TAN-4: 구 워크스페이스에는 필드가 없다. 기본 이름이면 auto 다.
    if t.name == DEFAULT_TAB_NAME {
        NAME_SOURCE_AUTO
    } else {
        NAME_SOURCE_MANUAL
    }
}

/// 화면에 보이는 이름이다 (layout-tree.js 의 tabName). auto 인 탭만 파생 이름을 받는다.
/// 설정은 파생 이름이 실제로 쓰일 때만 묻는다.
fn tab_display_name(
    t: &WsTab,
    fg: &HashMap<String, String>,
    enabled: &mut dyn FnMut() -> bool,
) -> String {
    if tab_name_source(t) != NAME_SOURCE_AUTO {
        return t.name.clone();
    }
    match fg.get(&t.tool_id) {
        Some(n) if !n.is_empty() && enabled() => n.clone(),
        _ => t.name.clone(),
    }
}

/// FR-TAN-19 의 설정을 읽는다. 기본은 켬이며, 읽지 못하면 기본으로 간다.
fn fg_tab_names_enabled(base: &str) -> bool {
    let r = http_get(&format!("{base}{}", apipath::SETTINGS));
    if r.err.is_some() || !(200..300).contains(&r.status) {
        return true;
    }
    let Ok(s) = json::unmarshal::<Option<BTreeMap<String, RawMessage>>>(&r.body) else {
        return true;
    };
    let raw = s
        .and_then(|m| m.get(FG_TAB_NAMES_SETTING).cloned())
        .unwrap_or_default();
    match json::unmarshal::<Option<bool>>(&raw.0) {
        Ok(Some(v)) => v,
        _ => true,
    }
}

#[derive(Debug, Default, Clone, Serialize, PartialEq)]
pub(crate) struct ListWorkspaceRow {
    pub label: String,
    pub uuid: String,
    pub short: String,
    #[serde(rename = "toolId")]
    pub tool_id: String,
    #[serde(rename = "shellPid")]
    pub shell_pid: i64,
    #[serde(rename = "sizeCols")]
    pub size_cols: i64,
    #[serde(rename = "sizeRows")]
    pub size_rows: i64,
    pub window: String,
    pub tab: String,
    #[serde(rename = "windowUuid")]
    pub window_uuid: String,
    #[serde(rename = "paneUuid")]
    pub pane_uuid: String,
    pub focused: bool,
    /// FR-WGR-34 · FR-ORD-30: 그룹과 담는 곳 안의 자리(1부터). git·editor 창은 비어 있다.
    #[serde(rename = "groupUuid", skip_serializing_if = "String::is_empty")]
    pub group_uuid: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub group: String,
    #[serde(rename = "windowContainer", skip_serializing_if = "String::is_empty")]
    pub window_container: String,
    #[serde(rename = "windowIndex", skip_serializing_if = "is_zero")]
    pub window_index: i64,
    #[serde(rename = "windowCount", skip_serializing_if = "is_zero")]
    pub window_count: i64,
    #[serde(rename = "tabIndex")]
    pub tab_index: i64,
    #[serde(rename = "tabCount")]
    pub tab_count: i64,
}

fn is_zero(n: &i64) -> bool {
    *n == 0
}

/// window 하나가 담는 곳 안에서 선 자리다.
#[derive(Debug, Default, Clone, PartialEq)]
pub(crate) struct WinPos {
    pub container: String,
    pub index: i64,
    pub count: i64,
}

/// web/js/core/window-order.js 의 winOrderItems 와 같은 규칙이다: 일반 창(type 없음)만
/// 세고, 같은 그룹의 연속한 창은 최상위에서 한 칸이다.
pub(crate) fn window_positions(windows: &[WsWindow]) -> HashMap<String, WinPos> {
    let mut items: Vec<(String, Vec<String>)> = Vec::new();
    for w in windows {
        if !w.kind.is_empty() {
            continue;
        }
        if let Some(last) = items.last_mut()
            && !w.group_id.is_empty()
            && last.0 == w.group_id
        {
            last.1.push(w.id.clone());
            continue;
        }
        items.push((w.group_id.clone(), vec![w.id.clone()]));
    }
    let mut out = HashMap::new();
    let n = items.len() as i64;
    for (i, (group, wins)) in items.iter().enumerate() {
        if group.is_empty() {
            out.insert(
                wins[0].clone(),
                WinPos {
                    container: WINDOW_CONTAINER_TOP.to_owned(),
                    index: i as i64 + 1,
                    count: n,
                },
            );
            continue;
        }
        for (j, id) in wins.iter().enumerate() {
            out.insert(
                id.clone(),
                WinPos {
                    container: group.clone(),
                    index: j as i64 + 1,
                    count: wins.len() as i64,
                },
            );
        }
    }
    out
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub(crate) struct GroupTree {
    pub repo: String,
    pub root: i64,
}

/// `dmctl list-groups` 의 한 줄이다. index 0 은 빈 그룹(최상위 목록 끝)이다.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub(crate) struct GroupRow {
    pub uuid: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tree: Option<GroupTree>,
    pub index: i64,
    pub windows: i64,
}

pub(crate) fn build_group_rows(ws: Option<&WsState>) -> Option<Vec<GroupRow>> {
    let ws = ws?;
    let mut top: HashMap<&str, i64> = HashMap::new();
    let mut count: HashMap<&str, i64> = HashMap::new();
    let mut item_idx = 0;
    let mut prev = "";
    for w in &ws.windows {
        if !w.kind.is_empty() {
            continue;
        }
        if w.group_id.is_empty() || w.group_id != prev {
            item_idx += 1;
        }
        prev = &w.group_id;
        if !w.group_id.is_empty() {
            *count.entry(&w.group_id).or_default() += 1;
            top.entry(&w.group_id).or_insert(item_idx);
        }
    }
    let (mut live, mut empty) = (Vec::new(), Vec::new());
    for g in &ws.window_groups {
        let r = GroupRow {
            uuid: g.id.clone(),
            name: g.name.clone(),
            tree: g.tree.as_ref().map(|t| GroupTree {
                repo: t.repo.clone(),
                root: t.root,
            }),
            index: top.get(g.id.as_str()).copied().unwrap_or(0),
            windows: count.get(g.id.as_str()).copied().unwrap_or(0),
        };
        if r.windows == 0 {
            empty.push(r);
        } else {
            live.push(r);
        }
    }
    if live.is_empty() && empty.is_empty() {
        return None;
    }
    live.sort_by_key(|r| r.index);
    live.extend(empty);
    Some(live)
}

pub(crate) fn build_list_workspace_rows(
    ws: Option<&WsState>,
    tools: &[ToolEntry],
    enabled: &mut dyn FnMut() -> bool,
) -> Option<Vec<ListWorkspaceRow>> {
    let ws = ws?;
    let mut by_tool: HashMap<&str, &ToolEntry> = HashMap::new();
    let mut fg = HashMap::new();
    for p in tools {
        by_tool.insert(&p.id, p);
        if !p.fg_name.is_empty() {
            fg.insert(p.id.clone(), p.fg_name.clone());
        }
    }
    let pos = window_positions(&ws.windows);
    let mut group_name: HashMap<&str, &str> = HashMap::new();
    for g in &ws.window_groups {
        group_name.insert(&g.id, &g.name);
    }
    let mut out = Vec::new();
    for (si, sess) in ws.windows.iter().enumerate() {
        let wp = pos.get(&sess.id).cloned().unwrap_or_default();
        let mut regions: Vec<&WsLayout> = Vec::new();
        workspace::collect_panes(sess.layout.as_ref(), &mut regions);
        for (pi, rg) in regions.iter().enumerate() {
            for (ti, tab) in rg.tabs.iter().enumerate() {
                let focused = sess.id == ws.active_window
                    && sess.focused_pane == rg.id
                    && rg.active_tab == tab.id;
                let t = by_tool.get(tab.tool_id.as_str());
                out.push(ListWorkspaceRow {
                    label: format!("W{}.P{}.T{}", si + 1, pi + 1, ti + 1),
                    uuid: tab.id.clone(),
                    short: workspace::short_code(&tab.id).to_owned(),
                    tool_id: tab.tool_id.clone(),
                    shell_pid: t.map_or(0, |t| t.pid),
                    size_cols: t.map_or(0, |t| t.size_cols),
                    size_rows: t.map_or(0, |t| t.size_rows),
                    window: sess.name.clone(),
                    tab: tab_display_name(tab, &fg, enabled),
                    window_uuid: sess.id.clone(),
                    pane_uuid: rg.id.clone(),
                    focused,
                    group_uuid: sess.group_id.clone(),
                    group: group_name
                        .get(sess.group_id.as_str())
                        .map_or_else(String::new, |s| (*s).to_owned()),
                    window_container: wp.container.clone(),
                    window_index: wp.index,
                    window_count: wp.count,
                    tab_index: ti as i64 + 1,
                    tab_count: rg.tabs.len() as i64,
                });
            }
        }
    }
    if out.is_empty() {
        return None;
    }
    Some(out)
}

/// substr 이 비었거나 s 가 substr 을 담으면 참이다(대소문자 무시).
pub fn match_fold(s: &str, substr: &str) -> bool {
    if substr.is_empty() {
        return true;
    }
    let lower = |x: &str| x.chars().flat_map(char::to_lowercase).collect::<String>();
    lower(s).contains(&lower(substr))
}

/// `/api/state` 한 번을 읽는다 — 이 읽기의 유일한 자리다 (FR-RDG-22). 실패는 stderr 에 한
/// 벌의 문구로 내고 1 이다. quiet 이면 아무것도 쓰지 않는다.
pub(crate) fn fetch_state<T: DeserializeOwned>(ctx: &mut Ctx<'_>, quiet: bool) -> Result<T, i32> {
    let r = http_get(&format!("{}{}", base_url(ctx.env), apipath::STATE));
    let rule = ExitRule {
        prefix: "dmctl",
        on_err: quiet.then(|| -> OnErr<'_> { Box::new(|_, _| 1) }),
        ok: None,
        refuse: refuse_with(move |w: &mut dyn Write, st, b: &[u8]| {
            if quiet {
                return;
            }
            let _ = write!(w, "dmctl: {} returned status {st}: ", apipath::STATE);
            let _ = w.write_all(b);
            let _ = w.write_all(b"\n");
        }),
    };
    let body = http_exit(ctx, r, rule)?;
    match json::unmarshal::<T>(&body) {
        Ok(v) => Ok(v),
        Err(e) => {
            if !quiet {
                errf!(ctx, "dmctl: invalid {} response: {e}\n", apipath::STATE);
            }
            Err(1)
        }
    }
}

#[derive(Default, Deserialize)]
#[serde(default)]
pub(crate) struct WorkspaceOnly {
    pub workspace: Option<WsState>,
}

/// /api/state 의 워크스페이스 트리만 읽는다 (list-groups).
pub(crate) fn fetch_workspace_tree(ctx: &mut Ctx<'_>) -> Result<Option<WsState>, i32> {
    fetch_state::<WorkspaceOnly>(ctx, false).map(|s| s.workspace)
}

/// `/api/state` 를 읽어 행으로 만든다.
pub(crate) fn fetch_list_workspace_rows(
    ctx: &mut Ctx<'_>,
) -> Result<Option<Vec<ListWorkspaceRow>>, i32> {
    dm_gocompat::go_type!(GoTools = "[]runtimebin.toolEntry");
    #[derive(Default, Deserialize)]
    #[serde(default)]
    struct State {
        #[serde(deserialize_with = "json::with_go_type::<GoTools, _, _>")]
        tools: Vec<ToolEntry>,
        workspace: Option<WsState>,
        /// 서버가 설정에서 읽어 실어 준 FR-TAN-19 의 값이다. 없으면 옛 서버다.
        #[serde(rename = "fgTabNames")]
        fg_tab_names: Option<bool>,
    }
    let state: State = fetch_state(ctx, false)?;
    let base = base_url(ctx.env);
    let mut cached: Option<bool> = state.fg_tab_names;
    let mut enabled = || *cached.get_or_insert_with(|| fg_tab_names_enabled(&base));
    Ok(build_list_workspace_rows(
        state.workspace.as_ref(),
        &state.tools,
        &mut enabled,
    ))
}

pub(crate) fn rename_matches(
    want_window: bool,
    want_auto: bool,
    want_name: &str,
    w: &WsWindow,
    t: &WsTab,
) -> bool {
    if want_window {
        return w.name == want_name;
    }
    if want_auto {
        return t.name == DEFAULT_TAB_NAME && t.name_source != NAME_SOURCE_MANUAL;
    }
    t.name == want_name && t.name_source == NAME_SOURCE_MANUAL
}
