//! 줄 단위 출처 (FR-GIT-276).

use std::collections::BTreeMap;

use dm_gocompat::strconv::quote;
use dm_webserver_domain_git_core::{Ctx, Service, is_null_oid, is_oid};
use serde::Serialize;

use crate::diff::diff_rel_path;
use crate::error::{Error, QueryKind};
use crate::log::{check_rev, rev_error};
use crate::status::atoi;

const BLAME_PATH_NOT_FOUND_STDERR: &str = "no such path";

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct BlameQuery {
    pub repo: String,
    pub rev: String,
    pub path: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct BlameCommit {
    pub oid: String,
    #[serde(rename = "authorName")]
    pub author_name: String,
    #[serde(rename = "authorMail")]
    pub author_mail: String,
    /// unix ms.
    #[serde(rename = "authorAt")]
    pub author_at: i64,
    pub summary: String,
    pub uncommitted: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct BlameLine {
    pub oid: String,
    pub line: i64,
    pub text: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct FileBlame {
    pub repo: String,
    pub rev: String,
    pub path: String,
    pub lines: Vec<BlameLine>,
    pub commits: BTreeMap<String, BlameCommit>,
}

pub async fn blame(s: &Service, ctx: &Ctx, q: &BlameQuery) -> Result<FileBlame, Error> {
    let args = blame_args(q)?;
    let out = match s.exec(ctx, &q.repo, &args).await {
        Ok(o) => o,
        Err(e) if e.to_string().contains(BLAME_PATH_NOT_FOUND_STDERR) => {
            return Err(Error::new(QueryKind::BlamePathNotFound, &q.path));
        }
        Err(e) => return Err(rev_error(e)),
    };
    if out.stdout_truncated {
        return Err(Error::new(
            QueryKind::BlameTruncated,
            format!(
                "blame 의 출력이 상한({}B)에서 잘렸다: 파일이 너무 크다",
                s.max_output()
            ),
        ));
    }
    let mut b = parse_blame(&out.stdout_str())?;
    b.repo = q.repo.clone();
    b.rev = q.rev.clone();
    b.path = q.path.clone();
    Ok(b)
}

pub(crate) fn blame_args(q: &BlameQuery) -> Result<Vec<String>, Error> {
    check_rev("rev", &q.rev)?;
    let rel = diff_rel_path(&q.path)?;
    let mut args = vec!["blame".to_owned(), "--porcelain".to_owned()];
    if !q.rev.is_empty() {
        args.push(q.rev.clone());
    }
    args.extend(["--".into(), rel]);
    Ok(args)
}

/// `blame --porcelain` 출력을 파싱한다.
pub fn parse_blame(out: &str) -> Result<FileBlame, Error> {
    let mut b = FileBlame::default();
    let mut cur = String::new();
    for ln in out.strip_suffix('\n').unwrap_or(out).split('\n') {
        if ln.is_empty() {
            continue;
        }
        if let Some(text) = ln.strip_prefix('\t') {
            if cur.is_empty() {
                return Err(Error::new(
                    QueryKind::BlameParse,
                    format!("헤더 없는 본문 줄: {}", quote(ln)),
                ));
            }
            if let Some(last) = b.lines.last_mut() {
                last.text = text.to_owned();
            }
            cur.clear();
            continue;
        }
        if let Some((oid, line)) = blame_header(ln) {
            b.commits
                .entry(oid.to_owned())
                .or_insert_with(|| BlameCommit {
                    oid: oid.to_owned(),
                    uncommitted: is_null_oid(oid),
                    ..BlameCommit::default()
                });
            b.lines.push(BlameLine {
                oid: oid.to_owned(),
                line,
                ..BlameLine::default()
            });
            cur = oid.to_owned();
            continue;
        }
        if cur.is_empty() {
            return Err(Error::new(
                QueryKind::BlameParse,
                format!("헤더 없는 메타 줄: {}", quote(ln)),
            ));
        }
        if let Some(c) = b.commits.get_mut(&cur) {
            blame_meta(c, ln);
        }
    }
    Ok(b)
}

fn blame_header(ln: &str) -> Option<(&str, i64)> {
    let f: Vec<&str> = ln.split_whitespace().collect();
    if f.len() < 3 || !is_oid(f[0]) {
        return None;
    }
    let n = atoi(f[2]).filter(|n| *n > 0)?;
    Some((f[0], n))
}

fn blame_meta(c: &mut BlameCommit, ln: &str) {
    let (key, val) = ln.split_once(' ').unwrap_or((ln, ""));
    match key {
        "author" => c.author_name = val.into(),
        "author-mail" => {
            let v = val.strip_prefix('<').unwrap_or(val);
            c.author_mail = v.strip_suffix('>').unwrap_or(v).into();
        }
        "author-time" => {
            if let Ok(n) = val.parse::<i64>() {
                c.author_at = n.wrapping_mul(1000);
            }
        }
        "summary" => c.summary = val.into(),
        _ => {}
    }
}
