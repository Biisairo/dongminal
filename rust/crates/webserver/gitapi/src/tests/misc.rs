//! Go `dialect_golden_test.go`·`decode_reason_test.go`·`body_too_large_test.go`·
//! `handlers_git_removed_test.go`·`oid_digest_vectors_test.go`·`handlers_git_policy_limits_test.go`·
//! `handlers_git_diff_commit_test.go`(blob.rs 의 fake 를 쓰지 않는 갈래).

use std::sync::Arc;

use dm_webserver_domain_git_query::Commit;
use http::Method;
use serde::Deserialize;
use serde_json::json;

use super::harness::*;
use crate::GitServer;
use crate::req::Req;

const UNAVAILABLE: &str =
    "{\"error\":\"git_unavailable\",\"message\":\"git 서비스가 구성되지 않았다\"}\n";
const EOF_BODY: &str = "{\"error\":\"bad_request\",\"message\":\"본문이 JSON 이 아니다: unexpected end of JSON input\"}\n";

// 방언 골든: 본문·상태·헤더 둘(Content-Type·X-Error-Code)이 Go 와 같다.
#[tokio::test]
async fn dialect_golden() {
    let r = crate::reply::git_fail(http::StatusCode::CONFLICT, "exists", "<x>");
    assert_eq!(r.headers().len(), 2);
    let (parts, body) = r.into_parts();
    use http_body_util::BodyExt;
    let b = body.collect().await.unwrap().to_bytes();
    assert_eq!(
        (parts.status.as_u16(), &b[..]),
        (
            409,
            &b"{\"error\":\"exists\",\"message\":\"\\u003cx\\u003e\"}\n"[..]
        )
    );
    assert_eq!(parts.headers["x-error-code"], "exists");

    let e = env();
    for (path, body) in [
        ("/api/git/records/replay", "{"),
        ("/api/git/repos/pin", "["),
        ("/api/git/records/replay", ""),
    ] {
        let r = req(&e.s, "POST", path, body).await;
        assert_eq!(
            (r.code, r.text()),
            (400, EOF_BODY.to_owned()),
            "{path} {body:?}"
        );
        assert_eq!(r.headers.len(), 2);
        assert_eq!(r.headers["x-error-code"], "bad_request");
        assert_eq!(r.headers["content-type"], "application/json");
    }
}

// 가드는 라우트에서 선다. git 이 없으면 본문을 읽기 전에 503 이다.
#[tokio::test]
async fn routes_unavailable_without_git() {
    let s = Arc::new(GitServer::default());
    for (m, p) in [
        ("GET", "/api/git/repos"),
        ("POST", "/api/git/init"),
        ("POST", "/api/git/repos/pin"),
        ("POST", "/api/git/repos/unpin"),
        ("GET", "/api/git/policy"),
        ("GET", "/api/git/recovery"),
    ] {
        let r = req(&s, m, p, "{").await;
        assert_eq!((r.code, r.text()), (503, UNAVAILABLE.to_owned()), "{m} {p}");
    }
}

// 본문에 Go 타입 이름이 새지 않는다 (FR-QG-1·2).
#[tokio::test]
async fn decode_hides_go_types() {
    let e = env();
    let r = req(&e.s, "POST", "/api/git/repos/pin", r#"{"path":1}"#).await;
    assert_eq!(r.code, 400);
    assert_eq!(r.headers["x-error-code"], "bad_request");
    assert_eq!(
        r.text(),
        "{\"error\":\"bad_request\",\"message\":\"본문이 JSON 이 아니다: path: number 값은 맞지 않다\"}\n"
    );
}

// 핀 저장 실패는 고정 문구다 — 가드를 지나지 않고 처리기를 직접 부른다.
#[tokio::test]
async fn pin_save_fail_is_fixed() {
    let s = GitServer::default();
    let mut r = Req::for_test(Method::POST, "/api/git/repos/unpin", r#"{"path":"/nope"}"#);
    let res = s.api_git_unpin(&mut r).await;
    assert_eq!(res.status().as_u16(), 500);
    use http_body_util::BodyExt;
    let b = res.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(
        &b[..],
        "{\"error\":\"git_failed\",\"message\":\"핀 목록을 저장하지 못했다\"}\n".as_bytes()
    );
}

// 본문 상한을 넘으면 413 body_too_large 이고 연결을 닫는다.
#[tokio::test]
async fn body_too_large() {
    let e = env();
    let big = format!(
        r#"{{"path":"{}"}}"#,
        "x".repeat(dm_shared_httpreq::DEFAULT_LIMIT as usize + 1024)
    );
    for path in ["/api/git/repos/pin", "/api/git/records/replay"] {
        let r = req(&e.s, "POST", path, &big).await;
        assert_eq!(r.code, 413, "{path}");
        assert_eq!(r.headers["x-error-code"], "body_too_large");
        assert_eq!(r.headers["connection"], "close");
    }
}

// 없앤 종단은 표와 잠금 표에 없다.
#[tokio::test]
async fn dead_endpoints_removed() {
    let e = env();
    for (m, p) in [
        ("GET", "/api/git/repo-at"),
        ("POST", "/api/git/repos/reorder"),
    ] {
        assert!(dm_webserver_httproute::dispatch(&crate::routes::ROUTES, m, p).is_none());
        assert!(crate::lock::write_lease(&Method::POST, p).is_none());
        assert_eq!(req(&e.s, m, p, "{}").await.code, 404);
    }
}

#[derive(Deserialize)]
struct Vector {
    oids: Vec<String>,
    digest: String,
}

// 화면과 나누는 지문 표본 (testdata/oid_digest_vectors.json).
#[test]
fn oid_digest_shared_vectors() {
    let p = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/testdata/oid_digest_vectors.json"
    );
    let vs: Vec<Vector> = serde_json::from_slice(&std::fs::read(p).unwrap()).unwrap();
    assert!(vs.len() >= 3);
    for v in vs {
        let cs: Vec<Commit> = v
            .oids
            .iter()
            .map(|o| Commit {
                oid: o.clone(),
                ..Commit::default()
            })
            .collect();
        assert_eq!(crate::history::oid_digest(&cs), v.digest, "{:?}", v.oids);
    }
}

#[tokio::test]
async fn policy_job_slots() {
    let e = env();
    let out = req(&e.s, "GET", "/api/git/policy", "").await.json();
    let want: Vec<serde_json::Value> = dm_webserver_domain_git_jobs::SLOT_ORDER
        .iter()
        .map(|s| serde_json::to_value(s).unwrap())
        .collect();
    assert_eq!(out["jobSlots"], json!(want));
    assert!(
        want.iter()
            .all(|w| w.get("slot").is_some() && w.get("remote").is_some())
    );
}
