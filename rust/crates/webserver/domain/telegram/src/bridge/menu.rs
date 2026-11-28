//! 일반 대화의 메뉴 (CHAT_TELEGRAM_UX_SRS 묶음 T). 늘 보이는 키보드의 `방 만들기`·`접속자` 단추, 방 이름·목적 묻기,
//! 접속자 목록의 개인채팅 단추다. 채팅 토픽이 켜져 있을 때만 있다 (FR-CTU-20). 허용 계정 판정은 부르는 쪽이 한다.

use std::sync::Arc;

use otter_shared_otterlog::infof;
use serde_json::{Value, json};
use time::{Duration as TimeDuration, OffsetDateTime};

use super::Bridge;
use crate::client::{CallbackQuery, Message};
use crate::config::Config;
use crate::render::esc;

pub(crate) const MENU_CREATE: &str = "방 만들기";
pub(crate) const MENU_WHO: &str = "접속자";
pub(crate) const MENU_TEXT: &str = "아래 단추로 방을 만들거나 접속자를 봅니다.";
pub(crate) const ASK_NAME: &str = "새 방의 이름을 보내세요.";
pub(crate) const ASK_PURPOSE: &str = "방의 목적을 보내세요. 없으면 [건너뛰기] 를 누르세요.";
const SKIP_LABEL: &str = "건너뛰기";
pub(crate) const SKIP_DATA: &str = "menu:skip";
const DM_PREFIX: &str = "dm:";
const DM_LABEL_PREFIX: &str = "개인채팅: ";
pub(crate) const CREATE_FAILED: &str = "방을 만들지 못했습니다";
pub(crate) const MENU_EXPIRED: &str = "입력이 끝났거나 시간이 지났습니다";
pub(crate) const WHO_EMPTY: &str = "접속한 참가자가 없습니다.";
const WHO_FAILED: &str = "접속자를 읽지 못했습니다.";
pub(crate) const WHO_STALE: &str = "목록이 바뀌었습니다. 다시 [접속자] 를 누르세요.";
pub(crate) const DM_OPENED: &str = "개인채팅을 열었습니다";
const DM_FAILED: &str = "개인채팅을 열지 못했습니다";
const KIND_HUMAN: &str = "사람";
const KIND_AGENT: &str = "에이전트";
/// 방 만들기의 물음에 답을 기다리는 시간 (FR-CTU-24).
pub(crate) const MENU_PENDING_TTL: TimeDuration = TimeDuration::minutes(10);
/// 접속자 목록에 다는 개인채팅 단추의 상한 (FR-CTU-25).
pub(crate) const MENU_WHO_MAX: usize = 50;

/// 접속한 참가자 하나 (FR-CTU-25). 서버가 채팅 상태에서 옮긴다. name 은 표시 이름(FR-CUX-9), node 는 노드 이름이다.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ChatOnline {
    pub id: String,
    pub name: String,
    pub node: String,
    pub human: bool,
}

enum Step {
    Name,
    Purpose(String),
}

/// 진행 중인 입력과 마지막으로 보낸 접속자 목록.
#[derive(Default)]
pub(crate) struct Menu {
    pending: Option<(Step, OffsetDateTime)>,
    who: Vec<String>,
    generation: u32,
}

impl Menu {
    /// 진행 중인 입력을 꺼낸다. 시간이 지났으면 버린다 (FR-CTU-24).
    fn take_live(&mut self, now: OffsetDateTime) -> Option<Step> {
        let (step, at) = self.pending.take()?;
        (now - at <= MENU_PENDING_TTL).then_some(step)
    }

    #[cfg(test)]
    pub(crate) fn age_pending(&mut self, by: TimeDuration) {
        if let Some((_, at)) = &mut self.pending {
            *at -= by;
        }
    }
}

/// 늘 보이는 키보드 (FR-CTU-21).
pub(crate) fn menu_keyboard() -> Value {
    json!({"keyboard": [[{"text": MENU_CREATE}, {"text": MENU_WHO}]],
        "resize_keyboard": true, "is_persistent": true})
}

fn created_text(name: &str) -> String {
    format!("방 「{name}」 을 만들었습니다. 같은 이름의 토픽에서 대화하세요.")
}

/// 접속자 목록의 차례: 내 노드 먼저, 다른 노드는 이름 차례, 노드 안에서는 사람 먼저·이름 차례다 (FR-CUX-12 와 같다).
fn who_order(list: Vec<ChatOnline>, me: &str) -> Vec<ChatOnline> {
    let my_node = list
        .iter()
        .find(|p| p.id == me)
        .map(|p| p.node.clone())
        .unwrap_or_default();
    let mut people: Vec<ChatOnline> = list.into_iter().filter(|p| p.id != me).collect();
    people.sort_by(|a, b| {
        (a.node != my_node)
            .cmp(&(b.node != my_node))
            .then_with(|| a.node.cmp(&b.node))
            .then_with(|| b.human.cmp(&a.human))
            .then_with(|| a.name.cmp(&b.name))
    });
    people
}

fn who_text(people: &[ChatOnline]) -> String {
    let mut out = format!("<b>{}</b>", esc(MENU_WHO));
    let mut node: Option<&str> = None;
    for p in people {
        if node != Some(p.node.as_str()) {
            out.push_str(&format!("\n\n<b>{}</b>", esc(&p.node)));
            node = Some(p.node.as_str());
        }
        let kind = if p.human { KIND_HUMAN } else { KIND_AGENT };
        out.push_str(&format!("\n• {} · {kind}", esc(&p.name)));
    }
    out
}

impl Bridge {
    /// 일반 대화의 글 (FR-CTU-21~25). 이 묶음의 글이 아니면(토픽이 꺼졌거나 토픽 안의 글) false 다.
    pub(crate) async fn menu_message(&self, c: &Config, m: &Message) -> bool {
        if !c.topics_active() || m.message_thread_id != 0 {
            return false;
        }
        let text = m.text.trim();
        let now = (self.now)();
        if text == MENU_CREATE {
            self.lock().menu.pending = Some((Step::Name, now));
            self.menu_send(c, ASK_NAME, json!({"force_reply": true}), false)
                .await;
            return true;
        }
        if text == MENU_WHO {
            self.lock().menu.pending = None;
            self.who(c).await;
            return true;
        }
        let step = self.lock().menu.take_live(now);
        match step {
            Some(Step::Name) if !text.is_empty() => {
                self.lock().menu.pending = Some((Step::Purpose(text.to_owned()), now));
                let skip = json!({"inline_keyboard": [[{"text": SKIP_LABEL, "callback_data": SKIP_DATA}]]});
                self.menu_send(c, ASK_PURPOSE, skip, false).await;
            }
            Some(Step::Purpose(name)) => self.create_room(c, &name, text).await,
            _ => self.menu_send(c, MENU_TEXT, menu_keyboard(), false).await,
        }
        true
    }

    /// `[건너뛰기]` 와 개인채팅 단추 (FR-CTU-22·26). 이 묶음의 단추가 아니면 false 다.
    pub(crate) async fn menu_button(&self, c: &Config, q: &CallbackQuery) -> bool {
        if !c.topics_active() {
            return false;
        }
        if q.data == SKIP_DATA {
            let step = self.lock().menu.take_live((self.now)());
            match step {
                Some(Step::Purpose(name)) => {
                    self.answer(c, &q.id, SKIP_LABEL).await;
                    self.create_room(c, &name, "").await;
                }
                other => {
                    if let Some(s @ Step::Name) = other {
                        self.lock().menu.pending = Some((s, (self.now)()));
                    }
                    self.answer(c, &q.id, MENU_EXPIRED).await;
                }
            }
            return true;
        }
        let Some(rest) = q.data.strip_prefix(DM_PREFIX) else {
            return false;
        };
        let target = rest
            .split_once(':')
            .and_then(|(g, i)| Some((g.parse::<u32>().ok()?, i.parse::<usize>().ok()?)))
            .and_then(|(g, i)| {
                let st = self.lock();
                if st.menu.generation == g {
                    st.menu.who.get(i).cloned()
                } else {
                    None
                }
            });
        let Some(id) = target else {
            self.answer(c, &q.id, WHO_STALE).await;
            return true;
        };
        let host = Arc::clone(&self.host);
        let res = tokio::task::spawn_blocking(move || host.chat_direct(&id)).await;
        let text = match res {
            Ok(Ok(())) => {
                self.on_chat_changed();
                DM_OPENED
            }
            Ok(Err(e)) => {
                infof!(None, "telegram: 개인채팅을 열지 못했다: {e}");
                DM_FAILED
            }
            Err(_) => DM_FAILED,
        };
        self.answer(c, &q.id, text).await;
        true
    }

    async fn who(&self, c: &Config) {
        let host = Arc::clone(&self.host);
        let read =
            tokio::task::spawn_blocking(move || (host.chat_online(), host.chat_view())).await;
        let Ok((Some(list), view)) = read else {
            self.menu_send(c, WHO_FAILED, Value::Null, false).await;
            return;
        };
        let me = view.map(|v| v.me.id).unwrap_or_default();
        let people = who_order(list, &me);
        if people.is_empty() {
            self.menu_send(c, WHO_EMPTY, Value::Null, false).await;
            return;
        }
        let shown: Vec<&ChatOnline> = people.iter().take(MENU_WHO_MAX).collect();
        let generation = {
            let mut st = self.lock();
            st.menu.generation = st.menu.generation.wrapping_add(1);
            st.menu.who = shown.iter().map(|p| p.id.clone()).collect();
            st.menu.generation
        };
        let rows: Vec<Value> = shown
            .iter()
            .enumerate()
            .map(|(i, p)| {
                json!([{"text": format!("{DM_LABEL_PREFIX}{}", p.name),
                    "callback_data": format!("{DM_PREFIX}{generation}:{i}")}])
            })
            .collect();
        self.menu_send(
            c,
            &who_text(&people),
            json!({"inline_keyboard": rows}),
            true,
        )
        .await;
    }

    async fn create_room(&self, c: &Config, name: &str, purpose: &str) {
        let host = Arc::clone(&self.host);
        let (n, p) = (name.to_owned(), purpose.to_owned());
        let res = tokio::task::spawn_blocking(move || host.chat_create(&n, &p)).await;
        let text = match res {
            Ok(Ok(())) => {
                self.on_chat_changed();
                created_text(name)
            }
            Ok(Err(e)) => format!("{CREATE_FAILED}: {e}"),
            Err(_) => CREATE_FAILED.to_owned(),
        };
        self.menu_send(c, &text, Value::Null, false).await;
    }

    /// 일반 대화로 보낸다. markup 이 Null 이면 달지 않는다.
    pub(crate) async fn menu_send(&self, c: &Config, text: &str, markup: Value, html: bool) {
        let mut p = json!({"chat_id": c.user_id, "text": text});
        if !markup.is_null() {
            p["reply_markup"] = markup;
        }
        if html {
            p["parse_mode"] = json!("HTML");
        }
        let _ = self.call(c, "sendMessage", &p).await;
    }
}

#[cfg(test)]
mod tests;
