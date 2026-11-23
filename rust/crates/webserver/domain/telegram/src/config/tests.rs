//! Go `config_test.go`·`config_perm_test.go` (TC-TGB-1·2).

use super::*;

const TEST_TOKEN: &str = "123456:SECRET-token-value";

fn open_temp() -> (Store, PathBuf, tempfile::TempDir) {
    let d = tempfile::tempdir().unwrap();
    let p = d.path().join("telegram.json");
    (Store::open(&p), p, d)
}

#[test]
fn defaults() {
    let (s, _, _d) = open_temp();
    let c = s.config();
    assert!(!c.enabled && c.token.is_empty() && c.user_id == 0);
    assert_eq!(c.silence_min, DEFAULT_SILENCE_MIN);
}

#[test]
fn round_trip_and_file_bytes() {
    let (s, p, _d) = open_temp();
    s.set_token(TEST_TOKEN, "office<bot>").unwrap();
    s.set_enabled(true).unwrap();
    let c = Store::open(&p).config();
    assert!(c.enabled);
    assert_eq!(c.token, TEST_TOKEN);
    assert_eq!(c.bot_name, "office<bot>");
    // Go json.MarshalIndent(c, "", "  ") — 필드 순서·HTML 이스케이프·끝 줄바꿈 없음.
    assert_eq!(
        std::fs::read_to_string(&p).unwrap(),
        "{\n  \"enabled\": true,\n  \"token\": \"123456:SECRET-token-value\",\n  \"botName\": \"office\\u003cbot\\u003e\",\n  \"userId\": 0,\n  \"silenceMin\": 5\n}"
    );
}

#[test]
fn view_hides_token() {
    let (s, _, _d) = open_temp();
    s.set_token(TEST_TOKEN, "office_bot").unwrap();
    s.set_user(42).unwrap();
    let v = s.view();
    let raw = String::from_utf8(dm_gocompat::json::marshal(&v).unwrap()).unwrap();
    assert!(!raw.contains("SECRET"), "{raw}");
    assert_eq!(
        raw,
        r#"{"enabled":false,"tokenSet":true,"botName":"office_bot","paired":true,"silenceMin":5}"#
    );
}

#[test]
fn set_token_resets_pairing() {
    let (s, _, _d) = open_temp();
    s.set_token(TEST_TOKEN, "a").unwrap();
    s.set_user(42).unwrap();
    s.set_token("999:other", "b").unwrap();
    assert_eq!(s.config().user_id, 0);
    s.set_user(43).unwrap();
    s.set_token("999:other", "b").unwrap();
    assert_eq!(s.config().user_id, 43);
}

#[test]
fn silence_bounds() {
    let (s, _, _d) = open_temp();
    assert_eq!(s.set_silence(0), Ok(()));
    assert_eq!(s.set_silence(-1), Err(StoreError::InvalidSilence));
    assert_eq!(
        s.set_silence(MAX_SILENCE_MIN + 1),
        Err(StoreError::InvalidSilence)
    );
    assert_eq!(
        StoreError::InvalidSilence.to_string(),
        "무음 시간은 0~1440분입니다"
    );
    assert_eq!(
        StoreError::SaveFailed.to_string(),
        "Telegram 설정을 저장하지 못했습니다"
    );
}

#[test]
fn reads_revision1_file() {
    let d = tempfile::tempdir().unwrap();
    let p = d.path().join("telegram.json");
    let old = format!(
        r#"{{"enabled":true,"token":"{TEST_TOKEN}","userId":42,"silenceMin":3,"topics":{{"s":{{"threadId":7}}}}}}"#
    );
    std::fs::write(&p, old).unwrap();
    let s = Store::open(&p);
    let c = s.config();
    assert!(c.enabled && c.user_id == 42 && c.silence_min == 3);
    s.set_silence(4).unwrap();
    assert!(!std::fs::read_to_string(&p).unwrap().contains("topics"));
}

#[test]
fn missing_fields_keep_defaults() {
    let d = tempfile::tempdir().unwrap();
    let p = d.path().join("telegram.json");
    std::fs::write(&p, r#"{"enabled":true,"silenceMin":null}"#).unwrap();
    let c = Store::open(&p).config();
    assert!(c.enabled);
    assert_eq!(c.silence_min, DEFAULT_SILENCE_MIN);
}

#[test]
fn broken_file_starts_disabled() {
    let d = tempfile::tempdir().unwrap();
    let p = d.path().join("telegram.json");
    std::fs::write(&p, "{broken").unwrap();
    assert!(!Store::open(&p).config().enabled);
}

#[test]
fn failed_write_keeps_memory() {
    let d = tempfile::tempdir().unwrap();
    let blocker = d.path().join("file");
    std::fs::write(&blocker, b"").unwrap();
    let s = Store::open(blocker.join("telegram.json"));
    assert_eq!(s.set_enabled(true), Err(StoreError::SaveFailed));
    assert!(!s.config().enabled);
}

#[cfg(unix)]
#[test]
fn file_mode_600() {
    use std::os::unix::fs::PermissionsExt;
    let (s, p, _d) = open_temp();
    s.set_token(TEST_TOKEN, "office_bot").unwrap();
    let mode = std::fs::metadata(&p).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o600);
}
