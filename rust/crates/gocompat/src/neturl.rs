//! Go `net/url` 의 쿼리 해석과 이스케이프 풀기 규칙이다 (go1.27.2 `src/net/url/url.go`).
//!
//! Go 문자열은 임의 바이트이므로 값은 `Vec<u8>` 로 담는다. `GODEBUG=urlmaxqueryparams` 는
//! 따르지 않는다 — 기본 상한(10000)만 쓴다.

use std::fmt;

/// Go `defaultMaxParams`.
pub const MAX_PARAMS: usize = 10000;

/// Go `ParseQuery`·`QueryUnescape`·`PathUnescape` 의 오류.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Error {
    /// Go `EscapeError`. 문제의 `%` 부터 최대 3바이트다.
    Escape(Vec<u8>),
    /// `;` 가 든 쌍.
    Semicolon,
    /// 쌍 수가 [`MAX_PARAMS`] 를 넘었다.
    TooManyParams,
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Escape(s) => write!(f, "invalid URL escape {}", crate::strconv::quote_bytes(s)),
            Error::Semicolon => f.write_str("invalid semicolon separator in query"),
            Error::TooManyParams => f.write_str("number of URL query parameters exceeded limit"),
        }
    }
}

impl std::error::Error for Error {}

/// Go `url.Values`. 키는 처음 나온 순서로, 키별 값은 나온 순서로 담는다.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Values {
    entries: Vec<(Vec<u8>, Vec<Vec<u8>>)>,
}

impl Values {
    fn find(&self, key: &[u8]) -> Option<&[Vec<u8>]> {
        self.entries
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.as_slice())
    }

    /// Go `v.Get(key)` 의 바이트. 키가 없으면 `None` 이다(Go 는 빈 문자열).
    pub fn get_bytes(&self, key: &str) -> Option<&[u8]> {
        self.find(key.as_bytes())
            .and_then(|v| v.first())
            .map(Vec::as_slice)
    }

    /// Go `v.Get(key)`. UTF-8 이 아닌 바이트는 U+FFFD 로 바꾼다.
    pub fn get(&self, key: &str) -> Option<String> {
        self.get_bytes(key)
            .map(|b| String::from_utf8_lossy(b).into_owned())
    }

    /// Go `v.Get(key)` 그대로: 없으면 빈 문자열.
    pub fn get_or_empty(&self, key: &str) -> String {
        self.get(key).unwrap_or_default()
    }

    /// Go `v.Has(key)`.
    pub fn has(&self, key: &str) -> bool {
        self.find(key.as_bytes()).is_some()
    }

    /// Go `v[key]`.
    pub fn get_all(&self, key: &str) -> Option<&[Vec<u8>]> {
        self.find(key.as_bytes())
    }

    /// 키 목록(처음 나온 순서).
    pub fn keys(&self) -> impl Iterator<Item = &[u8]> {
        self.entries.iter().map(|(k, _)| k.as_slice())
    }

    /// Go `v.Add(key, value)`.
    pub fn add(&mut self, key: Vec<u8>, value: Vec<u8>) {
        match self.entries.iter_mut().find(|(k, _)| *k == key) {
            Some((_, v)) => v.push(value),
            None => self.entries.push((key, vec![value])),
        }
    }

    /// 키 수. Go `len(v)`.
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

/// Go `url.ParseQuery`. 오류가 있어도 맞는 쌍은 모두 담는다. 오류는 처음 만난 이스케이프
/// 오류이되, `;` 쌍은 만날 때마다 오류를 덮어쓴다(Go 와 같다).
pub fn parse_query(query: impl AsRef<[u8]>) -> (Values, Option<Error>) {
    let mut q = query.as_ref();
    let mut m = Values::default();
    if q.iter().filter(|&&c| c == b'&').count() + 1 > MAX_PARAMS {
        return (m, Some(Error::TooManyParams));
    }
    let mut err = None;
    while !q.is_empty() {
        let (pair, rest) = cut(q, b'&');
        q = rest;
        if pair.contains(&b';') {
            err = Some(Error::Semicolon);
            continue;
        }
        if pair.is_empty() {
            continue;
        }
        let (k, v) = cut(pair, b'=');
        let (k, v) = match (unescape(k, true), unescape(v, true)) {
            (Ok(k), Ok(v)) => (k, v),
            (Err(e), _) | (_, Err(e)) => {
                err.get_or_insert(e);
                continue;
            }
        };
        m.add(k, v);
    }
    (m, err)
}

/// Go `url.QueryUnescape`: `%XX` 와 `+`(공백)를 푼다.
pub fn query_unescape(s: impl AsRef<[u8]>) -> Result<Vec<u8>, Error> {
    unescape(s.as_ref(), true)
}

/// Go `url.PathUnescape`: `%XX` 만 푼다. Go 가 `URL.Path` 를 만들 때와 같은 규칙이다.
pub fn path_unescape(s: impl AsRef<[u8]>) -> Result<Vec<u8>, Error> {
    unescape(s.as_ref(), false)
}

fn cut(s: &[u8], sep: u8) -> (&[u8], &[u8]) {
    match s.iter().position(|&c| c == sep) {
        Some(i) => (&s[..i], &s[i + 1..]),
        None => (s, &[]),
    }
}

fn unhex(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}

fn unescape(s: &[u8], plus_is_space: bool) -> Result<Vec<u8>, Error> {
    let mut out = Vec::with_capacity(s.len());
    let mut i = 0;
    while i < s.len() {
        match s[i] {
            b'%' => {
                let hex = s
                    .get(i + 1)
                    .and_then(|&a| unhex(a))
                    .zip(s.get(i + 2).and_then(|&b| unhex(b)));
                let Some((hi, lo)) = hex else {
                    return Err(Error::Escape(s[i..s.len().min(i + 3)].to_vec()));
                };
                out.push(hi << 4 | lo);
                i += 3;
            }
            b'+' if plus_is_space => {
                out.push(b' ');
                i += 1;
            }
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests;
