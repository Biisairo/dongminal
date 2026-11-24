//! 브랜치·태그 이름과 ref 판정 (FR-GIT-159·160·255·260).

use otter_gocompat::strconv::quote;
use otter_webserver_domain_git_core::{
    self as core, CHECK_REF_FORMAT_BRANCH, CHECK_REF_FORMAT_NORMALIZE, Ctx, Service, check_ref_arg,
    plain_exit,
};
use serde::Serialize;

use crate::error::{Error, ref_name_error};
use crate::refs::REF_TRACK_GONE;

pub const BRANCH_REF_PREFIX: &str = "refs/heads/";
pub const REMOTE_REF_PREFIX: &str = "refs/remotes/";
pub const TAG_REF_PREFIX: &str = "refs/tags/";

const REF_NAME_INVALID_STDERR: &str = "is not a valid branch name";
const MERGE_BASE_ANCESTOR: &str = "--is-ancestor";
const NOT_ANCESTOR_EXIT: i32 = 1;

/// 브랜치 이름을 git 의 규칙으로 검사한다 (FR-GIT-159).
pub async fn valid_branch_name(
    s: &Service,
    ctx: &Ctx,
    repo: &str,
    name: &str,
) -> Result<(), Error> {
    check_ref_arg("name", name)?;
    let out = s
        .exec(
            ctx,
            repo,
            &["check-ref-format", CHECK_REF_FORMAT_BRANCH, name],
        )
        .await
        .map_err(|e| branch_name_error(name, e))?;
    let text = out.stdout_str();
    let got = text.trim_end_matches('\n');
    if got != name {
        return Err(ref_name_error(format!(
            "{} 는 git 이 {} 로 펼치는 표현이다",
            quote(name),
            quote(got)
        )));
    }
    Ok(())
}

fn branch_name_error(name: &str, err: core::Error) -> Error {
    match plain_exit(&err) {
        Some(xe) if xe.stderr.to_lowercase().contains(REF_NAME_INVALID_STDERR) => ref_name_error(
            format!("{} 는 git 의 브랜치 이름 규칙을 어긴다", quote(name)),
        ),
        _ => err.into(),
    }
}

/// 태그 이름을 git 의 규칙으로 검사한다 (FR-GIT-260).
pub async fn valid_tag_name(s: &Service, ctx: &Ctx, repo: &str, name: &str) -> Result<(), Error> {
    check_ref_arg("name", name)?;
    let full = format!("{TAG_REF_PREFIX}{name}");
    let out = match s
        .exec(
            ctx,
            repo,
            &[
                "check-ref-format",
                CHECK_REF_FORMAT_NORMALIZE,
                full.as_str(),
            ],
        )
        .await
    {
        Ok(o) => o,
        Err(e) if plain_exit(&e).is_some() => {
            return Err(ref_name_error(format!(
                "{} 는 git 의 태그 이름 규칙을 어긴다",
                quote(name)
            )));
        }
        Err(e) => return Err(e.into()),
    };
    let text = out.stdout_str();
    let got = text.trim_end_matches('\n');
    if got != full {
        return Err(ref_name_error(format!(
            "{} 는 git 이 {} 로 고쳐 읽는 이름이다",
            quote(name),
            quote(got.strip_prefix(TAG_REF_PREFIX).unwrap_or(got))
        )));
    }
    Ok(())
}

pub async fn local_branch_exists(
    s: &Service,
    ctx: &Ctx,
    repo: &str,
    name: &str,
) -> Result<bool, Error> {
    ref_exists(s, ctx, repo, BRANCH_REF_PREFIX, name).await
}

pub async fn tag_exists(s: &Service, ctx: &Ctx, repo: &str, name: &str) -> Result<bool, Error> {
    ref_exists(s, ctx, repo, TAG_REF_PREFIX, name).await
}

/// HEAD 가 커밋을 가리키는가 (커밋이 없는 저장소면 거짓).
pub async fn has_head(s: &Service, ctx: &Ctx, repo: &str) -> Result<bool, Error> {
    ref_exists(s, ctx, repo, "", "HEAD").await
}

async fn ref_exists(
    s: &Service,
    ctx: &Ctx,
    repo: &str,
    prefix: &str,
    name: &str,
) -> Result<bool, Error> {
    match ref_oid(s, ctx, repo, prefix, name).await {
        Ok(_) => Ok(true),
        Err(e) if e.core().is_some_and(|c| plain_exit(c).is_some()) => Ok(false),
        Err(e) => Err(e),
    }
}

pub async fn branch_oid(s: &Service, ctx: &Ctx, repo: &str, name: &str) -> Result<String, Error> {
    ref_oid(s, ctx, repo, BRANCH_REF_PREFIX, name).await
}

pub async fn remote_branch_oid(
    s: &Service,
    ctx: &Ctx,
    repo: &str,
    short: &str,
) -> Result<String, Error> {
    ref_oid(s, ctx, repo, REMOTE_REF_PREFIX, short).await
}

pub async fn tag_oid(s: &Service, ctx: &Ctx, repo: &str, name: &str) -> Result<String, Error> {
    let oid = ref_oid(s, ctx, repo, TAG_REF_PREFIX, name).await?;
    if oid.is_empty() {
        return Err(Error::other(format!(
            "태그 {} 의 대상을 읽지 못했다: rev-parse 가 빈 값을 줬다",
            quote(name)
        )));
    }
    Ok(oid)
}

async fn ref_oid(
    s: &Service,
    ctx: &Ctx,
    repo: &str,
    prefix: &str,
    name: &str,
) -> Result<String, Error> {
    check_ref_arg("name", name)?;
    let full = format!("{prefix}{name}");
    let out = s
        .exec(ctx, repo, &["rev-parse", "--verify", full.as_str()])
        .await?;
    Ok(out.stdout_str().trim_end_matches('\n').to_owned())
}

/// 브랜치의 upstream 짧은 이름이다. 없으면 빈 값이다.
pub async fn branch_upstream(
    s: &Service,
    ctx: &Ctx,
    repo: &str,
    name: &str,
) -> Result<String, Error> {
    check_ref_arg("branch", name)?;
    let full = format!("{BRANCH_REF_PREFIX}{name}");
    let out = s
        .exec(
            ctx,
            repo,
            &["for-each-ref", "--format=%(upstream:short)", full.as_str()],
        )
        .await?;
    Ok(out.stdout_str().trim().to_owned())
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct UpstreamTarget {
    pub remote: String,
    pub r#ref: String,
}

pub async fn branch_upstream_target(
    s: &Service,
    ctx: &Ctx,
    repo: &str,
    name: &str,
) -> Result<UpstreamTarget, Error> {
    check_ref_arg("branch", name)?;
    let full = format!("{BRANCH_REF_PREFIX}{name}");
    let out = s
        .exec(
            ctx,
            repo,
            &[
                "for-each-ref",
                "--format=%(upstream:remotename)%00%(upstream:remoteref)",
                full.as_str(),
            ],
        )
        .await?;
    let text = out.stdout_str();
    let t = text.trim_end_matches('\n');
    let (remote, r) = t.split_once('\0').unwrap_or((t, ""));
    Ok(UpstreamTarget {
        remote: remote.into(),
        r#ref: r.into(),
    })
}

/// 브랜치가 upstream(없거나 사라졌으면 HEAD)에 합쳐졌는가.
pub async fn branch_merged(s: &Service, ctx: &Ctx, repo: &str, name: &str) -> Result<bool, Error> {
    check_ref_arg("branch", name)?;
    let full = format!("{BRANCH_REF_PREFIX}{name}");
    let out = s
        .exec(
            ctx,
            repo,
            &[
                "for-each-ref",
                "--format=%(upstream:short)%00%(upstream:track)",
                full.as_str(),
            ],
        )
        .await?;
    let text = out.stdout_str();
    let t = text.trim_end_matches('\n');
    let (up, track) = t.split_once('\0').unwrap_or((t, ""));
    let base = if up.is_empty() || track == REF_TRACK_GONE {
        "HEAD"
    } else {
        up
    };
    is_ancestor(s, ctx, repo, name, base).await
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct MergeImpact {
    pub r#ref: String,
    #[serde(rename = "ff")]
    pub fast_forward: bool,
    pub incoming: i64,
    pub diverged: i64,
    #[serde(rename = "upToDate")]
    pub up_to_date: bool,
}

/// merge 의 영향 범위다 (FR-GIT-255).
pub async fn merge_preview(
    s: &Service,
    ctx: &Ctx,
    repo: &str,
    r: &str,
) -> Result<MergeImpact, Error> {
    check_ref_arg("ref", r)?;
    let incoming = rev_count(s, ctx, repo, &format!("HEAD..{r}")).await?;
    let diverged = rev_count(s, ctx, repo, &format!("{r}..HEAD")).await?;
    let ff = is_ancestor(s, ctx, repo, "HEAD", r).await?;
    Ok(MergeImpact {
        r#ref: r.into(),
        fast_forward: ff,
        incoming,
        diverged,
        up_to_date: incoming == 0,
    })
}

async fn rev_count(s: &Service, ctx: &Ctx, repo: &str, rng: &str) -> Result<i64, Error> {
    let out = s.exec(ctx, repo, &["rev-list", "--count", rng]).await?;
    let text = out.stdout_str();
    crate::status::atoi(text.trim()).ok_or_else(|| {
        Error::other(format!(
            "rev-list --count {rng} 의 출력이 수가 아니다: {}",
            quote(&text)
        ))
    })
}

async fn is_ancestor(
    s: &Service,
    ctx: &Ctx,
    repo: &str,
    child: &str,
    parent: &str,
) -> Result<bool, Error> {
    match s
        .exec(
            ctx,
            repo,
            &["merge-base", MERGE_BASE_ANCESTOR, child, parent],
        )
        .await
    {
        Ok(_) => Ok(true),
        Err(e) if plain_exit(&e).is_some_and(|x| x.exit_code == NOT_ANCESTOR_EXIT) => Ok(false),
        Err(e) => Err(e.into()),
    }
}
