//! /api/git/worktrees{,/create,/remove} — Worktrees 탭 (GIT_REVIEW4_SRS §3.6.5 FR-GIT-240~243).
//! Go `handlers_git_worktree.go`.
//!
//! worktree 의 git 실행은 전부 worktree 도메인(사용자 영역 관리자)을 지난다 (FR-GIT-246).

use std::collections::BTreeMap;
use std::io;
use std::sync::{Arc, Mutex};

use http::StatusCode;
use otter_gocompat::filepath;
use otter_gocompat::oserr;
use otter_shared_httpresp::Response;
use otter_webserver_action::{self as action, Answer, deny};
use otter_webserver_apierr as apierr;
use otter_webserver_domain_git_core::{self as core, Ctx, PRE_PHASE_TIMEOUT};
use otter_webserver_domain_git_jobs::{
    self as jobs, Job, JobResult, Keys, SLOT_COMMON, SLOT_INDEX,
};
use otter_webserver_domain_worktree::{
    self as worktree, Entry, RemoveResult, RemoveSpec, RepoLock, Spec,
};
use serde::{Deserialize, Serialize};

use crate::GitServer;
use crate::answers::{SlotReader, slots_answer};
use crate::job::job_succeeded;
use crate::reply::{ERR_UNAVAILABLE, Obj, WErr, git_error, git_fail, git_json, obj};
use crate::req::Req;

const OWNER_USER: &str = "user";
const OWNER_RUN: &str = "run";
const OWNER_OUTSIDE: &str = "outside";
const PARENT_DIR_PERM: u32 = 0o755;
const CONFLICT: u16 = 409;

pub(crate) fn git_worktrees_unavailable() -> Response {
    git_fail(
        StatusCode::SERVICE_UNAVAILABLE,
        ERR_UNAVAILABLE,
        "사용자 worktree 관리자가 구성되지 않았다",
    )
}

/// worktree 가 누구의 영역에 있는가다 (FR-GIT-240).
fn worktree_owner(path: &str, user_root: &str, run_root: &str) -> &'static str {
    if under_root(path, user_root) {
        OWNER_USER
    } else if under_root(path, run_root) {
        OWNER_RUN
    } else {
        OWNER_OUTSIDE
    }
}

fn under_root(path: &str, root: &str) -> bool {
    if root.is_empty() {
        return false;
    }
    let prefix = format!("{root}{}", std::path::MAIN_SEPARATOR);
    filepath::clean(path).starts_with(&prefix)
}

#[derive(Serialize)]
struct WorktreeEntry {
    path: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    branch: String,
    detached: bool,
    owner: &'static str,
    main: bool,
    actions: BTreeMap<String, Answer>,
}

#[derive(Default, Deserialize)]
#[serde(default, rename = "gitapi.gitWorktreeCreateReq")]
struct WorktreeCreateReq {
    repo: String,
    name: String,
    r#ref: String,
    #[serde(rename = "newBranch")]
    new_branch: bool,
}

#[derive(Default, Deserialize)]
#[serde(default, rename = "gitapi.gitWorktreeRemoveReq")]
struct WorktreeRemoveReq {
    repo: String,
    path: String,
    #[serde(rename = "deleteBranch")]
    delete_branch: bool,
    confirm: bool,
    force: bool,
}

/// worktree 제거의 칸 판정이다. common 칸을 쥔 잡이 worktree 잡이면 막고, 그 밖에는 대상의 index
/// 칸을 본다 (GR-1a).
pub(crate) fn worktree_remove_answer(
    x: &impl SlotReader,
    common: &str,
    job_kind: impl Fn(&str) -> String,
    target: &str,
) -> Answer {
    if let Some(id) = x.common_busy(common)
        && job_kind(&id) == "worktree"
    {
        return deny(
            CONFLICT,
            apierr::CODE_JOB_BUSY,
            Some(BTreeMap::from([("job".to_owned(), id.into())])),
        );
    }
    let keys = Keys {
        top: core::exclusion_key(target),
        ..Keys::default()
    };
    slots_answer(x, &keys, &[SLOT_INDEX])
}

/// 목록에서 대상을 찾는다. 브랜치는 지우라고 했을 때만 준다.
fn listed_worktree_branch(entries: &[Entry], target: &str, delete_branch: bool) -> (String, bool) {
    match entries.iter().find(|e| e.path == target) {
        None => (String::new(), false),
        Some(_) if !delete_branch => (String::new(), true),
        Some(e) => (e.branch.clone(), true),
    }
}

fn worktree_remove_body(res: &RemoveResult) -> Obj {
    obj! {
        "path" => res.path, "branch" => res.branch,
        "removed" => res.removed, "residue" => res.residue, "detail" => res.detail,
    }
}

/// 없는 조상 디렉터리를 만들고, 새로 만든 것들을 깊은 것부터 돌려준다 — 등록이 실패하면 그것만
/// 지운다.
fn mkdir_parents(dir: &str) -> io::Result<Vec<String>> {
    let mut missing = Vec::new();
    let mut p = filepath::clean(dir);
    loop {
        if std::fs::metadata(&p).is_ok() {
            break;
        }
        missing.push(p.clone());
        let parent = filepath::dir(&p);
        if parent == p {
            break;
        }
        p = parent;
    }
    oserr::mkdir_all(dir, PARENT_DIR_PERM)?;
    Ok(missing)
}

/// 생성이 잡으로 등록되지 않고 끝나면 잠금을 놓고 만든 디렉터리를 지운다 (Go 의 defer).
struct CreateGuard {
    lock: Arc<Mutex<Option<RepoLock>>>,
    made: Vec<String>,
    registered: bool,
}

impl Drop for CreateGuard {
    fn drop(&mut self) {
        if self.registered {
            return;
        }
        self.lock.lock().unwrap_or_else(|e| e.into_inner()).take();
        for p in &self.made {
            let _ = std::fs::remove_dir(p);
        }
    }
}

impl GitServer {
    /// 잡 id 의 종류다. git 이 없으면 도는 잡도 없다.
    pub(crate) fn git_job_kind(&self, id: &str) -> String {
        let Some(git) = &self.git else {
            return String::new();
        };
        self.jobs_hub(git)
            .get(id)
            .map(|jb| jb.kind)
            .unwrap_or_default()
    }

    /// GET /api/git/worktrees?repo= — 그 저장소의 worktree 전부와 소유 (FR-GIT-240·241).
    pub(crate) async fn api_git_worktrees(&self, r: &mut Req) -> Response {
        let Some(wt) = self.user_worktrees.clone() else {
            return git_worktrees_unavailable();
        };
        let (_, root, requested) = match self.git_repo_param(r).await {
            Ok(v) => v,
            Err(res) => return res,
        };
        let ctx = r.ctx.with_timeout(PRE_PHASE_TIMEOUT);
        let res = self.git_worktree_list(&ctx, wt.as_ref(), &root).await;
        ctx.cancel();
        match res {
            Ok(out) => git_json(
                StatusCode::OK,
                &obj! {"repo" => root, "requested" => requested, "worktrees" => out},
            ),
            Err(res) => res,
        }
    }

    async fn git_worktree_list(
        &self,
        ctx: &Ctx,
        wt: &dyn worktree::Service,
        root: &str,
    ) -> Result<Vec<WorktreeEntry>, Response> {
        let entries = wt.list(ctx, root).await.map_err(|e| git_error(&e))?;
        let keys = self.job_keys(ctx, root).await.map_err(|e| git_error(&*e))?;
        let x = self.exclusion();
        let user_root = wt.root().to_owned();
        Ok(entries
            .into_iter()
            .map(|e| {
                let a =
                    worktree_remove_answer(&x, &keys.common, |id| self.git_job_kind(id), &e.path);
                WorktreeEntry {
                    owner: worktree_owner(&e.path, &user_root, &self.run_worktree_root),
                    path: e.path,
                    branch: e.branch,
                    detached: e.detached,
                    main: e.main,
                    actions: BTreeMap::from([(action::GIT_WORKTREE_REMOVE.to_owned(), a)]),
                }
            })
            .collect())
    }

    /// POST /api/git/worktrees/create — 사용자 영역에 worktree 를 만든다 (FR-GIT-242). 잡이다 —
    /// 저장소 잠금은 잡이 끝날 때 놓는다.
    pub(crate) async fn api_git_worktree_create(&self, r: &mut Req) -> Response {
        let available = self.user_worktrees.is_some();
        let (mut t, req) = self
            .begin_service_write::<WorktreeCreateReq>(r, available, git_worktrees_unavailable)
            .await;
        let a = worktree_input_answer(&req.name, &req.r#ref);
        if !a.ok && !t.stop() {
            t.reject_answer(&a, None);
        }
        t.resolve(&req.repo).await;
        if t.stop() {
            return t.finish();
        }
        let Some(wt) = self.user_worktrees.clone() else {
            return git_worktrees_unavailable();
        };
        let keys = match self.job_keys(&t.ctx(), &t.root).await {
            Ok(k) => k,
            Err(e) => {
                t.reject(&*e);
                return t.finish();
            }
        };
        t.keys = keys.clone();
        let a = slots_answer(&self.exclusion(), &keys, &[SLOT_COMMON]);
        if !a.ok {
            t.reject_answer(&a, None);
            return t.finish();
        }
        let lock = match worktree::lock_repo(&t.ctx(), &keys.common, self.git_lock_wait()).await {
            Ok(l) => l,
            Err(e) => {
                t.reject(&e);
                return t.finish();
            }
        };
        let mut guard = CreateGuard {
            lock: Arc::new(Mutex::new(Some(lock))),
            made: Vec::new(),
            registered: false,
        };
        let path = wt.path(&worktree::repo_bucket(&t.root), &req.name);
        let a = self
            .worktree_place_answer(&t.ctx(), &t.root, &path, &req.name, req.new_branch)
            .await;
        if !a.ok {
            t.reject_answer(&a, None);
            return t.finish();
        }
        let spec = Spec {
            repo: t.root.clone(),
            path: path.clone(),
            base: req.r#ref.clone(),
            lock_key: keys.common.clone(),
            branch: if req.new_branch {
                req.name.clone()
            } else {
                String::new()
            },
        };
        let add = match wt.add_spec(&spec) {
            Ok(a) => a,
            Err(e) => {
                t.reject(&e);
                return t.finish();
            }
        };
        match mkdir_parents(&filepath::dir(&path)) {
            Ok(made) => guard.made = made,
            Err(e) => {
                t.reject(&e);
                return t.finish();
            }
        }
        let held = Arc::clone(&guard.lock);
        let finish: jobs::Finisher = Box::new(move |ctx: Ctx, mut jb: Job| {
            Box::pin(async move {
                if job_succeeded(&jb) {
                    if ctx.err().is_none() {
                        wt.configure(&ctx, &spec).await;
                    }
                    jb.result = Some(JobResult {
                        path: spec.path.clone(),
                        branch: spec.branch.clone(),
                        ..JobResult::default()
                    });
                }
                held.lock().unwrap_or_else(|e| e.into_inner()).take();
                jb
            })
        });
        let root = t.root.clone();
        let registered = &mut guard.registered;
        t.launch_job(
            "worktree",
            move |h, k| {
                let jb = h.start_unguarded(
                    &root,
                    k,
                    "worktree",
                    add.argv,
                    &add.reason,
                    jobs::on_finish(finish),
                );
                *registered = jb.is_ok();
                jb
            },
            None,
        )
        .await;
        drop(guard);
        t.finish()
    }

    /// POST /api/git/worktrees/remove — 이 저장소의 worktree 하나를 지운다 (FR-GIT-243). 목록에
    /// 있는 것만 지운다.
    pub(crate) async fn api_git_worktree_remove(&self, r: &mut Req) -> Response {
        let available = self.user_worktrees.is_some();
        let (mut t, req) = self
            .begin_service_write::<WorktreeRemoveReq>(r, available, git_worktrees_unavailable)
            .await;
        t.require_confirm(
            true,
            req.confirm,
            "worktree 제거는 확인을 요구한다: confirm:true (FR-GIT-243)",
        );
        t.resolve(&req.repo).await;
        if t.stop() {
            return t.finish();
        }
        let Some(wt) = self.user_worktrees.clone() else {
            return git_worktrees_unavailable();
        };
        let keys = match self.job_keys(&t.ctx(), &t.root).await {
            Ok(k) => k,
            Err(e) => {
                t.reject(&*e);
                return t.finish();
            }
        };
        let x = self.exclusion();
        let entries = match wt.list(&t.ctx(), &t.root).await {
            Ok(e) => e,
            Err(e) => {
                t.reject(&e);
                return t.finish();
            }
        };
        let target = filepath::clean(&req.path);
        let (branch, found) = listed_worktree_branch(&entries, &target, req.delete_branch);
        if !found {
            t.reject_with(
                StatusCode::NOT_FOUND,
                apierr::CODE_NOT_FOUND,
                &format!("이 저장소의 worktree 가 아니다: {}", req.path),
            );
            return t.finish();
        }
        let busy = |t: &mut crate::write::GitWrite<'_>| {
            let a = worktree_remove_answer(&x, &keys.common, |id| self.git_job_kind(id), &target);
            if !a.ok {
                t.reject_answer(&a, None);
            }
            !a.ok
        };
        if busy(&mut t) {
            return t.finish();
        }
        let top = core::exclusion_key(&target);
        let _unlock = match x.lock_top(&t.r.ctx, &top, self.git_lock_wait()).await {
            Ok(rel) => rel,
            Err(e) => {
                t.reject(&e);
                return t.finish();
            }
        };
        if busy(&mut t) {
            return t.finish();
        }
        let rs = RemoveSpec {
            repo: t.root.clone(),
            path: req.path.clone(),
            branch,
            lock_key: keys.common.clone(),
            force: req.force,
            ..RemoveSpec::default()
        };
        let mut res = RemoveResult::default();
        let out = &mut res;
        let (ran, err) = t
            .write_within(self.git_manager_write(), |ctx| async move {
                let mut got = wt.remove_listed(&ctx, &rs).await;
                let err = got.err.take();
                *out = got;
                match err {
                    Some(e) => Err(WErr::from(e)),
                    None => Ok(()),
                }
            })
            .await;
        if !ran {
            return t.finish();
        }
        if let Some(e) = err {
            t.reject(&*e);
            return t.finish();
        }
        t.ok_plain(Some(&worktree_remove_body(&res)));
        t.finish()
    }
}

/// 이름·ref 입력의 판정이다 (GV-c).
pub(crate) fn worktree_input_answer(name: &str, r: &str) -> Answer {
    use crate::answers::{blank, err_answer};
    if blank(name) {
        return deny(400, apierr::CODE_EMPTY_NAME, None);
    }
    if let Err(e) = worktree::check_name(name) {
        return err_answer(Some(&e));
    }
    if blank(r) {
        return deny(400, apierr::CODE_EMPTY_REF, None);
    }
    action::allow()
}

impl GitServer {
    /// 만들 자리가 비었는가, 새 브랜치 이름이 비었는가다.
    pub(crate) async fn worktree_place_answer(
        &self,
        ctx: &Ctx,
        root: &str,
        path: &str,
        name: &str,
        new_branch: bool,
    ) -> Answer {
        if std::fs::metadata(path).is_ok() {
            return deny(
                CONFLICT,
                apierr::CODE_WORKTREE_EXISTS,
                Some(BTreeMap::from([("path".to_owned(), path.into())])),
            );
        }
        if let Some(wt) = &self.user_worktrees
            && new_branch
            && wt.branch_exists(ctx, root, name).await
        {
            return deny(
                CONFLICT,
                apierr::CODE_BRANCH_EXISTS,
                Some(BTreeMap::from([("branch".to_owned(), name.into())])),
            );
        }
        action::allow()
    }

    /// worktree 만들기 대화상자의 답이다 — 입력 → common 칸 → 자리.
    pub(crate) async fn worktree_create_answer(
        &self,
        ctx: &Ctx,
        root: &str,
        name: &str,
        r: &str,
        new_branch: bool,
    ) -> Result<Answer, WErr> {
        let a = worktree_input_answer(name, r);
        if !a.ok {
            return Ok(a);
        }
        let keys = self.job_keys(ctx, root).await?;
        let a = slots_answer(&self.exclusion(), &keys, &[SLOT_COMMON]);
        if !a.ok {
            return Ok(a);
        }
        let Some(wt) = &self.user_worktrees else {
            return Ok(action::allow());
        };
        let path = wt.path(&worktree::repo_bucket(root), name);
        Ok(self
            .worktree_place_answer(ctx, root, &path, name, new_branch)
            .await)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // FR-RDF-9: 조상이 파일이면 Go os.MkdirAll 처럼 막힌 그 칸의 경로로 not a directory 를 낸다.
    #[test]
    fn mkdir_parents_error_matches_go() {
        let t = tempfile::tempdir().unwrap();
        let blocker = filepath::join(&[t.path().to_str().unwrap(), "f"]);
        std::fs::write(&blocker, "x").unwrap();
        let dir = filepath::join(&[blocker.as_str(), "a", "b"]);
        let e = mkdir_parents(&dir).unwrap_err();
        assert_eq!(e.to_string(), format!("mkdir {blocker}: not a directory"));
    }
}
