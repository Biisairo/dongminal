use super::*;
use std::collections::BTreeMap;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

async fn frames(res: Response) -> Vec<Bytes> {
    let mut body = res.into_body();
    let mut out = Vec::new();
    while let Some(f) = body.frame().await {
        out.push(f.unwrap().into_data().unwrap());
    }
    out
}

#[tokio::test]
async fn frames_and_one_write() {
    let (res, mut s) = start(Duration::ZERO);
    assert_eq!(res.status(), StatusCode::OK);
    let h = res.headers();
    assert_eq!(h["content-type"], "text/event-stream");
    assert_eq!(h["cache-control"], "no-cache");
    assert_eq!(h["connection"], "keep-alive");
    let reader = tokio::spawn(frames(res));
    s.comment("connected");
    s.data(br#"{"a":1}"#);
    s.event("line", br#"{"b":2}"#);
    assert!(s.flush().await);
    // 빈 버퍼는 쓰지 않는다.
    assert!(s.flush().await);
    drop(s);
    let got = reader.await.unwrap();
    assert_eq!(got.len(), 1, "flush 하나가 프레임 하나다");
    assert_eq!(
        &got[0][..],
        b": connected\n\ndata: {\"a\":1}\n\nevent: line\ndata: {\"b\":2}\n\n"
    );
}

#[tokio::test]
async fn drain_stops_at_empty_and_cap() {
    let (_res, mut s) = start(Duration::ZERO);
    let (tx, mut rx) = mpsc::channel::<Vec<u8>>(8);
    for _ in 0..3 {
        tx.try_send(b"x".to_vec()).unwrap();
    }
    s.drain_data(|| rx.try_recv().ok());
    assert!(rx.try_recv().is_err());
    assert_eq!(s.buf, b"data: x\n\n".repeat(3));
    s.buf.clear();

    let big = vec![b'y'; MAX_BATCH_BYTES / 2];
    for _ in 0..4 {
        tx.try_send(big.clone()).unwrap();
    }
    s.drain_data(|| rx.try_recv().ok());
    assert!(!rx.is_empty() && s.full(), "상한에서 멈추지 않았다");
}

#[test]
fn constants() {
    assert_eq!(WRITE_TIMEOUT, Duration::from_secs(10));
    assert_eq!(MAX_BATCH_BYTES, 64 << 10);
}

#[tokio::test]
async fn flush_fails_after_client_left() {
    let (res, mut s) = start(Duration::ZERO);
    drop(res);
    s.data(b"x");
    assert!(!s.flush().await);
}

// 읽지 않는 클라이언트: 쓰기 시한이 지나면 flush 가 false 로 돌아온다 (HTTP-10).
// 포트를 잡지 않으려고 메모리 파이프 위에서 hyper 서버를 돌린다.
#[tokio::test]
async fn write_deadline_on_stuck_client() {
    let (mut client, server) = tokio::io::duplex(4096);
    let (done_tx, done_rx) = tokio::sync::oneshot::channel::<bool>();
    let done_tx = std::sync::Mutex::new(Some(done_tx));
    let svc = hyper::service::service_fn(move |_req| {
        let (res, mut s) = start(Duration::from_millis(150));
        let done = done_tx.lock().unwrap().take();
        tokio::spawn(async move {
            let big = vec![b'z'; 1 << 20];
            let mut ok = true;
            for _ in 0..64 {
                s.data(&big);
                if !s.flush().await {
                    ok = false;
                    break;
                }
            }
            if let Some(d) = done {
                let _ = d.send(ok);
            }
        });
        async move { Ok::<_, std::convert::Infallible>(res) }
    });
    let conn = tokio::spawn(
        hyper::server::conn::http1::Builder::new()
            .serve_connection(hyper_util::rt::TokioIo::new(server), svc),
    );
    client
        .write_all(b"GET /api/commands/sse HTTP/1.1\r\nHost: x\r\n\r\n")
        .await
        .unwrap();
    let ok = tokio::time::timeout(Duration::from_secs(5), done_rx)
        .await
        .expect("막힌 쓰기에서 돌아오지 않았다")
        .unwrap();
    assert!(
        !ok,
        "읽지 않는 클라이언트에 64 MiB 를 다 썼다 — 시한이 걸리지 않았다"
    );

    // 시한에 걸린 스트림은 연결을 끊는다. 남은 것을 읽어 내면 연결이 오류로 끝난다.
    let mut sink = Vec::new();
    let _ = tokio::time::timeout(Duration::from_secs(5), client.read_to_end(&mut sink)).await;
    let res = tokio::time::timeout(Duration::from_secs(5), conn)
        .await
        .expect("연결이 끝나지 않았다")
        .unwrap();
    assert!(res.is_err(), "시한 뒤 연결이 정상 종료로 끝났다");
    let head = String::from_utf8_lossy(&sink[..sink.len().min(512)]).to_string();
    assert!(head.starts_with("HTTP/1.1 200 OK\r\n"), "{head}");
    assert!(
        head.contains("content-type: text/event-stream\r\n"),
        "{head}"
    );
    assert!(head.contains("transfer-encoding: chunked\r\n"), "{head}");
}

// 봉투는 종전 map 조립과 바이트가 같다 (FR-OPT-0-3).
#[test]
fn payload_byte_compatible_with_map() {
    assert_eq!(
        payload::<()>("update_changed", None),
        br#"{"action":"update_changed"}"#
    );
    let empty: BTreeMap<&str, &str> = BTreeMap::new();
    assert_eq!(
        payload("access_changed", Some(&empty)),
        br#"{"action":"access_changed","args":{}}"#
    );
    let mut m = BTreeMap::new();
    m.insert("toolId", "t");
    m.insert("reason", "r");
    assert_eq!(
        payload("tool_attention", Some(&m)),
        br#"{"action":"tool_attention","args":{"reason":"r","toolId":"t"}}"#
    );
    assert_eq!(
        workspace_changed(7),
        br#"{"action":"workspace_changed","args":{"rev":7}}"#
    );
}

#[test]
fn payload_escapes_html() {
    let mut m = BTreeMap::new();
    m.insert("x", "<&>");
    assert_eq!(
        payload("a", Some(&m)),
        b"{\"action\":\"a\",\"args\":{\"x\":\"\\u003c\\u0026\\u003e\"}}"
    );
}

struct Unencodable;

impl serde::Serialize for Unencodable {
    fn serialize<S: serde::Serializer>(&self, _: S) -> Result<S::Ok, S::Error> {
        Err(serde::ser::Error::custom(
            "json: unsupported type: chan int",
        ))
    }
}

#[test]
fn payload_marshal_error_keeps_action() {
    assert_eq!(payload("x", Some(&Unencodable)), br#"{"action":"x"}"#);
}
