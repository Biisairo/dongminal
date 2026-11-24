//! 시험용 WebSocket 클라이언트 — 서버처럼 permessage-deflate 를 협상한다 (PERF_OPTIMIZATION_SRS D-12).
//! 업그레이드는 손으로 쓴다: 라이브러리의 클라이언트는 압축 스트림을 돌려주지 않는다.

use std::time::Duration;

use bytes::Bytes;
use sockudo_ws::deflate::parse_deflate_offer;
use sockudo_ws::stream::CompressedWebSocketStream;
use sockudo_ws::{Config, DeflateConfig};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

pub(crate) use sockudo_ws::Message;

pub(crate) type Client = CompressedWebSocketStream<TcpStream>;

/// 브라우저(Chromium)가 보내는 것과 같은 제안이다.
pub(crate) const OFFER: &str = "permessage-deflate; client_max_window_bits";
const KEY: &str = "dGhlIHNhbXBsZSBub25jZQ==";
const WAIT: Duration = Duration::from_secs(5);

/// 업그레이드 응답. `status` 가 101 이 아니면 `client` 가 없다.
pub(crate) struct Dialed {
    pub(crate) status: u16,
    pub(crate) headers: Vec<(String, String)>,
    pub(crate) client: Option<Client>,
}

impl Dialed {
    pub(crate) fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
}

/// `offer` 가 `None` 이면 압축을 제안하지 않는다. `extra` 는 덧붙일 요청 헤더다.
pub(crate) async fn dial_with(
    port: u16,
    path: &str,
    offer: Option<&str>,
    extra: &[(&str, &str)],
) -> Dialed {
    let mut tcp = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    let mut req = format!(
        "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {KEY}\r\nSec-WebSocket-Version: 13\r\n"
    );
    if let Some(o) = offer {
        req.push_str(&format!("Sec-WebSocket-Extensions: {o}\r\n"));
    }
    for (k, v) in extra {
        req.push_str(&format!("{k}: {v}\r\n"));
    }
    req.push_str("\r\n");
    tcp.write_all(req.as_bytes()).await.unwrap();
    let mut buf = Vec::new();
    let end = loop {
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break i + 4;
        }
        let mut chunk = [0u8; 4096];
        let n = tokio::time::timeout(WAIT, tcp.read(&mut chunk))
            .await
            .unwrap()
            .unwrap();
        assert!(n > 0, "업그레이드 응답 전에 닫혔다");
        buf.extend_from_slice(&chunk[..n]);
    };
    let head = String::from_utf8_lossy(&buf[..end]).into_owned();
    let mut lines = head.split("\r\n");
    let status = lines
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|c| c.parse().ok())
        .unwrap_or(0);
    let headers: Vec<(String, String)> = lines
        .filter_map(|l| l.split_once(':'))
        .map(|(k, v)| (k.trim().to_owned(), v.trim().to_owned()))
        .collect();
    let mut d = Dialed {
        status,
        headers,
        client: None,
    };
    if status == 101 {
        let ext = d
            .header("Sec-WebSocket-Extensions")
            .unwrap_or_default()
            .to_owned();
        let params =
            parse_deflate_offer(&ext).expect("서버가 permessage-deflate 를 협상하지 않았다");
        let cfg = DeflateConfig::from_params(&params).unwrap();
        let leftover = (buf.len() > end).then(|| Bytes::copy_from_slice(&buf[end..]));
        d.client = Some(CompressedWebSocketStream::client_with_leftover(
            tcp,
            Config::default(),
            cfg,
            leftover,
        ));
    }
    d
}

/// 압축을 제안하고 붙는다. 업그레이드가 실패하면 시험이 깨진다.
pub(crate) async fn dial(port: u16, path: &str) -> Client {
    let d = dial_with(port, path, Some(OFFER), &[]).await;
    assert_eq!(d.status, 101, "업그레이드 실패: {path}");
    d.client.unwrap()
}

/// 텍스트 프레임의 본문이다.
pub(crate) trait TextOf {
    fn as_str(&self) -> &str;
}

impl TextOf for Bytes {
    fn as_str(&self) -> &str {
        std::str::from_utf8(self).unwrap_or_default()
    }
}
