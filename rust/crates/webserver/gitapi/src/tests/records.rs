//! Go `handlers_git_records_test.go` (GIT_UI_REVISION_SRS FR-GIT-218 · FR-OPT-0-3).

use std::sync::Arc;

use otter_webserver_domain_git_core::{self as core, Ctx, Output, Service, WriteSpec};
use otter_webserver_domain_git_store::{Store, StoreOptions};
use serde_json::{Value, json};
use tempfile::TempDir;

use super::harness::*;
use crate::GitServer;

struct RecEnv {
    _dir: TempDir,
    root: String,
    s: Arc<GitServer>,
}

impl RecEnv {
    fn new() -> Self {
        let dir = TempDir::new().unwrap();
        let root = std::fs::canonicalize(dir.path())
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let r = root.clone();
        let svc = Service::builder()
            .runner(Arc::new(move |_, _, args: Vec<String>| {
                let o = match args[0].as_str() {
                    "rev-parse" if args.get(1).map(String::as_str) == Some("--show-toplevel") => {
                        out(&format!("{r}\n"))
                    }
                    "boom" => Output {
                        exit_code: 1,
                        stderr: "fatal: https://u:tok@host/x 로 붙지 못했다\n".to_owned(),
                        ..Output::default()
                    },
                    _ => Output::default(),
                };
                Box::pin(async move { Ok::<_, core::Error>(o) })
            }))
            .build();
        let s = Arc::new(GitServer {
            git: Some(Store::new(Arc::new(svc), StoreOptions::default())),
            ..GitServer::default()
        });
        RecEnv { _dir: dir, root, s }
    }

    fn svc(&self) -> &Service {
        self.s.git.as_ref().unwrap().service()
    }

    async fn exec(&self, dir: &str, args: &[&str]) {
        let _ = self.svc().exec(&Ctx::background(), dir, args).await;
    }

    async fn get(&self, query: &str) -> (u16, Value) {
        let r = req(
            &self.s,
            "GET",
            &format!("/api/git/records?repo={}{query}", self.root),
            "",
        )
        .await;
        (r.code, r.json())
    }
}

fn argv0(recs: &Value) -> Vec<String> {
    recs.as_array()
        .unwrap()
        .iter()
        .map(|r| r["argv"][0].as_str().unwrap().to_owned())
        .collect()
}

#[tokio::test]
async fn unavailable() {
    let s = Arc::new(GitServer::default());
    let r = req(
        &s,
        "GET",
        &format!("/api/git/records?repo={}", qe(&abs(&["r"]))),
        "",
    )
    .await;
    assert_eq!(
        (r.code, r.json()["error"].clone()),
        (503, json!("git_unavailable"))
    );
}

#[tokio::test]
async fn filters_by_resolved_root() {
    let e = RecEnv::new();
    let other = TempDir::new().unwrap();
    e.exec(&e.root, &["status"]).await;
    e.exec(&other.path().to_string_lossy(), &["status"]).await;
    let sub = format!("{}/sub", e.root);
    let r = req(&e.s, "GET", &format!("/api/git/records?repo={sub}"), "").await;
    assert_eq!(r.code, 200, "{}", r.text());
    let out = r.json();
    let recs = out["records"].as_array().unwrap();
    assert!(!recs.is_empty());
    assert!(recs.iter().all(|m| m["cwd"] == e.root.as_str()));
    assert_eq!(out["repo"], e.root);
    assert_eq!(out["requested"], json!({"repo": sub, "n": 0}));
    assert_eq!(out["total"], recs.len());
    assert!(r.text().starts_with("{\"requested\":{\"repo\":"));
}

#[tokio::test]
async fn newest_first() {
    let e = RecEnv::new();
    e.exec(&e.root, &["status"]).await;
    e.exec(&e.root, &["diff"]).await;
    let (_, out) = e.get("").await;
    let seen: Vec<String> = argv0(&out["records"])
        .into_iter()
        .filter(|a| a == "status" || a == "diff")
        .collect();
    assert_eq!(seen, ["diff", "status"]);
}

#[tokio::test]
async fn carries_write_flag() {
    let e = RecEnv::new();
    e.exec(&e.root, &["status"]).await;
    let spec = WriteSpec {
        argv: vec!["add".to_owned(), "a.txt".to_owned()],
        ..WriteSpec::default()
    };
    let _ = e.svc().exec_write(&Ctx::background(), &e.root, &spec).await;
    let (_, out) = e.get("").await;
    for m in out["records"].as_array().unwrap() {
        match m["argv"][0].as_str().unwrap() {
            "add" => assert_eq!(m["write"], true),
            "status" => assert_eq!(m["write"], false),
            _ => {}
        }
    }
    assert!(argv0(&out["records"]).contains(&"add".to_owned()));
}

#[tokio::test]
async fn redacts_credentials() {
    let e = RecEnv::new();
    e.exec(&e.root, &["boom", "https://u:tok@host/x"]).await;
    let r = req(
        &e.s,
        "GET",
        &format!("/api/git/records?repo={}", e.root),
        "",
    )
    .await;
    assert_eq!(r.code, 200);
    assert!(!r.text().contains("tok@host"), "{}", r.text());
    assert!(r.text().contains("***@host"), "{}", r.text());
}

#[tokio::test]
async fn limit_param() {
    let e = RecEnv::new();
    for _ in 0..5 {
        e.exec(&e.root, &["status"]).await;
    }
    let (_, out) = e.get("&n=2").await;
    assert_eq!(out["records"].as_array().unwrap().len(), 2);
    // rev-parse 기록도 그 저장소의 기록이다.
    assert_eq!(out["total"], 6);
    let (code, out) = e.get("&n=-1").await;
    assert_eq!(code, 400);
    assert_eq!(out["message"], "n 는 0 이상의 정수여야 한다: -1");
}

#[tokio::test]
async fn after_cursor() {
    let e = RecEnv::new();
    e.exec(&e.root, &["status"]).await;
    let (code, out) = e.get("&after=0").await;
    assert_eq!(code, 200, "{out}");
    let last = out["lastSeq"].as_u64().unwrap();
    assert!(last >= 1);
    assert_eq!(out["gap"], false);
    assert!(out["firstSeq"].is_u64());
    e.exec(&e.root, &["diff"]).await;
    let (_, out) = e.get(&format!("&after={last}")).await;
    let recs = out["records"].as_array().unwrap();
    assert!(recs.iter().all(|m| m["seq"].as_u64().unwrap() > last));
    let a = argv0(&out["records"]);
    assert_eq!(a.first().map(String::as_str), Some("diff"));
    assert!(!a.contains(&"status".to_owned()));
    for bad in ["x", "+1", "-1", ""] {
        let (code, out) = e.get(&format!("&after={bad}")).await;
        assert_eq!(code, 400, "after={bad}");
        assert_eq!(out["message"], "after 는 0 이상의 정수여야 한다");
    }
}

#[tokio::test]
async fn after_gap() {
    let e = RecEnv::new();
    e.exec(&e.root, &["status"]).await;
    let (_, out) = e.get("&after=999").await;
    assert_eq!(out["gap"], true);
    assert!(!out["records"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn after_epoch() {
    let e = RecEnv::new();
    for _ in 0..3 {
        e.exec(&e.root, &["status"]).await;
    }
    let (_, out) = e.get("&after=0").await;
    let epoch = out["epoch"].as_str().unwrap().to_owned();
    let all = out["records"].as_array().unwrap().len();
    assert!(!epoch.is_empty());
    let (_, out) = e.get(&format!("&after=1&epoch={epoch}")).await;
    assert_eq!(out["gap"], false);
    let (_, out) = e.get("&after=1&epoch=stale").await;
    assert_eq!(
        (out["gap"].clone(), out["epoch"].clone()),
        (json!(true), json!(epoch))
    );
    assert_eq!(out["records"].as_array().unwrap().len(), all);
    // 커서는 total 뒤에 Go 구조체 순서대로 붙는다.
    let keys: Vec<&String> = out.as_object().unwrap().keys().collect();
    assert_eq!(keys.len(), 8);
}

#[tokio::test]
async fn no_after_keeps_body() {
    let e = RecEnv::new();
    e.exec(&e.root, &["status"]).await;
    let r = req(
        &e.s,
        "GET",
        &format!("/api/git/records?repo={}", e.root),
        "",
    )
    .await;
    let out = r.json();
    for k in ["lastSeq", "firstSeq", "gap", "epoch"] {
        assert!(out.get(k).is_none(), "{k}");
    }
    assert!(r.text().contains("],\"total\":2}"), "{}", r.text());
}
