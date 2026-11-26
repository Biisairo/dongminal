//! 묶음 R — Run 레코드의 서버 계층이다 (Go `handlers_runs.go`·`handlers_runs_actions.go`,
//! RUN_ORCHESTRATION_SRS §3.1).
//!
//! 서버는 "무엇이 누구의 것인가"를 기록하고 답한다. 무엇을 언제 시킬지는 조정자 에이전트가
//! 정한다 (DC-RUN-1). 처리기 몸은 Go 처럼 동기로 돈다 — 저장소·도구 허브가 모두 블로킹이고,
//! 기다림(pollwait)과 worktree 호출만 런타임에 맡긴다([`Rt`]).

use std::collections::BTreeMap;
use std::future::Future;
use std::sync::Arc;

use http::StatusCode;
use otter_shared_activity as activity;
use otter_shared_httpresp::{self as httpresp, Response};
use otter_shared_otterlog::infof;
use otter_shared_pollwait as pollwait;
use otter_shared_runwait as runwait;
use otter_webserver_action::{self as action, Answer};
use otter_webserver_apierr as apierr;
use otter_webserver_domain_git_core as core;
use otter_webserver_domain_run::{self as run, Member, Record};
use serde::{Deserialize, Serialize, Serializer};
use tokio::runtime::Handle;
use tokio_util::sync::CancellationToken;

use crate::Server;
use crate::go_embed::{Embed, Obj, raw};
use crate::httperr::{decode_json_body, write_json, write_tool_io_error};
use crate::req::Req;
use crate::runs_headless::HeadlessRef;
use crate::runs_worktree::MemberIsolation;
use crate::status::Liveness;
use crate::tools_api::off_thread;

/// Go `handoffPreambleWait`: 프리앰블 조회가 늦은 인수인계를 기다리는 상한 (FR-RUN-4).
const HANDOFF_PREAMBLE_WAIT: std::time::Duration = runwait::PREAMBLE_WAIT;

/// 동기 처리기 몸이 쓰는 런타임 손잡이와 요청의 취소다 (Go `r.Context()`).
pub(crate) struct Rt {
    h: Handle,
    pub(crate) ctx: CancellationToken,
}

impl Rt {
    /// 취소하지 않는 손잡이다 (Go `context.Background()`).
    pub(crate) fn background() -> Rt {
        Rt {
            h: Handle::current(),
            ctx: CancellationToken::new(),
        }
    }

    /// 비동기 호출 하나를 이 스레드에서 끝까지 돌린다.
    pub(crate) fn wait<F: Future>(&self, f: F) -> F::Output {
        self.h.block_on(f)
    }

    /// Go `ctx.Err() != nil`.
    pub(crate) fn canceled(&self) -> bool {
        self.ctx.is_cancelled()
    }

    /// git 계층의 문맥이다.
    pub(crate) fn git(&self) -> core::Ctx {
        core::Ctx::from_token(self.ctx.clone())
    }
}

fn server_gone() -> Response {
    write_tool_io_error(StatusCode::SERVICE_UNAVAILABLE, "server gone")
}

/// 사유 표(`apierr::RUNS`)로 분류할 수 있는 오류다.
pub(crate) trait Cause:
    apierr::Classify + std::fmt::Display + std::fmt::Debug + Send
{
}

impl<T: apierr::Classify + std::fmt::Display + std::fmt::Debug + Send> Cause for T {}

/// Run 처리기의 실패다. 사유 표는 `apierr::RUNS` 가 갖는다 (FR-DPN-6).
#[derive(Debug)]
pub(crate) enum RunFail {
    /// Go `errIsolationUnavailable` 을 감싼 실패. 값은 오류 문구 전체다.
    Isolation(String),
    Cause(Box<dyn Cause>),
}

/// Go `errIsolationUnavailable` 의 문구.
pub(crate) const ISOLATION_UNAVAILABLE: &str = "isolation_unavailable";

impl RunFail {
    pub(crate) fn isolation(detail: &str) -> RunFail {
        RunFail::Isolation(format!("{ISOLATION_UNAVAILABLE}: {detail}"))
    }

    pub(crate) fn of<E: Cause + 'static>(e: E) -> RunFail {
        RunFail::Cause(Box::new(e))
    }
}

impl std::fmt::Display for RunFail {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RunFail::Isolation(d) => f.write_str(d),
            RunFail::Cause(e) => e.fmt(f),
        }
    }
}

impl From<run::Error> for RunFail {
    fn from(e: run::Error) -> Self {
        RunFail::of(e)
    }
}

/// `invalid_argument: <설명>`.
pub(crate) fn invalid(detail: impl Into<String>) -> RunFail {
    RunFail::of(run::Error::InvalidArgument(detail.into()))
}

/// 동기 스레드에서 비동기 호출 하나를 취소 없이 끝까지 돌린다 (Go `context.WithoutCancel`).
pub(crate) fn block<F: Future>(f: F) -> F::Output {
    Handle::current().block_on(f)
}

/// Go `writeRunError`: 사유를 상태로 옮긴다. 미분류 실패의 전문은 로그로만 간다 (FR-RGS-7).
pub(crate) fn write_run_error(err: &RunFail, extra: Obj) -> Response {
    let (status, name, detail) = match err {
        RunFail::Isolation(d) => (503, ISOLATION_UNAVAILABLE, d.clone()),
        RunFail::Cause(other) => match apierr::RUNS.lookup(other.as_ref()) {
            Some((s, c)) => (s, c, other.to_string()),
            None => {
                infof!(None, "runs 미분류 실패: {other}");
                (500, apierr::CODE_INTERNAL, apierr::CODE_INTERNAL.to_owned())
            }
        },
    };
    let mut body = extra;
    body.entry("error").or_insert_with(|| raw(name));
    body.entry("detail").or_insert_with(|| raw(&detail));
    let status = StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    // FR-ERR-7: 본문의 `error` 와 같은 값을 헤더로도 낸다.
    httpresp::fail_json(status, name, &body)
}

/// 한 칸짜리 덧붙임이다.
pub(crate) fn extra1<T: Serialize + ?Sized>(k: &'static str, v: &T) -> Obj {
    Obj::from([(k, raw(v))])
}

/// Go `runErrAnswer`: 저장소 사유를 동작 판정으로 옮긴다.
fn run_err_answer(err: &run::Error) -> Answer {
    match apierr::RUNS.lookup(err) {
        Some((status, code)) => action::deny(status, code, None),
        None => {
            infof!(None, "runs 미분류 실패: {err}");
            action::deny(500, apierr::CODE_INTERNAL, None)
        }
    }
}

/// Go `runCloseAnswer`: 강제 닫기도 할 수 없을 때만 막는다 (R-b).
fn run_close_answer(rec: &Record) -> Answer {
    match run::check_close(rec, true) {
        Ok(_) => action::allow(),
        Err((e, _)) => run_err_answer(&e),
    }
}

/// Go `runUnreported`: 강제 닫기 확인 문구의 근거 (R-d).
pub(crate) fn run_unreported(rec: &Record) -> i64 {
    match run::check_close(rec, true) {
        Ok(p) | Err((_, p)) => p.len() as i64,
    }
}

/// Go `memberDetachAnswer`.
pub(crate) fn member_detach_answer(m: &Member) -> Answer {
    if m.tab_id.is_empty() {
        return run_err_answer(&run::Error::MemberNotAttached);
    }
    action::allow()
}

pub(crate) type Actions = BTreeMap<&'static str, Answer>;

/// Go `runActions`.
pub(crate) fn run_actions(rec: &Record) -> Actions {
    Actions::from([
        (action::RUN_CLOSE, run_close_answer(rec)),
        (action::RUN_DELETE, action::allow()),
    ])
}

/// Go `memberActions`.
pub(crate) fn member_actions(m: &Member) -> Actions {
    Actions::from([(action::RUN_MEMBER_DETACH, member_detach_answer(m))])
}

fn is_false(b: &bool) -> bool {
    !*b
}

/// Go `memberView`: 질의 시점에 상태를 계산한 멤버 (FR-RUN-6).
#[derive(Clone, Default)]
pub(crate) struct MemberView {
    pub(crate) member: Member,
    pub(crate) state: String,
    /// 멤버 생성 응답에서만 채운다 (FR-PRE-1).
    pub(crate) preamble: String,
    /// 목록·조회에서만 싣는다 (R-b).
    pub(crate) actions: Option<Actions>,
    pub(crate) recoverable: bool,
}

#[derive(Serialize)]
struct MemberOuter<'a> {
    state: &'a str,
    #[serde(skip_serializing_if = "str::is_empty")]
    preamble: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    actions: Option<&'a Actions>,
    #[serde(skip_serializing_if = "is_false")]
    recoverable: bool,
}

impl MemberView {
    pub(crate) fn new(member: Member, state: String) -> MemberView {
        MemberView {
            member,
            state,
            ..MemberView::default()
        }
    }
}

impl Serialize for MemberView {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        Embed {
            inner: &self.member,
            hide: &["state", "preamble", "actions", "recoverable"],
            outer: MemberOuter {
                state: &self.state,
                preamble: &self.preamble,
                actions: self.actions.as_ref(),
                recoverable: self.recoverable,
            },
        }
        .serialize(s)
    }
}

/// Go `runView`: 멤버가 계산된 상태를 실은 Run.
pub(crate) struct RunView {
    rec: Record,
    members: Vec<MemberView>,
    orphans: Option<Vec<HeadlessRef>>,
    actions: Actions,
    unreported: i64,
    liveness: &'static str,
    coordinator_recoverable: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RunOuter<'a> {
    members: &'a [MemberView],
    #[serde(skip_serializing_if = "Option::is_none")]
    orphans: Option<&'a Vec<HeadlessRef>>,
    actions: &'a Actions,
    #[serde(skip_serializing_if = "is_zero")]
    unreported: i64,
    #[serde(skip_serializing_if = "str::is_empty")]
    liveness: &'a str,
    #[serde(skip_serializing_if = "is_false")]
    coordinator_recoverable: bool,
}

fn is_zero(n: &i64) -> bool {
    *n == 0
}

impl Serialize for RunView {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        Embed {
            inner: &self.rec,
            hide: &[
                "members",
                "orphans",
                "actions",
                "unreported",
                "liveness",
                "coordinatorRecoverable",
            ],
            outer: RunOuter {
                members: &self.members,
                orphans: self.orphans.as_ref(),
                actions: &self.actions,
                unreported: self.unreported,
                liveness: self.liveness,
                coordinator_recoverable: self.coordinator_recoverable,
            },
        }
        .serialize(s)
    }
}

/// Go `memberStateFrom`: 기록이 이긴다. 일하거나 묻는 중이면 그것이 기다림보다 먼저다.
pub(crate) fn member_state_from(
    recorded: &str,
    live: bool,
    hook: &str,
    open_child: bool,
) -> String {
    if settled_state(recorded) {
        return recorded.to_owned();
    }
    if !live {
        return run::LOST.to_owned();
    }
    let s = match hook {
        activity::WORKING => run::WORKING,
        activity::WAITING => run::WAITING,
        activity::IDLE | activity::DONE if open_child => run::WAITING_CHILDREN,
        activity::IDLE | activity::DONE => run::READY,
        _ => run::STARTING,
    };
    s.to_owned()
}

/// 보고·풀림·승계로 끝난 기록 상태인가.
pub(crate) fn settled_state(s: &str) -> bool {
    matches!(s, run::DONE | run::FAILED | run::RELEASED | run::SUCCEEDED)
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct StartBody {
    objective: String,
    projection: String,
    isolation: String,
    window_id: String,
    tool_id: String,
    /// 조정자의 작업 디렉터리 — 격리 Run 의 저장소·base 가 여기서 나온다 (FR-WKT-5).
    cwd: String,
    base: String,
    /// 이슈 트리 표지와 가지 여부 (FR-ITU-1).
    tree: String,
    tree_branch: bool,
    /// 로컬 이슈 트리의 원본 이슈 폴더(절대 경로) (ISSUE_TREE_CHAT_SRS FR-LIS-7).
    issue_dir: String,
    /// 트리 실행 방식 `tree`·`coord` (FR-LIS-1).
    mode: String,
    /// 트리 방의 채팅 방 id (FR-ITR-1).
    chat_room: String,
}

/// Go `memberAddReq`: `POST /api/runs/members` 의 본문.
#[derive(Deserialize, Default, Clone)]
#[serde(default, rename = "httpapi.memberAddReq", rename_all = "camelCase")]
pub(crate) struct MemberAddReq {
    pub(crate) run_id: String,
    pub(crate) role: String,
    pub(crate) agent: String,
    pub(crate) brief: String,
    pub(crate) id: String,
    /// `--at` 의 배타적 대안이다 (FR-HLM-1).
    pub(crate) headless: bool,
    /// 조정자의 작업 디렉터리. 헤드리스 멤버의 cwd 는 서버가 확정한다 (FR-HLM-2).
    pub(crate) cwd: String,
    /// 트리 Run 멤버의 배정 (FR-ITA-1).
    pub(crate) assign: Option<run::Assignment>,
}

/// Go `memberAddArgsError`: `--at` 과 `--headless` 가 정확히 하나인가 (FR-HLM-1).
pub(crate) fn member_add_args_error(body: &MemberAddReq) -> Option<RunFail> {
    if body.headless != body.id.is_empty() {
        return Some(invalid(
            "--at <탭 uuid> 와 --headless 중 정확히 하나가 필요하다",
        ));
    }
    None
}

/// Go `memberAddSpec`.
pub(crate) fn member_add_spec(
    body: &MemberAddReq,
    mi: &MemberIsolation,
    tool_id: &str,
    tab_id: &str,
) -> run::MemberSpec {
    run::MemberSpec {
        id: mi.id.clone(),
        role: body.role.clone(),
        agent: body.agent.clone(),
        brief: body.brief.clone(),
        tool_id: tool_id.to_owned(),
        tab_id: tab_id.to_owned(),
        worktree: mi.worktree.clone(),
        headless: body.headless,
        assign: body.assign.clone(),
    }
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct ReportBody {
    run_id: String,
    member_id: String,
    tool_id: String,
    outcome: String,
    summary: String,
    files: Option<Vec<String>>,
}

impl Server {
    pub(crate) fn runs(&self) -> Option<&Arc<run::Store>> {
        self.deps.runs.as_ref()
    }

    /// Go `runsReady`: 저장소 없는 배선은 503 이다 (NFR-RUN-1).
    pub(crate) fn runs_ready(&self) -> Result<Arc<run::Store>, Response> {
        self.runs().cloned().ok_or_else(|| {
            write_tool_io_error(StatusCode::SERVICE_UNAVAILABLE, "run store unavailable")
        })
    }

    /// 처리기의 동기 몸을 블로킹 스레드에서 돌린다.
    pub(crate) async fn run_sync(
        &self,
        r: &Req,
        f: impl FnOnce(&Server, &Rt) -> Response + Send + 'static,
    ) -> Response {
        let Some(srv) = self.arc() else {
            return server_gone();
        };
        let rt = Rt {
            h: Handle::current(),
            ctx: r.ctx.clone(),
        };
        off_thread(move || f(&srv, &rt))
            .await
            .unwrap_or_else(server_gone)
    }

    /// Go `deriveMemberState`: 멤버가 지금 무엇을 하는가. lost 는 확인된 죽음일 때만이다
    /// (FR-RIN-21). 쉬는 트리 노드에 열린 자식이 있으면 하위를 기다린다 (FR-ITC-4).
    pub(crate) fn derive_member_state(&self, m: &Member) -> String {
        if settled_state(&m.state) {
            return m.state.clone();
        }
        let live = self.tool_liveness(&m.tool_id) != Liveness::Dead;
        let hook = if live {
            self.tool_status_of(&m.tool_id, true).state
        } else {
            String::new()
        };
        let children = m.assign.is_some() && self.runs().is_some_and(|st| st.has_open_child(&m.id));
        member_state_from(&m.state, live, &hook, children)
    }

    pub(crate) fn member_view(&self, m: Member) -> MemberView {
        let state = self.derive_member_state(&m);
        MemberView::new(m, state)
    }

    /// Go `viewOf`.
    pub(crate) fn view_of(&self, rec: &Record) -> RunView {
        let open = rec.state == run::OPEN;
        let members = rec
            .members
            .iter()
            .map(|m| MemberView {
                state: self.derive_member_state(m),
                actions: Some(member_actions(m)),
                recoverable: open && self.recoverable(&crate::runs_recover::member_target(m)),
                ..MemberView::new(m.clone(), String::new())
            })
            .collect();
        RunView {
            rec: rec.clone(),
            members,
            orphans: self.orphan_headless(rec),
            actions: run_actions(rec),
            unreported: run_unreported(rec),
            liveness: self.run_liveness(rec),
            coordinator_recoverable: open
                && self.recoverable(&crate::runs_recover::coord_target(rec)),
        }
    }

    /// Go `runLiveness`: 열린 Run 의 열림을 물을 때 계산한다 (FR-ARD-4, D-ARD-4).
    fn run_liveness(&self, rec: &Record) -> &'static str {
        if rec.state != run::OPEN {
            return "";
        }
        let ids: Vec<&str> = std::iter::once(rec.coordinator_tool_id.as_str())
            .chain(rec.members.iter().map(|m| m.tool_id.as_str()))
            .filter(|id| !id.is_empty())
            .collect();
        let mut dead = 0;
        for id in &ids {
            match self.tool_liveness(id) {
                Liveness::Alive => return "open",
                Liveness::Dead => dead += 1,
                Liveness::Unknown => {}
            }
        }
        if !ids.is_empty() && dead == ids.len() {
            return "gone";
        }
        "unknown"
    }

    /// Go `runMember`: 없으면 `unknown_member` 다 — `sender_not_member` 는 권한의 사유다
    /// (FR-DRC-11).
    pub(crate) fn run_member(
        &self,
        st: &run::Store,
        member_id: &str,
    ) -> Result<(Record, Member), Response> {
        st.find_member(member_id).ok_or_else(|| {
            write_run_error(
                &RunFail::of(run::Error::UnknownMember),
                extra1("memberId", member_id),
            )
        })
    }

    /// GET /api/runs[?id=] (FR-RUN-8).
    pub(crate) async fn api_runs_get(&self, r: &mut Req) -> Response {
        let st = match self.runs_ready() {
            Ok(st) => st,
            Err(res) => return res,
        };
        let id = r.q("id");
        self.run_sync(r, move |s, _| {
            if !id.is_empty() {
                return match st.get(&id) {
                    Some(rec) => write_json(&s.view_of(&rec)),
                    None => write_run_error(&RunFail::of(run::Error::UnknownRun), Obj::new()),
                };
            }
            let views: Vec<RunView> = st.list().iter().map(|rec| s.view_of(rec)).collect();
            write_json(&extra1("runs", &views))
        })
        .await
    }

    /// POST /api/runs (FR-RUN-1).
    pub(crate) async fn api_run_start(&self, r: &mut Req) -> Response {
        let st = match self.runs_ready() {
            Ok(st) => st,
            Err(res) => return res,
        };
        let body: StartBody = match decode_json_body(r, 0).await {
            Ok(b) => b,
            Err(res) => return res,
        };
        let caller = self.caller_tool_id(r, &body.tool_id);
        self.run_sync(r, move |s, rt| s.run_start(&st, rt, body, caller))
            .await
    }

    fn run_start(&self, st: &run::Store, rt: &Rt, body: StartBody, caller: String) -> Response {
        let iso = if body.isolation.is_empty() {
            run::ISOLATION_NONE.to_owned()
        } else {
            body.isolation
        };
        if !run::valid_isolation(&iso) {
            let e = invalid(format!(
                "알 수 없는 isolation: {}",
                otter_gocompat::strconv::quote(&iso)
            ));
            return write_run_error(&e, Obj::new());
        }
        if !body.issue_dir.is_empty() && !std::path::Path::new(&body.issue_dir).is_absolute() {
            return write_run_error(&invalid("issueDir 는 절대 경로다"), Obj::new());
        }
        // 격리 준비가 레코드보다 먼저다 (FR-WKT-3/11). 실패한 Run 은 기록에 남지 않는다.
        let prov = match self.provision_run(rt, &iso, &body.cwd, &body.base) {
            Ok(p) => p,
            Err(e) => return write_run_error(&e, Obj::new()),
        };
        let mut opts = run::StartOptions {
            objective: body.objective,
            projection: body.projection,
            isolation: iso,
            coordinator_tool_id: caller,
            window_id: body.window_id,
            tree: body.tree,
            tree_branch: body.tree_branch,
            issue_dir: body.issue_dir,
            mode: body.mode,
            chat_room: body.chat_room,
            ..run::StartOptions::default()
        };
        if let Some(p) = &prov {
            opts.id = p.id.clone();
            opts.repo = p.repo.clone();
            opts.base = p.base.clone();
            opts.worktree = p.worktree.clone();
            opts.merge_into = p.merge_into.clone();
        }
        let rec = match st.start(opts) {
            Ok(rec) => rec,
            Err(e) => {
                self.rollback_run(prov.as_ref());
                let extra = self.tree_open_extra(&e);
                return write_run_error(&RunFail::of(e), extra);
            }
        };
        infof!(
            None,
            "[run] start id={} short={} projection={} isolation={} coordinator={}",
            rec.id,
            rec.short,
            rec.projection,
            rec.isolation,
            rec.coordinator_tool_id
        );
        self.broadcast_run_changed(&rec); // RUN_VIEW_LIVE_SRS FR-RLV-1
        write_json(&self.view_of(&rec))
    }

    /// POST /api/runs/members (FR-RUN-2). 도구는 탭 uuid 또는 살아 있는 toolId 로 지목한다
    /// (FR-IDU-4). 탭 uuid 는 서버가 채운다 (FR-RUN-9).
    pub(crate) async fn api_run_member_add(&self, r: &mut Req) -> Response {
        let st = match self.runs_ready() {
            Ok(st) => st,
            Err(res) => return res,
        };
        if let Err(res) = self.tool_io_ready() {
            return res;
        }
        let body: MemberAddReq = match decode_json_body(r, 0).await {
            Ok(b) => b,
            Err(res) => return res,
        };
        self.run_sync(r, move |s, rt| s.run_member_add(&st, rt, body))
            .await
    }

    fn run_member_add(&self, st: &run::Store, rt: &Rt, body: MemberAddReq) -> Response {
        if let Some(e) = member_add_args_error(&body) {
            return write_run_error(&e, Obj::new());
        }
        let mut tool_id = String::new();
        if !body.headless {
            match self.resolve_tool_id(&body.id) {
                Ok(id) => tool_id = id,
                Err(res) => return res,
            }
        }
        let Some(rec) = st.get(&body.run_id) else {
            return write_run_error(&RunFail::of(run::Error::UnknownRun), Obj::new());
        };
        // 작업 트리를 멤버 등록보다 먼저 만든다 — 반대 순서로는 트리 없는 멤버가 남는다 (FR-WKT-3).
        let mi = match self.provision_member(rt, &rec, &body.role) {
            Ok(mi) => mi,
            Err(e) => return write_run_error(&e, Obj::new()),
        };
        if body.headless {
            let cwd = match crate::runs_context::worktree_path(mi.worktree.as_ref()) {
                Some(p) => p,
                None => body.cwd.clone(),
            };
            match self.create_headless_tool(&cwd, "") {
                Ok(id) => tool_id = id,
                Err(e) => {
                    self.rollback_member(&mi);
                    return write_tool_io_error(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        &format!("헤드리스 도구 생성 실패: {e}"),
                    );
                }
            }
        }
        let spec = member_add_spec(&body, &mi, &tool_id, &self.tab_id_of_tool(&tool_id));
        let m = match st.add_member(&body.run_id, spec) {
            Ok(m) => m,
            Err(e) => {
                self.rollback_member_add(&mi, body.headless, &tool_id);
                let extra = self.node_taken_extra(&e);
                return write_run_error(&RunFail::of(e), extra);
            }
        };
        infof!(
            None,
            "[run] member run={} member={} role={} agent={} tool={} tab={}",
            body.run_id,
            m.id,
            m.role,
            m.agent,
            m.tool_id,
            m.tab_id
        );
        let view = self.member_added_view(st, &body.run_id, m);
        if let Some(rec) = st.get(&body.run_id) {
            self.broadcast_run_changed(&rec); // FR-RLV-2
        }
        write_json(&view)
    }

    /// Go `rollbackMemberAdd`: 등록에 실패한 멤버의 도구를 애초에 만들지 않은 것과 같게 되돌린다.
    fn rollback_member_add(&self, mi: &MemberIsolation, headless: bool, tool_id: &str) {
        if headless && let Some(hub) = self.tools(None) {
            // `GO-8`: 이 경로에서 "이미 없다" 는 정상이다 — 오류를 명시로 무시한다.
            let _ = hub.delete(tool_id);
            otter_shared_otterlog::errorf!(
                None,
                "[run] headless 롤백 — 멤버 등록 실패: tool={tool_id}"
            );
        }
        self.rollback_member(mi);
    }

    /// Go `memberAddedView`: 표식을 쓰고 프리앰블을 싣는다 (FR-PRE-1).
    fn member_added_view(&self, st: &run::Store, run_id: &str, m: Member) -> MemberView {
        let mut view = self.member_view(m);
        if let Some(rec) = st.get(run_id) {
            self.mark_workspace_run(&rec, &view.member.tab_id, &rec.id);
            view.preamble = self.member_preamble(&rec, &view.member);
        }
        view
    }

    /// GET /api/runs/preamble?member= (FR-PRE-1). 기록에서 같은 텍스트를 다시 만든다.
    pub(crate) async fn api_run_preamble(&self, r: &mut Req) -> Response {
        let st = match self.runs_ready() {
            Ok(st) => st,
            Err(res) => return res,
        };
        let member_id = r.q("member");
        self.run_sync(r, move |s, rt| s.run_preamble(&st, rt, &member_id))
            .await
    }

    fn run_preamble(&self, st: &run::Store, rt: &Rt, member_id: &str) -> Response {
        let (mut rec, mut m) = match self.run_member(st, member_id) {
            Ok(v) => v,
            Err(res) => return res,
        };
        // UX_BATCH6_SRS FR-RUN-4·5: 청해 두고 아직 오지 않은 인수인계를 상한만큼 기다린다.
        if st.handoff_waiting(&m.id) {
            if !self.wait_handoff(st, rt, &m.id) {
                // 묻는 쪽이 사라졌다 — 표식은 그대로 둔다.
                return server_gone();
            }
            // FR-SAF-5: 인수인계 절이 전임자의 요약을 `rec.members` 에서 찾으므로 rec 도 다시 읽는다.
            if let Some((cur_rec, cur)) = st.find_member(&m.id) {
                (rec, m) = (cur_rec, cur);
            }
        }
        let mut out = Obj::new();
        out.insert("runId", raw(&rec.id));
        out.insert("memberId", raw(&m.id));
        out.insert("role", raw(&m.role));
        out.insert("agent", raw(&m.agent));
        out.insert("tabId", raw(&m.tab_id));
        out.insert("toolId", raw(&m.tool_id));
        out.insert("runState", raw(&rec.state));
        out.insert("preamble", raw(&self.member_preamble(&rec, &m)));
        // ISSUE_TREE_CHAT_SRS FR-ITR-6: 트리 방이 있는 트리 멤버의 첫 지시는 파일로 넘긴다. 그 밖은 Go 기준선 모양 그대로다.
        if !rec.chat_room.is_empty() && m.assign.is_some() {
            out.insert("promptFile", raw(&true));
        }
        write_json(&out)
    }

    /// Go `waitHandoff`: 상한을 넘기면 기다림을 접는다 (FR-RUN-5). 요청이 먼저 끊기면 false 다.
    fn wait_handoff(&self, st: &run::Store, rt: &Rt, member_id: &str) -> bool {
        // FR-OPT-8-4 (HTTP-31): 요약은 Run 저장소를 지나 도착한다 — 바뀔 때만 다시 묻는다.
        let res = rt.wait(pollwait::on(
            &rt.ctx,
            HANDOFF_PREAMBLE_WAIT,
            || st.changes(),
            || !st.handoff_waiting(member_id),
        ));
        match res {
            Ok(()) => true,
            Err(pollwait::WaitError::Canceled) => false,
            Err(pollwait::WaitError::Timeout) => {
                infof!(
                    None,
                    "[run] handoff 기다림 종료 member={member_id} wait={} — 요약 없이 프리앰블을 낸다",
                    otter_gocompat::time::format_std_duration(HANDOFF_PREAMBLE_WAIT)
                );
                st.give_up_handoff(member_id);
                true
            }
        }
    }

    /// POST /api/runs/report (FR-PRE-2/5/7).
    pub(crate) async fn api_run_report(&self, r: &mut Req) -> Response {
        let st = match self.runs_ready() {
            Ok(st) => st,
            Err(res) => return res,
        };
        let body: ReportBody = match decode_json_body(r, 0).await {
            Ok(b) => b,
            Err(res) => return res,
        };
        let sender = self.caller_tool_id(r, &body.tool_id);
        self.run_sync(r, move |s, _| {
            let spec = run::ReportSpec {
                run_id: body.run_id,
                member_id: body.member_id,
                outcome: body.outcome,
                summary: body.summary,
                files_modified: body.files.unwrap_or_default(),
            };
            let m = match st.report(&sender, spec) {
                Ok(m) => m,
                Err(e) => return write_run_error(&RunFail::of(e), Obj::new()),
            };
            infof!(
                None,
                "[run] report run={} member={} tool={} outcome={} files={}",
                m.run_id,
                m.id,
                m.tool_id,
                m.outcome,
                m.files_modified.len()
            );
            // FR-RVZ-16: 보고는 멤버의 상태를 바꾼다 — 열린 대시보드가 다시 받게 한다.
            if let Some(rec) = st.get(&m.run_id) {
                s.broadcast_run_changed(&rec);
            }
            let state = m.state.clone();
            write_json(&MemberView::new(m, state))
        })
        .await
    }
}
