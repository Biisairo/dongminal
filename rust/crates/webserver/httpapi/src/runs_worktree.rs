//! 묶음 W — 격리 Run 의 작업 트리 준비·정리 (Go `handlers_runs_worktree.go`,
//! RUN_ORCHESTRATION_SRS FR-WKT-*).
//!
//! 준비는 레코드보다 먼저다 — 실패한 Run·멤버는 기록에 남지 않는다 (FR-WKT-3/11). 정리는 잔여를
//! 숨기지 않고 결과로 낸다.

use otter_shared_otterlog::{errorf, infof};
use otter_webserver_domain_git_core as core;
use otter_webserver_domain_run::{self as run, Record};
use otter_webserver_domain_worktree::{self as worktree, RemoveResult, RemoveSpec, Spec};

use crate::Server;
use crate::runs::{Rt, RunFail, block};

/// 사용 중인 트리를 지우지 않았을 때의 설명이다 (Go `runTreeBusyDetail`).
const RUN_TREE_BUSY_DETAIL: &str = "사용 중인 worktree — 작업이 끝난 뒤 정리";

/// Go `runIsolation`: 격리 Run 의 준비 결과.
pub(crate) struct RunIsolation {
    pub(crate) id: String,
    pub(crate) repo: String,
    pub(crate) base: String,
    /// 트리 Run 정리의 병합 검사 대상 브랜치 (FR-ITX-*).
    pub(crate) merge_into: String,
    pub(crate) worktree: Option<run::Worktree>,
    /// 롤백 대상 (per-run 일 때만).
    spec: Spec,
}

/// Go `memberIsolation`: 멤버 하나의 격리 준비 결과.
#[derive(Default)]
pub(crate) struct MemberIsolation {
    pub(crate) id: String,
    pub(crate) worktree: Option<run::Worktree>,
    spec: Spec,
    created: bool,
}

impl Server {
    /// Go `commonKey`: 저장소의 common-dir 배타 키다 (REPO_FIX 01 §5.1).
    fn common_key(&self, rt: &Rt, repo: &str) -> Result<String, RunFail> {
        let ctx = rt.git();
        match &self.deps.git_store {
            None => rt
                .wait(core::common_dir_key(None, &ctx, repo))
                .map_err(RunFail::of),
            Some(g) => {
                let common = rt.wait(g.common_dir(&ctx, repo)).map_err(RunFail::of)?;
                Ok(core::exclusion_key(&common))
            }
        }
    }

    /// Go `provisionRun`: none 이면 아무것도 만들지 않는다. 관리자가 없으면 조용히 none 으로
    /// 낮추지 않고 거절한다 (FR-WKT-11).
    pub(crate) fn provision_run(
        &self,
        rt: &Rt,
        iso: &str,
        cwd: &str,
        base: &str,
    ) -> Result<Option<RunIsolation>, RunFail> {
        if iso.is_empty() || iso == run::ISOLATION_NONE {
            return Ok(None);
        }
        let Some(wt) = &self.deps.worktrees else {
            return Err(RunFail::isolation("이 서버에는 worktree 관리자가 없다"));
        };
        let ctx = rt.git();
        let repo = rt.wait(wt.resolve(&ctx, cwd, base)).map_err(RunFail::of)?;
        let mut root = repo.root.clone();
        if let Ok(main) = rt.wait(wt.main_root(&ctx, &repo.root))
            && !main.is_empty()
        {
            root = main;
        }
        let mut out = RunIsolation {
            id: otter_shared_uuid::new_string(),
            repo: root,
            base: repo.base.clone(),
            merge_into: rt.wait(wt.current_branch(&ctx, cwd)),
            worktree: None,
            spec: Spec::default(),
        };
        if iso != run::ISOLATION_PER_RUN {
            return Ok(Some(out));
        }
        let slug = run::path_slug(&out.id);
        let key = self.common_key(rt, &out.repo)?;
        let spec = Spec {
            repo: out.repo.clone(),
            path: wt.path(&slug, "run"),
            branch: self.free_branch(rt, &out.repo, &slug, "run", "run"),
            base: repo.base,
            lock_key: key,
        };
        rt.wait(wt.create(&ctx, &spec)).map_err(RunFail::of)?;
        out.worktree = Some(run::Worktree {
            path: spec.path.clone(),
            branch: spec.branch.clone(),
            base: spec.base.clone(),
            ..run::Worktree::default()
        });
        out.spec = spec;
        Ok(Some(out))
    }

    /// Go `rollbackRun`: 레코드 생성에 실패한 Run 의 트리를 되돌린다.
    pub(crate) fn rollback_run(&self, iso: Option<&RunIsolation>) {
        let (Some(iso), Some(wt)) = (iso, &self.deps.worktrees) else {
            return;
        };
        if iso.worktree.is_none() {
            return;
        }
        errorf!(
            None,
            "[run] 격리 롤백 — 레코드 생성 실패: {}",
            iso.spec.path
        );
        block(wt.rollback(&core::Ctx::background(), &iso.spec));
    }

    /// Go `provisionMember`: per-member 는 멤버마다 트리를 만들고, per-run 은 공유 트리를 쓴다.
    pub(crate) fn provision_member(
        &self,
        rt: &Rt,
        rec: &Record,
        role: &str,
    ) -> Result<MemberIsolation, RunFail> {
        match rec.isolation.as_str() {
            "" | run::ISOLATION_NONE => return Ok(MemberIsolation::default()),
            run::ISOLATION_PER_RUN => {
                let Some(wt) = &rec.worktree else {
                    return Err(RunFail::isolation("per-run Run 에 공유 트리가 없다"));
                };
                return Ok(MemberIsolation {
                    worktree: Some(wt.clone()),
                    ..MemberIsolation::default()
                });
            }
            _ => {}
        }
        let Some(wt) = self
            .deps
            .worktrees
            .as_ref()
            .filter(|_| !rec.repo.is_empty())
        else {
            return Err(RunFail::isolation("이 Run 의 저장소를 알 수 없다"));
        };
        let id = otter_shared_uuid::new_string();
        let slug = run::path_slug(&id);
        let key = self.common_key(rt, &rec.repo)?;
        let run_slug = run::path_slug(&rec.id);
        let spec = Spec {
            repo: rec.repo.clone(),
            path: wt.path(&run_slug, &slug),
            branch: self.free_branch(rt, &rec.repo, &run_slug, role, &slug),
            base: rec.base.clone(),
            lock_key: key,
        };
        rt.wait(wt.create(&rt.git(), &spec)).map_err(RunFail::of)?;
        Ok(MemberIsolation {
            id,
            worktree: Some(run::Worktree {
                path: spec.path.clone(),
                branch: spec.branch.clone(),
                base: spec.base.clone(),
                ..run::Worktree::default()
            }),
            spec,
            created: true,
        })
    }

    /// Go `rollbackMember`.
    pub(crate) fn rollback_member(&self, mi: &MemberIsolation) {
        let Some(wt) = &self.deps.worktrees else {
            return;
        };
        if !mi.created {
            return;
        }
        errorf!(None, "[run] 격리 롤백 — 멤버 등록 실패: {}", mi.spec.path);
        block(wt.rollback(&core::Ctx::background(), &mi.spec));
    }

    /// Go `freeBranch`: 같은 이름의 브랜치가 있으면 fallback 을 붙인 이름을 쓴다.
    fn free_branch(
        &self,
        rt: &Rt,
        repo: &str,
        run_short: &str,
        role: &str,
        fallback: &str,
    ) -> String {
        let name = worktree::branch(run_short, role, fallback);
        let Some(wt) = &self.deps.worktrees else {
            return name;
        };
        if !rt.wait(wt.branch_exists(&rt.git(), repo, &name)) {
            return name;
        }
        worktree::branch(run_short, &format!("{role}-{fallback}"), fallback)
    }

    /// Go `removeRunTree`: 쓰기·잡이 쓰는 트리는 지우지 않는다 (REPO_FIX 01 §5.4).
    async fn remove_run_tree(&self, ctx: &core::Ctx, spec: &RemoveSpec) -> RemoveResult {
        let Some(wt) = &self.deps.worktrees else {
            return RemoveResult::default();
        };
        let Some(x) = &self.deps.git_exclusion else {
            return wt.remove(ctx, spec).await;
        };
        let busy = RemoveResult {
            path: spec.path.clone(),
            branch: spec.branch.clone(),
            residue: worktree::RESIDUE_REMOVE_FAILED.to_owned(),
            detail: RUN_TREE_BUSY_DETAIL.to_owned(),
            ..RemoveResult::default()
        };
        let top = core::exclusion_key(&spec.path);
        if x.index_busy(&top).is_some() {
            return busy;
        }
        let Some(_release) = x.try_lock_top(&top) else {
            return busy;
        };
        wt.remove(ctx, spec).await
    }

    /// Go `cleanupWorktrees`: 정리 결과를 레코드에 남기고 돌려준다. 관리자가 없으면 모두 잔여다.
    pub(crate) fn cleanup_worktrees(&self, rt: &Rt, rec: &Record, keep: bool) -> Vec<RemoveResult> {
        let targets = rec.worktree_targets();
        if targets.is_empty() {
            return Vec::new();
        }
        let Some(wt) = &self.deps.worktrees else {
            return targets
                .iter()
                .map(|t| RemoveResult {
                    path: t.path.clone(),
                    branch: t.branch.clone(),
                    residue: worktree::RESIDUE_REMOVE_FAILED.to_owned(),
                    detail: "worktree 관리자가 없다".to_owned(),
                    ..RemoveResult::default()
                })
                .collect();
        };
        let ctx = rt.git();
        let repo = self.cleanup_repo(rt, &rec.repo, &targets);
        let key = self.common_key(rt, &repo).unwrap_or_default();
        let mut out = Vec::with_capacity(targets.len());
        for t in &targets {
            let spec = RemoveSpec {
                repo: repo.clone(),
                path: t.path.clone(),
                branch: t.branch.clone(),
                keep,
                lock_key: key.clone(),
                require_merged: !rec.tree.is_empty(),
                merge_into: rec.merge_into.clone(),
                ..RemoveSpec::default()
            };
            // 보존은 지우지 않으므로 사용 중인지 볼 것이 없다.
            let res = if keep {
                rt.wait(wt.remove(&ctx, &spec))
            } else {
                rt.wait(self.remove_run_tree(&ctx, &spec))
            };
            if !res.removed {
                infof!(
                    None,
                    "[run] worktree 잔여물 run={} path={} residue={} detail={}",
                    rec.short,
                    res.path,
                    res.residue,
                    res.detail
                );
            }
            out.push(res);
        }
        let marks: Vec<run::WorktreeMark> = out
            .iter()
            .map(|r| run::WorktreeMark {
                path: r.path.clone(),
                removed: r.removed,
                residue: r.residue.clone(),
                detail: r.detail.clone(),
            })
            .collect();
        if let Some(st) = self.runs()
            && let Err(e) = st.mark_worktrees(&rec.id, &marks)
        {
            errorf!(None, "[run] 정리 결과 기록 실패 run={}: {e}", rec.short);
        }
        out
    }

    /// Go `cleanupRepo`: 기록된 저장소가 사라졌으면 남은 트리에서 주 작업 트리를 찾는다.
    fn cleanup_repo(&self, rt: &Rt, repo: &str, targets: &[run::Worktree]) -> String {
        if std::fs::metadata(repo).is_ok() {
            return repo.to_owned();
        }
        let Some(wt) = &self.deps.worktrees else {
            return repo.to_owned();
        };
        for t in targets {
            if let Ok(main) = rt.wait(wt.main_root(&rt.git(), &t.path))
                && !main.is_empty()
            {
                return main;
            }
        }
        repo.to_owned()
    }
}

/// Go `worktreeResidue`: 지우지 못한 트리 수.
pub(crate) fn worktree_residue(trees: &[RemoveResult]) -> i64 {
    trees.iter().filter(|t| !t.removed).count() as i64
}
