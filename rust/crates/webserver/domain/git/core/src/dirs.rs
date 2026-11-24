//! gitdir 과 common-dir.

use otter_gocompat::filepath;

use crate::ctx::Ctx;
use crate::error::{Error, Kind};
use crate::exec::Service;

impl Service {
    /// 리포의 gitdir 과 common-dir 을 준다. worktree 에서는 둘이 다르다. 둘째 줄이
    /// 상대경로면 repo 기준으로 절대화한다.
    pub async fn git_dirs(&self, ctx: &Ctx, repo: &str) -> Result<(String, String), Error> {
        let out = self
            .exec(
                ctx,
                repo,
                &["rev-parse", "--absolute-git-dir", "--git-common-dir"],
            )
            .await?;
        let lines = split_lines(&out.stdout_str());
        let Some(git_dir) = lines.first().cloned() else {
            return Err(Error::new(
                Kind::NotRepo,
                format!("rev-parse 가 gitdir 을 주지 않았다: {repo}"),
            ));
        };
        let mut common = lines.get(1).cloned().unwrap_or_else(|| git_dir.clone());
        if !filepath::is_abs(&common) {
            common = filepath::join(&[repo, common.as_str()]);
        }
        Ok((git_dir, common))
    }
}

/// 빈 줄을 버리고 각 줄을 다듬는다.
fn split_lines(s: &str) -> Vec<String> {
    s.split('\n')
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(str::to_owned)
        .collect()
}
