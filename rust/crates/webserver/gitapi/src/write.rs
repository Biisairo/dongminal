//! 쓰기 종단의 흐름 (Go `gitwrite.go` 와 `handlers_git_write.go` 의 공용 도우미).
//!
//! 순서(`begin_write` → `resolve` → `apply` → `ok`)를 [`GitWrite`] 가 소유한다. 어느 단계든
//! 응답을 쓰면 그 뒤 단계는 아무것도 하지 않는다.

use std::collections::{BTreeMap, BTreeSet};
use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use dm_shared_httpresp::Response;
use dm_webserver_action::Answer;
use dm_webserver_apierr::{Classify, Sentinel};
use dm_webserver_domain_git_core::{self as core, Ctx, Kind};
use dm_webserver_domain_git_jobs::{Exclusion, Keys, SLOT_INDEX};
use dm_webserver_domain_git_query::{FileEntry, Status};
use dm_webserver_domain_git_store::Store;
use http::StatusCode;
use serde::de::DeserializeOwned;

use crate::GitServer;
use crate::answers::{branch_exists_body, slots_answer};
use crate::lock::{Hold, LockMode, WriteLease};
use crate::reply::{
    Bare, ERR_BAD_REQUEST, ERR_CONFIRM_REQUIRED, GitErr, Obj, WErr, git_err_json, git_error,
    git_error_code, git_fail, git_json, git_tail, git_unavailable, obj, raw, status,
};
use crate::req::Req;

/// 재조회가 실패해 status 를 싣지 못한 성공 응답의 표식이다.
const KEY_STATUS_STALE: &str = "statusStale";

/// 서버 종료로 끊긴 쓰기의 문구다.
const SHUTDOWN_DETAIL: &str = "서버 종료로 중단했다 — 일부가 적용됐을 수 있다";

fn err_server_shutdown() -> WErr {
    Box::new(core::Error::new(Kind::ServerShutdown, SHUTDOWN_DETAIL))
}

fn is_kind<E: Classify + ?Sized>(err: &E, k: Kind) -> bool {
    err.is(&Sentinel::Core(k))
}

/// 쓰기 핸들러 한 번의 흐름이다.
pub(crate) struct GitWrite<'a> {
    pub(crate) s: &'a GitServer,
    pub(crate) r: &'a Req,
    res: Option<Response>,
    pub(crate) requested: String,
    pub(crate) root: String,
    /// 사전 단계 문맥 (REPO_FIX 01 §5.5). 임대가 없으면 요청 문맥이다.
    pre: Option<Ctx>,
    pub(crate) keys: Keys,
    before: Option<Status>,
    after: Status,
    /// 쓰기는 적용됐고 재조회만 실패했다 (FR-ATF-74).
    stale: bool,
    /// 잡 거절 응답에 함께 실을 "이미 적용된 것" 이다. 채우는 종단은 5.4.2 가 옮긴다.
    #[allow(dead_code)]
    pub(crate) applied: Option<Obj>,
}

impl GitServer {
    /// 쓰기 흐름을 연다: git 가용성 → 본문 디코드.
    pub(crate) async fn begin_write<'a, T: DeserializeOwned + Default + Send + 'static>(
        &'a self,
        r: &'a mut Req,
    ) -> (GitWrite<'a>, T) {
        self.begin_service_write(r, self.git.is_some(), git_unavailable)
            .await
    }

    /// git 이 아닌 서비스(worktree·submodule)의 가용성으로 여는 쓰기다.
    pub(crate) async fn begin_service_write<'a, T: DeserializeOwned + Default + Send + 'static>(
        &'a self,
        r: &'a mut Req,
        available: bool,
        unavailable: fn() -> Response,
    ) -> (GitWrite<'a>, T) {
        let (res, v) = if !available {
            (Some(unavailable()), T::default())
        } else {
            match r.decode_body::<T>().await {
                Ok(v) => (None, v),
                Err(res) => (Some(res), T::default()),
            }
        };
        let r: &'a Req = r;
        (
            GitWrite {
                s: self,
                r,
                res,
                requested: String::new(),
                root: String::new(),
                pre: None,
                keys: Keys::default(),
                before: None,
                after: Status::default(),
                stale: false,
                applied: None,
            },
            v,
        )
    }
}

impl<'a> GitWrite<'a> {
    pub(crate) fn stop(&self) -> bool {
        self.res.is_some()
    }

    /// 쓴 응답이다. 아무 응답도 쓰지 않았으면 Go 처럼 빈 200 이다.
    pub(crate) fn finish(self) -> Response {
        self.res.unwrap_or_else(|| {
            let mut res = http::Response::new(dm_shared_httpresp::empty());
            *res.status_mut() = StatusCode::OK;
            res
        })
    }

    pub(crate) fn respond(&mut self, res: Response) {
        self.res = Some(res);
    }

    /// 열린 git 이다. git 없이 연 흐름(서비스 쓰기)에서는 부르지 않는다.
    pub(crate) fn git(&self) -> Arc<Store> {
        self.s
            .git
            .clone()
            .expect("git 쓰기 흐름은 git 이 있을 때만 연다")
    }

    /// 파괴적 동작의 확인 (FR-GIT-89).
    pub(crate) fn require_confirm(&mut self, need: bool, confirmed: bool, reason: &str) {
        if self.stop() || !need || confirmed {
            return;
        }
        self.respond(git_fail(
            StatusCode::BAD_REQUEST,
            ERR_CONFIRM_REQUIRED,
            reason,
        ));
    }

    pub(crate) fn reject<E: GitErr + ?Sized>(&mut self, err: &E) {
        if self.stop() {
            return;
        }
        self.respond(git_error(err));
    }

    pub(crate) fn reject_with(&mut self, code: StatusCode, name: &str, msg: &str) {
        if self.stop() {
            return;
        }
        self.respond(git_fail(code, name, msg));
    }

    /// 표면 고유 필드를 더한 거절이다. `requested`·`repo` 를 함께 싣는다.
    pub(crate) fn reject_body(
        &mut self,
        code: StatusCode,
        name: &str,
        msg: &str,
        extra: Option<&Obj>,
    ) {
        if self.stop() {
            return;
        }
        let mut body = obj! {
            "error" => name, "message" => msg,
            "requested" => self.requested, "repo" => self.root,
        };
        if let Some(extra) = extra {
            body.extend(extra.clone());
        }
        self.respond(git_err_json(code, name, &body));
    }

    /// 판정 함수의 거짓 답을 그대로 거절로 옮긴다 (D-SDA-6).
    pub(crate) fn reject_answer(&mut self, a: &Answer, extra: Option<&Obj>) {
        if self.stop() {
            return;
        }
        let mut body = obj! {"error" => a.why, "requested" => self.requested, "repo" => self.root};
        if let Some(args) = &a.args {
            body.insert("args".to_owned(), raw(args));
        }
        if let Some(extra) = extra {
            body.extend(extra.clone());
        }
        self.respond(git_err_json(status(a.status), &a.why, &body));
    }

    /// 저장소를 풀고 잠근다.
    pub(crate) async fn resolve(&mut self, repo: &str) {
        self.resolve_root(repo).await;
        self.lock(true).await;
    }

    /// 저장소만 푼다 — 잠글지는 뒤에서 정하는 종단(replay)이 쓴다.
    pub(crate) async fn resolve_root(&mut self, repo: &str) {
        if self.stop() {
            return;
        }
        match self.s.git_resolve_repo(self.r, repo).await {
            Ok(root) => {
                self.requested = repo.to_owned();
                self.root = root;
            }
            Err(res) => self.respond(res),
        }
    }

    /// 임대가 있으면 잠금을 쥐고 사전 단계 문맥을 연다.
    pub(crate) async fn lock(&mut self, need: bool) {
        if self.stop() {
            return;
        }
        let Some(l) = self.r.lease.clone() else {
            self.pre = Some(self.r.ctx.clone());
            return;
        };
        if need && l.mode != LockMode::None {
            self.acquire(&l).await;
            if self.stop() {
                return;
            }
        }
        let pre = self.r.ctx.with_timeout(core::PRE_PHASE_TIMEOUT);
        l.hold(Hold::Cancel(pre.clone()));
        self.pre = Some(pre);
    }

    async fn acquire(&mut self, l: &WriteLease) {
        let git = self.git();
        let keys = match self.s.git_keys(&git, &self.r.ctx, &self.root).await {
            Ok(k) => k,
            Err(e) => return self.reject(&e),
        };
        self.keys = keys;
        let x = self.s.exclusion();
        if self.index_busy(&x) {
            return;
        }
        let wait = self.s.git_lock_wait();
        if l.mode == LockMode::Stash {
            match x.lock_common(&self.r.ctx, &self.keys.common, wait).await {
                Ok(rel) => l.hold(Hold::Lock(rel)),
                Err(e) => return self.reject(&e),
            }
        }
        match x.lock_top(&self.r.ctx, &self.keys.top, wait).await {
            Ok(rel) => l.hold(Hold::Lock(rel)),
            Err(e) => return self.reject(&e),
        }
        self.index_busy(&x);
    }

    /// 잡이 index 칸을 쥐었으면 409 job_busy 로 거절한다 (GR-1a).
    fn index_busy(&mut self, x: &Exclusion) -> bool {
        let a = slots_answer(x, &self.keys, &[SLOT_INDEX]);
        if !a.ok {
            self.reject_answer(&a, None);
        }
        !a.ok
    }

    /// 사전 단계 문맥이다. 잠그기 전이면 요청 문맥이다.
    pub(crate) fn ctx(&self) -> Ctx {
        self.pre.clone().unwrap_or_else(|| self.r.ctx.clone())
    }

    /// 쓰기 한 번을 기본 마감으로 돌린다.
    pub(crate) async fn write<F, Fut>(&mut self, run: F) -> (bool, Option<WErr>)
    where
        F: FnOnce(Ctx) -> Fut,
        Fut: Future<Output = Result<(), WErr>>,
    {
        self.write_within(core::DEFAULT_TIMEOUT, run).await
    }

    /// 쓰기 한 번을 서버 수명 문맥에서 돌린다 (REPO_FIX 01 §5.5). 요청은 시작 직전에만 본다 —
    /// 시작한 쓰기는 요청이 떠나도 끝까지 간다.
    pub(crate) async fn write_within<F, Fut>(&mut self, d: Duration, run: F) -> (bool, Option<WErr>)
    where
        F: FnOnce(Ctx) -> Fut,
        Fut: Future<Output = Result<(), WErr>>,
    {
        if self.shutdown() {
            self.reject(&*err_server_shutdown());
            return (false, None);
        }
        if self.r.ctx.err().is_some() {
            self.reject(&Bare(Kind::Canceled));
            return (false, None);
        }
        let ctx = self.s.git_root().with_timeout(d);
        let err = run(ctx).await.err();
        if self.shutdown() {
            return (true, Some(err_server_shutdown()));
        }
        (true, err)
    }

    fn shutdown(&self) -> bool {
        self.s.git_root().err().is_some()
    }

    /// 사후 단계 문맥 — 재조회와 실패 판정이 쓴다.
    pub(crate) fn post(&self) -> Ctx {
        self.s.git_root().with_timeout(core::POST_PHASE_TIMEOUT)
    }

    /// 실행 전 상태다. 한 번만 읽는다.
    pub(crate) async fn snapshot(&mut self) -> Status {
        if let Some(b) = &self.before {
            return b.clone();
        }
        if self.stop() {
            return Status::default();
        }
        let git = self.git();
        match git_status_before(&git, &self.ctx(), &self.root).await {
            Ok(st) => {
                self.before = Some(st.clone());
                st
            }
            Err(res) => {
                self.respond(res);
                Status::default()
            }
        }
    }

    /// 쓰기를 실행하고 상태를 다시 찍는다.
    pub(crate) async fn apply<F, Fut>(&mut self, run: F)
    where
        F: FnOnce(Ctx) -> Fut,
        Fut: Future<Output = Result<(), WErr>>,
    {
        if self.stop() {
            return;
        }
        let before = self.snapshot().await;
        if self.stop() {
            return;
        }
        if let Some(after) = self.git_apply(&before, run).await {
            self.after = after;
        }
    }

    pub(crate) fn ok(&mut self, extra: Option<&Obj>) {
        if self.stop() {
            return;
        }
        let res = if self.stale {
            git_write_stale_ok(&self.requested, &self.root, extra)
        } else {
            git_write_ok(&self.requested, &self.root, &self.after, extra)
        };
        self.respond(res);
    }

    /// status 를 싣지 않는 성공이다.
    pub(crate) fn ok_plain(&mut self, extra: Option<&Obj>) {
        if self.stop() {
            return;
        }
        let mut body = obj! {"ok" => true, "repo" => self.root, "requested" => self.requested};
        if let Some(extra) = extra {
            body.extend(extra.clone());
        }
        self.respond(git_json(StatusCode::OK, &body));
    }

    /// 쓰기 한 번을 실행하고 캐시를 버린 뒤 재조회한다 (FR-GIT-71). 실패하면 실행 전과 견줘
    /// `partial` 과 바뀐 경로를 싣는다 (FR-GIT-73). 성공이면 새 상태다(재조회 실패면 빈 상태와
    /// `stale`).
    async fn git_apply<F, Fut>(&mut self, before: &Status, run: F) -> Option<Status>
    where
        F: FnOnce(Ctx) -> Fut,
        Fut: Future<Output = Result<(), WErr>>,
    {
        let (ran, run_err) = self.write(run).await;
        if !ran {
            return None;
        }
        if let Some(e) = &run_err
            && is_kind(&**e, Kind::ServerShutdown)
        {
            // §8: 종료 중에는 재조회하지 않는다.
            self.reject(&**e);
            return None;
        }
        let ctx = self.post();
        let git = self.git();
        git.invalidate(&self.root);
        let (status_res, _) = git.status(&ctx, &self.root).await;
        let run_err = match (run_err, &status_res) {
            (None, Ok(obs)) => return Some(obs.status.clone()),
            (None, Err(_)) => {
                self.stale = true;
                return Some(Status::default());
            }
            (Some(e), _) => e,
        };
        let mut body = obj! {"partial" => false};
        if run_err.batch_partial() {
            body.insert("partial".to_owned(), raw(&true));
        }
        if let Some(name) = run_err.branch_exists() {
            body.extend(branch_exists_body(name, ""));
        }
        if let Ok(obs) = status_res {
            let changed = git_status_delta(before, &obs.status);
            if !changed.is_empty() {
                body.insert("partial".to_owned(), raw(&true));
                body.insert("changed".to_owned(), raw(&changed));
            }
            body.insert("status".to_owned(), raw(&obs.status));
        }
        self.git_write_fail(&ctx, &*run_err, body).await;
        None
    }

    /// 동기 쓰기 실패 응답의 공통 지점이다 (REPO_FIX 01 §7.2).
    pub(crate) async fn git_write_fail(&mut self, ctx: &Ctx, run_err: &dyn GitErr, body: Obj) {
        let (code, name) = git_error_code(run_err);
        self.git_render_fail(
            ctx,
            code,
            name,
            &git_tail(&run_err.to_string()),
            run_err,
            body,
        )
        .await;
    }

    /// 코드를 호출자가 정한 실패 응답이다. index.lock 에 막혔으면 lock 정보를 덧붙인다.
    pub(crate) async fn git_render_fail(
        &mut self,
        ctx: &Ctx,
        code: StatusCode,
        name: &str,
        msg: &str,
        cause: &dyn GitErr,
        mut body: Obj,
    ) {
        body.extend(obj! {
            "error" => name, "message" => msg,
            "requested" => self.requested, "repo" => self.root,
        });
        if let Some(lock) = self.s.git_index_lock(ctx, &self.root, cause).await {
            body.insert("lock".to_owned(), raw(&lock));
        }
        self.respond(git_err_json(code, name, &body));
    }
}

impl GitServer {
    /// err 가 index.lock 실패일 때 그 lock 의 정보다 (§7.2).
    pub(crate) async fn git_index_lock(
        &self,
        ctx: &Ctx,
        root: &str,
        err: &dyn GitErr,
    ) -> Option<core::LockInfo> {
        if !is_kind(err, Kind::IndexLocked) {
            return None;
        }
        let git = self.git.as_ref()?;
        git.service().index_lock_info(ctx, root).await
    }

    /// 요청의 repo 를 정규 루트로 옮긴다 (FR-GIT-62). 저장소가 아니면 404 다.
    pub(crate) async fn git_resolve_repo(
        &self,
        r: &Req,
        requested: &str,
    ) -> Result<String, Response> {
        let (root, not_repo) = self.git_resolve_repo_soft(r, requested).await?;
        if not_repo {
            return Err(git_error(&Bare(Kind::NotRepo)));
        }
        Ok(root)
    }

    /// `git_resolve_repo` 와 같은 검사를 하되 "저장소가 아니다" 를 값으로 돌려준다
    /// (API_ANSWER_NOT_ABSENCE_SRS FR-ANA-5). git 가용성·경계 검사는 이 한 자리에만 있다
    /// (FR-DPN-24 · FR-FAB-14).
    pub(crate) async fn git_resolve_repo_soft(
        &self,
        r: &Req,
        requested: &str,
    ) -> Result<(String, bool), Response> {
        let Some(git) = &self.git else {
            return Err(git_unavailable());
        };
        if requested.is_empty() {
            return Err(git_fail(
                StatusCode::BAD_REQUEST,
                ERR_BAD_REQUEST,
                "repo 인자가 없다",
            ));
        }
        if !dm_gocompat::filepath::is_abs(requested) {
            return Err(git_fail(
                StatusCode::BAD_REQUEST,
                ERR_BAD_REQUEST,
                "repo 는 절대경로여야 한다",
            ));
        }
        let root = match git.repo_root(&r.ctx, requested).await {
            Ok(root) => root,
            Err(e) if is_kind(&e, Kind::NotRepo) => return Ok((String::new(), true)),
            Err(e) => return Err(git_error(&e)),
        };
        // 목록을 본문에 싣지 않는다 (FR-ACL-8 승계).
        if let Some(guard) = &self.repo_guard
            && guard(&root).is_err()
        {
            return Err(git_fail(
                StatusCode::FORBIDDEN,
                ERR_BAD_REQUEST,
                "이 저장소는 워크스페이스 밖이다",
            ));
        }
        Ok((root, false))
    }
}

/// 실행 전 상태다. 캐시된 값을 써도 된다.
pub(crate) async fn git_status_before(
    git: &Arc<Store>,
    ctx: &Ctx,
    root: &str,
) -> Result<Status, Response> {
    match git.status(ctx, root).await.0 {
        Ok(obs) => Ok(obs.status),
        Err(e) => Err(git_error(&e)),
    }
}

/// 쓰기 성공 응답이다. 실행 후 status 를 함께 담는다 (FR-GIT-71).
pub(crate) fn git_write_ok(
    requested: &str,
    root: &str,
    st: &Status,
    extra: Option<&Obj>,
) -> Response {
    let mut body = obj! {
        "requested" => requested, "repo" => root, "ok" => true, "partial" => false, "status" => st,
    };
    if let Some(extra) = extra {
        body.extend(extra.clone());
    }
    git_json(StatusCode::OK, &body)
}

/// 쓰기는 적용됐고 재조회만 실패한 성공 응답이다 (FR-ATF-74).
pub(crate) fn git_write_stale_ok(requested: &str, root: &str, extra: Option<&Obj>) -> Response {
    let mut body = obj! {
        "requested" => requested, "repo" => root, "ok" => true, "partial" => false,
        KEY_STATUS_STALE => true,
    };
    if let Some(extra) = extra {
        body.extend(extra.clone());
    }
    git_json(StatusCode::OK, &body)
}

/// 실행 전후로 달라진 경로들이다(정렬).
pub(crate) fn git_status_delta(before: &Status, after: &Status) -> Vec<String> {
    let (b, a) = (git_entry_states(before), git_entry_states(after));
    let mut out = BTreeSet::new();
    for (p, xy) in &a {
        if b.get(p).map_or("", String::as_str) != xy {
            out.insert(p.clone());
        }
    }
    for p in b.keys() {
        if !a.contains_key(p) {
            out.insert(p.clone());
        }
    }
    out.into_iter().collect()
}

/// 경로 → XY. 한 파일이 여러 그룹에 들 수 있어 뒤 그룹이 이긴다(Go 와 같은 순서).
fn git_entry_states(st: &Status) -> BTreeMap<String, String> {
    let groups: [&[FileEntry]; 4] = [&st.staged, &st.changes, &st.untracked, &st.conflicts];
    groups
        .iter()
        .flat_map(|g| g.iter())
        .map(|e| (e.path.clone(), e.xy.clone()))
        .collect()
}
