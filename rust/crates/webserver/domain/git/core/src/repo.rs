//! 저장소 루트 (FR-GIT-8/9).

use otter_gocompat::{filepath, strconv::quote};

use crate::ctx::Ctx;
use crate::error::{Error, Kind};
use crate::exec::Service;

impl Service {
    /// cwd 가 속한 저장소의 루트 절대경로를 확정한다. 저장소가 아니면 NotRepo 다.
    /// 심링크 차이는 정규화하지 않고, OS 형태로 옮겨서 내보낸다 (FR-WTP-3).
    pub async fn repo_root(&self, ctx: &Ctx, cwd: &str) -> Result<String, Error> {
        let out = self
            .exec(ctx, cwd, &["rev-parse", "--show-toplevel"])
            .await?;
        let stdout = out.stdout_str();
        let top = stdout.trim();
        if top.is_empty() {
            return Err(Error::new(
                Kind::NotRepo,
                format!("{cwd} 는 git 저장소가 아니다"),
            ));
        }
        if !filepath::is_abs(top) {
            return Err(Error::new(
                Kind::NotRepo,
                format!("rev-parse 가 절대경로를 주지 않았다: {}", quote(top)),
            ));
        }
        Ok(filepath::clean(top))
    }
}
