//! 워크스페이스 되돌리기 (Go `handlers_workspace_revert_test.go`).

use std::sync::Arc;

use super::fsenv::FakeWork;
use super::support::{self, call};
use crate::{Deps, Server};

struct Env {
    dir: tempfile::TempDir,
    srv: Arc<Server>,
    ws: Arc<FakeWork>,
}

impl Env {
    fn path(&self) -> std::path::PathBuf {
        self.dir.path().join("workspace.json")
    }
}

/// Go `revertHome`: 현재 판과 세대 셋을 둔다.
fn revert_home() -> Env {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.json");
    std::fs::write(
        &path,
        r#"{"schemaVersion":2,"windows":[{"id":"w1","name":"now"}]}"#,
    )
    .unwrap();
    for i in 1..=3 {
        std::fs::write(
            format!("{}.bak.{i}", path.display()),
            format!(r#"{{"schemaVersion":2,"windows":[{{"id":"w1","name":"gen{i}"}}]}}"#),
        )
        .unwrap();
    }
    let ws = Arc::new(FakeWork::default());
    ws.set(r#"{"schemaVersion":2,"windows":[{"id":"w1","name":"now"}]}"#);
    let srv = support::server(
        dir.path(),
        Deps {
            work: Some(ws.clone()),
            ..Deps::default()
        },
    );
    Env { dir, srv, ws }
}

async fn post_revert(e: &Env, body: &str) -> support::Resp {
    support::post_json(&e.srv, "/api/workspace/revert", body).await
}

fn raw(ws: &FakeWork) -> String {
    use otter_webserver_domain_wsentry::WorkspaceStore;
    String::from_utf8(ws.snapshot().0.to_vec()).unwrap()
}

/// 목록은 되돌릴 수 있는 자리를 보인다. 읽히는지까지는 묻지 않는다.
#[tokio::test]
async fn workspace_revisions_list() {
    let e = revert_home();
    std::fs::write(format!("{}.bak.2", e.path().display()), "{망가짐").unwrap();
    std::fs::remove_file(format!("{}.bak.3", e.path().display())).unwrap();
    let r = support::get(&e.srv, "/api/workspace/revisions").await;
    assert_eq!(r.status, 200);
    let v = r.json();
    assert_eq!(v["rev"], 1);
    let gens = v["generations"].as_array().unwrap();
    assert_eq!(gens.len(), 2);
    assert_eq!(gens[0]["gen"], 1);
    assert_eq!(gens[1]["gen"], 2);
    assert_eq!(gens[1]["bytes"], 10);
    let m = gens[0]["modified"].as_str().unwrap();
    assert!(
        m.len() == 20 && m.ends_with('Z') && &m[10..11] == "T",
        "{m}"
    );
}

/// 세대가 없으면 빈 배열이고, 저장소가 없으면 rev 는 0 이다.
#[tokio::test]
async fn workspace_revisions_empty() {
    let dir = tempfile::tempdir().unwrap();
    let srv = support::server(dir.path(), Deps::default());
    let r = support::get(&srv, "/api/workspace/revisions").await;
    assert_eq!(r.body, "{\"rev\":0,\"generations\":[]}\n");
}

#[tokio::test]
async fn workspace_revert_loads_generation() {
    let e = revert_home();
    let before = e.ws.saves();
    let r = post_revert(&e, r#"{"gen":2}"#).await;
    assert_eq!(r.status, 200, "{}", r.body);
    assert_eq!(r.body, "{\"gen\":2,\"rev\":2}\n");
    assert!(raw(&e.ws).contains("gen2"));
    assert_eq!(e.ws.saves(), before + 1);
}

#[tokio::test]
async fn workspace_revert_missing_generation() {
    let e = revert_home();
    std::fs::remove_file(format!("{}.bak.3", e.path().display())).unwrap();
    let r = post_revert(&e, r#"{"gen":3}"#).await;
    assert_eq!((r.status, r.body.as_str()), (404, "generation not found\n"));
    let r = post_revert(&e, r#"{"gen":9}"#).await;
    assert_eq!(r.status, 400);
    assert_eq!(r.body, "gen must be 1..3\n");
}

#[tokio::test]
async fn workspace_revert_rejects_bad_gen() {
    let e = revert_home();
    for body in [r#"{"gen":0}"#, r#"{"gen":-1}"#, r#"{"gen":999}"#, "{}"] {
        let r = post_revert(&e, body).await;
        assert_eq!(r.status, 400, "{body}");
        assert_eq!(r.header("X-Error-Code"), "bad_request");
    }
    for body in ["nope", r#"{"gen":"1"}"#] {
        let r = post_revert(&e, body).await;
        assert_eq!(
            (r.status, r.body.as_str()),
            (400, "invalid json\n"),
            "{body}"
        );
        assert_eq!(r.header("X-Error-Code"), "invalid_json");
    }
    assert_eq!(e.ws.saves(), 0);
}

#[tokio::test]
async fn workspace_revert_rejects_corrupt_generation() {
    let e = revert_home();
    std::fs::write(format!("{}.bak.1", e.path().display()), "{망가짐").unwrap();
    let before = raw(&e.ws);
    let r = post_revert(&e, r#"{"gen":1}"#).await;
    assert_eq!(r.status, 409);
    assert_eq!(r.body, "generation is not valid JSON\n");
    assert_eq!(raw(&e.ws), before);
}

/// 저장소가 없으면 500 workspace_unavailable 이다.
#[tokio::test]
async fn workspace_revert_without_store() {
    let dir = tempfile::tempdir().unwrap();
    let srv = support::server(dir.path(), Deps::default());
    let r = call(
        &srv,
        "POST",
        "/api/workspace/revert",
        &[("Content-Type", "application/json")],
        r#"{"gen":1}"#,
        support::LOCAL,
    )
    .await;
    assert_eq!(
        (r.status, r.header("X-Error-Code").as_str()),
        (500, "workspace_unavailable")
    );
}
