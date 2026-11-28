//! ISSUE_TREE_CHAT_SRS FR-TGT-6·9·10 — 토픽의 단추와 글을 방으로 받는다.

use super::*;
use crate::bridge::chatrig::*;
use crate::bridge::mirror::{JOIN_PREFIX, LEAVE_PREFIX};
use crate::bridge::{ChatPerson, ChatPost, ChatRoom, Item};
use crate::client::{CallbackQuery, Chat, Message, Update, User};
use serde_json::Value;

const OTHER: i64 = 77;
const AGENT: &str = "fpA-a7";
const BOT2: &str = "fpA-a8";
const THREAD: i64 = THREAD_BASE + 1;

fn room_with(joined: bool) -> ChatRoom {
    ChatRoom {
        people: vec![
            ChatPerson {
                id: ME_ID.into(),
                name: ME_NAME.into(),
            },
            ChatPerson {
                id: AGENT.into(),
                name: "빌드".into(),
            },
            ChatPerson {
                id: BOT2.into(),
                name: "빌드봇".into(),
            },
        ],
        ..room("r1", "설계", joined)
    }
}

async fn ready(joined: bool) -> Rig {
    let r = rig().await;
    r.set_rooms(Some(vec![room_with(joined)]));
    r.sync().await;
    r.reset();
    let _ = r.queued();
    r
}

fn msg(from: i64, thread: i64, text: &str) -> Message {
    Message {
        message_id: 900,
        from: Some(User {
            id: from,
            ..User::default()
        }),
        chat: Chat {
            id: from,
            kind: "private".into(),
        },
        text: text.into(),
        message_thread_id: thread,
        ..Message::default()
    }
}

impl Rig {
    async fn tg_msg(&self, m: Message) {
        self.b
            .handle_update(Update {
                message: Some(m),
                ..Update::default()
            })
            .await;
    }
    async fn tg_press(&self, from: i64, data: &str) {
        self.b
            .handle_update(Update {
                callback_query: Some(CallbackQuery {
                    id: "cb".into(),
                    from: User {
                        id: from,
                        ..User::default()
                    },
                    data: data.into(),
                    message: Some(Message {
                        message_id: 2,
                        chat: Chat {
                            id: from,
                            kind: "private".into(),
                        },
                        message_thread_id: THREAD,
                        ..Message::default()
                    }),
                }),
                ..Update::default()
            })
            .await;
    }
    fn joins(&self) -> Vec<(String, bool)> {
        self.host.joins.lock().unwrap().clone()
    }
    fn sends(&self) -> Vec<(String, String, Vec<String>)> {
        self.host.sends.lock().unwrap().clone()
    }
    fn answer(&self) -> String {
        let c = self.calls();
        let a = c
            .iter()
            .rev()
            .find(|c| c.method == "answerCallbackQuery")
            .expect("버튼에 답하지 않았다");
        a.body["text"].as_str().unwrap().to_owned()
    }
    fn replies(&self) -> Vec<Value> {
        self.calls()
            .into_iter()
            .filter(|c| c.method == "sendMessage")
            .map(|c| c.body)
            .collect()
    }
}

/// FR-TGT-6: `[들어가기]`·`[나가기]` 는 사람 참가자의 join·leave 다. 처리한 뒤 거울을 다시 맞추게 한다.
#[tokio::test]
async fn buttons_join_and_leave() {
    let r = ready(false).await;
    r.tg_press(ME, &format!("{JOIN_PREFIX}{THREAD}")).await;
    assert_eq!(r.joins(), vec![("r1".to_string(), true)]);
    assert_eq!(r.answer(), JOINED_ANSWER);
    assert_eq!(r.queued(), 1, "맞추기를 넣지 않았다");
    r.tg_press(ME, &format!("{LEAVE_PREFIX}{THREAD}")).await;
    assert_eq!(r.joins()[1], ("r1".to_string(), false));
    assert_eq!(r.answer(), LEFT_ANSWER);
}

/// 처리하지 못하면 그렇게 답하고, 모르는 토픽·꺼진 채팅 토픽의 단추는 지원하지 않는다고 답한다.
#[tokio::test]
async fn button_failures() {
    let r = ready(false).await;
    *r.host.fail.lock().unwrap() = true;
    r.tg_press(ME, &format!("{JOIN_PREFIX}{THREAD}")).await;
    assert_eq!(r.answer(), BUTTON_FAILED);
    *r.host.fail.lock().unwrap() = false;
    r.tg_press(ME, &format!("{JOIN_PREFIX}999")).await;
    assert_eq!(r.answer(), "지원하지 않는 버튼입니다.");
    r.tg_press(ME, &format!("{JOIN_PREFIX}x")).await;
    assert_eq!(r.answer(), "지원하지 않는 버튼입니다.");
    r.st.set_chat_topics(false).unwrap();
    r.tg_press(ME, &format!("{JOIN_PREFIX}{THREAD}")).await;
    assert_eq!(r.answer(), "지원하지 않는 버튼입니다.");
    assert!(r.joins().is_empty());
}

/// FR-TGT-10: 허용 계정이 아닌 단추와 글은 무시한다.
#[tokio::test]
async fn strangers_are_ignored() {
    let r = ready(true).await;
    r.tg_press(OTHER, &format!("{JOIN_PREFIX}{THREAD}")).await;
    r.tg_msg(msg(OTHER, THREAD, "hi")).await;
    assert!(r.calls().is_empty(), "{:?}", r.methods());
    assert!(r.joins().is_empty() && r.sends().is_empty());
}

/// FR-TGT-9: 들어가 있는 방의 토픽 글은 그 방에 사람 글로 오른다. 본문의 `@이름`(긴 이름 먼저)과 답장한 글의
/// 보낸 이를 부른다. 나는 부르지 않는다.
#[tokio::test]
async fn topic_message_goes_to_room() {
    let r = ready(true).await;
    r.tg_msg(msg(ME, THREAD, "그냥 글")).await;
    r.tg_msg(msg(ME, THREAD, "@빌드봇 확인 @빌드 그리고 @나 메일a@빌드"))
        .await;
    assert_eq!(
        r.sends(),
        vec![
            ("r1".to_string(), "그냥 글".to_string(), vec![]),
            (
                "r1".to_string(),
                "@빌드봇 확인 @빌드 그리고 @나 메일a@빌드".to_string(),
                vec![BOT2.to_string(), AGENT.to_string()]
            ),
        ]
    );
    assert!(r.replies().is_empty(), "{:?}", r.replies());
}

/// FR-TGT-9: 토픽에 올린 글에 답장하면 그 글의 보낸 이를 부른다.
#[tokio::test]
async fn reply_calls_original_sender() {
    let r = ready(true).await;
    r.b.process(Item::ChatPost(ChatPost {
        room: "r1".into(),
        from: AGENT.into(),
        from_label: "mac/빌드".into(),
        text: "질문".into(),
        ..ChatPost::default()
    }))
    .await;
    // 가짜 서버의 message_id 는 호출 차례다.
    let sent_id = r.calls().len() as i64;
    let mut m = msg(ME, THREAD, "답");
    m.reply_to_message = Some(Box::new(Message {
        message_id: sent_id,
        ..Message::default()
    }));
    r.tg_msg(m).await;
    let mut topic = msg(ME, THREAD, "토픽 첫 글에 단 답");
    topic.reply_to_message = Some(Box::new(Message {
        message_id: 99_999,
        ..Message::default()
    }));
    r.tg_msg(topic).await;
    assert_eq!(r.sends()[0].2, vec![AGENT.to_string()]);
    assert!(r.sends()[1].2.is_empty());
}

/// FR-TGT-9: 들어가 있지 않으면 올리지 않고 토픽에 안내한다. 보내지 못하면 그렇게 알린다.
#[tokio::test]
async fn not_joined_or_failed_send_replies() {
    let r = ready(false).await;
    r.tg_msg(msg(ME, THREAD, "hi")).await;
    assert!(r.sends().is_empty());
    let rep = r.replies();
    assert_eq!(rep.len(), 1);
    assert_eq!(rep[0]["message_thread_id"], THREAD);
    assert_eq!(rep[0]["chat_id"], ME);
    assert_eq!(rep[0]["text"], NOT_JOINED_REPLY);
    let r = ready(true).await;
    *r.host.fail.lock().unwrap() = true;
    r.tg_msg(msg(ME, THREAD, "hi")).await;
    assert_eq!(r.replies()[0]["text"], SEND_FAILED_REPLY);
}

/// 모르는 토픽의 글은 지금처럼 안내만 한다. 토픽 밖의 글은 메뉴 키보드로 답한다(CHAT_TELEGRAM_UX_SRS FR-CTU-21).
/// 빈 글(사진 등)은 방에 올리지 않는다.
#[tokio::test]
async fn other_messages_keep_old_reply() {
    let r = ready(true).await;
    r.tg_msg(msg(ME, 0, "hi")).await;
    r.tg_msg(msg(ME, 4242, "hi")).await;
    r.tg_msg(msg(ME, THREAD, "")).await;
    assert!(r.sends().is_empty());
    let texts: Vec<Value> = r.replies().iter().map(|b| b["text"].clone()).collect();
    assert_eq!(
        texts,
        vec![crate::bridge::menu::MENU_TEXT, "이 봇은 알림만 보냅니다."]
    );
}

/// NFR-ITH-4: 채팅 토픽이 꺼져 있으면 토픽 글도 지금처럼 안내만 한다.
#[tokio::test]
async fn off_keeps_old_reply() {
    let r = ready(true).await;
    r.st.set_chat_topics(false).unwrap();
    r.tg_msg(msg(ME, THREAD, "hi")).await;
    assert!(r.sends().is_empty());
    assert_eq!(r.replies()[0]["text"], "이 봇은 알림만 보냅니다.");
    assert!(r.replies()[0].get("message_thread_id").is_none());
}

#[test]
fn calls_in_rules() {
    let people = room_with(true).people;
    assert_eq!(calls_in("@빌드", &people, ME_ID), vec![AGENT.to_string()]);
    assert_eq!(calls_in("@빌드봇", &people, ME_ID), vec![BOT2.to_string()]);
    assert!(calls_in("a@빌드 @나", &people, ME_ID).is_empty());
    assert_eq!(
        calls_in("@빌드 @빌드\n@빌드봇", &people, ME_ID),
        vec![AGENT.to_string(), BOT2.to_string()]
    );
}
