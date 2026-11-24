//! /api/git/{fetch,pull,push} + /api/git/job{s,/cancel,/events} + 원격 목록 — 원격 작업 표면
//! (GIT_SRS §3B.1 FR-GIT-98~112 · FR-GIT-269). Go `handlers_git_remote.go`.
//!
//! 자격증명을 받는 자리가 없다 (FR-GIT-104). 요청 본문에 인증 재료를 담을 필드를 만들지 않는다.

use std::sync::Arc;
use std::time::Duration;

use http::StatusCode;
use otter_gocompat::json::marshal;
use otter_gocompat::strconv;
use otter_shared_httpresp::Response;
use otter_webserver_apierr::{self as apierr, Classify, Sentinel};
use otter_webserver_domain_git_core::{Ctx, Hint, WriteSpec};
use otter_webserver_domain_git_jobs::{self as jobs, Job, Jobs, Line, StartOptions};
use otter_webserver_domain_git_query as query;
use otter_webserver_domain_git_write::{self as write, FetchOpts, PullOpts, PushOpts, PushPlan};
use otter_webserver_sse as sse;
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

use crate::GitServer;
use crate::job::uses_index;
use crate::reply::{
    ERR_BAD_REQUEST, Obj, WErr, git_err_json, git_error, git_fail, git_json, git_tail, obj,
};
use crate::req::Req;
use crate::write::GitWrite;

/// SSE 주석 하트비트 간격이다. /api/commands/sse 와 같은 값이다.
const JOB_KEEP_ALIVE: Duration = Duration::from_secs(15);

#[derive(Default, Deserialize)]
#[serde(default, rename = "gitapi.gitFetchReq")]
struct FetchReq {
    repo: String,
    prune: bool,
    /// 없으면 다이얼로그를 열지 않은 것이며, git 의 기본을 덮지 않는다 (FR-GIT-109).
    tags: Option<bool>,
}

#[derive(Default, Deserialize)]
#[serde(default, rename = "gitapi.gitPullReq")]
struct PullReq {
    repo: String,
    mode: String,
}

/// `publish` 는 upstream 설정의 사전 확인이고(FR-GIT-100), `confirm` 은 `--force` 의 2단계
/// 확인이다(FR-GIT-106).
#[derive(Default, Deserialize)]
#[serde(default, rename = "gitapi.gitPushReq")]
struct PushReq {
    repo: String,
    publish: bool,
    force: String,
    confirm: bool,
    remote: String,
    branch: String,
}

#[derive(Default, Deserialize)]
#[serde(default, rename = "gitapi.gitJobIDReq")]
struct JobIdReq {
    id: String,
}

/// remote add/remove 의 본문이다. URL 은 더할 때만 온다.
#[derive(Clone, Default, Deserialize)]
#[serde(default, rename = "gitapi.gitRemoteNameReq")]
struct RemoteNameReq {
    repo: String,
    name: String,
    url: String,
}

impl GitServer {
    /// POST /api/git/fetch — 기본은 `fetch --progress` 다 (FR-GIT-99).
    pub(crate) async fn api_git_fetch(&self, r: &mut Req) -> Response {
        let (mut t, req) = self.begin_write::<FetchReq>(r).await;
        t.resolve(&req.repo).await;
        if t.stop() {
            return t.finish();
        }
        let spec = write::fetch_spec(&FetchOpts {
            prune: req.prune,
            tags: req.tags,
        });
        t.start_job("fetch", spec, None).await;
        t.finish()
    }

    /// POST /api/git/pull — 기본은 `pull --progress` 다 (FR-GIT-99).
    pub(crate) async fn api_git_pull(&self, r: &mut Req) -> Response {
        let (mut t, req) = self.begin_write::<PullReq>(r).await;
        t.resolve(&req.repo).await;
        if t.stop() {
            return t.finish();
        }
        match write::pull_spec(&PullOpts { mode: req.mode }) {
            Ok(spec) => t.start_job("pull", spec, None).await,
            Err(e) => t.reject(&e),
        }
        t.finish()
    }

    /// POST /api/git/push — upstream 이 없으면 Publish 이고, 그 사실을 실행 전에 알린다
    /// (FR-GIT-100). force 는 lease 가 기본이다 (FR-GIT-106).
    pub(crate) async fn api_git_push(&self, r: &mut Req) -> Response {
        let (mut t, req) = self.begin_write::<PushReq>(r).await;
        t.resolve(&req.repo).await;
        if t.stop() {
            return t.finish();
        }
        let git = t.git();
        let opts = PushOpts {
            force: req.force,
            confirm: req.confirm,
            publish: req.publish,
            remote: req.remote,
            branch: req.branch,
        };
        let (res, plan) = write::push_spec(git.service(), &t.ctx(), &t.root, &opts).await;
        match res {
            Ok(spec) => {
                t.start_job("push", spec, Some(&obj! {"plan" => plan}))
                    .await
            }
            Err(e) => t.respond(git_push_error(&req.repo, &t.root, &plan, &e)),
        }
        t.finish()
    }

    /// 진행 중 작업 전부다 — `/api/git/jobs` 와 같은 목록이다. 상태바의 `/api/stats?jobs=1` 이
    /// 싣는다 (FR-OPT-4-4). git 이 없으면 `None` 이다.
    pub fn active_jobs(&self) -> Option<Vec<Job>> {
        let git = self.git.as_ref()?;
        Some(self.jobs_hub(git).active())
    }

    /// POST /api/git/job/cancel — 프로세스 그룹을 끝낸다 (FR-GIT-102).
    pub(crate) async fn api_git_job_cancel(&self, r: &mut Req) -> Response {
        let (t, req) = self.begin_write::<JobIdReq>(r).await;
        if t.stop() {
            return t.finish();
        }
        if req.id.is_empty() {
            return git_fail(StatusCode::BAD_REQUEST, ERR_BAD_REQUEST, "id 가 없다");
        }
        let hub = self.jobs_hub(&t.git());
        if hub.get(&req.id).is_none() {
            return git_fail(
                StatusCode::NOT_FOUND,
                apierr::CODE_JOB_NOT_FOUND,
                "그 작업이 없다",
            );
        }
        let canceled = hub.cancel(&req.id);
        git_json(
            StatusCode::OK,
            &obj! {"ok" => true, "id" => req.id, "canceled" => canceled},
        )
    }

    /// GET /api/git/jobs — 진행 중 작업 전부 (FR-OPT-4-4).
    pub(crate) async fn api_git_jobs(&self, _r: &mut Req) -> Response {
        let jobs = self.active_jobs().unwrap_or_default();
        git_json(StatusCode::OK, &obj! {"jobs" => jobs})
    }

    /// GET /api/git/job/events?id=&after=<seq> — 작업 출력 스트림 (FR-GIT-103). after 는 재연결
    /// 지점이다 — 보존된 줄을 먼저 흘려보낸다.
    ///
    /// 응답을 돌려준 뒤에도 스트림은 따로 task 에서 이어진다. 클라이언트가 떠나면 다음 쓰기가
    /// 실패해 끝난다 — 요청 문맥은 응답을 돌려줄 때 끝나므로 보지 않는다.
    pub(crate) async fn api_git_job_events(&self, r: &mut Req) -> Response {
        let id = r.q("id");
        if id.is_empty() {
            return git_fail(StatusCode::BAD_REQUEST, ERR_BAD_REQUEST, "id 가 없다");
        }
        // Go `after, _ := strconv.ParseUint(…)`: 문법 오류는 0, 넘치면 최댓값이다.
        let after = match strconv::parse_uint10(&r.q("after")) {
            Ok(n) => n,
            Err(e) if e.kind == strconv::NumErrorKind::Range => u64::MAX,
            Err(_) => 0,
        };
        let Some(git) = &self.git else {
            return crate::reply::git_unavailable();
        };
        let hub = self.jobs_hub(git);
        let Some((rx, unsub)) = hub.subscribe(&id, after) else {
            // 조용히 빈 스트림을 주면 클라이언트가 영원히 기다린다.
            return git_fail(
                StatusCode::NOT_FOUND,
                apierr::CODE_JOB_NOT_FOUND,
                "그 작업이 없다",
            );
        };
        let (res, mut st) = sse::start(Duration::ZERO);
        st.comment("connected");
        if !st.flush().await {
            return res;
        }
        let root = self.git_root();
        tokio::spawn(async move {
            let _unsub = unsub;
            job_event_loop(st, rx, hub, id, root).await;
        });
        res
    }

    /// GET /api/git/remotes?repo= — 원격 목록 (FR-GIT-269). URL 은 자격증명이 지워진 값이다.
    pub(crate) async fn api_git_remotes(&self, r: &mut Req) -> Response {
        let (git, root, requested) = match self.git_repo_param(r).await {
            Ok(v) => v,
            Err(res) => return res,
        };
        match query::remotes(git.service(), &r.ctx, &root).await {
            Ok(list) => git_json(
                StatusCode::OK,
                &obj! {
                    "requested" => obj! {"repo" => requested},
                    "repo" => root,
                    "remotes" => list,
                },
            ),
            Err(e) => git_error(&e),
        }
    }

    /// POST /api/git/remote/add — 원격을 더한다 (FR-GIT-269). 대화상자의 답(`git.remote.add`)과
    /// 같은 판정이다 (GV-c · D-SDA-6).
    pub(crate) async fn api_git_remote_add(&self, r: &mut Req) -> Response {
        self.git_remote_write(r, true).await
    }

    /// POST /api/git/remote/remove — 원격을 지운다 (FR-GIT-269). 파괴적이 아니다 — 되살릴
    /// `git remote add` 는 write 가 실행 전에 hint 로 남긴다 (FR-GIT-92).
    pub(crate) async fn api_git_remote_remove(&self, r: &mut Req) -> Response {
        self.git_remote_write(r, false).await
    }

    /// add/remove 가 공유하는 쓰기 규약이다 (FR-GIT-250 ③). 바뀐 목록을 함께 돌려준다.
    async fn git_remote_write(&self, r: &mut Req, add: bool) -> Response {
        let (mut t, req) = self.begin_write::<RemoteNameReq>(r).await;
        t.resolve(&req.repo).await;
        if t.stop() {
            return t.finish();
        }
        let git = t.git();
        let root = t.root.clone();
        if add {
            let a = self
                .remote_add_answer(&git, &t.ctx(), &root, &req.name, &req.url)
                .await;
            if !t.judge(a) {
                return t.finish();
            }
        }
        let (g, rt, rq) = (Arc::clone(&git), root.clone(), req.clone());
        t.apply(|ctx| async move {
            let res = if add {
                write::remote_add(g.service(), &ctx, &rt, &rq.name, &rq.url).await
            } else {
                write::remote_remove(g.service(), &ctx, &rt, &rq.name).await
            };
            res.map(drop).map_err(WErr::from)
        })
        .await;
        if t.stop() {
            return t.finish();
        }
        // 쓰기 뒤의 재조회는 사후 단계다 (REPO_FIX 01 §5.5).
        let ctx = t.post();
        match query::remotes(git.service(), &ctx, &root).await {
            Ok(list) => t.ok(Some(&obj! {"remotes" => list})),
            Err(e) => t.reject(&e),
        }
        t.finish()
    }
}

/// 작업 출력 스트림의 몸통이다. 채널이 닫히면(작업이 끝나면) 작업 자체를 `done` 으로 보낸다.
pub(crate) async fn job_event_loop(
    mut st: sse::Stream,
    mut rx: mpsc::Receiver<Line>,
    hub: Jobs,
    id: String,
    root: Ctx,
) {
    let mut keep =
        tokio::time::interval_at(tokio::time::Instant::now() + JOB_KEEP_ALIVE, JOB_KEEP_ALIVE);
    let gone = st.closed();
    tokio::pin!(gone);
    loop {
        tokio::select! {
            () = root.done() => return,
            () = &mut gone => return,
            ln = rx.recv() => {
                if !drain_job_lines(&mut st, &mut rx, ln) {
                    // 종료 사유·인증 안내·후속 선택지가 여기서 클라이언트에 닿는다.
                    match hub.get(&id) {
                        Some(jb) => job_event(&mut st, "done", &jb),
                        None => job_event(&mut st, "done", &obj! {"id" => id, "done" => true}),
                    }
                    st.flush().await;
                    return;
                }
            }
            _ = keep.tick() => st.comment("keep"),
        }
        if !st.flush().await {
            return;
        }
    }
}

/// 받은 줄과 이미 쌓인 줄을 함께 버퍼에 더한다 (HTTP-M2). 채널이 닫혔으면 false 다.
fn drain_job_lines(
    st: &mut sse::Stream,
    rx: &mut mpsc::Receiver<Line>,
    mut ln: Option<Line>,
) -> bool {
    while let Some(l) = ln {
        job_event(st, "line", &l);
        if st.full() {
            return true;
        }
        ln = match rx.try_recv() {
            Ok(l) => Some(l),
            Err(mpsc::error::TryRecvError::Empty) => return true,
            Err(mpsc::error::TryRecvError::Disconnected) => None,
        };
    }
    false
}

fn job_event<T: Serialize + ?Sized>(st: &mut sse::Stream, name: &str, payload: &T) {
    if let Ok(b) = marshal(payload) {
        st.event(name, &b);
    }
}

/// Publish 확인 요구만 따로 다룬다. 계획을 함께 보낸다 (FR-GIT-100).
pub(crate) fn git_push_error(
    requested: &str,
    root: &str,
    plan: &PushPlan,
    err: &write::Error,
) -> Response {
    if Classify::is(err, &Sentinel::Write(write::WriteKind::PublishRequired)) {
        return git_err_json(
            StatusCode::CONFLICT,
            apierr::CODE_PUBLISH_REQUIRED,
            &obj! {
                "error" => apierr::CODE_PUBLISH_REQUIRED,
                "message" => git_tail(&err.to_string()),
                "requested" => requested,
                "repo" => root,
                "plan" => plan,
            },
        );
    }
    git_error(err)
}

impl GitWrite<'_> {
    /// 작업을 띄우고 식별자를 즉시 돌려준다 (FR-GIT-102). index 칸을 쓰는 kind 는 완료 처리에서
    /// 쓰기 이후 status 를 싣는다 (§6.3).
    pub(crate) async fn start_job(&mut self, kind: &str, spec: WriteSpec, extra: Option<&Obj>) {
        self.start_hinted_job(kind, spec, extra, None).await;
    }

    /// `start_job` 이되 hint 를 등록이 성공한 뒤에만 남긴다 (§5.1).
    pub(crate) async fn start_hinted_job(
        &mut self,
        kind: &str,
        spec: WriteSpec,
        extra: Option<&Obj>,
        hint: Option<Hint>,
    ) {
        let mut opts = StartOptions::default();
        if uses_index(kind) {
            let before = self.snapshot().await;
            if self.stop() {
                return;
            }
            let git = self.git();
            opts = jobs::on_finish(self.s.index_finisher(&git, &self.root, before, None));
        }
        if self.stop() {
            return;
        }
        let git = self.git();
        let (root, k) = (self.root.clone(), kind.to_owned());
        self.launch_job(
            kind,
            move |h, keys| {
                let jb = h.start(&root, keys, &k, spec, opts)?;
                if let Some(hint) = hint {
                    git.service().add_hint(hint);
                }
                Ok(jb)
            },
            extra,
        )
        .await;
    }
}
