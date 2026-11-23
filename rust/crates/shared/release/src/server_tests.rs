use super::*;
use std::convert::Infallible;
use std::sync::{Arc, Mutex};

use bytes::Bytes;
use http_body_util::Full;
use hyper::{Request, Response};

/// 격리 규칙(C-RSP-1): 60147 이상의 포트에만 붙는다.
async fn listen() -> (tokio::net::TcpListener, u16) {
    for port in 60147u16..64000 {
        if let Ok(l) = tokio::net::TcpListener::bind(("127.0.0.1", port)).await {
            return (l, port);
        }
    }
    panic!("빈 포트가 없다");
}

type Seen = Arc<Mutex<Option<http::HeaderMap>>>;

async fn serve(status: u16, body: &'static str) -> (String, Seen) {
    let (l, port) = listen().await;
    let seen: Seen = Arc::default();
    let seen2 = Arc::clone(&seen);
    tokio::spawn(async move {
        loop {
            let Ok((sock, _)) = l.accept().await else {
                return;
            };
            let seen = Arc::clone(&seen2);
            let svc = hyper::service::service_fn(move |req: Request<hyper::body::Incoming>| {
                *seen.lock().unwrap() = Some(req.headers().clone());
                let mut res = Response::new(Full::new(Bytes::from_static(body.as_bytes())));
                *res.status_mut() = http::StatusCode::from_u16(status).unwrap();
                async move { Ok::<_, Infallible>(res) }
            });
            tokio::spawn(
                hyper::server::conn::http1::Builder::new()
                    .serve_connection(hyper_util::rt::TokioIo::new(sock), svc),
            );
        }
    });
    (format!("http://127.0.0.1:{port}/"), seen)
}

#[tokio::test]
async fn latest_reads_tag_and_link() {
    let (url, seen) = serve(
        200,
        r#"{"tag_name":"v9.9.9","html_url":"https://example/rel"}"#,
    )
    .await;
    let (tag, link) = latest(&url).await.unwrap();
    assert_eq!(
        (tag.as_str(), link.as_str()),
        ("v9.9.9", "https://example/rel")
    );
    let h = seen.lock().unwrap().clone().unwrap();
    assert_eq!(h["accept"], "application/vnd.github+json");
}

// NFR-UPD-4: 요청이 나르는 것은 Accept 한 줄뿐이다(User-Agent 는 Go 와 같은 값).
#[tokio::test]
async fn latest_sends_no_identity() {
    let (url, seen) = serve(200, r#"{"tag_name":"v1.0.0"}"#).await;
    latest(&url).await.unwrap();
    let h = seen.lock().unwrap().clone().unwrap();
    for k in h.keys() {
        assert!(
            matches!(
                k.as_str(),
                "accept" | "user-agent" | "accept-encoding" | "host"
            ),
            "보내지 않아야 할 헤더: {k}"
        );
    }
    assert_eq!(h["user-agent"], "Go-http-client/1.1");
}

#[tokio::test]
async fn latest_rejects_empty_tag() {
    let (url, _) = serve(200, r#"{"tag_name":""}"#).await;
    assert_eq!(
        latest(&url).await.unwrap_err().to_string(),
        "태그가 비었습니다"
    );
}

#[tokio::test]
async fn latest_rejects_non_200() {
    let (url, _) = serve(403, "").await;
    assert_eq!(latest(&url).await.unwrap_err().to_string(), "응답 403");
}

#[tokio::test]
async fn latest_decode_errors() {
    let (url, _) = serve(200, "").await;
    assert_eq!(latest(&url).await.unwrap_err().to_string(), "EOF");
    let (url, _) = serve(200, r#"{"tag_name":"#).await;
    assert_eq!(
        latest(&url).await.unwrap_err().to_string(),
        "unexpected EOF"
    );
    // Decoder 는 앞 값 하나만 읽는다.
    let (url, _) = serve(200, r#"{"tag_name":"v1"} trailing"#).await;
    assert_eq!(latest(&url).await.unwrap().0, "v1");
}

// go1.27.2 실측: `Get "http://127.0.0.1:P/": dial tcp 127.0.0.1:P: connect: connection refused`
#[tokio::test]
async fn latest_transport_error_is_go_url_error() {
    // listen() 이 훑지 않는 높은 범위에서 고른다. 다른 시험이 그 포트를 가져가지 못한다.
    let port = (64000u16..=65000)
        .rev()
        .find(|&p| std::net::TcpListener::bind(("127.0.0.1", p)).is_ok())
        .unwrap();
    let url = format!("http://127.0.0.1:{port}/");
    assert_eq!(
        latest(&url).await.unwrap_err().to_string(),
        format!("Get \"{url}\": dial tcp 127.0.0.1:{port}: connect: connection refused")
    );
}

// 본문이 Content-Length 보다 짧으면 Go 는 감싸지 않은 `unexpected EOF` 를 낸다.
#[tokio::test]
async fn latest_short_body_is_unexpected_eof() {
    let (l, port) = listen().await;
    tokio::spawn(async move {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        if let Ok((mut c, _)) = l.accept().await {
            let mut buf = [0u8; 4096];
            let _ = c.read(&mut buf).await;
            let _ = c
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n{\"tag")
                .await;
        }
    });
    assert_eq!(
        latest(&format!("http://127.0.0.1:{port}/"))
            .await
            .unwrap_err()
            .to_string(),
        "unexpected EOF"
    );
}
