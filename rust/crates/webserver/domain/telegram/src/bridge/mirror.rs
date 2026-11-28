//! 채팅 방의 거울 토픽 (ISSUE_TREE_CHAT_SRS FR-TGT-3·4·5). 채팅 상태가 바뀌면 방마다 토픽 하나와 맨 위 고정
//! 안내 글을 맞춘다. 짝은 [`TopicMap`] 에 둔다. 단추 데이터는 방 id(64자) 대신 토픽 thread id 를 싣는다 —
//! callback_data 는 64바이트가 상한이다.

use std::sync::Arc;
use std::sync::atomic::Ordering;

use otter_shared_otterlog::infof;
use serde::Deserialize;
use serde_json::{Value, json};

use super::{Bridge, CALL_TIMEOUT, Item, Sent};
use crate::client::{Error, with_deadline};
use crate::config::Config;
use crate::render::esc;
use crate::topics::Topic;

/// 토픽 이름의 상한(글자). Bot API createForumTopic 의 name 은 1~128자다.
pub(crate) const TOPIC_NAME_MAX: usize = 128;
/// 이름이 빈 방의 토픽 이름.
pub(crate) const UNNAMED_TOPIC: &str = "채팅";
/// 고정 글 단추의 데이터 접두. 뒤에 토픽 thread id 가 붙는다 (FR-TGT-6).
pub(crate) const JOIN_PREFIX: &str = "cj:";
pub(crate) const LEAVE_PREFIX: &str = "cl:";
const JOIN_TEXT: &str = "들어가기";
const LEAVE_TEXT: &str = "나가기";
const JOINED_TEXT: &str = "들어가 있음";
const NOT_JOINED_TEXT: &str = "들어가 있지 않음";
/// 다른 노드 참가자 이름의 나눔 (FR-CUX-9). 웹 카탈로그 `chat.name_remote` 와 같다.
const REMOTE_SEP: &str = " › ";
/// 참가자 하나의 id 와 표시 이름 (FR-CUX-9).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ChatPerson {
    pub id: String,
    pub name: String,
}

/// 사람 참가자가 보는 채팅 (FR-TGT-3). 서버가 채팅 상태에서 옮긴다.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ChatView {
    /// 사람 참가자(나).
    pub me: ChatPerson,
    pub rooms: Vec<ChatRoom>,
}

/// 사람 참가자에게 보이는 방 하나 (FR-TGT-3).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ChatRoom {
    pub id: String,
    /// 보이는 이름 — 단체채팅은 방 이름, 개인채팅은 상대의 표시 이름이다.
    pub name: String,
    pub purpose: String,
    pub members: i64,
    /// 사람 참가자가 들어가 있는가.
    pub joined: bool,
    /// 이 방에서 내 알림 단계(`all`·`called`·`off`). 비면 called 다 (FR-CAL-5·7).
    pub notify: String,
    /// 방의 참가자. 부른 상대의 이름을 찾는다 (FR-TGT-7).
    pub people: Vec<ChatPerson>,
}

/// 참가자의 표시 이름 (FR-CUX-9). 원래 이름은 `<노드>/<탭>` 이다. 내 노드의 참가자는 탭 이름, 다른 노드는
/// `<노드> › <탭>` 이다. 노드는 id 의 지문(마지막 `-` 앞)으로 가른다. 웹 `chatName` 과 같은 규칙이다.
pub fn display_name(label: &str, id: &str, me: &str) -> String {
    let Some((node, tab)) = label.split_once('/') else {
        return label.to_owned();
    };
    if node_of(id) == node_of(me) {
        return tab.to_owned();
    }
    format!("{node}{REMOTE_SEP}{tab}")
}

fn node_of(id: &str) -> &str {
    id.rfind('-').map_or("", |i| &id[..i])
}

/// 토픽 이름. 비면 [`UNNAMED_TOPIC`], 길면 [`TOPIC_NAME_MAX`] 글자에서 자른다.
pub(crate) fn topic_name(name: &str) -> String {
    let n = name.trim();
    if n.is_empty() {
        return UNNAMED_TOPIC.to_owned();
    }
    n.chars().take(TOPIC_NAME_MAX).collect()
}

/// 토픽 안내 글 (FR-TGT-5): 이름 · 목적 · 참가자 수 · 들어가 있는지. Telegram HTML 이다.
pub(crate) fn pin_text(r: &ChatRoom) -> String {
    let mut s = format!("<b>{}</b>\n", esc(&topic_name(&r.name)));
    if !r.purpose.trim().is_empty() {
        s.push_str(&esc(r.purpose.trim()));
        s.push('\n');
    }
    let state = if r.joined {
        JOINED_TEXT
    } else {
        NOT_JOINED_TEXT
    };
    s.push_str(&format!("참가자 {}명 · {state}", r.members));
    s
}

/// Telegram 이 토픽이 없다고 할 때의 설명 조각 (FR-TGT-11).
const TOPIC_MISSING: &[&str] = &[
    "message thread not found",
    "TOPIC_ID_INVALID",
    "TOPIC_DELETED",
];
const HTTP_BAD_REQUEST: i64 = 400;

/// 토픽이 없어졌다는 오류인가 (FR-TGT-11). 사용자가 토픽을 지웠거나 Telegram 이 치웠다.
pub(crate) fn topic_missing(e: &Error) -> bool {
    e.api().is_some_and(|a| {
        a.code == HTTP_BAD_REQUEST && TOPIC_MISSING.iter().any(|s| a.description.contains(s))
    })
}

/// 고정 글의 단추. 들어가 있으면 `[나가기]`, 아니면 `[들어가기]` 하나다 (FR-TGT-5·6).
pub(crate) fn pin_keyboard(thread: i64, joined: bool) -> Value {
    let (text, prefix) = if joined {
        (LEAVE_TEXT, LEAVE_PREFIX)
    } else {
        (JOIN_TEXT, JOIN_PREFIX)
    };
    json!({"inline_keyboard": [[{"text": text, "callback_data": format!("{prefix}{thread}")}]]})
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct ForumTopic {
    message_thread_id: i64,
}

impl Bridge {
    /// 채팅 상태가 바뀌었다 — 거울을 맞춘다. 채팅 토픽이 꺼져 있으면 아무것도 넣지 않는다 (NFR-ITH-4).
    /// 아직 처리하지 않은 맞추기가 큐에 있으면 하나로 합친다.
    pub fn on_chat_changed(&self) {
        if !self.st.config().topics_active() {
            return;
        }
        if self.sync_queued.swap(true, Ordering::AcqRel) {
            return;
        }
        if self.tx.try_send(Item::ChatSync).is_err() {
            self.sync_queued.store(false, Ordering::Release);
            infof!(None, "telegram: 사건 큐가 가득 찼다 — 토픽 맞추기를 버린다");
        }
    }

    /// 방 목록과 짝을 맞춘다 (FR-TGT-3·4·5). 방 목록을 읽지 못하면 아무것도 지우지 않는다. 읽은 보기는 글 올리기
    /// (FR-TGT-7·8)가 쓰도록 기억한다.
    pub(crate) async fn sync_topics(&self, c: &Config) {
        if !c.topics_active() {
            return;
        }
        let host = Arc::clone(&self.host);
        let Ok(Some(view)) = tokio::task::spawn_blocking(move || host.chat_view()).await else {
            return;
        };
        let rooms = view.rooms.clone();
        *self.view.lock().unwrap_or_else(|p| p.into_inner()) = Some(view);
        for r in &rooms {
            self.sync_room(c, r).await;
        }
        for id in self.topics.rooms() {
            if rooms.iter().all(|r| r.id != id) {
                self.drop_topic(c, &id).await;
            }
        }
    }

    async fn sync_room(&self, c: &Config, r: &ChatRoom) {
        let name = topic_name(&r.name);
        let text = pin_text(r);
        let Some(mut t) = self.topics.get(&r.id) else {
            self.open_topic(c, r, name, text).await;
            return;
        };
        let mut dirty = false;
        if t.name != name {
            let p = json!({"chat_id": c.user_id, "message_thread_id": t.thread_id, "name": name});
            match self.call(c, "editForumTopic", &p).await {
                Ok(()) => {
                    t.name = name;
                    dirty = true;
                }
                Err(e) if topic_missing(&e) => return self.reopen_topic(c, r, &e).await,
                Err(e) => infof!(None, "telegram: editForumTopic 실패: {e}"),
            }
        }
        if t.pin_id == 0 {
            if let Some(id) = self.post_pin(c, t.thread_id, r.joined, &text).await {
                t.pin_id = id;
                t.pin_text = text;
                dirty = true;
            }
        } else if t.pin_text != text {
            let p = json!({"chat_id": c.user_id, "message_id": t.pin_id, "text": text,
                "parse_mode": "HTML", "reply_markup": pin_keyboard(t.thread_id, r.joined)});
            match self.call(c, "editMessageText", &p).await {
                Ok(()) => {
                    t.pin_text = text;
                    dirty = true;
                }
                Err(e) if topic_missing(&e) => return self.reopen_topic(c, r, &e).await,
                Err(e) => infof!(None, "telegram: editMessageText 실패: {e}"),
            }
        }
        if dirty {
            let _ = self.topics.set(&r.id, t);
        }
    }

    /// 토픽이 없어졌다 — 짝을 지우고 다시 만든다 (FR-TGT-11). 방에는 아무 영향이 없다.
    async fn reopen_topic(&self, c: &Config, r: &ChatRoom, e: &Error) {
        infof!(None, "telegram: 토픽이 없어져 다시 만든다: {e}");
        if self.topics.remove(&r.id).is_ok() {
            self.open_topic(c, r, topic_name(&r.name), pin_text(r))
                .await;
        }
    }

    /// 짝이 없는 방의 토픽과 고정 글을 만든다. 고정 글을 못 올리면 다음 맞추기에서 다시 올린다.
    async fn open_topic(&self, c: &Config, r: &ChatRoom, name: String, text: String) {
        let p = json!({"chat_id": c.user_id, "name": name});
        let cl = self.client(c);
        let res = with_deadline(
            "createForumTopic",
            CALL_TIMEOUT,
            cl.call::<Option<ForumTopic>>("createForumTopic", Some(&p)),
        )
        .await;
        let thread = match res {
            Ok(Some(t)) if t.message_thread_id != 0 => t.message_thread_id,
            Ok(_) => return,
            Err(e) => {
                infof!(None, "telegram: 토픽을 만들지 못했다: {e}");
                return;
            }
        };
        let mut t = Topic {
            thread_id: thread,
            name,
            ..Topic::default()
        };
        if let Some(id) = self.post_pin(c, thread, r.joined, &text).await {
            t.pin_id = id;
            t.pin_text = text;
        }
        let _ = self.topics.set(&r.id, t);
    }

    /// 안내 글을 올린다. 고정하지 않는다 (CHAT_TELEGRAM_UX_SRS FR-CTU-40). 올린 글의 id 를 돌려준다.
    async fn post_pin(&self, c: &Config, thread: i64, joined: bool, text: &str) -> Option<i64> {
        let p = json!({"chat_id": c.user_id, "message_thread_id": thread, "text": text,
            "parse_mode": "HTML", "reply_markup": pin_keyboard(thread, joined),
            "disable_notification": true});
        let cl = self.client(c);
        let res = with_deadline(
            "sendMessage",
            CALL_TIMEOUT,
            cl.call::<Option<Sent>>("sendMessage", Some(&p)),
        )
        .await;
        let id = match res {
            Ok(Some(s)) if s.message_id != 0 => s.message_id,
            Ok(_) => return None,
            Err(e) => {
                infof!(None, "telegram: 토픽 안내 글을 올리지 못했다: {e}");
                return None;
            }
        };
        Some(id)
    }

    /// 방이 사라진 토픽을 지운다 (FR-TGT-3·4). Telegram 이 거절하면(이미 없음 등) 짝도 지운다. 닿지 못하면 짝을
    /// 남겨 다음 맞추기에서 다시 지운다.
    async fn drop_topic(&self, c: &Config, room: &str) {
        let Some(t) = self.topics.get(room) else {
            return;
        };
        let p = json!({"chat_id": c.user_id, "message_thread_id": t.thread_id});
        match self.call(c, "deleteForumTopic", &p).await {
            Ok(()) => {}
            Err(e) if e.api().is_some() => {
                infof!(
                    None,
                    "telegram: 토픽 지우기를 거절당했다 — 짝만 지운다: {e}"
                );
            }
            Err(e) => {
                infof!(None, "telegram: 토픽을 지우지 못했다: {e}");
                return;
            }
        }
        let _ = self.topics.remove(room);
    }
}

#[cfg(test)]
mod tests;
