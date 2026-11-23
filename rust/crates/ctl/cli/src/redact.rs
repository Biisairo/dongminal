//! 진단 번들 전용 비밀 가림 (FR-RSP-6). Go 판은 URL userinfo(`sanitize_remote`)만 가려, 로그·설정 속의
//! 토큰·비밀번호·인증 헤더·개인키가 번들에 실릴 수 있었다.
//!
//! **비밀이 없는 입력은 바이트 하나 바꾸지 않는다** — 바꾸는 것은 아래 모양의 값 자리뿐이다.
//! - PEM 블록의 본문. 로그 끝 자르기로 한쪽 표시만 남으면 그 표시부터 입력 끝(처음)까지
//! - `Authorization`·`Cookie` 류 헤더 줄의 값, `Bearer <토큰>`
//! - 이름이 비밀을 뜻하는 JSON 문자열 값(`"apiToken":"…"`, slog 줄 안의 `\"apiToken\":\"…\"`),
//!   `이름=값`, `이름: 값`(구분자 둘레 공백, 따옴표 값 포함)

use std::sync::LazyLock;

use regex::Regex;

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

static PEM_MARK: LazyLock<Regex> = LazyLock::new(|| re(r"-----(BEGIN|END) [A-Z0-9 ]+-----"));
static HEADER: LazyLock<Regex> = LazyLock::new(|| {
    re(
        r"(?i)\b(proxy-authorization|authorization|set-cookie|cookie|x-api-key|x-auth-token)([ \t]*:[ \t]*)[^\r\n]*",
    )
});
static BEARER: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)\b(bearer)[ \t]+[A-Za-z0-9._~+/=\-]+"));
static JSON_KEY: LazyLock<Regex> = LazyLock::new(|| re(r#"\\?"([^"\\]*)\\?"\s*:\s*"#));
static ASSIGN: LazyLock<Regex> = LazyLock::new(|| re(r"([A-Za-z0-9_.\-]+)[ \t]*(?:=|:)[ \t]*"));

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
    let s = mask_pem(s);
    let s = HEADER.replace_all(&s, format!("${{1}}${{2}}{MASK}").as_str());
    let s = BEARER.replace_all(&s, format!("${{1}} {MASK}").as_str());
    let s = mask_values(&s, &JSON_KEY, false);
    mask_values(&s, &ASSIGN, true)
}

/// PEM 본문을 가린다. 짝이 맞으면 두 표시 사이를, BEGIN 만 남으면 입력 끝까지, END 만 남으면
/// 앞 자리(입력 처음이나 앞 블록의 끝)부터 END 까지 가린다.
fn mask_pem(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut at = 0;
    let mut begin: Option<usize> = None;
    for c in PEM_MARK.captures_iter(s) {
        let (Some(m), Some(kind)) = (c.get(0), c.get(1)) else {
            continue;
        };
        match (kind.as_str(), begin) {
            ("BEGIN", None) => begin = Some(m.end()),
            ("BEGIN", Some(_)) => {}
            (_, Some(b)) => {
                out.push_str(&s[at..b]);
                out.push('\n');
                out.push_str(MASK);
                out.push('\n');
                out.push_str(m.as_str());
                at = m.end();
                begin = None;
            }
            (_, None) => {
                out.push_str(MASK);
                out.push('\n');
                out.push_str(m.as_str());
                at = m.end();
            }
        }
    }
    match begin {
        Some(b) => {
            out.push_str(&s[at..b]);
            out.push('\n');
            out.push_str(MASK);
        }
        None => out.push_str(&s[at..]),
    }
    out
}

/// 값 자리다. `rest` 기준으로 여는 따옴표 길이, 값 끝, 닫는 따옴표 길이.
struct Value {
    open: usize,
    end: usize,
    close: usize,
}

/// `rest` 앞의 값을 읽는다. 따옴표 값(`"…"`·`'…'`, 한 번 더 인용된 `\"…\"`)은 이스케이프를 건너뛰며
/// 짝 따옴표까지, 짝이 없으면 줄 끝까지다. `bare` 면 따옴표 없는 값도 `ends_value` 까지 읽는다.
fn value_at(rest: &str, bare: bool) -> Value {
    let b = rest.as_bytes();
    match b {
        [q @ (b'"' | b'\''), ..] => {
            let (end, close) = scan_quoted(b, *q);
            Value {
                open: 1,
                end,
                close,
            }
        }
        [b'\\', q @ (b'"' | b'\''), ..] => {
            let (end, close) = scan_escaped(b, *q);
            Value {
                open: 2,
                end,
                close,
            }
        }
        _ if bare => Value {
            open: 0,
            end: rest.find(ends_value).unwrap_or(rest.len()),
            close: 0,
        },
        _ => Value {
            open: 0,
            end: 0,
            close: 0,
        },
    }
}

/// `q…q` 의 값 끝과 닫는 따옴표 길이다. `\` 는 다음 바이트를 값으로 묶는다.
fn scan_quoted(b: &[u8], q: u8) -> (usize, usize) {
    let mut i = 1;
    while i < b.len() {
        match b[i] {
            b'\n' | b'\r' => return (i, 0),
            b'\\' => i += 2,
            x if x == q => return (i, 1),
            _ => i += 1,
        }
    }
    (b.len(), 0)
}

/// 한 번 더 인용된 `\q…\q` 의 값 끝과 닫는 따옴표 길이다. 바깥 이스케이프 `\x` 는 두 바이트,
/// 안쪽 이스케이프(`\\` 뒤의 바깥 한 단위, 예: `\\\"`)는 값의 일부다.
fn scan_escaped(b: &[u8], q: u8) -> (usize, usize) {
    let mut i = 2;
    while i < b.len() {
        match (b[i], b.get(i + 1)) {
            (b'\n' | b'\r', _) => return (i, 0),
            (b'\\', Some(&x)) if x == q => return (i, 2),
            (b'\\', Some(b'\\')) => i += if b.get(i + 2) == Some(&b'\\') { 4 } else { 3 },
            (b'\\', _) => i += 2,
            _ => i += 1,
        }
    }
    (b.len(), 0)
}

/// `re` 가 맞춘 비밀 이름(1번 묶음) 뒤의 값을 가린다. 값을 먹지 않고 이름·구분자만 맞추므로, 비밀이
/// 아닌 값 안의 비밀(`url=https://h/p?X-Amz-Signature=…`, JSON 문자열 속 인용된 JSON)도 계속 살핀다.
fn mask_values(s: &str, re: &Regex, bare: bool) -> String {
    let mut out = String::with_capacity(s.len());
    let mut at = 0;
    while let Some(c) = re.captures_at(s, at) {
        let (Some(whole), Some(name)) = (c.get(0), c.get(1)) else {
            break;
        };
        out.push_str(&s[at..whole.end()]);
        at = whole.end();
        if !is_secret_name(name.as_str()) {
            continue;
        }
        let rest = &s[at..];
        let v = value_at(rest, bare);
        let value = &rest[v.open..v.end];
        if value.is_empty() || value == MASK {
            out.push_str(&rest[..v.end + v.close]);
        } else {
            out.push_str(&rest[..v.open]);
            out.push_str(MASK);
            out.push_str(&rest[v.end..v.end + v.close]);
        }
        at += v.end + v.close;
    }
    out.push_str(&s[at..]);
    out
}
