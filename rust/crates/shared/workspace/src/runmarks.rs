//! Run 표식(`tab.runId`·`window.ownerRunId`)의 트리 조작 (FR-EM-17, M8 D-A-13).

use serde_json::{Map, Value};

type Obj = Map<String, Value>;

/// 디코딩된 workspace 트리를 제자리에서 바꾼다. 서버가 모르는 필드가 살아남도록 일반
/// 맵을 걷는다. 바뀐 것이 있으면 true 다.
pub fn apply_run_marks(
    tree: &mut Obj,
    tabs: &std::collections::HashSet<String>,
    window_id: &str,
    mark_window: bool,
    run_id: &str,
) -> bool {
    let Some(Value::Array(wins)) = tree.get_mut("windows") else {
        return false;
    };
    let mut changed = false;
    for wv in wins {
        let Value::Object(win) = wv else { continue };
        let is_target = str_of(win, "id") == window_id;
        if mark_window {
            if is_target {
                changed = set_or_clear(win, "ownerRunId", run_id) || changed;
            }
        } else if run_id.is_empty() && !window_id.is_empty() && is_target {
            changed = set_or_clear(win, "ownerRunId", "") || changed;
        }
        if let Some(layout) = win.get_mut("layout")
            && mark_tabs_in(layout, tabs, run_id)
        {
            changed = true;
        }
    }
    changed
}

fn mark_tabs_in(node: &mut Value, tabs: &std::collections::HashSet<String>, run_id: &str) -> bool {
    let Value::Object(n) = node else { return false };
    let mut changed = false;
    if let Some(Value::Array(list)) = n.get_mut("tabs") {
        for tv in list {
            let Value::Object(tab) = tv else { continue };
            if tabs.contains(str_of(tab, "id")) {
                changed = set_or_clear(tab, "runId", run_id) || changed;
            }
        }
    }
    if let Some(Value::Array(kids)) = n.get_mut("children") {
        for kid in kids {
            if mark_tabs_in(kid, tabs, run_id) {
                changed = true;
            }
        }
    }
    changed
}

/// Go `v, _ := m[key].(string)` — 문자열이 아니면 "".
fn str_of<'a>(m: &'a Obj, key: &str) -> &'a str {
    match m.get(key) {
        Some(Value::String(s)) => s,
        _ => "",
    }
}

/// 값을 쓰거나, 값이 비면 키를 지운다. 바뀌지 않은 트리는 저장을 일으키지 않는다.
fn set_or_clear(m: &mut Obj, key: &str, value: &str) -> bool {
    if value.is_empty() {
        return m.shift_remove(key).is_some();
    }
    if matches!(m.get(key), Some(Value::String(cur)) if cur == value) {
        return false;
    }
    m.insert(key.to_owned(), Value::String(value.to_owned()));
    true
}
