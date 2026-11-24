//! status 조회 (FR-GIT-13~36). porcelain v2 `-z` 를 파싱한다.

use std::collections::{BTreeMap, HashSet};

use otter_gocompat::strconv::quote;
use otter_webserver_domain_git_core::{Ctx, Service};
use serde::Serialize;

use crate::error::{Error, nil_if_empty};
use crate::operation::Operation;

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct FileEntry {
    pub path: String,
    /// rename/copy 원본 (FR-GIT-36).
    #[serde(rename = "origPath", skip_serializing_if = "String::is_empty")]
    pub orig_path: String,
    /// 2문자. '.' 는 변화 없음.
    pub xy: String,
    pub staged: bool,
    pub unstaged: bool,
    pub conflict: bool,
    pub untracked: bool,
    #[serde(skip_serializing_if = "is_zero")]
    pub score: i64,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub sub: String,
    #[serde(skip_serializing_if = "is_false")]
    pub dir: bool,
}

pub(crate) fn is_zero(n: &i64) -> bool {
    *n == 0
}

pub(crate) fn is_false(b: &bool) -> bool {
    !*b
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct Status {
    pub repo: String,
    pub oid: String,
    pub branch: String,
    pub detached: bool,
    pub initial: bool,
    pub upstream: String,
    #[serde(rename = "hasUpstream")]
    pub has_upstream: bool,
    pub ahead: i64,
    pub behind: i64,
    #[serde(serialize_with = "nil_if_empty")]
    pub staged: Vec<FileEntry>,
    #[serde(serialize_with = "nil_if_empty")]
    pub changes: Vec<FileEntry>,
    #[serde(serialize_with = "nil_if_empty")]
    pub untracked: Vec<FileEntry>,
    #[serde(serialize_with = "nil_if_empty")]
    pub conflicts: Vec<FileEntry>,
    /// 서로 다른 경로의 개수 (FR-GIT-14).
    pub total: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub truncated: Option<BTreeMap<String, i64>>,
    #[serde(rename = "outputTruncated", skip_serializing_if = "is_false")]
    pub output_truncated: bool,
    pub operation: Operation,
}

const STATUS_INITIAL_OID: &str = "(initial)";
const STATUS_DETACHED: &str = "(detached)";
const STATUS_NO_CHANGE: u8 = b'.';
const STATUS_SUB_NONE: &str = "N...";
const STATUS_SUB_IS_SUB: &str = "S";
const STATUS_SUB_COMMIT: u8 = b'C';
const STATUS_SUB_MODIFIED: u8 = b'M';
const STATUS_SUB_UNTRACK: u8 = b'U';
const STATUS_ORD_FIELDS: usize = 8;
const STATUS_REN_FIELDS: usize = 9;
const STATUS_UNMER_FIELDS: usize = 10;
const STATUS_UNTRACKED_XY: &str = "??";

/// 그룹 하나에 싣는 항목 상한이다.
pub const STATUS_GROUP_CAP: usize = 2000;

/// `git status --porcelain=v2 -z --branch` 출력을 파싱한다.
pub fn parse_status_v2(out: &str) -> Result<Status, Error> {
    let mut st = Status::default();
    let mut toks: Vec<&str> = out.split('\0').collect();
    if toks.last() == Some(&"") {
        toks.pop();
    }
    let mut i = 0;
    while i < toks.len() {
        let tok = toks[i];
        if let Some(rest) = tok.strip_prefix("# ") {
            parse_status_header(&mut st, rest);
        } else if let Some(rest) = tok.strip_prefix("1 ") {
            add_tracked(&mut st, parse_ordinary(rest)?);
        } else if let Some(rest) = tok.strip_prefix("2 ") {
            let Some(orig) = toks.get(i + 1) else {
                return Err(Error::other(format!(
                    "porcelain v2: rename 레코드에 origPath 가 없다: {}",
                    quote(tok)
                )));
            };
            let e = parse_renamed(rest, orig)?;
            i += 1;
            add_tracked(&mut st, e);
        } else if let Some(rest) = tok.strip_prefix("u ") {
            st.conflicts.push(parse_unmerged(rest)?);
        } else if let Some(rest) = tok.strip_prefix("? ") {
            st.untracked.push(new_untracked(rest));
        } else if tok.starts_with("! ") || tok.is_empty() {
        } else {
            return Err(Error::other(format!(
                "porcelain v2: 알 수 없는 레코드: {}",
                quote(tok)
            )));
        }
        i += 1;
    }
    finalize_status(&mut st);
    Ok(st)
}

fn parse_status_header(st: &mut Status, rest: &str) {
    let Some((key, val)) = rest.split_once(' ') else {
        return;
    };
    match key {
        "branch.oid" => {
            if val == STATUS_INITIAL_OID {
                st.initial = true;
            } else {
                st.oid = val.to_owned();
            }
        }
        "branch.head" => {
            if val == STATUS_DETACHED {
                st.detached = true;
            } else {
                st.branch = val.to_owned();
            }
        }
        "branch.upstream" => {
            st.upstream = val.to_owned();
            st.has_upstream = true;
        }
        "branch.ab" => (st.ahead, st.behind) = parse_ahead_behind(val),
        _ => {}
    }
}

/// Go `strconv.Atoi`.
pub(crate) fn atoi(s: &str) -> Option<i64> {
    s.parse::<i64>().ok()
}

fn parse_ahead_behind(s: &str) -> (i64, i64) {
    let (mut ahead, mut behind) = (0, 0);
    for f in s.split_whitespace() {
        let Some(n) = f.get(1..).and_then(atoi) else {
            continue;
        };
        match f.as_bytes()[0] {
            b'+' => ahead = n,
            b'-' => behind = n,
            _ => {}
        }
    }
    (ahead, behind)
}

fn fields_error(kind: &str, got: usize, want: usize, rest: &str) -> Error {
    Error::other(format!(
        "porcelain v2: {kind} 레코드의 필드가 {got}개다 (want {want}): {}",
        quote(rest)
    ))
}

fn parse_ordinary(rest: &str) -> Result<FileEntry, Error> {
    let f: Vec<&str> = rest.splitn(STATUS_ORD_FIELDS, ' ').collect();
    if f.len() < STATUS_ORD_FIELDS {
        return Err(fields_error("1", f.len(), STATUS_ORD_FIELDS, rest));
    }
    Ok(new_tracked(f[0], f[1], f[STATUS_ORD_FIELDS - 1]))
}

fn parse_renamed(rest: &str, orig: &str) -> Result<FileEntry, Error> {
    let f: Vec<&str> = rest.splitn(STATUS_REN_FIELDS, ' ').collect();
    if f.len() < STATUS_REN_FIELDS {
        return Err(fields_error("2", f.len(), STATUS_REN_FIELDS, rest));
    }
    let mut e = new_tracked(f[0], f[1], f[STATUS_REN_FIELDS - 1]);
    e.orig_path = orig.to_owned();
    let score = f[STATUS_REN_FIELDS - 2];
    if score.len() > 1
        && let Some(n) = score.get(1..).and_then(atoi)
    {
        e.score = n;
    }
    Ok(e)
}

fn parse_unmerged(rest: &str) -> Result<FileEntry, Error> {
    let f: Vec<&str> = rest.splitn(STATUS_UNMER_FIELDS, ' ').collect();
    if f.len() < STATUS_UNMER_FIELDS {
        return Err(fields_error("u", f.len(), STATUS_UNMER_FIELDS, rest));
    }
    let mut e = new_tracked(f[0], f[1], f[STATUS_UNMER_FIELDS - 1]);
    e.conflict = true;
    Ok(e)
}

fn new_tracked(xy: &str, sub: &str, path: &str) -> FileEntry {
    let mut e = FileEntry {
        path: path.to_owned(),
        xy: xy.to_owned(),
        ..FileEntry::default()
    };
    let b = xy.as_bytes();
    if b.len() == 2 {
        e.staged = b[0] != STATUS_NO_CHANGE;
        e.unstaged = b[1] != STATUS_NO_CHANGE;
    }
    if sub != STATUS_SUB_NONE {
        e.sub = sub.to_owned();
        e.dir = sub.starts_with(STATUS_SUB_IS_SUB);
    }
    e
}

impl FileEntry {
    /// 서브모듈 안에서만 바뀌었고 기록된 커밋은 같은가 (sub 필드 판정).
    pub fn submodule_inner_only(&self) -> bool {
        let s = self.sub.as_bytes();
        if s.len() != STATUS_SUB_NONE.len() || !self.sub.starts_with(STATUS_SUB_IS_SUB) {
            return false;
        }
        s[1] != STATUS_SUB_COMMIT && (s[2] == STATUS_SUB_MODIFIED || s[3] == STATUS_SUB_UNTRACK)
    }
}

fn new_untracked(path: &str) -> FileEntry {
    let mut e = FileEntry {
        path: path.to_owned(),
        xy: STATUS_UNTRACKED_XY.to_owned(),
        untracked: true,
        ..FileEntry::default()
    };
    if let Some(p) = path.strip_suffix('/') {
        e.path = p.to_owned();
        e.dir = true;
    }
    e
}

fn add_tracked(st: &mut Status, e: FileEntry) {
    if e.staged {
        st.staged.push(e.clone());
    }
    if e.unstaged {
        st.changes.push(e);
    }
}

fn finalize_status(st: &mut Status) {
    let mut seen: HashSet<String> = HashSet::new();
    let names = ["staged", "changes", "untracked", "conflicts"];
    for (i, g) in [
        &mut st.staged,
        &mut st.changes,
        &mut st.untracked,
        &mut st.conflicts,
    ]
    .into_iter()
    .enumerate()
    {
        g.sort_by(|a, b| a.path.cmp(&b.path));
        for e in g.iter() {
            seen.insert(e.path.clone());
        }
        if g.len() > STATUS_GROUP_CAP {
            st.truncated
                .get_or_insert_with(BTreeMap::new)
                .insert(names[i].to_owned(), g.len() as i64);
            g.truncate(STATUS_GROUP_CAP);
        }
    }
    st.total = seen.len() as i64;
}

/// 저장소 상태다 (추적되지 않는 파일 전부 포함).
pub async fn status_of(s: &Service, ctx: &Ctx, repo: &str) -> Result<Status, Error> {
    status_with(s, ctx, repo, "--untracked-files=all").await
}

/// 추적되는 파일만의 상태다.
pub async fn tracked_status_of(s: &Service, ctx: &Ctx, repo: &str) -> Result<Status, Error> {
    status_with(s, ctx, repo, "--untracked-files=no").await
}

async fn status_with(s: &Service, ctx: &Ctx, repo: &str, untracked: &str) -> Result<Status, Error> {
    let out = s
        .exec(
            ctx,
            repo,
            &["status", "--porcelain=v2", "-z", "--branch", untracked],
        )
        .await?;
    let mut raw: &[u8] = &out.stdout;
    if out.stdout_truncated {
        raw = drop_partial_record(raw);
    }
    let mut st = parse_status_v2(&String::from_utf8_lossy(raw))?;
    st.repo = repo.to_owned();
    st.output_truncated = out.stdout_truncated;
    Ok(st)
}

/// 상한에서 잘린 출력의 끝에 걸친 레코드를 버린다.
pub(crate) fn drop_partial_record(s: &[u8]) -> &[u8] {
    let Some(i) = s.iter().rposition(|&b| b == 0) else {
        return &[];
    };
    let s = &s[..=i];
    let toks: Vec<&[u8]> = s[..s.len() - 1].split(|&b| b == 0).collect();
    let mut start = 0;
    let mut j = 0;
    while j < toks.len() {
        let begin = start;
        start += toks[j].len() + 1;
        if toks[j].starts_with(b"2 ") {
            if j + 1 >= toks.len() {
                return &s[..begin];
            }
            start += toks[j + 1].len() + 1;
            j += 1;
        }
        j += 1;
    }
    s
}
