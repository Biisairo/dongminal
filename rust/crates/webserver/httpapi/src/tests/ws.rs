//! 터미널 — 채널 위의 `term.open`·`[op][sid]` 프레임 (`perf/CHANNEL_PROTOCOL.md` §10.6 C5, 옛 `/ws`
//! 통합 시험의 자리). 실제 TCP 로 업그레이드한다.

use std::convert::Infallible;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use super::wsc::{Message, TextOf};
use futures_util::{SinkExt, StreamExt};
use hyper_util::rt::TokioIo;
use otter_shared_toolhub::{
    OP_EXIT, OP_INPUT, OP_OUTPUT, OP_REPLY_SEAT, OP_RESIZE, OP_SEQ, OP_SIZE, OP_TOOL_ID, OutChunk,
    ToolScreen, ToolSnapshot, size_payload,
};
use serde_json::{Value, json};

use super::fakes::*;
use crate::{Config, Deps, Server};

type Client = super::wsc::Client;

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

/// 인사까지 마친 채널.
async fn chan(port: u16) -> Client {
    let mut c = super::wsc::dial(port, "/channel?v=1").await;
    send_json(&mut c, json!({"t":"hello","slots":[]})).await;
    loop {
        if let Some(Frame::Text(v)) = next(&mut c).await
            && v["t"] == "hello"
        {
            return c;
        }
    }
}

async fn send_json(c: &mut Client, v: Value) {
    c.send(Message::text(v.to_string())).await.unwrap();
}

async fn open(c: &mut Client, v: Value) {
    let mut v = v;
    v["t"] = json!("term.open");
    send_json(c, v).await;
}

async fn send_bin(c: &mut Client, op: u8, sid: u32, payload: &[u8]) {
    let mut b = vec![op];
    b.extend_from_slice(&sid.to_be_bytes());
    b.extend_from_slice(payload);
    c.send(Message::binary(b)).await.unwrap();
}

enum Frame {
    Text(Value),
    /// (sid, op 가 앞에 붙은 페이로드 — 옛 `/ws` 프레임 꼴)
    Bin(u32, Vec<u8>),
}

async fn next(c: &mut Client) -> Option<Frame> {
    loop {
        match tokio::time::timeout(WAIT, c.next()).await {
            Ok(Some(Ok(Message::Binary(b)))) => {
                let b = b.to_vec();
                let sid = u32::from_be_bytes(b[1..5].try_into().unwrap());
                let mut f = vec![b[0]];
                f.extend_from_slice(&b[5..]);
                return Some(Frame::Bin(sid, f));
            }
            Ok(Some(Ok(Message::Text(t)))) => {
                return Some(Frame::Text(serde_json::from_str(t.as_str()).unwrap()));
            }
            Ok(Some(Ok(Message::Ping(_) | Message::Pong(_)))) => continue,
            _ => return None,
        }
    }
}

/// `sid` 의 다음 바이너리 프레임. 다른 sid·텍스트는 건너뛴다.
async fn next_bin(c: &mut Client, sid: u32) -> Option<Vec<u8>> {
    loop {
        match next(c).await? {
            Frame::Bin(s, f) if s == sid => return Some(f),
            _ => continue,
        }
    }
}

/// `sid` 의 `op` 프레임까지 읽는다. 그 앞의 같은 sid 프레임들과 그 프레임을 돌려준다.
async fn until_op(c: &mut Client, sid: u32, op: u8) -> (Vec<Vec<u8>>, Vec<u8>) {
    let mut before = Vec::new();
    while let Some(m) = next_bin(c, sid).await {
        if m.first() == Some(&op) {
            return (before, m);
        }
        before.push(m);
    }
    panic!("op {op:#x} 가 오지 않았다 (앞 프레임 {before:?})");
}

/// 시한 안에 `sid` 로 아무것도 오지 않았는가.
async fn silent(c: &mut Client, sid: u32) -> bool {
    loop {
        match tokio::time::timeout(Duration::from_millis(300), c.next()).await {
            Err(_) | Ok(None) => return true,
            Ok(Some(Ok(Message::Binary(b)))) if b.len() >= 5 => {
                if u32::from_be_bytes(b[1..5].try_into().unwrap()) == sid {
                    return false;
                }
            }
            Ok(_) => continue,
        }
    }
}

fn outputs(frames: &[Vec<u8>]) -> Vec<u8> {
    frames
        .iter()
        .filter(|f| f.first() == Some(&OP_OUTPUT))
        .flat_map(|f| f[1..].to_vec())
        .collect()
}

fn snap(data: &str, cols: u16, rows: u16) -> ToolSnapshot {
    ToolSnapshot {
        data: data.as_bytes().to_vec(),
        end: data.len() as i64,
        cols,
        rows,
        ..ToolSnapshot::default()
    }
}

/// 링 바이트 `data` 의 화면 상태 스냅숏 — 끝 오프셋이 링과 같다.
fn screen(data: &str, cols: u16, rows: u16) -> ToolScreen {
    ToolScreen {
        data: format!("\x1bcSCREEN[{data}]").into_bytes(),
        end: data.len() as i64,
        cols,
        rows,
        ..ToolScreen::default()
    }
}

fn seeded(id: &str, data: &str, cols: u16, rows: u16) -> FakeHub {
    seed_into(FakeHub::default(), id, data, cols, rows)
}

fn seed_into(h: FakeHub, id: &str, data: &str, cols: u16, rows: u16) -> FakeHub {
    h.seed(id, "Shell");
    h.snaps
        .lock()
        .unwrap()
        .insert(id.to_owned(), snap(data, cols, rows));
    h.screens
        .lock()
        .unwrap()
        .insert(id.to_owned(), screen(data, cols, rows));
    h
}

fn seq_end(seq: &[u8]) -> i64 {
    i64::from_be_bytes(seq[1..9].try_into().unwrap())
}

const FLAG_FULL: u8 = 1;
const FLAG_ALT: u8 = 2;
const FLAG_SNAP: u8 = 4;

async fn wait_until(what: &str, f: impl Fn() -> bool) {
    let deadline = tokio::time::Instant::now() + WAIT;
    while !f() {
        assert!(tokio::time::Instant::now() < deadline, "{what}");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

/// TC-CH5-1
#[tokio::test]
async fn new_tool_announces_id() {
    let e = env(FakeHub::default()).await;
    let mut c = chan(e.port).await;
    open(&mut c, json!({"sid":3,"cols":80,"rows":24})).await;
    let m = next_bin(&mut c, 3).await.unwrap();
    assert_eq!(m[0], OP_TOOL_ID);
    assert_eq!(&m[1..], b"fake1");
    let (_, cols, rows, _) = e.hub.last.lock().unwrap().clone().unwrap();
    assert_eq!((cols, rows), (80, 24));
}

/// TC-CH5-2 · PERF 2.5: `since` 가 없으면(깨움) 순서는 `TOOLID` → `SIZE` → 좌석 → 스냅숏 `OUTPUT` →
/// `SEQ(FULL|SNAP)` 이다. 스냅숏은 데몬이 만든 그대로 보내고, `SEQ` 뒤에 첫 기록 줄 번호와 cwd 를 붙인다.
#[tokio::test]
async fn wake_frame_order_and_screen_snapshot() {
    let h = seeded("t1", "junk\nhello", 100, 30);
    {
        let mut g = h.screens.lock().unwrap();
        let s = g.get_mut("t1").unwrap();
        s.alt = true;
        s.first_line = 42;
        s.cwd = "/tmp/깨움".to_owned();
    }
    let e = env(h).await;
    let mut c = chan(e.port).await;
    open(&mut c, json!({"sid":7,"tool":"t1","cols":80,"rows":24})).await;
    let id = next_bin(&mut c, 7).await.unwrap();
    assert_eq!((id[0], &id[1..]), (OP_TOOL_ID, &b"t1"[..]));
    let size = next_bin(&mut c, 7).await.unwrap();
    assert_eq!(size[0], OP_SIZE);
    assert_eq!(&size[1..], size_payload(100, 30));
    let seat = next_bin(&mut c, 7).await.unwrap();
    assert_eq!(
        seat,
        vec![OP_REPLY_SEAT, 1],
        "첫 연결이 좌석의 주인이 아니다"
    );
    let (before, seq) = until_op(&mut c, 7, OP_SEQ).await;
    assert_eq!(
        before.len(),
        1,
        "스냅숏과 SEQ 사이에 다른 프레임이 끼었다: {before:?}"
    );
    assert_eq!(outputs(&before), b"\x1bcSCREEN[junk\nhello]");
    assert_eq!(seq[9], FLAG_FULL | FLAG_ALT | FLAG_SNAP);
    assert_eq!(seq_end(&seq), 10);
    assert_eq!(u64::from_be_bytes(seq[10..18].try_into().unwrap()), 42);
    assert_eq!(&seq[18..], "/tmp/깨움".as_bytes());
    assert_eq!(e.hub.screen_calls.load(Ordering::SeqCst), 1);
}

/// PERF 2.5: `snap` 이 있으면 `since` 가 있어도 스냅숏이다.
#[tokio::test]
async fn snap_flag_overrides_since() {
    let e = env(seeded("t1", "first\nsecond", 0, 0)).await;
    let mut c = chan(e.port).await;
    open(&mut c, json!({"sid":1,"tool":"t1","since":6,"snap":true})).await;
    let (before, seq) = until_op(&mut c, 1, OP_SEQ).await;
    assert_eq!(outputs(&before), b"\x1bcSCREEN[first\nsecond]");
    assert_eq!(seq[9] & FLAG_SNAP, FLAG_SNAP);
}

/// PERF 2.5 (FR-CON-10): `since` 가 링 밖이면 링 전량 재생 대신 스냅숏이다.
#[tokio::test]
async fn since_outside_ring_gets_screen() {
    let h = seeded("t1", "first\nsecond", 0, 0);
    // 링에는 끝 6바이트만 남았다 — 6 앞의 좌표는 이어 붙일 수 없다.
    h.snaps.lock().unwrap().insert(
        "t1".to_owned(),
        ToolSnapshot {
            data: b"second".to_vec(),
            end: 12,
            ..ToolSnapshot::default()
        },
    );
    let e = env(h).await;
    let mut c = chan(e.port).await;
    open(&mut c, json!({"sid":1,"tool":"t1","since":2})).await;
    let (before, seq) = until_op(&mut c, 1, OP_SEQ).await;
    assert_eq!(outputs(&before), b"\x1bcSCREEN[first\nsecond]");
    assert_eq!(seq[9] & FLAG_SNAP, FLAG_SNAP);
    assert_eq!(seq_end(&seq), 12);
}

/// PERF 2.5 (FR-TRM-4): 스냅숏 오프셋 뒤 출력은 빠짐·겹침 없이 잇는다.
#[tokio::test]
async fn output_after_screen_has_no_gap_or_overlap() {
    let e = env(seeded("t1", "0123456789", 0, 0)).await;
    let mut c = chan(e.port).await;
    open(&mut c, json!({"sid":1,"tool":"t1"})).await;
    let (_, seq) = until_op(&mut c, 1, OP_SEQ).await;
    assert_eq!(seq_end(&seq), 10);
    let (tx, _) = e.hub.subs.lock().unwrap().get("t1").cloned().unwrap();
    // 스냅숏보다 앞에서 시작한 조각(겹침)과 바로 뒤 조각.
    tx.send(chunk("89AB", 12)).await.unwrap();
    tx.send(chunk("CD", 14)).await.unwrap();
    let mut got = Vec::new();
    while got.len() < 4 {
        let m = next_bin(&mut c, 1).await.expect("출력이 끊겼다");
        assert_eq!(m[0], OP_OUTPUT);
        got.extend_from_slice(&m[1..]);
    }
    assert_eq!(got, b"ABCD");
    assert_eq!(e.hub.screen_calls.load(Ordering::SeqCst), 1);
}

/// PERF 2.5: 같은 도구를 여럿이 한꺼번에 깨우면 스냅숏은 한 번만 만든다.
#[tokio::test]
async fn concurrent_wakes_share_one_screen() {
    let h = FakeHub {
        screen_delay: Duration::from_millis(300),
        ..FakeHub::default()
    };
    let e = env(seed_into(h, "t1", "\n$ ", 0, 0)).await;
    let mut a = chan(e.port).await;
    let mut b = chan(e.port).await;
    open(&mut a, json!({"sid":1,"tool":"t1"})).await;
    open(&mut b, json!({"sid":1,"tool":"t1"})).await;
    let (fa, sa) = until_op(&mut a, 1, OP_SEQ).await;
    let (fb, sb) = until_op(&mut b, 1, OP_SEQ).await;
    assert_eq!(outputs(&fa), outputs(&fb));
    assert_eq!(sa, sb);
    assert_eq!(e.hub.screen_calls.load(Ordering::SeqCst), 1);
}

/// TC-CH5-3
#[tokio::test]
async fn resume_sends_delta_without_clear() {
    let e = env(seeded("t1", "first\nsecond", 0, 0)).await;
    let mut c = chan(e.port).await;
    open(&mut c, json!({"sid":1,"tool":"t1","since":6})).await;
    let (before, seq) = until_op(&mut c, 1, OP_SEQ).await;
    assert_eq!(seq[9], 0, "이어 붙였어야 한다");
    assert!(
        !before.iter().any(|f| f[0] == OP_SIZE),
        "크기를 모르면 알리지 않는다"
    );
    assert_eq!(outputs(&before), b"second");
}

/// TC-CH5-4
#[tokio::test]
async fn input_and_resize_reach_hub() {
    let e = env(seeded("t1", "\n$ ", 0, 0)).await;
    let mut c = chan(e.port).await;
    open(&mut c, json!({"sid":2,"tool":"t1"})).await;
    until_op(&mut c, 2, OP_SEQ).await;
    assert!(e.srv.last_browser_input("t1").is_none());
    send_bin(&mut c, OP_INPUT, 99, b"lost").await;
    send_bin(&mut c, OP_INPUT, 2, b"x").await;
    send_bin(&mut c, OP_RESIZE, 2, &[0, 100, 0, 30]).await;
    wait_until("입력·크기가 허브에 닿지 않았다", || {
        !e.hub.resizes.lock().unwrap().is_empty()
    })
    .await;
    assert_eq!(
        *e.hub.inputs.lock().unwrap(),
        vec![("t1".to_owned(), b"x".to_vec())],
        "모르는 sid 의 입력이 갔다"
    );
    assert_eq!(
        *e.hub.resizes.lock().unwrap(),
        vec![("t1".to_owned(), 100, 30)]
    );
    assert!(e.srv.last_browser_input("t1").is_some());
}

/// TC-CH5-5
#[tokio::test]
async fn missing_tool_gets_exit_and_channel_stays() {
    let e = env(FakeHub::default()).await;
    let mut c = chan(e.port).await;
    open(&mut c, json!({"sid":5,"tool":"9999"})).await;
    assert_eq!(next_bin(&mut c, 5).await.unwrap(), vec![OP_EXIT]);
    send_json(&mut c, json!({"t":"ping","n":1})).await;
    loop {
        match next(&mut c).await.expect("채널이 닫혔다") {
            Frame::Text(v) if v["t"] == "pong" => break,
            _ => continue,
        }
    }
}

/// TC-CH5-13
#[tokio::test]
async fn old_ws_endpoint_is_gone() {
    let e = env(FakeHub::default()).await;
    let d = super::wsc::dial_with(e.port, "/ws?tool=t1", Some(super::wsc::OFFER), &[]).await;
    assert_ne!(d.status, 101, "옛 /ws 가 아직 업그레이드된다");
}

async fn relay_env(
    data: &str,
) -> (
    Env,
    Client,
    tokio::sync::mpsc::Sender<OutChunk>,
    tokio_util::sync::CancellationToken,
) {
    let e = env(seeded("t1", data, 0, 0)).await;
    let mut c = chan(e.port).await;
    open(&mut c, json!({"sid":1,"tool":"t1"})).await;
    until_op(&mut c, 1, OP_SEQ).await;
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

/// TC-CH5-6
#[tokio::test]
async fn relay_advances_and_trims_overlap() {
    let (_e, mut c, tx, _) = relay_env("\nabcdefghij").await;
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
        let m = next_bin(&mut c, 1).await.expect("출력이 끊겼다");
        assert_eq!(m[0], OP_OUTPUT);
        got.extend_from_slice(&m[1..]);
    }
    assert_eq!(got, b"klmnopqold");
}

/// TC-CH5-6
#[tokio::test]
async fn relay_flushes_output_before_size() {
    let (_e, mut c, tx, _) = relay_env("\nabcdefghij").await;
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
        frames.push(next_bin(&mut c, 1).await.expect("끊겼다"));
    }
    let size_at = frames
        .iter()
        .position(|f| f[0] == OP_SIZE)
        .expect("크기 통보가 없다");
    assert_eq!(&frames[size_at][1..], size_payload(90, 20));
    assert_eq!(outputs(&frames[..size_at]), b"klm");
    assert_eq!(outputs(&frames[size_at..]), b"no");
}

/// TC-CH5-7: 틈이 생기면 그 sid 만 보낸 끝부터 다시 재생한다. 채널은 남는다.
#[tokio::test]
async fn relay_resyncs_sid_on_gap() {
    let (e, mut c, tx, _) = relay_env("\nabcdefghij").await;
    tx.send(chunk("klm", 14)).await.unwrap();
    let m = next_bin(&mut c, 1).await.unwrap();
    assert_eq!(m, [&[OP_OUTPUT][..], b"klm"].concat());
    // 데몬은 그 사이 "nopqrs" 까지 냈다 — 구독에는 끝 조각만 왔다.
    e.hub
        .snaps
        .lock()
        .unwrap()
        .insert("t1".to_owned(), snap("\nabcdefghijklmnopqrs", 0, 0));
    tx.send(chunk("rs", 20)).await.unwrap();
    let (before, seq) = until_op(&mut c, 1, OP_SEQ).await;
    assert_eq!(
        outputs(&before),
        b"nopqrs",
        "보낸 끝(14) 뒤를 다시 받아야 한다"
    );
    assert_eq!(seq[9] & 1, 0, "이어 붙이기다");
    assert_eq!(seq_end(&seq), 20);
    tx.send(chunk("t", 21)).await.unwrap();
    assert_eq!(
        next_bin(&mut c, 1).await.unwrap(),
        [&[OP_OUTPUT][..], b"t"].concat()
    );
}

/// PERF 2.5: 틈을 메울 바이트가 링에 없으면 그 sid 를 스냅숏으로 다시 맞춘다.
#[tokio::test]
async fn relay_gap_outside_ring_resyncs_with_screen() {
    let (e, mut c, tx, _) = relay_env("\nabcdefghij").await;
    // 데몬 링은 그 사이 앞을 잃었다 — 보낸 끝(11) 뒤를 이어 줄 수 없다.
    e.hub.snaps.lock().unwrap().insert(
        "t1".to_owned(),
        ToolSnapshot {
            data: b"uvwxyz".to_vec(),
            end: 40,
            ..ToolSnapshot::default()
        },
    );
    e.hub.screens.lock().unwrap().insert(
        "t1".to_owned(),
        ToolScreen {
            data: b"\x1bcNOW".to_vec(),
            end: 40,
            ..ToolScreen::default()
        },
    );
    tx.send(chunk("yz", 40)).await.unwrap();
    let (before, seq) = until_op(&mut c, 1, OP_SEQ).await;
    assert_eq!(outputs(&before), b"\x1bcNOW");
    assert_eq!(seq[9] & FLAG_SNAP, FLAG_SNAP);
    assert_eq!(seq_end(&seq), 40);
}

/// TC-CH5-8
#[tokio::test]
async fn tool_exit_sends_exit_and_other_sid_continues() {
    let h = seed_into(seeded("t1", "\nabc", 0, 0), "t2", "\nxyz", 0, 0);
    let e = env(h).await;
    let mut c = chan(e.port).await;
    open(&mut c, json!({"sid":1,"tool":"t1"})).await;
    until_op(&mut c, 1, OP_SEQ).await;
    open(&mut c, json!({"sid":2,"tool":"t2"})).await;
    until_op(&mut c, 2, OP_SEQ).await;
    let (_, exit1) = e.hub.subs.lock().unwrap().get("t1").cloned().unwrap();
    let (tx2, _) = e.hub.subs.lock().unwrap().get("t2").cloned().unwrap();
    exit1.cancel();
    assert_eq!(next_bin(&mut c, 1).await.unwrap(), vec![OP_EXIT]);
    tx2.send(chunk("w", 5)).await.unwrap();
    assert_eq!(
        next_bin(&mut c, 2).await.unwrap(),
        [&[OP_OUTPUT][..], b"w"].concat()
    );
}

/// TC-CH5-9·10
#[tokio::test]
async fn reply_seat_moves_on_term_close() {
    let e = env(seeded("t1", "\n$ ", 0, 0)).await;
    let mut a = chan(e.port).await;
    open(&mut a, json!({"sid":1,"tool":"t1"})).await;
    until_op(&mut a, 1, OP_SEQ).await;
    let mut b = chan(e.port).await;
    open(&mut b, json!({"sid":1,"tool":"t1"})).await;
    let (before, _) = until_op(&mut b, 1, OP_SEQ).await;
    assert!(
        before.contains(&vec![OP_REPLY_SEAT, 0]),
        "나중에 붙은 쪽이 주인이다: {before:?}"
    );
    assert_eq!(
        until_op(&mut a, 1, OP_REPLY_SEAT).await.1,
        vec![OP_REPLY_SEAT, 1],
        "붙음이 바뀌면 모두에게 다시 알린다"
    );
    send_json(&mut a, json!({"t":"term.close","sid":1})).await;
    assert_eq!(
        until_op(&mut b, 1, OP_REPLY_SEAT).await.1,
        vec![OP_REPLY_SEAT, 1],
        "좌석이 승계되지 않았다"
    );
    let (tx, _) = e.hub.subs.lock().unwrap().get("t1").cloned().unwrap();
    let _ = tx.send(chunk("z", 4)).await;
    assert!(silent(&mut a, 1).await, "닫은 sid 로 프레임이 왔다");
}

/// TC-CH5-12
#[tokio::test]
async fn subscription_end_sends_term_lost() {
    let (e, mut c, tx, _) = relay_env("\nabc").await;
    drop(tx);
    e.hub.subs.lock().unwrap().remove("t1");
    loop {
        match next(&mut c).await.expect("term.lost 가 오지 않았다") {
            Frame::Text(v) if v["t"] == "term.lost" => {
                assert_eq!(v["sid"], 1);
                break;
            }
            _ => continue,
        }
    }
}
