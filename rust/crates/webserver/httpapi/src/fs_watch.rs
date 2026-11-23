//! `PUT /api/fs/watch` 와 `fs_changed` 방송 (Go `handlers_fs_watch.go`, EDITOR_LIVE_RELOAD_SRS
//! FR-ELR-51·59·76).
//!
//! 감시 임대(attach/detach)는 SSE 구독(`commands::attach_sse_leases`)이 쥔다. `fs_changed` 뒤의
//! `gitWatch.Kick` 과 `applyGitWorktree` 는 gitWatch 를 세우는 5.5.8 이 잇는다.

use std::collections::BTreeMap;
use std::sync::Arc;

use dm_gocompat::filepath;
use dm_shared_httpresp::{self as httpresp, Response};
use dm_webserver_fswatch::{self as fswatch, Change, Manager, ManagerOptions};
use dm_webserver_hub::{CommandBroker, GIT_WATCH_INTERVAL, GIT_WATCH_WORKTREE_EVERY};
use http::StatusCode;
use serde::{Deserialize, Serialize};

use crate::Server;
use crate::files_stamp::FILE_STAMPS_MAX;
use crate::fs::{FS_ERR_BAD_REQUEST, fs_decode, fs_fail};
use crate::fs_stamp::FS_STAMP_MAX;
use crate::req::Req;

/// 한 클라이언트가 등록할 수 있는 디렉터리 수다 (FR-ELR-51) — fsStampMax + fileStampsMax.
pub(crate) const FS_WATCH_DIRS_MAX: usize = FS_STAMP_MAX + FILE_STAMPS_MAX;

/// 설정 blob 에서 워크트리 회차 간격을 읽는 키다 (FR-ELR-76).
#[cfg_attr(not(test), allow(dead_code))]
const GIT_WORKTREE_KEY: &str = "gitWorktreeInterval";

#[derive(Deserialize, Default)]
#[serde(default, rename = "httpapi.fsWatchReq")]
struct FsWatchReq {
    #[serde(rename = "clientId")]
    client_id: String,
    dirs: Option<Vec<String>>,
}

#[derive(Serialize)]
struct WatchResp {
    watching: Vec<String>,
}

#[derive(Serialize)]
struct ChangeOut<'a> {
    path: &'a str,
    #[serde(rename = "type")]
    kind: &'a str,
}

#[derive(Serialize)]
struct Changes<'a> {
    changes: Vec<ChangeOut<'a>>,
}

#[derive(Serialize)]
struct Overflow {
    overflow: bool,
}

/// Go `fsChangedPayload`: `fs_changed` 방송 본문이다 (FR-ELR-59).
pub(crate) fn fs_changed_payload(changes: &[Change], overflow: bool) -> Vec<u8> {
    if overflow {
        return dm_webserver_sse::payload("fs_changed", Some(&Overflow { overflow: true }));
    }
    let out = changes
        .iter()
        .map(|c| ChangeOut {
            path: &c.path,
            kind: c.kind.as_str(),
        })
        .collect();
    dm_webserver_sse::payload("fs_changed", Some(&Changes { changes: out }))
}

/// Go `newFSWatch`: 감시자를 세운다. 이벤트는 방송한다 (FR-ELR-59). 같은 경로로 git 관측을
/// 당기는 일(FR-ELR-75)은 5.5.8 이 gitWatch 와 함께 더한다.
pub(crate) fn new_fs_watch(cmds: Option<Arc<dyn CommandBroker>>) -> Manager {
    Manager::new(ManagerOptions::defaults(Arc::new(
        move |c: &[Change], overflow: bool| {
            if let Some(cmds) = &cmds {
                cmds.broadcast(&fs_changed_payload(c, overflow));
            }
        },
    )))
}

/// Go `gitWorktreeRounds`: 설정 blob 에서 워크트리 회차 간격을 회차 수로 낸다 (FR-ELR-76). 값은
/// `GIT_WATCH_INTERVAL` 로 나눠 올림한다. 읽을 수 없거나 범위 밖이면 표의 기본값이다.
/// 5.5.8 의 `applyGitWorktree` 가 부른다.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn git_worktree_rounds(blob: &[u8]) -> u64 {
    let spec = dm_shared_settingsschema::load()
        .ok()
        .and_then(|specs| dm_shared_settingsschema::by_key(&specs).remove(GIT_WORKTREE_KEY));
    let Some(spec) = spec else {
        return GIT_WATCH_WORKTREE_EVERY;
    };
    let Some(def) = spec.def.as_f64() else {
        return GIT_WATCH_WORKTREE_EVERY;
    };
    let mut ms = def;
    if !blob.is_empty()
        && let Ok(m) = dm_gocompat::json::unmarshal::<BTreeMap<String, serde_json::Value>>(blob)
        && let Some(v) = m.get(GIT_WORKTREE_KEY).and_then(serde_json::Value::as_f64)
    {
        let i = v as i64;
        if i as f64 == v
            && spec.min.is_none_or(|min| i >= min)
            && spec.max.is_none_or(|max| i <= max)
        {
            ms = v;
        }
    }
    (ms / GIT_WATCH_INTERVAL.as_millis() as f64).ceil() as u64
}

impl Server {
    /// PUT /api/fs/watch — 그 클라이언트의 감시 집합을 통째로 바꾼다 (FR-ELR-51). 통과하지
    /// 못한 것·없는 것·디렉터리가 아닌 것은 **빠진다**.
    pub(crate) async fn api_fs_watch(&self, r: &mut Req) -> Response {
        let req: FsWatchReq = match fs_decode(r).await {
            Ok(v) => v,
            Err(res) => return res,
        };
        let req_dirs = req.dirs.unwrap_or_default();
        if req_dirs.len() > FS_WATCH_DIRS_MAX {
            return fs_fail(FS_ERR_BAD_REQUEST, "dirs 가 너무 많다");
        }
        let mut dirs = Vec::with_capacity(req_dirs.len());
        for d in req_dirs {
            let Ok(target) = self.file_allow(&d) else {
                continue;
            };
            let Ok(real) = filepath::eval_symlinks(&target) else {
                continue;
            };
            if !std::fs::metadata(&real).is_ok_and(|st| st.is_dir()) {
                continue;
            }
            dirs.push(fswatch::Dir { path: d, real });
        }
        let Some(watch) = &self.fs.watch else {
            return fs_fail(FS_ERR_BAD_REQUEST, "SSE 구독이 없는 clientId");
        };
        match watch.set(&req.client_id, &dirs) {
            Ok(watching) => httpresp::json(StatusCode::OK, &WatchResp { watching }),
            Err(fswatch::NotAttached) => fs_fail(FS_ERR_BAD_REQUEST, "SSE 구독이 없는 clientId"),
        }
    }
}
