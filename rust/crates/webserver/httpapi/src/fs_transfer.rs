//! 탐색기의 전송 (Go `handlers_fs_transfer.go`, FILE_TRANSFER_SRS FR-FTR-12·15·16). 터미널의
//! `/api/{upload,download}` 와 같은 일을 하되 root 가드를 받는다. 같은 이름이 있으면 거부한다(D-3).
//! 터미널 업로드도 `fs_upload_target` 으로 자리를 정한다 (FR-TFD-30).

use std::path::MAIN_SEPARATOR;

use otter_gocompat::{filepath, oserr};

use otter_shared_httpresp::Response;
use serde::Serialize;

use crate::Server;
use crate::files::Fail;
use crate::files_transfer::serve_download;
use crate::fs::{
    FS_ERR_BAD_REQUEST, FS_ERR_NOT_FOUND, FsError, fs_fail_err, fs_from_io, fs_resolve_err,
    fs_resolve_existing, fs_under_root,
};
use crate::httperr::write_json;
use crate::multipart::Form;
use crate::req::Req;

/// 업로드 중간 디렉터리의 권한 (Go `os.MkdirAll(parent, 0o755)`).
const UPLOAD_DIR_PERM: u32 = 0o755;

#[derive(Serialize)]
struct UploadResp {
    name: String,
    ok: bool,
    path: String,
    size: u64,
}

impl Server {
    /// GET /api/fs/download?root=<abs>&path=<abs> (FR-FTR-12). 링크는 따라간다.
    pub(crate) async fn api_fs_download(&self, r: &mut Req) -> Response {
        let root = match self.fs_root(&r.q("root")) {
            Ok(v) => v,
            Err(res) => return res,
        };
        match fs_resolve_existing(&root, &r.q("path")) {
            Ok(target) => serve_download(&target, Fail::Json).await,
            Err(e) => fs_fail_err(&e),
        }
    }

    /// POST /api/fs/upload?root=<abs>&dir=<abs> (FR-FTR-15·16, FR-ETR-17).
    pub(crate) async fn api_fs_upload(&self, r: &mut Req) -> Response {
        let root = match self.fs_root(&r.q("root")) {
            Ok(v) => v,
            Err(res) => return res,
        };
        let dir = match fs_resolve_existing(&root, &r.q("dir")) {
            Ok(v) => v,
            Err(e) => return fs_fail_err(&e),
        };
        let sep = MAIN_SEPARATOR.to_string();
        let pick = |d: &str, n: &str, form: &Form| -> Result<String, FsError> {
            if n.is_empty() || n == "." || n == sep {
                return Err(FsError::new(FS_ERR_BAD_REQUEST, "파일 이름이 없다"));
            }
            fs_upload_target(&root, d, &form.value("relPath"), n)
        };
        match self.upload_into(r, &dir, &pick, Fail::Json).await {
            Ok((out, size)) => write_json(&UploadResp {
                name: filepath::base(&out),
                ok: true,
                path: out,
                size,
            }),
            Err(res) => res,
        }
    }
}

/// Go `fsUploadTarget`: 업로드가 놓일 자리다 (FR-ETR-17·18·19). `rel` 이 있으면 대상 아래의
/// 상대경로이며 중간 디렉터리를 만든다. 경계 판정은 문자열·합친 경로·실재하는 조상 세 번이다.
pub(crate) fn fs_upload_target(
    root: &str,
    dir: &str,
    rel: &str,
    name: &str,
) -> Result<String, FsError> {
    if rel.is_empty() {
        return fs_under_root(root, &filepath::join(&[dir, name]));
    }
    // 브라우저는 언제나 `/` 로 준다 (webkitRelativePath).
    let cleaned = filepath::clean(&filepath::from_slash(rel));
    let sep = MAIN_SEPARATOR.to_string();
    if filepath::is_abs(&cleaned)
        || !filepath::volume_name(&cleaned).is_empty()
        || cleaned.starts_with(&sep)
        || rel.starts_with('/')
    {
        return Err(FsError::new(
            FS_ERR_BAD_REQUEST,
            "relPath 는 상대경로여야 한다",
        ));
    }
    if cleaned == "." || cleaned == ".." || cleaned.starts_with(&format!("..{sep}")) {
        return Err(FsError::new(
            FS_ERR_BAD_REQUEST,
            "relPath 가 대상 밖을 가리킨다",
        ));
    }
    let target = fs_under_root(root, &filepath::join(&[dir, cleaned.as_str()]))?;
    let parent = filepath::dir(&target);
    fs_existing_ancestor_under_root(root, &parent)?;
    // FR-ETR-19·20: 중간 디렉터리는 만든다. 충돌 판정은 마지막 조각의 O_EXCL 이 한다.
    oserr::mkdir_all(&parent, UPLOAD_DIR_PERM).map_err(|e| fs_from_io(&e))?;
    Ok(target)
}

/// Go `fsExistingAncestorUnderRoot`: 실재하는 가장 깊은 조상을 풀어 루트 아래인지 본다.
fn fs_existing_ancestor_under_root(root: &str, dir: &str) -> Result<(), FsError> {
    let mut p = dir.to_owned();
    loop {
        if std::fs::symlink_metadata(&p).is_ok() {
            break;
        }
        let up = filepath::dir(&p);
        if up == p {
            return Err(FsError::new(FS_ERR_NOT_FOUND, "대상의 조상을 찾을 수 없다"));
        }
        p = up;
    }
    let resolved = filepath::eval_symlinks(&p).map_err(|e| fs_resolve_err(&e))?;
    fs_under_root(root, &resolved).map(|_| ())
}
