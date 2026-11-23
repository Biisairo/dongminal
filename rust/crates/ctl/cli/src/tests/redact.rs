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

// 우회 ①: 따옴표 값과 구분자 둘레 공백.
#[test]
fn quoted_and_spaced_assignments() {
    assert_masked(
        &format!(r#"token="{CANARY} x" next"#),
        r#"token="***" next"#,
    );
    assert_masked(
        &format!("password='{CANARY} x'; y=1"),
        "password='***'; y=1",
    );
    assert_masked(&format!(r#"secret: "{CANARY}""#), r#"secret: "***""#);
    assert_masked(&format!("api_key = {CANARY} y"), "api_key = *** y");
    assert_masked(&format!("passwd\t=\t{CANARY}"), "passwd\t=\t***");
    assert_masked(&format!("token : {CANARY}"), "token : ***");
    assert_masked(
        &format!(r#"token="{CANARY}\"{CANARY}" z"#),
        r#"token="***" z"#,
    );
    assert_masked(&format!(r#"token='{CANARY}\'{CANARY}' z"#), "token='***' z");
    // 닫는 따옴표가 없으면 그 줄 끝까지 가린다.
    assert_masked(&format!("token=\"{CANARY} x\nnext"), "token=\"***\nnext");
    assert_masked(&format!("token='{CANARY}"), "token='***");
    // 빈 값·이미 가린 값은 그대로다.
    for s in [
        r#"token="" x"#,
        "token='' x",
        r#"token="***""#,
        "token = \nnext",
    ] {
        assert_eq!(redact_secrets(s), s);
    }
}

// FR-RDF-12: 비밀 이름 뒤의 JSON 숫자 값도 가린다. JSON 이 깨지지 않게 문자열 `"***"` 로 바꾼다.
// true·false·null 은 비밀이 아니므로 그대로 둔다.
#[test]
fn json_number_values() {
    const NUM: &str = "8675309421";
    let got = redact_secrets(&format!(
        r#"{{"password": {NUM},"pin":1,"apiToken":-{NUM}.5e+3,"fontSize":13}}"#
    ));
    assert!(!got.contains(NUM), "숫자 카나리가 남았다:\n{got}");
    assert_eq!(
        got,
        r#"{"password": "***","pin":1,"apiToken":"***","fontSize":13}"#
    );
    let got = redact_secrets(&format!(r#"msg="body={{\"token\":{NUM},\"n\":2}}" n=1"#));
    assert!(!got.contains(NUM), "숫자 카나리가 남았다:\n{got}");
    assert_eq!(got, r#"msg="body={\"token\":\"***\",\"n\":2}" n=1"#);
    for s in [
        r#"{"password":true,"token":false,"secret":null}"#,
        r#"{"token": null, "auth":{"a":1}}"#,
    ] {
        assert_eq!(redact_secrets(s), s);
    }
}

// 우회 ②: slog 텍스트 줄 안의 이스케이프된 JSON·따옴표.
#[test]
fn escaped_json_in_slog_line() {
    assert_masked(
        &format!(r#"level=INFO msg="body={{\"token\":\"{CANARY}\",\"themeName\":\"dark\"}}" n=1"#),
        r#"level=INFO msg="body={\"token\":\"***\",\"themeName\":\"dark\"}" n=1"#,
    );
    // 값 안의 이스케이프된 따옴표(JSON \" 가 한 번 더 인용된 \\\")도 값의 일부다.
    assert_masked(
        &format!(r#"msg="{{\"apiToken\" : \"{CANARY}\\\"{CANARY}\"}}""#),
        r#"msg="{\"apiToken\" : \"***\"}""#,
    );
    assert_masked(
        &format!(r#"msg="run password=\"{CANARY} x\" ok" n=1"#),
        r#"msg="run password=\"***\" ok" n=1"#,
    );
    assert_masked(
        &format!(r#"msg="secret: \"{CANARY}\\\\\"" n=1"#),
        r#"msg="secret: \"***\"" n=1"#,
    );
    assert_masked(&format!(r#"msg="token=\"{CANARY}"#), r#"msg="token=\"***"#);
    for s in [
        r#"msg="body={\"themeName\":\"dark\",\"key\":\"ctrl+c\"}" n=1"#,
        r#"msg="{\"token\":\"\"}""#,
        r#"msg="run token=\"\" ok""#,
    ] {
        assert_eq!(redact_secrets(s), s);
    }
}

// 이스케이프 뒤의 여러 바이트 글자·입력 끝에서 끊긴 값도 패닉 없이 가린다.
#[test]
fn cut_values_do_not_panic() {
    for (input, want) in [
        ("token=\"\\한글", "token=\"***"),
        ("token='한\\", "token='***"),
        ("msg=\"token=\\\"\\\\한", "msg=\"token=\\\"***"),
        ("msg=\"token=\\\"\\\\\\", "msg=\"token=\\\"***"),
        ("{\\\"token\\\":\\\"\\", "{\\\"token\\\":\\\"***"),
        ("token=\\", "token=***"),
    ] {
        assert_eq!(redact_secrets(input), want, "{input}");
    }
}

// 우회 ③: 로그 끝 자르기로 PEM 의 한쪽 표시만 남은 경우.
#[test]
fn pem_half_block() {
    assert_masked(
        &format!("앞\n-----BEGIN RSA PRIVATE KEY-----\n{CANARY}\nAAAA\n"),
        "앞\n-----BEGIN RSA PRIVATE KEY-----\n***",
    );
    assert_masked(
        &format!("{CANARY}\nAAAA\n-----END RSA PRIVATE KEY-----\n뒤\n"),
        "***\n-----END RSA PRIVATE KEY-----\n뒤\n",
    );
    assert_masked(
        &format!(
            "{CANARY}\n-----END EC PRIVATE KEY-----\n가\n-----BEGIN EC PRIVATE KEY-----\n{CANARY}\n-----END EC PRIVATE KEY-----\n나\n-----BEGIN EC PRIVATE KEY-----\n{CANARY}"
        ),
        "***\n-----END EC PRIVATE KEY-----\n가\n-----BEGIN EC PRIVATE KEY-----\n***\n-----END EC PRIVATE KEY-----\n나\n-----BEGIN EC PRIVATE KEY-----\n***",
    );
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
