//! 커밋 그래프 조회 (FR-GIT-120~130).

use otter_gocompat::strconv::quote;
use otter_webserver_domain_git_core::{self as core, Ctx, Service, plain_exit, unix_sec_to_milli};
use serde::Serialize;

use crate::error::{Error, QueryKind, quote_list};
use crate::refs::{REF_KIND_LOCAL, REF_KIND_REMOTE, REF_KIND_TAG};

pub(crate) const LOG_FIELDS: usize = 9;
pub(crate) const LOG_FORMAT: &str =
    "--pretty=format:%H%x00%h%x00%P%x00%an%x00%ae%x00%at%x00%ct%x00%D%x00%s";
pub(crate) const LOG_DECORATE: &str = "--decorate=full";

pub const LOG_INITIAL_LIMIT: i64 = 300;
pub const LOG_PAGE_LIMIT: i64 = 100;
pub const LOG_MAX_LIMIT: i64 = 2000;

pub const LOG_ORDER_DATE: &str = "date";
pub const LOG_ORDER_AUTHOR_DATE: &str = "author-date";
pub const LOG_ORDER_TOPO: &str = "topo";

const LOG_DEC_SEP: &str = ", ";
const LOG_DEC_HEAD: &str = "HEAD";
const LOG_DEC_HEAD_TO: &str = "HEAD -> ";
const LOG_DEC_TAG: &str = "tag: ";
const LOG_REF_HEADS: &str = "refs/heads/";
const LOG_REF_REMOTES: &str = "refs/remotes/";
const LOG_REF_TAGS: &str = "refs/tags/";

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct CommitRef {
    pub name: String,
    pub kind: String,
    #[serde(rename = "isHead")]
    pub is_head: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct Commit {
    pub oid: String,
    pub abbrev: String,
    pub parents: Vec<String>,
    #[serde(rename = "authorName")]
    pub author_name: String,
    #[serde(rename = "authorMail")]
    pub author_mail: String,
    #[serde(rename = "authorAtUnixMs")]
    pub author_at: i64,
    #[serde(rename = "commitAtUnixMs")]
    pub commit_at: i64,
    pub subject: String,
    pub refs: Vec<CommitRef>,
    #[serde(rename = "isHead")]
    pub is_head: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LogQuery {
    pub repo: String,
    /// 비면 --all 이다 (FR-GIT-123).
    pub r#ref: String,
    pub skip: i64,
    pub limit: i64,
    pub order: String,
    pub author: String,
    pub since: String,
    pub until: String,
    pub path: String,
    pub grep: String,
    pub reflog: bool,
}

/// 커밋 목록이다.
pub async fn log(s: &Service, ctx: &Ctx, q: &LogQuery) -> Result<Vec<Commit>, Error> {
    let args = log_args(q)?;
    let out = s.exec(ctx, &q.repo, &args).await.map_err(rev_error)?;
    if out.stdout_truncated {
        return Err(Error::other(format!(
            "git log 의 출력이 상한({}B)에서 잘렸다: limit 을 줄여 다시 요청해야 한다",
            s.max_output()
        )));
    }
    parse_log(&out.stdout_str())
}

/// 요청 수를 받을 수 있는 범위로 옮긴다.
pub fn log_limit(n: i64) -> i64 {
    if n <= 0 {
        LOG_INITIAL_LIMIT
    } else if n > LOG_MAX_LIMIT {
        LOG_MAX_LIMIT
    } else {
        n
    }
}

pub(crate) fn log_args(q: &LogQuery) -> Result<Vec<String>, Error> {
    check_rev("ref", &q.r#ref)?;
    let mut args: Vec<String> = vec![
        "log".into(),
        "-z".into(),
        LOG_FORMAT.into(),
        LOG_DECORATE.into(),
    ];
    match q.order.as_str() {
        "" | LOG_ORDER_DATE => {}
        LOG_ORDER_AUTHOR_DATE => args.push("--author-date-order".into()),
        LOG_ORDER_TOPO => args.push("--topo-order".into()),
        o => return Err(Error::new(QueryKind::LogOrder, quote(o))),
    }
    if q.skip > 0 {
        args.push(format!("--skip={}", q.skip));
    }
    args.extend(["-n".into(), log_limit(q.limit).to_string()]);
    for (flag, val) in [
        ("--author=", &q.author),
        ("--since=", &q.since),
        ("--until=", &q.until),
        ("--grep=", &q.grep),
    ] {
        if !val.is_empty() {
            args.push(format!("{flag}{val}"));
        }
    }
    if q.reflog {
        args.push("--reflog".into());
    }
    args.push(if q.r#ref.is_empty() {
        "--all".into()
    } else {
        q.r#ref.clone()
    });
    if !q.path.is_empty() {
        args.extend(["--".into(), q.path.clone()]);
    }
    Ok(args)
}

/// 옵션처럼 생긴 rev 를 막는다.
pub(crate) fn check_rev(name: &str, rev: &str) -> Result<(), Error> {
    if rev.starts_with('-') {
        return Err(Error::new(
            QueryKind::UnsafeRev,
            format!("{name} 는 - 로 시작할 수 없다: {}", quote(rev)),
        ));
    }
    Ok(())
}

const REV_NOT_FOUND_STDERR: [&str; 5] = [
    "unknown revision or path not in the working tree",
    "bad object",
    "bad revision",
    "does not have any commits yet",
    "not a valid object name",
];

/// 없는 rev 를 RevNotFound 로 가른다.
pub(crate) fn rev_error(err: core::Error) -> Error {
    if let Some(xe) = plain_exit(&err) {
        let low = xe.stderr.to_lowercase();
        if REV_NOT_FOUND_STDERR.iter().any(|p| low.contains(p)) {
            return Error::new(QueryKind::RevNotFound, &err);
        }
    }
    err.into()
}

/// `log -z` 출력을 파싱한다.
pub fn parse_log(out: &str) -> Result<Vec<Commit>, Error> {
    if out.is_empty() {
        return Ok(Vec::new());
    }
    let toks: Vec<&str> = out.split('\0').collect();
    let rem = toks.len() % LOG_FIELDS;
    if rem != 0 {
        let tail: Vec<String> = toks[toks.len() - rem..]
            .iter()
            .map(|s| s.to_string())
            .collect();
        return Err(Error::other(format!(
            "git log: 마지막 레코드의 필드가 {rem}개다 (want {LOG_FIELDS}): {}",
            quote_list(&tail)
        )));
    }
    Ok(toks.chunks(LOG_FIELDS).map(commit_from_fields).collect())
}

pub(crate) fn commit_from_fields(f: &[&str]) -> Commit {
    let (refs, is_head) = parse_decoration(f[7]);
    Commit {
        oid: f[0].into(),
        abbrev: f[1].into(),
        parents: f[2].split_whitespace().map(String::from).collect(),
        author_name: f[3].into(),
        author_mail: f[4].into(),
        author_at: unix_sec_to_milli(f[5]),
        commit_at: unix_sec_to_milli(f[6]),
        subject: f[8].into(),
        refs,
        is_head,
    }
}

fn parse_decoration(d: &str) -> (Vec<CommitRef>, bool) {
    let mut refs = Vec::new();
    let mut is_head = false;
    if d.trim().is_empty() {
        return (refs, false);
    }
    for piece in d.split(LOG_DEC_SEP) {
        let mut piece = piece.trim();
        if piece.is_empty() {
            continue;
        }
        if piece == LOG_DEC_HEAD {
            is_head = true;
            continue;
        }
        let mut r = CommitRef::default();
        if let Some(rest) = piece.strip_prefix(LOG_DEC_HEAD_TO) {
            is_head = true;
            r.is_head = true;
            piece = rest;
        }
        if let Some(rest) = piece.strip_prefix(LOG_DEC_TAG) {
            r.name = rest.strip_prefix(LOG_REF_TAGS).unwrap_or(rest).into();
            r.kind = REF_KIND_TAG.into();
            refs.push(r);
            continue;
        }
        let (name, kind) = short_ref_name(piece);
        r.name = name.into();
        r.kind = kind.into();
        refs.push(r);
    }
    (refs, is_head)
}

/// 전체 ref 이름을 짧은 이름과 종류로 나눈다. 모르는 네임스페이스면 종류가 빈 값이다.
pub(crate) fn short_ref_name(name: &str) -> (&str, &'static str) {
    for (prefix, kind) in [
        (LOG_REF_HEADS, REF_KIND_LOCAL),
        (LOG_REF_REMOTES, REF_KIND_REMOTE),
        (LOG_REF_TAGS, REF_KIND_TAG),
    ] {
        if let Some(rest) = name.strip_prefix(prefix) {
            return (rest, kind);
        }
    }
    (name, "")
}
