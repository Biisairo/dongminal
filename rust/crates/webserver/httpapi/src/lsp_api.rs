//! `/api/lsp/*` (Go `handlers_lsp.go`·`handlers_lsp_ws.go`, EDITOR_LSP_SRS §3.1·CODEMIRROR_MIGRATION_SRS
//! §3.11). 여기에는 LSP 가 없다 — 요청을 [`LspService`](crate::LspService) 로 옮기고, WS 메시지를
//! 통로와 잇는다 (D-4).

use std::collections::HashMap;
use std::sync::Arc;

use http::StatusCode;
use otter_gocompat::json;
use otter_shared_httpreq::{self as httpreq, ReadError};
use otter_shared_httpresp::Response;
use otter_shared_otterlog::{errorf, infof};
use otter_webserver_apierr as apierr;
use otter_webserver_domain_ext as ext;
use otter_webserver_domain_lsp::{OpenError, PathsError, Tunnel};
use serde::{Deserialize, Serialize};
use sockudo_ws::Message;
use tokio::sync::Mutex as AsyncMutex;

use crate::Server;
use crate::httperr::{write_json, write_tool_io_error, write_tool_io_error_code};
use crate::req::Req;
use crate::tools_api::off_thread;
use crate::ws::{WsReader, WsWriter, handshake_error, ws_accept};

/// Go `lspMaxBody`: 상태·설치 요청 본문의 상한이다.
const LSP_MAX_BODY: i64 = httpreq::SMALL_LIMIT;

/// close code (FR-CMR-102·103). 브라우저(`lsp-client.js`)가 같은 값을 쓴다.
const LSP_WS_CLOSE_LIMIT: u16 = 4001;
const LSP_WS_CLOSE_START: u16 = 4002;
const LSP_WS_CLOSE_ENDED: u16 = 4003;
/// RFC 6455 §5.5 의 125바이트에서 code 2바이트를 뺀 값이다.
const LSP_WS_REASON_MAX: usize = 123;
/// 브라우저 메시지 하나의 상한이다 (FR-CMR-104) — 텍스트 상한을 JSON 문자열로 실은 최악의 크기다.
pub(crate) const LSP_WS_READ_LIMIT: usize =
    otter_shared_editorlimit::body_max_bytes(otter_webserver_domain_lsp::MAX_TEXT_BYTES) as usize;

/// 상태 응답이다. Go 는 map 이라 키가 이름 순이고, 빈 목록은 nil 이라 `null` 이다.
#[derive(Serialize)]
struct StatusBody {
    #[serde(skip_serializing_if = "Option::is_none")]
    problems: Option<Vec<String>>,
    servers: Option<Vec<ext::Status>>,
}

/// Go `lspInstallReq`: ID 는 **팩**이다 (FR-EXT-31).
#[derive(Deserialize, Default)]
#[serde(default)]
struct InstallReq {
    id: String,
}

/// Go `lspPathsBody`.
#[derive(Serialize, Deserialize, Default)]
#[serde(default)]
struct PathsBody {
    paths: HashMap<String, String>,
}

/// Go `lspReadBody`: 본문을 상한까지 읽고 한 바이트 더 읽어 초과를 가린다 (FR-OPT-1-10). 연결을
/// 닫는 표식은 얹지 않는다 — Go 는 `MaxBytesReader` 를 쓰지 않는다.
async fn lsp_read_body(r: &Req) -> Result<bytes::Bytes, Response> {
    match r.read_body(LSP_MAX_BODY).await {
        Ok(b) => Ok(b),
        Err(ReadError::TooLarge) => Err(write_tool_io_error_code(
            StatusCode::PAYLOAD_TOO_LARGE,
            apierr::CODE_BODY_TOO_BIG,
            "body too large",
        )),
        Err(ReadError::Other(_)) => {
            Err(write_tool_io_error(StatusCode::BAD_REQUEST, "bad request"))
        }
    }
}

/// Go `lspWSReason`: reason 을 control 프레임 한도 안의 온전한 UTF-8 로 자른다.
pub(crate) fn lsp_ws_reason(s: &str) -> &str {
    if s.len() <= LSP_WS_REASON_MAX {
        return s;
    }
    let mut end = LSP_WS_REASON_MAX;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

async fn close_with(sink: &AsyncMutex<WsWriter>, code: u16, reason: &str) {
    let mut s = sink.lock().await;
    let _ = tokio::time::timeout(
        std::time::Duration::from_secs(1),
        s.close(code, lsp_ws_reason(reason)),
    )
    .await;
}

impl Server {
    /// Go `lspReady`: LSP 를 쓰지 않는 서버는 503 이며 그 밖의 동작에는 영향이 없다.
    fn lsp_ready(&self) -> Result<Arc<dyn crate::LspService>, Response> {
        self.deps.lsp.clone().ok_or_else(|| {
            write_tool_io_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "language server support unavailable",
            )
        })
    }

    /// Go `apiLSPStatus`: 서술자마다 한 줄의 관측이다 (FR-LSP-5·46·47). 본문은 읽지 않는다.
    pub(crate) async fn api_lsp_status(&self, _r: &mut Req) -> Response {
        let lsp = match self.lsp_ready() {
            Ok(l) => l,
            Err(res) => return res,
        };
        let (servers, problems) = off_thread(move || lsp.status()).await.unwrap_or_default();
        write_json(&StatusBody {
            problems: (!problems.is_empty()).then_some(problems),
            servers: (!servers.is_empty()).then_some(servers),
        })
    }

    /// Go `apiLSPInstall`: 서술자 하나를 받는다 (FR-LSP-8·10). 실패도 200 이다 — 사유를 실은 결과가
    /// 이 종단의 산출이다.
    pub(crate) async fn api_lsp_install(&self, r: &mut Req) -> Response {
        let lsp = match self.lsp_ready() {
            Ok(l) => l,
            Err(res) => return res,
        };
        let body = match lsp_read_body(r).await {
            Ok(b) => b,
            Err(res) => return res,
        };
        let req = match json::unmarshal::<InstallReq>(&body) {
            Ok(req) if !req.id.is_empty() => req,
            _ => return write_tool_io_error(StatusCode::BAD_REQUEST, "id required"),
        };
        let ctx = ext::Ctx::new(r.ctx.clone());
        write_json(&lsp.install(&ctx, &req.id).await)
    }

    /// Go `apiLSPPathsGet`: 서버가 보관한 실행 파일 경로 표다 — 없으면 빈 객체다.
    pub(crate) async fn api_lsp_paths_get(&self, _r: &mut Req) -> Response {
        let lsp = match self.lsp_ready() {
            Ok(l) => l,
            Err(res) => return res,
        };
        write_json(&PathsBody { paths: lsp.paths() })
    }

    /// Go `apiLSPPathsPut`: 경로 표 전체를 바꾼다. 거부는 코드로 가른다.
    pub(crate) async fn api_lsp_paths_put(&self, r: &mut Req) -> Response {
        let lsp = match self.lsp_ready() {
            Ok(l) => l,
            Err(res) => return res,
        };
        let body = match lsp_read_body(r).await {
            Ok(b) => b,
            Err(res) => return res,
        };
        let Ok(req) = json::unmarshal::<PathsBody>(&body) else {
            return write_tool_io_error_code(
                StatusCode::BAD_REQUEST,
                apierr::CODE_BAD_REQUEST,
                "bad request",
            );
        };
        match off_thread(move || lsp.set_paths(req.paths)).await {
            Some(Ok(paths)) => write_json(&PathsBody { paths }),
            Some(Err(e @ PathsError::NotAbsolute(_))) => write_tool_io_error_code(
                StatusCode::BAD_REQUEST,
                apierr::CODE_ABS_PATH_NEEDED,
                &e.to_string(),
            ),
            Some(Err(e)) => {
                errorf!(None, "[lsp] 경로 표 저장 실패: {e}");
                save_failed()
            }
            None => save_failed(),
        }
    }

    /// Go `apiLSPWS`: `GET /api/lsp/ws?root=<루트>&server=<서술자 id>` (FR-CMR-91·100).
    ///
    /// 루트·서술자가 틀리면 업그레이드 전에 HTTP 로 답한다. 상한·기동 실패는 업그레이드 뒤 close
    /// code 로 알린다 — 브라우저의 WebSocket 은 HTTP 상태를 읽지 못한다.
    pub(crate) async fn api_lsp_ws(&self, r: &mut Req) -> Response {
        let lsp = match self.lsp_ready() {
            Ok(l) => l,
            Err(res) => return res,
        };
        let desc = r.q("server");
        if desc.is_empty() {
            return write_tool_io_error(StatusCode::BAD_REQUEST, "server required");
        }
        let root = match self.fs_root(&r.q("root")) {
            Ok(root) => root,
            Err(res) => return res,
        };
        let accept = match ws_accept(r) {
            Ok(a) => a,
            Err((status, why)) => {
                infof!(None, "lsp ws upgrade addr={}: {why}", r.remote_addr);
                return handshake_error(status);
            }
        };
        let Some(on_upgrade) = r.extensions.remove::<hyper::upgrade::OnUpgrade>() else {
            infof!(
                None,
                "lsp ws upgrade addr={}: websocket: response does not implement http.Hijacker",
                r.remote_addr
            );
            return write_tool_io_error(StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error");
        };
        let read_limit = self.lsp_ws_read_limit;
        let remote = r.remote_addr.clone();
        let res = accept.response();
        tokio::spawn(async move {
            let upgraded = match on_upgrade.await {
                Ok(u) => u,
                Err(e) => {
                    infof!(None, "lsp ws upgrade addr={remote}: {e}");
                    return;
                }
            };
            let (reader, writer) = accept.open(upgraded, read_limit);
            lsp_ws_session(lsp, reader, writer, root, desc).await;
        });
        res
    }
}

fn save_failed() -> Response {
    write_tool_io_error_code(
        StatusCode::INTERNAL_SERVER_ERROR,
        apierr::CODE_SAVE_FAILED,
        "경로 표를 저장하지 못했다",
    )
}

/// 업그레이드 뒤의 통로 한 벌이다.
async fn lsp_ws_session(
    lsp: Arc<dyn crate::LspService>,
    mut reader: WsReader,
    writer: WsWriter,
    root: String,
    desc: String,
) {
    let sink = Arc::new(AsyncMutex::new(writer));
    let opened = off_thread(move || lsp.open_tunnel(&root, &desc)).await;
    let t: Arc<dyn Tunnel> = match opened {
        Some(Ok(t)) => t,
        Some(Err(OpenError::Limit)) => {
            close_with(&sink, LSP_WS_CLOSE_LIMIT, "limit").await;
            return;
        }
        Some(Err(e)) => {
            close_with(&sink, LSP_WS_CLOSE_START, &e.to_string()).await;
            return;
        }
        None => return,
    };
    // 서버 → 브라우저. 프로세스가 끝나면 close 를 보내고 연결을 끊어 읽기 쪽을 깨운다.
    let ended = tokio_util::sync::CancellationToken::new();
    let pump = {
        let (t, sink, ended) = (t.clone(), sink.clone(), ended.clone());
        let (tx, mut rx) = tokio::sync::mpsc::channel::<Option<Vec<u8>>>(16);
        std::thread::spawn(move || {
            loop {
                let got = t.recv().ok();
                let done = got.is_none();
                if tx.blocking_send(got).is_err() || done {
                    return;
                }
            }
        });
        tokio::spawn(async move {
            while let Some(got) = rx.recv().await {
                let Some(b) = got else {
                    close_with(&sink, LSP_WS_CLOSE_ENDED, "ended").await;
                    ended.cancel();
                    return;
                };
                let text = String::from_utf8_lossy(&b).into_owned();
                if sink.lock().await.send(Message::text(text)).await.is_err() {
                    return;
                }
            }
        })
    };
    // 브라우저 → 서버. 연결이 닫히거나 상한을 넘으면 끝나고, 통로를 닫는다.
    loop {
        let msg = tokio::select! {
            _ = ended.cancelled() => break,
            m = reader.next() => m,
        };
        match msg {
            Some(Ok(Message::Text(b))) => {
                let t = t.clone();
                let body = b.to_vec();
                if !matches!(off_thread(move || t.send(&body)).await, Some(Ok(()))) {
                    break;
                }
            }
            Some(Ok(_)) => {}
            // 상한을 넘은 메시지는 라이브러리가 읽기 오류로 끝낸다. 그 뒤로는 쓰기가 막혀 1009 를
            // 보낼 수 없다 — 연결이 닫히고 통로도 닫는다.
            _ => break,
        }
    }
    t.close();
    pump.abort();
}
