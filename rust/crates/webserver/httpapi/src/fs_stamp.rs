//! 겹의 스탬프 (Go `handlers_fs_stamp.go`, NOTES_LIVE_EXPLORER_SRS 묶음 L·FR-OPT-4-2) — 디렉터리가
//! 바뀌었는지만 묻는다. 파일 내용만 바뀐 것은 겹의 mtime 을 움직이지 않는다.

use std::collections::BTreeMap;
use std::fs::Metadata;

use dm_shared_httpresp::Response;
use serde::{Deserialize, Serialize};

use crate::Server;
use crate::files_stamp::{FILE_STAMPS_MAX, mod_nano};
use crate::fs::{FS_ERR_BAD_REQUEST, fs_decode, fs_fail, fs_resolve_existing, fs_status};
use crate::httperr::write_json;
use crate::req::Req;

/// 한 요청이 볼 수 있는 디렉터리 수다.
pub(crate) const FS_STAMP_MAX: usize = 512;
/// `/api/fs/stamps` 한 요청의 루트 수다.
const FS_STAMPS_TREES_MAX: usize = 16;

#[derive(Deserialize, Default)]
#[serde(default, rename = "httpapi.fsStampReq")]
struct FsStampReq {
    root: String,
    dirs: Option<Vec<String>>,
}

#[derive(Deserialize, Default)]
#[serde(default, rename = "httpapi.fsStampsReq")]
struct FsStampsReq {
    trees: Option<Vec<FsStampReq>>,
    paths: Option<Vec<String>>,
}

#[derive(Serialize)]
struct StampsResp {
    stamps: BTreeMap<String, String>,
}

#[derive(Serialize)]
#[serde(untagged)]
enum Tree {
    Stamps { stamps: BTreeMap<String, String> },
    Denied { code: &'static str, status: u16 },
}

#[derive(Serialize)]
struct TreesResp {
    paths: BTreeMap<String, String>,
    trees: BTreeMap<String, Tree>,
}

/// Go `fsStampOf`: 문자열인 것은 JSON 의 수가 나노초의 정밀도를 잃기 때문이다. `apiFSList` 와
/// 폴링이 같은 함수를 지난다 (FR-FSL-10).
pub(crate) fn fs_stamp_of(st: &Metadata) -> String {
    mod_nano(st).to_string()
}

/// Go `fsStampsIn`: 풀리지 않거나 디렉터리가 아닌 것은 빠진다. 키는 보낸 경로 그대로다.
fn fs_stamps_in(root: &str, dirs: &[String]) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    for d in dirs {
        let Ok(target) = fs_resolve_existing(root, d) else {
            continue;
        };
        if let Ok(st) = std::fs::metadata(&target)
            && st.is_dir()
        {
            out.insert(d.clone(), fs_stamp_of(&st));
        }
    }
    out
}

impl Server {
    /// POST /api/fs/stamp (FR-FSL-1~9).
    pub(crate) async fn api_fs_stamp(&self, r: &mut Req) -> Response {
        let req: FsStampReq = match fs_decode(r).await {
            Ok(v) => v,
            Err(res) => return res,
        };
        let root = match self.fs_root(&req.root) {
            Ok(v) => v,
            Err(res) => return res,
        };
        let dirs = req.dirs.unwrap_or_default();
        if dirs.len() > FS_STAMP_MAX {
            return fs_fail(FS_ERR_BAD_REQUEST, "dirs 가 너무 많다");
        }
        write_json(&StampsResp {
            stamps: fs_stamps_in(&root, &dirs),
        })
    }

    /// POST /api/fs/stamps — 겹과 파일을 한 요청으로 묻는다 (FR-OPT-4-2). 루트마다의 판정은
    /// 본문에 싣는다 — 한 루트의 사정이 나머지를 막지 않는다.
    pub(crate) async fn api_fs_stamps(&self, r: &mut Req) -> Response {
        let req: FsStampsReq = match fs_decode(r).await {
            Ok(v) => v,
            Err(res) => return res,
        };
        let trees_req = req.trees.unwrap_or_default();
        if trees_req.len() > FS_STAMPS_TREES_MAX {
            return fs_fail(FS_ERR_BAD_REQUEST, "trees 가 너무 많다");
        }
        let paths = req.paths.unwrap_or_default();
        if paths.len() > FILE_STAMPS_MAX {
            return fs_fail(FS_ERR_BAD_REQUEST, "paths 가 너무 많다");
        }
        let mut trees = BTreeMap::new();
        for t in &trees_req {
            trees.insert(t.root.clone(), self.fs_stamps_tree(t));
        }
        write_json(&TreesResp {
            paths: self.file_stamps_in(&paths),
            trees,
        })
    }

    fn fs_stamps_tree(&self, t: &FsStampReq) -> Tree {
        let dirs = t.dirs.as_deref().unwrap_or_default();
        if dirs.len() > FS_STAMP_MAX {
            return denied(FS_ERR_BAD_REQUEST);
        }
        match self.fs_root_of(&t.root) {
            Ok(root) => Tree::Stamps {
                stamps: fs_stamps_in(&root, dirs),
            },
            Err(e) => denied(e.code),
        }
    }
}

fn denied(code: &'static str) -> Tree {
    Tree::Denied {
        code,
        status: fs_status(code).as_u16(),
    }
}
