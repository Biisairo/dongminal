//! /api/git/{stage,unstage,discard,resolve,commit,undo-last} — 저장소를 바꾸는 표면
//! (GIT_SRS §3A.1·§3A.2 FR-GIT-64~85). Go `handlers_git_write.go` 의 종단.
//!
//! 서버가 마지막 방어선이다. 확인·preflight·undo 만료를 여기서 다시 검사한다.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use dm_shared_httpresp::Response;
use dm_webserver_apierr::{self as apierr, Classify, Sentinel};
use dm_webserver_domain_git_core::{Ctx, Kind, Service};
use dm_webserver_domain_git_jobs::Job;
use dm_webserver_domain_git_query as query;
use dm_webserver_domain_git_write::{self as write, CommitOpts, ResolveResult};
use http::StatusCode;
use serde::Deserialize;

use crate::GitServer;
use crate::answers::{commit_message_answer, commit_state_answer, stage_answer};
use crate::job::job_succeeded;
use crate::reply::{GitErr, WErr, obj, raw};
use crate::req::Req;
use crate::write::{git_write_ok, git_write_stale_ok};

/// 파괴적 동작의 확인 문구다 (FR-GIT-89).
const CONFIRM_DESTRUCTIVE: &str = "파괴적 동작은 confirm:true 를 요구한다 (FR-GIT-89)";

#[derive(Default, Deserialize)]
#[serde(default, rename = "gitapi.gitPathsReq")]
struct PathsReq {
    repo: String,
    paths: Option<Vec<String>>,
}

#[derive(Default, Deserialize)]
#[serde(default, rename = "gitapi.gitDiscardReq")]
struct DiscardReq {
    repo: String,
    tracked: Option<Vec<String>>,
    untracked: Option<Vec<String>>,
    confirm: bool,
}

#[derive(Default, Deserialize)]
#[serde(default, rename = "gitapi.gitResolveReq")]
struct ResolveReq {
    repo: String,
    side: String,
    paths: Option<Vec<String>>,
    confirm: bool,
}

/// 메시지는 본문으로만 받는다 — 쿼리 파라미터는 접근 로그에 남는다 (FR-GIT-61).
#[derive(Default, Deserialize)]
#[serde(default, rename = "gitapi.gitCommitReq")]
struct CommitReq {
    repo: String,
    message: String,
    amend: bool,
    signoff: bool,
    #[serde(rename = "noVerify")]
    no_verify: bool,
    all: bool,
}

#[derive(Default, Deserialize)]
#[serde(default, rename = "gitapi.gitUndoReq")]
struct UndoReq {
    repo: String,
    #[serde(rename = "undoToken")]
    undo_token: String,
}

fn paths(p: &Option<Vec<String>>) -> &[String] {
    p.as_deref().unwrap_or_default()
}

impl GitServer {
    /// POST /api/git/stage (FR-GIT-64·66·68·69). 실행 전 status 로 `stage_answer` 를 본다
    /// (REFACTOR3_FE_REST1_SRS FR-FR1-7).
    pub(crate) async fn api_git_stage(&self, r: &mut Req) -> Response {
        let (mut t, req) = self.begin_write::<PathsReq>(r).await;
        t.resolve(&req.repo).await;
        let before = t.snapshot().await;
        if t.stop() {
            return t.finish();
        }
        let a = stage_answer(&before, paths(&req.paths));
        if !a.ok {
            t.reject_answer(&a, Some(&obj! {"status" => before}));
            return t.finish();
        }
        let (git, root) = (t.git(), t.root.clone());
        let p = paths(&req.paths).to_vec();
        t.apply(|ctx| async move {
            write::stage(git.service(), &ctx, &root, &p)
                .await
                .map(drop)
                .map_err(WErr::from)
        })
        .await;
        t.ok(None);
        t.finish()
    }

    /// POST /api/git/unstage (FR-GIT-65·67).
    pub(crate) async fn api_git_unstage(&self, r: &mut Req) -> Response {
        let (mut t, req) = self.begin_write::<PathsReq>(r).await;
        t.resolve(&req.repo).await;
        if t.stop() {
            return t.finish();
        }
        let (git, root) = (t.git(), t.root.clone());
        let p = paths(&req.paths).to_vec();
        t.apply(|ctx| async move {
            write::unstage(git.service(), &ctx, &root, &p)
                .await
                .map(drop)
                .map_err(WErr::from)
        })
        .await;
        t.ok(None);
        t.finish()
    }

    /// POST /api/git/discard — 워킹 트리의 변경을 버린다. 파괴적이다 (FR-GIT-89).
    pub(crate) async fn api_git_discard(&self, r: &mut Req) -> Response {
        let (mut t, req) = self.begin_write::<DiscardReq>(r).await;
        t.require_confirm(true, req.confirm, CONFIRM_DESTRUCTIVE);
        t.resolve(&req.repo).await;
        if t.stop() {
            return t.finish();
        }
        let (git, root) = (t.git(), t.root.clone());
        let (tr, un) = (paths(&req.tracked).to_vec(), paths(&req.untracked).to_vec());
        t.apply(|ctx| async move {
            write::discard(git.service(), &ctx, &root, &tr, &un)
                .await
                .map(drop)
                .map_err(WErr::from)
        })
        .await;
        t.ok(None);
        t.finish()
    }

    /// POST /api/git/resolve — 충돌 파일을 한쪽으로 받고 해결됨으로 표시한다 (FR-GIT-224).
    /// 경로마다 따로 해결하고 경로별 결과를 싣는다 (REPO_FIX 01 §7.4).
    pub(crate) async fn api_git_resolve(&self, r: &mut Req) -> Response {
        let (mut t, req) = self.begin_write::<ResolveReq>(r).await;
        t.require_confirm(true, req.confirm, CONFIRM_DESTRUCTIVE);
        t.resolve(&req.repo).await;
        t.snapshot().await;
        if t.stop() {
            return t.finish();
        }
        let (git, root) = (t.git(), t.root.clone());
        let mut results: Vec<ResolveResult> = Vec::new();
        let (side, p) = (req.side.clone(), paths(&req.paths).to_vec());
        let (ran, err) = t
            .write(|ctx| {
                let (git, root, out) = (Arc::clone(&git), root.clone(), &mut results);
                async move {
                    *out = write::resolve(git.service(), &ctx, &root, &side, &p).await?;
                    Ok(())
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
        let ctx = t.post();
        git.invalidate(&root);
        let (status_res, _) = git.status(&ctx, &root).await;
        let mut failed = 0usize;
        let mut locked: Option<&write::Error> = None;
        for res in &results {
            if res.ok {
                continue;
            }
            failed += 1;
            if locked.is_none()
                && let Some(e) = &res.err
                && Classify::is(e, &Sentinel::Core(Kind::IndexLocked))
            {
                locked = Some(e);
            }
        }
        let extra = obj! {"results" => results};
        if failed == 0 {
            let res = match &status_res {
                Ok(obs) => git_write_ok(&t.requested, &t.root, &obs.status, Some(&extra)),
                Err(_) => git_write_stale_ok(&t.requested, &t.root, Some(&extra)),
            };
            t.respond(res);
            return t.finish();
        }
        let mut body = extra;
        body.insert("partial".to_owned(), raw(&(failed < results.len())));
        if let Ok(obs) = &status_res {
            body.insert("status".to_owned(), raw(&obs.status));
        }
        // 코드 우선순위: index_locked → resolve_partial (§7.4).
        let msg = format!(
            "{}개 경로 중 {}개의 충돌 해결이 실패했다",
            results.len(),
            failed
        );
        let (name, cause) = match locked {
            Some(e) => (apierr::CODE_INDEX_LOCKED, Some(e as &dyn GitErr)),
            None => (apierr::CODE_RESOLVE_PARTIAL, None),
        };
        t.git_render_fail(&ctx, StatusCode::CONFLICT, name, &msg, cause, body)
            .await;
        t.finish()
    }

    /// POST /api/git/commit — staged 내용을 커밋한다 (FR-GIT-77·79·84). preflight 를 서버가
    /// 다시 돌린다 (FR-GIT-86). 커밋은 잡이다 — 훅이 분 단위일 수 있다 (REPO_FIX 01 §5.2).
    pub(crate) async fn api_git_commit_create(&self, r: &mut Req) -> Response {
        let (mut t, req) = self.begin_write::<CommitReq>(r).await;
        // 메시지 검사가 가장 앞이다 (FR-GIT-84 · GR-3b).
        let a = commit_message_answer(&req.message);
        if !t.stop() && !a.ok {
            t.reject_answer(&a, None);
        }
        t.resolve(&req.repo).await;
        if t.stop() {
            return t.finish();
        }
        let git = t.git();
        let root = t.root.clone();
        let pf = match query::preflight_of(git.service(), &t.ctx(), &root).await {
            Ok(pf) => pf,
            Err(e) => {
                t.reject(&e);
                return t.finish();
            }
        };
        let before = t.snapshot().await;
        if t.stop() {
            return t.finish();
        }
        // REPO_FIX 01 §7.7: amend 면 메시지가 바뀌었을 때 실행한다.
        let ctx = t.ctx();
        let a = commit_state_answer(&before, &pf, req.all, req.amend, || {
            git_amend_unchanged(git.service(), &ctx, &root, &req.message, req.signoff)
        })
        .await;
        if !a.ok {
            t.reject_answer(&a, Some(&obj! {"preflight" => pf}));
            return t.finish();
        }
        let spec = write::commit_spec(&CommitOpts {
            message: req.message.clone(),
            amend: req.amend,
            sign_off: req.signoff,
            no_verify: req.no_verify,
            all: req.all,
        });
        let undo = Arc::clone(&self.undo);
        let svc = Arc::clone(git.service());
        let finish: dm_webserver_domain_git_jobs::Finisher =
            Box::new(move |ctx: Ctx, jb: Job| Box::pin(issue_undo(svc, undo, root, ctx, jb)));
        t.start_write_job(spec, before, Some(finish), None).await;
        t.finish()
    }

    /// POST /api/git/undo-last — 직전 커밋을 되돌린다 (FR-GIT-82·83). 토큰이 없거나·만료됐거나·
    /// 다른 리포의 것이면 409 다.
    pub(crate) async fn api_git_undo_last(&self, r: &mut Req) -> Response {
        let (mut t, req) = self.begin_write::<UndoReq>(r).await;
        t.resolve(&req.repo).await;
        if t.stop() {
            return t.finish();
        }
        let git = t.git();
        let root = t.root.clone();
        // HEAD 와 메시지는 소비 전에 읽는다 (ATTIC_FIX_SRS FR-ATF-2).
        let (head, msg) = match query::head_commit(git.service(), &t.ctx(), &root).await {
            Ok(v) => v,
            Err(e) => {
                t.reject(&e);
                return t.finish();
            }
        };
        // 실행 전에 소비한다 — 한 번의 커밋에 한 번의 undo 다 (D-ATF-2).
        match self.undo.consume(&root, &req.undo_token, &head) {
            UndoVerdict::Invalid => {
                t.reject_with(
                    StatusCode::CONFLICT,
                    apierr::CODE_UNDO_EXPIRED,
                    "undo 창이 지났거나 이미 사용된 토큰이다 (5초)",
                );
                return t.finish();
            }
            UndoVerdict::HeadMoved => {
                t.reject_with(
                    StatusCode::CONFLICT,
                    apierr::CODE_STALE_OBSERVATION,
                    "토큰을 받은 뒤 HEAD 가 다른 커밋으로 옮겨졌다",
                );
                return t.finish();
            }
            UndoVerdict::Consumed => {}
        }
        t.apply(|ctx| async move {
            write::undo_last(git.service(), &ctx, &root)
                .await
                .map(drop)
                .map_err(WErr::from)
        })
        .await;
        // message 로 클라이언트가 입력을 커밋 직전으로 되돌린다 (FR-GIT-82).
        t.ok(Some(&obj! {"message" => msg}));
        t.finish()
    }
}

/// 커밋 잡의 완료 처리다. 토큰은 커밋이 성공한 뒤에만, 완료 처리의 마지막에 발급한다 — undo
/// 창의 기점이 Done 공개 직전이어야 한다. 토큰은 그 커밋에 묶는다 (FR-ATF-2).
async fn issue_undo(
    svc: Arc<Service>,
    undo: Arc<UndoStore>,
    root: String,
    ctx: Ctx,
    mut jb: Job,
) -> Job {
    if !job_succeeded(&jb) {
        return jb;
    }
    let Some(res) = jb.result.as_mut() else {
        return jb;
    };
    if let Some(st) = &res.status {
        res.oid = st.oid.clone();
    }
    let mut head = res.oid.clone();
    if head.is_empty() {
        match query::head_commit(&svc, &ctx, &root).await {
            Ok((oid, _)) => head = oid,
            Err(_) => return jb,
        }
    }
    res.undo_token = undo.issue(&root, &head);
    jb
}

/// amend 가 메시지도 바꾸지 않는가다. 직전 메시지를 읽지 못하면 바뀐 것으로 본다.
async fn git_amend_unchanged(
    svc: &Service,
    ctx: &Ctx,
    root: &str,
    msg: &str,
    signoff: bool,
) -> bool {
    let Ok(last) = query::last_commit_message(svc, ctx, root).await else {
        return false;
    };
    if signoff && !write::has_signoff(&last) {
        return false;
    }
    let prefix = write::comment_prefix(svc, ctx, root).await;
    write::normalize_commit_message(msg, &prefix) == write::normalize_commit_message(&last, &prefix)
}

/// 방금 만든 커밋 하나에 대한 되돌리기 권한이다.
struct UndoTicket {
    token: String,
    head: String,
    expires: Instant,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum UndoVerdict {
    Consumed,
    /// 없거나·만료됐거나·다른 토큰.
    Invalid,
    /// 토큰은 살아 있지만 HEAD 가 발급 때의 커밋이 아니다 — 소모하지 않는다.
    HeadMoved,
}

pub(crate) type UndoClock = Arc<dyn Fn() -> Instant + Send + Sync>;

#[derive(Default)]
struct UndoInner {
    tickets: HashMap<String, UndoTicket>,
    now: Option<UndoClock>,
}

impl UndoInner {
    fn clock(&self) -> Instant {
        self.now.as_ref().map_or_else(Instant::now, |f| f())
    }
}

/// 리포별로 티켓 하나를 쥔다 (FR-GIT-83). 새 커밋이 이전 토큰을 밀어내고, 소비되면 사라진다.
#[derive(Default)]
pub(crate) struct UndoStore {
    inner: Mutex<UndoInner>,
}

impl UndoStore {
    fn lock(&self) -> std::sync::MutexGuard<'_, UndoInner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// 시계를 바꾼다. 테스트가 5초를 기다리지 않게 한다.
    #[cfg(test)]
    pub(crate) fn set_clock(&self, now: UndoClock) {
        self.lock().now = Some(now);
    }

    /// 리포의 티켓을 새것으로 바꾸고 토큰을 준다. 이전 토큰은 이 순간 무효다.
    pub(crate) fn issue(&self, repo: &str, head: &str) -> String {
        let mut u = self.lock();
        let now = u.clock();
        u.tickets.retain(|_, t| now < t.expires);
        let token = dm_shared_uuid::new_string();
        u.tickets.insert(
            repo.to_owned(),
            UndoTicket {
                token: token.clone(),
                head: head.to_owned(),
                expires: now + write::UNDO_TTL,
            },
        );
        token
    }

    /// 토큰이 그 리포의 살아 있는 티켓이고 head 가 발급 때의 커밋일 때만 티켓을 없앤다. 빈
    /// 토큰은 언제나 `Invalid` 다.
    pub(crate) fn consume(&self, repo: &str, token: &str, head: &str) -> UndoVerdict {
        let mut u = self.lock();
        let now = u.clock();
        let Some(t) = u.tickets.get(repo) else {
            return UndoVerdict::Invalid;
        };
        if token.is_empty() || t.token != token || now >= t.expires {
            return UndoVerdict::Invalid;
        }
        if t.head != head {
            return UndoVerdict::HeadMoved;
        }
        u.tickets.remove(repo);
        UndoVerdict::Consumed
    }
}
