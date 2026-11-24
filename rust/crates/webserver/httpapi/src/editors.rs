//! `/api/editors/*` — Editor 목록 (Go `handlers_editors.go`, EDITOR_TAB_SRS §3.11). 탐색기와
//! 같은 오류 규약(`fs_fail`·`fs_json`)을 쓴다.

use std::collections::BTreeMap;

use otter_gocompat::filepath;
use otter_shared_httpresp::Response;
use otter_webserver_action::{self as action, Answer};
use otter_webserver_apierr as apierr;
use otter_webserver_domain_git_core::Ctx;
use otter_webserver_domain_wsentry::{self as wsentry, Error as WsError};
use serde::{Deserialize, Serialize};

use crate::Server;
use crate::fs::{FS_ERR_BAD_REQUEST, fs_decode, fs_fail, fs_fail_err, fs_from_os};
use crate::fs_actions::{fs_deny, fs_reject_answer};
use crate::httperr::write_json;
use crate::req::Req;

#[derive(Deserialize, Default)]
#[serde(default, rename = "httpapi.fsPathReq")]
struct FsPathReq {
    path: String,
}

#[derive(Deserialize, Default)]
#[serde(default, rename = "httpapi.fsReorderReq")]
struct FsReorderReq {
    src: String,
    target: String,
    before: bool,
}

#[derive(Serialize)]
struct EditorsResp {
    fixed: Vec<String>,
    home: String,
    list: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    notes: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    plugins: Option<String>,
}

#[derive(Serialize)]
struct ListsResp {
    list: Vec<String>,
    pinned: Vec<String>,
}

#[derive(Serialize)]
struct ListResp {
    list: Vec<String>,
}

#[derive(Serialize)]
struct ActionsResp {
    actions: BTreeMap<&'static str, Answer>,
}

impl Server {
    /// GET /api/editors — {fixed, home, list, notes?, plugins?} (FR-EDT-29·110, FR-NOT-3·11,
    /// FR-EXT-9b, K-e).
    pub(crate) async fn api_editors_get(&self, _r: &mut Req) -> Response {
        let (home, list) = match self.entries.list() {
            Ok(v) => v,
            Err(e) => return fs_fail_err(&fs_from_os(&e)),
        };
        // 메모·플러그인 자리를 얻지 못하는 것은 이 응답의 실패가 아니다 — 키가 빠진다.
        let notes = self.entries.notes().ok();
        let plugins = self.entries.plugins().ok();
        let fixed = wsentry::fixed_roots(
            &home,
            notes.as_deref().unwrap_or_default(),
            plugins.as_deref().unwrap_or_default(),
        );
        write_json(&EditorsResp {
            fixed,
            home,
            list,
            notes,
            plugins,
        })
    }

    /// POST /api/editors/add — 멱등이고, 응답은 두 목록을 함께 준다 (FR-EDT-25·39·110).
    pub(crate) async fn api_editors_add(&self, r: &mut Req) -> Response {
        let req: FsPathReq = match fs_decode(r).await {
            Ok(v) => v,
            Err(res) => return res,
        };
        // 판정은 답과 같은 함수다 (F-m · D-SDA-6).
        let a = editor_add_answer(&req.path);
        if !a.ok {
            return fs_reject_answer(&a);
        }
        let ctx = Ctx::from_token(r.ctx.clone());
        match self.entries.editor_add(&ctx, &req.path).await {
            Ok(l) => write_json(&ListsResp {
                list: l.editors,
                pinned: l.pinned,
            }),
            Err(e) => fs_fail_err(&fs_from_os(&e)),
        }
    }

    /// POST /api/editors/remove — 문자열 완전 일치다 (FR-EDT-26).
    pub(crate) async fn api_editors_remove(&self, r: &mut Req) -> Response {
        let req: FsPathReq = match fs_decode(r).await {
            Ok(v) => v,
            Err(res) => return res,
        };
        if !filepath::is_abs(&req.path) {
            return fs_fail(FS_ERR_BAD_REQUEST, "path 는 절대경로여야 한다");
        }
        match self.entries.editor_remove(&req.path) {
            Ok(l) => write_json(&ListsResp {
                list: l.editors,
                pinned: l.pinned,
            }),
            Err(e) => fs_fail_err(&fs_from_os(&e)),
        }
    }

    /// POST /api/editors/reorder — 델타다 (FR-EDT-27·110·111).
    pub(crate) async fn api_editors_reorder(&self, r: &mut Req) -> Response {
        let req: FsReorderReq = match fs_decode(r).await {
            Ok(v) => v,
            Err(res) => return res,
        };
        if req.src.is_empty() {
            return fs_fail(FS_ERR_BAD_REQUEST, "src 가 없다");
        }
        if !filepath::is_abs(&req.src) || (!req.target.is_empty() && !filepath::is_abs(&req.target))
        {
            return fs_fail(FS_ERR_BAD_REQUEST, "src·target 은 절대경로여야 한다");
        }
        match self
            .entries
            .editor_reorder(&req.src, &req.target, req.before)
        {
            Ok(list) => write_json(&ListResp { list }),
            Err(e) => fs_fail_err(&fs_from_os(&e)),
        }
    }

    /// POST /api/editors/validate — 편집기 루트 추가 경로의 답 (F-m · FR-SDA-55).
    pub(crate) async fn api_editors_validate(&self, r: &mut Req) -> Response {
        let req: FsPathReq = match fs_decode(r).await {
            Ok(v) => v,
            Err(res) => return res,
        };
        write_json(&ActionsResp {
            actions: BTreeMap::from([(action::EDITOR_ADD, editor_add_answer(&req.path))]),
        })
    }
}

/// Go `editorAddAnswer`: `check_editor_path` 의 오류를 사유 코드로 옮긴다.
pub(crate) fn editor_add_answer(path: &str) -> Answer {
    match wsentry::check_editor_path(path) {
        Ok(_) => action::allow(),
        Err(WsError::EmptyPath) => fs_deny(apierr::CODE_EMPTY_PATH, None),
        Err(WsError::NotAbsolute) => fs_deny(apierr::CODE_ABS_PATH_NEEDED, None),
        Err(WsError::NotFound) => fs_deny(apierr::CODE_NOT_FOUND, None),
        Err(WsError::FilesystemRoot) => fs_deny(apierr::CODE_FILESYSTEM_ROOT_PROTECTED, None),
        Err(_) => fs_deny(apierr::CODE_NOT_A_DIRECTORY, None),
    }
}
