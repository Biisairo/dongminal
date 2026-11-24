//! 터미널 재생·중계의 순수 함수와 WebSocket 업그레이드 판정 (Go `handlers_ws.go`·`term_resume.go`·
//! `ws_miss.go`·`snapshot_clean.go`·`browser_input.go` 에서 남은 것). 터미널 세션은 채널이 갖는다
//! (`channel/term.rs`, PERF_OPTIMIZATION_SRS M1 C5). 업그레이드 판정은 gorilla `Upgrader` 와 같다 —
//! 출처 판정은 출처 게이트가 이미 끝냈다 (FR-RQG-11).

use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::Engine;
use futures_util::stream::{SplitSink, SplitStream};
use http::{HeaderValue, Method, StatusCode};
use hyper_util::rt::TokioIo;
use otter_shared_httpresp::{self as httpresp, Response};
use otter_shared_otterlog::errorf;
use otter_shared_toolhub::{self as th, OutChunk, SafeConn};
use regex::bytes::Regex;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_util::sync::CancellationToken;

use crate::Server;
use crate::req::Req;

/// 정렬을 위해 줄 끝을 찾는 범위다 (Go `trsAlignScan`).
pub(crate) const TRS_ALIGN_SCAN: usize = 4 << 10;

/// 같은 없는 도구를 다시 물으면 늦춘다 (Go `MissRepeatWindow`·`MissDelay`).
pub(crate) const MISS_REPEAT_WINDOW: Duration = Duration::from_secs(10);
pub(crate) const MISS_DELAY: Duration = Duration::from_secs(2);

pub(crate) const TERM_RESET: &[u8] = b"\x1b[?9l\x1b[?1000l\x1b[?1001l\x1b[?1002l\x1b[?1003l\x1b[?1004l\x1b[?1005l\x1b[?1006l\x1b[?1015l\x1b[?2004l\x1b[?1049l\x1b[?47l\x1b[?1047l\x1b[?25h\x1b[?12l\x1b[20l";
pub(crate) const TERM_HARD_CLEAR: &[u8] = b"\x1b[?1049l\x1b[H\x1b[2J\x1b[3J";
const TERM_ALT_ON: &[u8] = b"\x1b[?1049h";
const SEQ_FLAG_FULL: u8 = 1 << 0;
const SEQ_FLAG_ALT: u8 = 1 << 1;

const BAD_HANDSHAKE: &str = "websocket: the client is not using the websocket protocol: ";

pub(crate) type Ws = WebSocketStream<TokioIo<hyper::upgrade::Upgraded>>;
pub(crate) type Conn = SafeConn<SplitSink<Ws, Message>>;
pub(crate) type Reader = SplitStream<Ws>;

static OSC777: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?-u)\x1b\]777;[^\x07]*\x07").unwrap_or_else(|e| unreachable!("{e}"))
});
static SNAPSHOT_QUERY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(concat!(
        r"(?-u)\x1b\[[?>=]?[0-9;]*[cnR]",
        r"|\x1b\[[?>=]?[0-9;]*\$p",
        r"|\x1b\](?:4|5|1[0-9])(?:;[^;\x07\x1b]*)*;\?(?:\x07|\x1b\\)",
        r"|\x1bP\$q[^\x1b]*\x1b\\"
    ))
    .unwrap_or_else(|e| unreachable!("{e}"))
});

/// Go `stripOSC777`: 알림 OSC 는 재생하지 않는다.
pub(crate) fn strip_osc777(b: &[u8]) -> Vec<u8> {
    OSC777.replace_all(b, &b""[..]).into_owned()
}

/// Go `stripSnapshotQueries`: 재생 중 터미널이 답할 질의를 지운다.
pub(crate) fn strip_snapshot_queries(b: &[u8]) -> Vec<u8> {
    SNAPSHOT_QUERY.replace_all(b, &b""[..]).into_owned()
}

pub(crate) fn align_head(b: &[u8]) -> &[u8] {
    let scan = b.len().min(TRS_ALIGN_SCAN);
    match b[..scan].iter().position(|&c| c == b'\n') {
        Some(i) => &b[i + 1..],
        None => b,
    }
}

/// Go `buildReplay`: 전량 재생이면 터미널을 초기화하고 첫 줄 끝까지 버린다.
pub(crate) fn build_replay(data: &[u8], full: bool, alt: bool) -> Vec<u8> {
    let body = strip_snapshot_queries(&strip_osc777(data));
    if !full {
        return body;
    }
    let body = align_head(&body);
    let mut out = Vec::with_capacity(TERM_RESET.len() + TERM_HARD_CLEAR.len() + 8 + body.len());
    out.extend_from_slice(TERM_RESET);
    out.extend_from_slice(TERM_HARD_CLEAR);
    if th::alt_screen_at_head(body, alt) {
        out.extend_from_slice(TERM_ALT_ON);
    }
    out.extend_from_slice(body);
    out
}

/// Go `seqPayload`: 8바이트 오프셋(빅엔디언) + 깃발.
pub(crate) fn seq_payload(offset: i64, full: bool, alt: bool) -> [u8; 9] {
    let mut p = [0u8; 9];
    p[..8].copy_from_slice(&offset.to_be_bytes());
    if full {
        p[8] |= SEQ_FLAG_FULL;
    }
    if alt {
        p[8] |= SEQ_FLAG_ALT;
    }
    p
}

/// Go `trimOverlap`: 이미 보낸 부분을 잘라낸다.
pub(crate) fn trim_overlap(chunk: &[u8], end: i64, offset: i64) -> &[u8] {
    if end <= 0 || offset < 0 {
        return chunk;
    }
    let start = end - chunk.len() as i64;
    if offset <= start {
        return chunk;
    }
    if offset >= end {
        return &[];
    }
    &chunk[usize::try_from(offset - start).unwrap_or(chunk.len())..]
}

fn output_gap(c: &OutChunk, sent: i64) -> bool {
    c.end > 0 && sent >= 0 && c.end - c.data.len() as i64 > sent
}

pub(crate) fn relay_joinable(c: &OutChunk, sent: i64) -> bool {
    c.size.is_none() && !output_gap(c, sent)
}

/// 없는 도구를 찾는 연결의 기록이다 (Go `missTracker`).
#[derive(Default)]
pub(crate) struct MissTracker {
    m: Mutex<HashMap<String, Instant>>,
}

impl MissTracker {
    pub(crate) fn repeat(&self, id: &str, now: Instant) -> bool {
        let mut st = self.m.lock().unwrap_or_else(|e| e.into_inner());
        let prev = st.get(id).copied();
        st.retain(|_, t| now.duration_since(*t) <= MISS_REPEAT_WINDOW);
        st.insert(id.to_owned(), now);
        prev.is_some_and(|p| now.duration_since(p) <= MISS_REPEAT_WINDOW)
    }

    #[allow(dead_code)] // /api/diag(5.5.8) 가 읽는다.
    pub(crate) fn size(&self) -> usize {
        self.m.lock().unwrap_or_else(|e| e.into_inner()).len()
    }
}

/// 브라우저 입력 시각이다 (Go `browserInputs`, FR-TGB-57).
#[derive(Default)]
pub(crate) struct BrowserInputs(Mutex<HashMap<String, SystemTime>>);

impl BrowserInputs {
    pub(crate) fn mark(&self, id: &str) {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id.to_owned(), SystemTime::now());
    }

    pub(crate) fn last(&self, id: &str) -> Option<SystemTime> {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(id)
            .copied()
    }
}

/// gorilla `tokenListContainsValue`.
fn token_list_contains(headers: &http::HeaderMap, name: &str, value: &str) -> bool {
    headers.get_all(name).iter().any(|v| {
        String::from_utf8_lossy(v.as_bytes())
            .split(',')
            .any(|t| t.trim().eq_ignore_ascii_case(value))
    })
}

/// gorilla `Upgrader.Upgrade` 의 판정. 실패면 (상태, 사유).
pub(crate) fn check_handshake(r: &Req) -> Result<String, (StatusCode, String)> {
    if !token_list_contains(&r.headers, "Connection", "upgrade") {
        return Err((
            StatusCode::BAD_REQUEST,
            format!("{BAD_HANDSHAKE}'upgrade' token not found in 'Connection' header"),
        ));
    }
    if !token_list_contains(&r.headers, "Upgrade", "websocket") {
        return Err((
            StatusCode::BAD_REQUEST,
            format!("{BAD_HANDSHAKE}'websocket' token not found in 'Upgrade' header"),
        ));
    }
    if r.method != Method::GET {
        return Err((
            StatusCode::METHOD_NOT_ALLOWED,
            format!("{BAD_HANDSHAKE}request method is not GET"),
        ));
    }
    if !token_list_contains(&r.headers, "Sec-Websocket-Version", "13") {
        return Err((
            StatusCode::BAD_REQUEST,
            "websocket: unsupported version: 13 not found in 'Sec-Websocket-Version' header"
                .to_owned(),
        ));
    }
    let key = r.header("Sec-Websocket-Key");
    let valid = !key.is_empty()
        && base64::engine::general_purpose::STANDARD
            .decode(key.as_bytes())
            .is_ok_and(|b| b.len() == 16);
    if !valid {
        return Err((
            StatusCode::BAD_REQUEST,
            "websocket: not a websocket handshake: 'Sec-WebSocket-Key' header must be Base64 encoded value of 16-byte in length".to_owned(),
        ));
    }
    Ok(key)
}

/// gorilla `returnError`: 평문 상태 문구와 `Sec-Websocket-Version`.
pub(crate) fn handshake_error(status: StatusCode) -> Response {
    let mut res = httpresp::status_error(status);
    res.headers_mut()
        .insert("Sec-Websocket-Version", HeaderValue::from_static("13"));
    res
}

pub(crate) fn unix_nanos() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| i64::try_from(d.as_nanos()).unwrap_or(i64::MAX))
        .unwrap_or_default()
}

impl Server {
    /// Go `LastBrowserInput`.
    pub fn last_browser_input(&self, tool_id: &str) -> Option<SystemTime> {
        self.browser_in.last(tool_id)
    }
}

/// Go `pingLoop`.
pub(crate) async fn ping_loop(conn: Arc<Conn>, done: CancellationToken) {
    let mut t = tokio::time::interval_at(
        tokio::time::Instant::now() + th::PING_PERIOD,
        th::PING_PERIOD,
    );
    loop {
        tokio::select! {
            _ = done.cancelled() => return,
            _ = t.tick() => {
                if let Err(e) = conn.write_ping().await {
                    errorf!(None, "pingLoop error addr={}: {e}", conn.remote_addr());
                    return;
                }
            }
        }
    }
}
