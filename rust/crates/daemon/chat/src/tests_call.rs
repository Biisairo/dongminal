//! ISSUE_TREE_CHAT_SRS 묶음 A — 지정(call)과 부른 글(called) 판정 (FR-CAL-1·3·4, TC-ITH-1).

use crate::frame::MsgBody;
use crate::tests::{eventually, link, must_code, new_test_node, rt, until_online_part};
use crate::*;

fn called_of(n: &crate::tests::TestNode, pid: &str, text: &str) -> Option<bool> {
    n.deliveries(pid)
        .into_iter()
        .find(|m| m.text == text)
        .map(|m| m.called)
}

// FR-CAL-1: 방에 없는 상대를 지정하면 bad_request 다. "user" 와 방의 참가자는 받는다.
#[test]
fn call_must_name_room_member() {
    rt().block_on(async {
        let a = new_test_node("a");
        let pa = a.register("a/x", KIND_AGENT);
        let pb = a.register("a/y", KIND_AGENT);
        let out = a.register("a/z", KIND_AGENT);
        let room = a.create(&pa.id, "r", "").unwrap();
        a.join(&pb.id, &room.id).unwrap();
        must_code(
            a.send_call(&pa.id, &room.id, "x", std::slice::from_ref(&out.id)),
            CODE_BAD_REQUEST,
        );
        must_code(
            a.send_call(&pa.id, &room.id, "x", &["nobody".to_string()]),
            CODE_BAD_REQUEST,
        );
        a.send_call(&pa.id, &room.id, "ok1", std::slice::from_ref(&pb.id))
            .unwrap();
        a.send_call(&pa.id, &room.id, "ok2", &[CALL_USER.to_string()])
            .unwrap();
    });
}

// FR-CAL-3 ②③: 에이전트 글은 지정한 상대만, 사람 글은 지정이 없으면 방의 모든 에이전트를 부른다.
#[test]
fn called_rules_in_group() {
    rt().block_on(async {
        let a = new_test_node("a");
        let pa = a.register("a/x", KIND_AGENT);
        let pb = a.register("a/y", KIND_AGENT);
        let pc = a.register("a/z", KIND_AGENT);
        let pu = a.register("a/User", KIND_USER);
        let room = a.create(&pa.id, "r", "").unwrap();
        for p in [&pb, &pc, &pu] {
            a.join(&p.id, &room.id).unwrap();
        }
        a.send_call(&pa.id, &room.id, "to-b", std::slice::from_ref(&pb.id))
            .unwrap();
        a.send(&pa.id, &room.id, "nobody").unwrap();
        a.send_call(&pa.id, &room.id, "to-user", &[CALL_USER.to_string()])
            .unwrap();
        a.send(&pu.id, &room.id, "human-all").unwrap();
        a.send_call(&pu.id, &room.id, "human-b", std::slice::from_ref(&pb.id))
            .unwrap();
        eventually("모두 받는다", || a.deliveries(&pc.id).len() == 5).await;

        assert_eq!(called_of(&a, &pb.id, "to-b"), Some(true));
        assert_eq!(called_of(&a, &pc.id, "to-b"), Some(false));
        assert_eq!(called_of(&a, &pu.id, "to-b"), Some(false));

        for p in [&pb, &pc, &pu] {
            assert_eq!(
                called_of(&a, &p.id, "nobody"),
                Some(false),
                "지정 없는 에이전트 글"
            );
        }

        assert_eq!(called_of(&a, &pu.id, "to-user"), Some(true));
        assert_eq!(called_of(&a, &pb.id, "to-user"), Some(false));

        for p in [&pa, &pb, &pc] {
            assert_eq!(
                called_of(&a, &p.id, "human-all"),
                Some(true),
                "지정 없는 사람 글"
            );
        }

        assert_eq!(called_of(&a, &pb.id, "human-b"), Some(true));
        assert_eq!(called_of(&a, &pa.id, "human-b"), Some(false));
        assert_eq!(called_of(&a, &pc.id, "human-b"), Some(false));
    });
}

// FR-CAL-3 ①: 개인채팅의 글은 상대를 부른 글이다.
#[test]
fn direct_message_is_called() {
    rt().block_on(async {
        let a = new_test_node("a");
        let pa = a.register("a/x", KIND_AGENT);
        let pb = a.register("a/y", KIND_AGENT);
        let room = a.direct(&pa.id, &pb.id, "").unwrap();
        eventually("상대가 들어간다", || {
            a.rooms(&pb.id).iter().any(|r| r.id == room.id && r.joined)
        })
        .await;
        a.send(&pa.id, &room.id, "dm").unwrap();
        eventually("상대가 받는다", || a.deliveries(&pb.id).len() == 1).await;
        assert_eq!(called_of(&a, &pb.id, "dm"), Some(true));
    });
}

// FR-CAL-4: 지정은 서명된 글에 실려 다른 노드에서도 같은 판정이 난다.
#[test]
fn call_crosses_network() {
    rt().block_on(async {
        let (a, b) = (new_test_node("a"), new_test_node("b"));
        let _k = link(&a, &b);
        let pa = a.register("a/x", KIND_AGENT);
        let pb = b.register("b/x", KIND_AGENT);
        let pc = b.register("b/y", KIND_AGENT);
        until_online_part(&a, &pb.id).await;
        let room = a.create(&pa.id, "r", "").unwrap();
        eventually("b 가 방을 본다", || b.room_visible(&pb.id, &room.id)).await;
        b.join(&pb.id, &room.id).unwrap();
        b.join(&pc.id, &room.id).unwrap();
        eventually("a 가 참가를 본다", || {
            a.first_room_members(&pa.id) == 3
        })
        .await;
        a.send_call(&pa.id, &room.id, "remote", std::slice::from_ref(&pb.id))
            .unwrap();
        eventually("b 의 둘이 받는다", || {
            b.deliveries(&pb.id).len() == 1 && b.deliveries(&pc.id).len() == 1
        })
        .await;
        assert_eq!(called_of(&b, &pb.id, "remote"), Some(true));
        assert_eq!(called_of(&b, &pc.id, "remote"), Some(false));
    });
}

// 옛 노드 호환: 지정이 없는 글의 서명 원문에는 call 키가 없다.
#[test]
fn msg_body_without_call_has_no_key() {
    let b = MsgBody::default();
    let s = otter_gocompat::json::marshal(&b).unwrap();
    assert!(!String::from_utf8_lossy(&s).contains("\"call\""));
    let c = MsgBody {
        call: vec!["p".into()],
        ..MsgBody::default()
    };
    let s = otter_gocompat::json::marshal(&c).unwrap();
    assert!(String::from_utf8_lossy(&s).contains("\"call\""));
}

fn notify_of(n: &crate::tests::TestNode, pid: &str, room: &str) -> String {
    n.rooms(pid)
        .into_iter()
        .find(|r| r.id == room)
        .map(|r| r.notify)
        .unwrap_or_default()
}

// FR-CAL-5·6: 알림 단계는 참가자·방마다다. 정하지 않으면 called, 나가면 지운다.
#[test]
fn notify_level_per_participant_and_room() {
    rt().block_on(async {
        let a = new_test_node("a");
        let pa = a.register("a/x", KIND_AGENT);
        let pb = a.register("a/y", KIND_AGENT);
        let r1 = a.create(&pa.id, "r1", "").unwrap();
        let r2 = a.create(&pa.id, "r2", "").unwrap();
        a.join(&pb.id, &r1.id).unwrap();
        assert_eq!(notify_of(&a, &pa.id, &r1.id), NOTIFY_CALLED);

        a.set_notify(&pa.id, &r1.id, NOTIFY_ALL).unwrap();
        assert_eq!(notify_of(&a, &pa.id, &r1.id), NOTIFY_ALL);
        assert_eq!(notify_of(&a, &pa.id, &r2.id), NOTIFY_CALLED, "다른 방");
        assert_eq!(notify_of(&a, &pb.id, &r1.id), NOTIFY_CALLED, "다른 참가자");
        a.set_notify(&pa.id, &r1.id, NOTIFY_OFF).unwrap();
        assert_eq!(notify_of(&a, &pa.id, &r1.id), NOTIFY_OFF);

        a.set_notify(&pb.id, &r1.id, NOTIFY_ALL).unwrap();
        a.leave(&pb.id, &r1.id).unwrap();
        a.join(&pb.id, &r1.id).unwrap();
        assert_eq!(
            notify_of(&a, &pb.id, &r1.id),
            NOTIFY_CALLED,
            "다시 들면 기본값"
        );
    });
}

// ISSUE_TREE_CHAT_SRS FR-CUX-12 (결정 I-10): 방 보기의 참가자는 이 노드의 참가자면 그 방의 단계를 싣는다.
#[test]
fn room_members_carry_local_notify() {
    rt().block_on(async {
        let a = new_test_node("a");
        let pa = a.register("a/x", KIND_AGENT);
        let pb = a.register("a/y", KIND_AGENT);
        let r = a.create(&pa.id, "r", "").unwrap();
        a.join(&pb.id, &r.id).unwrap();
        a.set_notify(&pb.id, &r.id, NOTIFY_OFF).unwrap();
        let info = a.rooms(&pa.id).into_iter().find(|x| x.id == r.id).unwrap();
        let of = |id: &str| {
            info.members
                .iter()
                .find(|m| m.id == id)
                .unwrap()
                .notify
                .clone()
        };
        assert_eq!(of(&pa.id), NOTIFY_CALLED);
        assert_eq!(of(&pb.id), NOTIFY_OFF);
    });
}

// FR-CAL-6: 모르는 단계는 bad_request, 들지 않은 방은 not_in_room, 없는 참가자는 그 오류다.
#[test]
fn notify_rejects_bad_input() {
    rt().block_on(async {
        let a = new_test_node("a");
        let pa = a.register("a/x", KIND_AGENT);
        let pb = a.register("a/y", KIND_AGENT);
        let r = a.create(&pa.id, "r", "").unwrap();
        for bad in ["", "ALL", "loud"] {
            must_code(a.set_notify(&pa.id, &r.id, bad), CODE_BAD_REQUEST);
        }
        must_code(a.set_notify(&pb.id, &r.id, NOTIFY_ALL), CODE_NOT_IN_ROOM);
        must_code(
            a.set_notify("nobody", &r.id, NOTIFY_ALL),
            CODE_NO_SUCH_PARTICIPANT,
        );
    });
}
