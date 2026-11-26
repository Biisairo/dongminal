//! PEER_CHAT_SRS §3.12 — 사람 참가자의 kill·kick (TC-PCH-17, Go human_test.go).

use std::sync::{Arc, Mutex};

use ed25519_dalek::SigningKey;
use otter_gocompat::json::{self, RawMessage};
use otter_shared_chatwire as chatwire;
use otter_shared_humancmd::{self as humancmd, Body, Request, Signed};
use time::OffsetDateTime;

use crate::tests::*;
use crate::*;

#[derive(Default)]
struct FakeState {
    code: String,
    fail: Option<humancmd::Error>,
    down: bool,
    got: Vec<Request>,
}

struct FakeHelper {
    key: SigningKey,
    st: Mutex<FakeState>,
}

fn new_fake_helper() -> Arc<FakeHelper> {
    let mut seed = [0u8; 32];
    rand::fill(&mut seed);
    Arc::new(FakeHelper {
        key: SigningKey::from_bytes(&seed),
        st: Mutex::new(FakeState {
            code: "123456".into(),
            ..FakeState::default()
        }),
    })
}

fn herr(code: &str, until: i64) -> humancmd::Error {
    humancmd::Error {
        code: code.into(),
        until,
    }
}

impl Helper for FakeHelper {
    fn sign(&self, code: &str, r: Request) -> Result<Signed, humancmd::Error> {
        let mut st = self.st.lock().unwrap();
        st.got.push(r.clone());
        if st.down {
            return Err(herr(humancmd::CODE_NO_HELPER, 0));
        }
        if let Some(e) = &st.fail {
            return Err(e.clone());
        }
        if code != st.code {
            return Err(herr(humancmd::CODE_BAD_CODE, 0));
        }
        let at = (OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000) as i64;
        Ok(humancmd::sign(
            &self.key,
            Body {
                id: humancmd::new_id(),
                node: r.node,
                op: r.op,
                rooms: r.rooms,
                kicks: r.kicks,
                at,
                key: String::new(),
            },
        )
        .unwrap())
    }
}

fn raw(s: &str) -> RawMessage {
    RawMessage(s.as_bytes().to_vec())
}

fn with_helper(fh: &Arc<FakeHelper>) -> Harness {
    let h2 = fh.clone();
    new_harness(move |o| o.helper = Some(h2))
}

fn user_room(h: &Harness) -> String {
    h.srv.start_user();
    let r = h
        .srv
        .user_call(chatwire::OP_CREATE, &raw(r#"{"name":"ops","purpose":""}"#))
        .unwrap();
    json::unmarshal::<chatwire::RoomResult>(&r.0)
        .unwrap()
        .room
        .id
}

fn user_state(h: &Harness) -> chatwire::State {
    let r = h
        .srv
        .user_call(chatwire::OP_STATE, &RawMessage::default())
        .unwrap();
    json::unmarshal(&r.0).unwrap()
}

fn kill_args(room: &str, code: &str) -> RawMessage {
    raw(&format!(r#"{{"rooms":["{room}"],"code":"{code}"}}"#))
}

#[test]
fn user_kill_through_helper() {
    let fh = new_fake_helper();
    let h = with_helper(&fh);
    let room = user_room(&h);
    let e = h
        .srv
        .user_call(chatwire::OP_KILL, &kill_args(&room, "000000"))
        .unwrap_err();
    assert_eq!(e.code, chatwire::CODE_BAD_CODE);
    h.srv
        .user_call(chatwire::OP_KILL, &kill_args(&room, "123456"))
        .unwrap();
    {
        let st = fh.st.lock().unwrap();
        assert!(
            st.got.len() == 2
                && st.got[1].node == h.svc.node()
                && st.got[1].op == humancmd::OP_KILL,
            "{:?}",
            st.got
        );
    }
    let st = user_state(&h);
    assert!(st.helper, "state.helper 가 거짓이다");
    assert!(
        !st.rooms.unwrap().iter().any(|r| r.id == room),
        "강제 삭제한 방이 남았다"
    );
}

#[test]
fn user_kick_through_helper() {
    let fh = new_fake_helper();
    let h = with_helper(&fh);
    let room = user_room(&h);
    let (mut cl, hello) = h.agent("s1", "tool-1", "claude");
    cl.call(
        chatwire::OP_JOIN,
        &chatwire::RoomArgs { room: room.clone() },
    );
    let args = format!(
        r#"{{"kicks":[{{"room":"{room}","participant":"{}"}}],"code":"123456"}}"#,
        hello.id
    );
    h.srv.user_call(chatwire::OP_KICK, &raw(&args)).unwrap();
    let f = cl.call(
        chatwire::OP_SEND,
        &chatwire::SendArgs {
            room,
            text: "x".into(),
            call: None,
        },
    );
    assert_eq!(
        f.error.unwrap().code,
        "not_in_room",
        "강퇴된 에이전트의 보내기"
    );
}

#[test]
fn user_human_errors() {
    let fh = new_fake_helper();
    let h = with_helper(&fh);
    let room = user_room(&h);
    let until = time::macros::datetime!(2026-11-17 12:00:00 UTC);
    let until_ms = (until.unix_timestamp_nanos() / 1_000_000) as i64;
    fh.st.lock().unwrap().fail = Some(herr(humancmd::CODE_LOCKED, until_ms));
    let e = h
        .srv
        .user_call(chatwire::OP_KILL, &kill_args(&room, "123456"))
        .unwrap_err();
    assert_eq!(e.code, chatwire::CODE_LOCKED);
    assert_eq!(
        e.message, "2026-11-17T12:00:00Z",
        "풀리는 시각(RFC 3339)을 기대"
    );
    fh.st.lock().unwrap().fail = None;
    let e = h
        .srv
        .user_call(chatwire::OP_KILL, &raw(r#"{"rooms":[],"code":"123456"}"#))
        .unwrap_err();
    assert_eq!(e.code, chatwire::CODE_BAD_REQUEST, "대상 없음");
    let e = h
        .srv
        .user_call(
            chatwire::OP_KICK,
            &raw(&format!(r#"{{"rooms":["{room}"],"code":"123456"}}"#)),
        )
        .unwrap_err();
    assert_eq!(e.code, chatwire::CODE_BAD_REQUEST, "종류가 섞임");
    fh.st.lock().unwrap().fail = Some(herr(humancmd::CODE_UNAVAILABLE, 0));
    let e = h
        .srv
        .user_call(chatwire::OP_KILL, &kill_args(&room, "123456"))
        .unwrap_err();
    assert_eq!(e.code, chatwire::CODE_NO_HELPER, "도우미 저장 실패");
    {
        let mut st = fh.st.lock().unwrap();
        st.fail = None;
        st.down = true;
    }
    let e = h
        .srv
        .user_call(chatwire::OP_KILL, &kill_args(&room, "123456"))
        .unwrap_err();
    assert_eq!(e.code, chatwire::CODE_NO_HELPER, "도우미 없음");
}

#[test]
fn user_human_without_helper() {
    let h = new_harness(|_| {});
    let room = user_room(&h);
    assert!(
        !user_state(&h).helper,
        "도우미가 없는데 state.helper 가 참이다"
    );
    let e = h
        .srv
        .user_call(chatwire::OP_KILL, &kill_args(&room, "123456"))
        .unwrap_err();
    assert_eq!(e.code, chatwire::CODE_NO_HELPER);
}

// 에이전트의 MCP 연결로는 kill·kick 을 부를 수 없다.
#[test]
fn agent_cannot_human() {
    let fh = new_fake_helper();
    let h = with_helper(&fh);
    let room = user_room(&h);
    let (mut cl, _) = h.agent("s1", "tool-1", "claude");
    #[derive(serde::Serialize)]
    struct Args {
        rooms: Vec<String>,
        code: String,
    }
    let f = cl.call(
        chatwire::OP_KILL,
        &Args {
            rooms: vec![room],
            code: "123456".into(),
        },
    );
    assert!(f.error.is_some(), "에이전트가 kill 을 불렀다");
    assert!(
        fh.st.lock().unwrap().got.is_empty(),
        "에이전트의 요청이 도우미에 닿았다"
    );
}
