//! 채팅 글을 거울 토픽에 올린다 (ISSUE_TREE_CHAT_SRS FR-TGT-7·8). 머리 줄은 굵은 표시 이름 · 시각 · 부른 상대다.
//! 본문은 Telegram HTML 이고, 4,096자를 넘으면 원문을 줄 단위로 나누어 차례로 보낸다. 나뉜 코드 블록은 다음
//! 조각에서 다시 연다. 소리는 사용자의 깨울 글의 첫 조각만 낸다.

use otter_gocompat::time::{local, to_zone};
use otter_shared_otterlog::infof;
use serde_json::{Map, Value, json};
use time::OffsetDateTime;

use super::mirror::{ChatView, topic_missing};
use super::{Bridge, Item};
use crate::config::Config;
use crate::render::{MESSAGE_MAX, chat_md_html, esc};

/// 부른 상대가 사람 참가자(나)일 때 쓰는 이름 (FR-CUX-7 의 `@나`).
pub(crate) const ME_CALL_NAME: &str = "나";
/// 사람 참가자를 부르는 call 항목 (FR-CAL-1).
const CALL_USER: &str = "user";
const NOTIFY_ALL: &str = "all";
const NOTIFY_OFF: &str = "off";
const FENCE: &str = "```";
/// 머리 줄과 다시 연 코드 블록 줄을 위해 조각마다 남겨 두는 UTF-16 단위.
const CHUNK_RESERVE: usize = 256;
/// 원문 한 조각의 상한(UTF-16 단위). 옮긴 HTML 의 보이는 글은 원문보다 길지 않다.
pub(crate) const CHUNK_MAX: usize = MESSAGE_MAX - CHUNK_RESERVE;
const MS_PER_SEC: i64 = 1000;
/// 토픽에 올릴 글 하나 (FR-TGT-7). 서버가 채팅 데몬의 글이나 내가 보낸 글에서 옮긴다.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ChatPost {
    pub room: String,
    /// 보낸 참가자 id 와 원래 이름(`<노드>/<탭>`). 내 글이면 비어도 된다.
    pub from: String,
    pub from_label: String,
    pub text: String,
    /// 보낸 시각(유닉스 밀리초).
    pub at_ms: i64,
    /// 부른 상대(참가자 id 또는 `user`).
    pub call: Vec<String>,
    /// 사람 참가자를 부른 글인가 (FR-CAL-4).
    pub called: bool,
    /// 사람 참가자(나)가 보낸 글인가.
    pub mine: bool,
}

impl Bridge {
    /// 채팅 글을 토픽에 올리게 한다. 채팅 토픽이 꺼져 있으면 넣지 않는다 (NFR-ITH-4).
    pub fn on_chat_post(&self, p: ChatPost) {
        if !self.st.config().topics_active() {
            return;
        }
        self.push(Item::ChatPost(p));
    }

    /// 글을 그 방의 토픽에 올린다. 짝이 없으면 먼저 거울을 맞춘다 — 방이 생기자마자 온 글이다.
    pub(crate) async fn post_chat(&self, c: &Config, p: ChatPost) {
        if !c.topics_active() {
            return;
        }
        if self.topics.get(&p.room).is_none() {
            self.sync_topics(c).await;
        }
        let Some(t) = self.topics.get(&p.room) else {
            infof!(None, "telegram: 글의 방에 토픽이 없다 — 올리지 않는다");
            return;
        };
        let view = self
            .view
            .lock()
            .unwrap_or_else(|x| x.into_inner())
            .clone()
            .unwrap_or_default();
        let head = post_head(&view, &p);
        let sound = wakes(&view, &p);
        let mut thread = t.thread_id;
        let mut reopened = false;
        for (i, chunk) in split_chunks(&p.text, CHUNK_MAX).iter().enumerate() {
            let body = chat_md_html(chunk);
            let text = if i == 0 {
                format!("{head}\n{body}")
            } else {
                body
            };
            let mut m = Map::new();
            m.insert("chat_id".into(), json!(c.user_id));
            m.insert("text".into(), Value::String(text));
            m.insert("parse_mode".into(), json!("HTML"));
            m.insert("disable_notification".into(), json!(!(sound && i == 0)));
            loop {
                m.insert("message_thread_id".into(), json!(thread));
                match self.send_alarm(c, m.clone()).await {
                    Ok(s) => {
                        if !p.mine {
                            self.lock().senders.remember(s.message_id, &p.from);
                        }
                        break;
                    }
                    // 토픽이 없어졌다 — 짝을 지우고 다시 맞춘 뒤 한 번만 다시 보낸다 (FR-TGT-11).
                    Err(e) if topic_missing(&e) && !reopened => {
                        reopened = true;
                        infof!(None, "telegram: 토픽이 없어져 다시 만든다: {e}");
                        let _ = self.topics.remove(&p.room);
                        self.sync_topics(c).await;
                        match self.topics.get(&p.room) {
                            Some(t) => thread = t.thread_id,
                            None => return,
                        }
                    }
                    Err(e) => {
                        infof!(None, "telegram: 토픽에 글을 올리지 못했다: {e}");
                        return;
                    }
                }
            }
        }
    }
}

/// 사용자의 깨울 글인가 (FR-TGT-8 · FR-CAL-5·7). 내 글은 깨우지 않는다. 방의 알림 단계가 all 이면 모든 글,
/// off 면 없음, 그 밖(called·빈 값)이면 나를 부른 글이다.
pub(crate) fn wakes(view: &ChatView, p: &ChatPost) -> bool {
    if p.mine {
        return false;
    }
    let level = view
        .rooms
        .iter()
        .find(|r| r.id == p.room)
        .map_or("", |r| r.notify.as_str());
    match level {
        NOTIFY_ALL => true,
        NOTIFY_OFF => false,
        _ => p.called,
    }
}

/// 머리 줄: `<b>보낸 이</b> HH:MM` 에 부른 상대가 있으면 ` · @이름 …` 을 붙인다 (FR-TGT-7).
pub(crate) fn post_head(view: &ChatView, p: &ChatPost) -> String {
    let from = if p.mine {
        view.me.name.clone()
    } else {
        super::display_name(&p.from_label, &p.from, &view.me.id)
    };
    let mut head = format!("<b>{}</b> {}", esc(&from), clock(p.at_ms));
    let names: Vec<String> = p
        .call
        .iter()
        .map(|id| call_name(view, &p.room, id))
        .collect();
    if !names.is_empty() {
        let tags: Vec<String> = names.iter().map(|n| format!("@{}", esc(n))).collect();
        head.push_str(" · ");
        head.push_str(&tags.join(" "));
    }
    head
}

fn call_name(view: &ChatView, room: &str, id: &str) -> String {
    if id == CALL_USER || id == view.me.id {
        return ME_CALL_NAME.to_owned();
    }
    view.rooms
        .iter()
        .find(|r| r.id == room)
        .and_then(|r| r.people.iter().find(|q| q.id == id))
        .map_or_else(|| id.to_owned(), |q| q.name.clone())
}

/// 이 PC 의 시간대로 본 `HH:MM`.
fn clock(at_ms: i64) -> String {
    let t = OffsetDateTime::from_unix_timestamp(at_ms.div_euclid(MS_PER_SEC))
        .unwrap_or(OffsetDateTime::UNIX_EPOCH);
    hh_mm(to_zone(t, local()))
}

pub(crate) fn hh_mm(t: OffsetDateTime) -> String {
    format!("{:02}:{:02}", t.hour(), t.minute())
}

fn units(s: &str) -> usize {
    s.chars().map(char::len_utf16).sum()
}

/// 원문을 limit UTF-16 단위 안의 조각으로 나눈다. 줄 단위로 채우고, 한 줄이 넘치면 글자 단위로 자른다. 조각 끝에서
/// 열려 있던 코드 블록은 다음 조각 앞에서 같은 여는 줄로 다시 연다.
pub(crate) fn split_chunks(text: &str, limit: usize) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut open: Option<String> = None;
    for line in text.split('\n') {
        for seg in split_line(line, limit) {
            let need = units(&seg) + usize::from(!cur.is_empty());
            if !cur.is_empty() && units(&cur) + need > limit {
                out.push(std::mem::take(&mut cur));
                if let Some(o) = &open {
                    cur.push_str(o);
                }
            }
            if !cur.is_empty() {
                cur.push('\n');
            }
            cur.push_str(&seg);
        }
        if line.trim().starts_with(FENCE) {
            open = match open {
                Some(_) => None,
                None => Some(line.trim().to_owned()),
            };
        }
    }
    if !cur.is_empty() || out.is_empty() {
        out.push(cur);
    }
    out
}

fn split_line(line: &str, limit: usize) -> Vec<String> {
    if units(line) <= limit {
        return vec![line.to_owned()];
    }
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut n = 0;
    for ch in line.chars() {
        let w = ch.len_utf16();
        if n + w > limit {
            out.push(std::mem::take(&mut cur));
            n = 0;
        }
        cur.push(ch);
        n += w;
    }
    out.push(cur);
    out
}

#[cfg(test)]
mod tests;
