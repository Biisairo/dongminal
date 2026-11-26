//! ISSUE_TREE_CHAT_SRS FR-TGT-3·4·5, NFR-ITH-4 — 방의 거울 토픽 맞추기.
//!
//! Telegram 은 가짜 서버, 채팅 상태는 가짜 Host 다. 맞추기는 process 로 하나씩 처리한다.

use super::*;
use crate::bridge::chatrig::*;

const NOT_FOUND: &str =
    r#"{"ok":false,"error_code":400,"description":"Bad Request: TOPIC_ID_INVALID"}"#;

/// FR-TGT-3·5: 짝이 없는 방은 토픽을 만들고, 고정 안내 글을 올려 고정한 뒤 짝을 저장한다.
#[tokio::test]
async fn new_room_opens_topic_and_pin() {
    let r = rig().await;
    r.set_rooms(Some(vec![room("r1", "설계", false)]));
    r.sync().await;
    assert_eq!(
        r.methods(),
        ["createForumTopic", "sendMessage", "pinChatMessage"]
    );
    let calls = r.calls();
    assert_eq!(calls[0].body["chat_id"], ME);
    assert_eq!(calls[0].body["name"], "설계");
    let thread = THREAD_BASE + 1;
    let send = &calls[1].body;
    assert_eq!(send["chat_id"], ME);
    assert_eq!(send["message_thread_id"], thread);
    assert_eq!(send["parse_mode"], "HTML");
    assert_eq!(send["disable_notification"], true);
    let text = send["text"].as_str().unwrap();
    assert!(text.contains("<b>설계</b>"), "{text}");
    assert!(text.contains("설계 논의"), "{text}");
    assert!(text.contains("참가자 3명"), "{text}");
    assert!(text.contains(NOT_JOINED_TEXT), "{text}");
    let btn = &send["reply_markup"]["inline_keyboard"][0][0];
    assert_eq!(btn["text"], JOIN_TEXT);
    assert_eq!(btn["callback_data"], format!("{JOIN_PREFIX}{thread}"));
    assert_eq!(calls[2].body["message_id"], 2);
    assert_eq!(calls[2].body["chat_id"], ME);
    let t = r.map().get("r1").expect("짝을 저장하지 않았다");
    assert_eq!(t.thread_id, thread);
    assert_eq!(t.pin_id, 2);
    assert_eq!(t.name, "설계");
    assert_eq!(t.pin_text, text);
}

/// FR-TGT-5: 바뀐 것이 없으면 Telegram 에 아무것도 보내지 않는다.
#[tokio::test]
async fn unchanged_rooms_send_nothing() {
    let r = rig().await;
    r.set_rooms(Some(vec![
        room("r1", "설계", false),
        room("r2", "리뷰", true),
    ]));
    r.sync().await;
    r.reset();
    r.sync().await;
    assert!(r.methods().is_empty(), "{:?}", r.methods());
}

/// FR-TGT-3·5: 이름이 바뀌면 토픽 이름을, 들어감·참가자 수가 바뀌면 고정 글과 단추를 고친다.
#[tokio::test]
async fn changes_edit_topic_and_pin() {
    let r = rig().await;
    r.set_rooms(Some(vec![room("r1", "설계", false)]));
    r.sync().await;
    r.reset();
    r.set_rooms(Some(vec![room("r1", "설계2", false)]));
    r.sync().await;
    assert_eq!(r.methods(), ["editForumTopic", "editMessageText"]);
    let c = r.calls();
    assert_eq!(c[0].body["message_thread_id"], THREAD_BASE + 1);
    assert_eq!(c[0].body["name"], "설계2");
    r.reset();
    let mut joined = room("r1", "설계2", true);
    joined.members = 4;
    r.set_rooms(Some(vec![joined]));
    r.sync().await;
    assert_eq!(r.methods(), ["editMessageText"]);
    let b = &r.calls()[0].body;
    assert_eq!(b["message_id"], 2);
    assert_eq!(b["parse_mode"], "HTML");
    let text = b["text"].as_str().unwrap();
    assert!(text.contains("참가자 4명"), "{text}");
    assert!(text.contains(JOINED_TEXT), "{text}");
    let btn = &b["reply_markup"]["inline_keyboard"][0][0];
    assert_eq!(btn["text"], LEAVE_TEXT);
    assert_eq!(
        btn["callback_data"],
        format!("{LEAVE_PREFIX}{}", THREAD_BASE + 1)
    );
    assert_eq!(r.map().get("r1").unwrap().pin_text, text);
}

/// FR-TGT-3·4: 짝만 있고 방이 없으면 토픽을 지우고 짝도 지운다.
#[tokio::test]
async fn gone_room_deletes_topic() {
    let r = rig().await;
    r.set_rooms(Some(vec![
        room("r1", "설계", false),
        room("r2", "리뷰", false),
    ]));
    r.sync().await;
    r.reset();
    r.set_rooms(Some(vec![room("r2", "리뷰", false)]));
    r.sync().await;
    assert_eq!(r.methods(), ["deleteForumTopic"]);
    let b = &r.calls()[0].body;
    assert_eq!(b["chat_id"], ME);
    assert_eq!(b["message_thread_id"], THREAD_BASE + 1);
    assert_eq!(r.map().get("r1"), None);
    assert!(r.map().get("r2").is_some());
}

/// FR-TGT-4: 서버를 다시 시작해도 짝을 이어 쓴다 — 지난 짝의 방이 없으면 지운다.
#[tokio::test]
async fn restart_keeps_pairs() {
    let r = rig().await;
    r.set_rooms(Some(vec![
        room("r1", "설계", false),
        room("r2", "리뷰", false),
    ]));
    r.sync().await;
    r.reset();
    let b2 = Bridge::new(
        Arc::clone(&r.st),
        r.host.clone(),
        &r.srv.url,
        Arc::new(time::OffsetDateTime::now_utc),
    );
    r.set_rooms(Some(vec![room("r2", "리뷰", false)]));
    b2.process(Item::ChatSync).await;
    assert_eq!(r.methods(), ["deleteForumTopic"]);
}

/// Telegram 이 지우기를 거절하면(이미 없음) 짝을 지운다. 닿지 못하면 짝을 남겨 다음에 다시 지운다.
#[tokio::test]
async fn delete_failures() {
    let r = rig().await;
    r.set_rooms(Some(vec![
        room("r1", "설계", false),
        room("r2", "리뷰", false),
    ]));
    r.sync().await;
    r.set_rooms(Some(vec![]));
    r.fail("deleteForumTopic", 400, NOT_FOUND);
    r.fail("deleteForumTopic", 502, "bad gateway");
    r.reset();
    r.sync().await;
    assert_eq!(r.methods(), ["deleteForumTopic", "deleteForumTopic"]);
    assert_eq!(r.map().get("r1"), None);
    assert!(r.map().get("r2").is_some(), "닿지 못한 짝을 지웠다");
    r.reset();
    r.sync().await;
    assert_eq!(r.methods(), ["deleteForumTopic"]);
    assert!(r.map().rooms().is_empty());
}

/// 방 목록을 읽지 못하면(데몬 없음) 아무것도 보내지 않고 짝도 지우지 않는다.
#[tokio::test]
async fn unreadable_rooms_change_nothing() {
    let r = rig().await;
    r.set_rooms(Some(vec![room("r1", "설계", false)]));
    r.sync().await;
    r.reset();
    r.set_rooms(None);
    r.sync().await;
    assert!(r.methods().is_empty());
    assert!(r.map().get("r1").is_some());
}

/// 토픽을 만들지 못하면 짝을 남기지 않고, 다음 맞추기에서 다시 만든다.
#[tokio::test]
async fn create_failure_retries_next_sync() {
    let r = rig().await;
    r.set_rooms(Some(vec![room("r1", "설계", false)]));
    r.fail(
        "createForumTopic",
        429,
        r#"{"ok":false,"error_code":429,"description":"Too Many Requests"}"#,
    );
    r.sync().await;
    assert_eq!(r.methods(), ["createForumTopic"]);
    assert_eq!(r.map().get("r1"), None);
    r.reset();
    r.sync().await;
    assert_eq!(
        r.methods(),
        ["createForumTopic", "sendMessage", "pinChatMessage"]
    );
    assert!(r.map().get("r1").is_some());
}

/// 고정 글을 올리지 못하면 토픽 짝만 남기고, 다음 맞추기에서 고정 글을 다시 올린다.
#[tokio::test]
async fn pin_failure_retries_next_sync() {
    let r = rig().await;
    r.set_rooms(Some(vec![room("r1", "설계", false)]));
    r.fail("sendMessage", 502, "bad gateway");
    r.sync().await;
    assert_eq!(r.methods(), ["createForumTopic", "sendMessage"]);
    let t = r.map().get("r1").unwrap();
    assert_eq!((t.thread_id, t.pin_id), (THREAD_BASE + 1, 0));
    r.reset();
    r.sync().await;
    assert_eq!(r.methods(), ["sendMessage", "pinChatMessage"]);
    assert_eq!(r.calls()[0].body["message_thread_id"], THREAD_BASE + 1);
    assert_ne!(r.map().get("r1").unwrap().pin_id, 0);
}

/// NFR-ITH-4: 채팅 토픽이 꺼져 있으면 맞추기를 넣지 않고, 넣어져 있어도 Telegram 에 아무것도 보내지 않는다.
#[tokio::test]
async fn off_sends_nothing() {
    let r = rig_with(false).await;
    r.set_rooms(Some(vec![room("r1", "설계", false)]));
    r.b.on_chat_changed();
    assert_eq!(r.queued(), 0);
    r.sync().await;
    assert!(r.methods().is_empty());
    // 켠 뒤에 브리지를 끄면(전제 하나가 빠지면) 역시 없는 것과 같다.
    r.st.set_chat_topics(true).unwrap();
    r.st.set_enabled(false).unwrap();
    r.b.on_chat_changed();
    assert_eq!(r.queued(), 0);
    r.sync().await;
    assert!(r.methods().is_empty());
}

/// 처리하지 않은 맞추기가 있으면 하나로 합친다. 처리를 시작하면 다시 넣을 수 있다.
#[tokio::test]
async fn changes_coalesce() {
    let r = rig().await;
    r.b.on_chat_changed();
    r.b.on_chat_changed();
    r.b.on_chat_changed();
    assert_eq!(r.queued(), 1);
    r.set_rooms(Some(vec![]));
    r.sync().await;
    r.b.on_chat_changed();
    assert_eq!(r.queued(), 1);
}

/// FR-CUX-9: 표시 이름 규칙은 웹과 같다.
#[test]
fn display_names() {
    let me = "fpA-u1";
    assert_eq!(display_name("mac/설계탭", "fpA-a7", me), "설계탭");
    assert_eq!(display_name("office/리뷰", "fpB-a7", me), "office › 리뷰");
    assert_eq!(display_name("이름만", "fpB-a7", me), "이름만");
    assert_eq!(display_name("", "fpB-a7", me), "");
}

/// 토픽 이름은 비면 기본 이름, 길면 128자에서 자른다. 단추 데이터는 64바이트 안이다.
#[test]
fn topic_name_and_button_limits() {
    assert_eq!(topic_name("  "), UNNAMED_TOPIC);
    assert_eq!(topic_name(" 설계 "), "설계");
    let long: String = "가".repeat(TOPIC_NAME_MAX + 10);
    assert_eq!(topic_name(&long).chars().count(), TOPIC_NAME_MAX);
    let kb = pin_keyboard(i64::MAX, false);
    let data = kb["inline_keyboard"][0][0]["callback_data"]
        .as_str()
        .unwrap();
    assert!(data.len() <= 64, "{data}");
}

/// 고정 글은 방 값을 HTML 이스케이프한다. 목적이 없으면 그 줄을 뺀다.
#[test]
fn pin_text_escapes() {
    let mut r = room("r1", "<a&b>", true);
    r.purpose = String::new();
    let t = pin_text(&r);
    assert_eq!(
        t,
        format!("<b>&lt;a&amp;b&gt;</b>\n참가자 3명 · {JOINED_TEXT}")
    );
}

/// FR-TGT-11: 토픽 이름이나 고정 글을 고치다 토픽이 없다는 오류가 나면 토픽을 다시 만든다.
#[tokio::test]
async fn missing_topic_on_edit_is_recreated() {
    let r = rig().await;
    r.set_rooms(Some(vec![room("r1", "설계", false)]));
    r.sync().await;
    r.reset();
    r.set_rooms(Some(vec![room("r1", "설계2", false)]));
    r.fail("editForumTopic", 400, NOT_FOUND);
    r.sync().await;
    assert_eq!(
        r.methods(),
        [
            "editForumTopic",
            "createForumTopic",
            "sendMessage",
            "pinChatMessage"
        ]
    );
    let t = r.map().get("r1").unwrap();
    assert_eq!((t.thread_id, t.name.as_str()), (THREAD_BASE + 2, "설계2"));
    r.reset();
    r.set_rooms(Some(vec![room("r1", "설계2", true)]));
    r.fail("editMessageText", 400, NOT_FOUND);
    r.sync().await;
    assert_eq!(
        r.methods(),
        [
            "editMessageText",
            "createForumTopic",
            "sendMessage",
            "pinChatMessage"
        ]
    );
    assert_eq!(r.map().get("r1").unwrap().thread_id, THREAD_BASE + 3);
}

/// 토픽 관련 Bot API 메서드.
const TOPIC_METHODS: &[&str] = &[
    "createForumTopic",
    "editForumTopic",
    "deleteForumTopic",
    "pinChatMessage",
    "editMessageText",
];

/// NFR-ITH-4 (TC-ITH-13): 채팅 토픽을 끄면 맞추기 · 글 · 토픽 글 · 단추 어느 길로도 토픽 요청을 보내지 않는다.
#[tokio::test]
async fn off_makes_no_topic_requests() {
    let r = rig().await;
    r.set_rooms(Some(vec![room("r1", "설계", true)]));
    r.sync().await;
    r.st.set_chat_topics(false).unwrap();
    r.reset();
    r.set_rooms(Some(vec![room("r1", "설계2", false)]));
    r.b.on_chat_changed();
    r.b.on_chat_post(crate::bridge::ChatPost {
        room: "r1".into(),
        text: "hi".into(),
        ..Default::default()
    });
    assert_eq!(r.queued(), 0);
    r.sync().await;
    r.b.process(Item::ChatPost(crate::bridge::ChatPost {
        room: "r1".into(),
        text: "hi".into(),
        ..Default::default()
    }))
    .await;
    let thread = THREAD_BASE + 1;
    r.b.handle_update(crate::client::Update {
        message: Some(crate::client::Message {
            from: Some(crate::client::User {
                id: ME,
                ..Default::default()
            }),
            chat: crate::client::Chat {
                id: ME,
                kind: "private".into(),
            },
            text: "hi".into(),
            message_thread_id: thread,
            ..Default::default()
        }),
        ..Default::default()
    })
    .await;
    for c in r.calls() {
        assert!(!TOPIC_METHODS.contains(&c.method.as_str()), "{c:?}");
        assert!(c.body.get("message_thread_id").is_none(), "{c:?}");
    }
}

/// FR-TGT-12: 채팅 토픽이 켜져 있어도 기존 알림은 토픽 밖 일반 대화로 간다.
#[tokio::test]
async fn alarms_stay_outside_topics() {
    let r = rig().await;
    r.set_rooms(Some(vec![room("r1", "설계", true)]));
    r.sync().await;
    r.reset();
    r.b.process(Item::Attention {
        tool: "tool-A".into(),
        reason: "done".into(),
    })
    .await;
    let c = r.calls();
    assert_eq!(c.len(), 1, "{c:?}");
    assert_eq!(c[0].method, "sendMessage");
    assert_eq!(c[0].body["chat_id"], ME);
    assert!(c[0].body.get("message_thread_id").is_none());
}
