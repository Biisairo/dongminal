//! Telegram 알림 브리지. 사건은 큐로 받고(NFR-TGB-2), 작업자 하나와 polling 하나가 처리한다.
//! 상태 잠금(state)은 tabs·buttons 만 지킨다 — Telegram HTTP 는 잠금 밖에서 부른다
//! (REFACTOR3_DEFECTS_SRS FR-RD3-40).

use std::collections::HashMap;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use otter_gocompat::time::format_std_duration;
use otter_shared_fanout::CancellationToken;
use otter_shared_otterlog::{infof, warnf};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use time::OffsetDateTime;
use tokio::sync::mpsc;

use crate::client::{CallbackQuery, Client, Error, Message, POLL_TIMEOUT, Update, with_deadline};
use crate::config::{Config, Store};
use crate::pair::{NowFn, Pairing};
use crate::render::{AlarmKind, Body, READ_PREFIX, fit_alarm, plain_text, read_keyboard};
use crate::topics::{TopicMap, topics_path};
use crate::transcript::last_reply;

#[cfg(test)]
mod chatrig;
mod inbox;
mod mirror;
mod post;

pub use mirror::{ChatPerson, ChatRoom, ChatView, display_name};
pub use post::ChatPost;

/// hook 보고 하나 (FR-TGB-80·81). 서버가 활동 보고에서 옮겨 넣는다.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Event {
    pub tool_id: String,
    pub hook: String,
    pub tool: String,
    pub detail: String,
    /// 도구 입력의 JSON 원문. 없으면 비었다.
    pub input: Vec<u8>,
    pub input_over: bool,
    /// 대화 기록 파일의 경로. 내용은 실리지 않는다.
    pub transcript: String,
}

/// 알림의 위치 (FR-TGB-56). window 가 비면 알림에서 뺀다.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Location {
    pub device: String,
    pub window: String,
    pub tab: String,
}

/// 브리지가 otterminal 에 닿는 자리. 서버가 채운다.
pub trait Host: Send + Sync {
    /// PC 브라우저에서 그 탭에 마지막으로 입력한 시각 (FR-TGB-57). 없으면 None.
    fn last_browser_input(&self, tool_id: &str) -> Option<OffsetDateTime>;
    fn location(&self, tool_id: &str) -> Location;
    /// PC 알람을 끈다. typed 가 거짓이면 포커스를 준 것과 같다 (FR-TGB-58a).
    fn attend(&self, tool_id: &str, typed: bool);
    /// 짝맞춤으로 허용 계정이 바뀌었다.
    fn paired(&self) {}
    /// 사람 참가자가 보는 채팅 (ISSUE_TREE_CHAT_SRS FR-TGT-3). 읽지 못하면 None 이다. 막힐 수 있어 작업자는
    /// 블로킹 스레드에서 부른다. 아래 채팅 연산도 같다.
    fn chat_view(&self) -> Option<ChatView> {
        None
    }
    /// 사람 참가자가 방에 들어가거나(join) 나간다 (FR-TGT-6).
    fn chat_join(&self, _room: &str, _join: bool) -> Result<(), String> {
        Err(CHAT_UNSUPPORTED.to_owned())
    }
    /// 사람 참가자로 방에 글을 보낸다 (FR-TGT-9).
    fn chat_send(&self, _room: &str, _text: &str, _call: &[String]) -> Result<(), String> {
        Err(CHAT_UNSUPPORTED.to_owned())
    }
}

pub(crate) const QUEUE_SIZE: usize = 256;
/// 탭 하나가 기억하는 `[읽음]` 메시지 수 (FR-RD3-42 · D-RD3-4).
pub(crate) const MAX_BUTTONS_PER_TAB: usize = 32;
const CALL_TIMEOUT: Duration = Duration::from_secs(15);
/// 꺼져 있을 때 설정을 다시 보는 간격.
const DISABLED_RECHECK: Duration = Duration::from_secs(3);
pub(crate) const BACKOFF_FIRST: Duration = Duration::from_secs(1);
const BACKOFF_MAX: Duration = Duration::from_secs(60);
/// 알림 재전송 전에 429 의 retry_after 를 지켜 기다리는 상한 (FR-ATF-76).
pub(crate) const ALARM_RETRY_AFTER_MAX: Duration = Duration::from_secs(30);
/// 버튼 걷기 요청을 한꺼번에 몇 개까지 띄우는가 (FR-QG-20 · D-QG-6).
pub(crate) const CLEAR_BUTTONS_PARALLEL: usize = 4;
/// Bot API 가 HTML 을 읽지 못했을 때 400 설명에 싣는 글.
const PARSE_ERROR_TEXT: &str = "can't parse entities";
/// 사용자에게 선택지를 묻는 도구.
pub(crate) const ASK_TOOL: &str = "AskUserQuestion";
const HTTP_TOO_MANY: i64 = 429;
/// 채팅을 모르는 Host 의 답.
const CHAT_UNSUPPORTED: &str = "chat unsupported";
pub(crate) const UNSUPPORTED_BUTTON: &str = "지원하지 않는 버튼입니다.";
const HTTP_BAD_REQUEST: i64 = 400;

/// 알림 재전송 전의 기다림. 시험은 자지 않는 것으로 바꾼다.
pub(crate) type SleepFn =
    Arc<dyn Fn(Duration) -> Pin<Box<dyn Future<Output = ()> + Send>> + Send + Sync>;

/// 작업자 큐의 한 칸.
#[derive(Debug)]
pub(crate) enum Item {
    Activity(Event),
    Attention {
        tool: String,
        reason: String,
    },
    Clear(String),
    /// 사라진 도구 — 그 탭의 직전 hook 을 잊는다 (GD-12).
    Gone(String),
    /// 탭과 무관한 글 (FR-CAC-100a).
    Notice(String),
    /// 채팅 상태가 바뀌었다 — 거울 토픽을 맞춘다 (ISSUE_TREE_CHAT_SRS FR-TGT-3).
    ChatSync,
    /// 토픽에 올릴 채팅 글 (FR-TGT-7).
    ChatPost(ChatPost),
}

/// 탭 하나의 직전 hook (FR-TGB-51·55). 알람이 울릴 때 종류와 내용을 정한다.
#[derive(Clone, Debug, Default)]
pub(crate) struct TabState {
    transcript: String,
    ask: Option<Arc<Event>>,
    perm: Option<Arc<Event>>,
    notice: String,
    failed: bool,
    failure: String,
}

impl TabState {
    fn close(&mut self) {
        self.ask = None;
        self.perm = None;
        self.notice.clear();
        self.failed = false;
        self.failure.clear();
    }

    fn observe(&mut self, ev: Event) {
        if !ev.transcript.is_empty() {
            self.transcript = ev.transcript.clone();
        }
        match ev.hook.as_str() {
            "PreToolUse" if ev.tool == ASK_TOOL => self.ask = Some(Arc::new(ev)),
            "PermissionRequest" => self.perm = Some(Arc::new(ev)),
            "Notification" => self.notice = ev.detail,
            "StopFailure" => {
                self.close();
                self.failed = true;
                self.failure = ev.detail;
            }
            "PostToolUse" | "PostToolUseFailure" | "Stop" | "UserPromptSubmit" | "SessionStart"
            | "SessionEnd" => self.close(),
            _ => {}
        }
    }
}

const KIND_DONE: AlarmKind = AlarmKind::new("✅", "완료");
const KIND_ERROR: AlarmKind = AlarmKind::new("❌", "오류");
const KIND_QUESTION: AlarmKind = AlarmKind::new("❓", "질문");
const KIND_PERMISSION: AlarmKind = AlarmKind::new("🔐", "권한 요청");
const KIND_WAITING: AlarmKind = AlarmKind::new("⏳", "입력 대기");
const KIND_OTHER: AlarmKind = AlarmKind::new("🔔", "알림");

/// 알람 사유와 직전 hook 으로 종류와 내용을 정한다. ts 가 None 이면 hook 이 없는 에이전트다
/// (FR-TGB-52·59).
fn classify(reason: &str, ts: Option<&TabState>) -> (AlarmKind, Body) {
    let empty = TabState::default();
    let ts = ts.unwrap_or(&empty);
    match reason {
        "done" => {
            if ts.failed {
                return (KIND_ERROR, Body::Plain(ts.failure.clone()));
            }
            if ts.transcript.is_empty() {
                return (KIND_DONE, Body::None);
            }
            (KIND_DONE, Body::Reply(last_reply(&ts.transcript)))
        }
        "waiting" => {
            if let Some(p) = &ts.perm
                && p.tool != ASK_TOOL
            {
                let mut k = KIND_PERMISSION;
                k.tool = p.tool.clone();
                let summary = crate::render::perm_summary(&p.input, &p.detail);
                return (k, Body::Code(summary));
            }
            if ts.ask.is_some() || ts.perm.is_some() {
                return (KIND_QUESTION, Body::Question(question_input(ts)));
            }
            (KIND_WAITING, Body::Plain(ts.notice.clone()))
        }
        _ => (KIND_OTHER, Body::None),
    }
}

/// 질문의 입력. 권한 요청에 입력이 없으면 앞서 연 질문의 것이다 (FR-TGB-55).
fn question_input(ts: &TabState) -> Vec<u8> {
    if let Some(p) = &ts.perm
        && !p.input.is_empty()
    {
        return p.input.clone();
    }
    ts.ask.as_ref().map(|a| a.input.clone()).unwrap_or_default()
}

#[derive(Default)]
pub(crate) struct State {
    pub(crate) tabs: HashMap<String, TabState>,
    /// 탭마다 `[읽음]` 이 남은 알림의 메시지 id (FR-TGB-58b).
    pub(crate) buttons: HashMap<String, Vec<i64>>,
    /// 토픽에 올린 글의 보낸 이 (ISSUE_TREE_CHAT_SRS FR-TGT-9).
    pub(crate) senders: inbox::Senders,
}

/// Telegram 알림.
pub struct Bridge {
    st: Arc<Store>,
    host: Arc<dyn Host>,
    base: String,
    now: NowFn,
    pair: Pairing,
    tx: mpsc::Sender<Item>,
    pub(crate) rx: Mutex<Option<mpsc::Receiver<Item>>>,
    pub(crate) sleep: Mutex<SleepFn>,
    pub(crate) state: Mutex<State>,
    /// 방과 토픽의 짝 (FR-TGT-4).
    topics: TopicMap,
    /// 큐에 처리하지 않은 ChatSync 가 있다.
    sync_queued: AtomicBool,
    /// 마지막 맞추기에서 읽은 채팅 (FR-TGT-7·8).
    view: Mutex<Option<ChatView>>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct Sent {
    message_id: i64,
}

impl Bridge {
    /// 브리지를 만든다. base 가 비면 Bot API 주소다.
    pub fn new(st: Arc<Store>, host: Arc<dyn Host>, base: &str, now: NowFn) -> Arc<Bridge> {
        let (tx, rx) = mpsc::channel(QUEUE_SIZE);
        let st_path = st.path();
        let sleep: SleepFn = Arc::new(|d| Box::pin(tokio::time::sleep(d)));
        Arc::new(Bridge {
            st,
            host,
            base: base.to_owned(),
            pair: Pairing::new(Arc::clone(&now)),
            now,
            tx,
            rx: Mutex::new(Some(rx)),
            sleep: Mutex::new(sleep),
            state: Mutex::new(State::default()),
            topics: TopicMap::open(&topics_path(&st_path)),
            sync_queued: AtomicBool::new(false),
            view: Mutex::new(None),
        })
    }

    pub fn pairing(&self) -> &Pairing {
        &self.pair
    }

    pub(crate) fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// hook 보고를 큐에 넣는다. 막지 않고, 차면 버린다 (NFR-TGB-2).
    pub fn on_activity(&self, ev: Event) {
        self.enqueue(Item::Activity(ev));
    }

    /// PC 알람 (FR-TGB-50).
    pub fn on_attention(&self, tool_id: &str, reason: &str) {
        self.enqueue(Item::Attention {
            tool: tool_id.to_owned(),
            reason: reason.to_owned(),
        });
    }

    /// PC 알람이 꺼진 것 (FR-TGB-58b).
    pub fn on_attention_clear(&self, tool_id: &str) {
        self.enqueue(Item::Clear(tool_id.to_owned()));
    }

    /// 탭과 무관한 글 한 통 (FR-CAC-100a). 무음 규칙은 탭 입력 기준이라 쓰지 않는다.
    pub fn on_notice(&self, text: &str) {
        self.enqueue(Item::Notice(text.to_owned()));
    }

    /// 도구가 끝났거나 지워진 것 (GD-12). 꺼져 있어도 받는다 — 켜 있던 동안 쌓인 것을 걷는다.
    pub fn on_tool_gone(&self, tool_id: &str) {
        self.push(Item::Gone(tool_id.to_owned()));
    }

    fn enqueue(&self, it: Item) {
        if !self.st.config().enabled {
            return;
        }
        self.push(it);
    }

    fn push(&self, it: Item) {
        if self.tx.try_send(it).is_err() {
            warnf!(None, "telegram: 사건 큐가 가득 찼다 — 하나를 버린다");
        }
    }

    /// 작업자와 polling 을 돌린다. cancel 이 끝나면 돌아온다. 두 번째 호출은 곧바로 돌아온다.
    pub async fn run(self: Arc<Self>, cancel: CancellationToken) {
        let Some(mut rx) = self.rx.lock().unwrap_or_else(|p| p.into_inner()).take() else {
            return;
        };
        tokio::spawn(Arc::clone(&self).poll_loop(cancel.clone()));
        loop {
            tokio::select! {
                _ = cancel.cancelled() => return,
                it = rx.recv() => match it {
                    Some(it) => self.process(it).await,
                    None => return,
                },
            }
        }
    }

    /// 큐의 한 칸을 처리한다. 작업자만 부른다(시험은 직접 부른다).
    pub(crate) async fn process(&self, it: Item) {
        if let Item::Gone(t) = &it {
            self.lock().tabs.remove(t);
            return;
        }
        if let Item::ChatSync = it {
            self.sync_queued.store(false, Ordering::Release);
        }
        let Some(c) = self.active() else {
            return;
        };
        match it {
            Item::Activity(ev) => {
                let mut g = self.lock();
                g.tabs.entry(ev.tool_id.clone()).or_default().observe(ev);
            }
            Item::Clear(t) => self.clear_buttons(&c, &t).await,
            Item::Notice(text) => {
                let p = json!({"chat_id": c.user_id, "text": text});
                if let Err(e) = self.call(&c, "sendMessage", &p).await {
                    infof!(None, "telegram: 글을 보내지 못했다: {e}");
                }
            }
            Item::Attention { tool, reason } => self.alarm(&c, &tool, &reason).await,
            Item::ChatSync => self.sync_topics(&c).await,
            Item::ChatPost(p) => self.post_chat(&c, p).await,
            Item::Gone(_) => {}
        }
    }

    fn active(&self) -> Option<Config> {
        let c = self.st.config();
        (c.enabled && !c.token.is_empty() && c.user_id != 0).then_some(c)
    }

    fn client(&self, c: &Config) -> Client {
        Client::new(&self.base, &c.token)
    }

    async fn call(&self, c: &Config, method: &str, p: &Value) -> Result<(), Error> {
        let cl = self.client(c);
        with_deadline(method, CALL_TIMEOUT, cl.call_discard(method, Some(p))).await
    }

    async fn poll_loop(self: Arc<Self>, cancel: CancellationToken) {
        let mut offset: i64 = 0;
        let mut wait = BACKOFF_FIRST;
        while !cancel.is_cancelled() {
            let c = self.st.config();
            if !c.enabled || c.token.is_empty() {
                if !sleep_ctx(&cancel, DISABLED_RECHECK).await {
                    return;
                }
                continue;
            }
            let cl = self.client(&c);
            let res = tokio::select! {
                _ = cancel.cancelled() => return,
                r = cl.get_updates(offset, POLL_TIMEOUT.as_secs() as i64) => r,
            };
            match res {
                Err(e) => {
                    let d = match e.api() {
                        Some(a) if a.retry_after > 0 => Duration::from_secs(a.retry_after as u64),
                        _ => wait,
                    };
                    infof!(
                        None,
                        "telegram: 받기 실패 — {} 뒤 다시: {e}",
                        format_std_duration(d)
                    );
                    if !sleep_ctx(&cancel, d).await {
                        return;
                    }
                    wait = (wait * 2).min(BACKOFF_MAX);
                }
                Ok(ups) => {
                    wait = BACKOFF_FIRST;
                    for u in ups {
                        offset = u.update_id + 1;
                        self.handle_update(u).await;
                    }
                }
            }
        }
    }

    // ── 받는 쪽 ─────────────────────────────────────

    /// Telegram 에서 온 것 하나. polling 이 부른다. 받는 것은 짝맞춤뿐이다.
    pub(crate) async fn handle_update(&self, u: Update) {
        let c = self.st.config();
        if !c.enabled || c.token.is_empty() {
            return;
        }
        if let Some(m) = u.message {
            self.on_message(c, m).await;
        } else if let Some(q) = u.callback_query {
            self.on_callback(&c, q).await;
        }
    }

    async fn reply(&self, c: &Config, m: &Message, text: &str) {
        let _ = self
            .call(
                c,
                "sendMessage",
                &json!({"chat_id": m.chat.id, "text": text}),
            )
            .await;
    }

    async fn on_message(&self, mut c: Config, m: Message) {
        let Some(from) = &m.from else {
            return;
        };
        let from_id = from.id;
        // 짝맞춤은 등록 전에도 받는다 (FR-TGB-11).
        if let Some(code) = m.text.trim().strip_prefix("/pair") {
            if self.pair.redeem(code.trim()) {
                if let Err(e) = self.st.set_user(from_id) {
                    infof!(None, "telegram: 짝맞춤 저장 실패 from={from_id}: {e}");
                    self.reply(
                        &c,
                        &m,
                        "코드는 맞았지만 등록을 저장하지 못했습니다. PC 에서 새 코드를 받아 다시 시도하세요.",
                    )
                    .await;
                    return;
                }
                c.user_id = from_id;
                self.host.paired();
                self.reply(&c, &m, "등록했습니다. 이제 이 대화방으로 알림을 보냅니다.")
                    .await;
                return;
            }
            infof!(None, "telegram: 짝맞춤 실패 from={from_id}");
            if from_id == c.user_id {
                self.reply(&c, &m, "코드가 틀렸거나 지났습니다.").await;
            }
            return;
        }
        // 허용 계정이 아니면 답하지 않는다. 판정은 보낸 사람이다 (FR-TGB-12·13).
        if c.user_id == 0 || from_id != c.user_id {
            infof!(
                None,
                "telegram: 등록되지 않은 사람의 message 를 버렸다 from={from_id}"
            );
            return;
        }
        if self.topic_message(&c, &m).await {
            return;
        }
        self.reply(&c, &m, "이 봇은 알림만 보냅니다.").await;
    }

    /// `[✓ 읽음]` (FR-TGB-58a). 그 밖의 버튼은 로딩으로 멈추지 않게 답만 한다 (FR-TGB-14).
    async fn on_callback(&self, c: &Config, q: CallbackQuery) {
        if c.user_id == 0 || q.from.id != c.user_id {
            infof!(
                None,
                "telegram: 등록되지 않은 사람의 버튼을 버렸다 from={}",
                q.from.id
            );
            return;
        }
        if self.room_button(c, &q).await {
            return;
        }
        let tool = match q.data.strip_prefix(READ_PREFIX) {
            Some(t) if !t.is_empty() => t.to_owned(),
            _ => {
                self.answer(c, &q.id, UNSUPPORTED_BUTTON).await;
                return;
            }
        };
        self.host.attend(&tool, false);
        self.answer(c, &q.id, "읽음").await;
        // 걷지 못하면 목록에 남겨 해제 때 다시 걷는다 (FR-ATF-41).
        if let Some(m) = &q.message
            && self.drop_button(c, m.chat.id, m.message_id).await.is_ok()
        {
            self.forget_button(&tool, m.message_id);
        }
    }

    async fn answer(&self, c: &Config, id: &str, text: &str) {
        let p = json!({"callback_query_id": id, "text": text});
        let _ = self.call(c, "answerCallbackQuery", &p).await;
    }

    // ── 알림 ────────────────────────────────────────

    async fn alarm(&self, c: &Config, tool_id: &str, reason: &str) {
        // classify 는 transcript 를 읽으므로 잠금 밖에서 사본으로 한다 (FR-ATF-43 · FR-RD3-40).
        let snap = self.lock().tabs.get(tool_id).cloned();
        let (kind, body) = classify(reason, snap.as_ref());
        let text = fit_alarm(&kind, &self.host.location(tool_id), &body);
        let mut p = Map::new();
        p.insert("chat_id".into(), json!(c.user_id));
        p.insert("text".into(), json!(text));
        p.insert("parse_mode".into(), json!("HTML"));
        let kb = read_keyboard(tool_id);
        if let Some(kb) = &kb {
            p.insert("reply_markup".into(), kb.clone());
        }
        if self.silent(c, tool_id) {
            p.insert("disable_notification".into(), json!(true));
        }
        let sent = match self.send_alarm(c, p).await {
            Ok(s) => s,
            Err(e) => {
                infof!(None, "telegram: 알림을 보내지 못했다: {e}");
                return;
            }
        };
        if kb.is_some() {
            let mut g = self.lock();
            let ids = g.buttons.entry(tool_id.to_owned()).or_default();
            ids.push(sent.message_id);
            // 넘치면 가장 오래된 것을 잊는다 (FR-RD3-42).
            if ids.len() > MAX_BUTTONS_PER_TAB {
                let drop = ids.len() - MAX_BUTTONS_PER_TAB;
                ids.drain(..drop);
            }
        }
    }

    async fn send_once(&self, c: &Config, p: &Map<String, Value>) -> Result<Sent, Error> {
        let cl = self.client(c);
        let p = Value::Object(p.clone());
        with_deadline(
            "sendMessage",
            CALL_TIMEOUT,
            cl.call::<Option<Sent>>("sendMessage", Some(&p)),
        )
        .await
        .map(Option::unwrap_or_default)
    }

    /// 알림을 보내고, 실패하면 한 번 다시 보낸다 (FR-ATF-76 · AT-TG-3). 429 면 retry_after 를
    /// ALARM_RETRY_AFTER_MAX 까지 지켜 기다리고, HTML 해석 오류(400)면 parse_mode 를 빼고
    /// 보낸다. 그 밖의 실패는 BACKOFF_FIRST 뒤에 같은 것을 다시 보낸다. 잠금은 쥐지 않는다.
    async fn send_alarm(&self, c: &Config, mut p: Map<String, Value>) -> Result<Sent, Error> {
        let err = match self.send_once(c, &p).await {
            Ok(s) => return Ok(s),
            Err(e) => e,
        };
        let sleep = Arc::clone(&self.sleep.lock().unwrap_or_else(|x| x.into_inner()));
        match err.api() {
            Some(a) if a.code == HTTP_TOO_MANY => {
                let d = Duration::from_secs(a.retry_after.max(0) as u64).min(ALARM_RETRY_AFTER_MAX);
                sleep(d).await;
            }
            Some(a) if a.code == HTTP_BAD_REQUEST && a.description.contains(PARSE_ERROR_TEXT) => {
                // parse_mode 만 빼면 태그가 글자로 보인다 — 평문은 태그를 걷고 이스케이프를 푼다.
                p.remove("parse_mode");
                if let Some(Value::String(t)) = p.get("text") {
                    let plain = plain_text(t);
                    p.insert("text".into(), Value::String(plain));
                }
            }
            _ => sleep(BACKOFF_FIRST).await,
        }
        self.send_once(c, &p).await
    }

    /// 그 탭의 남은 `[읽음]` 을 모두 걷는다 (FR-TGB-58b). 잠금 밖에서 상한 있는 병렬로 보낸다.
    pub(crate) async fn clear_buttons(&self, c: &Config, tool_id: &str) {
        let ids = self.lock().buttons.remove(tool_id).unwrap_or_default();
        let failed: Vec<AtomicBool> = ids.iter().map(|_| AtomicBool::new(false)).collect();
        let none = CancellationToken::new();
        otter_shared_fanout::each(&none, CLEAR_BUTTONS_PARALLEL, ids.len(), |i| {
            let (id, failed) = (ids[i], &failed[i]);
            async move {
                if self.drop_button(c, c.user_id, id).await.is_err() {
                    failed.store(true, Ordering::Relaxed);
                }
            }
        })
        .await;
        let left: Vec<i64> = ids
            .iter()
            .zip(&failed)
            .filter(|(_, f)| f.load(Ordering::Relaxed))
            .map(|(id, _)| *id)
            .collect();
        self.keep_buttons(tool_id, left);
    }

    /// 걷지 못한 메시지를 목록 앞(오래된 쪽)에 되돌린다 — 다음 해제 때 다시 걷는다 (FR-ATF-41).
    fn keep_buttons(&self, tool_id: &str, mut ids: Vec<i64>) {
        if ids.is_empty() {
            return;
        }
        let mut g = self.lock();
        if let Some(rest) = g.buttons.get(tool_id) {
            ids.extend_from_slice(rest);
        }
        if ids.len() > MAX_BUTTONS_PER_TAB {
            ids.drain(..ids.len() - MAX_BUTTONS_PER_TAB);
        }
        g.buttons.insert(tool_id.to_owned(), ids);
    }

    /// 이미 걷은 메시지를 목록에서 뺀다.
    fn forget_button(&self, tool_id: &str, msg_id: i64) {
        let mut g = self.lock();
        let Some(ids) = g.buttons.get_mut(tool_id) else {
            return;
        };
        ids.retain(|&id| id != msg_id);
        if ids.is_empty() {
            g.buttons.remove(tool_id);
        }
    }

    async fn drop_button(&self, c: &Config, chat_id: i64, msg_id: i64) -> Result<(), Error> {
        let p = json!({"chat_id": chat_id, "message_id": msg_id,
            "reply_markup": {"inline_keyboard": []}});
        self.call(c, "editMessageReplyMarkup", &p).await
    }

    fn silent(&self, c: &Config, tool_id: &str) -> bool {
        if c.silence_min <= 0 {
            return false;
        }
        match self.host.last_browser_input(tool_id) {
            Some(last) => (self.now)() - last < time::Duration::minutes(c.silence_min),
            None => false,
        }
    }
}

async fn sleep_ctx(cancel: &CancellationToken, d: Duration) -> bool {
    tokio::select! {
        _ = cancel.cancelled() => false,
        _ = tokio::time::sleep(d) => true,
    }
}

#[cfg(test)]
mod tests;
