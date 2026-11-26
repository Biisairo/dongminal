//! 거울 토픽에서 받기 (ISSUE_TREE_CHAT_SRS FR-TGT-6·9·10). 고정 글의 단추는 사람 참가자의 join·leave 이고, 토픽에
//! 쓴 글은 그 방에 사람 글로 오른다. 허용 계정의 것만 받는다 — 판정은 부르는 쪽(on_message·on_callback)이 한다.

use std::collections::VecDeque;
use std::sync::Arc;

use otter_shared_otterlog::infof;
use serde_json::json;

use super::mirror::{ChatPerson, JOIN_PREFIX, LEAVE_PREFIX};
use super::{Bridge, UNSUPPORTED_BUTTON};
use crate::client::{CallbackQuery, Message};
use crate::config::Config;

pub(crate) const JOINED_ANSWER: &str = "들어갔습니다";
pub(crate) const LEFT_ANSWER: &str = "나갔습니다";
pub(crate) const BUTTON_FAILED: &str = "처리하지 못했습니다";
pub(crate) const NOT_JOINED_REPLY: &str =
    "이 방에 들어간 뒤에 쓸 수 있습니다. 맨 위 고정 글의 [들어가기] 를 누르세요.";
pub(crate) const SEND_FAILED_REPLY: &str = "방에 보내지 못했습니다.";
/// 답장한 글의 보낸 이를 찾으려고 기억하는, 토픽에 올린 글의 수.
pub(crate) const SENDERS_MAX: usize = 1024;

/// 토픽에 올린 글 id → 보낸 참가자 id. 오래된 것부터 잊는다.
#[derive(Default)]
pub(crate) struct Senders {
    list: VecDeque<(i64, String)>,
}

impl Senders {
    pub(crate) fn remember(&mut self, msg_id: i64, from: &str) {
        self.list.push_back((msg_id, from.to_owned()));
        while self.list.len() > SENDERS_MAX {
            self.list.pop_front();
        }
    }

    fn of(&self, msg_id: i64) -> Option<String> {
        self.list
            .iter()
            .rev()
            .find(|(id, _)| *id == msg_id)
            .map(|(_, f)| f.clone())
    }
}

/// 본문에서 부른 참가자 (FR-TGT-9). 낱말 처음(글 처음이나 공백 뒤)의 `@` 에 이어진 표시 이름이고, 긴 이름을 먼저
/// 맞춘다. 나는 뺀다. 웹 `chatCallsIn` 과 같은 규칙이다.
pub(crate) fn calls_in(text: &str, people: &[ChatPerson], me: &str) -> Vec<String> {
    let mut cand: Vec<&ChatPerson> = people
        .iter()
        .filter(|p| p.id != me && !p.name.is_empty())
        .collect();
    cand.sort_by_key(|p| std::cmp::Reverse(p.name.chars().count()));
    let mut out: Vec<String> = Vec::new();
    let mut prev: Option<char> = None;
    for (i, ch) in text.char_indices() {
        if ch == '@' && prev.is_none_or(char::is_whitespace) {
            let rest = &text[i + ch.len_utf8()..];
            if let Some(p) = cand.iter().find(|p| rest.starts_with(p.name.as_str()))
                && !out.contains(&p.id)
            {
                out.push(p.id.clone());
            }
        }
        prev = Some(ch);
    }
    out
}

impl Bridge {
    /// 고정 글의 `[들어가기]`·`[나가기]` (FR-TGT-6). 방 단추가 아니면 false 다.
    pub(crate) async fn room_button(&self, c: &Config, q: &CallbackQuery) -> bool {
        let (join, rest) = if let Some(r) = q.data.strip_prefix(JOIN_PREFIX) {
            (true, r)
        } else if let Some(r) = q.data.strip_prefix(LEAVE_PREFIX) {
            (false, r)
        } else {
            return false;
        };
        let room = match rest.parse::<i64>() {
            Ok(t) if c.topics_active() => self.topics.by_thread(t),
            _ => None,
        };
        let Some(room) = room else {
            self.answer(c, &q.id, UNSUPPORTED_BUTTON).await;
            return true;
        };
        let host = Arc::clone(&self.host);
        let res = tokio::task::spawn_blocking(move || host.chat_join(&room, join)).await;
        let text = match res {
            Ok(Ok(())) => {
                self.on_chat_changed();
                if join { JOINED_ANSWER } else { LEFT_ANSWER }
            }
            Ok(Err(e)) => {
                infof!(None, "telegram: 토픽 단추를 처리하지 못했다: {e}");
                BUTTON_FAILED
            }
            Err(_) => BUTTON_FAILED,
        };
        self.answer(c, &q.id, text).await;
        true
    }

    /// 거울 토픽에 쓴 글 (FR-TGT-9). 거울 토픽의 글이 아니면 false 다.
    pub(crate) async fn topic_message(&self, c: &Config, m: &Message) -> bool {
        if !c.topics_active() || m.message_thread_id == 0 {
            return false;
        }
        let Some(room) = self.topics.by_thread(m.message_thread_id) else {
            return false;
        };
        if m.text.trim().is_empty() {
            return true;
        }
        let host = Arc::clone(&self.host);
        let view = tokio::task::spawn_blocking(move || host.chat_view())
            .await
            .ok()
            .flatten();
        let Some(view) = view else {
            self.thread_reply(c, m, SEND_FAILED_REPLY).await;
            return true;
        };
        let Some(r) = view.rooms.iter().find(|r| r.id == room && r.joined) else {
            self.thread_reply(c, m, NOT_JOINED_REPLY).await;
            return true;
        };
        let mut call: Vec<String> = Vec::new();
        if let Some(to) = &m.reply_to_message
            && let Some(from) = self.lock().senders.of(to.message_id)
        {
            call.push(from);
        }
        for id in calls_in(&m.text, &r.people, &view.me.id) {
            if !call.contains(&id) {
                call.push(id);
            }
        }
        let host = Arc::clone(&self.host);
        let text = m.text.clone();
        let res = tokio::task::spawn_blocking(move || host.chat_send(&room, &text, &call)).await;
        if !matches!(res, Ok(Ok(()))) {
            infof!(None, "telegram: 토픽 글을 방에 보내지 못했다");
            self.thread_reply(c, m, SEND_FAILED_REPLY).await;
        }
        true
    }

    async fn thread_reply(&self, c: &Config, m: &Message, text: &str) {
        let p =
            json!({"chat_id": m.chat.id, "message_thread_id": m.message_thread_id, "text": text});
        let _ = self.call(c, "sendMessage", &p).await;
    }
}

#[cfg(test)]
mod tests;
