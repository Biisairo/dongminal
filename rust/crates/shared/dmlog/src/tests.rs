use std::io::Write;
use std::sync::{Arc, Mutex, MutexGuard};

use super::*;

/// 로거는 전역이므로 검사끼리 줄을 세운다.
static SERIAL: Mutex<()> = Mutex::new(());

#[derive(Clone, Default)]
struct Buf(Arc<Mutex<Vec<u8>>>);

impl Write for Buf {
    fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(b);
        Ok(b.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl Buf {
    fn text(&self) -> String {
        String::from_utf8(self.0.lock().unwrap().clone()).unwrap()
    }
}

fn setup(level: &str) -> (Buf, MutexGuard<'static, ()>) {
    let g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let buf = Buf::default();
    init(Options {
        level: level.into(),
        out: Some(Box::new(buf.clone())),
    });
    (buf, g)
}

// TC-OBS-1: 수준 하한이 듣는다.
#[test]
fn level_filters() {
    let (buf, _g) = setup("warn");
    infof!(None, "숨어야 한다");
    warnf!(None, "보여야 한다");
    let s = buf.text();
    assert!(!s.contains("숨어야"), "{s}");
    assert!(s.contains("보여야"), "{s}");
    reset();
}

// TC-OBS-2: 알 수 없는 수준은 info 로 떨어지고 오류가 아니다.
#[test]
fn unknown_level_falls_back_to_info() {
    let (buf, _g) = setup("nonsense");
    assert_eq!(level(), "info");
    infof!(None, "보여야 한다");
    assert!(buf.text().contains("보여야"));
    reset();
}

#[test]
fn level_names() {
    let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    for (input, want) in [
        ("debug", "debug"),
        (" DEBUG ", "debug"),
        ("warning", "warn"),
        ("Warn", "warn"),
        ("error", "error"),
        ("", "info"),
    ] {
        init(Options {
            level: input.into(),
            out: Some(Box::new(Buf::default())),
        });
        assert_eq!(level(), want, "{input:?}");
    }
    reset();
}

// 요청 ID 가 줄에 실린다 (FR-OBS-3·9).
#[test]
fn req_id_rides_ctx() {
    let (buf, _g) = setup("debug");
    warnf!(Some("abc123"), "무언가 {}", 7);
    let s = buf.text();
    assert!(s.contains("reqId=abc123"), "{s}");
    assert!(s.contains("무언가 7"), "{s}");
    reset();
}

// ID 가 없거나 비면 그 필드를 싣지 않는다.
#[test]
fn no_req_id_no_field() {
    let (buf, _g) = setup("debug");
    infof!(None, "민짜");
    infof!(Some(""), "민짜");
    assert!(!buf.text().contains("reqId"), "{}", buf.text());
    reset();
}

// 키-값 호출 (FR-OBS-4).
#[test]
fn structured_call() {
    let (buf, _g) = setup("debug");
    info(Some("r1"), "열었다", &[("tool", "t-9".into())]);
    let s = buf.text();
    for want in ["열었다", "tool", "t-9", "r1"] {
        assert!(s.contains(want), "{want:?} 가 없다: {s}");
    }
    reset();
}

#[test]
fn debug_hidden_at_info() {
    let (buf, _g) = setup("");
    debug(None, "숨어야", &[]);
    debugf!(None, "숨어야");
    error(None, "보여야", &[]);
    let s = buf.text();
    assert!(!s.contains("숨어야") && s.contains("level=ERROR"), "{s}");
    reset();
}

// FR-OBS-7: 클라이언트가 준 값은 검사를 지나야 쓰인다.
#[test]
fn sanitize() {
    let a64 = "a".repeat(64);
    let a65 = "a".repeat(65);
    for (input, want) in [
        ("abc-123_XY", "abc-123_XY"),
        ("", ""),
        ("has space", ""),
        ("new\nline", ""),
        ("세미콜론;", ""),
        (a64.as_str(), a64.as_str()),
        (a65.as_str(), ""),
    ] {
        assert_eq!(sanitize_req_id(input), want, "{input:?}");
    }
}

// 새로 만든 ID 는 자기 검사를 통과하고 겹치지 않는다.
#[test]
fn new_req_id_is_valid() {
    let mut seen = std::collections::HashSet::new();
    for _ in 0..100 {
        let id = new_req_id();
        assert_eq!(id.len(), 12);
        assert_eq!(sanitize_req_id(&id), id);
        assert!(seen.insert(id));
    }
}
