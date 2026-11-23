//! creds_test·oauth_test(WithTokens)·paths_test.

use std::fs;

use serde_json::Value;

use super::cred;
use crate::paths::profile_hash;
use crate::{ClaudePaths, Credential, TokenResult};

fn obj(c: &Credential) -> Value {
    serde_json::from_slice(&c.marshal().unwrap()).unwrap()
}

// TC-CAC-3: 모르는 필드 보존, 공유 필드 병합과 삭제. TC-CAC-4 의 지문.
#[test]
fn credential_round_trip_keeps_unknown() {
    let c = cred("at", "rt", r#""trustedDeviceToken":"tdt","newTop":{"x":1}"#);
    assert_eq!(
        (
            c.access_token(),
            c.refresh_token(),
            c.expires_at(),
            c.refresh_token_expires_at()
        ),
        (
            "at".into(),
            "rt".into(),
            1_700_000_000_000,
            1_800_000_000_000
        )
    );
    let m = obj(&c);
    assert!(m["newTop"].is_object() && m["trustedDeviceToken"] == "tdt");
    assert_eq!(m["claudeAiOauth"]["futureField"], 7);
    assert_eq!(m["claudeAiOauth"]["subscriptionType"], "max");
}

#[test]
fn credential_marshal_bytes_sorted_like_go() {
    let c =
        Credential::parse(br#"{"z":1,"claudeAiOauth":{"b":"<",  "a":[1, 2]},"a":true}"#).unwrap();
    assert_eq!(
        String::from_utf8(c.marshal().unwrap()).unwrap(),
        r#"{"a":true,"claudeAiOauth":{"a":[1,2],"b":"\u003c"},"z":1}"#
    );
}

#[test]
fn credential_parse_rejects_non_object() {
    for s in [
        "",
        "null",
        "[]",
        "\"x\"",
        "{bad",
        r#"{"claudeAiOauth":"x"}"#,
    ] {
        let e = Credential::parse(s.as_bytes()).unwrap_err();
        assert_eq!(e.to_string(), "자격증명이 JSON 객체가 아닙니다", "{s}");
    }
}

#[test]
fn credential_empty() {
    assert!(Credential::parse(b"{}").unwrap().is_empty());
    assert!(
        Credential::parse(br#"{"claudeAiOauth":{"accessToken":"","refreshToken":""}}"#)
            .unwrap()
            .is_empty()
    );
    assert!(!cred("a", "", "").is_empty());
}

#[test]
fn credential_fingerprint() {
    let (a, b, c) = (
        cred("at1", "rt", ""),
        cred("at2", "rt", ""),
        cred("at1", "rt2", ""),
    );
    assert_eq!(a.fingerprint(), b.fingerprint());
    assert_ne!(a.fingerprint(), c.fingerprint());
    assert_eq!(a.fingerprint().len(), 12);
    assert!(!a.fingerprint().contains("rt"));
    assert_eq!(Credential::parse(b"{}").unwrap().fingerprint(), "");
    // sha256("rt") 앞 12자리.
    assert_eq!(a.fingerprint(), "cdffd5dd8ca8");
}

#[test]
fn credential_with_shared() {
    let target = cred(
        "t",
        "tr",
        r#""mcpOAuth":{"old":1},"pluginSecrets":{"p":1},"trustedDeviceToken":"target-tdt""#,
    );
    let live = cred(
        "l",
        "lr",
        r#""mcpOAuth":{"new":2},"mcpXaaIdp":{"z":3},"trustedDeviceToken":"live-tdt""#,
    );
    let got = target.with_shared(&live);
    let m = obj(&got);
    assert_eq!(m["mcpOAuth"]["new"], 2);
    assert!(!m["mcpXaaIdp"].is_null());
    assert!(m.get("pluginSecrets").is_none());
    assert_eq!(m["trustedDeviceToken"], "target-tdt");
    assert_eq!(got.access_token(), "t");
}

#[test]
fn credential_with_tokens() {
    let c = cred("at", "rt", r#""mcpOAuth":{"m":1}"#);
    let tr = TokenResult {
        access_token: "a2".into(),
        expires_in: 60,
        scopes: vec!["s".into()],
        ..TokenResult::default()
    };
    let n = c.with_tokens(&tr, 1_000_000);
    assert_eq!(
        (n.access_token(), n.refresh_token(), n.expires_at()),
        ("a2".into(), "rt".into(), 1_000_000 + 60_000)
    );
    assert_eq!(obj(&n)["claudeAiOauth"]["scopes"], serde_json::json!(["s"]));
    let tr = TokenResult {
        access_token: "a3".into(),
        refresh_token: "r3".into(),
        expires_in: 60,
        ..TokenResult::default()
    };
    let n = c.with_tokens(&tr, 0);
    assert_eq!(n.refresh_token(), "r3");
    let s = String::from_utf8(n.marshal().unwrap()).unwrap();
    assert!(s.contains(r#""mcpOAuth":{"m":1}"#), "{s}");
    assert_eq!(c.access_token(), "at");
}

#[test]
fn credential_expired() {
    let c = Credential::parse(br#"{"claudeAiOauth":{"expiresAt":1000000}}"#).unwrap();
    let at = |ms: u64| std::time::UNIX_EPOCH + std::time::Duration::from_millis(ms);
    assert!(c.expired(at(1_000_000 - 300_000)));
    assert!(!c.expired(at(1_000_000 - 300_001)));
    assert!(Credential::parse(b"{}").unwrap().expired(at(0)));
}

#[test]
fn default_claude_paths() {
    let home = tempfile::tempdir().unwrap();
    let h = home.path();
    let p = ClaudePaths::default_for(h);
    assert_eq!(p.config_home, h.join(".claude"));
    assert_eq!(p.global_config, h.join(".claude.json"));
    assert_eq!(p.credentials, h.join(".claude").join(".credentials.json"));
    assert_eq!(p.keychain_service, "Claude Code-credentials");
    assert_eq!(
        p.cred_lock_dirs(),
        [
            h.join(".claude").join(".oauth_refresh.lock"),
            h.join(".claude.lock")
        ]
    );
    assert_eq!(p.config_lock_dir(), h.join(".claude.json.lock"));
}

#[test]
fn default_claude_paths_legacy_config() {
    let home = tempfile::tempdir().unwrap();
    let h = home.path();
    fs::create_dir_all(h.join(".claude")).unwrap();
    let legacy = h.join(".claude").join(".config.json");
    fs::write(&legacy, r#"{"a":1}"#).unwrap();
    assert_eq!(ClaudePaths::default_for(h).global_config, legacy);
    fs::write(&legacy, "").unwrap();
    assert_eq!(
        ClaudePaths::default_for(h).global_config,
        legacy,
        "empty legacy, no global"
    );
    fs::write(h.join(".claude.json"), "{}").unwrap();
    assert_eq!(
        ClaudePaths::default_for(h).global_config,
        h.join(".claude.json")
    );
}

#[test]
fn profile_claude_paths() {
    let dir = std::path::Path::new("/tmp/profiles/abc");
    let p = ClaudePaths::profile(dir);
    assert_eq!(p.config_home, dir);
    assert_eq!(p.global_config, dir.join(".claude.json"));
    assert_eq!(p.credentials, dir.join(".credentials.json"));
    assert_eq!(
        p.keychain_service,
        format!(
            "Claude Code-credentials-{}",
            profile_hash("/tmp/profiles/abc")
        )
    );
    // sha256("/tmp/profiles/abc") 앞 8자 (cswap session.py 와 같은 규칙).
    assert_eq!(profile_hash("/tmp/profiles/abc"), "ee03649f");
    // NFC 정규화: 조합형과 완성형이 같은 해시를 낸다.
    assert_eq!(
        profile_hash("/tmp/\u{1112}\u{1161}\u{11ab}"),
        profile_hash("/tmp/한")
    );
}
