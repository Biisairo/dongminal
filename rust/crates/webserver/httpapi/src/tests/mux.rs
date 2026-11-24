//! mux·미들웨어 사슬 (Go `http.ServeMux` 동작 — go1.27.2 로 확인한 값, `reqid_test.go`,
//! `recover_test.go`, `httperr_test.go`).

use super::support::*;
use crate::Deps;
use crate::serve::{clean_path, escaped_path, should_log_request};

#[tokio::test]
async fn unclean_paths_redirect_307() {
    let d = tempfile::tempdir().unwrap();
    let srv = server(d.path(), Deps::default());
    for (p, loc) in [
        ("/api", "/api/"),
        ("/api//x", "/api/x"),
        ("/api/./x", "/api/x"),
        ("/api/a/../b", "/api/b"),
        ("/a/..", "/"),
        ("//api/x", "/api/x"),
        ("/api/x/.", "/api/x"),
        ("/api/x%20y/../z?k=v", "/api/z?k=v"),
        ("/api//x%20y", "/api/x%20y"),
        ("/api//a%2Fb", "/api/a%2Fb"),
    ] {
        let r = get(&srv, p).await;
        assert_eq!(r.status, 307, "{p}");
        assert_eq!(r.header("Location"), loc, "{p}");
        assert_eq!(r.header("Content-Type"), "text/html; charset=utf-8");
        assert_eq!(
            r.body,
            format!("<a href=\"{loc}\">Temporary Redirect</a>.\n\n"),
            "{p}"
        );
    }
    let r = call(
        &srv,
        "POST",
        "/api//x",
        &[("Content-Type", "application/json")],
        "{}",
        LOCAL,
    )
    .await;
    assert_eq!(
        (r.status, r.header("Location"), r.body.as_str()),
        (307, "/api/x".into(), "")
    );
    assert_eq!(r.header("Content-Type"), "");
}

#[tokio::test]
async fn unmatched_paths_are_go_404() {
    let d = tempfile::tempdir().unwrap();
    let srv = server(d.path(), Deps::default());
    for p in ["/foo", "/", "/ws/"] {
        let r = get(&srv, p).await;
        assert_eq!(
            (r.status, r.body.as_str()),
            (404, "404 page not found\n"),
            "{p}"
        );
        assert_eq!(r.header("X-Content-Type-Options"), "nosniff");
        assert_eq!(r.header("X-Error-Code"), "");
    }
    let r = get(&srv, "/api/nope").await;
    assert_eq!((r.status, r.body.as_str()), (404, "not found\n"));
    assert_eq!(r.header("X-Error-Code"), "not_found");
    let r = get(&srv, "/api/%2e%2e/x").await;
    assert_eq!(r.status, 404, "인코딩된 점은 정리하지 않는다");
}

#[tokio::test]
async fn bad_escape_is_400() {
    let d = tempfile::tempdir().unwrap();
    let srv = server(d.path(), Deps::default());
    let r = get(&srv, "/api/%zz").await;
    assert_eq!((r.status, r.body.as_str()), (400, "400 Bad Request"));
    assert_eq!(r.header("Connection"), "close");
}

#[tokio::test]
async fn ping_answers_ok_for_any_method() {
    let d = tempfile::tempdir().unwrap();
    let srv = server(d.path(), Deps::default());
    let r = get(&srv, "/api/ping").await;
    assert_eq!((r.status, r.body.as_str()), (200, "ok"));
    assert_eq!(r.header("Content-Type"), "text/plain; charset=utf-8");
    let r = call(
        &srv,
        "POST",
        "/api/ping",
        &[("Content-Type", "application/json")],
        "",
        LOCAL,
    )
    .await;
    assert_eq!(r.status, 200);
}

#[tokio::test]
async fn request_id_generated_honored_and_sanitized() {
    let d = tempfile::tempdir().unwrap();
    let srv = server(d.path(), Deps::default());
    let r = get(&srv, "/api/ping").await;
    let id = r.header("X-Request-Id");
    assert!(!id.is_empty());
    assert_eq!(otter_shared_otterlog::sanitize_req_id(&id), id);
    let r = call(
        &srv,
        "GET",
        "/api/ping",
        &[("X-Request-Id", "abc-123")],
        "",
        LOCAL,
    )
    .await;
    assert_eq!(r.header("X-Request-Id"), "abc-123");
    let bad = "x".repeat(200);
    let r = call(
        &srv,
        "GET",
        "/api/ping",
        &[("X-Request-Id", &bad)],
        "",
        LOCAL,
    )
    .await;
    assert_ne!(r.header("X-Request-Id"), bad);
    assert!(!r.header("X-Request-Id").is_empty());
}

#[tokio::test]
async fn request_id_present_on_gate_rejection() {
    let d = tempfile::tempdir().unwrap();
    let srv = server(d.path(), Deps::default());
    let r = call(
        &srv,
        "GET",
        "/api/state",
        &[("Host", "evil.example")],
        "",
        LOCAL,
    )
    .await;
    assert_eq!(r.status, 421);
    assert!(!r.header("X-Request-Id").is_empty());
}

#[tokio::test]
async fn panic_becomes_500() {
    let d = tempfile::tempdir().unwrap();
    let srv = server(d.path(), Deps::default());
    let r = get(&srv, "/api/test/panic").await;
    assert_eq!((r.status, r.body.as_str()), (500, "internal error\n"));
    assert_eq!(r.header("X-Error-Code"), "internal_error");
    assert_eq!(get(&srv, "/api/ping").await.status, 200, "서버는 산다");
}

#[test]
fn log_filter_matches_go() {
    assert!(!should_log_request("/api/ping", 200));
    assert!(!should_log_request("/api/stats", 200));
    assert!(!should_log_request("/api/workspace", 200));
    assert!(!should_log_request("/api/tools/output", 200));
    assert!(should_log_request("/api/tools/output", 404));
    assert!(should_log_request("/api/access", 200));
    assert!(should_log_request("/", 200));
}

#[test]
fn clean_and_escape_match_go() {
    assert_eq!(clean_path(""), "/");
    assert_eq!(clean_path("a/b/"), "/a/b/");
    assert_eq!(clean_path("/a//b//"), "/a/b/");
    assert_eq!(clean_path("/a/b/../"), "/a/");
    assert_eq!(escaped_path("/a%20b", "/a b"), "/a%20b");
    assert_eq!(escaped_path("/a b", "/a b"), "/a%20b");
    assert_eq!(escaped_path("/é", "/é"), "/%C3%A9");
    assert_eq!(escaped_path("/a%2Fb", "/a/b"), "/a%2Fb");
}
