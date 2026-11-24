//! 창·탭·그룹 이름의 길이 판정 (Go `entity_name.go`, FR-RGS-7).

use std::collections::BTreeMap;

use http::StatusCode;
use otter_shared_httpresp::Response;
use otter_webserver_action::{self as action, Answer};
use otter_webserver_apierr as apierr;
use serde::Deserialize;

use crate::httperr::http_err;

/// 이름의 상한(UTF-16 단위)이다. 화면은 `/api/meta` 로 같은 값을 받는다.
pub(crate) const ENTITY_NAME_MAX: usize = 64;

/// 이름을 싣는 명령이다.
const ENTITY_NAME_COMMANDS: &[&str] = &[
    "newWindow",
    "newTab",
    "openEditorTab",
    "renameTab",
    "renameWindow",
    "newGroup",
    "renameGroup",
];

/// Go `entityNameAnswer`.
pub(crate) fn entity_name_answer(name: &str) -> Answer {
    if name.encode_utf16().count() > ENTITY_NAME_MAX {
        let mut args = BTreeMap::new();
        args.insert("max".to_owned(), serde_json::Value::from(ENTITY_NAME_MAX));
        return action::deny(400, apierr::CODE_NAME_TOO_LONG, Some(args));
    }
    action::allow()
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct NameArg {
    name: String,
}

/// Go `commandNameAnswer`: 이름을 싣는 명령이면 `args.name` 을 판정한다.
pub(crate) fn command_name_answer(act: &str, args: Option<&[u8]>) -> Answer {
    let Some(args) = args.filter(|a| !a.is_empty()) else {
        return action::allow();
    };
    if !ENTITY_NAME_COMMANDS.contains(&act) {
        return action::allow();
    }
    match otter_gocompat::json::unmarshal::<NameArg>(args) {
        Ok(a) => entity_name_answer(&a.name),
        Err(_) => action::allow(),
    }
}

/// Go `rejectCommandAnswer`: 평문 방언 `<사유>: max <상한>`.
pub(crate) fn reject_command_answer(a: &Answer) -> Response {
    let max = a
        .args
        .as_ref()
        .and_then(|m| m.get("max"))
        .map_or_else(|| "<nil>".to_owned(), ToString::to_string);
    let status = StatusCode::from_u16(a.status).unwrap_or(StatusCode::BAD_REQUEST);
    http_err(&format!("{}: max {max}", a.why), status, &a.why)
}
