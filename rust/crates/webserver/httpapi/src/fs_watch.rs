//! `PUT /api/fs/watch` 와 `fs_changed` 방송 (Go `handlers_fs_watch.go`, EDITOR_LIVE_RELOAD_SRS
//! FR-ELR-51·59·76).
//!
//! 감시 임대(attach/detach)는 채널의 `hello.client` 신원(`commands::attach_channel_leases`)이 쥔다.

use std::sync::Arc;

use http::StatusCode;
use otter_gocompat::filepath;
use otter_shared_httpresp::{self as httpresp, Response};
use otter_webserver_fswatch::{self as fswatch, Change, Manager, ManagerOptions};
use otter_webserver_hub::GitWatcher;
use serde::{Deserialize, Serialize};

use crate::Server;
use crate::files_stamp::FILE_STAMPS_MAX;
use crate::fs::{FS_ERR_BAD_REQUEST, fs_decode, fs_fail};
use crate::fs_stamp::FS_STAMP_MAX;
use crate::req::Req;

/// 한 클라이언트가 등록할 수 있는 디렉터리 수다 (FR-ELR-51) — fsStampMax + fileStampsMax.
pub(crate) const FS_WATCH_DIRS_MAX: usize = FS_STAMP_MAX + FILE_STAMPS_MAX;

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

/// 파일 변화 사건의 본문이다 (FR-ELR-59). 채널의 `fs` 사건 토픽이 싣는다 (CHANNEL_PROTOCOL C2b).
pub(crate) fn fs_changed_args(changes: &[Change], overflow: bool) -> serde_json::Value {
    let v = if overflow {
        serde_json::to_value(Overflow { overflow: true })
    } else {
        let out = changes
            .iter()
            .map(|c| ChangeOut {
                path: &c.path,
                kind: c.kind.as_str(),
            })
            .collect();
        serde_json::to_value(Changes { changes: out })
    };
    v.unwrap_or_default()
}

impl crate::Server {
    /// 파일 변화를 `fs` 사건 토픽으로 낸다.
    pub(crate) fn publish_fs_changed(&self, changes: &[Change], overflow: bool) {
        self.topics
            .publish_event("fs", fs_changed_args(changes, overflow));
    }
}

/// Go `newFSWatch`: 감시자를 세운다. 이벤트는 방송하고, 같은 경로로 git 관측을 당긴다
/// (FR-ELR-59·75).
///
/// 감시 이벤트는 tokio 밖의 스레드에서 오고, git 의 계기 관측은 tokio 타이머를 건다 — 세운 순간의
/// 런타임에 들어가 부른다. 런타임 밖에서 세웠으면 계기 관측만 빠진다(회차 관측은 그대로다).
pub(crate) fn new_fs_watch(
    me: std::sync::Weak<crate::Server>,
    git: Option<Arc<GitWatcher>>,
) -> Manager {
    let rt = tokio::runtime::Handle::try_current().ok();
    Manager::new(ManagerOptions::defaults(Arc::new(
        move |c: &[Change], overflow: bool| {
            if let Some(s) = me.upgrade() {
                s.publish_fs_changed(c, overflow);
            }
            if let (Some(git), Some(rt)) = (&git, &rt)
                && !c.is_empty()
            {
                let paths: Vec<String> = c.iter().map(|x| x.path.clone()).collect();
                let _g = rt.enter();
                git.kick(&paths);
            }
        },
    )))
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
