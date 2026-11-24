//! 채널 `/channel` — 브라우저 탭 하나의 WebSocket 하나 (PERF_OPTIMIZATION_SRS FR-CON,
//! `docs/internal/perf/CHANNEL_PROTOCOL.md`). C1: 인사·생존 확인·칸 신원 임대.

use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use futures_util::StreamExt;
use http::{HeaderValue, StatusCode, header};
use hyper_util::rt::TokioIo;
use otter_shared_httpresp::{self as httpresp, Response};
use otter_shared_otterlog::infof;
use otter_shared_toolhub::{self as th, SafeConn};
use serde_json::{Value, json};
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::{Role, WebSocketConfig};
use tokio_util::sync::CancellationToken;

use crate::Server;
use crate::httperr::http_err;
use crate::req::Req;
use crate::ws::{Conn, Reader, check_handshake, handshake_error, ping_loop};
use otter_webserver_apierr as apierr;

/// 브라우저가 보내는 메시지 하나의 상한이다 (`/ws` 의 `WS_READ_LIMIT` 와 같다).
const CHANNEL_READ_LIMIT: usize = 1 << 20;
/// 첫 `hello` 를 기다리는 시간이다 (TC-CH1-2).
const HELLO_WAIT: Duration = Duration::from_secs(10);

/// 서버 프로세스마다 하나다. 순번은 이 값 안에서만 뜻이 있다 (§5.1).
static EPOCH: LazyLock<String> = LazyLock::new(|| hex::encode(rand::random::<[u8; 8]>()));

type Release = Box<dyn FnOnce() + Send>;

impl Server {
    /// GET /channel?v=1.
    pub(crate) async fn handle_channel(&self, r: &mut Req) -> Response {
        let key = match check_handshake(r) {
            Ok(k) => k,
            Err((status, why)) => {
                infof!(None, "channel upgrade addr={}: {why}", r.remote_addr);
                return handshake_error(status);
            }
        };
        let (Some(on_upgrade), Some(me)) = (
            r.extensions.remove::<hyper::upgrade::OnUpgrade>(),
            self.arc(),
        ) else {
            return http_err(
                "Internal Server Error",
                StatusCode::INTERNAL_SERVER_ERROR,
                apierr::CODE_INTERNAL,
            );
        };
        let remote = r.remote_addr.clone();
        tokio::spawn(async move {
            let upgraded = match on_upgrade.await {
                Ok(u) => u,
                Err(e) => {
                    infof!(None, "channel upgrade addr={remote}: {e}");
                    return;
                }
            };
            let cfg = WebSocketConfig::default()
                .max_message_size(Some(CHANNEL_READ_LIMIT))
                .max_frame_size(Some(CHANNEL_READ_LIMIT));
            let ws =
                WebSocketStream::from_raw_socket(TokioIo::new(upgraded), Role::Server, Some(cfg))
                    .await;
            let (sink, reader) = ws.split();
            let conn = Arc::new(SafeConn::new(sink, remote.clone()));
            me.conn.ws_open.fetch_add(1, Ordering::SeqCst);
            me.channel_session(conn.clone(), reader, &remote).await;
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

    async fn channel_session(self: &Arc<Self>, conn: Arc<Conn>, mut reader: Reader, remote: &str) {
        let first = match tokio::time::timeout(HELLO_WAIT, next_frame(&mut reader)).await {
            Ok(Some(f)) => f,
            _ => return,
        };
        let Some(hello) = first.json().filter(|v| v["t"] == "hello") else {
            let _ = send(&conn, error("hello_required")).await;
            return;
        };
        infof!(None, "channel connected addr={remote}");
        let mut slots: HashMap<String, Release> = HashMap::new();
        if self.channel_hello(&conn, &hello, &mut slots, remote).await {
            let done = CancellationToken::new();
            let ping = tokio::spawn(ping_loop(conn.clone(), done.clone()));
            self.channel_read_loop(&conn, &mut reader, &mut slots, remote)
                .await;
            done.cancel();
            let _ = ping.await;
        }
        for (_, release) in slots.drain() {
            release();
        }
    }

    async fn channel_read_loop(
        self: &Arc<Self>,
        conn: &Arc<Conn>,
        reader: &mut Reader,
        slots: &mut HashMap<String, Release>,
        remote: &str,
    ) {
        loop {
            let Ok(Some(frame)) = tokio::time::timeout(th::PONG_WAIT, next_frame(reader)).await
            else {
                return;
            };
            let reply = match frame {
                Frame::Alive => continue,
                Frame::Binary => error("unsupported"),
                Frame::Text(_) => match frame.json() {
                    None => error("bad_json"),
                    Some(v) if v["t"] == "hello" => {
                        if self.channel_hello(conn, &v, slots, remote).await {
                            continue;
                        }
                        return;
                    }
                    Some(v) if v["t"] == "ping" => json!({"t":"pong","n":v["n"]}),
                    Some(_) => error("unknown_type"),
                },
            };
            if send(conn, reply).await.is_err() {
                return;
            }
        }
    }

    /// 칸 신원의 임대를 `hello` 의 목록에 맞추고 인사로 답한다. 보내지 못하면 false.
    async fn channel_hello(
        self: &Arc<Self>,
        conn: &Arc<Conn>,
        hello: &Value,
        slots: &mut HashMap<String, Release>,
        remote: &str,
    ) -> bool {
        let want: Vec<String> = hello["slots"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default();
        let gone: Vec<String> = slots
            .keys()
            .filter(|k| !want.contains(k))
            .cloned()
            .collect();
        for k in gone {
            if let Some(release) = slots.remove(&k) {
                release();
            }
        }
        for id in want {
            if let std::collections::hash_map::Entry::Vacant(e) = slots.entry(id) {
                let release = self.attach_sse_leases(e.key(), remote, true);
                e.insert(Box::new(release));
            }
        }
        let v = self.asset_version();
        let server = if v.is_empty() {
            json!({})
        } else {
            json!({"assetVersion": v})
        };
        send(conn, json!({"t":"hello","epoch":*EPOCH,"server":server}))
            .await
            .is_ok()
    }
}

enum Frame {
    Text(String),
    Binary,
    /// 핑·퐁 — 살아 있다는 뜻만 있다.
    Alive,
}

impl Frame {
    fn json(&self) -> Option<Value> {
        match self {
            Frame::Text(t) => serde_json::from_str(t).ok(),
            _ => None,
        }
    }
}

/// 다음 프레임. 닫혔거나 읽기 오류면 `None`.
async fn next_frame(reader: &mut Reader) -> Option<Frame> {
    match reader.next().await? {
        Ok(Message::Text(t)) => Some(Frame::Text(t.as_str().to_owned())),
        Ok(Message::Binary(_)) => Some(Frame::Binary),
        Ok(Message::Ping(_) | Message::Pong(_) | Message::Frame(_)) => Some(Frame::Alive),
        Ok(Message::Close(_)) | Err(_) => None,
    }
}

fn error(code: &str) -> Value {
    json!({"t":"error","code":code})
}

async fn send(conn: &Conn, v: Value) -> Result<(), tokio_tungstenite::tungstenite::Error> {
    conn.write_msg(Message::text(v.to_string())).await
}
