use super::*;

#[test]
fn human_ops_are_humancmd() {
    assert_eq!(OP_KILL, otter_shared_humancmd::OP_KILL);
    assert_eq!(OP_KICK, otter_shared_humancmd::OP_KICK);
}

#[test]
fn encode_omits_empty_and_ends_with_newline() {
    let f = Frame {
        t: TYPE_HELLO.into(),
        session: "s".into(),
        ..Default::default()
    };
    assert_eq!(
        encode(&f).unwrap(),
        b"{\"t\":\"hello\",\"session\":\"s\"}\n"
    );
}

#[test]
fn frame_round_trip() {
    let f = Frame {
        t: TYPE_MSG.into(),
        n: 3,
        msg: Some(Message {
            id: "m1".into(),
            at: 7,
            ..Default::default()
        }),
        total: 2,
        ..Default::default()
    };
    let line = encode(&f).unwrap();
    let back: Frame = json::unmarshal(&line[..line.len() - 1]).unwrap();
    assert_eq!(back, f);
}

#[test]
fn scanner_lines_cr_and_tail() {
    let mut sc = Scanner::new(&b"a\r\n\nb"[..]);
    assert_eq!(sc.next_line().unwrap(), b"a");
    assert_eq!(sc.next_line().unwrap(), b"");
    assert_eq!(sc.next_line().unwrap(), b"b");
    assert!(sc.next_line().is_none());
    assert!(sc.err().is_none());
}

#[test]
fn scanner_max_line_boundary() {
    let mut ok = vec![b'x'; MAX_LINE - 1];
    ok.push(b'\n');
    let mut sc = Scanner::new(&ok[..]);
    assert_eq!(sc.next_line().unwrap().len(), MAX_LINE - 1);

    let long = vec![b'x'; MAX_LINE];
    let mut sc = Scanner::new(&long[..]);
    assert!(sc.next_line().is_none());
    assert!(matches!(sc.err(), Some(ScanError::TooLong)));
}

// ISSUE_TREE_CHAT_SRS FR-CUX-7: 글은 부른 상대(call)를 싣는다. 비면 키가 없다 — 옛 형식과 같다.
#[test]
fn message_carries_call() {
    let m = Message {
        call: vec!["p1".into(), "user".into()],
        called: true,
        ..Default::default()
    };
    let s = String::from_utf8(json::marshal(&m).unwrap()).unwrap();
    assert!(
        s.ends_with(r#","call":["p1","user"],"called":true}"#),
        "{s}"
    );
    assert_eq!(json::unmarshal::<Message>(s.as_bytes()).unwrap(), m);
    let plain = String::from_utf8(json::marshal(&Message::default()).unwrap()).unwrap();
    assert!(!plain.contains("\"call\""), "{plain}");
}

// ISSUE_TREE_CHAT_SRS FR-CAL-1·4·5: 지정(call)·부른 글(called)·알림 단계(notify)의 와이어 모양.
#[test]
fn call_called_notify_wire() {
    assert_eq!(
        (NOTIFY_ALL, NOTIFY_CALLED, NOTIFY_OFF),
        ("all", "called", "off")
    );
    let m = Message {
        called: true,
        ..Default::default()
    };
    assert!(
        String::from_utf8(json::marshal(&m).unwrap())
            .unwrap()
            .ends_with(",\"called\":true}")
    );
    let plain = SendArgs {
        room: "r".into(),
        text: "t".into(),
        ..Default::default()
    };
    assert_eq!(
        json::marshal(&plain).unwrap(),
        br#"{"room":"r","text":"t"}"#
    );
    let called = SendArgs {
        call: Some(vec!["p1".into(), "user".into()]),
        ..plain
    };
    let b = json::marshal(&called).unwrap();
    assert_eq!(b, br#"{"room":"r","text":"t","call":["p1","user"]}"#);
    assert_eq!(json::unmarshal::<SendArgs>(&b).unwrap(), called);
    let room = Room {
        notify: NOTIFY_ALL.into(),
        ..Default::default()
    };
    assert!(
        String::from_utf8(json::marshal(&room).unwrap())
            .unwrap()
            .contains(r#""notify":"all""#)
    );
    let n = NotifyArgs {
        room: "r".into(),
        level: NOTIFY_OFF.into(),
    };
    assert_eq!(json::marshal(&n).unwrap(), br#"{"room":"r","level":"off"}"#);
    assert_eq!(OP_NOTIFY, "notify");
}

// FR-CAL-9·10: 깨움 대기의 프레임 — 부른 글 수(called)는 개수만이다.
#[test]
fn wait_frames() {
    let f = Frame {
        t: TYPE_WAKE.into(),
        n: 4,
        total: 3,
        called: 1,
        ..Default::default()
    };
    assert_eq!(
        encode(&f).unwrap(),
        b"{\"t\":\"wake\",\"n\":4,\"total\":3,\"called\":1}\n"
    );
    assert_eq!(
        [TYPE_WAIT, TYPE_WAKE_ASK, TYPE_WAKE, TYPE_WAKE_DROP],
        ["wait", "wake?", "wake", "wake-drop"]
    );
}
