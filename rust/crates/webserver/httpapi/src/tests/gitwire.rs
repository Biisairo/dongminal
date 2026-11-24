//! Go `route_git_prefix_test.go`·`handlers_stats_test.go`(`?jobs=1`) 의 이식과 gitapi 배선의 시험.
//!
//! 옮기지 않은 것: `BenchmarkHandleAPI_GitPath`(성능 측정).

use std::sync::Arc;

use otter_webserver_domain_git_core::Service;
use otter_webserver_domain_git_store::{Store, StoreOptions};

use super::support::{get, server};
use crate::Deps;
use crate::routes::API_ROUTES;

fn git_store() -> Arc<Store> {
    Store::new(Arc::new(Service::new()), StoreOptions::default())
}

// FR-OPT-8-2 (HTTP-25): /api/git/* 는 표를 훑지 않고 git 표면으로 간다 — 표에 git 경로를 잡는
// 항목이 없어야 한다.
#[test]
fn api_routes_do_not_claim_git_paths() {
    for p in [
        "/api/git/status",
        "/api/git/job/events",
        "/api/git/",
        "/api/git/anything/deep",
    ] {
        for (i, rt) in API_ROUTES.iter().enumerate() {
            assert!(
                !rt.matcher.matches(p),
                "API_ROUTES[{i}] 가 git 경로 {p} 를 잡는다"
            );
        }
    }
}

// git 처리기가 없으면 종전처럼 404 다.
#[tokio::test]
async fn git_prefix_without_git_is_404() {
    let d = tempfile::tempdir().unwrap();
    let s = crate::Server::new_with(
        crate::Config {
            data_dir: d.path().to_path_buf(),
            ..crate::Config::default()
        },
        Deps::default(),
        |srv| srv.deps.git = None,
    );
    let r = get(&s, "/api/git/status").await;
    assert_eq!(r.status, 404);
    assert_eq!(r.header("X-Error-Code"), "not_found");
}

// Go NewServer 는 저장소 계층이 없어도 git 표면을 세운다 — 그 표면은 503 이다 (FR-GIT-60).
#[tokio::test]
async fn git_without_store_is_503() {
    let d = tempfile::tempdir().unwrap();
    let s = server(d.path(), Deps::default());
    let r = get(&s, "/api/git/repos").await;
    assert_eq!(r.status, 503, "{}", r.body);
    assert_eq!(r.header("X-Error-Code"), "git_unavailable");
    // 라우트가 없는 git 경로는 gitapi 가 처리하지 않는다 — 404 다.
    assert_eq!(get(&s, "/api/git/anything/deep").await.status, 404);
}

// /api/git/* 이 httpapi 를 지나 gitapi 에서 돈다.
#[tokio::test]
async fn git_status_through_httpapi() {
    let d = tempfile::tempdir().unwrap();
    let repo = d.path().join("repo");
    std::fs::create_dir(&repo).unwrap();
    if otter_shared_gittest::path().is_none() {
        return; // git 이 없다.
    }
    otter_shared_gittest::run(&repo, &["init", "-q"]);
    let s = server(
        d.path(),
        Deps {
            git_store: Some(git_store()),
            ..Deps::default()
        },
    );
    let target = format!("/api/git/status?repo={}", repo.display());
    let r = get(&s, &target).await;
    assert_eq!(r.status, 200, "{}", r.body);
    assert_eq!(r.json()["requested"], repo.display().to_string());
    let r = get(&s, "/api/git/status?repo=relative").await;
    assert_eq!(r.status, 400);
}

// TC-CH4-6: 진행 중 git 작업은 `git.jobs` 토픽이 싣는다 — `/api/stats?jobs=1` 의 안전망은 없다.
#[tokio::test]
async fn stats_never_carries_jobs() {
    let d = tempfile::tempdir().unwrap();
    let s = server(
        d.path(),
        Deps {
            git_store: Some(git_store()),
            ..Deps::default()
        },
    );
    let v = get(&s, "/api/stats?jobs=1").await.json();
    assert!(v.get("jobs").is_none(), "{v}");
}
