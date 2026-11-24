//! 구 식별자를 uuid 로 재작성한다 (묶음 M, WORKSPACE_IDENTITY_SRS §3.5).

use std::collections::{HashMap, HashSet};

use serde_json::Value;

use crate::tree::{Obj, decode_obj, decode_vec, tabs_of, walk_nodes};
use crate::{Error, marshal};

/// 구 식별자 재작성의 결과다 (FR-MGU-10).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct IdentityReport {
    pub windows: usize,
    pub panes: usize,
    pub tabs: usize,
    pub tools: usize,
    /// 매핑에 없어 값을 보존한 구 형식 참조다 (FR-MGU-6). 보고만 한다.
    pub dangling: Vec<String>,
}

impl IdentityReport {
    pub fn total(&self) -> usize {
        self.windows + self.panes + self.tabs + self.tools
    }
}

/// canonical 8-4-4-4-12 형태인지만 본다 (FR-MGU-3).
pub(crate) fn is_uuid_form(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 36 && b[8] == b'-' && b[13] == b'-' && b[18] == b'-' && b[23] == b'-'
}

type Table = HashMap<String, String>;

/// 재작성한 (workspace, tools, 보고). 입력이 없던 쪽은 `None` 이다.
pub type Rewritten = (Option<Vec<u8>>, Option<Vec<u8>>, IdentityReport);

fn str_at<'a>(m: &'a Obj, key: &str) -> Option<&'a str> {
    match m.get(key) {
        Some(Value::String(s)) => Some(s),
        _ => None,
    }
}

/// workspace/tools 블롭의 구 식별자를 uuid 로 재작성한다. 매핑을 먼저 완성한 뒤 일괄
/// 치환한다 (FR-MGU-5). 이미 uuid 형태인 id 는 재발급하지 않으므로 멱등하다 (FR-MGU-3).
/// `next_id` 가 `None` 이면 uuid v7 을 만든다.
pub fn rewrite_identifiers(
    workspace_blob: &[u8],
    tools_blob: &[u8],
    next_id: Option<&mut dyn FnMut() -> String>,
) -> Result<Rewritten, Error> {
    let mut default_next_id = otter_shared_uuid::new_string;
    let next_id: &mut dyn FnMut() -> String = match next_id {
        Some(g) => g,
        None => &mut default_next_id,
    };
    let mut rep = IdentityReport::default();
    let mut ws = if workspace_blob.is_empty() {
        None
    } else {
        decode_obj(workspace_blob, "workspace")?
    };
    let mut tools = if tools_blob.is_empty() {
        None
    } else {
        decode_vec(tools_blob, "tools")?
    };
    if ws.is_none() && tools.is_none() {
        return Ok((None, None, rep));
    }

    let tool_map = claim_tools(tools.as_deref().unwrap_or_default(), next_id);
    let entity_map = match ws.as_mut() {
        Some(ws) => claim_entities(ws, next_id),
        None => Table::new(),
    };
    let mut rw = Rewriter {
        tool_map: &tool_map,
        entity_map: &entity_map,
        rep: &mut rep,
        seen: HashSet::new(),
    };
    if let Some(t) = tools.as_mut() {
        rw.tools(t);
    }
    if let Some(w) = ws.as_mut() {
        rw.workspace(w);
    }

    let ws_out = ws.map(|w| marshal(&w, "workspace")).transpose()?;
    let tools_out = tools.map(|t| marshal(&t, "tools")).transpose()?;
    Ok((ws_out, tools_out, rep))
}

/// tools.json 의 구 형식 id 마다 새 uuid 를 예약한다.
fn claim_tools(tools: &[Value], next_id: &mut dyn FnMut() -> String) -> Table {
    let mut m = Table::new();
    for raw in tools {
        if let Value::Object(item) = raw
            && let Some(id) = str_at(item, "id")
            && !id.is_empty()
            && !is_uuid_form(id)
        {
            m.insert(id.to_owned(), next_id());
        }
    }
    m
}

/// 창·분할 칸·탭의 구 형식 id 마다 새 uuid 를 예약한다 — 도구와 분리된 매핑이다.
fn claim_entities(ws: &mut Obj, next_id: &mut dyn FnMut() -> String) -> Table {
    let mut m = Table::new();
    if let Some(Value::Array(windows)) = ws.get_mut("windows") {
        for raw in windows {
            let Value::Object(win) = raw else { continue };
            claim(&mut m, win, next_id);
            if let Some(Value::Object(layout)) = win.get_mut("layout") {
                walk_nodes(layout, &mut |node| {
                    claim(&mut m, node, next_id);
                    for tab in tabs_of(node) {
                        claim(&mut m, tab, next_id);
                    }
                });
            }
        }
    }
    m
}

fn claim(table: &mut Table, m: &Obj, next_id: &mut dyn FnMut() -> String) {
    let Some(id) = str_at(m, "id") else { return };
    if id.is_empty() || is_uuid_form(id) || table.contains_key(id) {
        return;
    }
    table.insert(id.to_owned(), next_id());
}

/// 예약된 매핑을 반영하고 반영 여부를 돌려준다.
fn apply_map(table: &Table, m: &mut Obj, key: &str) -> bool {
    let Some(nw) = str_at(m, key).and_then(|id| table.get(id)) else {
        return false;
    };
    m.insert(key.to_owned(), Value::String(nw.clone()));
    true
}

struct Rewriter<'a> {
    tool_map: &'a Table,
    entity_map: &'a Table,
    rep: &'a mut IdentityReport,
    seen: HashSet<String>,
}

impl Rewriter<'_> {
    fn dangle(&mut self, old: &str) {
        if self.seen.insert(old.to_owned()) {
            self.rep.dangling.push(old.to_owned());
        }
    }

    /// 참조를 매핑에 있을 때만 바꾼다. 구 형식인데 매핑에 없으면 끊어진 참조다 (FR-MGU-6).
    fn reference(&mut self, m: &mut Obj, key: &str, tools: bool) {
        let Some(old) = str_at(m, key).filter(|s| !s.is_empty()).map(str::to_owned) else {
            return;
        };
        let table = if tools {
            self.tool_map
        } else {
            self.entity_map
        };
        if let Some(nw) = table.get(&old) {
            m.insert(key.to_owned(), Value::String(nw.clone()));
        } else if !is_uuid_form(&old) {
            self.dangle(&old);
        }
    }

    fn tools(&mut self, tools: &mut [Value]) {
        for raw in tools {
            if let Value::Object(item) = raw
                && apply_map(self.tool_map, item, "id")
            {
                self.rep.tools += 1;
            }
        }
    }

    fn workspace(&mut self, ws: &mut Obj) {
        self.reference(ws, "activeWindow", false);
        if let Some(Value::Array(order)) = ws.get_mut("agentsOrder") {
            for raw in order.iter_mut() {
                let Value::String(old) = raw else { continue };
                if old.is_empty() {
                    continue;
                }
                if let Some(nw) = self.tool_map.get(old.as_str()) {
                    *raw = Value::String(nw.clone());
                } else if !is_uuid_form(old) {
                    let old = old.clone();
                    self.dangle(&old);
                }
            }
        }
        let Some(Value::Array(windows)) = ws.get_mut("windows") else {
            return;
        };
        for raw in windows {
            let Value::Object(win) = raw else { continue };
            if apply_map(self.entity_map, win, "id") {
                self.rep.windows += 1;
            }
            self.reference(win, "focusedPane", false);
            let Some(Value::Object(layout)) = win.get_mut("layout") else {
                continue;
            };
            walk_nodes(layout, &mut |node| {
                if apply_map(self.entity_map, node, "id") {
                    self.rep.panes += 1;
                }
                self.reference(node, "activeTab", false);
                for tab in tabs_of(node) {
                    if apply_map(self.entity_map, tab, "id") {
                        self.rep.tabs += 1;
                    }
                    self.reference(tab, "toolId", true);
                }
            });
        }
    }
}
