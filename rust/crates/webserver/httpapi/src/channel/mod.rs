//! 채널 `/channel` — 브라우저 탭 하나의 WebSocket 하나 (PERF_OPTIMIZATION_SRS FR-CON,
//! `docs/internal/perf/CHANNEL_PROTOCOL.md`). 인사·생존 확인·칸 신원 임대(C1), 토픽 구독(§11.1).

// 발행하는 쪽(C2~C5)이 붙기 전까지 제품 빌드에서 쓰이지 않는 표면이 있다. 첫 발행자가 붙으면 지운다.
#[cfg_attr(not(test), allow(dead_code))]
mod outbox;
#[cfg_attr(not(test), allow(dead_code))]
mod topics;

#[cfg_attr(not(test), allow(unused_imports))]
pub(crate) use outbox::{CHANNEL_PENDING_MAX, Out, Outbox, TOPIC_PENDING_MAX};
#[cfg_attr(not(test), allow(unused_imports))]
pub(crate) use topics::{DeltaOp, Seed, SubError, TOPIC_RING, TopicHub};

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
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

/// 채널마다 붙는 번호 — 토픽 구독자의 열쇠다.
static NEXT_CHAN: AtomicU64 = AtomicU64::new(1);

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
        let chan = NEXT_CHAN.fetch_add(1, Ordering::Relaxed);
        let out = Outbox::new();
        let done = CancellationToken::new();
        let writer = tokio::spawn(write_loop(
            Arc::clone(self),
            conn.clone(),
            out.clone(),
            done.clone(),
        ));
        let ping = tokio::spawn(ping_loop(conn.clone(), done.clone()));
        let mut slots: HashMap<String, Release> = HashMap::new();
        self.channel_hello(&out, &hello, &mut slots, remote);
        self.channel_read_loop(chan, &out, &mut reader, &mut slots, remote, &done)
            .await;
        done.cancel();
        let _ = writer.await;
        let _ = ping.await;
        self.topics.unsubscribe_all(chan);
        for (_, release) in slots.drain() {
            release();
        }
    }

    async fn channel_read_loop(
        self: &Arc<Self>,
        chan: u64,
        out: &Arc<Outbox>,
        reader: &mut Reader,
        slots: &mut HashMap<String, Release>,
        remote: &str,
        done: &CancellationToken,
    ) {
        loop {
            let frame = tokio::select! {
                _ = done.cancelled() => return,
                r = tokio::time::timeout(th::PONG_WAIT, next_frame(reader)) => match r {
                    Ok(Some(f)) => f,
                    _ => return,
                },
            };
            let reply = match frame {
                Frame::Alive => continue,
                Frame::Binary => error("unsupported"),
                Frame::Text(_) => match frame.json() {
                    None => error("bad_json"),
                    Some(v) => match v["t"].as_str().unwrap_or_default() {
                        "hello" => {
                            self.channel_hello(out, &v, slots, remote);
                            continue;
                        }
                        "ping" => json!({"t":"pong","n":v["n"]}),
                        "sub" => match self.channel_sub(chan, out, &v).await {
                            Ok(()) => continue,
                            Err(e) => e,
                        },
                        "unsub" => {
                            self.topics
                                .unsubscribe(chan, v["topic"].as_str().unwrap_or_default());
                            continue;
                        }
                        _ => error("unknown_type"),
                    },
                },
            };
            out.push_control(reply.to_string());
        }
    }

    async fn channel_sub(&self, chan: u64, out: &Arc<Outbox>, v: &Value) -> Result<(), Value> {
        let topic = v["topic"].as_str().unwrap_or_default();
        let r = self
            .topics
            .subscribe(chan, out, topic, v["seq"].as_u64(), v["epoch"].as_str())
            .await;
        match r {
            Ok(()) => Ok(()),
            Err(SubError::UnknownTopic) => {
                Err(json!({"t":"error","code":"unknown_topic","topic":topic}))
            }
        }
    }

    /// 칸 신원의 임대를 `hello` 의 목록에 맞추고 인사로 답한다.
    fn channel_hello(
        self: &Arc<Self>,
        out: &Outbox,
        hello: &Value,
        slots: &mut HashMap<String, Release>,
        remote: &str,
    ) {
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
        out.push_control(
            json!({"t":"hello","epoch":self.topics.epoch(),"server":server}).to_string(),
        );
    }
}

/// Outbox 를 비우는 쓰기 태스크 하나. 쓰기에 실패하거나 상한을 넘으면 세션을 끝낸다.
async fn write_loop(srv: Arc<Server>, conn: Arc<Conn>, out: Arc<Outbox>, done: CancellationToken) {
    loop {
        let next = tokio::select! {
            _ = done.cancelled() => return,
            o = out.next() => o,
        };
        let msg = match next {
            Out::Text(t) => Message::text(t.as_ref()),
            Out::Binary(b) => Message::binary(b),
            Out::NeedFull(topic) => match srv.topics.full_item(&topic) {
                Some(it) => {
                    out.drop_upto(&topic, it.seq);
                    Message::text(it.frame.as_ref())
                }
                None => continue,
            },
            Out::Close => break,
        };
        if conn.write_msg(msg).await.is_err() {
            break;
        }
    }
    done.cancel();
    conn.close().await;
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
