//! 채널 `/channel` — 브라우저 탭 하나의 WebSocket 하나 (PERF_OPTIMIZATION_SRS FR-CON,
//! `docs/internal/perf/CHANNEL_PROTOCOL.md`). 인사·생존 확인·칸 신원 임대(C1), 토픽 구독(§11.1).

mod cmd;
mod outbox;
mod screens;
mod term;
mod topics;

#[cfg(test)]
pub(crate) use outbox::{CHANNEL_PENDING_MAX, TOPIC_PENDING_MAX};
pub(crate) use outbox::{Out, Outbox};
pub(crate) use screens::ScreenFlights;
#[cfg(test)]
pub(crate) use term::TERM_HISTORY_MAX;
#[cfg(test)]
pub(crate) use topics::TOPIC_RING;
pub(crate) use topics::{DeltaOp, Seed, SubError, TopicHub};

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use bytes::Bytes;
use http::StatusCode;
use otter_shared_httpresp::Response;
use otter_shared_otterlog::infof;
use otter_shared_toolhub as th;
use serde_json::{Value, json};
use sockudo_ws::Message;
use tokio_util::sync::CancellationToken;

use crate::Server;
use crate::httperr::http_err;
use crate::req::Req;
use crate::ws::{WsReader, WsWriter, handshake_error, ws_accept};
use otter_webserver_apierr as apierr;

/// 브라우저가 보내는 메시지 하나의 상한이다 (`/ws` 의 `WS_READ_LIMIT` 와 같다).
const CHANNEL_READ_LIMIT: usize = 1 << 20;
/// 첫 `hello` 를 기다리는 시간이다 (TC-CH1-2).
const HELLO_WAIT: Duration = Duration::from_secs(10);

/// 채널마다 붙는 번호 — 토픽 구독자의 열쇠다.
static NEXT_CHAN: AtomicU64 = AtomicU64::new(1);

type Release = Box<dyn FnOnce() + Send>;

/// 이 채널이 대표하는 신원 — 칸 신원의 임대(C1)와 `client` 의 임대·명령 구독(C2a).
#[derive(Default)]
struct Who {
    slots: HashMap<String, Release>,
    client: Option<cmd::ClientLink>,
}

impl Server {
    /// GET /channel?v=1.
    pub(crate) async fn handle_channel(&self, r: &mut Req) -> Response {
        let accept = match ws_accept(r) {
            Ok(a) => a,
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
        let res = accept.response();
        tokio::spawn(async move {
            let upgraded = match on_upgrade.await {
                Ok(u) => u,
                Err(e) => {
                    infof!(None, "channel upgrade addr={remote}: {e}");
                    return;
                }
            };
            let (reader, writer) = accept.open(upgraded, CHANNEL_READ_LIMIT);
            me.conn.ws_open.fetch_add(1, Ordering::SeqCst);
            me.channel_session(writer, reader, &remote).await;
            me.conn.ws_open.fetch_sub(1, Ordering::SeqCst);
        });
        res
    }

    async fn channel_session(
        self: &Arc<Self>,
        mut writer: WsWriter,
        mut reader: WsReader,
        remote: &str,
    ) {
        let first = match tokio::time::timeout(HELLO_WAIT, next_frame(&mut reader)).await {
            Ok(Some(f)) => f,
            _ => {
                let _ = writer.close(1000, "").await;
                return;
            }
        };
        let Some(hello) = first.json().filter(|v| v["t"] == "hello") else {
            let _ = write(
                &mut writer,
                Message::text(error("hello_required").to_string()),
            )
            .await;
            let _ = writer.close(1000, "").await;
            return;
        };
        infof!(None, "channel connected addr={remote}");
        let chan = NEXT_CHAN.fetch_add(1, Ordering::Relaxed);
        let out = Outbox::new();
        let done = CancellationToken::new();
        let writer = tokio::spawn(write_loop(
            Arc::clone(self),
            writer,
            out.clone(),
            done.clone(),
        ));
        let mut who = Who::default();
        let terms = Arc::new(term::Terms::default());
        self.channel_hello(&out, &hello, &mut who.slots, remote);
        self.channel_client(&out, &hello, &mut who.client, remote);
        self.channel_read_loop(chan, &out, &terms, &mut reader, &mut who, remote, &done)
            .await;
        done.cancel();
        terms.close_all();
        let _ = writer.await;
        self.topics.unsubscribe_all(chan);
        if let Some(l) = who.client.take() {
            self.channel_client_drop(l);
        }
        for (_, release) in who.slots.drain() {
            release();
        }
    }

    #[allow(clippy::too_many_arguments)]
    async fn channel_read_loop(
        self: &Arc<Self>,
        chan: u64,
        out: &Arc<Outbox>,
        terms: &Arc<term::Terms>,
        reader: &mut WsReader,
        who: &mut Who,
        remote: &str,
        done: &CancellationToken,
    ) {
        loop {
            let frame = tokio::select! {
                _ = done.cancelled() => return,
                f = next_frame(reader) => match f {
                    Some(f) => f,
                    None => return,
                },
            };
            let reply = match frame {
                Frame::Alive => continue,
                Frame::Binary(b) if b.len() >= term::HEAD => {
                    self.term_input(terms, &b);
                    continue;
                }
                Frame::Binary(_) => error("bad_frame"),
                Frame::Text(_) => match frame.json() {
                    None => error("bad_json"),
                    Some(v) => match v["t"].as_str().unwrap_or_default() {
                        "hello" => {
                            self.channel_hello(out, &v, &mut who.slots, remote);
                            self.channel_client(out, &v, &mut who.client, remote);
                            continue;
                        }
                        "ping" => json!({"t":"pong","n":v["n"]}),
                        "cmd.result" => {
                            self.channel_cmd_result(v);
                            continue;
                        }
                        "sub" => match self.channel_sub(chan, out, &v).await {
                            Ok(()) => continue,
                            Err(e) => e,
                        },
                        "term.open" => {
                            self.term_open(terms, out, &v);
                            continue;
                        }
                        "term.history" => {
                            self.term_history(terms, out, &v);
                            continue;
                        }
                        "term.close" => {
                            self.term_close(terms, out, &v);
                            continue;
                        }
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
async fn write_loop(
    srv: Arc<Server>,
    mut writer: WsWriter,
    out: Arc<Outbox>,
    done: CancellationToken,
) {
    loop {
        let next = tokio::select! {
            _ = done.cancelled() => return,
            o = out.next() => o,
        };
        let msg = match next {
            Out::Text(t) => Message::Text(Bytes::copy_from_slice(t.as_bytes())),
            Out::Binary(b) => Message::Binary(Bytes::from(b)),
            Out::NeedFull(topic) => match srv.topics.full_item(&topic) {
                Some(it) => {
                    out.drop_upto(&topic, it.seq);
                    Message::Text(Bytes::copy_from_slice(it.frame.as_bytes()))
                }
                None => continue,
            },
            Out::Close => break,
        };
        if write(&mut writer, msg).await.is_err() {
            break;
        }
    }
    done.cancel();
    let _ = writer.close(1000, "").await;
}

/// 쓰기 한 번. 마감(`WRITE_WAIT`) 안에 끝나지 않으면 실패다 — 읽지 않는 상대가 쓰기 태스크를
/// 영영 붙잡지 않게 한다.
async fn write(writer: &mut WsWriter, msg: Message) -> Result<(), ()> {
    match tokio::time::timeout(th::WRITE_WAIT, writer.send(msg)).await {
        Ok(Ok(())) => Ok(()),
        _ => Err(()),
    }
}

enum Frame {
    Text(String),
    Binary(Vec<u8>),
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
async fn next_frame(reader: &mut WsReader) -> Option<Frame> {
    match reader.next().await? {
        Ok(Message::Text(t)) => Some(Frame::Text(String::from_utf8_lossy(&t).into_owned())),
        Ok(Message::Binary(b)) => Some(Frame::Binary(b.to_vec())),
        Ok(Message::Ping(_) | Message::Pong(_)) => Some(Frame::Alive),
        Ok(Message::Close(_)) | Err(_) => None,
    }
}

fn error(code: &str) -> Value {
    json!({"t":"error","code":code})
}
