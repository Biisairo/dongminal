//! api_test·oauth_test·usage_test(헤더)·resets_test(ClaimReset). 가짜 서버는 60147 이상 포트다.

use std::collections::BTreeMap;
use std::convert::Infallible;
use std::sync::{Arc, Mutex};

use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::{Request, Response};

use crate::client::OAUTH_CLIENT_ID;
use crate::error::Sentinel;
use crate::*;

/// 받은 요청 하나.
#[derive(Debug, Clone, Default)]
struct Seen {
    method: String,
    path: String,
    query: String,
    headers: http::HeaderMap,
    body: Vec<u8>,
}

/// 응답: 상태, 헤더, 본문.
type Reply = (u16, Vec<(&'static str, &'static str)>, &'static str);

/// 격리 규칙(C-RSP-1): 60147 이상의 포트에만 붙는다.
async fn listen() -> (tokio::net::TcpListener, u16) {
    for port in 60147u16..=65000 {
        if let Ok(l) = tokio::net::TcpListener::bind(("127.0.0.1", port)).await {
            return (l, port);
        }
    }
    panic!("빈 포트가 없다");
}

async fn serve(
    route: impl Fn(&Seen) -> Reply + Send + Sync + 'static,
) -> (String, Arc<Mutex<Vec<Seen>>>) {
    let (l, port) = listen().await;
    let seen: Arc<Mutex<Vec<Seen>>> = Arc::default();
    let (seen2, route) = (seen.clone(), Arc::new(route));
    tokio::spawn(async move {
        while let Ok((sock, _)) = l.accept().await {
            let (seen, route) = (seen2.clone(), route.clone());
            let svc = hyper::service::service_fn(move |req: Request<hyper::body::Incoming>| {
                let (seen, route) = (seen.clone(), route.clone());
                async move {
                    let (parts, body) = req.into_parts();
                    let body = body
                        .collect()
                        .await
                        .map(|b| b.to_bytes().to_vec())
                        .unwrap_or_default();
                    let s = Seen {
                        method: parts.method.to_string(),
                        path: parts.uri.path().to_owned(),
                        query: parts.uri.query().unwrap_or_default().to_owned(),
                        headers: parts.headers,
                        body,
                    };
                    let (status, hs, b) = route(&s);
                    seen.lock().unwrap().push(s);
                    let mut res = Response::new(Full::new(Bytes::from_static(b.as_bytes())));
                    *res.status_mut() = http::StatusCode::from_u16(status).unwrap();
                    for (k, v) in hs {
                        res.headers_mut().insert(k, v.parse().unwrap());
                    }
                    Ok::<_, Infallible>(res)
                }
            });
            tokio::spawn(
                hyper::server::conn::http1::Builder::new()
                    .serve_connection(hyper_util::rt::TokioIo::new(sock), svc),
            );
        }
    });
    (format!("http://127.0.0.1:{port}"), seen)
}

fn h<'a>(s: &'a Seen, k: &str) -> &'a str {
    s.headers
        .get(k)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
}

#[tokio::test]
async fn client_profile() {
    let (url, seen) = serve(|s| {
        if s.path != "/api/oauth/profile" {
            return (404, vec![], "");
        }
        (
            200,
            vec![],
            r#"{"account":{"uuid":" acc-1 ","email":"a@x.com"},"organization":{"uuid":"org-1"}}"#,
        )
    })
    .await;
    let c = Client {
        base: url,
        user_agent: "dongminal/test".into(),
        ..Client::default()
    };
    let id = c.profile("tok").await.unwrap();
    assert_eq!(
        id,
        Identity {
            account_uuid: "acc-1".into(),
            email: "a@x.com".into(),
            org_uuid: "org-1".into()
        }
    );
    let s = seen.lock().unwrap()[0].clone();
    assert_eq!(
        (h(&s, "authorization"), h(&s, "user-agent")),
        ("Bearer tok", "dongminal/test")
    );
    assert_eq!(
        (s.method.as_str(), h(&s, "content-type")),
        ("GET", "application/json")
    );
}

#[tokio::test]
async fn client_profile_errors() {
    let cases: [(&str, Reply); 3] = [
        ("401", (401, vec![], "")),
        ("no uuid", (200, vec![], r#"{"account":{"email":"a"}}"#)),
        ("garbage", (200, vec![], "<html>")),
    ];
    for (name, reply) in cases {
        let (url, _) = serve(move |_| reply.clone()).await;
        let e = Client {
            base: url,
            ..Client::default()
        }
        .profile("secret-token")
        .await
        .unwrap_err();
        if name == "401" {
            assert_eq!(e.http_status().map(|s| s.status), Some(401));
            assert_eq!(e.to_string(), "anthropic api: status 401");
        } else {
            assert_eq!(
                e.to_string(),
                "profile 응답에 account.uuid 가 없습니다",
                "{name}"
            );
        }
        assert!(!e.to_string().contains("secret-token"));
    }
}

#[tokio::test]
async fn client_no_user_agent_when_empty() {
    let (url, seen) = serve(|_| (200, vec![], r#"{"account":{"uuid":"u"}}"#)).await;
    Client {
        base: format!("{url}/"),
        ..Client::default()
    }
    .profile("t")
    .await
    .unwrap();
    let s = seen.lock().unwrap()[0].clone();
    assert!(
        s.headers.get("user-agent").is_none(),
        "Go 는 빈 User-Agent 를 보내지 않는다"
    );
    assert_eq!(s.path, "/api/oauth/profile", "끝의 / 는 뗀다");
}

#[tokio::test]
async fn client_transport_error_hides_token() {
    let (l, port) = listen().await;
    drop(l);
    let e = Client {
        base: format!("http://127.0.0.1:{port}"),
        ..Client::default()
    }
    .profile("secret-token")
    .await
    .unwrap_err();
    let msg = e.to_string();
    assert!(
        msg.starts_with(&format!(
            "Get \"http://127.0.0.1:{port}/api/oauth/profile\": "
        )),
        "{msg}"
    );
    assert!(!msg.contains("secret-token") && e.http_status().is_none());
}

// TC-CAC-9: 갱신 요청 본문과 영구·일시 실패.
#[tokio::test]
async fn client_refresh() {
    let (url, seen) = serve(|s| {
        if s.path != "/v1/oauth/token" || s.method != "POST" {
            return (404, vec![], "");
        }
        (200, vec![], r#"{"access_token":"new-at","refresh_token":"new-rt","expires_in":3600,"scope":"user:inference user:profile"}"#)
    })
    .await;
    let tr = Client {
        token_base: url,
        ..Client::default()
    }
    .refresh("old-rt")
    .await
    .unwrap();
    let s = seen.lock().unwrap()[0].clone();
    assert_eq!(
        String::from_utf8(s.body).unwrap(),
        format!(
            r#"{{"client_id":"{OAUTH_CLIENT_ID}","grant_type":"refresh_token","refresh_token":"old-rt"}}"#
        )
    );
    assert!(s.headers.get("authorization").is_none());
    assert_eq!(
        tr,
        TokenResult {
            access_token: "new-at".into(),
            refresh_token: "new-rt".into(),
            expires_in: 3600,
            scopes: vec!["user:inference".into(), "user:profile".into()],
        }
    );
}

#[tokio::test]
async fn client_refresh_errors() {
    let cases: [(&str, u16, &'static str, Option<&str>); 7] = [
        (
            "invalid_grant",
            400,
            r#"{"error":"invalid_grant"}"#,
            Some("다시 로그인해야 합니다 (invalid_grant)"),
        ),
        (
            "invalid_client",
            401,
            r#"{"error":"invalid_client"}"#,
            Some("다시 로그인해야 합니다 (invalid_client)"),
        ),
        ("other 400", 400, r#"{"error":"invalid_request"}"#, None),
        (
            "marker in text",
            400,
            r#"{"error":"x","error_description":"invalid_grant"}"#,
            None,
        ),
        ("500", 500, r#"{"error":"invalid_grant"}"#, None),
        ("garbage", 403, "<html>", None),
        ("200 no token", 200, r#"{"refresh_token":"x"}"#, None),
    ];
    for (name, status, body, permanent) in cases {
        let (url, _) = serve(move |_| (status, vec![("Retry-After", "7")], body)).await;
        let e = Client {
            token_base: url,
            ..Client::default()
        }
        .refresh("rt")
        .await
        .unwrap_err();
        assert_eq!(
            e.is(Sentinel::ReloginRequired),
            permanent.is_some(),
            "{name}"
        );
        match permanent {
            Some(m) => assert_eq!(e.to_string(), m),
            None if status == 200 => assert_eq!(e.to_string(), "token 응답을 읽을 수 없습니다"),
            None => {
                let s = e.http_status().unwrap();
                assert_eq!((s.status, s.retry_after.as_str()), (status, "7"), "{name}");
            }
        }
    }
}

// TC-CAC-10: 사용량 조회 헤더.
#[tokio::test]
async fn client_usage_headers() {
    let (url, seen) = serve(|s| {
        if s.path == "/api/oauth/usage" {
            (200, vec![], r#"{"five_hour":{"utilization":1}}"#)
        } else {
            (404, vec![], "")
        }
    })
    .await;
    let c = Client {
        base: url,
        user_agent: "dongminal/x".into(),
        ..Client::default()
    };
    let raw = c.usage_raw("tok", "").await.unwrap();
    assert_eq!(raw, br#"{"five_hour":{"utilization":1}}"#);
    c.usage_raw("tok", "at_wall=1&skip_spend=1").await.unwrap();
    let all = seen.lock().unwrap().clone();
    assert_eq!(
        (
            h(&all[0], "authorization"),
            h(&all[0], "anthropic-beta"),
            h(&all[0], "user-agent"),
            all[0].query.as_str()
        ),
        ("Bearer tok", "oauth-2025-04-20", "dongminal/x", "")
    );
    assert_eq!(all[1].query, "at_wall=1&skip_spend=1");
}

#[tokio::test]
async fn client_usage_429() {
    let (url, _) = serve(|_| (429, vec![("Retry-After", "120")], "")).await;
    let e = Client {
        base: url,
        ..Client::default()
    }
    .usage_raw("tok", "")
    .await
    .unwrap_err();
    let s = e.http_status().unwrap();
    assert_eq!((s.status, s.retry_after.as_str()), (429, "120"));
}

#[tokio::test]
async fn client_body_limited_to_1mib() {
    static BIG: std::sync::LazyLock<String> =
        std::sync::LazyLock::new(|| "x".repeat((1 << 20) + 10));
    let (url, _) = serve(|_| (200, vec![], BIG.as_str())).await;
    let raw = Client {
        base: url,
        ..Client::default()
    }
    .usage_raw("t", "")
    .await
    .unwrap();
    assert_eq!(raw.len(), 1 << 20);
}

#[tokio::test]
async fn client_claim_reset() {
    let (url, seen) = serve(|_| (409, vec![], r#"{"result":"already_used"}"#)).await;
    let c = Client {
        base: url,
        ..Client::default()
    };
    let body = BTreeMap::from([("program".to_owned(), serde_json::json!(PROGRAM_JUNIPER))]);
    let (raw, r) = c.claim_reset("AT", "org-1", &body).await;
    assert_eq!(r.unwrap_err().http_status().map(|s| s.status), Some(409));
    assert_eq!(raw, br#"{"result":"already_used"}"#);
    let s = seen.lock().unwrap()[0].clone();
    assert_eq!(
        (
            s.method.as_str(),
            s.path.as_str(),
            h(&s, "authorization"),
            String::from_utf8(s.body.clone()).unwrap().as_str()
        ),
        (
            "POST",
            "/api/organizations/org-1/reset_rate_limits",
            "Bearer AT",
            r#"{"program":"juniper_tide"}"#
        )
    );
    let (_, r) = c.claim_reset("AT", "a/b c!", &body).await;
    assert!(r.is_err());
    assert_eq!(
        seen.lock().unwrap()[1].path,
        "/api/organizations/a%2Fb%20c%21/reset_rate_limits"
    );
}
