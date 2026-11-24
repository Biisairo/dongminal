//! full·사건 상태 토픽 (`perf/CHANNEL_PROTOCOL.md` §5.2·§10.3 C2b).
//!
//! full 토픽의 본문은 그 GET 종단의 본문 그대로다 — 받는 쪽의 복원 함수가 한 벌로 남는다
//! (`snapshot.rs` 와 같은 근거). 상태가 바뀌는 자리는 [`Server::refresh_state_topic`] 을 부른다.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use bytes::Bytes;
use http::{HeaderMap, Method, StatusCode};
use http_body_util::{BodyExt, Empty};
use otter_shared_httpresp::Response;
use serde_json::{Value, json};

use crate::Server;
use crate::channel::Seed;
use crate::req::Req;

/// full 토픽과 그 본문을 내는 GET 종단이다.
const FULL_TOPICS: &[(&str, &str)] = &[
    ("workspace", "/api/state"),
    ("settings", "/api/settings"),
    ("edges", "/api/edges"),
    ("chat", "/api/chat"),
    ("update", "/api/update"),
    ("claude.accounts", "/api/claude-accounts"),
    ("focus", "/api/focus"),
    ("telegram", "/api/telegram"),
];

/// 상태가 없는 사건 토픽이다.
const EVENT_TOPICS: &[&str] = &["alert", "fs", "edges.notice"];

/// 서버 안에서 만든 조회 요청의 원격 주소다.
const INTERNAL_ADDR: &str = "127.0.0.1:0";
const INTERNAL_HOST: &str = "127.0.0.1";

/// 200 이 아닌 GET 의 결과를 싣는 키다. `{"$http": 상태, "body": 본문}`.
const HTTP_STATUS_KEY: &str = "$http";
/// GET 의 ETag 를 싣는 키다. 받는 쪽은 그것을 응답 머리로 되돌린다 — 지문으로 "내 변경인가" 를 가리는
/// 화면(설정 패널·워크스페이스 rev)이 그대로 돈다.
const ETAG_KEY: &str = "$etag";

/// 토픽 하나의 다시 만들기 자리. `last` 는 마지막으로 낸 본문이고, 다시 만들기를 줄 세운다.
/// `queued` 는 아직 시작하지 않은 다시 만들기가 있다는 뜻이다 — 몰려 온 요청은 하나로 합친다.
#[derive(Default)]
struct Slot {
    last: tokio::sync::Mutex<Option<String>>,
    queued: AtomicBool,
}

#[derive(Default)]
pub(crate) struct FullTopics {
    slots: Mutex<HashMap<&'static str, Arc<Slot>>>,
    /// 등록할 때의 런타임. 데몬 push 처럼 런타임 밖의 스레드에서 불려도 다시 만들기를 건다.
    rt: std::sync::OnceLock<tokio::runtime::Handle>,
}

impl FullTopics {
    fn slot(&self, topic: &'static str) -> Arc<Slot> {
        let mut m = self.slots.lock().unwrap_or_else(|e| e.into_inner());
        m.entry(topic).or_default().clone()
    }
}

fn path_of(topic: &str) -> Option<(&'static str, &'static str)> {
    FULL_TOPICS.iter().copied().find(|(t, _)| *t == topic)
}

fn internal_get(path: &str) -> Option<Req> {
    let uri: http::Uri = path.parse().ok()?;
    let body = Empty::<Bytes>::new()
        .map_err(|never| match never {})
        .boxed_unsync();
    Some(Req::new(
        Method::GET,
        path.to_owned(),
        uri,
        HeaderMap::new(),
        INTERNAL_HOST.to_owned(),
        INTERNAL_ADDR.to_owned(),
        http::Extensions::new(),
        body,
        None,
    ))
}

impl Server {
    /// full·사건 토픽의 seed 를 건다. `Server::new` 가 한 번 부른다 (C3 의 `state_topics` 는 delta 토픽이다).
    pub(crate) fn register_full_topics(self: &Arc<Self>) {
        if let Ok(h) = tokio::runtime::Handle::try_current() {
            let _ = self.full_topics.rt.set(h);
        }
        for &(topic, _) in FULL_TOPICS {
            let me = Arc::downgrade(self);
            self.topics.register_seed(topic, move |_| {
                let me = me.clone();
                Box::pin(async move {
                    let s = me.upgrade()?;
                    let slot = s.full_topics.slot(topic);
                    let mut last = slot.last.lock().await;
                    let v = s.state_body(topic).await?;
                    *last = Some(v.to_string());
                    Some(Seed::Full(v))
                })
            });
        }
        for &topic in EVENT_TOPICS {
            self.topics
                .register_seed(topic, |_| Box::pin(async { Some(Seed::Event) }));
        }
    }

    /// 토픽의 지금 본문을 다시 만들어, 지난번과 다르면 `full` 로 낸다 (TC-CH2B-2).
    /// 지금 스레드의 런타임, 없으면 등록할 때의 런타임에 건다. 둘 다 없으면 아무것도 하지 않는다.
    pub(crate) fn refresh_full_topic(&self, topic: &'static str) {
        // 옛 `workspace_changed` 방송이 delta 토픽(C3)의 계기였다 — 그 방송 대신 여기서 건다.
        if topic == "workspace" {
            self.mark_state_topics(crate::state_topics::T_ALL);
        }
        let rt = tokio::runtime::Handle::try_current()
            .ok()
            .or_else(|| self.full_topics.rt.get().cloned());
        let (Some(me), Some(rt)) = (self.arc(), rt) else {
            return;
        };
        let slot = self.full_topics.slot(topic);
        if slot.queued.swap(true, Ordering::AcqRel) {
            return;
        }
        rt.spawn(async move {
            let mut last = slot.last.lock().await;
            slot.queued.store(false, Ordering::Release);
            let Some(v) = me.state_body(topic).await else {
                return;
            };
            let s = v.to_string();
            if last.as_deref() == Some(s.as_str()) {
                return;
            }
            *last = Some(s);
            me.topics.publish_full(topic, v);
        });
    }

    /// 판 확인 결과가 바뀌었다 (UPDATE_NOTICE_SRS FR-UPD-8a). 합성 루트가 확인기에서 부른다.
    pub fn update_changed(&self) {
        self.refresh_full_topic("update");
    }

    /// 토픽의 지금 본문이다. GET 에 ETag 가 있으면 `$etag` 로 더한다.
    async fn state_body(&self, topic: &str) -> Option<Value> {
        let (_, path) = path_of(topic)?;
        let mut r = internal_get(path)?;
        let res: Response = match topic {
            "workspace" => self.api_state_get(&mut r).await,
            "settings" => self.api_settings_get(&mut r).await,
            "edges" => self.api_edges_get(&mut r).await,
            "chat" => self.api_chat_get(&mut r).await,
            "update" => self.api_update_get(&mut r).await,
            "claude.accounts" => self.api_claude_accounts_list(&mut r).await,
            "focus" => self.api_focus_get(&mut r).await,
            "telegram" => self.api_telegram_get(&mut r).await,
            _ => return None,
        };
        let status = res.status();
        let etag = res
            .headers()
            .get("ETag")
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned);
        let body = res.into_body().collect().await.ok()?.to_bytes();
        let parsed: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
        if status != StatusCode::OK {
            return Some(json!({HTTP_STATUS_KEY: status.as_u16(), "body": parsed}));
        }
        let mut v = parsed;
        if let (Some(o), Some(etag)) = (v.as_object_mut(), etag) {
            o.insert(ETAG_KEY.to_owned(), json!(etag));
        }
        Some(v)
    }
}
