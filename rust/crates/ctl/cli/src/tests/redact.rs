//! 진단 번들 전용 비밀 가림 — 비밀 모양마다 카나리, 비밀 없는 입력은 그대로 (FR-RSP-6).

use crate::redact::{is_secret_name, redact_secrets};

const CANARY: &str = "CANARY9f3k2LmQ";

fn assert_masked(input: &str, want: &str) {
    let got = redact_secrets(input);
    assert!(!got.contains(CANARY), "카나리가 남았다:\n{got}");
    assert_eq!(got, want);
}

#[test]
fn pem_block() {
    let input = format!(
        "앞\n-----BEGIN OPENSSH PRIVATE KEY-----\n{CANARY}\nAAAA\n-----END OPENSSH PRIVATE KEY-----\n뒤\n"
    );
    assert_masked(
        &input,
        "앞\n-----BEGIN OPENSSH PRIVATE KEY-----\n***\n-----END OPENSSH PRIVATE KEY-----\n뒤\n",
    );
}

#[test]
fn auth_headers() {
    assert_masked(
        &format!("req Authorization: Basic {CANARY}\nnext"),
        "req Authorization: ***\nnext",
    );
    assert_masked(&format!("Cookie: sid={CANARY}; x=1"), "Cookie: ***");
    assert_masked(&format!("set-cookie:{CANARY}"), "set-cookie:***");
    assert_masked(&format!("X-Api-Key: {CANARY}"), "X-Api-Key: ***");
    assert_masked(
        &format!("call with Bearer {CANARY}.x-y"),
        "call with Bearer ***",
    );
}

#[test]
fn json_values() {
    assert_masked(
        &format!(r#"{{"apiToken":"{CANARY}","themeName":"dark","client_secret" : "{CANARY}\"x"}}"#),
        r#"{"apiToken":"***","themeName":"dark","client_secret" : "***"}"#,
    );
    assert_masked(
        &format!(r#"{{"password":"{CANARY}","privateKey":"{CANARY}","sig":"{CANARY}"}}"#),
        r#"{"password":"***","privateKey":"***","sig":"***"}"#,
    );
}

#[test]
fn query_and_assignments() {
    assert_masked(
        &format!("GET /x?access_token={CANARY}&page=2 HTTP/1.1"),
        "GET /x?access_token=***&page=2 HTTP/1.1",
    );
    assert_masked(
        &format!("url=https://h/p?X-Amz-Signature={CANARY}&sig={CANARY}"),
        "url=https://h/p?X-Amz-Signature=***&sig=***",
    );
    assert_masked(&format!("PASSWORD={CANARY} next"), "PASSWORD=*** next");
    assert_masked(&format!("auth: {CANARY}"), "auth: ***");
    assert_masked(&format!("GITHUB_TOKEN={CANARY}"), "GITHUB_TOKEN=***");
}

// 비밀이 없는 입력은 바이트 하나 바꾸지 않는다 — Go 번들과 같아야 한다.
#[test]
fn no_secret_is_unchanged() {
    for s in [
        "",
        "line1\nline2\n",
        r#"{"themeName":"dark","keybar":{"a":true},"key":"ctrl+c","fontSize":13}"#,
        "time=2026-11-23T12:00:00.000+09:00 level=INFO msg=\"[tool 01a2] started shell=/bin/zsh pid=1 cwd=/x cols=80 rows=24\"",
        "GET /api/tools/output?id=abc&bytes=1024 200 author=kim",
        "remote https://***@github.com/x/y.git",
        "basic setup done: ok\nkey: value\nmonkey=1 hotkey=ctrl",
        "-----BEGIN-----\n",
        "a\u{0}b\r\n\t한글 ✅",
    ] {
        assert_eq!(redact_secrets(s), s);
    }
}

#[test]
fn secret_names() {
    for n in [
        "token",
        "apiToken",
        "access_token",
        "GITHUB_TOKEN",
        "client-secret",
        "password",
        "passwd",
        "pwd",
        "privateKey",
        "accessKey",
        "authorization",
        "auth",
        "oauth",
        "cookie",
        "sig",
        "X-Amz-Signature",
        "credentials",
    ] {
        assert!(is_secret_name(n), "{n}");
    }
    for n in [
        "key",
        "keybar",
        "hotkey",
        "monkey",
        "author",
        "themeName",
        "signal",
        "id",
        "https",
    ] {
        assert!(!is_secret_name(n), "{n}");
    }
}
