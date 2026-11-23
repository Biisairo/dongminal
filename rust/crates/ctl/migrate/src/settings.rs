use serde_json::Value;

use crate::tree::{convert_layout, decode_obj};
use crate::{Error, is_blank, marshal};

/// v2 어휘로 바뀌는 단축키 action id 다 (FR-EM-6a).
const SHORTCUT_RENAMES: [(&str, &str); 4] = [
    ("sessionNext", "windowNext"),
    ("sessionPrev", "windowPrev"),
    ("newSession", "newWindow"),
    ("closeSession", "closeWindow"),
];

/// settings.json 을 v2 어휘로 바꾼다. 바꾼 것이 있을 때만 산출물을 낸다 — 바꿀 것이 없으면
/// `(None, [])` 이고, 호출자는 파일을 건드리지 않는다. 개명된 단축키 목록(정렬)을 함께 낸다.
pub fn settings(blob: &[u8]) -> Result<(Option<Vec<u8>>, Vec<String>), Error> {
    if is_blank(blob) {
        return Ok((None, Vec::new()));
    }
    let Some(mut m) = decode_obj(blob, "settings")? else {
        return Ok((None, Vec::new()));
    };
    let mut changed = false;
    let mut renamed = Vec::new();
    if let Some(Value::Object(sc)) = m.get_mut("shortcuts") {
        for (old, neu) in SHORTCUT_RENAMES {
            let Some(v) = sc.shift_remove(old) else {
                continue;
            };
            // 신 키가 이미 있으면 그것을 존중한다 (사용자가 재설정한 경우).
            if !sc.contains_key(neu) {
                sc.insert(neu.to_owned(), v);
            }
            renamed.push(format!("{old} -> {neu}"));
        }
        renamed.sort();
        changed = !renamed.is_empty();
    }
    if let Some(Value::Array(presets)) = m.get_mut("layoutPresets") {
        for raw in presets {
            if let Value::Object(p) = raw
                && let Some(Value::Object(layout)) = p.get_mut("layout")
            {
                changed = convert_layout(layout, false) || changed;
            }
        }
    }
    if !changed {
        return Ok((None, Vec::new()));
    }
    Ok((Some(marshal(&m, "settings")?), renamed))
}
