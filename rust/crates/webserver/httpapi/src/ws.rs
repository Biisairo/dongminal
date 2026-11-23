//! 터미널 WebSocket `/ws` (Go `handlers_ws.go`·`term_resume.go`·`ws_miss.go`·`snapshot_clean.go`·
//! `browser_input.go`). 업그레이드 판정은 gorilla `Upgrader` 와 같다 — 출처 판정은 출처 게이트가
//! 이미 끝냈다 (FR-RQG-11).

use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::Engine;
use dm_shared_dmlog::{errorf, infof, warnf};
use dm_shared_httpresp::{self as httpresp, Response};
use dm_shared_toolhub::{
    self as th, OP_ERROR, OP_EXIT, OP_INPUT, OP_OUTPUT, OP_RESIZE, OP_SEQ, OP_SIZE, OP_TOOL_ID,
    OutChunk, Placement, SafeConn, TermModes,
};
use dm_webserver_apierr as apierr;
use dm_webserver_hub::SeatConn;
use futures_util::StreamExt;
use futures_util::stream::{SplitSink, SplitStream};
use http::{HeaderValue, Method, StatusCode, header};
use hyper_util::rt::TokioIo;
use regex::bytes::Regex;
use tokio::sync::mpsc;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::{Role, WebSocketConfig};
use tokio_util::sync::CancellationToken;

use crate::Server;
use crate::httperr::http_err;
use crate::req::Req;
use crate::toolhub::{ToolError, ToolHub, with_req};

/// 브라우저가 보내는 메시지 하나의 상한이다 (Go `wsReadLimit`).
const WS_READ_LIMIT: usize = 1 << 20;
/// 출력 프레임을 합치는 상한이다 (Go `relayCoalesceMax`).
const RELAY_COALESCE_MAX: usize = 64 << 10;
/// 구독 채널의 크기다.
const OUTPUT_QUEUE: usize = 256;
/// 정렬을 위해 줄 끝을 찾는 범위다 (Go `trsAlignScan`).
pub(crate) const TRS_ALIGN_SCAN: usize = 4 << 10;

/// 같은 없는 도구를 다시 물으면 늦춘다 (Go `MissRepeatWindow`·`MissDelay`).
pub(crate) const MISS_REPEAT_WINDOW: Duration = Duration::from_secs(10);
pub(crate) const MISS_DELAY: Duration = Duration::from_secs(2);
/// 이만큼 거듭되면 연결을 붙잡는다 (Go `MissHoldAfter`·`MissHoldMax`·`MissHoldLimit`).
pub(crate) const MISS_HOLD_AFTER: usize = 5;
pub(crate) const MISS_HOLD_MAX: Duration = Duration::from_secs(10 * 60);
pub(crate) const MISS_HOLD_LIMIT: i64 = 64;

pub(crate) const TERM_RESET: &[u8] = b"\x1b[?9l\x1b[?1000l\x1b[?1001l\x1b[?1002l\x1b[?1003l\x1b[?1004l\x1b[?1005l\x1b[?1006l\x1b[?1015l\x1b[?2004l\x1b[?1049l\x1b[?47l\x1b[?1047l\x1b[?25h\x1b[?12l\x1b[20l";
pub(crate) const TERM_HARD_CLEAR: &[u8] = b"\x1b[?1049l\x1b[H\x1b[2J\x1b[3J";
const TERM_ALT_ON: &[u8] = b"\x1b[?1049h";
const SEQ_FLAG_FULL: u8 = 1 << 0;
const SEQ_FLAG_ALT: u8 = 1 << 1;

const BAD_HANDSHAKE: &str = "websocket: the client is not using the websocket protocol: ";

type Ws = WebSocketStream<TokioIo<hyper::upgrade::Upgraded>>;
type Conn = SafeConn<SplitSink<Ws, Message>>;
type Reader = SplitStream<Ws>;

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

/// Go `parseSince`.
pub(crate) fn parse_since(raw: &str) -> Option<i64> {
    if raw.is_empty() {
        return None;
    }
    raw.parse::<i64>().ok().filter(|v| *v >= 0)
}

fn output_gap(c: &OutChunk, sent: i64) -> bool {
    c.end > 0 && sent >= 0 && c.end - c.data.len() as i64 > sent
}

fn advance_sent(c: &OutChunk, sent: i64) -> i64 {
    c.end.max(sent)
}

pub(crate) fn relay_joinable(c: &OutChunk, sent: i64) -> bool {
    c.size.is_none() && !output_gap(c, sent)
}

/// 없는 도구를 찾는 연결의 기록이다 (Go `missTracker`).
#[derive(Default)]
pub(crate) struct MissTracker {
    m: Mutex<(HashMap<String, Instant>, HashMap<String, usize>)>,
}

impl MissTracker {
    fn prune(st: &mut (HashMap<String, Instant>, HashMap<String, usize>), now: Instant) {
        let old: Vec<String> =
            st.0.iter()
                .filter(|(_, t)| now.duration_since(**t) > MISS_REPEAT_WINDOW)
                .map(|(k, _)| k.clone())
                .collect();
        for k in old {
            st.0.remove(&k);
            st.1.remove(&k);
        }
    }

    pub(crate) fn repeat(&self, id: &str, now: Instant) -> bool {
        let mut st = self.m.lock().unwrap_or_else(|e| e.into_inner());
        let prev = st.0.get(id).copied();
        Self::prune(&mut st, now);
        st.0.insert(id.to_owned(), now);
        prev.is_some_and(|p| now.duration_since(p) <= MISS_REPEAT_WINDOW)
    }

    pub(crate) fn count(&self, id: &str, now: Instant) -> usize {
        let mut st = self.m.lock().unwrap_or_else(|e| e.into_inner());
        let fresh =
            st.0.get(id)
                .is_some_and(|p| now.duration_since(*p) <= MISS_REPEAT_WINDOW);
        Self::prune(&mut st, now);
        let n = if fresh {
            st.1.get(id).copied().unwrap_or(0) + 1
        } else {
            1
        };
        st.0.insert(id.to_owned(), now);
        st.1.insert(id.to_owned(), n);
        n
    }

    #[allow(dead_code)] // /api/diag(5.5.8) 가 읽는다.
    pub(crate) fn size(&self) -> usize {
        self.m.lock().unwrap_or_else(|e| e.into_inner()).0.len()
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

fn unix_nanos() -> i64 {
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

    /// GET /ws?tool=&cols=&rows=&since=.
    pub(crate) async fn handle_ws(&self, r: &mut Req) -> Response {
        let Some(hub) = self.deps.tools.clone() else {
            return http_err(
                "tools unavailable",
                StatusCode::INTERNAL_SERVER_ERROR,
                apierr::CODE_TOOLS_UNREADY,
            );
        };
        let key = match check_handshake(r) {
            Ok(k) => k,
            Err((status, why)) => {
                infof!(None, "ws upgrade addr={}: {why}", r.remote_addr);
                return handshake_error(status);
            }
        };
        let Some(on_upgrade) = r.extensions.remove::<hyper::upgrade::OnUpgrade>() else {
            infof!(
                None,
                "ws upgrade addr={}: websocket: response does not implement http.Hijacker",
                r.remote_addr
            );
            return http_err(
                "Internal Server Error",
                StatusCode::INTERNAL_SERVER_ERROR,
                apierr::CODE_INTERNAL,
            );
        };
        let Some(me) = self.arc() else {
            return http_err(
                "internal error",
                StatusCode::INTERNAL_SERVER_ERROR,
                apierr::CODE_INTERNAL,
            );
        };
        let q = r.query();
        let session = WsSession {
            tool_id: q.get_or_empty("tool"),
            cols: q.get("cols"),
            rows: q.get("rows"),
            since: parse_since(&q.get_or_empty("since")),
            remote: r.remote_addr.clone(),
            rid: r.rid().map(str::to_owned),
        };
        tokio::spawn(async move {
            let upgraded = match on_upgrade.await {
                Ok(u) => u,
                Err(e) => {
                    infof!(None, "ws upgrade addr={}: {e}", session.remote);
                    return;
                }
            };
            let cfg = WebSocketConfig::default()
                .max_message_size(Some(WS_READ_LIMIT))
                .max_frame_size(Some(WS_READ_LIMIT));
            let ws =
                WebSocketStream::from_raw_socket(TokioIo::new(upgraded), Role::Server, Some(cfg))
                    .await;
            let (sink, reader) = ws.split();
            let conn = Arc::new(SafeConn::new(sink, session.remote.clone()));
            me.conn.ws_open.fetch_add(1, Ordering::SeqCst);
            me.ws_session(hub, conn.clone(), reader, session).await;
            conn.close().await;
            me.conn.ws_open.fetch_sub(1, Ordering::SeqCst);
        });
        let mut res = http::Response::new(httpresp::empty());
        *res.status_mut() = StatusCode::SWITCHING_PROTOCOLS;
        let h = res.headers_mut();
        h.insert(header::UPGRADE, HeaderValue::from_static("websocket"));
        h.insert(header::CONNECTION, HeaderValue::from_static("Upgrade"));
        let accept = tokio_tungstenite::tungstenite::handshake::derive_accept_key(key.as_bytes());
        if let Ok(v) = HeaderValue::from_str(&accept) {
            h.insert(header::SEC_WEBSOCKET_ACCEPT, v);
        }
        res
    }

    async fn ws_session(
        self: &Arc<Self>,
        hub: Arc<dyn ToolHub>,
        conn: Arc<Conn>,
        mut reader: Reader,
        s: WsSession,
    ) {
        let mut tool_id = s.tool_id.clone();
        self.conn.last_ws.store(unix_nanos(), Ordering::Relaxed);
        infof!(None, "ws connected addr={} tool={tool_id}", s.remote);
        let (cols, rows) = th::parse_size(s.cols.as_deref(), s.rows.as_deref());
        let snap_judges = hub.has_feature(dm_shared_toolipc::FEATURE_SNAPSHOT_NOT_FOUND);
        if !tool_id.is_empty() && !snap_judges {
            let (h, id) = (hub.clone(), tool_id.clone());
            let found = tokio::task::spawn_blocking(move || h.get(&id))
                .await
                .ok()
                .flatten();
            if found.is_none() {
                if !hub.connected() {
                    warnf!(
                        None,
                        "ws addr={}: tool {tool_id} lookup during daemon reconnect; closing for retry",
                        s.remote
                    );
                    return;
                }
                self.ws_tool_gone(&conn, &mut reader, &tool_id, &s.remote)
                    .await;
                return;
            }
        } else if tool_id.is_empty() {
            let h = with_req(hub.clone(), s.rid.as_deref());
            let created = tokio::task::spawn_blocking(move || {
                h.create("", cols, rows, &Placement::default())
            })
            .await
            .unwrap_or_else(|e| Err(ToolError::Other(e.to_string())));
            match created {
                Ok(t) => tool_id = t.id,
                Err(e) => {
                    let _ = conn
                        .send(
                            OP_ERROR,
                            format!("도구를 만들지 못했습니다: {e}").as_bytes(),
                        )
                        .await;
                    errorf!(None, "ws addr={}: tool create error: {e}", s.remote);
                    return;
                }
            }
        }
        let since = s.since.unwrap_or(-1);
        self.ws_daemon(hub, conn, reader, &tool_id, since, &s.remote)
            .await;
    }

    async fn ws_tool_gone(
        &self,
        conn: &Arc<Conn>,
        reader: &mut Reader,
        tool_id: &str,
        remote: &str,
    ) {
        if self.conn.misses.repeat(tool_id, Instant::now()) {
            tokio::time::sleep(MISS_DELAY).await;
        }
        let _ = conn.send(OP_EXIT, &[]).await;
        infof!(
            None,
            "ws addr={remote}: tool {tool_id} not found (sent toolhub.OpExit)"
        );
        self.hold_miss(tool_id, reader).await;
    }

    /// Go `holdMiss`: 같은 없는 도구를 거듭 묻는 연결은 붙잡아 재접속 폭주를 막는다.
    async fn hold_miss(&self, tool_id: &str, reader: &mut Reader) -> bool {
        if self.conn.misses.count(tool_id, Instant::now()) < MISS_HOLD_AFTER {
            return false;
        }
        if self.conn.holds.fetch_add(1, Ordering::SeqCst) + 1 > MISS_HOLD_LIMIT {
            self.conn.holds.fetch_sub(1, Ordering::SeqCst);
            return false;
        }
        infof!(
            None,
            "ws hold tool={tool_id} held={}",
            self.conn.holds.load(Ordering::SeqCst)
        );
        let gone = async { while let Some(Ok(_)) = reader.next().await {} };
        let _ = tokio::time::timeout(MISS_HOLD_MAX, gone).await;
        infof!(
            None,
            "ws hold released tool={tool_id} held={}",
            self.conn.holds.load(Ordering::SeqCst) - 1
        );
        self.conn.holds.fetch_sub(1, Ordering::SeqCst);
        true
    }

    async fn ws_daemon(
        self: &Arc<Self>,
        hub: Arc<dyn ToolHub>,
        conn: Arc<Conn>,
        mut reader: Reader,
        tool_id: &str,
        since: i64,
        remote: &str,
    ) {
        let (tx, rx) = mpsc::channel::<OutChunk>(OUTPUT_QUEUE);
        let (exit, unsub) = hub.subscribe(tool_id, tx);
        let (h, id) = (hub.clone(), tool_id.to_owned());
        let snap = tokio::task::spawn_blocking(move || h.snapshot_tool_since(&id, since))
            .await
            .unwrap_or_else(|e| Err(ToolError::Other(e.to_string())));
        let snap = match snap {
            Ok(s) => s,
            Err(ToolError::NotFound(_)) => {
                unsub();
                self.ws_tool_gone(&conn, &mut reader, tool_id, remote).await;
                return;
            }
            Err(e) => {
                unsub();
                errorf!(None, "[tool {tool_id}] snapshot error: {e}");
                return;
            }
        };
        let _ = conn.send(OP_TOOL_ID, tool_id.as_bytes()).await;
        let full = !snap.resumed;
        infof!(
            None,
            "[ws-daemon] replay tool={tool_id} len={} end={} full={full} since={since}",
            snap.data.len(),
            snap.end
        );
        if snap.cols != 0 && snap.rows != 0 {
            let _ = conn
                .send(OP_SIZE, &th::size_payload(snap.cols, snap.rows))
                .await;
        }
        let seat: Arc<dyn SeatConn> = conn.clone();
        self.seats.join(tool_id, seat.clone()).await;
        let ok = self
            .ws_replay(&conn, tool_id, &snap.data, full, &snap.modes, snap.end)
            .await;
        if ok {
            let done = CancellationToken::new();
            let relay = tokio::spawn(relay_output(
                conn.clone(),
                tool_id.to_owned(),
                rx,
                exit,
                done.clone(),
                snap.end,
            ));
            let ping = tokio::spawn(ping_loop(conn.clone(), done.clone()));
            let me = Arc::clone(self);
            let (h1, h2, id) = (hub.clone(), hub.clone(), tool_id.to_owned());
            ws_read_loop(
                &mut reader,
                tool_id,
                remote,
                &done,
                |b| {
                    me.browser_in.mark(&id);
                    h1.input_notify(&id, b);
                },
                |c, r| h2.resize_notify(tool_id, c, r),
            )
            .await;
            done.cancel();
            let _ = relay.await;
            let _ = ping.await;
        }
        self.seats.leave(tool_id, &seat).await;
        unsub();
    }

    async fn ws_replay(
        &self,
        conn: &Conn,
        tool_id: &str,
        data: &[u8],
        full: bool,
        modes: &TermModes,
        end: i64,
    ) -> bool {
        let payload = build_replay(data, full, modes.alt_screen);
        if !payload.is_empty()
            && let Err(e) = conn.send(OP_OUTPUT, &payload).await
        {
            errorf!(None, "[tool {tool_id}] replay send error: {e}");
            return false;
        }
        let restore = modes.restore_bytes();
        if !restore.is_empty()
            && let Err(e) = conn.send(OP_OUTPUT, &restore).await
        {
            errorf!(None, "[tool {tool_id}] mode restore send error: {e}");
            return false;
        }
        if let Err(e) = conn
            .send(OP_SEQ, &seq_payload(end, full, modes.alt_screen))
            .await
        {
            errorf!(None, "[tool {tool_id}] seq send error: {e}");
            return false;
        }
        true
    }
}

struct WsSession {
    tool_id: String,
    cols: Option<String>,
    rows: Option<String>,
    since: Option<i64>,
    remote: String,
    rid: Option<String>,
}

/// Go `wsReadLoop`: 입력·크기 조정 프레임을 읽는다. 핑의 답(퐁)이 늦으면 끊는다.
async fn ws_read_loop(
    reader: &mut Reader,
    tool_id: &str,
    remote: &str,
    done: &CancellationToken,
    mut input: impl FnMut(&[u8]),
    mut resize: impl FnMut(u16, u16),
) {
    let mut deadline = tokio::time::Instant::now() + th::PONG_WAIT;
    loop {
        let msg = tokio::select! {
            _ = done.cancelled() => return,
            r = tokio::time::timeout_at(deadline, reader.next()) => r,
        };
        let msg = match msg {
            Err(_) => {
                errorf!(
                    None,
                    "[tool {tool_id}] readWS error addr={remote}: i/o timeout"
                );
                return;
            }
            Ok(None) => return,
            Ok(Some(Err(e))) => {
                use tokio_tungstenite::tungstenite::Error as E;
                if !matches!(e, E::ConnectionClosed | E::AlreadyClosed | E::Io(_))
                    && !matches!(
                        e,
                        E::Protocol(
                            tokio_tungstenite::tungstenite::error::ProtocolError::ResetWithoutClosingHandshake
                        )
                    )
                {
                    errorf!(None, "[tool {tool_id}] readWS error addr={remote}: {e}");
                }
                return;
            }
            Ok(Some(Ok(m))) => m,
        };
        let data = match msg {
            Message::Pong(_) => {
                deadline = tokio::time::Instant::now() + th::PONG_WAIT;
                continue;
            }
            Message::Close(f) => {
                if let Some(f) = f {
                    let code = u16::from(f.code);
                    if !matches!(code, 1000 | 1001 | 1005) {
                        errorf!(
                            None,
                            "[tool {tool_id}] readWS error addr={remote}: websocket: close {code} {}",
                            f.reason
                        );
                    }
                }
                return;
            }
            Message::Binary(b) => b.to_vec(),
            Message::Text(t) => t.as_bytes().to_vec(),
            _ => continue,
        };
        match data.first() {
            Some(&OP_INPUT) => input(&data[1..]),
            Some(&OP_RESIZE) if data.len() >= 5 => resize(
                u16::from_be_bytes([data[1], data[2]]),
                u16::from_be_bytes([data[3], data[4]]),
            ),
            _ => {}
        }
    }
}

/// Go `relayOutput`: 도구 출력을 이어 붙여 보낸다. 틈이 생기거나 구독이 끊기면 연결을 닫아
/// 브라우저가 since 로 재동기하게 한다.
async fn relay_output(
    conn: Arc<Conn>,
    tool_id: String,
    mut rx: mpsc::Receiver<OutChunk>,
    exit: CancellationToken,
    done: CancellationToken,
    mut sent: i64,
) {
    let mut pending: Option<OutChunk> = None;
    let mut pending_closed = false;
    loop {
        let chunk = if pending_closed {
            None
        } else if let Some(p) = pending.take() {
            Some(p)
        } else {
            tokio::select! {
                c = rx.recv() => c,
                _ = exit.cancelled() => {
                    let _ = conn.send(OP_EXIT, &[]).await;
                    conn.close().await;
                    done.cancel();
                    return;
                }
                _ = done.cancelled() => return,
            }
        };
        let Some(chunk) = chunk else {
            infof!(
                None,
                "[tool {tool_id}] relay resync addr={}",
                conn.remote_addr()
            );
            conn.close().await;
            done.cancel();
            return;
        };
        if let Some(sz) = chunk.size {
            if let Err(e) = conn
                .send(OP_SIZE, &th::size_payload(sz.cols, sz.rows))
                .await
            {
                relay_fail(&conn, &tool_id, "size", &e, &done).await;
                return;
            }
            continue;
        }
        if output_gap(&chunk, sent) {
            warnf!(
                None,
                "[tool {tool_id}] output gap sent={sent} start={} addr={} — resync",
                chunk.end - chunk.data.len() as i64,
                conn.remote_addr()
            );
            conn.close().await;
            done.cancel();
            return;
        }
        let mut frame = trim_overlap(&chunk.data, chunk.end, sent).to_vec();
        sent = advance_sent(&chunk, sent);
        loop {
            match rx.try_recv() {
                Ok(next) => {
                    if !relay_joinable(&next, sent) {
                        pending = Some(next);
                        break;
                    }
                    let d = trim_overlap(&next.data, next.end, sent);
                    if frame.len() + d.len() > RELAY_COALESCE_MAX {
                        pending = Some(next);
                        break;
                    }
                    frame.extend_from_slice(d);
                    sent = advance_sent(&next, sent);
                }
                Err(mpsc::error::TryRecvError::Disconnected) => {
                    pending_closed = true;
                    break;
                }
                Err(mpsc::error::TryRecvError::Empty) => break,
            }
        }
        if frame.is_empty() {
            continue;
        }
        if let Err(e) = conn.send(OP_OUTPUT, &frame).await {
            relay_fail(&conn, &tool_id, "output", &e, &done).await;
            return;
        }
    }
}

async fn relay_fail(
    conn: &Conn,
    tool_id: &str,
    what: &str,
    e: &(dyn std::fmt::Display + Sync),
    done: &CancellationToken,
) {
    infof!(
        None,
        "[tool {tool_id}] {what} relay stopped addr={}: {e}",
        conn.remote_addr()
    );
    conn.close().await;
    done.cancel();
}

/// Go `pingLoop`.
async fn ping_loop(conn: Arc<Conn>, done: CancellationToken) {
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
