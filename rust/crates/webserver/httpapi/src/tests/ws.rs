//! `/ws` 통합 (Go `handlers_ws_test.go`·`term_resume_test.go`·`term_size_test.go`·
//! `browser_input_test.go`·`ws_relay_coalesce_test.go` 의 연결 부분). 실제 TCP 로 업그레이드한다.

use std::convert::Infallible;
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use hyper_util::rt::TokioIo;
use otter_shared_toolhub::{
    OP_EXIT, OP_INPUT, OP_OUTPUT, OP_REPLY_SEAT, OP_RESIZE, OP_SEQ, OP_SIZE, OP_TOOL_ID, OutChunk,
    ToolSnapshot, size_payload,
};
use tokio_tungstenite::tungstenite::Message;

use super::fakes::*;
use crate::ws::{TERM_HARD_CLEAR, TERM_RESET};
use crate::{Config, Deps, Server};

type Client =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

const PORT_MIN: u16 = 60147;
const PORT_MAX: u16 = 64999;
const WAIT: Duration = Duration::from_secs(5);

/// 격리 규칙(C-RSP-1): 60147 이상의 loopback 포트에만 붙는다.
pub(crate) async fn listen(srv: Arc<Server>) -> u16 {
    let start = PORT_MIN + (std::process::id() as u16 % 2000);
    for p in (start..PORT_MAX).chain(PORT_MIN..start) {
        let Ok(l) = tokio::net::TcpListener::bind(("127.0.0.1", p)).await else {
            continue;
        };
        tokio::spawn(async move {
            while let Ok((sock, addr)) = l.accept().await {
                let s = srv.clone();
                tokio::spawn(async move {
                    let svc = hyper::service::service_fn(move |req| {
                        let s = s.clone();
                        async move { Ok::<_, Infallible>(s.serve(req, addr).await) }
                    });
                    let _ = hyper::server::conn::http1::Builder::new()
                        .serve_connection(TokioIo::new(sock), svc)
                        .with_upgrades()
                        .await;
                });
            }
        });
        return p;
    }
    panic!("빈 포트가 없다");
}

struct Env {
    _dir: tempfile::TempDir,
    srv: Arc<Server>,
    hub: Arc<FakeHub>,
    port: u16,
}

async fn env(hub: FakeHub) -> Env {
    let dir = tempfile::tempdir().unwrap();
    let hub = Arc::new(hub);
    let srv = Server::new(
        Config {
            data_dir: dir.path().to_path_buf(),
            ..Config::default()
        },
        Deps {
            tools: Some(hub.clone()),
            ..Deps::default()
        },
    );
    let port = listen(srv.clone()).await;
    Env {
        _dir: dir,
        srv,
        hub,
        port,
    }
}

async fn dial(port: u16, path: &str) -> Client {
    let (c, _) = tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{port}{path}"))
        .await
        .unwrap();
    c
}

async fn next_bin(c: &mut Client) -> Option<Vec<u8>> {
    loop {
        match tokio::time::timeout(WAIT, c.next()).await {
            Ok(Some(Ok(Message::Binary(b)))) => return Some(b.to_vec()),
            Ok(Some(Ok(Message::Ping(_) | Message::Pong(_)))) => continue,
            _ => return None,
        }
    }
}

/// `op` 프레임까지 읽는다. 그 앞의 프레임들과 그 프레임을 돌려준다.
async fn until_op(c: &mut Client, op: u8) -> (Vec<Vec<u8>>, Vec<u8>) {
    let mut before = Vec::new();
    while let Some(m) = next_bin(c).await {
        if m.first() == Some(&op) {
            return (before, m);
        }
        before.push(m);
    }
    panic!("op {op:#x} 가 오지 않았다 (앞 프레임 {before:?})");
}

fn outputs(frames: &[Vec<u8>]) -> Vec<u8> {
    frames
        .iter()
        .filter(|f| f.first() == Some(&OP_OUTPUT))
        .flat_map(|f| f[1..].to_vec())
        .collect()
}

fn find(h: &[u8], n: &[u8]) -> Option<usize> {
    h.windows(n.len()).position(|w| w == n)
}

fn seeded(id: &str, data: &str, cols: u16, rows: u16) -> FakeHub {
    let h = FakeHub::default();
    h.seed(id, "Shell");
    h.snaps.lock().unwrap().insert(
        id.to_owned(),
        ToolSnapshot {
            data: data.as_bytes().to_vec(),
            end: data.len() as i64,
            cols,
            rows,
            ..ToolSnapshot::default()
        },
    );
    h
}

async fn wait_until(what: &str, f: impl Fn() -> bool) {
    let deadline = tokio::time::Instant::now() + WAIT;
    while !f() {
        assert!(tokio::time::Instant::now() < deadline, "{what}");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

#[tokio::test]
async fn new_tool_announces_id() {
    let e = env(FakeHub::default()).await;
    let mut c = dial(e.port, "/ws?cols=80&rows=24").await;
    let m = next_bin(&mut c).await.unwrap();
    assert_eq!(m[0], OP_TOOL_ID);
    assert_eq!(&m[1..], b"fake1");
    let (_, cols, rows, _) = e.hub.last.lock().unwrap().clone().unwrap();
    assert_eq!((cols, rows), (80, 24));
}

#[tokio::test]
async fn existing_tool_frame_order_and_full_replay() {
    let e = env(seeded("t1", "junk\nhello", 100, 30)).await;
    let mut c = dial(e.port, "/ws?tool=t1&cols=80&rows=24").await;
    let id = next_bin(&mut c).await.unwrap();
    assert_eq!((id[0], &id[1..]), (OP_TOOL_ID, &b"t1"[..]));
    let size = next_bin(&mut c).await.unwrap();
    assert_eq!(size[0], OP_SIZE);
    assert_eq!(&size[1..], size_payload(100, 30));
    let seat = next_bin(&mut c).await.unwrap();
    assert_eq!(
        seat,
        vec![OP_REPLY_SEAT, 1],
        "첫 연결이 좌석의 주인이 아니다"
    );
    let (before, seq) = until_op(&mut c, OP_SEQ).await;
    assert_eq!(seq.len(), 10);
    assert_eq!(seq[9], 1, "since 가 없으면 전량 재생이다");
    assert_eq!(i64::from_be_bytes(seq[1..9].try_into().unwrap()), 10);
    let body = outputs(&before);
    let clear = find(&body, TERM_HARD_CLEAR).expect("하드 클리어가 없다");
    assert!(find(&body, TERM_RESET).is_some_and(|r| r < clear));
    assert!(body.ends_with(b"hello"), "첫 줄 끝까지 버린다: {body:?}");
    assert!(find(&body, b"junk").is_none());
}

#[tokio::test]
async fn resume_sends_delta_without_clear() {
    let e = env(seeded("t1", "first\nsecond", 0, 0)).await;
    let mut c = dial(e.port, "/ws?tool=t1&since=6").await;
    let (before, seq) = until_op(&mut c, OP_SEQ).await;
    assert_eq!(seq[9], 0, "이어 붙였어야 한다");
    assert!(
        !before.iter().any(|f| f[0] == OP_SIZE),
        "크기를 모르면 알리지 않는다"
    );
    let body = outputs(&before);
    assert_eq!(body, b"second");
}

#[tokio::test]
async fn input_and_resize_reach_hub() {
    let e = env(seeded("t1", "\n$ ", 0, 0)).await;
    let mut c = dial(e.port, "/ws?tool=t1").await;
    until_op(&mut c, OP_SEQ).await;
    assert!(e.srv.last_browser_input("t1").is_none());
    c.send(Message::Binary(vec![OP_INPUT, b'x'].into()))
        .await
        .unwrap();
    c.send(Message::Binary(vec![OP_RESIZE, 0, 100, 0, 30].into()))
        .await
        .unwrap();
    wait_until("입력·크기가 허브에 닿지 않았다", || {
        !e.hub.resizes.lock().unwrap().is_empty()
    })
    .await;
    assert_eq!(
        *e.hub.inputs.lock().unwrap(),
        vec![("t1".to_owned(), b"x".to_vec())]
    );
    assert_eq!(
        *e.hub.resizes.lock().unwrap(),
        vec![("t1".to_owned(), 100, 30)]
    );
    assert!(e.srv.last_browser_input("t1").is_some());
}

#[tokio::test]
async fn missing_tool_gets_exit() {
    let e = env(FakeHub::default()).await;
    let mut c = dial(e.port, "/ws?tool=9999").await;
    assert_eq!(next_bin(&mut c).await.unwrap(), vec![OP_EXIT]);
}

#[tokio::test]
async fn nil_tools_is_500_and_plain_get_is_400() {
    let dir = tempfile::tempdir().unwrap();
    let srv = Server::new(
        Config {
            data_dir: dir.path().to_path_buf(),
            ..Config::default()
        },
        Deps::default(),
    );
    let port = listen(srv).await;
    match tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{port}/ws")).await {
        Err(tokio_tungstenite::tungstenite::Error::Http(r)) => assert_eq!(r.status(), 500),
        other => panic!("업그레이드가 실패해야 한다: {:?}", other.map(|_| ())),
    }
    let e = env(FakeHub::default()).await;
    let mut s = tokio::net::TcpStream::connect(("127.0.0.1", e.port))
        .await
        .unwrap();
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    s.write_all(
        format!(
            "GET /ws HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\n\r\n",
            e.port
        )
        .as_bytes(),
    )
    .await
    .unwrap();
    let mut out = String::new();
    s.read_to_string(&mut out).await.unwrap();
    assert!(out.starts_with("HTTP/1.1 400 "), "{out}");
}

async fn relay_env() -> (
    Env,
    Client,
    tokio::sync::mpsc::Sender<OutChunk>,
    tokio_util::sync::CancellationToken,
) {
    let e = env(seeded("t1", "\nabcdefghij", 0, 0)).await;
    let mut c = dial(e.port, "/ws?tool=t1").await;
    until_op(&mut c, OP_SEQ).await;
    let (tx, exit) = e.hub.subs.lock().unwrap().get("t1").cloned().unwrap();
    (e, c, tx, exit)
}

fn chunk(s: &str, end: i64) -> OutChunk {
    OutChunk {
        data: s.as_bytes().to_vec(),
        end,
        size: None,
    }
}

#[tokio::test]
async fn relay_advances_and_trims_overlap() {
    let (_e, mut c, tx, _) = relay_env().await;
    for ch in [
        chunk("klmno", 16),
        chunk("no", 16),
        chunk("pq", 18),
        chunk("old", 0),
    ] {
        tx.send(ch).await.unwrap();
    }
    let mut got = Vec::new();
    while got.len() < b"klmnopqold".len() {
        let m = next_bin(&mut c).await.expect("출력이 끊겼다");
        assert_eq!(m[0], OP_OUTPUT);
        got.extend_from_slice(&m[1..]);
    }
    assert_eq!(got, b"klmnopqold");
}

#[tokio::test]
async fn relay_closes_on_gap() {
    let (_e, mut c, tx, _) = relay_env().await;
    tx.send(chunk("klm", 14)).await.unwrap();
    tx.send(chunk("xyz", 30)).await.unwrap();
    let m = next_bin(&mut c).await.unwrap();
    assert_eq!(m, [&[OP_OUTPUT][..], b"klm"].concat());
    assert!(next_bin(&mut c).await.is_none(), "구멍 뒤의 조각이 나갔다");
}

#[tokio::test]
async fn relay_sends_exit_on_tool_exit() {
    let (_e, mut c, _tx, exit) = relay_env().await;
    exit.cancel();
    assert_eq!(next_bin(&mut c).await.unwrap(), vec![OP_EXIT]);
    assert!(next_bin(&mut c).await.is_none());
}

#[tokio::test]
async fn relay_flushes_output_before_size() {
    let (_e, mut c, tx, _) = relay_env().await;
    tx.send(chunk("klm", 14)).await.unwrap();
    tx.send(OutChunk {
        size: Some(otter_shared_toolhub::TermSize { cols: 90, rows: 20 }),
        ..OutChunk::default()
    })
    .await
    .unwrap();
    tx.send(chunk("no", 16)).await.unwrap();
    let mut frames = Vec::new();
    while frames
        .iter()
        .filter(|f: &&Vec<u8>| f[0] == OP_OUTPUT)
        .map(|f| f.len() - 1)
        .sum::<usize>()
        < 5
    {
        frames.push(next_bin(&mut c).await.expect("끊겼다"));
    }
    let size_at = frames
        .iter()
        .position(|f| f[0] == OP_SIZE)
        .expect("크기 통보가 없다");
    assert_eq!(&frames[size_at][1..], size_payload(90, 20));
    assert_eq!(outputs(&frames[..size_at]), b"klm");
    assert_eq!(outputs(&frames[size_at..]), b"no");
}
