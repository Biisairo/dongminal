//! Go `git_pins_link_test.go`·`handlers_git_pinned_perf_test.go` (FR-EDT-24·31~38 · FR-PRF-55~57 · FR-OPT-7-4).

use std::sync::Arc;
use std::sync::atomic::{AtomicI32, Ordering};
use std::time::Duration;

use dm_webserver_domain_wsentry as wsentry;
use serde_json::{Value, json};

use super::harness::*;

fn work_repo() -> String {
    abs(&["work", "repo"])
}

async fn pin(e: &Env, path: &str) -> Value {
    let r = req(
        &e.s,
        "POST",
        "/api/git/repos/pin",
        &format!(r#"{{"path":{}}}"#, q(path)),
    )
    .await;
    assert_eq!(r.code, 200, "{}", r.text());
    r.json()
}

#[tokio::test]
async fn pin_creates_editor_row_and_saves_once() {
    let e = env();
    e.g.root_at(&work_repo());
    let out = pin(&e, &work_repo()).await;
    assert_eq!(out["editors"], json!([work_repo()]));
    let doc: Value = serde_json::from_str(&e.ws.raw()).unwrap();
    assert_eq!(doc["editors"]["list"], json!([work_repo()]));
    // 두 목록이 한 저장·한 방송이다.
    assert_eq!(e.ws.saves(), 1);
    assert_eq!(e.cb.published.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn unpin_removes_editor_row() {
    let e = env();
    let other = abs(&["other"]);
    e.ws.set(&format!(
        r#"{{"schemaVersion":2,"git":{{"pinned":[{0}]}},"editors":{{"list":[{0},{1}]}}}}"#,
        q(&work_repo()),
        q(&other)
    ));
    let r = req(
        &e.s,
        "POST",
        "/api/git/repos/unpin",
        &format!(r#"{{"path":{}}}"#, q(&work_repo())),
    )
    .await;
    assert_eq!(r.code, 200, "{}", r.text());
    assert_eq!(r.json()["pinned"], json!([]));
    assert_eq!(r.json()["editors"], json!([other]));
}

// 홈은 Editor 행을 만들지 않는다 (FR-EDT-38). 홈은 격리 실행의 HOME 이다.
#[tokio::test]
async fn pin_home_makes_no_editor_row() {
    let Ok(home) = std::env::var("HOME") else {
        return;
    };
    let norm = wsentry::normalize_path(&home);
    let e = env();
    e.g.root_at(&norm);
    assert_eq!(pin(&e, &norm).await["editors"], json!([]));
    let r = req(
        &e.s,
        "POST",
        "/api/git/repos/unpin",
        &format!(r#"{{"path":{}}}"#, q(&norm)),
    )
    .await;
    assert_eq!(r.json()["editors"], json!([]));
}

// 응답의 root 는 wsentry 가 정규화해 저장한 값이다 (FR-EDT-24).
#[cfg(unix)]
#[tokio::test]
async fn pin_normalizes_root_like_editor_add() {
    let dir = tempfile::TempDir::new().unwrap();
    let real = dir.path().join("real");
    std::fs::create_dir(&real).unwrap();
    let link = dir.path().join("link");
    std::os::unix::fs::symlink(&real, &link).unwrap();
    let link = link.to_string_lossy().into_owned();
    let e = env();
    e.g.root_at(&link);
    let out = pin(&e, &link).await;
    let want = wsentry::normalize_path(&real.to_string_lossy());
    assert_eq!(out["root"], want);
    assert_eq!(out["pinned"], json!([want]));
}

// 핀 목록은 겹쳐 확정하되 상한(4)을 넘지 않고 순서를 지킨다 (FR-PRF-57).
#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn pinned_entries_run_in_parallel() {
    let e = env();
    let list: Vec<String> = (0..10).map(|i| format!("{}-{i}", work_repo())).collect();
    e.ws.set(&json!({"git": {"pinned": list}}).to_string());
    let (cur, peak) = (Arc::new(AtomicI32::new(0)), Arc::new(AtomicI32::new(0)));
    let (c, p) = (cur.clone(), peak.clone());
    e.g.set_root(move |dir| {
        let n = c.fetch_add(1, Ordering::SeqCst) + 1;
        p.fetch_max(n, Ordering::SeqCst);
        std::thread::sleep(Duration::from_millis(20));
        c.fetch_sub(1, Ordering::SeqCst);
        out(&format!("{dir}\n"))
    });
    let out = req(&e.s, "GET", "/api/git/repos", "").await.json();
    let got: Vec<&str> = out["pinned"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["path"].as_str().unwrap())
        .collect();
    assert_eq!(got, list);
    let p = peak.load(Ordering::SeqCst);
    assert!((2..=4).contains(&p), "동시 진행 최대 {p}");
}

// 목록은 한 번 읽어 두 단계가 나눠 쓴다 (FR-OPT-7-4).
#[tokio::test]
async fn repos_observe_reads_pins_once() {
    let e = env();
    e.ws.set(&json!({"git": {"pinned": [work_repo(), format!("{}-2", work_repo())]}}).to_string());
    let before = e.ws.reads.load(Ordering::SeqCst);
    let out = req(&e.s, "GET", "/api/git/repos?observe=1", "")
        .await
        .json();
    assert_eq!(out["pinned"].as_array().unwrap().len(), 2);
    assert_eq!(e.ws.reads.load(Ordering::SeqCst) - before, 1);
}
