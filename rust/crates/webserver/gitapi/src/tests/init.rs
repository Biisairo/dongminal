//! Go `handlers_git_init_test.go` (REPO_TAB_UNIFY_SRS FR-RTU-25~29). 실제 git 을 쓴다.

use std::sync::Arc;

use dm_webserver_domain_git_core::{Ctx, Service};
use dm_webserver_domain_git_store::{Store, StoreOptions};
use tempfile::TempDir;

use super::harness::*;
use crate::GitServer;

fn real() -> (Arc<GitServer>, Arc<FakeWorkspace>) {
    let ws = Arc::new(FakeWorkspace::default());
    let s = Arc::new(GitServer {
        git: Some(Store::new(
            Arc::new(Service::new()),
            StoreOptions::default(),
        )),
        work: Some(ws.clone()),
        commands: Some(Arc::new(FakeBroker::default())),
        ..GitServer::default()
    });
    (s, ws)
}

fn body(p: &str) -> String {
    format!(r#"{{"path":{}}}"#, q(p))
}

fn canon(d: &TempDir) -> String {
    std::fs::canonicalize(d.path())
        .unwrap()
        .to_string_lossy()
        .into_owned()
}

#[tokio::test]
async fn rejects_existing_and_relative() {
    let (s, _) = real();
    let dir = TempDir::new().unwrap();
    let r = req(&s, "POST", "/api/git/init", r#"{"path":"relative/path"}"#).await;
    assert_eq!(r.code, 400);
    assert_eq!(r.json()["message"], "path 는 절대경로여야 한다");
    let p = dir.path().to_string_lossy().into_owned();
    let r = req(&s, "POST", "/api/git/init", &body(&p)).await;
    assert_eq!(r.code, 200, "{}", r.text());
    let r = req(&s, "POST", "/api/git/init", &body(&p)).await;
    assert_eq!(r.code, 409, "{}", r.text());
    assert_eq!(r.json()["error"], "exists");
    assert_eq!(
        r.json()["message"],
        format!("이미 git 저장소입니다: {}", canon(&dir))
    );
}

#[tokio::test]
async fn creates_repo_and_pins() {
    let (s, ws) = real();
    let dir = TempDir::new().unwrap();
    let r = req(
        &s,
        "POST",
        "/api/git/init",
        &body(&dir.path().to_string_lossy()),
    )
    .await;
    assert_eq!(r.code, 200, "{}", r.text());
    let out = r.json();
    assert_eq!(out["ok"], true);
    assert_eq!(out["repo"], canon(&dir));
    assert!(dir.path().join(".git").is_dir());
    assert_eq!(out["pinned"].as_array().unwrap().len(), 1);
    assert_eq!(out["editors"].as_array().unwrap().len(), 1);
    assert_eq!(ws.saves(), 1);
}

#[tokio::test]
async fn invalidates_root_cache() {
    let (s, _) = real();
    let dir = TempDir::new().unwrap();
    let git = s.git.clone().unwrap();
    let p = dir.path().to_string_lossy().into_owned();
    assert!(git.repo_root(&Ctx::background(), &p).await.is_err());
    assert_eq!(req(&s, "POST", "/api/git/init", &body(&p)).await.code, 200);
    let root = git
        .repo_root(&Ctx::background(), &p)
        .await
        .expect("init 직후 RepoRoot");
    assert_eq!(root, canon(&dir));
}

#[tokio::test]
async fn stale_root_cache_does_not_block() {
    let (s, _) = real();
    let d = TempDir::new().unwrap();
    let dir = canon(&d);
    assert_eq!(
        req(&s, "POST", "/api/git/init", &body(&dir)).await.code,
        200
    );
    let git = s.git.clone().unwrap();
    assert_eq!(git.repo_root(&Ctx::background(), &dir).await.unwrap(), dir);
    std::fs::remove_dir_all(format!("{dir}/.git")).unwrap();
    let r = req(&s, "POST", "/api/git/init", &body(&dir)).await;
    assert_eq!(r.code, 200, "{}", r.text());
}

#[tokio::test]
async fn rejects_missing_and_file() {
    let (s, _) = real();
    let base = TempDir::new().unwrap();
    let missing = format!("{}/nope", canon(&base));
    let r = req(&s, "POST", "/api/git/init", &body(&missing)).await;
    assert_eq!(r.code, 400);
    assert_eq!(
        r.json()["message"],
        format!("그런 폴더가 없습니다: {missing}")
    );
    assert!(!std::path::Path::new(&missing).exists());
    let file = format!("{}/f.txt", canon(&base));
    std::fs::write(&file, "x").unwrap();
    let r = req(&s, "POST", "/api/git/init", &body(&file)).await;
    assert_eq!(r.code, 400);
    assert_eq!(r.json()["message"], format!("디렉터리가 아닙니다: {file}"));
}

#[tokio::test]
async fn unavailable() {
    let s = Arc::new(GitServer::default());
    let r = req(&s, "POST", "/api/git/init", r#"{"path":"/x"}"#).await;
    assert_eq!(r.code, 503);
}
