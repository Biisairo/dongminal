//! Go `handlers_git_blame_test.go` (FR-GIT-276).

use std::sync::Arc;

use dm_webserver_domain_git_core::Output;

use super::harness::*;
use crate::GitServer;

const PORCELAIN: &str = "1111111111111111111111111111111111111111 1 1 1\n\
author 김 동민\n\
author-mail <dy@example.com>\n\
author-time 1700000000\n\
summary 첫 커밋\n\
filename f.txt\n\
\ta\n";

/// blame 만 답하는 fake. 그 밖의 비-rev-parse 호출은 128 이다.
fn blame_env(fail: &'static str, truncated: bool) -> (Env, String) {
    let g = GitFake::new();
    let root = g.git_dir();
    g.set_extra(move |_, args| match args[0].as_str() {
        "rev-parse" => None,
        "blame" if !fail.is_empty() => Some(Output {
            exit_code: 128,
            stderr: fail.to_owned(),
            ..Output::default()
        }),
        "blame" => {
            let mut o = out(PORCELAIN);
            o.stdout_truncated = truncated;
            Some(o)
        }
        _ => Some(Output {
            exit_code: 128,
            stderr: "fatal: 예상하지 못한 호출\n".to_owned(),
            ..Output::default()
        }),
    });
    (env_with(g, |_| {}), root)
}

#[tokio::test]
async fn echoes_requested() {
    let (e, root) = blame_env("", false);
    let r = req(
        &e.s,
        "GET",
        &format!("/api/git/blame?repo={root}&path=d+ir%2Ff.txt&rev=HEAD%7E1"),
        "",
    )
    .await;
    assert_eq!(r.code, 200, "{}", r.text());
    let out = r.json();
    assert_eq!(out["requested"]["repo"], root);
    assert_eq!(out["requested"]["path"], "d ir/f.txt");
    assert_eq!(out["requested"]["rev"], "HEAD~1");
    assert_eq!(e.g.calls(), ["blame --porcelain HEAD~1 -- d ir/f.txt"]);
    assert_eq!(out["lines"].as_array().unwrap().len(), 1);
    assert_eq!(out["lines"][0]["text"], "a");
    assert_eq!(out["lines"][0]["line"], 1);
    let c = &out["commits"]["1111111111111111111111111111111111111111"];
    assert_eq!(c["authorName"], "김 동민");
    assert_eq!(c["summary"], "첫 커밋");
    // requested 가 먼저, 그 뒤에 FileBlame 필드가 펼쳐진다(Go 임베드 순서).
    assert!(
        r.text()
            .starts_with(&format!("{{\"requested\":{{\"repo\":{}", q(&root)))
    );
    assert_eq!(out["repo"], root);
}

#[tokio::test]
async fn rejects_bad_params() {
    let (e, root) = blame_env("", false);
    for qs in [
        "&path=",
        "&path=..%2Fetc%2Fpasswd",
        "&path=%2Fetc%2Fpasswd",
        "&path=f.txt&rev=--all",
    ] {
        let r = req(&e.s, "GET", &format!("/api/git/blame?repo={root}{qs}"), "").await;
        assert_eq!(r.code, 400, "{qs}: {}", r.text());
        assert_eq!(r.json()["error"], "bad_request", "{qs}");
    }
    assert!(
        e.g.calls().is_empty(),
        "거부했는데 실행했다: {:?}",
        e.g.calls()
    );
}

#[tokio::test]
async fn unavailable() {
    let s = Arc::new(GitServer::default());
    let r = req(
        &s,
        "GET",
        &format!("/api/git/blame?repo={}&path=f.txt", qe(&abs(&["x"]))),
        "",
    )
    .await;
    assert_eq!(r.code, 503);
}

#[tokio::test]
async fn unknown_path_is_not_found() {
    let (e, root) = blame_env("fatal: no such path 'none.txt' in HEAD\n", false);
    let r = req(
        &e.s,
        "GET",
        &format!("/api/git/blame?repo={root}&path=none.txt"),
        "",
    )
    .await;
    assert_eq!(r.code, 404, "{}", r.text());
    assert_eq!(r.json()["error"], "not_found");
}

#[tokio::test]
async fn truncated_is_too_large() {
    let (e, root) = blame_env("", true);
    let r = req(
        &e.s,
        "GET",
        &format!("/api/git/blame?repo={root}&path=f.txt"),
        "",
    )
    .await;
    assert_eq!(r.code, 413, "{}", r.text());
}
