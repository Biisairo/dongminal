//! 진단 번들 전용 비밀 가림 (FR-RSP-6). Go 판은 URL userinfo(`sanitize_remote`)만 가려, 로그·설정 속의
//! 토큰·비밀번호·인증 헤더·개인키가 번들에 실릴 수 있었다.
//!
//! **비밀이 없는 입력은 바이트 하나 바꾸지 않는다** — 바꾸는 것은 아래 모양의 값 자리뿐이다.
//! - PEM 블록의 본문
//! - `Authorization`·`Cookie` 류 헤더 줄의 값, `Bearer <토큰>`
//! - 이름이 비밀을 뜻하는 JSON 문자열 값(`"apiToken":"…"`), `이름=값`, `이름: 값`

use std::sync::LazyLock;

use regex::{Captures, Regex};

/// 가린 자리에 남기는 표시다. `sanitize_remote` 와 같다.
const MASK: &str = "***";

/// 이름(소문자, `_`·`-`·`.` 를 뺀 것)이 이것으로 끝나면 비밀이다. `key` 하나만으로는 고르지
/// 않는다 — 단축키 설정(`"key":"ctrl+c"`)처럼 비밀이 아닌 자리가 흔하다.
const SECRET_SUFFIXES: [&str; 17] = [
    "token",
    "secret",
    "password",
    "passwd",
    "passphrase",
    "apikey",
    "privatekey",
    "accesskey",
    "secretkey",
    "signingkey",
    "clientsecret",
    "authorization",
    "auth",
    "cookie",
    "signature",
    "credential",
    "credentials",
];

/// 이름 그 자체로 비밀인 짧은 것들이다.
const SECRET_NAMES: [&str; 2] = ["sig", "pwd"];

fn re(p: &str) -> Regex {
    Regex::new(p).unwrap_or_else(|e| unreachable!("고정 정규식: {e}"))
}

static PEM: LazyLock<Regex> =
    LazyLock::new(|| re(r"(?s)(-----BEGIN [A-Z0-9 ]+-----).*?(-----END [A-Z0-9 ]+-----)"));
static HEADER: LazyLock<Regex> = LazyLock::new(|| {
    re(
        r"(?i)\b(proxy-authorization|authorization|set-cookie|cookie|x-api-key|x-auth-token)([ \t]*:[ \t]*)[^\r\n]*",
    )
});
static BEARER: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)\b(bearer)[ \t]+[A-Za-z0-9._~+/=\-]+"));
static JSON_KV: LazyLock<Regex> = LazyLock::new(|| re(r#""([^"\\]*)"(\s*:\s*)"(?:[^"\\]|\\.)*""#));
static ASSIGN: LazyLock<Regex> = LazyLock::new(|| re(r"([A-Za-z0-9_.\-]+)(?:=|:[ \t]*)"));

/// `이름=값`·`이름: 값` 의 값이 끝나는 글자다.
fn ends_value(c: char) -> bool {
    c.is_whitespace()
        || matches!(
            c,
            '&' | '"' | '\'' | '#' | ';' | ',' | '{' | '}' | '[' | ']'
        )
}

/// 이름이 비밀을 뜻하는지다.
pub(crate) fn is_secret_name(name: &str) -> bool {
    let n: String = name
        .chars()
        .filter(|c| !matches!(c, '_' | '-' | '.'))
        .flat_map(char::to_lowercase)
        .collect();
    SECRET_NAMES.contains(&n.as_str()) || SECRET_SUFFIXES.iter().any(|s| n.ends_with(s))
}

/// 번들에 싣기 전에 비밀 모양의 값을 가린다. 비밀이 없으면 입력 그대로다.
pub(crate) fn redact_secrets(s: &str) -> String {
    let s = PEM.replace_all(s, format!("${{1}}\n{MASK}\n${{2}}").as_str());
    let s = HEADER.replace_all(&s, format!("${{1}}${{2}}{MASK}").as_str());
    let s = BEARER.replace_all(&s, format!("${{1}} {MASK}").as_str());
    let s = JSON_KV.replace_all(&s, |c: &Captures<'_>| {
        if is_secret_name(&c[1]) {
            format!("\"{}\"{}\"{MASK}\"", &c[1], &c[2])
        } else {
            c[0].to_owned()
        }
    });
    mask_assignments(&s)
}

/// 비밀 이름 뒤의 값을 가린다. 값을 먹지 않고 이름·구분자만 맞추므로, 비밀이 아닌 값 안의 비밀
/// (`url=https://h/p?X-Amz-Signature=…`)도 계속 살핀다.
fn mask_assignments(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut at = 0;
    while let Some(c) = ASSIGN.captures_at(s, at) {
        let (Some(whole), Some(name)) = (c.get(0), c.get(1)) else {
            break;
        };
        if !is_secret_name(name.as_str()) {
            out.push_str(&s[at..whole.end()]);
            at = whole.end();
            continue;
        }
        let rest = &s[whole.end()..];
        let n = rest.find(ends_value).unwrap_or(rest.len());
        out.push_str(&s[at..whole.end()]);
        if n == 0 || &rest[..n] == MASK {
            out.push_str(&rest[..n]);
        } else {
            out.push_str(MASK);
        }
        at = whole.end() + n;
    }
    out.push_str(&s[at..]);
    out
}
