//! stage·unstage·discard (FR-GIT-60~66). 경로는 1000개씩 끊어 실행한다.

use dm_webserver_domain_git_core::{self as core, Ctx, Hint, Output, Service};
use dm_webserver_domain_git_query as query;

use crate::commit::{argv, spec};
use crate::error::{Batch, Error, exec_write};

/// 한 번의 git 호출이 받는 경로 수 상한이다 (ARG_MAX).
pub const MAX_PATHS_PER_CALL: usize = 1000;
pub(crate) const PATHS_SEP: &str = "--";

pub async fn stage(s: &Service, ctx: &Ctx, repo: &str, paths: &[String]) -> Result<Output, Error> {
    let clean = check_paths(paths)?;
    let total = clean.len();
    exec_paths(s, ctx, repo, &clean, false, total, 0, &["add"])
        .await
        .map(|(o, _)| o)
}

/// 커밋이 없으면 `rm --cached` 로 index 에서 뺀다.
pub async fn unstage(
    s: &Service,
    ctx: &Ctx,
    repo: &str,
    paths: &[String],
) -> Result<Output, Error> {
    let clean = check_paths(paths)?;
    let lead: &[&str] = if query::has_head(s, ctx, repo).await? {
        &["reset", "-q", "HEAD"]
    } else {
        &["rm", "--cached", "-q"]
    };
    let total = clean.len();
    exec_paths(s, ctx, repo, &clean, false, total, 0, lead)
        .await
        .map(|(o, _)| o)
}

/// tracked 는 index 로 덮고 untracked 는 지운다. 파괴적이며 성공 뒤 hint 를 남긴다.
pub async fn discard(
    s: &Service,
    ctx: &Ctx,
    repo: &str,
    tracked: &[String],
    untracked: &[String],
) -> Result<Output, Error> {
    if tracked.is_empty() && untracked.is_empty() {
        return Err(Error::unsafe_argument("경로가 없다"));
    }
    let ct = check_each(tracked)?;
    let cu = check_each(untracked)?;
    let total = ct.len() + cu.len();
    let mut out = Output::default();
    let mut applied = 0;
    if !ct.is_empty() {
        (out, applied) = exec_paths(s, ctx, repo, &ct, true, total, 0, &["checkout", "-q"]).await?;
    }
    if !cu.is_empty() {
        (out, _) = exec_paths(
            s,
            ctx,
            repo,
            &cu,
            true,
            total,
            applied,
            &["clean", "-q", "-f"],
        )
        .await?;
    }
    s.add_hint(discard_hint(repo, &ct, &cu));
    Ok(out)
}

fn discard_hint(repo: &str, tracked: &[String], untracked: &[String]) -> Hint {
    let targets: Vec<String> = tracked.iter().chain(untracked).cloned().collect();
    let mut note = "워킹 트리의 변경은 git 에 저장된 적이 없어 되살릴 값이 없다.".to_owned();
    if !tracked.is_empty() {
        note.push_str(&format!(
            " tracked {} 개는 index 의 내용으로 덮인다 — staged 분은 남는다.",
            tracked.len()
        ));
    }
    if !untracked.is_empty() {
        note.push_str(&format!(" untracked {} 개는 삭제된다.", untracked.len()));
    }
    Hint {
        repo: repo.to_owned(),
        action: core::ACTION_DISCARD.to_owned(),
        targets: Some(targets),
        note,
        ..Hint::default()
    }
}

/// 묶음마다 `lead -- paths` 로 실행한다. 실패하면 그때까지 적용된 수를 [`Batch`] 로 싣는다.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn exec_paths(
    s: &Service,
    ctx: &Ctx,
    repo: &str,
    paths: &[String],
    destructive: bool,
    total: usize,
    offset: usize,
    lead: &[&str],
) -> Result<(Output, usize), Error> {
    let mut last = Output::default();
    let mut applied = offset;
    for chunk in paths.chunks(MAX_PATHS_PER_CALL) {
        let mut av = argv(lead);
        av.push(PATHS_SEP.to_owned());
        av.extend(chunk.iter().cloned());
        match exec_write(s, ctx, repo, spec(av.clone(), destructive)).await {
            Ok(out) => {
                applied += chunk.len();
                last = out;
            }
            Err(e) => {
                let batch = Batch {
                    argv: av,
                    applied,
                    total,
                };
                return Err(Error::batch_failed(batch, e));
            }
        }
    }
    Ok((last, applied))
}

pub(crate) fn check_paths(paths: &[String]) -> Result<Vec<String>, Error> {
    if paths.is_empty() {
        return Err(Error::unsafe_argument("경로가 없다"));
    }
    check_each(paths)
}

fn check_each(paths: &[String]) -> Result<Vec<String>, Error> {
    paths
        .iter()
        .map(|p| core::rel_path(p, core::Kind::UnsafeArgument).map_err(Error::from))
        .collect()
}
