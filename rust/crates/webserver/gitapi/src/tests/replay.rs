//! Go `handlers_git_replay_test.go` (FR-GIT-281). Go 는 준비 기록을 checkout 종단(5.4.2)으로
//! 만들지만, 여기서는 같은 기록을 서비스에 직접 남긴다 — 검증하는 것은 replay 의 관측 동작이다.

use std::sync::Arc;

use otter_webserver_domain_git_core::{Ctx, WriteSpec};
use serde_json::json;

use super::harness::*;
use crate::GitServer;

fn repo() -> String {
    abs(&["work", "repo"])
}

async fn seed(e: &Env) -> (u64, u64) {
    let svc = e.s.git.as_ref().unwrap().service();
    let _ = svc.exec(&Ctx::background(), &repo(), &["status"]).await;
    let spec = WriteSpec {
        argv: vec!["checkout".to_owned(), "dev".to_owned()],
        ..WriteSpec::default()
    };
    svc.exec_write(&Ctx::background(), &repo(), &spec)
        .await
        .unwrap();
    let recs = svc.records(0);
    let read = recs.iter().rev().find(|r| !r.write).unwrap().seq;
    let write = recs.iter().rev().find(|r| r.write).unwrap().seq;
    (read, write)
}

fn writes(e: &Env) -> Vec<String> {
    e.g.calls()
        .into_iter()
        .filter(|c| c.starts_with("checkout"))
        .collect()
}

// 본문에 실린 argv·command 는 무시한다 — 서버가 자기 기록에서 꺼낸다.
#[tokio::test]
async fn has_no_command_field() {
    let e = env();
    let (read, _) = seed(&e).await;
    let body = format!(
        r#"{{"repo":{},"seq":{read},"confirm":true,"argv":["push","--force"],"command":"rm -rf /"}}"#,
        q(&repo())
    );
    let r = req(&e.s, "POST", "/api/git/records/replay", &body).await;
    assert_eq!(r.code, 200, "{}", r.text());
    for rec in e.s.git.as_ref().unwrap().service().records(0) {
        assert!(!rec.argv().join(" ").contains("--force"));
    }
}

#[tokio::test]
async fn missing_record() {
    let e = env();
    let r = req(
        &e.s,
        "POST",
        "/api/git/records/replay",
        &format!(r#"{{"repo":{},"seq":9999,"confirm":true}}"#, q(&repo())),
    )
    .await;
    assert_eq!(r.code, 404);
    assert_eq!(
        r.text(),
        "{\"error\":\"record_missing\",\"message\":\"그 기록이 이 저장소에 없다 — 버퍼에서 밀려났을 수 있다\"}\n"
    );
}

#[tokio::test]
async fn write_requires_confirm() {
    let e = env();
    let (_, write) = seed(&e).await;
    let before = writes(&e).len();
    let r = req(
        &e.s,
        "POST",
        "/api/git/records/replay",
        &format!(r#"{{"repo":{},"seq":{write}}}"#, q(&repo())),
    )
    .await;
    assert_eq!(r.code, 400);
    assert_eq!(r.json()["error"], "confirmation_required");
    assert_eq!(
        r.json()["message"],
        "쓰기 기록을 다시 실행한다: confirm:true 를 요구한다 (FR-GIT-89)"
    );
    assert_eq!(writes(&e).len(), before);
}

#[tokio::test]
async fn runs_recorded_argv() {
    let e = env();
    let (_, write) = seed(&e).await;
    let before = writes(&e);
    let r = req(
        &e.s,
        "POST",
        "/api/git/records/replay",
        &format!(r#"{{"repo":{},"seq":{write},"confirm":true}}"#, q(&repo())),
    )
    .await;
    assert_eq!(r.code, 200, "{}", r.text());
    let out = r.json();
    assert_eq!(out["ok"], true);
    assert_eq!(out["argv"], json!(["checkout", "dev"]));
    assert_eq!(out["repo"], repo());
    assert_eq!(out["partial"], false);
    assert!(out["status"].is_object());
    let after = writes(&e);
    assert_eq!(after.len(), before.len() + 1);
    assert_eq!(after.last(), before.last());
}

#[tokio::test]
async fn route_registered_and_unavailable() {
    assert!(
        otter_webserver_httproute::dispatch(
            &crate::routes::ROUTES,
            "POST",
            "/api/git/records/replay"
        )
        .is_some()
    );
    let s = Arc::new(GitServer::default());
    let r = req(
        &s,
        "POST",
        "/api/git/records/replay",
        &format!(r#"{{"repo":{},"seq":1,"confirm":true}}"#, q(&repo())),
    )
    .await;
    assert_eq!(
        (r.code, r.json()["error"].clone()),
        (503, json!("git_unavailable"))
    );
}
