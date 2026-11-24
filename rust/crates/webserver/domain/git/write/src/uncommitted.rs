//! 커밋하지 않은 변경 전체를 되돌린다 (UNCOMMITTED_RESET_SRS).

use dm_gocompat::filepath;
use dm_webserver_domain_git_core::{self as core, Ctx, Hint, Output, Service};
use dm_webserver_domain_git_query as query;

use crate::commit::{argv, spec};
use crate::error::{Error, WriteKind, exec_write};
use crate::stage::{check_paths, exec_paths, literal};

pub fn uncommitted_reset_args() -> Vec<String> {
    argv(&["reset", "-q", "--mixed", "HEAD"])
}

pub fn clean_untracked_args() -> Vec<String> {
    argv(&["clean", "-q", "-f", "-d"])
}

pub async fn uncommitted_reset(s: &Service, ctx: &Ctx, repo: &str) -> Result<Output, Error> {
    if !query::has_head(s, ctx, repo).await? {
        return Err(Error::new(
            WriteKind::UncommittedNoHead,
            "커밋이 없어 HEAD 로 되돌릴 수 없다",
        ));
    }
    exec_write(s, ctx, repo, spec(uncommitted_reset_args(), false)).await
}

/// 확인한 목록과 지금의 추적되지 않는 파일이 정확히 같을 때만 지운다.
pub async fn clean_untracked(
    s: &Service,
    ctx: &Ctx,
    repo: &str,
    want: &[String],
) -> Result<Output, Error> {
    let want = check_paths(want)?;
    let st = query::status_of(s, ctx, repo).await?;
    if st.untracked.is_empty() {
        return Err(Error::new(
            WriteKind::NothingToClean,
            "추적되지 않는 파일이 없다",
        ));
    }
    let paths: Vec<String> = st.untracked.iter().map(|e| e.path.clone()).collect();
    let mut asked: Vec<&str> = Vec::new();
    for p in &want {
        if !paths.contains(p) {
            return Err(Error::new(
                WriteKind::CleanChanged,
                format!("{p} 는 지금 추적되지 않는 파일이 아니다"),
            ));
        }
        if !asked.contains(&p.as_str()) {
            asked.push(p);
        }
    }
    let now = {
        let mut v: Vec<&str> = paths.iter().map(String::as_str).collect();
        v.sort_unstable();
        v.dedup();
        v.len()
    };
    if asked.len() != now {
        return Err(Error::new(
            WriteKind::CleanChanged,
            format!(
                "확인한 뒤 추적되지 않는 파일이 {}개에서 {now}개가 됐다",
                asked.len()
            ),
        ));
    }
    s.add_hint(clean_hint(repo, &paths));
    let specs = literal(&paths);
    let lead = clean_untracked_args();
    let lead: Vec<&str> = lead.iter().map(String::as_str).collect();
    let res = exec_paths(s, ctx, repo, &specs, true, specs.len(), 0, &lead).await;
    remove_empty_parents(repo, &paths);
    res.map(|(o, _)| o)
}

/// 지운 파일이 남긴 빈 디렉터리를 저장소 루트 앞까지 걷어낸다.
pub(crate) fn remove_empty_parents(repo: &str, paths: &[String]) {
    let top = filepath::clean(repo);
    for p in paths {
        let mut dir = filepath::dir(&filepath::join(&[top.as_str(), &filepath::from_slash(p)]));
        while dir != top {
            if std::fs::remove_dir(&dir).is_err() {
                break;
            }
            dir = filepath::dir(&dir);
        }
    }
}

fn clean_hint(repo: &str, paths: &[String]) -> Hint {
    Hint {
        repo: repo.to_owned(),
        action: core::ACTION_CLEAN_UNTRACKED.to_owned(),
        targets: Some(paths.to_vec()),
        command: "git stash push -u".to_owned(),
        note: format!(
            "추적되지 않는 파일 {}개는 git 에 저장된 적이 없어 지운 뒤에는 되살릴 값이 없다. 지우기 전에 위 명령으로 담아 둘 수 있다.",
            paths.len()
        ),
        ..Hint::default()
    }
}
