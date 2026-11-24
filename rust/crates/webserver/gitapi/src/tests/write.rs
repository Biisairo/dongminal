//! Go `gitwrite_test.go`·`handlers_git_exclusion_test.go`·`handlers_git_shutdown_test.go` 중 5.4.1 범위.
//! Go 는 stage·stash 종단으로 시험하지만, 여기서는 같은 흐름(GitWrite·임대·잠금)을 지나는 5.4.1 종단
//! (records/replay·lock/remove)으로 시험한다. stage·resolve·pull 갈래는 `exclusion.rs`, stash 갈래는 `carryover.rs` 에 있다.

use std::sync::Arc;
use std::time::{Duration, Instant};

use http::Method;
use otter_webserver_domain_git_core::{self as core, Ctx, Output, WriteSpec};
use otter_webserver_domain_git_jobs::{Exclusion, JobRunner, Keys, StartOptions};
use otter_webserver_domain_git_store::{Store, StoreOptions};
use serde_json::json;

use super::harness::*;
use crate::GitServer;
use crate::req::Req;

const WAIT: Duration = Duration::from_millis(80);

fn repo() -> String {
    abs(&["work", "repo"])
}

/// 잡이 멈춰 있는 실행기 — 세마포어가 닫힐 때까지 끝나지 않는다.
fn held_runner(sem: Arc<tokio::sync::Semaphore>) -> JobRunner {
    Arc::new(move |_, _, _, _, _| {
        let sem = sem.clone();
        Box::pin(async move {
            let _ = sem.acquire().await;
            (0, None)
        })
    })
}

struct WEnv {
    e: Env,
    x: Exclusion,
    hold: Arc<tokio::sync::Semaphore>,
}

fn wenv_with(edit: impl FnOnce(&mut GitServer) + 'static) -> WEnv {
    let x = Exclusion::new();
    let hold = Arc::new(tokio::sync::Semaphore::new(0));
    let (xc, hc) = (x.clone(), hold.clone());
    let e = env_with(GitFake::new(), move |s| {
        s.exclusion = Some(xc);
        s.lock_wait = WAIT;
        s.job_runner = Some(held_runner(hc));
        edit(s);
    });
    WEnv { e, x, hold }
}

fn keys(e: &Env) -> Keys {
    Keys {
        top: core::exclusion_key(&repo()),
        common: core::exclusion_key(&e.g.git_dir()),
    }
}

/// 쓰기 기록 하나(checkout dev)를 남기고 그 seq 를 준다.
async fn write_record(e: &Env) -> u64 {
    let svc = e.s.git.as_ref().unwrap().service();
    let spec = WriteSpec {
        argv: vec!["checkout".to_owned(), "dev".to_owned()],
        ..WriteSpec::default()
    };
    let _ = svc.exec_write(&Ctx::background(), &repo(), &spec).await;
    svc.records(0).iter().rev().find(|r| r.write).unwrap().seq
}

fn checkouts(e: &Env) -> usize {
    e.g.calls()
        .iter()
        .filter(|c| c.starts_with("checkout"))
        .count()
}

async fn replay(e: &Env, seq: u64) -> (u16, serde_json::Value) {
    let r = req(
        &e.s,
        "POST",
        "/api/git/records/replay",
        &format!(r#"{{"repo":{},"seq":{seq},"confirm":true}}"#, q(&repo())),
    )
    .await;
    (r.code, r.json())
}

// 동기 쓰기는 잠금 상한만큼 기다린 뒤 409 repo_busy 로 거절하고 실행하지 않는다.
#[tokio::test]
async fn sync_write_held_is_repo_busy() {
    let w = wenv_with(|_| {});
    let seq = write_record(&w.e).await;
    let n = checkouts(&w.e);
    let rel =
        w.x.lock_top(&Ctx::background(), &keys(&w.e).top, Duration::from_secs(1))
            .await
            .unwrap();
    let started = Instant::now();
    let (code, out) = replay(&w.e, seq).await;
    assert_eq!(
        (code, out["error"].clone()),
        (409, json!("repo_busy")),
        "{out}"
    );
    assert!(started.elapsed() >= WAIT);
    assert_eq!(checkouts(&w.e), n);
    rel.release();
}

// 응답 뒤에는 뮤텍스가 풀려 있다.
#[tokio::test]
async fn released_after_response() {
    let w = wenv_with(|_| {});
    let seq = write_record(&w.e).await;
    for i in 0..3 {
        let (code, out) = replay(&w.e, seq).await;
        assert_eq!(code, 200, "{i}: {out}");
    }
    assert!(
        w.x.try_lock_top(&keys(&w.e).top).is_some(),
        "응답 뒤에도 뮤텍스가 쥐여 있다"
    );
}

// 대기 중에 요청이 떠나면 쓰기를 실행하지 않는다 — Go 처럼 499 git_canceled 다.
#[tokio::test]
async fn canceled_while_waiting_not_executed() {
    let w = wenv_with(|s| s.lock_wait = Duration::from_secs(1));
    let seq = write_record(&w.e).await;
    let n = checkouts(&w.e);
    let rel =
        w.x.lock_top(&Ctx::background(), &keys(&w.e).top, Duration::from_secs(1))
            .await
            .unwrap();
    let mut r = Req::for_test(
        Method::POST,
        "/api/git/records/replay",
        &format!(r#"{{"repo":{},"seq":{seq},"confirm":true}}"#, q(&repo())),
    );
    r.lease = crate::lock::write_lease(&Method::POST, "/api/git/records/replay").map(Arc::new);
    let ctx = r.ctx.clone();
    let s = w.e.s.clone();
    let task = tokio::spawn(async move {
        let res = s.api_git_replay(&mut r).await;
        if let Some(l) = &r.lease {
            l.release();
        }
        res
    });
    tokio::time::sleep(WAIT / 2).await;
    ctx.cancel();
    let res = task.await.unwrap();
    rel.release();
    assert_eq!(res.status().as_u16(), 499);
    assert_eq!(res.headers()["x-error-code"], "git_canceled");
    assert_eq!(checkouts(&w.e), n);
}

// 잡이 index 칸을 쥐면 409 job_busy 다.
#[tokio::test]
async fn index_job_running_is_job_busy() {
    let w = wenv_with(|_| {});
    let seq = write_record(&w.e).await;
    let git = w.e.s.git.clone().unwrap();
    let spec = WriteSpec {
        argv: vec!["pull".to_owned()],
        ..WriteSpec::default()
    };
    w.e.s
        .jobs_hub(&git)
        .start(&repo(), keys(&w.e), "pull", spec, StartOptions::default())
        .unwrap();
    let (code, out) = replay(&w.e, seq).await;
    assert_eq!(
        (code, out["error"].clone()),
        (409, json!("job_busy")),
        "{out}"
    );
    assert!(out["args"]["job"].is_string());
    w.hold.close();
}

fn index_locked(
    git_dir: String,
) -> impl Fn(&str, &[String]) -> Option<Output> + Send + Sync + 'static {
    move |_, args| {
        if args.len() > 2 && args[1] == "--git-path" {
            return Some(out(&format!("{git_dir}/index.lock\n")));
        }
        (args[0] == "checkout").then(|| Output {
            exit_code: 128,
            stderr: format!("fatal: Unable to create '{git_dir}/index.lock': File exists.\n"),
            ..Output::default()
        })
    }
}

// index.lock 에 막힌 쓰기는 lock 경로·mtime 을 싣는다 (REPO_FIX 01 §7.2).
#[tokio::test]
async fn index_locked_carries_lock() {
    let w = wenv_with(|_| {});
    let seq = write_record(&w.e).await;
    w.e.g.set_extra(index_locked(w.e.g.git_dir()));
    let lock = format!("{}/index.lock", w.e.g.git_dir());
    // 사라진 lock 은 mtime 을 싣지 않는다.
    let (code, out) = replay(&w.e, seq).await;
    assert_eq!(
        (code, out["error"].clone()),
        (409, json!("index_locked")),
        "{out}"
    );
    assert!(out["lock"]["path"].is_string());
    assert!(out["lock"].get("mtimeUnixMs").is_none());
    assert_eq!(out["partial"], false);
    assert!(out["status"].is_object());
    std::fs::write(&lock, "").unwrap();
    let (code, out) = replay(&w.e, seq).await;
    assert_eq!(code, 409);
    assert!(out["lock"]["mtimeUnixMs"].as_i64().unwrap() > 0, "{out}");
}

fn lock_body(extra: &str) -> String {
    format!(r#"{{"repo":{}{extra}}}"#, q(&repo()))
}

fn mtime_ms(p: &str) -> i64 {
    let t = std::fs::symlink_metadata(p).unwrap().modified().unwrap();
    t.duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64
}

#[tokio::test]
async fn lock_remove_requires_confirm() {
    let w = wenv_with(|_| {});
    let r = req(
        &w.e.s,
        "POST",
        "/api/git/lock/remove",
        &lock_body(r#","mtimeUnixMs":1"#),
    )
    .await;
    assert_eq!(
        (r.code, r.json()["error"].clone()),
        (400, json!("confirmation_required"))
    );
    assert_eq!(
        r.json()["message"],
        "index.lock 삭제는 confirm:true 를 요구한다 (FR-GIT-89)"
    );
}

#[tokio::test]
async fn lock_remove_removes() {
    let w = wenv_with(|_| {});
    let lock = format!("{}/index.lock", w.e.g.git_dir());
    std::fs::write(&lock, "").unwrap();
    w.e.g.set_extra({
        let l = lock.clone();
        move |_, a| (a.len() > 2 && a[1] == "--git-path").then(|| out(&format!("{l}\n")))
    });
    let body = lock_body(&format!(
        r#","confirm":true,"mtimeUnixMs":{}"#,
        mtime_ms(&lock)
    ));
    let r = req(&w.e.s, "POST", "/api/git/lock/remove", &body).await;
    assert_eq!(r.code, 200, "{}", r.text());
    let out = r.json();
    assert_eq!(
        (
            out["removed"].clone(),
            out["lockPath"].clone(),
            out["ok"].clone()
        ),
        (json!(true), json!(lock), json!(true))
    );
    assert!(!std::path::Path::new(&lock).exists());
    let r = req(&w.e.s, "POST", "/api/git/lock/remove", &body).await;
    assert_eq!((r.code, r.json()["removed"].clone()), (200, json!(false)));
}

#[tokio::test]
async fn lock_remove_stale_mtime_and_not_regular() {
    let w = wenv_with(|_| {});
    let lock = format!("{}/index.lock", w.e.g.git_dir());
    w.e.g.set_extra({
        let l = lock.clone();
        move |_, a| (a.len() > 2 && a[1] == "--git-path").then(|| out(&format!("{l}\n")))
    });
    std::fs::write(&lock, "").unwrap();
    let body = lock_body(r#","confirm":true,"mtimeUnixMs":1"#);
    let r = req(&w.e.s, "POST", "/api/git/lock/remove", &body).await;
    assert_eq!(
        (r.code, r.json()["error"].clone()),
        (409, json!("stale_observation"))
    );
    assert_eq!(
        r.json()["lock"],
        json!({"path": lock, "mtimeUnixMs": mtime_ms(&lock)})
    );
    assert!(std::path::Path::new(&lock).exists());
    std::fs::remove_file(&lock).unwrap();
    std::fs::create_dir(&lock).unwrap();
    let r = req(&w.e.s, "POST", "/api/git/lock/remove", &body).await;
    assert_eq!(r.code, 400);
    assert_eq!(r.json()["message"], format!("{lock} 는 일반 파일이 아니다"));
}

// 이 저장소의 index.lock 이 아닌 경로는 지우지 않는다.
#[tokio::test]
async fn lock_remove_rejects_foreign_path() {
    let w = wenv_with(|_| {});
    w.e.g
        .set_extra(|_, a| (a.len() > 2 && a[1] == "--git-path").then(|| out("/etc/index.lock\n")));
    let r = req(
        &w.e.s,
        "POST",
        "/api/git/lock/remove",
        &lock_body(r#","confirm":true,"mtimeUnixMs":1"#),
    )
    .await;
    assert_eq!(r.code, 400);
    assert_eq!(
        r.json()["message"],
        "/etc/index.lock 는 이 저장소의 index.lock 이 아니다"
    );
}

#[tokio::test]
async fn lock_remove_busy_and_job() {
    let w = wenv_with(|_| {});
    let lock = format!("{}/index.lock", w.e.g.git_dir());
    std::fs::write(&lock, "").unwrap();
    let body = lock_body(r#","confirm":true,"mtimeUnixMs":1"#);
    let rel =
        w.x.lock_top(&Ctx::background(), &keys(&w.e).top, Duration::from_secs(1))
            .await
            .unwrap();
    let started = Instant::now();
    let r = req(&w.e.s, "POST", "/api/git/lock/remove", &body).await;
    rel.release();
    assert_eq!(
        (r.code, r.json()["error"].clone()),
        (409, json!("repo_busy"))
    );
    assert!(started.elapsed() < WAIT, "TryLock 이어야 하는데 기다렸다");
    let git = w.e.s.git.clone().unwrap();
    let spec = WriteSpec {
        argv: vec!["fetch".to_owned()],
        ..WriteSpec::default()
    };
    w.e.s
        .jobs_hub(&git)
        .start(&repo(), keys(&w.e), "fetch", spec, StartOptions::default())
        .unwrap();
    let r = req(&w.e.s, "POST", "/api/git/lock/remove", &body).await;
    assert_eq!(
        (r.code, r.json()["error"].clone()),
        (409, json!("job_busy"))
    );
    assert!(std::path::Path::new(&lock).exists());
    // 잡의 시작·끝은 git_jobs_changed 로 알린다.
    assert!(
        w.e.cb
            .published
            .lock()
            .unwrap()
            .iter()
            .any(|p| p == br#"{"action":"git_jobs_changed"}"#)
    );
    w.hold.close();
}

// POST 종단은 모두 잠금 표에 있고, 잠금 표의 경로는 모두 POST 종단이다 (§5.2).
#[test]
fn write_locks_cover_post_routes() {
    for rt in crate::routes::ROUTES.iter().filter(|r| r.method == "POST") {
        let otter_webserver_httproute::Matcher::Exact(p) = rt.matcher else {
            panic!("POST 종단은 정확 일치다");
        };
        assert!(crate::lock::write_lease(&Method::POST, p).is_some(), "{p}");
    }
    assert!(crate::lock::write_lease(&Method::GET, "/api/git/records/replay").is_none());
    // 반대 방향: 잠금 표의 경로는 모두 POST 종단이다 — 표만 남은 경로가 없다.
    for (p, _) in crate::lock::WRITE_LOCKS {
        let routed = crate::routes::ROUTES.iter().any(|r| {
            r.method == "POST"
                && matches!(r.matcher, otter_webserver_httproute::Matcher::Exact(e) if e == *p)
        });
        assert!(routed, "잠금 표에만 있는 경로: {p}");
    }
}

// 첫 응답 뒤의 단계는 아무것도 하지 않는다.
#[tokio::test]
async fn write_pipeline_responds_once() {
    let s = GitServer::default();
    let mut r = Req::for_test(Method::POST, "/api/git/records/replay", "{}");
    let (mut t, _) = s.begin_write::<serde_json::Value>(&mut r).await;
    assert!(t.stop());
    t.require_confirm(true, false, "무시돼야 한다");
    t.resolve("/tmp/x").await;
    t.reject_with(http::StatusCode::IM_A_TEAPOT, "teapot", "무시돼야 한다");
    t.apply(|_| async { panic!("apply 가 돌았다") }).await;
    t.ok(None);
    let res = t.finish();
    assert_eq!(res.status().as_u16(), 503);
    assert_eq!(res.headers()["x-error-code"], "git_unavailable");
}

fn shutdown_env() -> (Env, Ctx) {
    let root = Ctx::background();
    let g = GitFake::new();
    let at = std::time::SystemTime::now();
    let store = Store::new(
        Arc::new(g.service()),
        StoreOptions::default()
            .clock(Arc::new(move || at))
            .root(root.clone()),
    );
    (env_with(g, move |s| s.git = Some(store)), root)
}

// 쓰기 도중 서버가 끝나면 503 server_shutdown 이고, 재조회하지 않으며 partial 을 싣지 않는다.
#[tokio::test]
async fn shutdown_sync_write_cut_is_503() {
    let (e, root) = shutdown_env();
    let seq = write_record(&e).await;
    let r2 = root.clone();
    e.g.set_extra(move |_, a| {
        if a[0] == "checkout" {
            r2.cancel();
        }
        None
    });
    let before = e.g.count("status");
    let (code, out) = replay(&e, seq).await;
    assert_eq!(
        (code, out["error"].clone()),
        (503, json!("server_shutdown")),
        "{out}"
    );
    assert!(out.get("partial").is_none());
    assert_eq!(
        out["message"],
        "server_shutdown: 서버 종료로 중단했다 — 일부가 적용됐을 수 있다"
    );
    assert_eq!(e.g.count("status") - before, 1, "종료 뒤 재조회했다");
}

// 서버가 이미 끝났으면 쓰기를 시작하지 않는다.
#[tokio::test]
async fn shutdown_sync_write_after_shutdown_not_run() {
    let (e, root) = shutdown_env();
    let seq = write_record(&e).await;
    let n = checkouts(&e);
    let r2 = root.clone();
    e.g.set_extra(move |_, a| {
        if a[0] == "status" {
            r2.cancel();
        }
        None
    });
    let (code, out) = replay(&e, seq).await;
    assert_eq!(
        (code, out["error"].clone()),
        (503, json!("server_shutdown")),
        "{out}"
    );
    assert_eq!(checkouts(&e), n);
}
