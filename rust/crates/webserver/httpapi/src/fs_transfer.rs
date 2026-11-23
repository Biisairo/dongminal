//! 탐색기 전송의 자리 판정 (Go `handlers_fs_transfer.go` 의 일부). `/api/fs/{download,upload}`
//! 종단은 5.5.7 이 옮긴다. 터미널 업로드(`/api/upload`)도 같은 함수로 자리를 정한다 (FR-TFD-30).

use std::path::MAIN_SEPARATOR;

use dm_gocompat::filepath;

use crate::fs::{
    FS_ERR_BAD_REQUEST, FS_ERR_NOT_FOUND, FsError, fs_from_io, fs_resolve_err, fs_under_root,
};

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
    mkdir_all(&parent).map_err(|e| fs_from_io(&e))?;
    Ok(target)
}

/// Go `os.MkdirAll(p, 0o755)`.
fn mkdir_all(p: &str) -> std::io::Result<()> {
    let mut b = std::fs::DirBuilder::new();
    b.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        b.mode(0o755);
    }
    b.create(p)
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
