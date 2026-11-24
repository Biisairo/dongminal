//! Go `mime.ParseMediaType` (go1.27.2). `Content-Type`·`Content-Disposition` 을 읽는다 — 업로드의
//! multipart 판정과 파일 이름이 이것에 기댄다. 값은 바이트로 다룬다(Go 문자열과 같다).

use std::collections::HashMap;

/// 풀리지 않은 미디어 형이다. 어느 오류인지는 관측되지 않는다(모두 400 이 된다).
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Invalid;

fn is_tspecial(c: u8) -> bool {
    b"()<>@,;:\\\"/[]?=".contains(&c)
}

fn is_token_char(c: u8) -> bool {
    c > 0x20 && c < 0x7f && !is_tspecial(c)
}

fn consume_token(v: &[u8]) -> (&[u8], &[u8]) {
    let i = v.iter().position(|&c| !is_token_char(c)).unwrap_or(v.len());
    (&v[..i], &v[i..])
}

/// Go `strings.TrimLeftFunc(v, unicode.IsSpace)`.
fn trim_left_space(v: &[u8]) -> &[u8] {
    let s = String::from_utf8_lossy(v);
    let trimmed = s.trim_start_matches(char::is_whitespace);
    if trimmed.len() == s.len() {
        return v;
    }
    // 잘린 앞부분은 공백 글자라 언제나 올바른 UTF-8 이다 — 원래 바이트의 같은 자리다.
    &v[s.len() - trimmed.len()..]
}

fn consume_value(v: &[u8]) -> (Vec<u8>, &[u8]) {
    if v.is_empty() {
        return (Vec::new(), v);
    }
    if v[0] != b'"' {
        let (t, rest) = consume_token(v);
        return (t.to_vec(), rest);
    }
    let mut buf = Vec::new();
    let mut i = 1;
    while i < v.len() {
        let r = v[i];
        if r == b'"' {
            return (buf, &v[i + 1..]);
        }
        if r == b'\\' && i + 1 < v.len() && is_tspecial(v[i + 1]) {
            buf.push(v[i + 1]);
            i += 2;
            continue;
        }
        if r == b'\r' || r == b'\n' {
            return (Vec::new(), v);
        }
        buf.push(r);
        i += 1;
    }
    (Vec::new(), v)
}

/// `(param, value, rest)`. 풀지 못하면 param 이 빈다.
fn consume_media_param(v: &[u8]) -> (Vec<u8>, Vec<u8>, &[u8]) {
    let rest = trim_left_space(v);
    let Some(rest) = rest.strip_prefix(b";") else {
        return (Vec::new(), Vec::new(), v);
    };
    let rest = trim_left_space(rest);
    let (param, rest) = consume_token(rest);
    let param = param.to_ascii_lowercase();
    if param.is_empty() {
        return (Vec::new(), Vec::new(), v);
    }
    let rest = trim_left_space(rest);
    let Some(rest) = rest.strip_prefix(b"=") else {
        return (Vec::new(), Vec::new(), v);
    };
    let rest = trim_left_space(rest);
    let (value, rest2) = consume_value(rest);
    if value.is_empty() && rest2.len() == rest.len() {
        return (Vec::new(), Vec::new(), v);
    }
    (param, value, rest2)
}

fn unhex(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}

fn percent_hex_unescape(s: &[u8]) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(s.len());
    let mut i = 0;
    while i < s.len() {
        if s[i] != b'%' {
            out.push(s[i]);
            i += 1;
            continue;
        }
        let hi = s.get(i + 1).copied().and_then(unhex)?;
        let lo = s.get(i + 2).copied().and_then(unhex)?;
        out.push(hi << 4 | lo);
        i += 3;
    }
    Some(out)
}

fn decode_2231_enc(v: &[u8]) -> Option<Vec<u8>> {
    let q = v.iter().position(|&c| c == b'\'')?;
    let (charset, rest) = (&v[..q], &v[q + 1..]);
    let q2 = rest.iter().position(|&c| c == b'\'')?;
    let ext = &rest[q2 + 1..];
    let charset = charset.to_ascii_lowercase();
    if charset != b"us-ascii" && charset != b"utf-8" {
        return None;
    }
    percent_hex_unescape(ext)
}

fn check_media_type_disposition(s: &[u8]) -> Result<(), Invalid> {
    let (typ, rest) = consume_token(s);
    if typ.is_empty() {
        return Err(Invalid);
    }
    if rest.is_empty() {
        return Ok(());
    }
    let rest = rest.strip_prefix(b"/").ok_or(Invalid)?;
    let (sub, rest) = consume_token(rest);
    if sub.is_empty() || !rest.is_empty() {
        return Err(Invalid);
    }
    Ok(())
}

/// Go `mime.ParseMediaType`: 미디어 형(소문자)과 매개변수(키 소문자)다.
pub(crate) fn parse_media_type(v: &[u8]) -> Result<(String, HashMap<String, Vec<u8>>), Invalid> {
    let semi = v.iter().position(|&c| c == b';').unwrap_or(v.len());
    let base = String::from_utf8_lossy(&v[..semi]).to_lowercase();
    let mediatype = base.trim().to_owned();
    check_media_type_disposition(mediatype.as_bytes())?;

    let mut params: HashMap<Vec<u8>, Vec<u8>> = HashMap::new();
    let mut continuation: HashMap<Vec<u8>, HashMap<Vec<u8>, Vec<u8>>> = HashMap::new();
    let mut v = &v[semi..];
    while !v.is_empty() {
        v = trim_left_space(v);
        if v.is_empty() {
            break;
        }
        let (key, value, rest) = consume_media_param(v);
        if key.is_empty() {
            if String::from_utf8_lossy(rest).trim() == ";" {
                break;
            }
            return Err(Invalid);
        }
        let pmap = match key.iter().position(|&c| c == b'*') {
            Some(i) => continuation.entry(key[..i].to_vec()).or_default(),
            None => &mut params,
        };
        if let Some(old) = pmap.get(&key)
            && *old != value
        {
            return Err(Invalid);
        }
        pmap.insert(key, value);
        v = rest;
    }

    for (key, pieces) in continuation {
        let mut single = key.clone();
        single.push(b'*');
        if let Some(v) = pieces.get(&single) {
            if let Some(d) = decode_2231_enc(v) {
                params.insert(key, d);
            }
            continue;
        }
        let mut buf = Vec::new();
        let mut valid = false;
        for n in 0.. {
            let mut simple = key.clone();
            simple.extend_from_slice(format!("*{n}").as_bytes());
            if let Some(v) = pieces.get(&simple) {
                valid = true;
                buf.extend_from_slice(v);
                continue;
            }
            let mut encoded = simple;
            encoded.push(b'*');
            let Some(v) = pieces.get(&encoded) else {
                break;
            };
            valid = true;
            if n == 0 {
                if let Some(d) = decode_2231_enc(v) {
                    buf.extend_from_slice(&d);
                }
            } else {
                buf.extend_from_slice(&percent_hex_unescape(v).unwrap_or_default());
            }
        }
        if valid {
            params.insert(key, buf);
        }
    }
    let params = params
        .into_iter()
        .map(|(k, v)| (String::from_utf8_lossy(&k).into_owned(), v))
        .collect();
    Ok((mediatype, params))
}

fn is_token(s: &[u8]) -> bool {
    !s.is_empty() && s.iter().all(|&c| is_token_char(c))
}

/// Go `needsEncoding`: 탭이 아닌 제어 문자나 ASCII 밖의 글자가 있는가다.
fn needs_encoding(s: &[u8]) -> bool {
    s.iter().any(|&b| !(b' '..=b'~').contains(&b) && b != b'\t')
}

/// Go `mime.FormatMediaType`. 형식에 맞지 않으면 빈 값이다.
pub(crate) fn format_media_type(t: &str, param: &HashMap<String, Vec<u8>>) -> Vec<u8> {
    const UPPERHEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut b = Vec::new();
    match t.split_once('/') {
        None => {
            if !is_token(t.as_bytes()) {
                return Vec::new();
            }
            b.extend_from_slice(t.to_ascii_lowercase().as_bytes());
        }
        Some((major, sub)) => {
            if !is_token(major.as_bytes()) || !is_token(sub.as_bytes()) {
                return Vec::new();
            }
            b.extend_from_slice(major.to_ascii_lowercase().as_bytes());
            b.push(b'/');
            b.extend_from_slice(sub.to_ascii_lowercase().as_bytes());
        }
    }
    let mut keys: Vec<&String> = param.keys().collect();
    keys.sort();
    for attribute in keys {
        let value = &param[attribute];
        b.extend_from_slice(b"; ");
        if !is_token(attribute.as_bytes()) {
            return Vec::new();
        }
        b.extend_from_slice(attribute.to_ascii_lowercase().as_bytes());
        if needs_encoding(value) {
            b.extend_from_slice(b"*=utf-8''");
            for &ch in value {
                if ch <= b' '
                    || ch >= 0x7f
                    || ch == b'*'
                    || ch == b'\''
                    || ch == b'%'
                    || is_tspecial(ch)
                {
                    b.extend_from_slice(&[
                        b'%',
                        UPPERHEX[usize::from(ch >> 4)],
                        UPPERHEX[usize::from(ch & 0x0f)],
                    ]);
                } else {
                    b.push(ch);
                }
            }
            continue;
        }
        b.push(b'=');
        if is_token(value) {
            b.extend_from_slice(value);
            continue;
        }
        b.push(b'"');
        for &ch in value {
            if ch == b'"' || ch == b'\\' {
                b.push(b'\\');
            }
            b.push(ch);
        }
        b.push(b'"');
    }
    b
}
