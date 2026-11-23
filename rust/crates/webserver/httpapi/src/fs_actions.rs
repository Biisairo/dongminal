//! 파일 표면의 동작 답 (Go `handlers_fs_actions.go`, SERVER_DRIVEN_ACTIONS_SRS F-a·F-i·F-e) —
//! 메뉴의 답(`/api/fs/actions`)과 이름 판정(`/api/fs/validate-name`). 실행 종단도 같은 판정을 부른다.

use std::collections::BTreeMap;
use std::path::MAIN_SEPARATOR;

use dm_gocompat::filepath;
use dm_shared_httpresp::Response;
use dm_webserver_action::{self as action, Answer};
use dm_webserver_apierr as apierr;
use serde::{Deserialize, Serialize};

use crate::Server;
use crate::fs::{
    FS_ERR_BAD_REQUEST, FsError, fs_decode, fs_fail, fs_fail_body, fs_from_io, fs_resolve_err,
    fs_status, fs_target_in,
};
use crate::fs_mutate::fs_count;
use crate::httperr::write_json;
use crate::req::Req;

#[derive(Deserialize, Default)]
#[serde(default, rename = "httpapi.fsActionsReq")]
struct FsActionsReq {
    root: String,
    paths: Option<Vec<String>>,
}

#[derive(Deserialize, Default)]
#[serde(default, rename = "httpapi.fsNameReq")]
struct FsNameReq {
    name: String,
}

#[derive(Serialize)]
struct ActionsResp {
    actions: BTreeMap<&'static str, Answer>,
    #[serde(skip_serializing_if = "Option::is_none")]
    count: Option<usize>,
}

impl Server {
    /// POST /api/fs/actions — 메뉴의 답과 삭제할 항목 수 (F-a).
    pub(crate) async fn api_fs_actions(&self, r: &mut Req) -> Response {
        let req: FsActionsReq = match fs_decode(r).await {
            Ok(v) => v,
            Err(res) => return res,
        };
        let paths = req.paths.unwrap_or_default();
        if paths.is_empty() {
            return fs_fail(FS_ERR_BAD_REQUEST, "paths 가 비었다");
        }
        let root = match self.fs_root(&req.root) {
            Ok(v) => v,
            Err(res) => return res,
        };
        let mut targets = Vec::with_capacity(paths.len());
        for p in &paths {
            match fs_target_in(&root, p) {
                Ok(t) => targets.push(t),
                Err(res) => return res,
            }
        }
        let (del, count) = self.fs_delete_answer(&root, &targets, self.limits.fs_delete);
        let moves: Vec<Answer> = targets
            .iter()
            .map(|t| self.fs_move_answer(&root, t))
            .collect();
        let copies: Vec<Answer> = targets.iter().map(|t| fs_copy_answer(t)).collect();
        write_json(&ActionsResp {
            actions: BTreeMap::from([
                (action::FS_RENAME, moves[0].clone()),
                (action::FS_MOVE, action::first(moves)),
                (action::FS_COPY, action::first(copies)),
                (action::FS_DELETE, del),
            ]),
            count: Some(count),
        })
    }

    /// POST /api/fs/validate-name — 만들기·이름 바꾸기의 이름 하나 (F-i · FR-SDA-53).
    pub(crate) async fn api_fs_validate_name(&self, r: &mut Req) -> Response {
        let req: FsNameReq = match fs_decode(r).await {
            Ok(v) => v,
            Err(res) => return res,
        };
        write_json(&ActionsResp {
            actions: BTreeMap::from([(action::FS_NAME, fs_name_answer(&req.name))]),
            count: None,
        })
    }

    /// Go `fsProtectAnswer`: 루트·홈·파일시스템 루트·다른 Editor 루트는 지우거나 옮기지 않는다
    /// (FR-EDT-112·118).
    pub(crate) fn fs_protect_answer(&self, root: &str, target: &str) -> Answer {
        if target == root {
            return fs_deny(apierr::CODE_EDITOR_ROOT_PROTECTED, None);
        }
        if filepath::dir(target) == target {
            return fs_deny(apierr::CODE_FILESYSTEM_ROOT_PROTECTED, None);
        }
        if let Ok(home) = self.entries.home()
            && target == home
        {
            return fs_deny(apierr::CODE_HOME_PROTECTED, None);
        }
        if let Ok(roots) = self.entries.roots()
            && roots.iter().any(|r| r == target)
        {
            return fs_deny(apierr::CODE_EDITOR_ROOT_PROTECTED, None);
        }
        action::allow()
    }

    /// Go `fsMoveAnswer`.
    pub(crate) fn fs_move_answer(&self, root: &str, target: &str) -> Answer {
        action::first([self.fs_protect_answer(root, target), fs_copy_answer(target)])
    }

    /// Go `fsDeleteAnswer`: 답과 지울 항목 수(대상 자신 제외).
    pub(crate) fn fs_delete_answer(
        &self,
        root: &str,
        targets: &[String],
        max: usize,
    ) -> (Answer, usize) {
        let mut total = 0;
        for target in targets {
            let a = self.fs_protect_answer(root, target);
            if !a.ok {
                return (a, 0);
            }
            match fs_count(target, max) {
                Err(e) => return (fs_err_answer(&e), 0),
                Ok(n) if n > max => return (fs_too_many(max), 0),
                Ok(n) => total += n - 1,
            }
        }
        (action::allow(), total)
    }
}

/// Go `fsCopyAnswer`: 원본이 있어야 한다.
pub(crate) fn fs_copy_answer(target: &str) -> Answer {
    match std::fs::symlink_metadata(target) {
        Ok(_) => action::allow(),
        Err(e) => fs_err_answer(&fs_from_io(&e)),
    }
}

/// Go `fsTooMany`.
pub(crate) fn fs_too_many(max: usize) -> Answer {
    fs_deny(
        apierr::CODE_TOO_MANY_ENTRIES,
        Some(BTreeMap::from([(
            "max".to_owned(),
            serde_json::Value::from(max),
        )])),
    )
}

/// Go `fsErrAnswer`: 파일 표면의 오류를 답으로 옮긴다.
pub(crate) fn fs_err_answer(e: &FsError) -> Answer {
    fs_deny(e.code, None)
}

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

/// Go `fsRejectAnswer`: 거짓인 답으로 실행 요청을 거절한다 (F-e). 서버 문구는 싣지 않는다 (D-SDA-5).
pub(crate) fn fs_reject_answer(a: &Answer) -> Response {
    fs_fail_body(
        &a.why,
        &RejectBody {
            args: a.args.as_ref(),
            code: &a.why,
        },
    )
}

/// Go `fsNameAnswer`: 앞뒤 공백을 지운 뒤 본다. 경로 구분자는 `/` 와 이 OS 의 구분자다.
pub(crate) fn fs_name_answer(name: &str) -> Answer {
    let n = name.trim();
    if n.is_empty() {
        return fs_deny(apierr::CODE_EMPTY_NAME, None);
    }
    if n.contains('/') || n.contains(MAIN_SEPARATOR) {
        return fs_deny(apierr::CODE_NAME_HAS_SEPARATOR, None);
    }
    if n == "." || n == ".." {
        return fs_deny(apierr::CODE_NAME_RESERVED, None);
    }
    action::allow()
}

/// Go `fsIntoSelfAnswer`: 디렉터리를 자기 안으로 옮기거나 복사하지 않는다 (FR-WBR-63).
pub(crate) fn fs_into_self_answer(src: &str, dst_dir: &str, is_dir: bool) -> Answer {
    if !is_dir {
        return action::allow();
    }
    let real = match filepath::eval_symlinks(src) {
        Ok(r) => r,
        Err(e) => return fs_err_answer(&fs_resolve_err(&e)),
    };
    let Ok(rel) = filepath::rel(&real, dst_dir) else {
        return action::allow();
    };
    if rel == ".." || rel.starts_with(&format!("..{MAIN_SEPARATOR}")) {
        return action::allow();
    }
    fs_deny(apierr::CODE_INTO_SELF, None)
}
