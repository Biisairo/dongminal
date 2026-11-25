//! 데몬이 답할 질의의 답(D-23): DA·DSR·커서 위치만 모으고 색 질의 등은 버린다.

use super::*;

fn replies(input: &[u8]) -> String {
    let mut s = Screen::new(80, 24, HISTORY_CAP);
    s.feed(input);
    String::from_utf8(s.take_replies()).unwrap()
}

#[test]
fn device_attributes_are_answered() {
    let r = replies(b"\x1b[c");
    assert!(r.starts_with("\x1b[?") && r.ends_with('c'), "{r:?}");
    let r2 = replies(b"\x1b[>c");
    assert!(r2.starts_with("\x1b[>") && r2.ends_with('c'), "{r2:?}");
}

#[test]
fn status_and_cursor_position_are_answered() {
    assert_eq!(replies(b"\x1b[5n"), "\x1b[0n");
    assert_eq!(replies(b"\x1b[3;7H\x1b[6n"), "\x1b[3;7R");
}

#[test]
fn several_queries_in_one_feed_answer_in_order() {
    assert_eq!(replies(b"\x1b[5nab\x1b[6n"), "\x1b[0n\x1b[1;3R");
}

#[test]
fn colour_mode_and_keyboard_queries_are_not_answered() {
    assert_eq!(replies(b"\x1b]10;?\x07\x1b]11;?\x07"), "");
    assert_eq!(replies(b"\x1b[?2004$p"), "");
    assert_eq!(replies(b"\x1b[?u"), "");
    assert_eq!(replies(b"plain text\r\n"), "");
}

#[test]
fn take_drains() {
    let mut s = Screen::new(80, 24, HISTORY_CAP);
    s.feed(b"\x1b[5n");
    assert!(!s.take_replies().is_empty());
    assert!(s.take_replies().is_empty());
}

#[test]
fn restore_does_not_carry_replies() {
    let mut a = Screen::new(80, 24, HISTORY_CAP);
    a.feed(b"hi");
    let h = a.handover();
    let mut b = Screen::restore(80, 24, HISTORY_CAP, &h.snapshot, &h.store);
    assert!(b.take_replies().is_empty());
}
