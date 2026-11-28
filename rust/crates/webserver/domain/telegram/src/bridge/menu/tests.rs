//! CHAT_TELEGRAM_UX_SRS 묶음 T — 일반 대화의 메뉴 키보드, 방 만들기, 접속자와 개인채팅.

use super::*;
use crate::bridge::chatrig::*;
use crate::client::{CallbackQuery, Chat, Message, Update, User};
use serde_json::Value;
use time::Duration as TimeDuration;

const AGENT: &str = "fpA-a7";
const REMOTE: &str = "fpB-u2";

async fn ready(topics: bool) -> Rig {
    let r = rig_with(topics).await;
    r.set_rooms(Some(Vec::new()));
    r.reset();
    r
}

fn msg(text: &str) -> Message {
    Message {
        message_id: 900,
        from: Some(User {
            id: ME,
            ..User::default()
        }),
        chat: Chat {
            id: ME,
            kind: "private".into(),
        },
        text: text.into(),
        ..Message::default()
    }
}

impl Rig {
    async fn say(&self, text: &str) {
        self.b
            .handle_update(Update {
                message: Some(msg(text)),
                ..Update::default()
            })
            .await;
    }
    async fn press(&self, data: &str) {
        self.b
            .handle_update(Update {
                callback_query: Some(CallbackQuery {
                    id: "cb".into(),
                    from: User {
                        id: ME,
                        ..User::default()
                    },
                    data: data.into(),
                    message: Some(Message {
                        message_id: 3,
                        chat: Chat {
                            id: ME,
                            kind: "private".into(),
                        },
                        ..Message::default()
                    }),
                }),
                ..Update::default()
            })
            .await;
    }
    fn last_send(&self) -> Value {
        self.calls()
            .into_iter()
            .rev()
            .find(|c| c.method == "sendMessage")
            .expect("보낸 글이 없다")
            .body
    }
    fn last_answer(&self) -> String {
        let c = self.calls();
        let a = c
            .iter()
            .rev()
            .find(|c| c.method == "answerCallbackQuery")
            .expect("버튼에 답하지 않았다");
        a.body["text"].as_str().unwrap().to_owned()
    }
    fn set_online(&self, list: Vec<ChatOnline>) {
        *self.host.online.lock().unwrap() = Some(list);
    }
}

fn online(id: &str, name: &str, node: &str, human: bool) -> ChatOnline {
    ChatOnline {
        id: id.into(),
        name: name.into(),
        node: node.into(),
        human,
    }
}

fn keyboard_texts(v: &Value) -> Vec<String> {
    v["reply_markup"]["keyboard"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|row| row.as_array().cloned().unwrap_or_default())
        .map(|b| b["text"].as_str().unwrap_or_default().to_owned())
        .collect()
}

fn inline_data(v: &Value) -> Vec<String> {
    v["reply_markup"]["inline_keyboard"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|row| row.as_array().cloned().unwrap_or_default())
        .map(|b| b["callback_data"].as_str().unwrap_or_default().to_owned())
        .collect()
}

/// V-CTU-20: 토픽이 꺼져 있으면 지금과 같다.
#[tokio::test]
async fn topics_off_keeps_alarm_only_reply() {
    let r = ready(false).await;
    r.say("안녕").await;
    let s = r.last_send();
    assert_eq!(s["text"], "이 봇은 알림만 보냅니다.");
    assert!(s.get("reply_markup").is_none(), "{s}");
}

/// V-CTU-21: 토픽이 켜져 있으면 일반 글에 늘 보이는 키보드를 단다.
#[tokio::test]
async fn general_message_gets_menu_keyboard() {
    let r = ready(true).await;
    r.say("안녕").await;
    let s = r.last_send();
    assert_eq!(s["text"], MENU_TEXT);
    assert_eq!(keyboard_texts(&s), vec![MENU_CREATE, MENU_WHO]);
    assert_eq!(s["reply_markup"]["is_persistent"], true);
}

/// V-CTU-22: 이름 → 목적 → 만들기. 답하고 맞추기를 넣는다.
#[tokio::test]
async fn create_room_asks_name_then_purpose() {
    let r = ready(true).await;
    r.say(MENU_CREATE).await;
    let s = r.last_send();
    assert_eq!(s["text"], ASK_NAME);
    assert_eq!(s["reply_markup"]["force_reply"], true);
    r.say("배포").await;
    let s = r.last_send();
    assert_eq!(s["text"], ASK_PURPOSE);
    assert_eq!(inline_data(&s), vec![SKIP_DATA]);
    let _ = r.queued();
    r.say("배포 점검").await;
    assert_eq!(
        r.host.creates.lock().unwrap().clone(),
        vec![("배포".to_string(), "배포 점검".to_string())]
    );
    assert!(r.last_send()["text"].as_str().unwrap().contains("배포"));
    assert_eq!(r.queued(), 1, "맞추기를 넣지 않았다");
    r.say("다음 글").await;
    assert_eq!(
        r.host.creates.lock().unwrap().len(),
        1,
        "입력이 끝났는데 또 만들었다"
    );
    assert_eq!(r.last_send()["text"], MENU_TEXT);
}

/// V-CTU-23: `[건너뛰기]` 는 목적을 비운다.
#[tokio::test]
async fn skip_purpose_creates_with_empty_purpose() {
    let r = ready(true).await;
    r.say(MENU_CREATE).await;
    r.say("배포").await;
    r.press(SKIP_DATA).await;
    assert_eq!(
        r.host.creates.lock().unwrap().clone(),
        vec![("배포".to_string(), String::new())]
    );
}

/// V-CTU-23: 진행 중인 목적 물음이 없으면 `[건너뛰기]` 는 아무것도 만들지 않는다.
#[tokio::test]
async fn skip_without_pending_does_nothing() {
    let r = ready(true).await;
    r.press(SKIP_DATA).await;
    assert!(r.host.creates.lock().unwrap().is_empty());
    assert_eq!(r.last_answer(), MENU_EXPIRED);
}

/// V-CTU-24: 만들기 실패를 답한다.
#[tokio::test]
async fn create_failure_is_reported() {
    let r = ready(true).await;
    *r.host.fail.lock().unwrap() = true;
    r.say(MENU_CREATE).await;
    r.say("배포").await;
    r.press(SKIP_DATA).await;
    let t = r.last_send()["text"].as_str().unwrap().to_owned();
    assert!(t.starts_with(CREATE_FAILED), "{t}");
    assert!(t.contains("no_such_room"), "{t}");
}

/// V-CTU-25: 10분 지난 입력은 버린다.
#[tokio::test]
async fn pending_expires() {
    let r = ready(true).await;
    r.say(MENU_CREATE).await;
    r.b.lock()
        .menu
        .age_pending(MENU_PENDING_TTL + TimeDuration::seconds(1));
    r.say("배포").await;
    assert_eq!(r.last_send()["text"], MENU_TEXT);
    assert!(r.host.creates.lock().unwrap().is_empty());
}

/// V-CTU-25: 메뉴 단추는 진행 중인 입력을 버리고 그 단추를 처리한다.
#[tokio::test]
async fn menu_button_cancels_pending() {
    let r = ready(true).await;
    r.set_online(Vec::new());
    r.say(MENU_CREATE).await;
    r.say(MENU_WHO).await;
    assert_eq!(r.last_send()["text"], WHO_EMPTY);
    r.say("배포").await;
    assert_eq!(r.last_send()["text"], MENU_TEXT);
    assert!(r.host.creates.lock().unwrap().is_empty());
}

/// V-CTU-26: 접속자 — 나 제외, 노드별(내 노드 먼저), 참가자마다 단추.
#[tokio::test]
async fn who_lists_online_by_node() {
    let r = ready(true).await;
    r.set_online(vec![
        online(ME_ID, ME_NAME, "mac", true),
        online(REMOTE, "linux › User", "linux", true),
        online(AGENT, "빌드", "mac", false),
    ]);
    r.say(MENU_WHO).await;
    let s = r.last_send();
    let text = s["text"].as_str().unwrap();
    assert!(!text.contains(ME_NAME), "{text}");
    let mac = text.find("<b>mac</b>").expect(text);
    let linux = text.find("<b>linux</b>").expect(text);
    assert!(mac < linux, "내 노드가 먼저가 아니다: {text}");
    assert!(text.contains("빌드 · 에이전트"), "{text}");
    assert!(text.contains("linux › User · 사람"), "{text}");
    assert_eq!(inline_data(&s).len(), 2);
}

/// V-CTU-26: 아무도 없으면 그렇게 답한다.
#[tokio::test]
async fn who_empty() {
    let r = ready(true).await;
    r.set_online(vec![online(ME_ID, ME_NAME, "mac", true)]);
    r.say(MENU_WHO).await;
    assert_eq!(r.last_send()["text"], WHO_EMPTY);
}

/// V-CTU-26: 단추는 상한까지만이다.
#[tokio::test]
async fn who_caps_buttons() {
    let r = ready(true).await;
    let many = (0..MENU_WHO_MAX + 5)
        .map(|i| online(&format!("fpA-a{i}"), &format!("a{i}"), "mac", false))
        .collect();
    r.set_online(many);
    r.say(MENU_WHO).await;
    assert_eq!(inline_data(&r.last_send()).len(), MENU_WHO_MAX);
}

/// V-CTU-27: 개인채팅 단추는 그 참가자와의 direct 다. 낡은 목록의 단추는 거절한다.
#[tokio::test]
async fn dm_button_opens_direct() {
    let r = ready(true).await;
    r.set_online(vec![online(AGENT, "빌드", "mac", false)]);
    r.say(MENU_WHO).await;
    let first = inline_data(&r.last_send())[0].clone();
    let _ = r.queued();
    r.press(&first).await;
    assert_eq!(
        r.host.directs.lock().unwrap().clone(),
        vec![AGENT.to_string()]
    );
    assert_eq!(r.last_answer(), DM_OPENED);
    assert_eq!(r.queued(), 1, "맞추기를 넣지 않았다");
    r.say(MENU_WHO).await;
    r.press(&first).await;
    assert_eq!(
        r.host.directs.lock().unwrap().len(),
        1,
        "낡은 단추로 열었다"
    );
    assert_eq!(r.last_answer(), WHO_STALE);
}

/// FR-CTU-27: 허용 계정이 아니면 답하지 않는다.
#[tokio::test]
async fn stranger_is_ignored() {
    let r = ready(true).await;
    let mut m = msg(MENU_CREATE);
    m.from = Some(User {
        id: 77,
        ..User::default()
    });
    r.b.handle_update(Update {
        message: Some(m),
        ..Update::default()
    })
    .await;
    assert!(r.calls().is_empty());
}
