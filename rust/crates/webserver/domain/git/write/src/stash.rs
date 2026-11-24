//! stash (FR-GIT-100~108). 대상은 위치(stash@{n})가 아니라 oid 로 받는다 (FR-GIT-104).

use std::sync::LazyLock;

use dm_gocompat::strconv::quote;
use dm_webserver_domain_git_core::{self as core, Ctx, Hint, Output, Service};
use dm_webserver_domain_git_query as query;
use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::commit::{argv, spec};
use crate::error::{Error, WriteKind, exec_write};

const STASH_FIELDS: usize = 4;
const STASH_FORMAT: &str = "--format=%gd%x00%H%x00%gs%x00%ct%x00";
const STASH_REC_SEP: &str = "\0\n";

const STASH_WIP_PREFIX: &str = "WIP on ";
const STASH_ON_PREFIX: &str = "On ";
const STASH_BASE_SEP: &str = ": ";

const STASH_INDEX_FLAG: &str = "--index";
const STASH_UNTRACKED_FLAG: &str = "--include-untracked";
const STASH_KEEP_INDEX_FLAG: &str = "--keep-index";
const STASH_MESSAGE_FLAG: &str = "--message=";
const STASH_NAME_STATUS_FLAGS: &str = "--name-status";

static STASH_REF_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^stash@\{(\d+)\}$").unwrap_or_else(|e| unreachable!("고정 정규식: {e}"))
});

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "write.Stash")]
pub struct Stash {
    /// stash@{n} 의 n.
    pub index: i64,
    pub oid: String,
    pub message: String,
    /// 기준 브랜치. detached 면 `(no branch)`.
    pub base: String,
    #[serde(rename = "atUnixMs")]
    pub at_unix_ms: i64,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "write.StashPushOpts")]
pub struct StashPushOpts {
    pub message: String,
    #[serde(rename = "includeUntracked")]
    pub include_untracked: bool,
    #[serde(rename = "keepIndex")]
    pub keep_index: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "write.StashPopKept")]
pub struct StashPopKept {
    #[serde(rename = "stashKept")]
    pub kept: bool,
    #[serde(rename = "stashKeptReason", skip_serializing_if = "String::is_empty")]
    pub reason: String,
    #[serde(rename = "stashKeptOid", skip_serializing_if = "String::is_empty")]
    pub oid: String,
}

fn stash_ref(index: i64) -> String {
    format!("stash@{{{index}}}")
}

/// `stash@{n}`. 음수는 거부한다.
pub fn stash_ref_of(index: i64) -> Result<String, Error> {
    if index < 0 {
        return Err(Error::unsafe_argument(format!(
            "stash 인덱스는 0 이상이어야 한다: {index}"
        )));
    }
    Ok(stash_ref(index))
}

/// stash 목록. stash 는 읽기 허용 목록에 없어 쓰기 경로로 돈다.
pub async fn stash_list(s: &Service, ctx: &Ctx, repo: &str) -> Result<Vec<Stash>, Error> {
    let out = exec_write(
        s,
        ctx,
        repo,
        spec(argv(&["stash", "list", STASH_FORMAT]), false),
    )
    .await?;
    if out.stdout_truncated {
        return Err(Error::other(format!(
            "git stash list 의 출력이 상한({}B)에서 잘렸다: stash 목록을 온전히 줄 수 없다",
            s.max_output()
        )));
    }
    parse_stash_list(&out.stdout_str())
}

pub fn parse_stash_list(out: &str) -> Result<Vec<Stash>, Error> {
    let mut list = Vec::new();
    for rec in out.split(STASH_REC_SEP) {
        if rec.is_empty() {
            continue;
        }
        let f: Vec<&str> = rec.split('\0').collect();
        if f.len() != STASH_FIELDS {
            return Err(Error::other(format!(
                "stash list: 필드가 {}개다 (want {STASH_FIELDS}): {}",
                f.len(),
                quote(rec)
            )));
        }
        let index = stash_index_of(f[0])?;
        let (base, message) = stash_subject(f[2]);
        list.push(Stash {
            index,
            oid: f[1].to_owned(),
            message,
            base,
            at_unix_ms: core::unix_sec_to_milli(f[3]),
        });
    }
    Ok(list)
}

pub async fn stash_push(
    s: &Service,
    ctx: &Ctx,
    repo: &str,
    o: &StashPushOpts,
) -> Result<Output, Error> {
    let st = stash_push_status(s, ctx, repo, o.include_untracked).await?;
    if stashable_count(&st, o.include_untracked) == 0 {
        return Err(Error::new(
            WriteKind::StashEmpty,
            stash_empty_reason(&st, o.include_untracked),
        ));
    }
    let mut av = argv(&["stash", "push"]);
    if o.include_untracked {
        av.push(STASH_UNTRACKED_FLAG.to_owned());
    }
    if o.keep_index {
        av.push(STASH_KEEP_INDEX_FLAG.to_owned());
    }
    if !o.message.is_empty() {
        av.push(format!("{STASH_MESSAGE_FLAG}{}", o.message));
    }
    exec_write(s, ctx, repo, spec(av, false)).await
}

async fn stash_push_status(
    s: &Service,
    ctx: &Ctx,
    repo: &str,
    include_untracked: bool,
) -> Result<query::Status, Error> {
    if include_untracked {
        return Ok(query::status_of(s, ctx, repo).await?);
    }
    let st = query::tracked_status_of(s, ctx, repo).await?;
    if stashable_count(&st, false) > 0 {
        return Ok(st);
    }
    Ok(query::status_of(s, ctx, repo).await?)
}

pub fn stashable_count(st: &query::Status, include_untracked: bool) -> usize {
    let mut n = st.staged.len() + st.changes.len() + st.conflicts.len();
    if include_untracked {
        n += st.untracked.len();
    }
    n
}

pub fn stash_empty_reason(st: &query::Status, include_untracked: bool) -> String {
    if !include_untracked && !st.untracked.is_empty() {
        return format!(
            "추적되지 않는 파일 {}개뿐이다: --include-untracked 를 켜야 담긴다",
            st.untracked.len()
        );
    }
    "저장할 변경이 없다".to_owned()
}

pub fn check_stash_oid(oid: &str) -> Result<(), Error> {
    let ok = (oid.len() == 40 || oid.len() == 64)
        && oid
            .chars()
            .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c));
    if !ok {
        return Err(Error::unsafe_argument(format!(
            "stash oid 형식이 아니다: {}",
            quote(oid)
        )));
    }
    Ok(())
}

/// oid 로 stash 를 찾는다. 목록도 함께 돌려준다.
pub async fn stash_locate(
    s: &Service,
    ctx: &Ctx,
    repo: &str,
    oid: &str,
) -> Result<(Stash, Vec<Stash>), Error> {
    check_stash_oid(oid)?;
    let list = stash_list(s, ctx, repo).await?;
    match list.iter().find(|st| st.oid == oid) {
        Some(st) => Ok((st.clone(), list)),
        None => Err(Error::new(
            WriteKind::StashMoved,
            format!("stash {oid} 가 목록에 없다 (stash {}개)", list.len()),
        )),
    }
}

pub async fn stash_apply(
    s: &Service,
    ctx: &Ctx,
    repo: &str,
    oid: &str,
    with_index: bool,
) -> Result<Output, Error> {
    stash_locate(s, ctx, repo, oid).await?;
    exec_write(
        s,
        ctx,
        repo,
        spec(stash_restore_args("apply", oid, with_index), false),
    )
    .await
}

pub async fn stash_pop(
    s: &Service,
    ctx: &Ctx,
    repo: &str,
    oid: &str,
    with_index: bool,
) -> Result<Output, Error> {
    let (target, _) = stash_locate(s, ctx, repo, oid).await?;
    stash_pop_at(s, ctx, repo, &target, with_index).await
}

async fn stash_pop_at(
    s: &Service,
    ctx: &Ctx,
    repo: &str,
    target: &Stash,
    with_index: bool,
) -> Result<Output, Error> {
    let av = stash_restore_args("pop", &stash_ref(target.index), with_index);
    exec_write(s, ctx, repo, spec(av, false)).await
}

/// pop 뒤에 목록을 다시 읽어 stash 가 남았는지 알린다. kept 는 pop 이 실패해도 돌려준다.
pub async fn stash_pop_checked(
    s: &Service,
    ctx: &Ctx,
    repo: &str,
    oid: &str,
    with_index: bool,
) -> (Result<Output, Error>, StashPopKept) {
    let target = match stash_locate(s, ctx, repo, oid).await {
        Ok((t, _)) => t,
        Err(e) => return (Err(e), StashPopKept::default()),
    };
    let res = stash_pop_at(s, ctx, repo, &target, with_index).await;
    let kept = stash_kept_after(
        s,
        ctx,
        repo,
        oid,
        "pop 이 끝나지 않아 git 이 stash({}) 를 남겼다 — 저장한 작업은 사라지지 않았다. 충돌을 해소한 뒤 drop 하면 된다.",
    )
    .await;
    after_kept(res, kept)
}

fn after_kept(
    res: Result<Output, Error>,
    kept: Result<StashPopKept, Error>,
) -> (Result<Output, Error>, StashPopKept) {
    match kept {
        Ok(k) => (res, k),
        Err(list_err) => {
            let (out, run_err) = match res {
                Ok(o) => (o, None),
                Err(e) => (e.output(), Some(e)),
            };
            (
                Err(Error::join(run_err, list_err).with_output(out)),
                StashPopKept::default(),
            )
        }
    }
}

async fn stash_kept_after(
    s: &Service,
    ctx: &Ctx,
    repo: &str,
    oid: &str,
    reason_fmt: &str,
) -> Result<StashPopKept, Error> {
    let after = stash_list(s, ctx, repo).await?;
    if after.iter().any(|st| st.oid == oid) {
        return Ok(StashPopKept {
            kept: true,
            oid: oid.to_owned(),
            reason: reason_fmt.replacen("{}", oid, 1),
        });
    }
    Ok(StashPopKept::default())
}

/// 파괴적이다. 지우기 전에 되살리는 hint 를 남긴다 (FR-GIT-92).
pub async fn stash_drop(s: &Service, ctx: &Ctx, repo: &str, oid: &str) -> Result<Output, Error> {
    let (target, _) = stash_locate(s, ctx, repo, oid).await?;
    s.add_hint(stash_drop_hint(repo, &target));
    let av = vec![
        "stash".to_owned(),
        "drop".to_owned(),
        stash_ref(target.index),
    ];
    exec_write(s, ctx, repo, spec(av, true)).await
}

pub fn stash_branch_args(name: &str, index: i64) -> Result<Vec<String>, Error> {
    core::check_ref_arg("name", name)?;
    let r = stash_ref_of(index)?;
    Ok(vec![
        "stash".to_owned(),
        "branch".to_owned(),
        name.to_owned(),
        r,
    ])
}

pub async fn stash_branch(
    s: &Service,
    ctx: &Ctx,
    repo: &str,
    name: &str,
    oid: &str,
) -> (Result<Output, Error>, StashPopKept) {
    let target = match stash_locate(s, ctx, repo, oid).await {
        Ok((t, _)) => t,
        Err(e) => return (Err(e), StashPopKept::default()),
    };
    let av = match stash_branch_args(name, target.index) {
        Ok(a) => a,
        Err(e) => return (Err(e), StashPopKept::default()),
    };
    let res = exec_write(s, ctx, repo, spec(av, false)).await;
    let kept = stash_kept_after(
        s,
        ctx,
        repo,
        oid,
        "stash branch 가 끝나지 않아 git 이 stash({}) 를 남겼다 — 저장한 작업은 사라지지 않았다.",
    )
    .await;
    after_kept(res, kept)
}

pub async fn stash_preview(
    s: &Service,
    ctx: &Ctx,
    repo: &str,
    oid: &str,
) -> Result<Vec<query::CommitFile>, Error> {
    stash_locate(s, ctx, repo, oid).await?;
    let av = argv(&["stash", "show", STASH_NAME_STATUS_FLAGS, "-z", oid]);
    let out = exec_write(s, ctx, repo, spec(av, false)).await?;
    if out.stdout_truncated {
        return Err(Error::other(format!(
            "git stash show 의 출력이 상한({}B)에서 잘렸다: 변경 파일 목록을 온전히 줄 수 없다",
            s.max_output()
        )));
    }
    Ok(query::parse_name_status_z(&out.stdout_str())?)
}

fn stash_restore_args(sub: &str, target: &str, with_index: bool) -> Vec<String> {
    let mut av = argv(&["stash", sub]);
    if with_index {
        av.push(STASH_INDEX_FLAG.to_owned());
    }
    av.push(target.to_owned());
    av
}

fn stash_drop_hint(repo: &str, st: &Stash) -> Hint {
    let at = time::OffsetDateTime::from_unix_timestamp_nanos(i128::from(st.at_unix_ms) * 1_000_000)
        .map(|t| dm_gocompat::time::to_zone(t, dm_gocompat::time::local()))
        .map(dm_gocompat::time::format_rfc3339)
        .unwrap_or_default();
    Hint {
        repo: repo.to_owned(),
        action: core::ACTION_STASH_DROP.to_owned(),
        targets: Some(vec![stash_ref(st.index)]),
        values: Some(vec![st.oid.clone()]),
        command: format!("git stash store -m {} {}", quote(&st.message), st.oid),
        note: format!(
            "{at} 에 {} 기준으로 만든 stash 다. gc 전이면 위 명령으로 되살릴 수 있다.",
            st.base
        ),
        ..Hint::default()
    }
}

fn stash_index_of(gd: &str) -> Result<i64, Error> {
    let Some(m) = STASH_REF_RE.captures(gd) else {
        return Err(Error::other(format!(
            "stash list: {} 는 stash@{{n}} 이 아니다",
            quote(gd)
        )));
    };
    m[1].parse::<i64>()
        .map_err(|_| Error::other(format!("stash list: {} 의 인덱스를 읽지 못했다", quote(gd))))
}

fn stash_subject(gs: &str) -> (String, String) {
    let rest = gs
        .strip_prefix(STASH_WIP_PREFIX)
        .or_else(|| gs.strip_prefix(STASH_ON_PREFIX));
    match rest.and_then(|r| r.split_once(STASH_BASE_SEP)) {
        Some((base, msg)) => (base.to_owned(), msg.to_owned()),
        None => (String::new(), gs.to_owned()),
    }
}
