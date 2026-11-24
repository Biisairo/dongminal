//! /api/git/{cherry-pick,revert,reset,drop} + /api/git/commit-range — 커밋 동작
//! (GIT_ACTIONS_SRS §3.4 FR-GIT-263~267). Go `handlers_git_commit_ops.go`.
//!
//! 진행 중 상태를 실패로 뭉개지 않는다 — 충돌로 멈추면 그 출구는 `/api/git/operation` 이다.

use dm_shared_httpresp::Response;
use dm_webserver_action::{self as action, Answer, allow, deny};
use dm_webserver_apierr::{self as apierr, Classify, Sentinel};
use dm_webserver_domain_git_core::{self as core, Ctx, WriteSpec};
use dm_webserver_domain_git_query::Status;
use dm_webserver_domain_git_write::{self as write, PickOpts, ResetOpts, WriteKind};
use http::StatusCode;
use serde::Deserialize;

use crate::GitServer;
use crate::answers::op_answer;
use crate::reply::{WErr, git_err_json, git_error, git_fail, git_json, git_tail, obj};
use crate::req::Req;

const CONFLICT: u16 = 409;
const BAD_REQUEST: u16 = 400;

/// merge 여부는 요청이 정하지 않는다 — 저장소가 답하는 사실이다.
#[derive(Default, Deserialize)]
#[serde(default, rename = "gitapi.gitPickReq")]
struct PickReq {
    repo: String,
    oid: String,
    mainline: i64,
    #[serde(rename = "noCommit")]
    no_commit: bool,
}

#[derive(Default, Deserialize)]
#[serde(default, rename = "gitapi.gitResetReq")]
struct ResetReq {
    repo: String,
    oid: String,
    mode: String,
    confirm: bool,
}

#[derive(Default, Deserialize)]
#[serde(default, rename = "gitapi.gitDropReq")]
struct DropReq {
    repo: String,
    oid: String,
    confirm: bool,
}

/// 대상 커밋의 사실이다 — 전체 oid 와 부모.
#[derive(Clone, Debug, Default)]
pub(crate) struct CommitFacts {
    pub(crate) oid: String,
    pub(crate) parents: Vec<String>,
}

/// cherry-pick·revert 의 동사 → 동작 ID.
fn pick_action(verb: &str) -> &'static str {
    if verb == write::PICK_CHERRY {
        action::GIT_COMMIT_CHERRY_PICK
    } else {
        action::GIT_COMMIT_REVERT
    }
}

/// 커밋 행 메뉴 동작 하나의 판정이다 (GT-c · FR-SDA-30·33·34). 진행 중 작업이 먼저다.
pub(crate) fn commit_op_answer(id: &str, st: &Status, c: &CommitFacts) -> Answer {
    let a = op_answer(st);
    if !a.ok {
        return a;
    }
    match id {
        action::GIT_COMMIT_CHERRY_PICK | action::GIT_COMMIT_RESET
            if !st.oid.is_empty() && c.oid == st.oid =>
        {
            return deny(CONFLICT, apierr::CODE_TARGET_IS_HEAD, None);
        }
        action::GIT_COMMIT_DROP => {
            if c.parents.is_empty() {
                return deny(BAD_REQUEST, apierr::CODE_ROOT_COMMIT, None);
            }
            if c.parents.len() > 1 {
                return deny(BAD_REQUEST, apierr::CODE_MERGE_COMMIT, None);
            }
        }
        _ => {}
    }
    allow()
}

/// 커밋 동작의 거부를 응답으로 옮긴다. 부모 번호가 빠졌으면 부모 목록을 함께 준다 (FR-GIT-263).
fn commit_op_error(err: &write::Error, parents: &[String]) -> Response {
    if Classify::is(err, &Sentinel::Write(WriteKind::MergeParent)) {
        return git_err_json(
            StatusCode::BAD_REQUEST,
            apierr::CODE_MERGE_PARENT,
            &obj! {
                "error" => apierr::CODE_MERGE_PARENT,
                "message" => git_tail(&err.to_string()),
                "parents" => parents,
            },
        );
    }
    git_error(err)
}

impl GitServer {
    /// POST /api/git/cherry-pick — 지목한 커밋을 현재 브랜치에 얹는다 (FR-GIT-263).
    pub(crate) async fn api_git_cherry_pick(&self, r: &mut Req) -> Response {
        self.git_pick(r, write::PICK_CHERRY).await
    }

    /// POST /api/git/revert — 지목한 커밋을 되돌리는 커밋을 만든다 (FR-GIT-264).
    pub(crate) async fn api_git_revert(&self, r: &mut Req) -> Response {
        self.git_pick(r, write::PICK_REVERT).await
    }

    /// cherry-pick·revert 의 공통 경로다. 둘은 부모 선택 규약이 같다.
    async fn git_pick(&self, r: &mut Req, verb: &str) -> Response {
        let (mut t, req) = self.begin_write::<PickReq>(r).await;
        t.resolve(&req.repo).await;
        if t.stop() {
            return t.finish();
        }
        // 머지 여부는 저장소에 묻는다 (FR-GIT-263).
        let c = match self.git_commit_facts(&t.ctx(), &t.root, &req.oid).await {
            Ok(c) => c,
            Err(res) => return res,
        };
        let before = t.snapshot().await;
        if t.stop() {
            return t.finish();
        }
        // 메뉴의 답과 같은 판정이다 (GT-c · D-SDA-6).
        let a = commit_op_answer(pick_action(verb), &before, &c);
        if !a.ok {
            t.reject_answer(&a, None);
            return t.finish();
        }
        let opts = PickOpts {
            oid: req.oid.clone(),
            merge: c.parents.len() > 1,
            mainline: req.mainline,
            no_commit: req.no_commit,
        };
        let argv = match write::pick_args(verb, &opts) {
            Ok(a) => a,
            Err(e) => return commit_op_error(&e, &c.parents),
        };
        // §5.2: cherry-pick·revert 는 새 커밋을 만드는 잡이다.
        let spec = WriteSpec {
            argv,
            ..WriteSpec::default()
        };
        t.start_write_job(spec, before, None, None).await;
        t.finish()
    }

    /// POST /api/git/reset — 현재 브랜치를 그 커밋으로 옮긴다 (FR-GIT-265). `--hard` 만 확인을
    /// 요구한다.
    pub(crate) async fn api_git_reset(&self, r: &mut Req) -> Response {
        let (mut t, req) = self.begin_write::<ResetReq>(r).await;
        t.require_confirm(
            req.mode == write::RESET_HARD,
            req.confirm,
            "reset --hard 는 워킹 트리와 index 의 변경을 버린다: confirm:true 를 요구한다 (FR-GIT-89·265)",
        );
        let opts = ResetOpts {
            oid: req.oid.clone(),
            mode: req.mode.clone(),
        };
        // 인자 검증이 repo 해석보다 앞이다.
        if let Err(e) = write::reset_args(&opts) {
            t.reject(&e);
        }
        t.resolve(&req.repo).await;
        if t.stop() {
            return t.finish();
        }
        let c = match self.git_commit_facts(&t.ctx(), &t.root, &req.oid).await {
            Ok(c) => c,
            Err(res) => return res,
        };
        // hint 는 옮기기 전 HEAD 를 싣는다 (FR-GIT-250.2).
        let before = t.snapshot().await;
        let a = commit_op_answer(action::GIT_COMMIT_RESET, &before, &c);
        if !t.stop() && !a.ok {
            t.reject_answer(&a, None);
        }
        if t.stop() {
            return t.finish();
        }
        let (git, root, head) = (t.git(), t.root.clone(), before.oid.clone());
        t.apply(|ctx| async move {
            write::reset(git.service(), &ctx, &root, &opts, &head)
                .await
                .map(drop)
                .map_err(WErr::from)
        })
        .await;
        t.ok(None);
        t.finish()
    }

    /// POST /api/git/drop — 커밋 하나를 히스토리에서 뺀다 (FR-GIT-266). 파괴적이다.
    pub(crate) async fn api_git_drop(&self, r: &mut Req) -> Response {
        let (mut t, req) = self.begin_write::<DropReq>(r).await;
        t.require_confirm(
            true,
            req.confirm,
            "커밋을 빼면 뒤따르는 커밋의 해시가 전부 바뀐다: confirm:true 를 요구한다 (FR-GIT-89·266)",
        );
        if let Err(e) = write::drop_args(&req.oid) {
            t.reject(&e);
        }
        t.resolve(&req.repo).await;
        if t.stop() {
            return t.finish();
        }
        let c = match self.git_commit_facts(&t.ctx(), &t.root, &req.oid).await {
            Ok(c) => c,
            Err(res) => return res,
        };
        let before = t.snapshot().await;
        if t.stop() {
            return t.finish();
        }
        // 메뉴의 답과 같은 판정이다 (GT-c) — 루트·머지 커밋은 뺄 수 없다.
        let a = commit_op_answer(action::GIT_COMMIT_DROP, &before, &c);
        if !a.ok {
            t.reject_answer(&a, None);
            return t.finish();
        }
        match write::drop_spec(&t.root, &req.oid, &before.oid) {
            // §5.2: drop 은 rebase 잡이다.
            Ok((spec, hint)) => t.start_write_job(spec, before, None, Some(hint)).await,
            Err(e) => t.reject(&e),
        }
        t.finish()
    }

    /// GET /api/git/commit-range?repo=&from=&to=&symmetric= — 두 리비전 사이의 범위. reset
    /// 다이얼로그의 영향 커밋 수(FR-GIT-265)와 Compare with 의 왼쪽 리비전(FR-GIT-267)이 쓴다.
    pub(crate) async fn api_git_commit_range(&self, r: &mut Req) -> Response {
        let (git, root, requested) = match self.git_repo_param(r).await {
            Ok(v) => v,
            Err(res) => return res,
        };
        let (mut from, to) = (r.q("from"), r.q("to"));
        for (name, val) in [("from", &from), ("to", &to)] {
            if let Err(e) = core::check_ref_arg(name, val) {
                return git_fail(
                    StatusCode::BAD_REQUEST,
                    apierr::CODE_REF_NAME,
                    &git_tail(&e.to_string()),
                );
            }
        }
        let svc = git.service();
        if !r.q("symmetric").is_empty() {
            // `A...B` 의 왼쪽은 merge-base 다. rev-parse 가 `^merge-base` 줄을 준다.
            let range = format!("{from}...{to}");
            match svc
                .exec(&r.ctx, &root, &["rev-parse", range.as_str()])
                .await
            {
                Err(e) => return git_error(&e),
                Ok(out) => {
                    let base = out
                        .stdout_str()
                        .split('\n')
                        .find_map(|l| l.trim().strip_prefix('^').map(str::to_owned));
                    // 공통 조상이 없는 두 갈래다. 지어내지 않고 왼쪽을 그대로 쓴다.
                    if let Some(base) = base {
                        from = base;
                    }
                }
            }
        }
        let range = format!("{from}..{to}");
        let n: i64 = match svc
            .exec(&r.ctx, &root, &["rev-list", "--count", range.as_str()])
            .await
        {
            Err(e) => return git_error(&e),
            Ok(out) => out.stdout_str().trim().parse().unwrap_or(0),
        };
        git_json(
            StatusCode::OK,
            &obj! {"requested" => requested, "repo" => root, "from" => from, "to" => to, "count" => n},
        )
    }

    /// 대상 커밋의 oid·부모를 저장소에 묻는다 (FR-GIT-263). `Err` 는 다 만든 응답이다.
    pub(crate) async fn git_commit_facts(
        &self,
        ctx: &Ctx,
        root: &str,
        oid: &str,
    ) -> Result<CommitFacts, Response> {
        if let Err(e) = core::check_ref_arg("oid", oid) {
            return Err(git_fail(
                StatusCode::BAD_REQUEST,
                apierr::CODE_REF_NAME,
                &git_tail(&e.to_string()),
            ));
        }
        let Some(git) = &self.git else {
            return Err(crate::reply::git_unavailable());
        };
        let out = git
            .service()
            .exec(ctx, root, &["log", "-n", "1", "--format=%H %P", oid])
            .await
            .map_err(|e| git_error(&e))?;
        let s = out.stdout_str();
        let mut f = s.split_whitespace().map(str::to_owned);
        match f.next() {
            None => Err(git_fail(
                StatusCode::NOT_FOUND,
                apierr::CODE_NOT_FOUND,
                &format!("commit not found: {oid}"),
            )),
            Some(oid) => Ok(CommitFacts {
                oid,
                parents: f.collect(),
            }),
        }
    }
}
