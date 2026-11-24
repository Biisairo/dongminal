//! 터미널 재생·중계의 순수 함수와 WebSocket 업그레이드 판정 (Go `handlers_ws.go`·`term_resume.go`·
//! `ws_miss.go`·`snapshot_clean.go`·`browser_input.go` 에서 남은 것). 터미널 세션은 채널이 갖는다
//! (`channel/term.rs`, PERF_OPTIMIZATION_SRS M1 C5). 업그레이드 판정은 gorilla `Upgrader` 와 같다 —
//! 출처 판정은 출처 게이트가 이미 끝냈다 (FR-RQG-11).

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::Engine;
use http::{HeaderValue, Method, StatusCode, header};
use hyper_util::rt::TokioIo;
use otter_shared_httpresp::{self as httpresp, Response};
use otter_shared_toolhub::{OutChunk, ToolScreen};
use regex::bytes::Regex;
use sockudo_ws::deflate::{DeflateNegotiation, DeflateWindowBits, negotiate_server_deflate};
use sockudo_ws::stream::{CompressedSplitReader, CompressedSplitWriter, CompressedWebSocketStream};
use sockudo_ws::{Config as WsConfig, DeflateConfig};

use crate::Server;
use crate::req::Req;

/// 같은 없는 도구를 다시 물으면 늦춘다 (Go `MissRepeatWindow`·`MissDelay`).
pub(crate) const MISS_REPEAT_WINDOW: Duration = Duration::from_secs(10);
pub(crate) const MISS_DELAY: Duration = Duration::from_secs(2);

const SEQ_FLAG_FULL: u8 = 1 << 0;
const SEQ_FLAG_ALT: u8 = 1 << 1;
/// 앞의 `OUTPUT` 이 화면 상태 스냅숏이다 (PERF D-19). FULL 과 함께 선다.
const SEQ_FLAG_SNAP: u8 = 1 << 2;

const BAD_HANDSHAKE: &str = "websocket: the client is not using the websocket protocol: ";

pub(crate) type WsIo = TokioIo<hyper::upgrade::Upgraded>;
pub(crate) type WsReader = CompressedSplitReader<WsIo>;
pub(crate) type WsWriter = CompressedSplitWriter<WsIo>;

/// 서버 압축기의 창 크기다. 15 → 13 비트로 연결당 압축기 메모리가 338 → 242 KB 로 줄고 압축 후
/// 크기는 TUI 출력 +9%·줄 출력 +5% 다 (`perf/COMPRESSION_2026-11-24.md` §9).
const DEFLATE_SERVER_WINDOW: DeflateWindowBits = DeflateWindowBits::Bits13;
/// 압축 단계다 (zlib 기본, §8).
const DEFLATE_LEVEL: u32 = 6;
const NO_DEFLATE: &str = "websocket: permessage-deflate offer required";

/// 업그레이드를 받아들인 WebSocket 하나 — 압축이 협상됐다 (PERF_OPTIMIZATION_SRS D-12).
pub(crate) struct WsAccept {
    key: String,
    neg: DeflateNegotiation,
}

/// 업그레이드 판정 + permessage-deflate 협상. 압축을 제안하지 않는 연결은 400 이다 — 모든 연결을
/// 압축하므로 스트림 종류가 하나다 (D-12).
pub(crate) fn ws_accept(r: &Req) -> Result<WsAccept, (StatusCode, String)> {
    let key = check_handshake(r)?;
    let policy = DeflateConfig {
        server_max_window_bits: DEFLATE_SERVER_WINDOW,
        compression_level: DEFLATE_LEVEL,
        compression_threshold: 0,
        ..DeflateConfig::default()
    };
    let offers = r.header("Sec-Websocket-Extensions");
    match negotiate_server_deflate(&offers, &policy) {
        Some(neg) => Ok(WsAccept { key, neg }),
        None => Err((StatusCode::BAD_REQUEST, NO_DEFLATE.to_owned())),
    }
}

impl WsAccept {
    /// 101 응답이다.
    pub(crate) fn response(&self) -> Response {
        let mut res = http::Response::new(httpresp::empty());
        *res.status_mut() = StatusCode::SWITCHING_PROTOCOLS;
        let h = res.headers_mut();
        h.insert(header::UPGRADE, HeaderValue::from_static("websocket"));
        h.insert(header::CONNECTION, HeaderValue::from_static("Upgrade"));
        let accept = sockudo_ws::handshake::generate_accept_key(&self.key);
        if let Ok(v) = HeaderValue::from_str(&accept) {
            h.insert(header::SEC_WEBSOCKET_ACCEPT, v);
        }
        if let Ok(v) = HeaderValue::from_str(&self.neg.to_response_header()) {
            h.insert(header::SEC_WEBSOCKET_EXTENSIONS, v);
        }
        res
    }

    /// 업그레이드된 소켓을 압축 스트림으로 세워 읽기·쓰기 반쪽으로 나눈다. 생존 확인(핑·퐁·
    /// 무응답 마감)은 라이브러리의 쓰기 구동기가 한다.
    pub(crate) fn open(
        self,
        up: hyper::upgrade::Upgraded,
        max_message: usize,
    ) -> (WsReader, WsWriter) {
        let cfg = WsConfig {
            max_message_size: max_message,
            max_frame_size: max_message,
            ..WsConfig::default()
        };
        CompressedWebSocketStream::server(TokioIo::new(up), cfg, self.neg.config).split()
    }
}

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

/// 링에서 이어 붙이는 바이트 — 알림 OSC 와 시작 질의를 뺀다.
pub(crate) fn replay_delta(data: &[u8]) -> Vec<u8> {
    strip_snapshot_queries(&strip_osc777(data))
}

/// Go `seqPayload`: 8바이트 오프셋(빅엔디언) + 깃발. 링에서 이어 붙인 뒤의 좌표다.
pub(crate) fn seq_payload(offset: i64, alt: bool) -> [u8; 9] {
    let mut p = [0u8; 9];
    p[..8].copy_from_slice(&offset.to_be_bytes());
    if alt {
        p[8] |= SEQ_FLAG_ALT;
    }
    p
}

/// 스냅숏 뒤의 좌표 (PERF D-19): `seq_payload` + FULL·SNAP 깃발 + 첫 기록 줄 번호(u64 BE) + cwd(UTF-8).
pub(crate) fn snap_seq_payload(s: &ToolScreen) -> Vec<u8> {
    let mut p = seq_payload(s.end, s.alt).to_vec();
    p[8] |= SEQ_FLAG_FULL | SEQ_FLAG_SNAP;
    p.extend_from_slice(&s.first_line.to_be_bytes());
    p.extend_from_slice(s.cwd.as_bytes());
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
