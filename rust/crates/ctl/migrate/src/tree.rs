//! 일반 맵 트리를 다루는 도우미. Go 의 `map[string]interface{}` 순회와 같은 뜻이다.

use otter_gocompat::json::{self, GoTyped};
use serde_json::{Map, Value};

use crate::Error;

pub(crate) type Obj = Map<String, Value>;

otter_gocompat::go_type!(GoMapAny = "map[string]interface {}");
otter_gocompat::go_type!(GoSliceAny = "[]interface {}");

/// Go `json.Unmarshal(b, &map[string]interface{})`. `null` 은 `None`(nil map)이다.
pub(crate) fn decode_obj(b: &[u8], what: &str) -> Result<Option<Obj>, Error> {
    json::unmarshal::<GoTyped<GoMapAny, Option<Obj>>>(b)
        .map(GoTyped::into_inner)
        .map_err(|e| Error::Msg(format!("{what} 파싱: {e}")))
}

/// Go `json.Unmarshal(b, &[]interface{})`. `null` 은 `None`(nil slice)이다.
pub(crate) fn decode_vec(b: &[u8], what: &str) -> Result<Option<Vec<Value>>, Error> {
    json::unmarshal::<GoTyped<GoSliceAny, Option<Vec<Value>>>>(b)
        .map(GoTyped::into_inner)
        .map_err(|e| Error::Msg(format!("{what} 파싱: {e}")))
}

/// Go `v, _ := x.(string)` — 문자열이 아니면 "".
pub(crate) fn as_str(v: Option<&Value>) -> &str {
    match v {
        Some(Value::String(s)) => s,
        _ => "",
    }
}

/// 키를 옮긴다. 실제로 옮겼는지를 돌려준다.
pub(crate) fn rename_key(m: &mut Obj, from: &str, to: &str) -> bool {
    match m.shift_remove(from) {
        Some(v) => {
            m.insert(to.to_owned(), v);
            true
        }
        None => false,
    }
}

/// 레이아웃 트리를 걸으며 region→pane, paneId→toolId 를 적용한다. 미지 type 은 바꾸지 않고
/// 자식만 걷는다. 트리에서 바꾼 것이 있는지를 돌려준다.
pub(crate) fn convert_layout(node: &mut Obj, already_migrated: bool) -> bool {
    let mut changed = false;
    if !already_migrated {
        if node.get("type") == Some(&Value::String("region".into())) {
            node.insert("type".into(), Value::String("pane".into()));
            changed = true;
        }
        if let Some(Value::Array(tabs)) = node.get_mut("tabs") {
            for raw in tabs {
                if let Value::Object(tab) = raw {
                    changed = rename_key(tab, "paneId", "toolId") || changed;
                }
            }
        }
    }
    if let Some(Value::Array(children)) = node.get_mut("children") {
        for raw in children {
            if let Value::Object(child) = raw {
                changed = convert_layout(child, already_migrated) || changed;
            }
        }
    }
    changed
}

/// 레이아웃 트리를 전위 순회하며 각 노드에 f 를 적용한다.
pub(crate) fn walk_nodes(node: &mut Obj, f: &mut dyn FnMut(&mut Obj)) {
    f(node);
    if let Some(Value::Array(children)) = node.get_mut("children") {
        for raw in children {
            if let Value::Object(child) = raw {
                walk_nodes(child, f);
            }
        }
    }
}

/// 노드의 탭 목록 중 객체인 것.
pub(crate) fn tabs_of(node: &mut Obj) -> Vec<&mut Obj> {
    match node.get_mut("tabs") {
        Some(Value::Array(raw)) => raw
            .iter_mut()
            .filter_map(|r| match r {
                Value::Object(t) => Some(t),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    }
}
