//! Go `handlers_git_policy_test.go` (GIT_SRS §3A.3 FR-GIT-86~93).

use std::sync::Arc;

use otter_webserver_domain_git_core::{self as core, Hint};
use otter_webserver_domain_git_write as write;
use serde_json::json;

use super::harness::*;
use crate::GitServer;

fn policy_endpoints() -> [String; 3] {
    [
        format!("/api/git/preflight?repo={}", qe(&abs(&["work", "repo"]))),
        "/api/git/policy".to_owned(),
        "/api/git/recovery".to_owned(),
    ]
}

#[tokio::test]
async fn preflight() {
    let e = env();
    let repo = abs(&["work", "repo"]);
    let r = req(
        &e.s,
        "GET",
        &format!("/api/git/preflight?repo={}", qe(&repo)),
        "",
    )
    .await;
    assert_eq!(r.code, 200, "{}", r.text());
    let out = r.json();
    assert_eq!(
        (out["requested"].as_str(), out["repo"].as_str()),
        (Some(repo.as_str()), Some(repo.as_str()))
    );
    let pf = &out["preflight"];
    for key in ["blocks", "warnings", "gpgSign", "template"] {
        assert!(pf.get(key).is_some(), "preflight 에 {key} 가 없다: {pf}");
    }
    let blocks = pf["blocks"].as_array().unwrap();
    assert_eq!(blocks.len(), 1);
    assert_eq!(blocks[0]["code"], "identity_missing");
    assert!(!blocks[0]["reason"].as_str().unwrap().is_empty());
    assert!(!blocks[0]["fix"].as_str().unwrap().is_empty());
}

#[tokio::test]
async fn preflight_repo_param() {
    let e = env();
    for path in ["/api/git/preflight", "/api/git/preflight?repo=relative"] {
        assert_eq!(req(&e.s, "GET", path, "").await.code, 400, "{path}");
    }
}

#[tokio::test]
async fn policy_lists() {
    let e = env();
    let r = req(&e.s, "GET", "/api/git/policy", "").await;
    assert_eq!(r.code, 200);
    let out = r.json();
    assert_eq!(out["destructive"], json!(core::DESTRUCTIVE_ACTIONS));
    assert_eq!(out["tagKinds"], json!(write::TAG_KINDS));
    assert_eq!(out["resetModes"], json!(write::RESET_MODES));
    assert_eq!(out["jobLineCap"], 2000);
    assert_eq!(
        out["logLimits"],
        json!({"initial": 300, "page": 100, "max": 2000})
    );
    assert!(out["jobSlots"].as_array().is_some_and(|a| a.len() == 2));
    assert!(out["operations"].is_object());
    let keys: Vec<&String> = out.as_object().unwrap().keys().collect();
    assert_eq!(
        keys,
        [
            "destructive",
            "jobLineCap",
            "jobSlots",
            "logLimits",
            "operations",
            "resetModes",
            "tagKinds"
        ]
    );
}

#[tokio::test]
async fn recovery() {
    let e = env();
    let r = req(&e.s, "GET", "/api/git/recovery", "").await;
    assert_eq!(r.code, 200);
    assert_eq!(r.text(), "{\"hints\":[]}\n");
    e.s.git.as_ref().unwrap().service().add_hint(Hint {
        repo: abs(&["work", "repo"]),
        action: core::ACTION_BRANCH_DELETE.to_owned(),
        targets: Some(vec!["feature".to_owned()]),
        values: Some(vec!["1111111111111111111111111111111111111111".to_owned()]),
        command: "git branch feature 1111111111111111111111111111111111111111".to_owned(),
        ..Hint::default()
    });
    let out = req(&e.s, "GET", "/api/git/recovery", "").await.json();
    let hints = out["hints"].as_array().unwrap();
    assert_eq!(hints.len(), 1);
    assert_eq!(hints[0]["action"], core::ACTION_BRANCH_DELETE);
    assert_eq!(hints[0]["seq"], 1);
    assert!(!hints[0]["command"].as_str().unwrap().is_empty());
    assert_ne!(hints[0]["atUnixMs"], 0);
}

#[tokio::test]
async fn policy_endpoints_unavailable() {
    let s = Arc::new(GitServer::default());
    for path in policy_endpoints() {
        let r = req(&s, "GET", &path, "").await;
        assert_eq!(
            (r.code, r.json()["error"].clone()),
            (503, json!("git_unavailable")),
            "{path}"
        );
    }
}

#[test]
fn policy_routes_registered() {
    for ep in policy_endpoints() {
        let path = ep.split('?').next().unwrap();
        assert!(
            otter_webserver_httproute::dispatch(&crate::routes::ROUTES, "GET", path).is_some(),
            "{path}"
        );
    }
}
