//! 파일 하나의 양쪽 내용 (FR-GIT-40~48). 편집기 diff 뷰가 쓴다.

use otter_gocompat::{filepath, strconv::quote};
use otter_webserver_domain_git_core::{self as core, Ctx, Service, plain_exit};
use serde::Serialize;

use crate::error::{Error, QueryKind};
use crate::log::check_rev;

pub const AXIS_WORKTREE_INDEX: &str = "worktree-index";
pub const AXIS_INDEX_HEAD: &str = "index-head";
pub const AXIS_WORKTREE_HEAD: &str = "worktree-head";
pub const AXIS_COMMIT_PARENT: &str = "commit-parent";

pub const DIFF_KIND_TEXT: &str = "text";
pub const DIFF_KIND_ABSENT: &str = "absent";
pub const DIFF_KIND_BINARY: &str = "binary";
pub const DIFF_KIND_LFS: &str = "lfs";
pub const DIFF_KIND_TOO_LARGE: &str = "too_large";
pub const DIFF_KIND_SUBMODULE: &str = "submodule";

const GITLINK_MODE: &str = "160000";

pub const DIFF_MAX_BYTES: i64 = otter_shared_editorlimit::FILE_MAX_BYTES;
pub const LFS_MAX_POINTER_BYTES: i64 = 1024;

pub(crate) const INDEX_REV_PREFIX: &str = ":";
pub(crate) const HEAD_REV_PREFIX: &str = "HEAD:";
const LFS_PREFIX: &str = "version https://git-lfs.github.com/spec/";
const LFS_OID_FIELD: &str = "oid sha256:";
const LFS_SIZE_FIELD: &str = "size ";

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct DiffSide {
    pub kind: String,
    /// kind 가 text 일 때만 채운다.
    pub content: String,
    pub size: i64,
    #[serde(rename = "lfsOid", skip_serializing_if = "String::is_empty")]
    pub lfs_oid: String,
    #[serde(rename = "lfsSize", skip_serializing_if = "crate::status::is_zero")]
    pub lfs_size: i64,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub oid: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub encoding: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decodable: Option<bool>,
    /// 원문 바이트. 인코딩을 바꿔 다시 읽을 때 쓴다.
    #[serde(skip)]
    pub(crate) body: Vec<u8>,
}

impl DiffSide {
    fn kind(kind: &str) -> Self {
        DiffSide {
            kind: kind.to_owned(),
            ..DiffSide::default()
        }
    }

    fn decode_as(&mut self, enc: &str) {
        let ok = self.kind == DIFF_KIND_TEXT
            || (self.kind == DIFF_KIND_BINARY && otter_shared_textenc::has_utf16_bom(&self.body));
        if !ok {
            return;
        }
        let d = otter_shared_textenc::decode_as(&self.body, enc)
            .unwrap_or_else(|| otter_shared_textenc::detect(&self.body));
        self.kind = DIFF_KIND_TEXT.to_owned();
        self.content = d.text;
        self.encoding = d.enc.to_owned();
        self.decodable = Some(d.decodable);
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct DiffContent {
    pub repo: String,
    pub axis: String,
    pub path: String,
    #[serde(rename = "origPath")]
    pub orig_path: String,
    #[serde(rename = "imageMime", skip_serializing_if = "String::is_empty")]
    pub image_mime: String,
    pub original: DiffSide,
    pub modified: DiffSide,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub note: String,
}

impl DiffContent {
    /// 양쪽을 enc 로 다시 읽는다 (인코딩 바꿔 열기).
    pub fn decode_as(&mut self, enc: &str) {
        self.original.decode_as(enc);
        self.modified.decode_as(enc);
        self.note = diff_note(&self.original, &self.modified);
    }
}

pub(crate) fn diff_rel_path(p: &str) -> Result<String, Error> {
    core::rel_path_detail(p).map_err(|d| Error::new(QueryKind::DiffPath, d))
}

pub(crate) fn diff_rel_pair(p: &str, orig: &str) -> Result<(String, String), Error> {
    let rel = diff_rel_path(p)?;
    let orig_rel = if orig.is_empty() {
        rel.clone()
    } else {
        diff_rel_path(orig)?
    };
    Ok((rel, orig_rel))
}

fn valid_axis(axis: &str) -> bool {
    matches!(
        axis,
        AXIS_WORKTREE_INDEX | AXIS_INDEX_HEAD | AXIS_WORKTREE_HEAD
    )
}

/// 축(axis)의 양쪽 내용이다.
pub async fn diff_content_of(
    s: &Service,
    ctx: &Ctx,
    repo: &str,
    axis: &str,
    p: &str,
    orig_path: &str,
) -> Result<DiffContent, Error> {
    if !valid_axis(axis) {
        return Err(Error::new(QueryKind::DiffAxis, quote(axis)));
    }
    let (rel, orig_rel) = diff_rel_pair(p, orig_path)?;
    let mut dc = DiffContent {
        repo: repo.into(),
        axis: axis.into(),
        path: rel.clone(),
        orig_path: orig_rel.clone(),
        ..DiffContent::default()
    };
    let prefix = if axis == AXIS_WORKTREE_INDEX {
        INDEX_REV_PREFIX
    } else {
        HEAD_REV_PREFIX
    };
    dc.original = diff_blob_side(s, ctx, repo, &format!("{prefix}{orig_rel}")).await?;
    dc.modified = if axis == AXIS_INDEX_HEAD {
        diff_blob_side(s, ctx, repo, &format!("{INDEX_REV_PREFIX}{rel}")).await?
    } else {
        diff_worktree_side(repo, &rel)?
    };
    if axis != AXIS_INDEX_HEAD
        && dc.original.kind == DIFF_KIND_SUBMODULE
        && dc.modified.kind == DIFF_KIND_ABSENT
        && worktree_is_dir(repo, &rel)
    {
        dc.modified = DiffSide::kind(DIFF_KIND_SUBMODULE);
    }
    if dc.original.kind == DIFF_KIND_ABSENT && dc.modified.kind == DIFF_KIND_ABSENT {
        return Err(Error::new(
            QueryKind::DiffBothAbsent,
            format!("{repo} 의 {axis} 축 양쪽에 {} 가 없다", quote(&rel)),
        ));
    }
    dc.note = diff_note(&dc.original, &dc.modified);
    Ok(dc)
}

/// 커밋과 그 부모 사이의 파일 하나다 (FR-GIT-138).
#[allow(clippy::too_many_arguments)]
pub async fn diff_commit(
    s: &Service,
    ctx: &Ctx,
    repo: &str,
    oid: &str,
    parent_oid: &str,
    p: &str,
    orig_path: &str,
) -> Result<DiffContent, Error> {
    if oid.trim().is_empty() {
        return Err(Error::new(QueryKind::UnsafeRev, "oid 가 비었다"));
    }
    check_rev("oid", oid)?;
    if !parent_oid.is_empty() {
        check_rev("parentOid", parent_oid)?;
    }
    let (rel, orig_rel) = diff_rel_pair(p, orig_path)?;
    let mut dc = DiffContent {
        repo: repo.into(),
        axis: AXIS_COMMIT_PARENT.into(),
        path: rel.clone(),
        orig_path: orig_rel.clone(),
        ..DiffContent::default()
    };
    dc.original = if parent_oid.is_empty() {
        DiffSide::kind(DIFF_KIND_ABSENT)
    } else {
        diff_blob_side(s, ctx, repo, &format!("{parent_oid}:{orig_rel}")).await?
    };
    dc.modified = diff_blob_side(s, ctx, repo, &format!("{oid}:{rel}")).await?;
    if dc.original.kind == DIFF_KIND_ABSENT && dc.modified.kind == DIFF_KIND_ABSENT {
        return Err(Error::new(
            QueryKind::DiffBothAbsent,
            format!(
                "{repo} 의 {parent_oid}..{oid} 양쪽에 {} 가 없다",
                quote(&rel)
            ),
        ));
    }
    dc.note = diff_note(&dc.original, &dc.modified);
    Ok(dc)
}

async fn diff_blob_side(s: &Service, ctx: &Ctx, repo: &str, rev: &str) -> Result<DiffSide, Error> {
    let out = match s.exec(ctx, repo, &["cat-file", "-s", rev]).await {
        Ok(o) => o,
        Err(e) => {
            if diff_absent(&e) {
                return Ok(DiffSide::kind(DIFF_KIND_ABSENT));
            }
            if let Some(sub) = gitlink_side(s, ctx, repo, rev).await {
                return Ok(sub);
            }
            return Err(e.into());
        }
    };
    let text = out.stdout_str();
    let Ok(size) = text.trim().parse::<i64>() else {
        return Err(Error::other(format!(
            "cat-file -s {rev} 가 크기를 주지 않았다: {}",
            quote(&text)
        )));
    };
    if size > DIFF_MAX_BYTES {
        return Ok(DiffSide {
            size,
            ..DiffSide::kind(DIFF_KIND_TOO_LARGE)
        });
    }
    let body = s.exec(ctx, repo, &["show", rev]).await?;
    if body.stdout_truncated {
        return Ok(DiffSide {
            size,
            ..DiffSide::kind(DIFF_KIND_TOO_LARGE)
        });
    }
    Ok(diff_side_from_body(body.stdout, size))
}

async fn gitlink_side(s: &Service, ctx: &Ctx, repo: &str, rev: &str) -> Option<DiffSide> {
    let (treeish, p) = rev.split_once(':').unwrap_or((rev, ""));
    let out = if treeish.is_empty() {
        s.exec(ctx, repo, &["ls-files", "-s", "--", p]).await
    } else {
        s.exec(ctx, repo, &["ls-tree", treeish, "--", p]).await
    }
    .ok()?;
    let text = out.stdout_str();
    let meta = text.trim().split('\t').next().unwrap_or("");
    let f: Vec<&str> = meta.split_whitespace().collect();
    if f.len() < 3 || f[0] != GITLINK_MODE {
        return None;
    }
    let oid = if treeish.is_empty() { f[1] } else { f[2] };
    Some(DiffSide {
        oid: oid.to_owned(),
        ..DiffSide::kind(DIFF_KIND_SUBMODULE)
    })
}

fn worktree_is_dir(repo: &str, rel: &str) -> bool {
    std::fs::symlink_metadata(filepath::join(&[repo, rel])).is_ok_and(|m| m.is_dir())
}

fn diff_worktree_side(repo: &str, rel: &str) -> Result<DiffSide, Error> {
    let abs = diff_worktree_abs(repo, rel)?;
    let m = match std::fs::symlink_metadata(&abs) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(DiffSide::kind(DIFF_KIND_ABSENT));
        }
        Err(e) => return Err(Error::io("lstat", &abs, e)),
    };
    if m.file_type().is_symlink() {
        let link = std::fs::read_link(&abs).map_err(|e| Error::io("readlink", &abs, e))?;
        let link = link.to_string_lossy().into_owned();
        return Ok(DiffSide {
            size: link.len() as i64,
            content: link,
            ..DiffSide::kind(DIFF_KIND_TEXT)
        });
    }
    if m.is_dir() {
        return Ok(DiffSide::kind(DIFF_KIND_ABSENT));
    }
    if m.len() as i64 > DIFF_MAX_BYTES {
        return Ok(DiffSide {
            size: m.len() as i64,
            ..DiffSide::kind(DIFF_KIND_TOO_LARGE)
        });
    }
    let body = std::fs::read(&abs).map_err(|e| Error::io("open", &abs, e))?;
    let size = body.len() as i64;
    Ok(diff_side_from_body(body, size))
}

/// 리포 안의 작업 트리 경로다. 심링크로 리포 밖을 가리키면 거부한다.
pub(crate) fn diff_worktree_abs(repo: &str, rel: &str) -> Result<String, Error> {
    let root = filepath::eval_symlinks(repo).unwrap_or_else(|_| repo.to_owned());
    let abs = filepath::join(&[repo, rel]);
    let target = filepath::join(&[
        eval_existing(&filepath::dir(&abs)).as_str(),
        filepath::base(&abs).as_str(),
    ]);
    if target != root && !target.starts_with(&format!("{root}{}", filepath::SEPARATOR)) {
        return Err(Error::new(
            QueryKind::DiffPath,
            format!("{} 가 리포 밖({target})을 가리킨다", quote(rel)),
        ));
    }
    Ok(abs)
}

fn eval_existing(abs: &str) -> String {
    let mut rest = String::new();
    let mut p = abs.to_owned();
    loop {
        if let Ok(resolved) = filepath::eval_symlinks(&p) {
            return filepath::join(&[resolved.as_str(), rest.as_str()]);
        }
        let parent = filepath::dir(&p);
        if parent == p {
            return filepath::join(&[p.as_str(), rest.as_str()]);
        }
        rest = filepath::join(&[filepath::base(&p).as_str(), rest.as_str()]);
        p = parent;
    }
}

fn diff_side_from_body(body: Vec<u8>, size: i64) -> DiffSide {
    if size <= LFS_MAX_POINTER_BYTES && body.starts_with(LFS_PREFIX.as_bytes()) {
        let (oid, lfs_size) = parse_lfs_pointer(&String::from_utf8_lossy(&body));
        return DiffSide {
            size,
            lfs_oid: oid,
            lfs_size,
            ..DiffSide::kind(DIFF_KIND_LFS)
        };
    }
    if has_nul(&body) {
        return DiffSide {
            size,
            body,
            ..DiffSide::kind(DIFF_KIND_BINARY)
        };
    }
    DiffSide {
        content: String::from_utf8_lossy(&body).into_owned(),
        size,
        body,
        ..DiffSide::kind(DIFF_KIND_TEXT)
    }
}

fn has_nul(body: &[u8]) -> bool {
    let n = body.len().min(otter_shared_editorlimit::BINARY_SNIFF_BYTES);
    body[..n].contains(&0)
}

fn parse_lfs_pointer(body: &str) -> (String, i64) {
    let (mut oid, mut size) = (String::new(), 0);
    for line in body.split('\n') {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix(LFS_OID_FIELD) {
            oid = rest.to_owned();
        } else if let Some(rest) = line.strip_prefix(LFS_SIZE_FIELD)
            && let Ok(n) = rest.parse::<i64>()
        {
            size = n;
        }
    }
    (oid, size)
}

const DIFF_ABSENT_STDERR: [&str; 4] = [
    "does not exist in '",
    "does not exist (neither on disk nor in",
    "exists on disk, but not in",
    "invalid object name 'head'",
];

pub(crate) fn diff_absent(err: &core::Error) -> bool {
    let Some(xe) = plain_exit(err) else {
        return false;
    };
    let low = xe.stderr.to_lowercase();
    DIFF_ABSENT_STDERR.iter().any(|p| low.contains(p))
}

fn diff_note(orig: &DiffSide, modified: &DiffSide) -> String {
    for kind in [orig.kind.as_str(), modified.kind.as_str()] {
        match kind {
            DIFF_KIND_TOO_LARGE => {
                return format!(
                    "파일이 상한({}MiB)을 넘습니다 — 본문을 표시하지 않습니다",
                    DIFF_MAX_BYTES >> 20
                );
            }
            DIFF_KIND_LFS => {
                return "Git LFS 포인터입니다 — 실제 내용은 받아오지 않았습니다".into();
            }
            DIFF_KIND_BINARY => return "바이너리 파일입니다 — 본문을 표시하지 않습니다".into(),
            DIFF_KIND_SUBMODULE => return "서브모듈입니다 — 가리키는 커밋이 바뀌었습니다".into(),
            _ => {}
        }
    }
    if orig.kind == DIFF_KIND_ABSENT {
        return "새로 추가된 파일입니다 — 이전 내용이 없습니다".into();
    }
    if modified.kind == DIFF_KIND_ABSENT {
        return "삭제된 파일입니다 — 현재 내용이 없습니다".into();
    }
    String::new()
}
