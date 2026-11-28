//! ISSUE_TREE_CHAT_SRS FR-TGT-7·8, NFR-ITH-4 — 채팅 글을 거울 토픽에 올린다.

use super::*;
use crate::bridge::chatrig::*;
use crate::bridge::{ChatPerson, ChatRoom};
use crate::render::plain_text;

const AGENT: &str = "fpA-a7";
const REMOTE: &str = "fpB-b2";
const AT_MS: i64 = 1_700_000_000_123;

fn room_with(notify: &str) -> ChatRoom {
    ChatRoom {
        notify: notify.into(),
        people: vec![
            ChatPerson {
                id: ME_ID.into(),
                name: ME_NAME.into(),
                human: false,
            },
            ChatPerson {
                id: AGENT.into(),
                name: "빌드".into(),
                human: false,
            },
        ],
        ..room("r1", "설계", true)
    }
}

fn post(text: &str) -> ChatPost {
    ChatPost {
        room: "r1".into(),
        from: AGENT.into(),
        from_label: "mac/빌드".into(),
        text: text.into(),
        at_ms: AT_MS,
        ..ChatPost::default()
    }
}

async fn ready(notify: &str) -> Rig {
    let r = rig().await;
    r.set_rooms(Some(vec![room_with(notify)]));
    r.sync().await;
    r.reset();
    r
}

impl Rig {
    async fn post(&self, p: ChatPost) {
        self.b.process(Item::ChatPost(p)).await;
    }
    fn posts(&self) -> Vec<Value> {
        self.calls()
            .into_iter()
            .filter(|c| c.method == "sendMessage")
            .map(|c| c.body)
            .collect()
    }
}

/// 채팅 글의 태그는 b · code · pre · 언어 표시 code 뿐이고 여닫이 수가 맞는다.
fn check_tags(text: &str) {
    let re = regex::Regex::new(r"<[^>]*>").unwrap();
    let lang = regex::Regex::new(r#"^<code class="language-[A-Za-z0-9_+-]+">$"#).unwrap();
    let allowed = ["<b>", "</b>", "<code>", "</code>", "<pre>", "</pre>"];
    for m in re.find_iter(text) {
        let t = m.as_str();
        assert!(
            allowed.contains(&t) || lang.is_match(t),
            "허용 목록 밖의 태그 {t}: {text}"
        );
    }
    for tag in ["b", "code", "pre"] {
        let open =
            text.matches(&format!("<{tag}>")).count() + text.matches(&format!("<{tag} ")).count();
        assert_eq!(
            open,
            text.matches(&format!("</{tag}>")).count(),
            "{tag}: {text}"
        );
    }
}

fn head_re() -> regex::Regex {
    regex::Regex::new(r"^<b>([^<]+)</b> \d\d:\d\d").unwrap()
}

/// FR-TGT-7: 글은 그 방의 토픽에 HTML 로 오른다. 머리 줄은 굵은 표시 이름 · 시각 · 부른 상대다. 코드 블록은 pre 다.
#[tokio::test]
async fn post_goes_to_topic_with_head() {
    let r = ready("called").await;
    let mut p = post("안녕 **굵게** `x`\n```rust\nlet a = 1 < 2;\n```");
    p.call = vec!["user".into(), AGENT.into(), "fpZ-zz".into()];
    p.called = true;
    r.post(p).await;
    let ps = r.posts();
    assert_eq!(ps.len(), 1, "{:?}", r.methods());
    let b = &ps[0];
    assert_eq!(b["chat_id"], ME);
    assert_eq!(b["message_thread_id"], THREAD_BASE + 1);
    assert_eq!(b["parse_mode"], "HTML");
    let text = b["text"].as_str().unwrap();
    check_tags(text);
    let first = text.lines().next().unwrap();
    assert_eq!(&head_re().captures(first).unwrap()[1], "빌드", "{first}");
    assert!(first.ends_with(" · @나 @빌드 @fpZ-zz"), "{first}");
    assert!(text.contains("<b>굵게</b> <code>x</code>"), "{text}");
    assert!(
        text.contains("<pre><code class=\"language-rust\">let a = 1 &lt; 2;</code></pre>"),
        "{text}"
    );
}

/// FR-TGT-8: 소리는 사용자의 깨울 글만 낸다 — 단계 called 면 나를 부른 글, all 이면 모든 글, off 면 없음. 내 글은
/// 소리를 내지 않고 머리에 내 이름을 쓴다.
#[tokio::test]
async fn sound_follows_notify_level() {
    // 같은 포트를 다시 잡은 새 가짜 서버로는 재사용된 연결이 닿지 않는다 — rig 하나에서 단계만 바꾼다.
    let r = rig().await;
    for (level, called, mine, sound) in [
        ("called", true, false, true),
        ("called", false, false, false),
        ("", true, false, true),
        ("", false, false, false),
        ("all", false, false, true),
        ("off", true, false, false),
        ("all", true, true, false),
    ] {
        r.set_rooms(Some(vec![room_with(level)]));
        r.sync().await;
        r.reset();
        let mut p = post("hi");
        p.called = called;
        p.mine = mine;
        r.post(p).await;
        let b = &r.posts()[0];
        assert_eq!(
            b["disable_notification"], !sound,
            "level={level} called={called} mine={mine}"
        );
        if mine {
            let first = b["text"]
                .as_str()
                .unwrap()
                .lines()
                .next()
                .unwrap()
                .to_owned();
            assert_eq!(&head_re().captures(&first).unwrap()[1], ME_NAME);
        }
    }
}

/// FR-CUX-9: 다른 노드의 보낸 이는 `<노드> › <탭>` 이다.
#[tokio::test]
async fn remote_sender_name() {
    let r = ready("called").await;
    let mut p = post("hi");
    p.from = REMOTE.into();
    p.from_label = "office/리뷰".into();
    r.post(p).await;
    let text = r.posts()[0]["text"].as_str().unwrap().to_owned();
    assert_eq!(&head_re().captures(&text).unwrap()[1], "office › 리뷰");
}

/// FR-TGT-7: 4,096자를 넘으면 나누어 보낸다. 조각마다 상한 안이고 태그가 맞으며, 나뉜 코드 블록은 다음 조각에서
/// 다시 열린다. 머리와 소리는 첫 조각만이다.
#[tokio::test]
async fn long_post_splits() {
    let r = ready("all").await;
    let mut src = String::from("머리말\n```py\n");
    for i in 0..600 {
        src.push_str(&format!("print('줄 {i:04} <&>')\n"));
    }
    src.push_str("```\n끝맺음 ");
    src.push_str(&"가".repeat(5000));
    r.post(post(&src)).await;
    let ps = r.posts();
    assert!(ps.len() >= 4, "{}", ps.len());
    for (i, b) in ps.iter().enumerate() {
        let text = b["text"].as_str().unwrap();
        check_tags(text);
        let n: usize = plain_text(text).chars().map(char::len_utf16).sum();
        assert!(n <= crate::render::MESSAGE_MAX, "조각 {i}: {n}");
        assert_eq!(b["disable_notification"], i != 0, "조각 {i}");
        assert_eq!(head_re().is_match(text), i == 0, "조각 {i}");
        assert_eq!(b["message_thread_id"], THREAD_BASE + 1);
    }
    assert!(
        ps[1]["text"]
            .as_str()
            .unwrap()
            .starts_with("<pre><code class=\"language-py\">")
    );
    let all: String = ps
        .iter()
        .map(|b| plain_text(b["text"].as_str().unwrap()))
        .collect();
    assert!(all.contains("줄 0000") && all.contains("줄 0599"));
    assert_eq!(all.matches('가').count(), 5000);
}

/// 짝이 없는 방의 글이 먼저 오면 거울을 맞춘 뒤 올린다.
#[tokio::test]
async fn post_before_topic_syncs_first() {
    let r = rig().await;
    r.set_rooms(Some(vec![room_with("called")]));
    r.post(post("hi")).await;
    assert_eq!(
        r.methods(),
        ["createForumTopic", "sendMessage", "sendMessage"]
    );
    assert_eq!(r.posts()[1]["message_thread_id"], THREAD_BASE + 1);
}

/// 보이지 않는 방의 글은 올리지 않는다.
#[tokio::test]
async fn unknown_room_is_dropped() {
    let r = ready("called").await;
    let mut p = post("hi");
    p.room = "r9".into();
    r.post(p).await;
    assert!(r.posts().is_empty(), "{:?}", r.methods());
}

/// NFR-ITH-4: 채팅 토픽이 꺼져 있으면 글을 넣지 않고, 넣어져 있어도 보내지 않는다.
#[tokio::test]
async fn off_posts_nothing() {
    let r = rig_with(false).await;
    r.set_rooms(Some(vec![room_with("all")]));
    r.b.on_chat_post(post("hi"));
    assert_eq!(r.queued(), 0);
    r.post(post("hi")).await;
    assert!(r.methods().is_empty());
}

/// 조각 나누기: 줄 단위로 채우고, 긴 줄은 자르고, 열린 코드 블록은 다시 연다. 빈 글은 빈 조각 하나다.
#[test]
fn split_chunks_rules() {
    assert_eq!(split_chunks("", 10), vec![String::new()]);
    assert_eq!(split_chunks("ab\ncd", 10), vec!["ab\ncd".to_string()]);
    assert_eq!(split_chunks("abcd\nefgh", 6), vec!["abcd", "efgh"]);
    assert_eq!(split_chunks("abcdefghij", 4), vec!["abcd", "efgh", "ij"]);
    assert_eq!(
        split_chunks("```go\naaaa\nbbbb\ncccc\n```", 15),
        vec!["```go\naaaa\nbbbb", "```go\ncccc\n```"]
    );
    let c = split_chunks(&"😀".repeat(5), 4);
    assert_eq!(c, vec!["😀😀", "😀😀", "😀"]);
}

#[test]
fn hh_mm_pads() {
    let t = time::OffsetDateTime::from_unix_timestamp(3600 * 9 + 60 * 5).unwrap();
    assert_eq!(hh_mm(t), "09:05");
}

const THREAD_GONE: &str =
    r#"{"ok":false,"error_code":400,"description":"Bad Request: message thread not found"}"#;

/// FR-TGT-11: 토픽이 없다는 오류가 나면 토픽을 다시 만들고 짝을 고친 뒤 다시 보낸다.
#[tokio::test]
async fn missing_topic_is_recreated() {
    let r = ready("called").await;
    r.fail("sendMessage", 400, THREAD_GONE);
    r.post(post("hi")).await;
    assert_eq!(
        r.methods(),
        [
            "sendMessage",
            "createForumTopic",
            "sendMessage",
            "sendMessage"
        ]
    );
    let ps = r.posts();
    assert_eq!(ps[0]["message_thread_id"], THREAD_BASE + 1);
    assert_eq!(ps[2]["message_thread_id"], THREAD_BASE + 2);
    assert!(head_re().is_match(ps[2]["text"].as_str().unwrap()));
    assert_eq!(r.map().get("r1").unwrap().thread_id, THREAD_BASE + 2);
}

/// 다시 만든 토픽에도 보내지 못하면 그 글은 버린다 — 되풀이하지 않는다.
#[tokio::test]
async fn missing_topic_retries_once() {
    let r = ready("called").await;
    r.fail("sendMessage", 400, THREAD_GONE);
    r.fail(
        "sendMessage",
        200,
        r#"{"ok":true,"result":{"message_id":7}}"#,
    );
    r.fail("sendMessage", 400, THREAD_GONE);
    r.post(post("hi")).await;
    let n = r
        .methods()
        .iter()
        .filter(|m| *m == "createForumTopic")
        .count();
    assert_eq!(n, 1, "{:?}", r.methods());
}
