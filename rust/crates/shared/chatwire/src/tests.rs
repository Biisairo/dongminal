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
