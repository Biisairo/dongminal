//! 채널 `/channel` 의 뼈대 (PERF_OPTIMIZATION_SRS FR-CON · `perf/CHANNEL_PROTOCOL.md` §10.1 C1).
//! 실제 TCP 로 업그레이드한다.

use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use http::Method;
use serde_json::{Value, json};
use tokio_tungstenite::tungstenite::Message;

use super::ws::listen;
use crate::{Config, Deps, Server};

type Client =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

const WAIT: Duration = Duration::from_secs(5);

struct Env {
    _dir: tempfile::TempDir,
    srv: Arc<Server>,
    port: u16,
}

async fn env() -> Env {
    let dir = tempfile::tempdir().unwrap();
    let srv = Server::new(
        Config {
            data_dir: dir.path().to_path_buf(),
            ..Config::default()
        },
        Deps::default(),
    );
    let port = listen(srv.clone()).await;
    Env {
        _dir: dir,
        srv,
        port,
    }
}

async fn dial(port: u16) -> Client {
    let (c, _) = tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{port}/channel?v=1"))
        .await
        .unwrap();
    c
}

async fn send(c: &mut Client, v: Value) {
    c.send(Message::text(v.to_string())).await.unwrap();
}

/// 다음 텍스트 프레임. 닫히거나 시한이 지나면 `None`.
async fn next_json(c: &mut Client) -> Option<Value> {
    loop {
        match tokio::time::timeout(WAIT, c.next()).await {
            Ok(Some(Ok(Message::Text(t)))) => return serde_json::from_str(t.as_str()).ok(),
            Ok(Some(Ok(Message::Ping(_) | Message::Pong(_)))) => continue,
            _ => return None,
        }
    }
}

/// 서버가 연결을 닫았는가 (닫기 프레임 또는 스트림 끝).
async fn closed(c: &mut Client) -> bool {
    loop {
        match tokio::time::timeout(WAIT, c.next()).await {
            Ok(None | Some(Err(_)) | Some(Ok(Message::Close(_)))) => return true,
            Ok(Some(Ok(_))) => continue,
            Err(_) => return false,
        }
    }
}

async fn hello(c: &mut Client, slots: &[&str]) -> Value {
    send(c, json!({"t":"hello","slots":slots})).await;
    let v = next_json(c).await.expect("hello 답이 없다");
    assert_eq!(v["t"], "hello", "{v}");
    v
}

async fn wait_live(s: &Server, want: usize) {
    let deadline = tokio::time::Instant::now() + WAIT;
    while s.focus.live_count() != want && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(s.focus.live_count(), want);
}

/// TC-CH1-1
#[tokio::test]
async fn plain_get_is_400_and_channel_opens_without_tools() {
    let e = env().await;
    let r = reqwest_get(e.port, "/channel?v=1").await;
    assert_eq!(r, 400);
    let mut c = dial(e.port).await;
    hello(&mut c, &[]).await;
    assert!(
        !crate::reqgate::gate_exempt(&Method::GET, "/channel"),
        "채널은 출처 게이트를 지나야 한다"
    );
}

/// 업그레이드 헤더 없는 GET 의 상태 코드.
async fn reqwest_get(port: u16, path: &str) -> u16 {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut s = tokio::net::TcpStream::connect(("127.0.0.1", port))
        .await
        .unwrap();
    let req = format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    s.write_all(req.as_bytes()).await.unwrap();
    let mut buf = Vec::new();
    let _ = tokio::time::timeout(WAIT, s.read_to_end(&mut buf)).await;
    let head = String::from_utf8_lossy(&buf);
    head.split_whitespace()
        .nth(1)
        .and_then(|c| c.parse().ok())
        .unwrap_or(0)
}

/// TC-CH1-2
#[tokio::test]
async fn first_frame_must_be_hello() {
    let e = env().await;
    let mut c = dial(e.port).await;
    send(&mut c, json!({"t":"ping","n":1})).await;
    let v = next_json(&mut c).await.expect("error 프레임이 없다");
    assert_eq!(v["t"], "error");
    assert_eq!(v["code"], "hello_required");
    assert!(closed(&mut c).await, "hello 없이 연결이 남았다");
}

/// TC-CH1-3
#[tokio::test]
async fn hello_answers_epoch_and_server_info() {
    let e = env().await;
    let mut a = dial(e.port).await;
    let mut b = dial(e.port).await;
    let ha = hello(&mut a, &[]).await;
    let hb = hello(&mut b, &[]).await;
    let ep = ha["epoch"].as_str().unwrap_or_default();
    assert!(!ep.is_empty(), "{ha}");
    assert_eq!(ha["epoch"], hb["epoch"], "같은 프로세스의 epoch 가 다르다");
    let want = e.srv.asset_version();
    if want.is_empty() {
        assert!(ha["server"].get("assetVersion").is_none(), "{ha}");
    } else {
        assert_eq!(ha["server"]["assetVersion"], want.as_str(), "{ha}");
    }
}

/// TC-CH1-4
#[tokio::test]
async fn slots_hold_focus_lease_for_channel_lifetime() {
    let e = env().await;
    let mut c = dial(e.port).await;
    hello(&mut c, &["slotA", "slotB"]).await;
    wait_live(&e.srv, 2).await;

    hello(&mut c, &["slotB", "slotC"]).await;
    wait_live(&e.srv, 2).await;
    // 실행자는 산 구독 중 가장 최근에 주장한 신원이다 — 주장한 신원이 죽었으면 뽑히지 않는다.
    e.srv.focus.claim("slotA", "W1");
    assert_ne!(e.srv.focus.executor(), "slotA", "빠진 신원이 아직 산다");
    e.srv.focus.claim("slotC", "W2");
    assert_eq!(e.srv.focus.executor(), "slotC", "새 신원이 붙지 않았다");

    drop(c);
    wait_live(&e.srv, 0).await;
}

/// TC-CH1-5
#[tokio::test]
async fn ping_gets_pong_with_same_n() {
    let e = env().await;
    let mut c = dial(e.port).await;
    hello(&mut c, &[]).await;
    send(&mut c, json!({"t":"ping","n":7})).await;
    let v = next_json(&mut c).await.unwrap();
    assert_eq!(v, json!({"t":"pong","n":7}));
}

/// TC-CH1-6
#[tokio::test]
async fn bad_frames_get_error_and_connection_stays() {
    let e = env().await;
    let mut c = dial(e.port).await;
    hello(&mut c, &[]).await;

    c.send(Message::text("{not json")).await.unwrap();
    let v = next_json(&mut c).await.unwrap();
    assert_eq!(v["t"], "error", "{v}");

    send(&mut c, json!({"t":"nope"})).await;
    let v = next_json(&mut c).await.unwrap();
    assert_eq!(v["t"], "error", "{v}");

    c.send(Message::binary(vec![0u8, 0, 0, 0, 1]))
        .await
        .unwrap();
    let v = next_json(&mut c).await.unwrap();
    assert_eq!(v["t"], "error", "{v}");

    send(&mut c, json!({"t":"ping","n":1})).await;
    assert_eq!(next_json(&mut c).await.unwrap()["t"], "pong");
}
