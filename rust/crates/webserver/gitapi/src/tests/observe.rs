//! Go `handlers_git_observe_test.go`·`gitwatch_note_test.go`·`handlers_git_mark_test.go`·
//! `handlers_git_rootmatch_test.go`·`handlers_git_repo_guard_test.go` (FR-GOB-1~6 · FR-GPO-10 · FR-GWL ·
//! FR-OPT-4-3·4-7 · FR-DIR-5·41·42 · FR-FAB-14).

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use otter_webserver_domain_git_core::{self as core, Ctx, Kind};
use otter_webserver_domain_git_store::{Observation, mark};
use serde_json::{Value, json};

use super::harness::*;
use crate::RepoWatcher;

#[derive(Default)]
struct Spy {
    notes: Mutex<Vec<String>>,
}

impl RepoWatcher for Spy {
    fn note(&self, repo: &str, _: &Observation) {
        self.notes.lock().unwrap().push(repo.to_owned());
    }
}

fn pin_ws(e: &Env, pins: &[String]) {
    let list: Vec<String> = pins.iter().map(|p| q(p)).collect();
    e.ws.set(&format!(
        r#"{{"schemaVersion":2,"git":{{"pinned":[{}]}}}}"#,
        list.join(",")
    ));
}

fn abc(n: usize) -> Vec<String> {
    ["a", "b", "c", "d", "e"][..n]
        .iter()
        .map(|s| abs(&[s]))
        .collect()
}

fn with_spy() -> (Env, Arc<Spy>) {
    let spy = Arc::new(Spy::default());
    let sc = spy.clone();
    (env_with(GitFake::new(), move |s| s.watch = Some(sc)), spy)
}

async fn repos(e: &Env, qs: &str) -> Value {
    let r = req(&e.s, "GET", &format!("/api/git/repos{qs}"), "").await;
    assert_eq!(r.code, 200, "{}", r.text());
    r.json()
}

#[tokio::test]
async fn observe_fills_every_badge() {
    let e = env();
    pin_ws(&e, &abc(3));
    let out = repos(&e, "?observe=1").await;
    assert_eq!(e.g.count("status"), 3);
    for p in out["pinned"].as_array().unwrap() {
        assert_eq!(
            (p["badge"]["total"].clone(), p["badge"]["branch"].clone()),
            (json!(1), json!("main")),
            "{p}"
        );
    }
}

#[tokio::test]
async fn observe_keeps_pin_order() {
    let e = env();
    let want = abc(5);
    pin_ws(&e, &want);
    let out = repos(&e, "?observe=1").await;
    let got: Vec<&str> = out["pinned"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["path"].as_str().unwrap())
        .collect();
    assert_eq!(got, want);
}

#[tokio::test]
async fn no_observe_never_runs_status() {
    let e = env();
    pin_ws(&e, &abc(3));
    repos(&e, "").await;
    assert_eq!(e.g.count("status"), 0);
}

#[tokio::test]
async fn observe_survives_bad_pin() {
    let e = env();
    let (bad, good) = (abs(&["bad"]), abs(&["good"]));
    pin_ws(&e, &[bad.clone(), good]);
    e.g.set_root_result(move |dir| {
        if dir == bad {
            Err(core::Error::new(Kind::NotRepo, "x"))
        } else {
            Ok(out(&format!("{dir}\n")))
        }
    });
    let o = repos(&e, "?observe=1").await;
    let p = o["pinned"].as_array().unwrap();
    assert_eq!(
        (p[0]["isRepo"].clone(), p[0]["badge"].clone()),
        (json!(false), Value::Null)
    );
    assert!(p[1]["badge"].is_object());
}

#[tokio::test]
async fn observe_notes_pins_and_others_do_not() {
    let (e, spy) = with_spy();
    let pins = abc(2);
    pin_ws(&e, &pins);
    repos(&e, "?observe=1").await;
    let mut noted = spy.notes.lock().unwrap().clone();
    noted.sort();
    assert_eq!(noted, pins);
    repos(&e, "").await;
    repos(&e, "?observe=0").await;
    assert_eq!(spy.notes.lock().unwrap().len(), 2);
    assert_eq!(e.g.count("status"), 2);
}

#[tokio::test]
async fn entry_carries_root() {
    let e = env();
    let a = abs(&["a"]);
    pin_ws(&e, std::slice::from_ref(&a));
    let o = repos(&e, "").await;
    assert_eq!(o["pinned"][0]["root"], a);
}

#[tokio::test]
async fn observe_vanished_pin_is_not_repo() {
    let e = env();
    pin_ws(&e, &abc(1));
    let calls = Arc::new(AtomicUsize::new(0));
    let c = calls.clone();
    e.g.set_root(move |dir| {
        if c.fetch_add(1, Ordering::SeqCst) > 0 {
            not_repo_out()
        } else {
            out(&format!("{dir}\n"))
        }
    });
    e.g.status_not_repo.store(true, Ordering::SeqCst);
    let o = repos(&e, "?observe=1").await;
    assert_eq!(o["pinned"][0]["isRepo"], false);
}

fn work_repo() -> String {
    abs(&["work", "repo"])
}

async fn status(e: &Env, qs: &str) -> (u16, Value) {
    let r = req(
        &e.s,
        "GET",
        &format!("/api/git/status?repo={}{qs}", qe(&work_repo())),
        "",
    )
    .await;
    (r.code, r.json())
}

#[tokio::test]
async fn status_notes_interest() {
    let (e, spy) = with_spy();
    e.g.root_at(&work_repo());
    assert_eq!(status(&e, "").await.0, 200);
    assert_eq!(*spy.notes.lock().unwrap(), [work_repo()]);
    // Watch 가 없어도 답한다.
    let e = env();
    e.g.root_at(&work_repo());
    assert_eq!(status(&e, "").await.0, 200);
}

#[tokio::test]
async fn status_carries_mark_and_if_mark() {
    let (e, spy) = with_spy();
    e.g.root_at(&work_repo());
    let (_, full) = status(&e, "").await;
    let git = e.s.git.clone().unwrap();
    let obs = git
        .status(&Ctx::background(), &work_repo())
        .await
        .0
        .unwrap();
    assert_eq!(full["mark"], mark(&obs));
    let m = full["mark"].as_str().unwrap().to_owned();
    let (code, out) = status(&e, &format!("&ifMark={}", qe(&m))).await;
    assert_eq!((code, out["unchanged"].clone()), (200, json!(true)));
    assert!(out.get("status").is_none());
    for k in [
        "repo",
        "requested",
        "isRepo",
        "rootMatch",
        "requestedResolved",
        "mark",
    ] {
        assert_eq!(out[k], full[k], "{k}");
    }
    assert_eq!(spy.notes.lock().unwrap().len(), 2);
    let (_, other) = status(&e, "&ifMark=stale").await;
    assert!(other.get("unchanged").is_none() && other["status"].is_object());
}

#[tokio::test]
async fn status_root_match() {
    for (ask, want) in [(work_repo(), true), (abs(&["work", "repo", "sub"]), false)] {
        let e = env();
        e.g.root_at(&work_repo());
        let r = req(
            &e.s,
            "GET",
            &format!("/api/git/status?repo={}", qe(&ask)),
            "",
        )
        .await;
        assert_eq!(r.code, 200);
        assert_eq!(r.json()["rootMatch"], want, "{ask}");
        assert!(r.json()["requestedResolved"].is_string());
    }
}

#[cfg(unix)]
#[tokio::test]
async fn status_root_match_through_symlink() {
    let base = tempfile::TempDir::new().unwrap();
    let real = base.path().join("real");
    std::fs::create_dir_all(&real).unwrap();
    let link = base.path().join("link");
    std::os::unix::fs::symlink(&real, &link).unwrap();
    let resolved = std::fs::canonicalize(&real)
        .unwrap()
        .to_string_lossy()
        .into_owned();
    let e = env();
    e.g.root_at(&resolved);
    let link = link.to_string_lossy().into_owned();
    let r = req(
        &e.s,
        "GET",
        &format!("/api/git/status?repo={}", qe(&link)),
        "",
    )
    .await;
    assert_eq!(r.code, 200);
    assert_eq!(r.json()["rootMatch"], true);
    assert_eq!(r.json()["requested"], link);
}

fn deny_except(allowed: String) -> crate::RepoGuard {
    Arc::new(move |p: &str| {
        if p == allowed {
            Ok(())
        } else {
            Err("denied".to_owned())
        }
    })
}

#[tokio::test]
async fn repo_guard() {
    let outside = abs(&["elsewhere", "repo"]);
    // 밖은 403.
    let g = GitFake::new();
    g.root_at(&outside);
    let e = env_with(g, |s| s.repo_guard = Some(deny_except(work_repo())));
    let r = req(
        &e.s,
        "GET",
        &format!("/api/git/status?repo={}", qe(&outside)),
        "",
    )
    .await;
    assert_eq!(r.code, 403);
    assert_eq!(
        r.text(),
        "{\"error\":\"bad_request\",\"message\":\"이 저장소는 워크스페이스 밖이다\"}\n"
    );
    // 안은 통과.
    let e = env_with(GitFake::new(), |s| {
        s.repo_guard = Some(deny_except(work_repo()))
    });
    assert_eq!(status(&e, "").await.0, 200);
    // 푼 루트로 판정한다.
    let seen = Arc::new(Mutex::new(String::new()));
    let sc = seen.clone();
    let g = GitFake::new();
    g.root_at(&outside);
    let e = env_with(g, move |s| {
        s.repo_guard = Some(Arc::new(move |p: &str| {
            *sc.lock().unwrap() = p.to_owned();
            Err("denied".to_owned())
        }))
    });
    req(
        &e.s,
        "GET",
        &format!(
            "/api/git/status?repo={}",
            qe(&format!("{outside}/deep/sub"))
        ),
        "",
    )
    .await;
    assert_eq!(*seen.lock().unwrap(), outside);
}
