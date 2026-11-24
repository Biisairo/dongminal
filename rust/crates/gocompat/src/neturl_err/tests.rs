//! 기대 문구는 go1.27.2 실측값이다(로컬 가짜 서버·닫힌 포트, `http.Client{Timeout: 1s}`).

use super::*;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

const TIMEOUT: Duration = Duration::from_secs(1);

/// 격리 규칙(C-RSP-1): 60147 이상의 포트만 쓴다.
async fn listen() -> (TcpListener, u16) {
    for port in 60147u16..64000 {
        if let Ok(l) = TcpListener::bind(("127.0.0.1", port)).await {
            return (l, port);
        }
    }
    panic!("빈 포트가 없다");
}

/// 닫힌 포트. [`listen`] 이 훑지 않는 높은 범위에서 잠깐 묶었다가 놓는다.
fn closed_port() -> u16 {
    for port in (64000u16..=65000).rev() {
        if let Ok(l) = std::net::TcpListener::bind(("127.0.0.1", port)) {
            drop(l);
            return port;
        }
    }
    panic!("빈 포트가 없다");
}

/// 요청을 읽고 `resp` 를 쓴 뒤 `hold` 만큼 기다렸다가 끊는다.
async fn raw(resp: &'static [u8], hold: Duration) -> u16 {
    let (l, port) = listen().await;
    tokio::spawn(async move {
        while let Ok((mut c, _)) = l.accept().await {
            tokio::spawn(async move {
                let mut buf = [0u8; 4096];
                let _ = c.read(&mut buf).await;
                let _ = c.write_all(resp).await;
                tokio::time::sleep(hold).await;
            });
        }
    });
    port
}

fn client() -> reqwest::Client {
    let _ = rustls::crypto::ring::default_provider().install_default();
    reqwest::Client::builder()
        .timeout(TIMEOUT)
        .redirect(redirect_policy())
        .build()
        .unwrap()
}

async fn get_err(url: &str) -> String {
    let e = client().get(url).send().await.unwrap_err();
    UrlError::from_reqwest("GET", url, &e).to_string()
}

async fn body_err(url: &str) -> String {
    let mut res = client().get(url).send().await.unwrap();
    loop {
        match res.chunk().await {
            Ok(Some(_)) => {}
            Ok(None) => panic!("본문 오류가 나야 한다"),
            Err(e) => return body_error(&e),
        }
    }
}

#[tokio::test]
async fn connection_refused() {
    let port = closed_port();
    let url = format!("http://127.0.0.1:{port}/a");
    assert_eq!(
        get_err(&url).await,
        format!("Get \"{url}\": dial tcp 127.0.0.1:{port}: connect: connection refused")
    );
}

#[tokio::test]
async fn connection_refused_post() {
    let port = closed_port();
    let url = format!("http://127.0.0.1:{port}/p");
    let e = client().post(&url).send().await.unwrap_err();
    assert_eq!(
        UrlError::from_reqwest("POST", &url, &e).to_string(),
        format!("Post \"{url}\": dial tcp 127.0.0.1:{port}: connect: connection refused")
    );
}

#[tokio::test]
async fn timeout_awaiting_headers() {
    let port = raw(b"", Duration::from_secs(3)).await;
    let url = format!("http://127.0.0.1:{port}/x");
    assert_eq!(
        get_err(&url).await,
        format!(
            "Get \"{url}\": context deadline exceeded (Client.Timeout exceeded while awaiting headers)"
        )
    );
}

#[tokio::test]
async fn closed_without_response_is_eof() {
    let port = raw(b"", Duration::ZERO).await;
    let url = format!("http://127.0.0.1:{port}/x");
    assert_eq!(get_err(&url).await, format!("Get \"{url}\": EOF"));
}

#[tokio::test]
async fn https_to_http_server() {
    let port = raw(
        b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n",
        Duration::ZERO,
    )
    .await;
    let url = format!("https://127.0.0.1:{port}/x");
    assert_eq!(
        get_err(&url).await,
        format!("Get \"{url}\": http: server gave HTTP response to HTTPS client")
    );
}

#[tokio::test]
async fn tls_unknown_authority() {
    let port = tls_server().await;
    let url = format!("https://127.0.0.1:{port}/t");
    assert_eq!(
        get_err(&url).await,
        format!(
            "Get \"{url}\": tls: failed to verify certificate: x509: certificate signed by unknown authority"
        )
    );
}

#[tokio::test]
async fn too_many_redirects() {
    let (url, hits) = redirect_server().await;
    let start = format!("{url}/start");
    assert_eq!(
        get_err(&start).await,
        "Get \"/r10\": stopped after 10 redirects"
    );
    assert_eq!(hits.load(Ordering::SeqCst), 10, "Go 는 요청 10번 뒤 멈춘다");
}

#[tokio::test]
async fn unsupported_scheme() {
    assert_eq!(
        get_err("ftp://x/y").await,
        "Get \"ftp://x/y\": unsupported protocol scheme \"ftp\""
    );
}

#[tokio::test]
async fn body_short_is_unexpected_eof() {
    let port = raw(
        b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n{\"tag",
        Duration::ZERO,
    )
    .await;
    assert_eq!(
        body_err(&format!("http://127.0.0.1:{port}/x")).await,
        "unexpected EOF"
    );
}

#[tokio::test]
async fn body_timeout() {
    let port = raw(
        b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n{\"tag",
        Duration::from_secs(3),
    )
    .await;
    assert_eq!(
        body_err(&format!("http://127.0.0.1:{port}/x")).await,
        "context deadline exceeded (Client.Timeout or context cancellation while reading body)"
    );
}

#[tokio::test]
async fn body_bad_chunk() {
    let port = raw(
        b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nzz\r\n",
        Duration::ZERO,
    )
    .await;
    assert_eq!(
        body_err(&format!("http://127.0.0.1:{port}/x")).await,
        "invalid byte in chunk length"
    );
}

#[test]
fn display_and_helpers() {
    assert_eq!(op("GET"), "Get");
    assert_eq!(op("delete"), "Delete");
    assert_eq!(op(""), "");
    assert_eq!(
        UrlError::new("GET", "https://u:secret@h/p", "EOF").to_string(),
        "Get \"https://u:***@h/p\": EOF"
    );
    assert_eq!(
        UrlError::canceled("GET", "http://h/\"q").to_string(),
        "Get \"http://h/\\\"q\": context canceled"
    );
}

async fn tls_server() -> u16 {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let cert = rcgen::generate_simple_self_signed(vec!["127.0.0.1".to_owned()]).unwrap();
    let der = cert.cert.der().clone();
    let key = rustls::pki_types::PrivateKeyDer::Pkcs8(cert.signing_key.serialize_der().into());
    let cfg = rustls::ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(vec![der], key)
        .unwrap();
    let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(cfg));
    let (l, port) = listen().await;
    tokio::spawn(async move {
        while let Ok((c, _)) = l.accept().await {
            let acceptor = acceptor.clone();
            tokio::spawn(async move {
                let _ = acceptor.accept(c).await;
            });
        }
    });
    port
}

async fn redirect_server() -> (String, Arc<AtomicUsize>) {
    let (l, port) = listen().await;
    let hits = Arc::new(AtomicUsize::new(0));
    let h = Arc::clone(&hits);
    tokio::spawn(async move {
        while let Ok((mut c, _)) = l.accept().await {
            let h = Arc::clone(&h);
            tokio::spawn(async move {
                let mut buf = [0u8; 4096];
                while let Ok(n) = c.read(&mut buf).await {
                    if n == 0 {
                        return;
                    }
                    let k = h.fetch_add(1, Ordering::SeqCst) + 1;
                    let resp = format!(
                        "HTTP/1.1 302 Found\r\nLocation: /r{k}\r\nContent-Length: 0\r\n\r\n"
                    );
                    if c.write_all(resp.as_bytes()).await.is_err() {
                        return;
                    }
                }
            });
        }
    });
    (format!("http://127.0.0.1:{port}"), hits)
}

/// 이름 해석 실패. 외부 DNS 에 묻지 않도록 해석기를 바꿔 끼운다.
struct NoSuchHost;

impl reqwest::dns::Resolve for NoSuchHost {
    fn resolve(&self, _: reqwest::dns::Name) -> reqwest::dns::Resolving {
        Box::pin(async {
            Err::<reqwest::dns::Addrs, _>(
                io::Error::other("failed to lookup address information").into(),
            )
        })
    }
}

#[tokio::test]
async fn dns_no_such_host() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let c = reqwest::Client::builder()
        .timeout(TIMEOUT)
        .dns_resolver(Arc::new(NoSuchHost))
        .build()
        .unwrap();
    let url = "http://nonexistent.invalid/a";
    let e = c.get(url).send().await.unwrap_err();
    assert_eq!(
        UrlError::from_reqwest("GET", url, &e).to_string(),
        "Get \"http://nonexistent.invalid/a\": dial tcp: lookup nonexistent.invalid: no such host"
    );
}
