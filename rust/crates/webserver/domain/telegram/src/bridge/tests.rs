//! Go `bridge*_test.go`·`client_test.go` (TELEGRAM_BRIDGE_SRS TC-TGB-2·10·11·40~49·80, ATTIC_FIX
//! TC-ATF-40~43·76, REFACTOR3 TC-RD3-40·41, QUALITY_GO TC-QG-20) 를 옮겼다.
//!
//! Telegram 은 가짜 서버, otterminal 은 가짜 Host 다. 사건은 process 로 하나씩 처리한다.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Mutex as StdMutex;
use std::sync::atomic::AtomicUsize;
use std::time::Instant;

use super::*;
use crate::client::{Chat, User};
use crate::render::tests::check_tags;
use crate::render::{CONTENT_MAX, CUT_MARK, DIVIDER};
use crate::testsrv::{self, Handler, Server};

const ME: i64 = 42;
const TAB_A: &str = "tool-A";
const TEST_TOKEN: &str = "123456:SECRET-token-value";
const LOC_A: &str = "<code>Server :</code> <b>macmini</b>\n<code>Window :</code> <b>otterminal</b>\n<code>Tab    :</code> <b>API 리팩터</b>";

#[derive(Clone)]
struct Call {
    method: String,
    body: Value,
    raw: Vec<u8>,
}

#[derive(Default)]
struct FakeTg {
    calls: Vec<Call>,
    fail_edits: HashSet<i64>,
    send_fails: VecDeque<(u16, String)>,
}

type Tg = Arc<StdMutex<FakeTg>>;

fn tg_handler(tg: Tg) -> Handler {
    Arc::new(move |method, raw| {
        let tg = Arc::clone(&tg);
        Box::pin(async move {
            let body: Value = serde_json::from_slice(&raw).unwrap_or(Value::Null);
            let mut f = tg.lock().unwrap();
            f.calls.push(Call {
                method: method.clone(),
                body: body.clone(),
                raw,
            });
            let id = f.calls.len();
            if method == "sendMessage"
                && let Some(fail) = f.send_fails.pop_front()
            {
                return fail;
            }
            if method == "editMessageReplyMarkup"
                && f.fail_edits
                    .contains(&body["message_id"].as_i64().unwrap_or(-1))
            {
                return (
                    429,
                    r#"{"ok":false,"error_code":429,"description":"Too Many Requests"}"#.to_owned(),
                );
            }
            if method == "sendMessage" {
                return (
                    200,
                    format!(r#"{{"ok":true,"result":{{"message_id":{id}}}}}"#),
                );
            }
            (200, r#"{"ok":true,"result":true}"#.to_owned())
        })
    })
}

fn methods(tg: &Tg) -> Vec<String> {
    tg.lock()
        .unwrap()
        .calls
        .iter()
        .map(|c| c.method.clone())
        .collect()
}

fn last(tg: &Tg, method: &str) -> Option<Call> {
    tg.lock()
        .unwrap()
        .calls
        .iter()
        .rev()
        .find(|c| c.method == method)
        .cloned()
}

fn edited(tg: &Tg) -> Vec<i64> {
    tg.lock()
        .unwrap()
        .calls
        .iter()
        .filter(|c| c.method == "editMessageReplyMarkup")
        .map(|c| c.body["message_id"].as_i64().unwrap())
        .collect()
}

#[derive(Default)]
struct FakeHost {
    last_in: StdMutex<HashMap<String, OffsetDateTime>>,
    locs: StdMutex<HashMap<String, Location>>,
    attends: StdMutex<Vec<String>>,
}

impl Host for FakeHost {
    fn last_browser_input(&self, tool: &str) -> Option<OffsetDateTime> {
        self.last_in.lock().unwrap().get(tool).copied()
    }
    fn location(&self, tool: &str) -> Location {
        self.locs
            .lock()
            .unwrap()
            .get(tool)
            .cloned()
            .unwrap_or(Location {
                device: "mac".into(),
                window: String::new(),
                tab: tool.into(),
            })
    }
    fn attend(&self, tool: &str, typed: bool) {
        let s = if typed { "typed" } else { "seen" };
        self.attends.lock().unwrap().push(format!("{tool}|{s}"));
    }
}

struct Rig {
    b: Arc<Bridge>,
    tg: Tg,
    host: Arc<FakeHost>,
    st: Arc<Store>,
    now: OffsetDateTime,
    dir: tempfile::TempDir,
    _srv: Server,
}

fn store_in(dir: &tempfile::TempDir) -> Arc<Store> {
    let st = Arc::new(Store::open(dir.path().join("telegram.json")));
    st.set_token(TEST_TOKEN, "office_bot").unwrap();
    st.set_user(ME).unwrap();
    st.set_enabled(true).unwrap();
    st
}

fn fixed_now(t: OffsetDateTime) -> NowFn {
    Arc::new(move || t)
}

async fn rig() -> Rig {
    let tg: Tg = Arc::default();
    let srv = testsrv::serve(tg_handler(Arc::clone(&tg))).await;
    let dir = tempfile::tempdir().unwrap();
    let st = store_in(&dir);
    let host = Arc::new(FakeHost::default());
    host.locs.lock().unwrap().insert(
        TAB_A.into(),
        Location {
            device: "macmini".into(),
            window: "otterminal".into(),
            tab: "API 리팩터".into(),
        },
    );
    let now = OffsetDateTime::from_unix_timestamp(10_000).unwrap();
    let b = Bridge::new(Arc::clone(&st), host.clone(), &srv.url, fixed_now(now));
    Rig {
        b,
        tg,
        host,
        st,
        now,
        dir,
        _srv: srv,
    }
}

impl Rig {
    async fn act(&self, ev: Event) {
        self.b.process(Item::Activity(ev)).await;
    }
    async fn attn(&self, tool: &str, reason: &str) {
        self.b
            .process(Item::Attention {
                tool: tool.into(),
                reason: reason.into(),
            })
            .await;
    }
    async fn clear(&self, tool: &str) {
        self.b.process(Item::Clear(tool.into())).await;
    }
    async fn msg(&self, from: i64, text: &str) {
        self.b
            .handle_update(Update {
                message: Some(Message {
                    from: Some(User {
                        id: from,
                        ..User::default()
                    }),
                    chat: Chat {
                        id: from,
                        kind: "private".into(),
                    },
                    text: text.into(),
                    ..Message::default()
                }),
                ..Update::default()
            })
            .await;
    }
    async fn press(&self, from: i64, data: &str) {
        self.press_on(from, data, 5).await;
    }
    async fn press_on(&self, from: i64, data: &str, msg_id: i64) {
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
                        message_id: msg_id,
                        chat: Chat {
                            id: from,
                            kind: String::new(),
                        },
                        ..Message::default()
                    }),
                }),
                ..Update::default()
            })
            .await;
    }
    /// 마지막 알림의 `[✓ 읽음]` 버튼 데이터. 없으면 빈 글이다.
    fn read_data(&self) -> String {
        let Some(c) = last(&self.tg, "sendMessage") else {
            return String::new();
        };
        let rows = &c.body["reply_markup"]["inline_keyboard"];
        match rows.as_array() {
            Some(r) if r.len() == 1 && r[0].as_array().is_some_and(|x| x.len() == 1) => {
                let b = &r[0][0];
                if b["text"] != "읽음" {
                    return String::new();
                }
                b["callback_data"].as_str().unwrap_or_default().to_owned()
            }
            _ => String::new(),
        }
    }
    /// 마지막 알림. 알림은 허용 계정의 1:1 대화방으로 간다 (FR-TGB-50).
    fn sent(&self) -> String {
        let c = last(&self.tg, "sendMessage").expect("알림을 보내지 않았다");
        assert_eq!(c.body["chat_id"], ME, "{}", c.body);
        assert_eq!(c.body["parse_mode"], "HTML", "{}", c.body);
        assert!(c.body.get("message_thread_id").is_none());
        let text = c.body["text"].as_str().unwrap().to_owned();
        check_tags(&text);
        text
    }
    fn sends(&self) -> usize {
        methods(&self.tg)
            .iter()
            .filter(|m| *m == "sendMessage")
            .count()
    }
    fn buttons(&self, tool: &str) -> Option<Vec<i64>> {
        self.b.lock().buttons.get(tool).cloned()
    }
    fn tp(&self, lines: &[String]) -> String {
        let p = self.dir.path().join("s.jsonl");
        let mut body = String::new();
        for l in lines {
            body.push_str(l);
            body.push('\n');
        }
        std::fs::write(&p, body).unwrap();
        p.to_string_lossy().into_owned()
    }
    fn fake_sleep(&self) -> Arc<StdMutex<Vec<Duration>>> {
        let w: Arc<StdMutex<Vec<Duration>>> = Arc::default();
        let w2 = Arc::clone(&w);
        *self.b.sleep.lock().unwrap() = Arc::new(move |d| {
            w2.lock().unwrap().push(d);
            Box::pin(async {})
        });
        w
    }
    fn fail_sends(&self, fs: &[(u16, &str)]) {
        let mut f = self.tg.lock().unwrap();
        for (c, b) in fs {
            f.send_fails.push_back((*c, (*b).to_owned()));
        }
    }
}

fn ev(tool: &str, hook: &str) -> Event {
    Event {
        tool_id: tool.into(),
        hook: hook.into(),
        ..Event::default()
    }
}

fn reply_line(text: &str) -> String {
    format!(
        r#"{{"type":"assistant","isSidechain":false,"message":{{"content":[{{"type":"text","text":{}}}]}}}}"#,
        serde_json::to_string(text).unwrap()
    )
}

fn want_has(text: &str, parts: &[&str]) {
    for p in parts {
        assert!(text.contains(p), "{p:?} 가 없다:\n{text}");
    }
}

/// 접힌 문단에서 구분선 아래의 내용. 없으면 빈 글이다.
fn folded(text: &str) -> String {
    let sep = format!("\n\n{DIVIDER}\n\n");
    let Some((_, rest)) = text.split_once(&sep) else {
        return String::new();
    };
    rest.split_once("</blockquote>")
        .map(|(a, _)| a)
        .unwrap_or(rest)
        .to_owned()
}

fn units(s: &str) -> usize {
    s.chars().map(char::len_utf16).sum()
}

// ── 허용 계정 (TC-TGB-10·11) ──

#[tokio::test]
async fn ignores_stranger() {
    let r = rig().await;
    r.msg(7, "/agents").await;
    r.msg(7, "hello").await;
    r.press(7, &format!("r:{TAB_A}")).await;
    assert!(methods(&r.tg).is_empty(), "모르는 사람에게 답했다");
}

#[tokio::test]
async fn pair_command() {
    let r = rig().await;
    r.st.set_user(0).unwrap();
    let (code, _) = r.b.pairing().issue();
    r.msg(77, "/pair 000000").await;
    assert_eq!(r.st.config().user_id, 0, "틀린 코드로 등록됐다");
    r.msg(77, &format!("/pair {code}")).await;
    assert_eq!(r.st.config().user_id, 77);
    let c = last(&r.tg, "sendMessage").unwrap();
    assert_eq!(c.body["chat_id"], 77);
    assert_eq!(
        c.body["text"],
        "등록했습니다. 이제 이 대화방으로 알림을 보냅니다."
    );
}

#[tokio::test]
async fn pair_wrong_code_from_owner_replies() {
    let r = rig().await;
    r.b.pairing().issue();
    r.msg(ME, "/pair 1").await;
    let c = last(&r.tg, "sendMessage").unwrap();
    assert_eq!(c.body["text"], "코드가 틀렸거나 지났습니다.");
}

#[tokio::test]
async fn pair_save_failure_replies() {
    let r = rig().await;
    r.st.set_user(0).unwrap();
    let (code, _) = r.b.pairing().issue();
    let blocker = r.dir.path().join("file");
    std::fs::write(&blocker, b"").unwrap();
    r.st.set_path(blocker.join("telegram.json"));
    r.msg(77, &format!("/pair {code}")).await;
    let c = last(&r.tg, "sendMessage").expect("저장 실패를 알리지 않았다");
    assert_eq!(c.body["chat_id"], 77);
    assert!(c.body["text"].as_str().unwrap().contains("저장하지 못했"));
    assert_eq!(r.st.config().user_id, 0);
}

#[tokio::test]
async fn owner_gets_notice_only() {
    let r = rig().await;
    r.msg(ME, "/agents").await;
    let c = last(&r.tg, "sendMessage").unwrap();
    assert!(c.body["text"].as_str().unwrap().contains("알림만"));
    r.press(ME, "c:1:2").await;
    let a = last(&r.tg, "answerCallbackQuery").unwrap();
    assert_eq!(a.body["callback_query_id"], "cb");
    assert!(a.body["text"].as_str().unwrap().contains("지원하지 않는"));
}

// ── 알림 (TC-TGB-40~45) ──

#[tokio::test]
async fn done_carries_last_reply_folded() {
    let r = rig().await;
    let tp = r.tp(&[
        reply_line("앞 응답"),
        reply_line("```\nx\n```"),
        reply_line("모두 고쳤습니다. <b>태그</b> & 끝"),
    ]);
    r.act(Event {
        transcript: tp.clone(),
        ..ev(TAB_A, "UserPromptSubmit")
    })
    .await;
    r.act(Event {
        transcript: tp,
        ..ev(TAB_A, "Stop")
    })
    .await;
    r.attn(TAB_A, "done").await;
    let text = r.sent();
    let head = text.split(DIVIDER).next().unwrap();
    assert_eq!(
        head,
        format!("✅ <b>완료</b>\n<blockquote expandable>{LOC_A}\n\n")
    );
    assert_eq!(
        folded(&text),
        "모두 고쳤습니다. &lt;b&gt;태그&lt;/b&gt; &amp; 끝"
    );
}

#[tokio::test]
async fn stop_failure_is_error() {
    let r = rig().await;
    r.act(Event {
        detail: "rate_limit".into(),
        ..ev(TAB_A, "StopFailure")
    })
    .await;
    r.attn(TAB_A, "done").await;
    let text = r.sent();
    want_has(&text, &["❌", "<b>오류</b>"]);
    assert_eq!(folded(&text), "rate_limit");
    r.act(ev(TAB_A, "UserPromptSubmit")).await;
    r.act(ev(TAB_A, "Stop")).await;
    r.attn(TAB_A, "done").await;
    want_has(&r.sent(), &["✅"]);
}

#[tokio::test]
async fn question_alarm() {
    let r = rig().await;
    let input = r#"{"questions":[{"header":"색","question":"어느 색?","options":[{"label":"빨강","description":"따뜻함"},{"label":"파랑"}]}]}"#.as_bytes();
    r.act(Event {
        tool: ASK_TOOL.into(),
        input: input.to_vec(),
        ..ev(TAB_A, "PreToolUse")
    })
    .await;
    r.act(Event {
        tool: ASK_TOOL.into(),
        ..ev(TAB_A, "PermissionRequest")
    })
    .await;
    r.attn(TAB_A, "waiting").await;
    let text = r.sent();
    want_has(
        &text,
        &[&format!(
            "❓ <b>질문</b>\n<blockquote expandable>{LOC_A}\n\n{DIVIDER}\n\n"
        )],
    );
    assert_eq!(
        folded(&text),
        "<b>[색] 어느 색?</b>\n1. 빨강 — 따뜻함\n2. 파랑"
    );
}

#[tokio::test]
async fn permission_alarm() {
    let r = rig().await;
    r.act(Event {
        tool: "Bash".into(),
        ..ev(TAB_A, "PreToolUse")
    })
    .await;
    r.act(Event {
        tool: "Bash".into(),
        input: br#"{"command":"rm -rf build && make"}"#.to_vec(),
        ..ev(TAB_A, "PermissionRequest")
    })
    .await;
    r.attn(TAB_A, "waiting").await;
    let text = r.sent();
    want_has(&text, &["🔐 <b>권한 요청</b> · Bash\n"]);
    assert_eq!(folded(&text), "<code>rm -rf build &amp;&amp; make</code>");
    r.act(Event {
        tool: "Write".into(),
        input_over: true,
        detail: "/src/big.go".into(),
        ..ev(TAB_A, "PermissionRequest")
    })
    .await;
    r.attn(TAB_A, "waiting").await;
    assert_eq!(folded(&r.sent()), "<code>/src/big.go</code>");
    r.act(Event {
        tool: "Bash".into(),
        input: br#"{"command":"cd x\n\nmake"}"#.to_vec(),
        ..ev(TAB_A, "PermissionRequest")
    })
    .await;
    r.attn(TAB_A, "waiting").await;
    assert_eq!(folded(&r.sent()), "<code>cd x</code>\n\n<code>make</code>");
}

#[tokio::test]
async fn closed_request_is_plain_waiting() {
    let r = rig().await;
    r.act(Event {
        tool: "Bash".into(),
        input: br#"{"command":"ls"}"#.to_vec(),
        ..ev(TAB_A, "PermissionRequest")
    })
    .await;
    r.act(Event {
        tool: "Bash".into(),
        ..ev(TAB_A, "PostToolUse")
    })
    .await;
    r.act(Event {
        detail: "Claude needs your input".into(),
        ..ev(TAB_A, "Notification")
    })
    .await;
    r.attn(TAB_A, "waiting").await;
    let text = r.sent();
    want_has(&text, &["⏳", "<b>입력 대기</b>"]);
    assert!(!text.contains("🔐"));
    assert_eq!(folded(&text), "Claude needs your input");
}

#[tokio::test]
async fn no_hook_agent() {
    let r = rig().await;
    r.attn("codex-tab", "done").await;
    assert_eq!(
        r.sent(),
        "✅ <b>완료</b>\n<blockquote expandable><code>Server :</code> <b>mac</b>\n<code>Tab    :</code> <b>codex-tab</b></blockquote>"
    );
    r.attn("codex-tab", "waiting").await;
    want_has(&r.sent(), &["⏳"]);
    r.attn("codex-tab", "bell").await;
    want_has(&r.sent(), &["🔔"]);
}

#[tokio::test]
async fn long_content_cut() {
    let r = rig().await;
    let tp = r.tp(&[reply_line(&"가".repeat(5000))]);
    r.act(Event {
        transcript: tp,
        ..ev(TAB_A, "Stop")
    })
    .await;
    r.attn(TAB_A, "done").await;
    let text = r.sent();
    let got = folded(&text);
    let body = got.strip_suffix(CUT_MARK).expect("자르지 않았다");
    assert_eq!(body.chars().count(), CONTENT_MAX);
    assert!(text.chars().count() <= 4096);
}

#[tokio::test]
async fn read_button() {
    let r = rig().await;
    r.attn(TAB_A, "done").await;
    let data = r.read_data();
    assert_eq!(data, format!("r:{TAB_A}"));
    r.press(7, &data).await;
    assert!(r.host.attends.lock().unwrap().is_empty());
    r.press(ME, &data).await;
    assert_eq!(*r.host.attends.lock().unwrap(), [format!("{TAB_A}|seen")]);
    assert_eq!(
        last(&r.tg, "answerCallbackQuery").unwrap().body["text"],
        "읽음"
    );
    let ed = last(&r.tg, "editMessageReplyMarkup").expect("버튼을 걷지 않았다");
    assert_eq!(ed.body["message_id"], 5);
    assert_eq!(ed.body["chat_id"], ME);
    r.attn(&"x".repeat(63), "done").await;
    assert_eq!(r.read_data(), "", "64바이트를 넘는 데이터로 버튼을 달았다");
}

#[tokio::test]
async fn clear_removes_buttons() {
    let r = rig().await;
    r.attn(TAB_A, "done").await;
    r.attn(TAB_A, "waiting").await;
    r.attn("tool-B", "done").await;
    r.clear(TAB_A).await;
    let mut got = edited(&r.tg);
    got.sort();
    assert_eq!(got, [1, 2]);
    r.clear(TAB_A).await;
    assert_eq!(edited(&r.tg).len(), 2);
    r.press_on(ME, "r:tool-B", 3).await;
    r.clear("tool-B").await;
    let got = edited(&r.tg);
    assert_eq!(got.len(), 3);
    assert_eq!(got[2], 3);
}

#[tokio::test]
async fn clear_keeps_failed_buttons() {
    let r = rig().await;
    for _ in 0..3 {
        r.attn(TAB_A, "done").await;
    }
    r.tg.lock().unwrap().fail_edits = HashSet::from([2]);
    r.clear(TAB_A).await;
    assert_eq!(r.buttons(TAB_A), Some(vec![2]));
    r.tg.lock().unwrap().fail_edits.clear();
    r.clear(TAB_A).await;
    let got = edited(&r.tg);
    assert_eq!(got.len(), 4);
    assert_eq!(got[3], 2);
    assert_eq!(r.buttons(TAB_A), None);
}

#[tokio::test]
async fn read_press_keeps_failed_button() {
    let r = rig().await;
    r.attn(TAB_A, "done").await;
    r.tg.lock().unwrap().fail_edits = HashSet::from([1]);
    r.press_on(ME, &format!("r:{TAB_A}"), 1).await;
    assert_eq!(r.buttons(TAB_A), Some(vec![1]));
}

#[tokio::test]
async fn buttons_capped() {
    let r = rig().await;
    for _ in 0..MAX_BUTTONS_PER_TAB + 8 {
        r.attn(TAB_A, "done").await;
    }
    assert_eq!(r.buttons(TAB_A).unwrap().len(), MAX_BUTTONS_PER_TAB);
}

#[tokio::test]
async fn silence_after_pc_input() {
    let r = rig().await;
    let set = |d: i64| {
        r.host
            .last_in
            .lock()
            .unwrap()
            .insert(TAB_A.into(), r.now - time::Duration::minutes(d));
    };
    set(2);
    r.attn(TAB_A, "done").await;
    assert_eq!(
        last(&r.tg, "sendMessage").unwrap().body["disable_notification"],
        true
    );
    set(6);
    r.attn(TAB_A, "done").await;
    assert!(
        last(&r.tg, "sendMessage")
            .unwrap()
            .body
            .get("disable_notification")
            .is_none()
    );
    r.st.set_silence(0).unwrap();
    set(0);
    r.attn(TAB_A, "done").await;
    assert!(
        last(&r.tg, "sendMessage")
            .unwrap()
            .body
            .get("disable_notification")
            .is_none()
    );
}

// ── 와이어 (Go json.Marshal: 키 정렬, HTML 이스케이프) ──

#[tokio::test]
async fn alarm_wire_bytes_match_go() {
    let r = rig().await;
    r.attn("t<&>", "bell").await;
    let c = last(&r.tg, "sendMessage").unwrap();
    assert_eq!(
        String::from_utf8(c.raw).unwrap(),
        concat!(
            r#"{"chat_id":42,"parse_mode":"HTML","reply_markup":{"inline_keyboard":[[{"callback_data":"r:t\u003c\u0026\u003e","text":"읽음"}]]},"#,
            r#""text":"🔔 \u003cb\u003e알림\u003c/b\u003e\n\u003cblockquote expandable\u003e\u003ccode\u003eServer :\u003c/code\u003e \u003cb\u003emac\u003c/b\u003e\n\u003ccode\u003eTab    :\u003c/code\u003e \u003cb\u003et\u0026lt;\u0026amp;\u0026gt;\u003c/b\u003e\u003c/blockquote\u003e"}"#
        )
    );
    r.clear("t<&>").await;
    let e = last(&r.tg, "editMessageReplyMarkup").unwrap();
    assert_eq!(
        String::from_utf8(e.raw).unwrap(),
        r#"{"chat_id":42,"message_id":1,"reply_markup":{"inline_keyboard":[]}}"#
    );
}

// ── 꺼짐 (TC-TGB-80) ──

#[tokio::test]
async fn disabled_is_silent() {
    let r = rig().await;
    r.st.set_enabled(false).unwrap();
    r.act(ev(TAB_A, "Stop")).await;
    r.attn(TAB_A, "done").await;
    r.msg(ME, "hello").await;
    assert!(methods(&r.tg).is_empty());
}

#[tokio::test]
async fn enqueue_never_blocks() {
    let r = rig().await;
    let start = Instant::now();
    for _ in 0..QUEUE_SIZE * 3 {
        r.b.on_activity(ev(TAB_A, "PreToolUse"));
    }
    assert!(start.elapsed() < Duration::from_secs(2));
}

fn drain(b: &Bridge) -> Vec<Item> {
    let mut g = b.rx.lock().unwrap();
    let rx = g.as_mut().unwrap();
    let mut out = Vec::new();
    while let Ok(it) = rx.try_recv() {
        out.push(it);
    }
    out
}

#[tokio::test]
async fn forgets_gone_tools() {
    let r = rig().await;
    for i in 0..10 {
        r.act(Event {
            detail: "x".into(),
            ..ev(&format!("tool-{i}"), "Notification")
        })
        .await;
    }
    assert_eq!(r.b.lock().tabs.len(), 10);
    for i in 0..10 {
        r.b.on_tool_gone(&format!("tool-{i}"));
    }
    for it in drain(&r.b) {
        r.b.process(it).await;
    }
    assert!(r.b.lock().tabs.is_empty());
}

#[tokio::test]
async fn forgets_gone_tools_while_disabled() {
    let r = rig().await;
    r.act(Event {
        detail: "x".into(),
        ..ev(TAB_A, "Notification")
    })
    .await;
    r.st.set_enabled(false).unwrap();
    r.b.on_tool_gone(TAB_A);
    for it in drain(&r.b) {
        r.b.process(it).await;
    }
    assert!(r.b.lock().tabs.is_empty());
}

// ── 글 (FR-CAC-100a) ──

#[tokio::test]
async fn notice_sends_plain_text() {
    let r = rig().await;
    r.b.process(Item::Notice(
        "Claude 계정 자동 전환: ab***@ → cd***@".into(),
    ))
    .await;
    let c = last(&r.tg, "sendMessage").unwrap();
    assert_eq!(c.body["chat_id"], ME);
    assert_eq!(c.body["text"], "Claude 계정 자동 전환: ab***@ → cd***@");
    assert!(c.body.get("parse_mode").is_none());
    assert!(c.body.get("disable_notification").is_none());
}

#[tokio::test]
async fn notice_queue_rules() {
    let r = rig().await;
    r.st.set_enabled(false).unwrap();
    r.b.on_notice("x");
    assert!(drain(&r.b).is_empty(), "꺼진 브리지는 큐에 넣지 않는다");
    r.st.set_enabled(true).unwrap();
    r.b.on_notice("hello");
    let items = drain(&r.b);
    assert!(matches!(items.as_slice(), [Item::Notice(s)] if s == "hello"));
}

// ── 재전송 (TC-ATF-76) ──

fn too_many(after: u64) -> String {
    format!(
        r#"{{"ok":false,"error_code":429,"description":"Too Many Requests: retry after","parameters":{{"retry_after":{after}}}}}"#
    )
}

const BAD_ENTITIES: &str = r#"{"ok":false,"error_code":400,"description":"Bad Request: can't parse entities: Unsupported start tag"}"#;

#[tokio::test]
async fn alarm_retries_after_429() {
    let r = rig().await;
    let w = r.fake_sleep();
    r.fail_sends(&[(429, &too_many(3))]);
    r.attn(TAB_A, "done").await;
    assert_eq!(r.sends(), 2);
    assert_eq!(*w.lock().unwrap(), [Duration::from_secs(3)]);
    r.sent();
    assert_eq!(r.buttons(TAB_A), Some(vec![2]));
}

#[tokio::test]
async fn alarm_retry_after_is_capped() {
    let r = rig().await;
    let w = r.fake_sleep();
    r.fail_sends(&[(429, &too_many(ALARM_RETRY_AFTER_MAX.as_secs() + 600))]);
    r.attn(TAB_A, "done").await;
    assert_eq!(*w.lock().unwrap(), [ALARM_RETRY_AFTER_MAX]);
}

#[tokio::test]
async fn alarm_parse_error_resends_plain() {
    let r = rig().await;
    let w = r.fake_sleep();
    r.fail_sends(&[(400, BAD_ENTITIES)]);
    r.attn(TAB_A, "done").await;
    assert_eq!(r.sends(), 2);
    let c = last(&r.tg, "sendMessage").unwrap();
    assert!(c.body.get("parse_mode").is_none());
    assert_eq!(c.body["chat_id"], ME);
    let text = c.body["text"].as_str().unwrap();
    assert!(!text.is_empty());
    assert!(
        !text.contains('<') && !text.contains("&lt;") && !text.contains("&amp;"),
        "{text}"
    );
    assert!(w.lock().unwrap().is_empty());
}

#[tokio::test]
async fn alarm_retries_only_once() {
    let r = rig().await;
    r.fake_sleep();
    let t = too_many(1);
    r.fail_sends(&[(429, &t), (429, &t), (429, &t)]);
    r.attn(TAB_A, "done").await;
    assert_eq!(r.sends(), 2);
    assert_eq!(r.buttons(TAB_A), None);
}

#[tokio::test]
async fn alarm_retry_waits_without_lock() {
    let r = rig().await;
    let free = Arc::new(AtomicBool::new(false));
    let (b, f) = (Arc::downgrade(&r.b), Arc::clone(&free));
    *r.b.sleep.lock().unwrap() = Arc::new(move |_| {
        if let Some(b) = b.upgrade()
            && b.state.try_lock().is_ok()
        {
            f.store(true, Ordering::Relaxed);
        }
        Box::pin(async {})
    });
    r.fail_sends(&[(429, &too_many(1))]);
    r.attn(TAB_A, "done").await;
    assert!(free.load(Ordering::Relaxed), "기다리는 동안 잠금을 쥐었다");
}

#[tokio::test]
async fn alarm_retries_other_failure() {
    let r = rig().await;
    let w = r.fake_sleep();
    r.fail_sends(&[(
        502,
        r#"{"ok":false,"error_code":502,"description":"Bad Gateway"}"#,
    )]);
    r.attn(TAB_A, "done").await;
    assert_eq!(r.sends(), 2);
    assert_eq!(*w.lock().unwrap(), [BACKOFF_FIRST]);
    r.sent();
}

// ── 길이 (TC-ATF-40) ──

fn want_fits(text: &str) {
    let n = units(&plain_text(text));
    assert!(n <= 4096, "UTF-16 {n} 단위 — 상한을 넘었다");
}

#[tokio::test]
async fn long_question_fits() {
    let r = rig().await;
    let input = json!({"questions": [
        {"header": "머".repeat(300), "question": "가".repeat(5000), "options": [
            {"label": "나".repeat(3000), "description": "다".repeat(3000)},
            {"label": "<b>&"}]},
        {"question": "라".repeat(3000)}]});
    r.act(Event {
        tool: ASK_TOOL.into(),
        input: serde_json::to_vec(&input).unwrap(),
        ..ev(TAB_A, "PreToolUse")
    })
    .await;
    r.attn(TAB_A, "waiting").await;
    let text = r.sent();
    want_fits(&text);
    want_has(&folded(&text), &[CUT_MARK, "<b>[머"]);
}

#[tokio::test]
async fn emoji_reply_fits() {
    let r = rig().await;
    let tp = r.tp(&[reply_line(&"😀".repeat(5000))]);
    r.act(Event {
        transcript: tp,
        ..ev(TAB_A, "Stop")
    })
    .await;
    r.attn(TAB_A, "done").await;
    let text = r.sent();
    want_fits(&text);
    let got = folded(&text);
    assert_eq!(units(got.strip_suffix(CUT_MARK).unwrap()), CONTENT_MAX);
}

#[tokio::test]
async fn long_names_fit() {
    let r = rig().await;
    r.host.locs.lock().unwrap().insert(
        TAB_A.into(),
        Location {
            device: "기".repeat(5000),
            window: "😀".repeat(5000),
            tab: "<&".repeat(3000),
        },
    );
    r.act(Event {
        tool: "T".repeat(5000),
        input: format!(r#"{{"command":"{}"}}"#, "y".repeat(5000)).into_bytes(),
        ..ev(TAB_A, "PermissionRequest")
    })
    .await;
    r.attn(TAB_A, "waiting").await;
    want_fits(&r.sent());
}

#[tokio::test]
async fn expanding_markdown_fits() {
    let r = rig().await;
    let md = format!("|h|i|j|k|\n|-|-|-|-|\n{}", "|a|b|c|d|\n".repeat(1000));
    let tp = r.tp(&[reply_line(&md)]);
    r.act(Event {
        transcript: tp,
        ..ev(TAB_A, "Stop")
    })
    .await;
    r.attn(TAB_A, "done").await;
    let text = r.sent();
    want_fits(&text);
    want_has(&folded(&text), &["• a · b · c · d"]);
}

// ── 잠금 (TC-RD3-40, TC-QG-20) ──

#[tokio::test]
async fn http_outside_lock() {
    let entered = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    let (e2, r2) = (Arc::clone(&entered), Arc::clone(&release));
    let srv = testsrv::serve(Arc::new(move |_, _| {
        let (e, r) = (Arc::clone(&e2), Arc::clone(&r2));
        Box::pin(async move {
            e.notify_one();
            r.notified().await;
            (200, r#"{"ok":true,"result":{"message_id":1}}"#.to_owned())
        })
    }))
    .await;
    let dir = tempfile::tempdir().unwrap();
    let b = Bridge::new(
        store_in(&dir),
        Arc::new(FakeHost::default()),
        &srv.url,
        fixed_now(OffsetDateTime::UNIX_EPOCH),
    );
    let b2 = Arc::clone(&b);
    let worker = tokio::spawn(async move {
        b2.process(Item::Attention {
            tool: TAB_A.into(),
            reason: "done".into(),
        })
        .await;
    });
    tokio::time::timeout(Duration::from_secs(5), entered.notified())
        .await
        .expect("작업자가 HTTP 에 닿지 않았다");
    let upd = Update {
        message: Some(Message {
            from: Some(User {
                id: ME + 1,
                ..User::default()
            }),
            text: "hi".into(),
            ..Message::default()
        }),
        ..Update::default()
    };
    tokio::time::timeout(Duration::from_secs(2), b.handle_update(upd))
        .await
        .expect("작업자의 HTTP 가 끝날 때까지 handle_update 가 막혔다");
    release.notify_one();
    let _ = worker.await;
}

#[tokio::test]
async fn clear_buttons_bounded_parallel() {
    const DELAY: Duration = Duration::from_millis(100);
    let in_flight = Arc::new(AtomicUsize::new(0));
    let peak = Arc::new(AtomicUsize::new(0));
    let calls = Arc::new(AtomicUsize::new(0));
    let (f, p, c) = (
        Arc::clone(&in_flight),
        Arc::clone(&peak),
        Arc::clone(&calls),
    );
    let srv = testsrv::serve(Arc::new(move |_, _| {
        let (f, p, c) = (Arc::clone(&f), Arc::clone(&p), Arc::clone(&c));
        Box::pin(async move {
            let n = f.fetch_add(1, Ordering::SeqCst) + 1;
            c.fetch_add(1, Ordering::SeqCst);
            p.fetch_max(n, Ordering::SeqCst);
            tokio::time::sleep(DELAY).await;
            f.fetch_sub(1, Ordering::SeqCst);
            (200, r#"{"ok":true,"result":true}"#.to_owned())
        })
    }))
    .await;
    let dir = tempfile::tempdir().unwrap();
    let st = store_in(&dir);
    let b = Bridge::new(
        Arc::clone(&st),
        Arc::new(FakeHost::default()),
        &srv.url,
        fixed_now(OffsetDateTime::UNIX_EPOCH),
    );
    b.lock()
        .buttons
        .insert(TAB_A.into(), (1..=MAX_BUTTONS_PER_TAB as i64).collect());
    let start = Instant::now();
    b.clear_buttons(&st.config(), TAB_A).await;
    let took = start.elapsed();
    assert_eq!(calls.load(Ordering::SeqCst), MAX_BUTTONS_PER_TAB);
    assert!(peak.load(Ordering::SeqCst) <= CLEAR_BUTTONS_PARALLEL);
    assert!(
        took < DELAY * MAX_BUTTONS_PER_TAB as u32 / 2,
        "순차와 다르지 않다: {took:?}"
    );
    assert!(!b.lock().buttons.contains_key(TAB_A));
}

// ── 클라이언트 (TC-TGB-2) ──

async fn fake_api(f: impl Fn(&str) -> (u16, String) + Send + Sync + 'static) -> Server {
    let f = Arc::new(f);
    testsrv::serve(Arc::new(move |m, _| {
        let out = f(&m);
        Box::pin(async move { out })
    }))
    .await
}

#[tokio::test]
async fn client_get_me() {
    let srv = fake_api(|m| {
        assert_eq!(m, "getMe");
        (
            200,
            r#"{"ok":true,"result":{"id":9,"is_bot":true,"username":"office_bot","has_topics_enabled":true}}"#.into(),
        )
    })
    .await;
    let me = Client::new(&srv.url, TEST_TOKEN).get_me().await.unwrap();
    assert_eq!(me.username, "office_bot");
    assert!(me.is_bot);
}

#[tokio::test]
async fn client_api_error_and_retry_after() {
    let srv = fake_api(|_| {
        (
            429,
            r#"{"ok":false,"error_code":429,"description":"Too Many Requests: retry after 3","parameters":{"retry_after":3}}"#.into(),
        )
    })
    .await;
    let e = Client::new(&srv.url, TEST_TOKEN)
        .call_discard("sendMessage", Some(&json!({"chat_id": 1})))
        .await
        .unwrap_err();
    let a = e.api().expect("APIError 가 아니다");
    assert_eq!((a.code, a.retry_after), (429, 3));
    assert_eq!(
        e.to_string(),
        "telegram 429: Too Many Requests: retry after 3"
    );
}

#[tokio::test]
async fn client_error_texts() {
    let srv = fake_api(|_| (502, "<html>".into())).await;
    let e = Client::new(&srv.url, TEST_TOKEN)
        .get_me()
        .await
        .unwrap_err();
    assert_eq!(
        e.to_string(),
        "telegram getMe: 응답이 JSON 이 아니다 (HTTP 502)"
    );
    let srv = fake_api(|_| (500, r#"{"ok":false,"description":"x"}"#.into())).await;
    let e = Client::new(&srv.url, TEST_TOKEN)
        .get_me()
        .await
        .unwrap_err();
    assert_eq!(e.to_string(), "telegram 500: x");
}

// 오류 문구에 token 이 섞이지 않는다 (FR-TGB-3).
#[tokio::test]
async fn client_error_never_leaks_token() {
    let e = Client::new("http://127.0.0.1:1", TEST_TOKEN)
        .call_discard("getMe", None)
        .await
        .expect_err("닿지 않는 주소인데 오류가 없다");
    assert!(!e.to_string().contains("SECRET"), "{e}");
    assert!(e.to_string().starts_with("telegram getMe: "), "{e}");
}

#[tokio::test]
async fn client_sends_json_params() {
    let got: Arc<StdMutex<Vec<u8>>> = Arc::default();
    let g = Arc::clone(&got);
    let srv = testsrv::serve(Arc::new(move |_, raw| {
        *g.lock().unwrap() = raw;
        Box::pin(async { (200, r#"{"ok":true,"result":{"message_id":5}}"#.to_owned()) })
    }))
    .await;
    #[derive(Deserialize, Default)]
    #[serde(default)]
    struct Out {
        message_id: i64,
    }
    let out: Out = Client::new(&srv.url, TEST_TOKEN)
        .call(
            "sendMessage",
            Some(&json!({"text": "안녕", "chat_id": 7, "message_thread_id": 9})),
        )
        .await
        .unwrap();
    assert_eq!(out.message_id, 5);
    assert_eq!(
        String::from_utf8(got.lock().unwrap().clone()).unwrap(),
        r#"{"chat_id":7,"message_thread_id":9,"text":"안녕"}"#
    );
    let srv2 = fake_api(|_| (200, r#"{"ok":true,"result":{}}"#.into())).await;
    let e = Client::new(&srv2.url, TEST_TOKEN)
        .call_discard("getMe", None)
        .await;
    assert!(e.is_ok());
}

#[tokio::test]
async fn client_get_updates_parses() {
    let srv = fake_api(|_| {
        (200, r#"{"ok":true,"result":[
            {"update_id":10,"message":{"message_id":1,"from":{"id":42},"chat":{"id":42,"type":"private"},"message_thread_id":263,"text":"hi"}},
            {"update_id":11,"callback_query":{"id":"cb1","from":{"id":42},"data":"k:1","message":{"message_id":3,"chat":{"id":42,"type":"private"},"message_thread_id":263}}}]}"#.into())
    })
    .await;
    let ups = Client::new(&srv.url, TEST_TOKEN)
        .get_updates(0, 0)
        .await
        .unwrap();
    assert_eq!(ups.len(), 2);
    let m = ups[0].message.as_ref().unwrap();
    assert_eq!(
        (m.text.as_str(), m.from.as_ref().unwrap().id, m.chat.id),
        ("hi", 42, 42)
    );
    let cb = ups[1].callback_query.as_ref().unwrap();
    assert_eq!(
        (cb.data.as_str(), cb.id.as_str(), cb.from.id),
        ("k:1", "cb1", 42)
    );
}

#[tokio::test]
async fn client_get_updates_body() {
    let got: Arc<StdMutex<Vec<u8>>> = Arc::default();
    let g = Arc::clone(&got);
    let srv = testsrv::serve(Arc::new(move |_, raw| {
        *g.lock().unwrap() = raw;
        Box::pin(async { (200, r#"{"ok":true,"result":[]}"#.to_owned()) })
    }))
    .await;
    Client::new(&srv.url, TEST_TOKEN)
        .get_updates(7, 50)
        .await
        .unwrap();
    assert_eq!(
        String::from_utf8(got.lock().unwrap().clone()).unwrap(),
        r#"{"allowed_updates":["message","callback_query"],"offset":7,"timeout":50}"#
    );
}

// polling 은 받은 것을 처리하고 offset 을 올린다. 취소하면 끝난다.
#[tokio::test]
async fn run_polls_and_stops() {
    let offsets: Arc<StdMutex<Vec<i64>>> = Arc::default();
    let o = Arc::clone(&offsets);
    let srv = testsrv::serve(Arc::new(move |m, raw| {
        let o = Arc::clone(&o);
        Box::pin(async move {
            if m != "getUpdates" {
                return (200, r#"{"ok":true,"result":{"message_id":1}}"#.to_owned());
            }
            let v: Value = serde_json::from_slice(&raw).unwrap();
            let off = v["offset"].as_i64().unwrap();
            o.lock().unwrap().push(off);
            if off == 0 {
                return (200, r#"{"ok":true,"result":[{"update_id":5,"message":{"from":{"id":9},"chat":{"id":9},"text":"x"}}]}"#.to_owned());
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
            (200, r#"{"ok":true,"result":[]}"#.to_owned())
        })
    }))
    .await;
    let dir = tempfile::tempdir().unwrap();
    let b = Bridge::new(
        store_in(&dir),
        Arc::new(FakeHost::default()),
        &srv.url,
        fixed_now(OffsetDateTime::UNIX_EPOCH),
    );
    let cancel = CancellationToken::new();
    let run = tokio::spawn(Arc::clone(&b).run(cancel.clone()));
    let deadline = Instant::now() + Duration::from_secs(5);
    while !offsets.lock().unwrap().contains(&6) {
        assert!(Instant::now() < deadline, "offset 이 오르지 않았다");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    cancel.cancel();
    tokio::time::timeout(Duration::from_secs(2), run)
        .await
        .expect("취소 뒤에도 돌았다")
        .unwrap();
}
