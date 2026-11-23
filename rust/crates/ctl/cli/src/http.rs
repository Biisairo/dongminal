//! 겨누는 명령이 서버를 두드리는 HTTP 왕복. Go `http.Client{Timeout}` 과 같은 오류 문구를 낸다.

use std::future::Future;
use std::time::Duration;

use dm_gocompat::neturl_err::{self, UrlError};

/// 살아 있는지 한 번 묻는 상한이다.
pub(crate) const ALIVE_PROBE_TIMEOUT: Duration = Duration::from_secs(2);

/// 응답 하나. 본문을 읽다 실패하면 거기까지 읽은 것이다.
pub(crate) struct Reply {
    pub status: u16,
    pub body: Vec<u8>,
}

fn block_on<F: Future>(f: F) -> std::io::Result<F::Output> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map(|rt| rt.block_on(f))
}

fn client(timeout: Duration) -> Result<reqwest::Client, reqwest::Error> {
    // reqwest 의 rustls-no-provider 는 프로세스 공통 암호 공급자를 요구한다. 이미 있으면 그대로 쓴다.
    let _ = rustls::crypto::ring::default_provider().install_default();
    reqwest::Client::builder()
        .timeout(timeout)
        .redirect(neturl_err::redirect_policy())
        .no_proxy()
        .build()
}

async fn send(
    method: &str,
    url: &str,
    body: Option<Vec<u8>>,
    timeout: Duration,
) -> Result<Reply, String> {
    let failed = |e: reqwest::Error| UrlError::from_reqwest(method, url, &e).to_string();
    let c = client(timeout).map_err(failed)?;
    let mut req = if body.is_some() {
        c.post(url)
            .header(reqwest::header::CONTENT_TYPE, "application/json")
    } else {
        c.get(url)
    };
    if let Some(b) = body {
        req = req.body(b);
    }
    let mut res = req.send().await.map_err(failed)?;
    let status = res.status().as_u16();
    let mut data = Vec::new();
    while let Ok(Some(chunk)) = res.chunk().await {
        data.extend_from_slice(&chunk);
    }
    Ok(Reply { status, body: data })
}

/// URL 이 2xx/3xx 를 주는지다.
pub(crate) fn ping(url: &str, timeout: Duration) -> bool {
    matches!(
        block_on(send("GET", url, None, timeout)),
        Ok(Ok(r)) if r.status < 400
    )
}

/// `application/json` 본문으로 POST 한다. 오류는 Go `*url.Error` 문구다.
pub(crate) fn post_json(url: &str, body: Vec<u8>, timeout: Duration) -> Result<Reply, String> {
    block_on(send("POST", url, Some(body), timeout))
        .unwrap_or_else(|e| Err(UrlError::new("POST", url, e.to_string()).to_string()))
}
