//! POST /api/git/lock/remove — 남은 index.lock 을 지운다. 파괴적이다 (REPO_FIX 01 §7.2 · FR-GIT-89).
//!
//! 자동 삭제는 없다 — 사용자가 확인한 뒤에만 온다. 잡이 돌거나 동기 쓰기가 뮤텍스를 쥐고
//! 있으면 기다리지 않고 거절한다. 지울 경로는 서버가 git 에 물어 정한다.

use std::io;
use std::time::UNIX_EPOCH;

use dm_gocompat::{filepath, oserr};
use dm_shared_httpresp::Response;
use dm_webserver_apierr as apierr;
use dm_webserver_domain_git_core as core;
use dm_webserver_domain_git_jobs::{SLOT_COMMON, SLOT_INDEX};
use http::StatusCode;
use serde::Deserialize;

use crate::GitServer;
use crate::answers::slots_answer;
use crate::reply::{ERR_FAILED, obj};
use crate::req::Req;
use crate::write::GitWrite;

/// 이 종단이 지울 수 있는 유일한 파일 이름이다.
const INDEX_LOCK_NAME: &str = "index.lock";

#[derive(Default, Deserialize)]
#[serde(default, rename = "gitapi.gitLockRemoveReq")]
struct LockRemoveReq {
    repo: String,
    confirm: bool,
    #[serde(rename = "mtimeUnixMs")]
    mtime_unix_ms: i64,
}

/// Go `time.Time.UnixMilli` (1970 이전은 내림).
fn unix_milli(m: &std::fs::Metadata) -> i64 {
    let Ok(t) = m.modified() else { return 0 };
    match t.duration_since(UNIX_EPOCH) {
        Ok(d) => i64::try_from(d.as_millis()).unwrap_or(i64::MAX),
        Err(e) => {
            let d = e.duration();
            let ms = i64::try_from(d.as_millis()).unwrap_or(i64::MAX);
            if d.as_nanos() % 1_000_000 == 0 {
                -ms
            } else {
                -ms - 1
            }
        }
    }
}

impl GitServer {
    pub(crate) async fn api_git_lock_remove(&self, r: &mut Req) -> Response {
        let (mut t, req) = self.begin_write::<LockRemoveReq>(r).await;
        t.require_confirm(
            true,
            req.confirm,
            "index.lock 삭제는 confirm:true 를 요구한다 (FR-GIT-89)",
        );
        t.resolve(&req.repo).await;
        if t.stop() {
            return t.finish();
        }
        let git = t.git();
        let keys = match self.git_keys(&git, &t.ctx(), &t.root).await {
            Ok(k) => k,
            Err(e) => {
                t.reject(&e);
                return t.finish();
            }
        };
        let x = self.exclusion();
        let a = slots_answer(&x, &keys, &[SLOT_INDEX, SLOT_COMMON]);
        if !a.ok {
            t.reject_answer(&a, None);
            return t.finish();
        }
        let Some(_release) = x.try_lock_top(&keys.top) else {
            t.reject_with(
                StatusCode::CONFLICT,
                apierr::CODE_REPO_BUSY,
                "이 저장소에서 쓰기가 진행 중이다 — 끝난 뒤 다시 확인하라",
            );
            return t.finish();
        };
        let Some(lock_path) = self.git_index_lock_target(&mut t).await else {
            return t.finish();
        };
        let st = match std::fs::symlink_metadata(&lock_path) {
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                t.ok_plain(Some(&obj! {"removed" => false, "lockPath" => lock_path}));
                return t.finish();
            }
            Err(e) => {
                let msg = oserr::path_error("lstat", &lock_path, e).to_string();
                t.reject_with(StatusCode::INTERNAL_SERVER_ERROR, ERR_FAILED, &msg);
                return t.finish();
            }
            Ok(st) => st,
        };
        if !st.file_type().is_file() {
            t.reject_with(
                StatusCode::BAD_REQUEST,
                apierr::CODE_BAD_REQUEST,
                &format!("{lock_path} 는 일반 파일이 아니다"),
            );
            return t.finish();
        }
        let mtime = unix_milli(&st);
        if mtime != req.mtime_unix_ms {
            t.reject_body(
                StatusCode::CONFLICT,
                apierr::CODE_STALE_OBSERVATION,
                "확인한 뒤 lock 이 바뀌었다 — 다른 git 이 만든 새 lock 일 수 있다",
                Some(&obj! {"lock" => obj! {"path" => lock_path, "mtimeUnixMs" => mtime}}),
            );
            return t.finish();
        }
        if let Err(e) = std::fs::remove_file(&lock_path) {
            let msg = oserr::path_error("remove", &lock_path, e).to_string();
            t.reject_with(StatusCode::INTERNAL_SERVER_ERROR, ERR_FAILED, &msg);
            return t.finish();
        }
        let m = req.mtime_unix_ms;
        dm_shared_dmlog::infof!(
            r_rid(&t),
            "[git] 남은 index.lock 삭제: {lock_path} (mtime {m})"
        );
        git.invalidate(&t.root);
        t.ok_plain(Some(&obj! {"removed" => true, "lockPath" => lock_path}));
        t.finish()
    }

    /// 지울 lock 의 경로다. git 이 답한 경로가 이 저장소 gitdir·common-dir 바로 아래의
    /// `index.lock` 이 아니면 400 이다.
    async fn git_index_lock_target(&self, t: &mut GitWrite<'_>) -> Option<String> {
        let git = t.git();
        let svc = git.service();
        let lock_path = match svc.index_lock_path(&t.ctx(), &t.root).await {
            Ok(p) => p,
            Err(e) => {
                t.reject(&e);
                return None;
            }
        };
        let (git_dir, common_dir) = match svc.git_dirs(&t.ctx(), &t.root).await {
            Ok(v) => v,
            Err(e) => {
                t.reject(&e);
                return None;
            }
        };
        let parent = core::exclusion_key(&filepath::dir(&lock_path));
        let under =
            parent == core::exclusion_key(&git_dir) || parent == core::exclusion_key(&common_dir);
        if filepath::base(&lock_path) != INDEX_LOCK_NAME || !under {
            t.reject_with(
                StatusCode::BAD_REQUEST,
                apierr::CODE_BAD_REQUEST,
                &format!("{lock_path} 는 이 저장소의 index.lock 이 아니다"),
            );
            return None;
        }
        Some(lock_path)
    }
}

fn r_rid<'a>(t: &'a GitWrite<'_>) -> dm_shared_dmlog::ReqCtx<'a> {
    t.r.rid()
}
