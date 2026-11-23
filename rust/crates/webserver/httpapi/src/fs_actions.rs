//! 파일 표면의 동작 답 (Go `handlers_fs_actions.go` 의 일부). `/api/fs/{actions,validate-name}`
//! 종단은 5.5.7 이 옮긴다.

use std::collections::BTreeMap;

use dm_shared_httpresp::Response;
use dm_webserver_action::{self as action, Answer};
use serde::Serialize;

use crate::fs::{fs_fail_body, fs_status};

/// Go `fsDeny`: 상태는 코드의 표가 정한다 — 답의 상태와 거절의 상태가 한 자리에서 나온다.
pub(crate) fn fs_deny(code: &str, args: Option<BTreeMap<String, serde_json::Value>>) -> Answer {
    action::deny(fs_status(code).as_u16(), code, args)
}

#[derive(Serialize)]
struct RejectBody<'a> {
    #[serde(skip_serializing_if = "Option::is_none")]
    args: Option<&'a BTreeMap<String, serde_json::Value>>,
    code: &'a str,
}

/// Go `fsRejectAnswer`: 거짓인 답으로 실행 요청을 거절한다 (F-e). 서버 문구(`message`)는 싣지
/// 않는다 (D-SDA-5).
pub(crate) fn fs_reject_answer(a: &Answer) -> Response {
    fs_fail_body(
        &a.why,
        &RejectBody {
            args: a.args.as_ref(),
            code: &a.why,
        },
    )
}
