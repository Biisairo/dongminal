//! 정리 (FR-WKT-8·12·18, WORKTREE_REMOVE_ALL_SRS FR-WRA-1~3, ISSUE_TREE_CLOSE_SRS FR-ITX-40~49).

use std::time::{Duration, Instant};

use otter_gocompat::filepath;
use otter_gocompat::strconv::quote;
use otter_webserver_domain_git_core::Ctx;
use serde::Serialize;

use crate::error::{Error, Kind};
use crate::lock::RepoLock;
use crate::manager::{Manager, check_abs_path};
use crate::naming::valid_ref;

/// 잔여물 사유 (FR-WKT-12). 정리하지 못한 자원은 반드시 이 중 하나로 보고된다.
pub const RESIDUE_DIRTY: &str = "dirty";
pub const RESIDUE_KEPT: &str = "kept";
pub const RESIDUE_UNSAFE_PATH: &str = "unsafe-path";
pub const RESIDUE_REMOVE_FAILED: &str = "remove-failed";
pub const RESIDUE_BRANCH_RETAINED: &str = "branch-retained";
pub const RESIDUE_UNMERGED: &str = "unmerged";

/// `git worktree remove` 의 되풀이 규칙이다 (FR-WKT-18). 예산은 되풀이 전체의 상한이다.
pub(crate) const REMOVE_RETRY_TRIES: usize = 6;
pub(crate) const REMOVE_RETRY_GAP: Duration = Duration::from_millis(250);
pub(crate) const REMOVE_RETRY_BUDGET: Duration = Duration::from_secs(3);

/// 정리 대상 하나다. keep 이면 보존만 하고 보고한다.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RemoveSpec {
    pub repo: String,
    pub path: String,
    pub branch: String,
    pub keep: bool,
    /// dirty 여도 지운다 — remove_listed 만 읽는다 (FR-WRA-3).
    pub force: bool,
    /// 잠금 키 — common-dir 키다.
    pub lock_key: String,
    /// branch 가 merge_into 의 조상일 때만 지운다 (FR-ITX-41).
    pub require_merged: bool,
    pub merge_into: String,
}

/// 정리 한 건의 결말이다. removed 가 false 면 residue 가 반드시 있다.
#[derive(Clone, Debug, Default, Serialize)]
pub struct RemoveResult {
    pub path: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub branch: String,
    pub removed: bool,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub residue: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub detail: String,
    /// 잠금을 얻지 못한 사유다 — 대기 상한(RepoBusy)·마감(core Timeout)·이탈(core Canceled).
    /// 그때는 아무것도 하지 않았다.
    #[serde(skip)]
    pub err: Option<Error>,
}

impl RemoveResult {
    fn residue(mut self, r: &str, detail: impl Into<String>) -> Self {
        self.residue = r.to_owned();
        self.detail = detail.into();
        self
    }
}

enum PathCheck {
    Area,
    Abs,
}

impl Manager {
    /// 정리 규칙 전부다 (FR-WKT-8). dirty 면 지우지 않고, clean 이면 worktree 를 지우고 브랜치는
    /// -d 로 지운다. 지우지 못한 것은 잔여물로 보고한다. force 는 무시한다.
    pub async fn remove(&self, ctx: &Ctx, s: &RemoveSpec) -> RemoveResult {
        let (res, _lock) = match self.prepare_remove(ctx, s, PathCheck::Area, true).await {
            Ok(v) => v,
            Err(res) => return res,
        };
        self.remove_locked(ctx, s, false, res).await
    }

    /// remove 와 같되 경로 인가가 영역이 아니라 등록이다 (FR-WRA-1~3) — `git worktree list` 에
    /// main 이 아닌 항목으로 있어야 한다. force 면 dirty 판정을 건너뛰고 `--force` 로 지운다.
    pub async fn remove_listed(&self, ctx: &Ctx, s: &RemoveSpec) -> RemoveResult {
        let (res, _lock) = match self.prepare_remove(ctx, s, PathCheck::Abs, false).await {
            Ok(v) => v,
            Err(res) => return res,
        };
        let entries = match self.list(ctx, &s.repo).await {
            Ok(e) => e,
            Err(e) => return res.residue(RESIDUE_REMOVE_FAILED, e.to_string()),
        };
        let target = filepath::clean(&s.path);
        match entries.iter().find(|e| e.path == target) {
            Some(e) if e.main => {
                res.residue(RESIDUE_UNSAFE_PATH, "main worktree 는 제거하지 않는다")
            }
            Some(_) => self.remove_locked(ctx, s, s.force, res).await,
            None => res.residue(
                RESIDUE_UNSAFE_PATH,
                format!("등록된 worktree 가 아니다: {}", quote(&s.path)),
            ),
        }
    }

    /// remove·remove_listed 의 같은 전처리다 (FR-RDG-60): 경로 인가, 저장소 자신의 거절,
    /// honor_keep 이면 keep 보존, 그리고 잠금.
    async fn prepare_remove(
        &self,
        ctx: &Ctx,
        s: &RemoveSpec,
        check: PathCheck,
        honor_keep: bool,
    ) -> Result<(RemoveResult, RepoLock), RemoveResult> {
        let res = RemoveResult {
            path: s.path.clone(),
            branch: s.branch.clone(),
            ..RemoveResult::default()
        };
        let checked = match check {
            PathCheck::Area => self.check_path(&s.path),
            PathCheck::Abs => check_abs_path(&s.path),
        };
        if let Err(e) = checked {
            return Err(res.residue(RESIDUE_UNSAFE_PATH, e.to_string()));
        }
        if !s.repo.is_empty() && filepath::clean(&s.path) == filepath::clean(&s.repo) {
            return Err(res.residue(RESIDUE_UNSAFE_PATH, "저장소 자신은 제거하지 않는다"));
        }
        if honor_keep && s.keep {
            return Err(res.residue(RESIDUE_KEPT, ""));
        }
        match self.lock(ctx, &s.lock_key, &s.repo).await {
            Ok(lock) => Ok((res, lock)),
            Err(e) => {
                let mut res = res.residue(RESIDUE_REMOVE_FAILED, e.to_string());
                res.err = Some(e);
                Err(res)
            }
        }
    }

    /// 인가가 끝나고 잠금을 쥔 뒤의 정리 흐름이다 (FR-WKT-8).
    async fn remove_locked(
        &self,
        ctx: &Ctx,
        s: &RemoveSpec,
        force: bool,
        mut res: RemoveResult,
    ) -> RemoveResult {
        // FR-ITX-49: 경로도 브랜치도 없으면 이미 정리됐다.
        let missing = matches!(std::fs::metadata(&s.path), Err(e) if e.kind() == std::io::ErrorKind::NotFound);
        if missing && !self.branch_exists_of(ctx, s).await {
            self.prune(ctx, &s.repo).await;
            res.removed = true;
            return res;
        }
        if s.require_merged
            && let Some(detail) = self.unmerged_detail(ctx, s).await
        {
            return res.residue(RESIDUE_UNMERGED, detail);
        }
        if missing {
            // 경로가 이미 없다 — 등록만 남았을 수 있으므로 정리하고 성공으로 본다.
            self.prune(ctx, &s.repo).await;
            res.removed = true;
            self.delete_branch(ctx, s, &mut res).await;
            return res;
        }
        if !force {
            match self.is_dirty(ctx, &s.path).await {
                Err(e) => return res.residue(RESIDUE_REMOVE_FAILED, e.to_string()),
                Ok(true) => return res.residue(RESIDUE_DIRTY, ""),
                Ok(false) => {}
            }
        }
        if let Err(e) = self.remove_with_retry(ctx, s, force).await {
            // 조회·제거 실패를 "사라졌다"의 증거로 쓰지 않는다 — prune 뒤 재확인한다.
            if !self.prune_and_check_gone(ctx, &s.repo, &s.path).await {
                return res.residue(RESIDUE_REMOVE_FAILED, e.to_string());
            }
        }
        res.removed = true;
        self.delete_branch(ctx, s, &mut res).await;
        res
    }

    /// `git worktree remove` 를 잠깐 되풀이한다 (FR-WKT-18) — Windows 에서 우리 자신의 관측이
    /// 폴더를 붙들고 있는 짧은 틈을 넘기 위해서다. 예산이 있고 ctx 로 끊긴다 (M8 GO-12).
    async fn remove_with_retry(&self, ctx: &Ctx, s: &RemoveSpec, force: bool) -> Result<(), Error> {
        let mut args = vec!["worktree", "remove"];
        if force {
            args.push("--force");
        }
        args.push(&s.path);
        let start = Instant::now();
        let mut last = Error::other("");
        for i in 0..REMOVE_RETRY_TRIES {
            match self.git(ctx, &s.repo, &args).await {
                Ok(_) => return Ok(()),
                Err(f) => last = f.err,
            }
            if i == REMOVE_RETRY_TRIES - 1 || start.elapsed() > REMOVE_RETRY_BUDGET {
                return Err(last);
            }
            tokio::select! {
                _ = ctx.done() => {
                    let why = ctx.err().map(|e| e.to_string()).unwrap_or_default();
                    return Err(last.suffix(format!(" (요청이 끊겨 되풀이를 접었다: {why})")));
                }
                _ = tokio::time::sleep(REMOVE_RETRY_GAP) => {}
            }
        }
        Err(last)
    }

    /// 머지된 브랜치만 지운다. 남으면 잔여물이다. 호출자는 잠금을 쥐고 있다.
    async fn delete_branch(&self, ctx: &Ctx, s: &RemoveSpec, res: &mut RemoveResult) {
        if s.repo.is_empty() || valid_ref(&s.branch).is_err() {
            return;
        }
        // FR-ITX-42: 병합 대상의 조상임을 이미 확인했으면 -D 로 잃는 것이 없다.
        let flag = if s.require_merged { "-D" } else { "-d" };
        if let Err(f) = self.git(ctx, &s.repo, &["branch", flag, &s.branch]).await {
            let r = format!("refs/heads/{}", s.branch);
            if self
                .git(ctx, &s.repo, &["rev-parse", "--verify", "--quiet", &r])
                .await
                .is_ok()
            {
                res.residue = RESIDUE_BRANCH_RETAINED.to_owned();
                res.detail = f.err.to_string();
            }
        }
    }

    async fn branch_exists_of(&self, ctx: &Ctx, s: &RemoveSpec) -> bool {
        self.branch_exists(ctx, &s.repo, &s.branch).await
    }

    /// 사람이 잃을 수 있는 것이 있는가 — 추적되지 않는 파일도 포함한다.
    pub(crate) async fn is_dirty(&self, ctx: &Ctx, path: &str) -> Result<bool, Error> {
        let out = self
            .git(ctx, path, &["status", "--porcelain"])
            .await
            .map_err(|f| f.err)?;
        Ok(!out.trim().is_empty())
    }

    /// 디스크에서 사라진 worktree 의 등록을 걷는다. 실패는 무시한다.
    async fn prune(&self, ctx: &Ctx, repo: &str) {
        let _ = self.git(ctx, repo, &["worktree", "prune"]).await;
    }

    pub(crate) async fn prune_and_check_gone(&self, ctx: &Ctx, repo: &str, path: &str) -> bool {
        self.prune(ctx, repo).await;
        self.gone(ctx, repo, path).await
    }

    /// path 가 등록에도 디스크에도 없는가. 확인할 수 없으면 사라졌다고 단정하지 않는다.
    pub(crate) async fn gone(&self, ctx: &Ctx, repo: &str, path: &str) -> bool {
        if std::fs::metadata(path).is_ok() {
            return false;
        }
        match self.list(ctx, repo).await {
            Ok(entries) => !entries.iter().any(|e| e.path == path),
            Err(_) => false,
        }
    }

    /// branch 가 merge_into 의 조상이 아닌 사유다. 조상이면 None 이다 (FR-ITX-41·44).
    async fn unmerged_detail(&self, ctx: &Ctx, s: &RemoveSpec) -> Option<String> {
        if s.merge_into.is_empty() {
            return Some("병합 대상을 모른다".to_owned());
        }
        if valid_ref(&s.branch).is_err() || valid_ref(&s.merge_into).is_err() {
            return Some(format!(
                "병합을 판정할 수 없는 이름: {} → {}",
                quote(&s.branch),
                quote(&s.merge_into)
            ));
        }
        let args = ["merge-base", "--is-ancestor", &s.branch, &s.merge_into];
        if self.git(ctx, &s.repo, &args).await.is_err() {
            return Some(format!(
                "{} 가 {} 에 병합되지 않았다",
                s.branch, s.merge_into
            ));
        }
        None
    }

    /// dir 이 속한 저장소의 메인 worktree 경로다 (FR-ITX-47).
    pub async fn main_root(&self, ctx: &Ctx, dir: &str) -> Result<String, Error> {
        let entries = self.list(ctx, dir).await?;
        match entries.into_iter().find(|e| e.main) {
            Some(e) => Ok(e.path),
            None => Err(Error::new(
                Kind::NotRepo,
                format!("{dir} 의 메인 worktree 가 없다"),
            )),
        }
    }

    /// dir 의 현재 브랜치 이름이다. 분리된 HEAD 이거나 저장소가 아니면 빈 값이다 (FR-ITX-40).
    pub async fn current_branch(&self, ctx: &Ctx, dir: &str) -> String {
        self.git(ctx, dir, &["symbolic-ref", "--quiet", "--short", "HEAD"])
            .await
            .map(|o| o.trim().to_owned())
            .unwrap_or_default()
    }
}
