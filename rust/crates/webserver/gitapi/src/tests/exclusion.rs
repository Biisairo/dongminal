//! Go `handlers_git_exclusion_test.go` 중 5.4.1 이 건너뛴 stage·resolve·pull·fetch·
//! branch/delete-remote 갈래와 `handlers_git_actions_slots_test.go`·`handlers_git_actions_facts_test.go`
//! 의 칸을 보는 status actions 갈래 (REPO_FIX 01 §5.4·5.5·7.2 · GR-1·GR-2a).
//!
//! 옮기지 않은 것:
//! - TestExclusion_CanceledWhileWaitingNotExecuted·TestExclusion_ReleasedAfterResponse·
//!   TestIndexLocked_SyncWriteCarriesLock·TestIndexLocked_GoneLockOmitsMtime·TestLockRemove_*:
//!   5.4.1 이 같은 흐름을 replay·lock/remove 로 write.rs 에 옮겼다.
//! - TestWriteLocks_CoverAllPostRoutes: 두 방향 모두 `write.rs` 의 `write_locks_cover_post_routes` 다.
//! - TestExclusion_StashTakesCommonDirLock·TestIndexLocked_StashCarriesLock·
//!   TestRemoteRefDelete_NoHintWhenJobBusy 의 tag 갈래: `carryover.rs` 에 있다.

use std::sync::{Arc, Mutex, Once};
use std::time::{Duration, Instant};

use dm_webserver_domain_git_core::{self as core, Ctx, Output};
use dm_webserver_domain_git_jobs::{Exclusion, Keys};
use http::Method;
use serde_json::{Value, json};

use super::answers::{branch_server, repo, status_actions};
use super::harness::{q, req};
use super::wfake::{WEnv, WriteFake, remote_hold, wserver_with};
use crate::GitServer;
use crate::req::Req;

const WAIT: Duration = Duration::from_millis(80);

struct XEnv {
    e: WEnv,
    x: Exclusion,
    release: Arc<tokio::sync::Semaphore>,
}

impl Drop for XEnv {
    fn drop(&mut self) {
        self.release.close();
    }
}

/// Go `exclServer`: 짧은 잠금 대기와 매달리는 잡 실행기를 가진 서버다.
fn excl_server(f: &WriteFake) -> XEnv {
    let x = Exclusion::new();
    let release = Arc::new(tokio::sync::Semaphore::new(0));
    let (xc, rc) = (x.clone(), release.clone());
    let e = wserver_with(f, move |s| {
        s.exclusion = Some(xc);
        s.lock_wait = WAIT;
        s.job_runner = Some(remote_hold(rc));
    });
    XEnv { e, x, release }
}

/// fake 는 toplevel 로 요청 dir, common-dir 로 gitDir 을 준다.
fn excl_keys(f: &WriteFake) -> Keys {
    Keys {
        top: core::exclusion_key(&repo()),
        common: core::exclusion_key(&f.git_dir()),
    }
}

fn excl_writes(f: &WriteFake, sub: &str) -> usize {
    f.wrote()
        .iter()
        .filter(|a| a.first().map(String::as_str) == Some(sub))
        .count()
}

fn stage_body() -> String {
    format!(r#"{{"repo":{},"paths":["a.txt"]}}"#, q(&repo()))
}

fn repo_body() -> String {
    format!(r#"{{"repo":{}}}"#, q(&repo()))
}

async fn post(s: &Arc<GitServer>, path: &str, body: &str) -> (u16, Value) {
    let r = req(s, "POST", path, body).await;
    (r.code, r.json())
}

fn want(got: (u16, Value), code: u16, err: &str, what: &str) {
    assert!(
        got.0 == code && got.1["error"] == err,
        "{what} = {} {}, want {code} {err}",
        got.0,
        got.1
    );
}

// 행렬 1행: 아무것도 없으면 둘 다 실행된다.
#[tokio::test]
async fn exclusion_matrix_idle() {
    let f = WriteFake::new();
    let x = excl_server(&f);
    let (code, out) = post(&x.e.s, "/api/git/stage", &stage_body()).await;
    assert_eq!(code, 200, "동기 쓰기: {out}");
    let (code, out) = post(&x.e.s, "/api/git/pull", &repo_body()).await;
    assert_eq!(code, 200, "index 잡: {out}");
}

// 행렬 2행: 동기 쓰기가 뮤텍스를 쥐고 있다 — 동기 쓰기·index 잡은 상한까지 기다린 뒤 409
// repo_busy, 비-index 잡은 실행.
#[tokio::test]
async fn exclusion_matrix_sync_write_held() {
    let f = WriteFake::new();
    let x = excl_server(&f);
    let rel =
        x.x.lock_top(
            &Ctx::background(),
            &excl_keys(&f).top,
            Duration::from_secs(1),
        )
        .await
        .unwrap();
    let started = Instant::now();
    want(
        post(&x.e.s, "/api/git/stage", &stage_body()).await,
        409,
        "repo_busy",
        "동기 쓰기",
    );
    assert!(started.elapsed() >= WAIT, "잠금 상한을 기다리지 않았다");
    assert_eq!(excl_writes(&f, "add"), 0, "막힌 쓰기가 실행됐다");
    want(
        post(&x.e.s, "/api/git/pull", &repo_body()).await,
        409,
        "repo_busy",
        "index 잡",
    );
    let (code, out) = post(&x.e.s, "/api/git/fetch", &repo_body()).await;
    assert_eq!(code, 200, "비-index 잡: {out}");
    rel.release();
}

// 행렬 3행: index 잡(pull)이 돈다 — 동기 쓰기는 즉시 job_busy, index 잡도 job_busy, 비-index
// 잡은 pull 이 common 칸도 쥐므로 job_busy.
#[tokio::test]
async fn exclusion_matrix_index_job_running() {
    let f = WriteFake::new();
    let x = excl_server(&f);
    let (code, out) = post(&x.e.s, "/api/git/pull", &repo_body()).await;
    assert_eq!(code, 200, "pull 시작: {out}");
    let started = Instant::now();
    want(
        post(&x.e.s, "/api/git/stage", &stage_body()).await,
        409,
        "job_busy",
        "동기 쓰기",
    );
    assert!(
        started.elapsed() < WAIT,
        "job_busy 가 잠금 대기를 거쳤다 — 즉시여야 한다"
    );
    want(
        post(&x.e.s, "/api/git/pull", &repo_body()).await,
        409,
        "job_busy",
        "index 잡",
    );
    want(
        post(&x.e.s, "/api/git/fetch", &repo_body()).await,
        409,
        "job_busy",
        "pull 중 fetch (두 칸)",
    );
}

// 행렬 4행: 비-index 잡(fetch)이 돈다 — 동기 쓰기는 실행, pull·fetch 는 job_busy(common 칸).
#[tokio::test]
async fn exclusion_matrix_common_job_running() {
    let f = WriteFake::new();
    let x = excl_server(&f);
    let (code, out) = post(&x.e.s, "/api/git/fetch", &repo_body()).await;
    assert_eq!(code, 200, "fetch 시작: {out}");
    let (code, out) = post(&x.e.s, "/api/git/stage", &stage_body()).await;
    assert_eq!(code, 200, "fetch 중 동기 쓰기: {out}");
    want(
        post(&x.e.s, "/api/git/pull", &repo_body()).await,
        409,
        "job_busy",
        "fetch 중 pull",
    );
    want(
        post(&x.e.s, "/api/git/fetch", &repo_body()).await,
        409,
        "job_busy",
        "fetch 중 fetch",
    );
}

/// 요청 ctx 를 쥔 채 stage 종단을 직접 부른다 — `handle` 은 ctx 를 밖에 내주지 않는다.
fn stage_req() -> (Req, Ctx) {
    let mut r = Req::for_test(Method::POST, "/api/git/stage", &stage_body());
    r.lease = crate::lock::write_lease(&Method::POST, "/api/git/stage").map(Arc::new);
    let ctx = r.ctx.clone();
    (r, ctx)
}

async fn run_stage(s: &Arc<GitServer>, mut r: Req) -> dm_shared_httpresp::Response {
    let res = s.api_git_stage(&mut r).await;
    if let Some(l) = &r.lease {
        l.release();
    }
    res
}

// §5.5: 쓰기 단계는 서버 루트 ctx 에서 파생한다 — 쓰기가 시작된 뒤 요청이 떠나도 쓰기와 사후
// 단계는 끝까지 간다.
#[tokio::test]
async fn exclusion_write_phase_ignores_request_cancel() {
    let f = WriteFake::new();
    let x = excl_server(&f);
    let (r, ctx) = stage_req();
    let seen: Arc<Mutex<Option<bool>>> = Arc::default();
    let once = Arc::new(Once::new());
    let sc = seen.clone();
    f.lock().write_ctx = Some(Arc::new(move |wctx: &Ctx| {
        once.call_once(|| {
            ctx.cancel();
            *sc.lock().unwrap() = Some(wctx.err().is_some());
        });
    }));
    let res = run_stage(&x.e.s, r).await;
    assert_eq!(
        *seen.lock().unwrap(),
        Some(false),
        "요청 취소가 쓰기 ctx 로 번졌다"
    );
    assert_eq!(
        res.status().as_u16(),
        200,
        "쓰기 뒤 이탈은 200 이어야 한다 (사후 단계까지 끝낸다)"
    );
}

// §5.5 ④: 사전 단계 뒤·쓰기 직전에 요청이 떠났으면 실행하지 않는다.
#[tokio::test]
async fn exclusion_canceled_before_write_not_executed() {
    let f = WriteFake::new();
    let x = excl_server(&f);
    let (r, ctx) = stage_req();
    f.lock().on_status = Some(Arc::new(move || ctx.cancel()));
    let res = run_stage(&x.e.s, r).await;
    assert_eq!(
        excl_writes(&f, "add"),
        0,
        "쓰기 직전에 떠난 요청이 실행됐다"
    );
    assert_eq!(res.status().as_u16(), 499);
    assert_eq!(res.headers()["x-error-code"], "git_canceled");
}

fn index_locked(git_dir: &str) -> Output {
    Output {
        exit_code: 128,
        stderr: format!("fatal: Unable to create '{git_dir}/index.lock': File exists.\n"),
        ..Output::default()
    }
}

// §7.4: 충돌 해결의 경로 오류에 index_locked 가 있으면 resolve_partial 보다 앞선다.
#[tokio::test]
async fn index_locked_resolve_priority() {
    let f = WriteFake::new();
    let gd = f.git_dir();
    f.lock().write_err = Some(Arc::new(move |argv: &[String]| {
        // 4.2.1 DIFF-14: 경로는 축자 pathspec(`:(literal)b.txt`)으로 온다.
        if argv.last().is_some_and(|a| a.ends_with("b.txt")) {
            return Ok(index_locked(&gd));
        }
        Ok(Output::default())
    }));
    let x = excl_server(&f);
    let body = format!(
        r#"{{"repo":{},"side":"ours","paths":["a.txt","b.txt"],"confirm":true}}"#,
        q(&repo())
    );
    let (code, out) = post(&x.e.s, "/api/git/resolve", &body).await;
    want((code, out.clone()), 409, "index_locked", "resolve");
    assert!(
        !out["results"].is_null() && !out["status"].is_null() && !out["lock"].is_null(),
        "results·status·lock 이 없다: {out}"
    );
}

// FR-OPT-1-3 (DOM-6): 잡 등록이 실패하면(job_busy) 원격 ref 삭제의 hint 를 남기지 않는다 —
// 실행되지 않은 삭제의 복구 안내는 거짓이다 (§5.1).
#[tokio::test]
async fn remote_ref_delete_no_hint_when_job_busy() {
    let release = Arc::new(tokio::sync::Semaphore::new(0));
    let rc = release.clone();
    let b = branch_server(move |s| s.job_runner = Some(remote_hold(rc)));
    let body = format!(
        r#"{{"repo":{},"remote":"origin","branch":"feat","confirm":true}}"#,
        q(&repo())
    );
    let (code, out) = post(&b.s, "/api/git/branch/delete-remote", &body).await;
    assert_eq!(code, 200, "첫 삭제: {out}");
    want(
        post(&b.s, "/api/git/branch/delete-remote", &body).await,
        409,
        "job_busy",
        "둘째 삭제",
    );
    let hints = b.s.git.as_ref().unwrap().service().hints(0);
    assert_eq!(
        hints.len(),
        1,
        "등록되지 않은 잡의 hint 가 남았다: {hints:?}"
    );
    release.close();
}

/// Go `wantAnswers`.
fn want_answers(acts: &Value, want: &[(&str, bool)]) {
    for (id, ok) in want {
        let a = &acts[*id];
        assert!(a.is_object(), "{id} 의 답이 없다");
        assert_eq!(a["ok"], json!(ok), "{id} = {a}");
        if !ok {
            assert_eq!(a["why"], "job_busy", "{id} why");
            assert!(
                dm_webserver_action::may_give(&dm_webserver_action::catalog(), id, "job_busy"),
                "{id} 가 동작 목록에 job_busy 를 갖지 않는다"
            );
        }
    }
}

// TC-SDA-5 (GR-1b·c): 1층 답은 칸 상태를 따른다 — fetch 가 도는 동안 common 칸 동작은 꺼지고
// index 칸 동작은 켜져 있다.
#[tokio::test]
async fn status_actions_follow_slots() {
    use dm_webserver_action::*;
    let f = WriteFake::new();
    let x = excl_server(&f);
    let (_, idle) = status_actions(&x.e.s, "").await;
    let all = [
        GIT_FETCH,
        GIT_PULL,
        GIT_PUSH,
        GIT_WRITE,
        GIT_LOCK_REMOVE,
        GIT_WORKTREE_CREATE,
        GIT_SUBMODULE_UPDATE,
        GIT_TAG_PUSH,
        GIT_TAG_DELETE_REMOTE,
    ];
    want_answers(&idle, &all.map(|id| (id, true)));
    let (code, out) = post(&x.e.s, "/api/git/fetch", &repo_body()).await;
    assert_eq!(code, 200, "fetch 시작: {out}");
    let (_, busy) = status_actions(&x.e.s, "").await;
    want_answers(&busy, &all.map(|id| (id, id == GIT_WRITE)));
}

// GR-1b: pull 은 두 칸을 쥔다 — 동기 쓰기도 꺼진다.
#[tokio::test]
async fn status_actions_pull_holds_both() {
    use dm_webserver_action::*;
    let f = WriteFake::new();
    let x = excl_server(&f);
    let (code, out) = post(&x.e.s, "/api/git/pull", &repo_body()).await;
    assert_eq!(code, 200, "pull 시작: {out}");
    let (_, acts) = status_actions(&x.e.s, "").await;
    want_answers(
        &acts,
        &[(GIT_WRITE, false), (GIT_FETCH, false), (GIT_PUSH, false)],
    );
}

// GR-1c: 잡 상태는 mark 밖이다 — unchanged 응답에도 actions 가 실린다.
#[tokio::test]
async fn status_actions_in_unchanged() {
    use dm_webserver_action::*;
    let f = WriteFake::new();
    let x = excl_server(&f);
    let (out, _) = status_actions(&x.e.s, "").await;
    let mark = out["mark"].as_str().unwrap_or_default().to_owned();
    assert!(!mark.is_empty(), "mark 가 없다: {out}");
    let (code, o) = post(&x.e.s, "/api/git/fetch", &repo_body()).await;
    assert_eq!(code, 200, "fetch 시작: {o}");
    let (again, acts) =
        status_actions(&x.e.s, &format!("&ifMark={}", super::harness::qe(&mark))).await;
    assert_eq!(again["unchanged"], true, "unchanged 응답이 아니다: {again}");
    want_answers(&acts, &[(GIT_FETCH, false), (GIT_WRITE, true)]);
}

// TC-SDA-1 (D-SDA-6): 답이 거짓이면 실행이 같은 코드로 거절된다 — 동기 쓰기·잡 시작·lock
// 지우기 대표 셋.
#[tokio::test]
async fn status_actions_match_rejection() {
    use dm_webserver_action::*;
    let f = WriteFake::new();
    let x = excl_server(&f);
    let (code, out) = post(&x.e.s, "/api/git/pull", &repo_body()).await;
    assert_eq!(code, 200, "pull 시작: {out}");
    let (_, acts) = status_actions(&x.e.s, "").await;
    let lock_body = format!(
        r#"{{"repo":{},"confirm":true,"mtimeUnixMs":1}}"#,
        q(&repo())
    );
    for (id, path, body) in [
        (GIT_WRITE, "/api/git/stage", stage_body()),
        (GIT_FETCH, "/api/git/fetch", repo_body()),
        (GIT_LOCK_REMOVE, "/api/git/lock/remove", lock_body),
    ] {
        let a = &acts[id];
        let (code, out) = post(&x.e.s, path, &body).await;
        assert!(
            a["ok"] == false && code == 409 && out["error"] == a["why"],
            "{id}: 답 {a} · 실행 {code} {} — 같은 코드로 거절돼야 한다",
            out["error"]
        );
    }
}

// GR-2a: 칸이 먼저다 — index 잡이 돌면 상태 사실과 무관하게 job_busy.
#[tokio::test]
async fn fact_answers_slot_first() {
    use dm_webserver_action::*;
    let f = WriteFake::new();
    let x = excl_server(&f);
    let (code, out) = post(&x.e.s, "/api/git/pull", &repo_body()).await;
    assert_eq!(code, 200, "pull 시작: {out}");
    let (_, acts) = status_actions(&x.e.s, "").await;
    for id in [GIT_STASH_NEW, GIT_UNCOMMITTED_RESET, GIT_UNCOMMITTED_CLEAN] {
        let a = &acts[id];
        assert!(
            a["ok"] == false && a["why"] == "job_busy",
            "{id} = {a}, want job_busy"
        );
    }
}
