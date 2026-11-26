//! ISSUE_TREE_CHAT_SRS FR-TGT-4 — 방과 토픽의 짝 파일.

use std::os::unix::fs::PermissionsExt;

use super::*;

fn open_temp() -> (TopicMap, std::path::PathBuf, tempfile::TempDir) {
    let d = tempfile::tempdir().unwrap();
    let p = d.path().join(TOPICS_FILE);
    (TopicMap::open(&p), p, d)
}

fn topic(thread: i64) -> Topic {
    Topic {
        thread_id: thread,
        pin_id: thread + 100,
        name: format!("room{thread}"),
        pin_text: "pin".into(),
    }
}

#[test]
fn set_get_remove_and_reopen() {
    let (m, p, _d) = open_temp();
    assert!(m.rooms().is_empty());
    m.set("r1", topic(7)).unwrap();
    m.set("r2", topic(9)).unwrap();
    assert_eq!(m.get("r1"), Some(topic(7)));
    assert_eq!(m.rooms(), vec!["r1".to_string(), "r2".to_string()]);
    m.remove("r1").unwrap();
    let again = TopicMap::open(&p);
    assert_eq!(again.get("r1"), None);
    assert_eq!(again.get("r2"), Some(topic(9)));
    assert_eq!(again.by_thread(9).as_deref(), Some("r2"));
    assert_eq!(again.by_thread(7), None);
}

#[test]
fn file_mode_600() {
    let (m, p, _d) = open_temp();
    m.set("r1", topic(1)).unwrap();
    let mode = std::fs::metadata(&p).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o600);
}

#[test]
fn broken_file_starts_empty() {
    let d = tempfile::tempdir().unwrap();
    let p = d.path().join(TOPICS_FILE);
    std::fs::write(&p, "{not json").unwrap();
    assert!(TopicMap::open(&p).rooms().is_empty());
}

#[test]
fn file_sits_next_to_settings() {
    assert_eq!(
        topics_path(std::path::Path::new("/x/telegram.json")),
        std::path::PathBuf::from("/x").join(TOPICS_FILE)
    );
}
