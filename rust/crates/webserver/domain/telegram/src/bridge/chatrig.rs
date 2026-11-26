//! 채팅 토픽 시험의 공용 틀 (ISSUE_TREE_CHAT_SRS 묶음 T). Telegram 은 가짜 서버, 채팅 상태는 가짜 Host 다.

use std::collections::{HashMap, VecDeque};
use std::sync::Mutex as StdMutex;

use time::OffsetDateTime;

use std::sync::Arc;

use serde_json::Value;

use crate::bridge::{Bridge, ChatPerson, ChatRoom, ChatView, Host, Item, Location};
use crate::config::Store;
use crate::testsrv::{self, Handler, Server};
use crate::topics::{TopicMap, topics_path};

pub(crate) const ME: i64 = 42;
const TEST_TOKEN: &str = "123456:SECRET-token-value";
pub(crate) const THREAD_BASE: i64 = 500;
/// 사람 참가자(나)의 id 와 표시 이름.
pub(crate) const ME_ID: &str = "fpA-u1";
pub(crate) const ME_NAME: &str = "나";

#[derive(Clone, Debug)]
pub(crate) struct Call {
    pub(crate) method: String,
    pub(crate) body: Value,
}

#[derive(Default)]
pub(crate) struct FakeTg {
    calls: Vec<Call>,
    fails: HashMap<String, VecDeque<(u16, String)>>,
    threads: i64,
}

pub(crate) type Tg = Arc<StdMutex<FakeTg>>;

fn handler(tg: Tg) -> Handler {
    Arc::new(move |method, raw| {
        let tg = Arc::clone(&tg);
        Box::pin(async move {
            let body: Value = serde_json::from_slice(&raw).unwrap_or(Value::Null);
            let mut f = tg.lock().unwrap();
            f.calls.push(Call {
                method: method.clone(),
                body,
            });
            let id = f.calls.len();
            if let Some(fail) = f.fails.get_mut(&method).and_then(VecDeque::pop_front) {
                return fail;
            }
            match method.as_str() {
                "createForumTopic" => {
                    f.threads += 1;
                    let n = THREAD_BASE + f.threads;
                    (
                        200,
                        format!(r#"{{"ok":true,"result":{{"message_thread_id":{n},"name":"x"}}}}"#),
                    )
                }
                "sendMessage" => (
                    200,
                    format!(r#"{{"ok":true,"result":{{"message_id":{id}}}}}"#),
                ),
                _ => (200, r#"{"ok":true,"result":true}"#.to_owned()),
            }
        })
    })
}

#[derive(Default)]
pub(crate) struct FakeHost {
    view: StdMutex<Option<ChatView>>,
    /// (방, 들어가기인가).
    pub(crate) joins: StdMutex<Vec<(String, bool)>>,
    /// (방, 본문, 부른 상대).
    pub(crate) sends: StdMutex<Vec<(String, String, Vec<String>)>>,
    pub(crate) fail: StdMutex<bool>,
}

impl Host for FakeHost {
    fn last_browser_input(&self, _: &str) -> Option<OffsetDateTime> {
        None
    }
    fn location(&self, tool: &str) -> Location {
        Location {
            tab: tool.into(),
            ..Location::default()
        }
    }
    fn attend(&self, _: &str, _: bool) {}
    fn chat_view(&self) -> Option<ChatView> {
        self.view.lock().unwrap().clone()
    }
    fn chat_join(&self, room: &str, join: bool) -> Result<(), String> {
        if *self.fail.lock().unwrap() {
            return Err("no_such_room".into());
        }
        self.joins.lock().unwrap().push((room.into(), join));
        Ok(())
    }
    fn chat_send(&self, room: &str, text: &str, call: &[String]) -> Result<(), String> {
        if *self.fail.lock().unwrap() {
            return Err("rate_limited".into());
        }
        self.sends
            .lock()
            .unwrap()
            .push((room.into(), text.into(), call.to_vec()));
        Ok(())
    }
}

pub(crate) struct Rig {
    pub(crate) b: Arc<Bridge>,
    pub(crate) tg: Tg,
    pub(crate) host: Arc<FakeHost>,
    pub(crate) st: Arc<Store>,
    pub(crate) dir: tempfile::TempDir,
    pub(crate) srv: Server,
}

pub(crate) async fn rig_with(topics: bool) -> Rig {
    let tg: Tg = Arc::default();
    let srv = testsrv::serve(handler(Arc::clone(&tg))).await;
    let dir = tempfile::tempdir().unwrap();
    let st = Arc::new(Store::open(dir.path().join("telegram.json")));
    st.set_token(TEST_TOKEN, "office_bot").unwrap();
    st.set_user(ME).unwrap();
    st.set_enabled(true).unwrap();
    if topics {
        st.set_chat_topics(true).unwrap();
    }
    let host = Arc::new(FakeHost::default());
    let now = OffsetDateTime::from_unix_timestamp(10_000).unwrap();
    let b = Bridge::new(
        Arc::clone(&st),
        host.clone(),
        &srv.url,
        Arc::new(move || now),
    );
    Rig {
        b,
        tg,
        host,
        st,
        dir,
        srv,
    }
}

pub(crate) async fn rig() -> Rig {
    rig_with(true).await
}

pub(crate) fn room(id: &str, name: &str, joined: bool) -> ChatRoom {
    ChatRoom {
        id: id.into(),
        name: name.into(),
        purpose: "설계 논의".into(),
        members: 3,
        joined,
        ..ChatRoom::default()
    }
}

impl Rig {
    pub(crate) fn set_rooms(&self, rooms: Option<Vec<ChatRoom>>) {
        *self.host.view.lock().unwrap() = rooms.map(|rooms| ChatView {
            me: ChatPerson {
                id: ME_ID.into(),
                name: ME_NAME.into(),
            },
            rooms,
        });
    }
    pub(crate) async fn sync(&self) {
        self.b.process(Item::ChatSync).await;
    }
    pub(crate) fn calls(&self) -> Vec<Call> {
        self.tg.lock().unwrap().calls.clone()
    }
    pub(crate) fn methods(&self) -> Vec<String> {
        self.calls().into_iter().map(|c| c.method).collect()
    }
    pub(crate) fn reset(&self) {
        self.tg.lock().unwrap().calls.clear();
    }
    pub(crate) fn fail(&self, method: &str, code: u16, body: &str) {
        self.tg
            .lock()
            .unwrap()
            .fails
            .entry(method.into())
            .or_default()
            .push_back((code, body.into()));
    }
    pub(crate) fn map(&self) -> TopicMap {
        TopicMap::open(&topics_path(&self.dir.path().join("telegram.json")))
    }
    pub(crate) fn queued(&self) -> usize {
        let mut g = self.b.rx.lock().unwrap();
        let rx = g.as_mut().unwrap();
        let mut n = 0;
        while rx.try_recv().is_ok() {
            n += 1;
        }
        n
    }
}
