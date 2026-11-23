//! 이미지 diff 의 양쪽 바이트 (FR-GIT-49).

use std::io::Read;

use dm_gocompat::strconv::quote;
use dm_webserver_domain_git_core::{Ctx, Service};

use crate::diff::{
    AXIS_COMMIT_PARENT, AXIS_INDEX_HEAD, AXIS_WORKTREE_HEAD, AXIS_WORKTREE_INDEX, HEAD_REV_PREFIX,
    INDEX_REV_PREFIX, diff_absent, diff_rel_pair, diff_worktree_abs,
};
use crate::error::{Error, QueryKind};
use crate::log::check_rev;

pub const DIFF_SIDE_ORIGINAL: &str = "original";
pub const DIFF_SIDE_MODIFIED: &str = "modified";

const IMAGE_SNIFF_BYTES: usize = 512;

/// 한쪽의 rev 다. 빈 값이면 작업 트리다.
fn side_rev(
    axis: &str,
    side: &str,
    rel: &str,
    orig_rel: &str,
    oid: &str,
    parent_oid: &str,
) -> Result<String, Error> {
    if side != DIFF_SIDE_ORIGINAL && side != DIFF_SIDE_MODIFIED {
        return Err(Error::new(QueryKind::DiffSide, quote(side)));
    }
    let original = side == DIFF_SIDE_ORIGINAL;
    match axis {
        AXIS_WORKTREE_INDEX if original => Ok(format!("{INDEX_REV_PREFIX}{orig_rel}")),
        AXIS_WORKTREE_INDEX | AXIS_WORKTREE_HEAD if !original => Ok(String::new()),
        AXIS_WORKTREE_HEAD | AXIS_INDEX_HEAD if original => {
            Ok(format!("{HEAD_REV_PREFIX}{orig_rel}"))
        }
        AXIS_INDEX_HEAD => Ok(format!("{INDEX_REV_PREFIX}{rel}")),
        AXIS_COMMIT_PARENT if original => {
            if parent_oid.trim().is_empty() {
                return Err(Error::bare(QueryKind::DiffBothAbsent));
            }
            check_rev("parentOid", parent_oid)?;
            Ok(format!("{parent_oid}:{orig_rel}"))
        }
        AXIS_COMMIT_PARENT => {
            if oid.trim().is_empty() {
                return Err(Error::new(QueryKind::UnsafeRev, "oid 가 비었다"));
            }
            check_rev("oid", oid)?;
            Ok(format!("{oid}:{rel}"))
        }
        _ => Err(Error::new(QueryKind::DiffAxis, quote(axis))),
    }
}

/// 이미지 diff 한쪽의 바이트다. 상한은 img 의 출력 상한이다.
#[allow(clippy::too_many_arguments)]
pub async fn side_bytes(
    img: &Service,
    ctx: &Ctx,
    repo: &str,
    axis: &str,
    p: &str,
    orig_path: &str,
    oid: &str,
    parent_oid: &str,
    side: &str,
) -> Result<Vec<u8>, Error> {
    let (rel, orig_rel) = diff_rel_pair(p, orig_path)?;
    let rev = side_rev(axis, side, &rel, &orig_rel, oid, parent_oid)?;
    if rev.is_empty() {
        return worktree_bytes(repo, &rel, img.max_output(), 0);
    }
    let out = match img.exec(ctx, repo, &["show", rev.as_str()]).await {
        Ok(o) => o,
        Err(e) if diff_absent(&e) => return Err(Error::bare(QueryKind::DiffBothAbsent)),
        Err(e) => return Err(e.into()),
    };
    if out.stdout_truncated {
        return Err(Error::bare(QueryKind::DiffTooLarge));
    }
    Ok(out.stdout)
}

/// 작업 트리 쪽 바이트다. head 가 0 이 아니면 앞 head 바이트만 읽는다.
fn worktree_bytes(repo: &str, rel: &str, limit: usize, head: usize) -> Result<Vec<u8>, Error> {
    let abs = diff_worktree_abs(repo, rel)?;
    let m = match std::fs::symlink_metadata(&abs) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(Error::bare(QueryKind::DiffBothAbsent));
        }
        Err(e) => return Err(Error::io("lstat", &abs, e)),
    };
    if m.file_type().is_symlink() {
        let link = std::fs::read_link(&abs).map_err(|e| Error::io("readlink", &abs, e))?;
        return Ok(link.to_string_lossy().into_owned().into_bytes());
    }
    if m.is_dir() {
        return Err(Error::bare(QueryKind::DiffBothAbsent));
    }
    if head > 0 {
        let f = std::fs::File::open(&abs).map_err(|e| Error::io("open", &abs, e))?;
        let mut buf = Vec::with_capacity(head);
        f.take(head as u64)
            .read_to_end(&mut buf)
            .map_err(|e| Error::io("read", &abs, e))?;
        return Ok(buf);
    }
    if m.len() > limit as u64 {
        return Err(Error::bare(QueryKind::DiffTooLarge));
    }
    std::fs::read(&abs).map_err(|e| Error::io("open", &abs, e))
}

/// 이미지 MIME 이다. 바뀐 쪽을 먼저, 없으면 원래 쪽을 본다. 이미지가 아니면 빈 문자열이다.
#[allow(clippy::too_many_arguments)]
pub async fn image_mime_of(
    img: &Service,
    ctx: &Ctx,
    repo: &str,
    axis: &str,
    p: &str,
    orig_path: &str,
    oid: &str,
    parent_oid: &str,
) -> String {
    for side in [DIFF_SIDE_MODIFIED, DIFF_SIDE_ORIGINAL] {
        let Ok(b) = sniff_side(img, ctx, repo, axis, p, orig_path, oid, parent_oid, side).await
        else {
            continue;
        };
        let m = dm_shared_mimeprobe::image_mime(&b);
        if !m.is_empty() {
            return m.to_owned();
        }
    }
    String::new()
}

#[allow(clippy::too_many_arguments)]
async fn sniff_side(
    img: &Service,
    ctx: &Ctx,
    repo: &str,
    axis: &str,
    p: &str,
    orig_path: &str,
    oid: &str,
    parent_oid: &str,
    side: &str,
) -> Result<Vec<u8>, Error> {
    let (rel, orig_rel) = diff_rel_pair(p, orig_path)?;
    let rev = side_rev(axis, side, &rel, &orig_rel, oid, parent_oid)?;
    if rev.is_empty() {
        return worktree_bytes(repo, &rel, img.max_output(), IMAGE_SNIFF_BYTES);
    }
    side_bytes(img, ctx, repo, axis, p, orig_path, oid, parent_oid, side).await
}
