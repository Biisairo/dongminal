//! ISSUE_TREE_CHAT_SRS FR-ITR-2·3·10 (TC-ITH-18): 트리 방 규칙. 사람 참가자와 트리 멤버 세션의 자동 입장·퇴장.

use std::net::Shutdown;

use otter_gocompat::json::{self, RawMessage};
use otter_shared_chatwire as chatwire;

use crate::tests::*;

fn raw(s: &str) -> RawMessage {
    RawMessage(s.as_bytes().to_vec())
}

/// 사람 화면이 보는 그 방의 참가자 id 목록이다. 사람이 그 방에 없으면 None.
fn people_of(h: &Harness, room: &str) -> Option<Vec<String>> {
    let r = h
        .srv
        .user_call(chatwire::OP_STATE, &RawMessage::default())
        .unwrap();
    let st: chatwire::State = json::unmarshal(&r.0).unwrap();
    st.rooms
        .unwrap_or_default()
        .into_iter()
        .find(|x| x.id == room && x.joined)
        .map(|x| {
            x.people
                .unwrap_or_default()
                .into_iter()
                .map(|p| p.id)
                .collect()
        })
}

fn tree(h: &Harness, args: &str) -> Result<RawMessage, chatwire::Error> {
    h.srv.user_call(chatwire::OP_TREE, &raw(args))
}

#[test]
fn tree_room_auto_join_and_leave() {
    let h = new_harness(|_| {});
    let me = h.srv.start_user();
    let (mut coord, hc) = h.agent("s-coord", "t-coord", "coord");
    let room = must_room(&coord.call(
        chatwire::OP_CREATE,
        &chatwire::CreateArgs {
            name: "perf:2 묶음".into(),
            purpose: "perf:2 제목".into(),
        },
    ))
    .id;
    let (_m1, h1) = h.agent("s-m1", "t-m1", "m1");
    let (_x, hx) = h.agent("s-x", "t-x", "x");
    assert!(
        people_of(&h, &room).is_none(),
        "규칙 전에는 사람이 방에 없다"
    );

    tree(
        &h,
        &format!(r#"{{"room":"{room}","tools":["t-coord","t-m1","t-m2"]}}"#),
    )
    .unwrap();
    let p = people_of(&h, &room).expect("사람이 트리 방에 들어간다 (FR-ITR-2)");
    for id in [&me.id, &hc.id, &h1.id] {
        assert!(p.contains(id), "{id} 없음: {p:?}");
    }
    assert!(
        !p.contains(&hx.id),
        "트리 멤버가 아닌 세션이 들어갔다: {p:?}"
    );

    let (m2, h2) = h.agent("s-m2", "t-m2", "m2");
    eventually("나중에 붙은 멤버가 들어간다 (FR-ITR-3)", || {
        people_of(&h, &room).is_some_and(|p| p.contains(&h2.id))
    });
    let _ = m2.c.shutdown(Shutdown::Both);
    eventually("연결이 끊긴 멤버는 나간다", || {
        people_of(&h, &room).is_some_and(|p| !p.contains(&h2.id))
    });

    // 같은 규칙을 다시 주어도(서버 재동기) 그대로다.
    tree(
        &h,
        &format!(r#"{{"room":"{room}","tools":["t-coord","t-m1","t-m2"]}}"#),
    )
    .unwrap();

    tree(&h, &format!(r#"{{"room":"{room}","close":true}}"#)).unwrap();
    assert!(
        people_of(&h, &room).is_none(),
        "닫으면 사람이 나간다 (FR-ITR-10)"
    );
    let (mut m2b, h2b) = h.agent("s-m2b", "t-m2", "m2");
    let rooms: chatwire::Rooms =
        json::unmarshal(&m2b.call(chatwire::OP_ROOMS, &None::<()>).result.0).unwrap();
    assert!(
        rooms.rooms.unwrap_or_default().iter().all(|r| !r.joined),
        "닫힌 규칙으로 들어갔다: {}",
        h2b.id
    );
}

#[test]
fn tree_rule_rejects_bad_args() {
    let h = new_harness(|_| {});
    h.srv.start_user();
    for args in [r#"{"tools":["t"]}"#, r#"{"room":"nope","tools":["t"]}"#] {
        let e = tree(&h, args).unwrap_err();
        assert!(!e.code.is_empty(), "{args}");
    }
}
