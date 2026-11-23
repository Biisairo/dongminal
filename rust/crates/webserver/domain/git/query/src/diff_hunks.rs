//! 부분 스테이징용 hunk (FR-GIT-278).

use dm_gocompat::strconv::quote;
use dm_webserver_domain_git_core::{Ctx, Service};
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::diff::{AXIS_INDEX_HEAD, AXIS_WORKTREE_INDEX, DIFF_MAX_BYTES, diff_rel_path};
use crate::error::{Error, QueryKind, nil_if_empty};

pub const HUNK_CONTEXT: usize = 3;
pub const HUNK_CONTEXT_MARK: u8 = b' ';
pub const HUNK_ADD_MARK: u8 = b'+';
pub const HUNK_DEL_MARK: u8 = b'-';
pub const HUNK_NO_NEWLINE: u8 = b'\\';

const HUNK_HEAD_MARK: &str = "@@";
const HUNK_BINARY_MARK: &str = "Binary files";

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct Hunk {
    pub index: i64,
    pub header: String,
    #[serde(rename = "oldStart")]
    pub old_start: i64,
    #[serde(rename = "oldLines")]
    pub old_lines: i64,
    #[serde(rename = "newStart")]
    pub new_start: i64,
    #[serde(rename = "newLines")]
    pub new_lines: i64,
    #[serde(serialize_with = "nil_if_empty")]
    pub lines: Vec<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct FileDiff {
    pub repo: String,
    pub axis: String,
    pub path: String,
    #[serde(rename = "diffId")]
    pub diff_id: String,
    #[serde(skip)]
    pub preamble: Vec<String>,
    #[serde(serialize_with = "nil_if_empty")]
    pub hunks: Vec<Hunk>,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub note: String,
}

/// 파일 하나의 hunk 목록이다.
pub async fn hunks_of(
    s: &Service,
    ctx: &Ctx,
    repo: &str,
    axis: &str,
    p: &str,
) -> Result<FileDiff, Error> {
    if axis != AXIS_WORKTREE_INDEX && axis != AXIS_INDEX_HEAD {
        return Err(Error::new(
            QueryKind::DiffAxis,
            format!("{} 축에는 부분 스테이징이 없다", quote(axis)),
        ));
    }
    let rel = diff_rel_path(p)?;
    let mut argv: Vec<String> = [
        "diff",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "--src-prefix=a/",
        "--dst-prefix=b/",
    ]
    .map(String::from)
    .to_vec();
    argv.push(format!("-U{HUNK_CONTEXT}"));
    if axis == AXIS_INDEX_HEAD {
        argv.push("--cached".into());
    }
    argv.extend(["--".into(), rel.clone()]);
    let ds = s.sized(dm_shared_editorlimit::patch_diff_max_bytes(DIFF_MAX_BYTES) as usize);
    let out = ds.exec(ctx, repo, &argv).await?;
    if out.stdout_truncated {
        return Err(Error::new(
            QueryKind::DiffTruncated,
            format!(
                "{rel} 의 diff 가 상한({}MiB)에서 잘렸다",
                ds.max_output() >> 20
            ),
        ));
    }
    let body = out.stdout_str();
    let mut fd = FileDiff {
        repo: repo.into(),
        axis: axis.into(),
        path: rel.clone(),
        diff_id: hunk_diff_id(axis, &rel, &out.stdout),
        ..FileDiff::default()
    };
    (fd.preamble, fd.hunks) = parse_hunks(&body);
    if fd.hunks.is_empty() {
        fd.note = hunk_empty_note(&body);
    }
    Ok(fd)
}

fn hunk_diff_id(axis: &str, rel: &str, body: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(axis.as_bytes());
    h.update([0]);
    h.update(rel.as_bytes());
    h.update([0]);
    h.update(body);
    hex::encode(h.finalize())
}

fn hunk_empty_note(body: &str) -> String {
    if body.contains(HUNK_BINARY_MARK) {
        return "바이너리 파일입니다 — 부분 스테이징을 할 수 없습니다".into();
    }
    if body.trim().is_empty() {
        return String::new();
    }
    "이 축에 적용할 수 있는 조각이 없습니다".into()
}

/// unified diff 를 머리말과 hunk 로 나눈다.
pub fn parse_hunks(body: &str) -> (Vec<String>, Vec<Hunk>) {
    let mut lines: Vec<&str> = body.split('\n').collect();
    if lines.last() == Some(&"") {
        lines.pop();
    }
    let mut preamble = Vec::new();
    let mut hunks: Vec<Hunk> = Vec::new();
    let mut cur: Option<usize> = None;
    for l in lines {
        if l.starts_with(HUNK_HEAD_MARK) {
            cur = parse_hunk_head(l).map(|mut h| {
                h.index = hunks.len() as i64;
                hunks.push(h);
                hunks.len() - 1
            });
            continue;
        }
        let Some(c) = cur else {
            preamble.push(l.to_owned());
            continue;
        };
        if l.is_empty() || !hunk_body_mark(l.as_bytes()[0]) {
            cur = None;
            continue;
        }
        hunks[c].lines.push(l.to_owned());
    }
    (preamble, hunks)
}

fn hunk_body_mark(c: u8) -> bool {
    matches!(
        c,
        HUNK_CONTEXT_MARK | HUNK_ADD_MARK | HUNK_DEL_MARK | HUNK_NO_NEWLINE
    )
}

fn parse_hunk_head(l: &str) -> Option<Hunk> {
    let after = &l[HUNK_HEAD_MARK.len()..];
    let end = after.find(HUNK_HEAD_MARK)?;
    let spec: Vec<&str> = after[..end].split_whitespace().collect();
    if spec.len() != 2
        || spec[0].as_bytes()[0] != HUNK_DEL_MARK
        || spec[1].as_bytes()[0] != HUNK_ADD_MARK
    {
        return None;
    }
    let (old_start, old_lines) = parse_hunk_range(&spec[0][1..])?;
    let (new_start, new_lines) = parse_hunk_range(&spec[1][1..])?;
    Some(Hunk {
        header: l.to_owned(),
        old_start,
        old_lines,
        new_start,
        new_lines,
        ..Hunk::default()
    })
}

fn parse_hunk_range(s: &str) -> Option<(i64, i64)> {
    let (start, count) = match s.split_once(',') {
        Some((a, b)) => (a, crate::status::atoi(b)?),
        None => (s, 1),
    };
    Some((crate::status::atoi(start)?, count))
}
