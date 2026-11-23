//! Go `net/http` 의 `ServeContent`·`FileServer` 중 정적 자산이 쓰는 부분 (go1.27.2 `net/http/fs.go`).
//!
//! 자산은 바이너리에 담겨 있어 ModTime 이 언제나 zero 다 — 시각 조건(`If-Modified-Since` 등)은
//! Go 에서도 판정하지 않으므로 옮기지 않았다.

use bytes::Bytes;
use dm_shared_httpresp::{self as httpresp, Response};
use http::header::{self, HeaderName};
use http::{HeaderMap, HeaderValue, Method, StatusCode};

pub(crate) use crate::mimetable::type_by_extension;
use crate::req::Req;

/// Go `errNoOverlap`.
const ERR_NO_OVERLAP: &str = "invalid range: failed to overlap";
const ERR_INVALID_RANGE: &str = "invalid range";
/// Go `defaultMaxContentRanges`.
const DEFAULT_MAX_CONTENT_RANGES: usize = 200;
/// Go `http.Error` 가 싣는 형식.
const ERROR_CONTENT_TYPE: &str = "text/plain; charset=utf-8";
const DIR_LIST_CONTENT_TYPE: &str = "text/html; charset=utf-8";

/// 쌓아 둔 머리와 상태·본문으로 응답을 만든다.
pub(crate) fn respond(h: HeaderMap, status: StatusCode, body: Bytes) -> Response {
    let mut res = Response::new(httpresp::full(body));
    *res.status_mut() = status;
    *res.headers_mut() = h;
    res
}

pub(crate) fn set(h: &mut HeaderMap, name: HeaderName, value: &str) {
    if let Ok(v) = HeaderValue::from_str(value) {
        h.insert(name, v);
    }
}

fn get<'a>(h: &'a HeaderMap, name: &HeaderName) -> &'a str {
    h.get(name)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
}

/// Go `http.Error`: 쌓아 둔 머리는 남기고 형식·길이만 바꾼다.
pub(crate) fn go_error(mut h: HeaderMap, msg: &str, status: StatusCode) -> Response {
    h.remove(header::CONTENT_LENGTH);
    set(&mut h, header::CONTENT_TYPE, ERROR_CONTENT_TYPE);
    set(&mut h, header::X_CONTENT_TYPE_OPTIONS, "nosniff");
    respond(h, status, Bytes::from(format!("{msg}\n")))
}

/// Go `serveError`: 표현에 딸린 머리를 지우고 `http.Error` 다.
pub(crate) fn serve_error(mut h: HeaderMap, msg: &str, status: StatusCode) -> Response {
    for k in [
        header::CACHE_CONTROL,
        header::CONTENT_ENCODING,
        header::ETAG,
        header::LAST_MODIFIED,
    ] {
        h.remove(k);
    }
    go_error(h, msg, status)
}

/// Go `writeNotModified`.
fn not_modified(mut h: HeaderMap) -> Response {
    h.remove(header::CONTENT_TYPE);
    h.remove(header::CONTENT_LENGTH);
    h.remove(header::CONTENT_ENCODING);
    if !get(&h, &header::ETAG).is_empty() {
        h.remove(header::LAST_MODIFIED);
    }
    respond(h, StatusCode::NOT_MODIFIED, Bytes::new())
}

/// Go `textproto.TrimString`.
fn trim(s: &str) -> &str {
    s.trim_matches(|c| matches!(c, ' ' | '\t' | '\n' | '\r'))
}

/// Go `scanETag`: (태그, 나머지). 태그가 아니면 둘 다 빈다.
fn scan_etag(s: &str) -> (&str, &str) {
    let s = trim(s);
    let b = s.as_bytes();
    let start = if s.starts_with("W/") { 2 } else { 0 };
    if b.len() - start < 2 || b[start] != b'"' {
        return ("", "");
    }
    for i in start + 1..b.len() {
        match b[i] {
            0x21 | 0x23..=0x7e | 0x80..=0xff => {}
            b'"' => return (&s[..=i], &s[i + 1..]),
            _ => return ("", ""),
        }
    }
    ("", "")
}

fn etag_strong_match(a: &str, b: &str) -> bool {
    a == b && a.starts_with('"')
}

fn etag_weak_match(a: &str, b: &str) -> bool {
    a.strip_prefix("W/").unwrap_or(a) == b.strip_prefix("W/").unwrap_or(b)
}

#[derive(PartialEq, Eq)]
enum Cond {
    None,
    True,
    False,
}

fn check_if_match(h: &HeaderMap, r: &Req) -> Cond {
    let mut im = r.header("If-Match");
    if im.is_empty() {
        return Cond::None;
    }
    let tag = get(h, &header::ETAG);
    loop {
        let t = trim(&im).to_owned();
        if t.is_empty() {
            break;
        }
        if let Some(rest) = t.strip_prefix(',') {
            im = rest.to_owned();
            continue;
        }
        if t.starts_with('*') {
            return Cond::True;
        }
        let (etag, remain) = scan_etag(&t);
        if etag.is_empty() {
            break;
        }
        if etag_strong_match(etag, tag) {
            return Cond::True;
        }
        im = remain.to_owned();
    }
    Cond::False
}

fn check_if_none_match(h: &HeaderMap, r: &Req) -> Cond {
    let mut buf = r.header("If-None-Match");
    if buf.is_empty() {
        return Cond::None;
    }
    let tag = get(h, &header::ETAG);
    loop {
        let t = trim(&buf).to_owned();
        if t.is_empty() {
            break;
        }
        if let Some(rest) = t.strip_prefix(',') {
            buf = rest.to_owned();
            continue;
        }
        if t.starts_with('*') {
            return Cond::False;
        }
        let (etag, remain) = scan_etag(&t);
        if etag.is_empty() {
            break;
        }
        if etag_weak_match(etag, tag) {
            return Cond::False;
        }
        buf = remain.to_owned();
    }
    Cond::True
}

fn is_get_or_head(m: &Method) -> bool {
    *m == Method::GET || *m == Method::HEAD
}

/// Go `checkIfRange` (ModTime 이 zero 다).
fn check_if_range(h: &HeaderMap, r: &Req) -> Cond {
    if !is_get_or_head(&r.method) {
        return Cond::None;
    }
    let ir = r.header("If-Range");
    if ir.is_empty() {
        return Cond::None;
    }
    let (etag, _) = scan_etag(&ir);
    if !etag.is_empty() && etag_strong_match(etag, get(h, &header::ETAG)) {
        return Cond::True;
    }
    Cond::False
}

/// Go `checkPreconditions`: 끝난 응답이거나, 처리할 `Range` 다.
fn check_preconditions(h: HeaderMap, r: &Req) -> Result<(HeaderMap, String), Response> {
    if check_if_match(&h, r) == Cond::False {
        return Err(respond(h, StatusCode::PRECONDITION_FAILED, Bytes::new()));
    }
    if check_if_none_match(&h, r) == Cond::False {
        if is_get_or_head(&r.method) {
            return Err(not_modified(h));
        }
        return Err(respond(h, StatusCode::PRECONDITION_FAILED, Bytes::new()));
    }
    let mut range = r.header("Range");
    if !range.is_empty() && check_if_range(&h, r) == Cond::False {
        range.clear();
    }
    Ok((h, range))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct HttpRange {
    pub(crate) start: i64,
    pub(crate) length: i64,
}

impl HttpRange {
    fn content_range(&self, size: i64) -> String {
        format!(
            "bytes {}-{}/{size}",
            self.start,
            self.start + self.length - 1
        )
    }
}

/// Go `parseRange`. 오류는 Go 의 문구다.
pub(crate) fn parse_range(s: &str, size: i64) -> Result<Vec<HttpRange>, &'static str> {
    if s.is_empty() {
        return Ok(Vec::new());
    }
    let Some(spec) = s.strip_prefix("bytes=") else {
        return Err(ERR_INVALID_RANGE);
    };
    if spec.matches(',').count() + 1 > DEFAULT_MAX_CONTENT_RANGES {
        return Ok(Vec::new());
    }
    let mut ranges = Vec::new();
    let mut no_overlap = false;
    for ra in spec.split(',') {
        let ra = trim(ra);
        if ra.is_empty() {
            continue;
        }
        let Some((start, end)) = ra.split_once('-') else {
            return Err(ERR_INVALID_RANGE);
        };
        let (start, end) = (trim(start), trim(end));
        let r = if start.is_empty() {
            if end.is_empty() || end.starts_with('-') {
                return Err(ERR_INVALID_RANGE);
            }
            let mut i = match end.parse::<i64>() {
                Ok(i) if i >= 0 => i,
                _ => return Err(ERR_INVALID_RANGE),
            };
            if i > size {
                i = size;
            }
            HttpRange {
                start: size - i,
                length: i,
            }
        } else {
            let i = match start.parse::<i64>() {
                Ok(i) if i >= 0 => i,
                _ => return Err(ERR_INVALID_RANGE),
            };
            if i >= size {
                no_overlap = true;
                continue;
            }
            if end.is_empty() {
                HttpRange {
                    start: i,
                    length: size - i,
                }
            } else {
                let mut e = match end.parse::<i64>() {
                    Ok(e) if i <= e => e,
                    _ => return Err(ERR_INVALID_RANGE),
                };
                if e >= size {
                    e = size - 1;
                }
                HttpRange {
                    start: i,
                    length: e - i + 1,
                }
            }
        };
        ranges.push(r);
    }
    if no_overlap && ranges.is_empty() {
        return Err(ERR_NO_OVERLAP);
    }
    Ok(ranges)
}

fn slice(content: &Bytes, ra: HttpRange) -> Bytes {
    let start = usize::try_from(ra.start).unwrap_or(0);
    let end = usize::try_from(ra.start + ra.length).unwrap_or(0);
    content.slice(start.min(content.len())..end.min(content.len()))
}

/// Go `multipart.Writer` 로 쓴 `multipart/byteranges` 본문. 경계는 Go 처럼 무작위 30바이트다.
fn multipart_ranges(ranges: &[HttpRange], ctype: &str, content: &Bytes) -> (String, Bytes) {
    let boundary = hex::encode(rand::random::<[u8; 30]>());
    let size = i64::try_from(content.len()).unwrap_or(i64::MAX);
    let mut out = Vec::new();
    for (i, ra) in ranges.iter().enumerate() {
        let lead = if i == 0 { "" } else { "\r\n" };
        out.extend_from_slice(
            format!(
                "{lead}--{boundary}\r\nContent-Range: {}\r\nContent-Type: {ctype}\r\n\r\n",
                ra.content_range(size)
            )
            .as_bytes(),
        );
        out.extend_from_slice(&slice(content, *ra));
    }
    out.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    (boundary, Bytes::from(out))
}

/// Go `serveContent` (ModTime 이 zero 다). `h` 는 핸들러가 앞서 쌓은 머리다.
pub(crate) fn serve_content(r: &Req, h: HeaderMap, name: &str, content: Bytes) -> Response {
    let (mut h, range) = match check_preconditions(h, r) {
        Ok(v) => v,
        Err(res) => return res,
    };
    let ctype = match h.get(header::CONTENT_TYPE) {
        Some(v) => String::from_utf8_lossy(v.as_bytes()).into_owned(),
        None => {
            let mut ct = type_by_extension(dm_gocompat::path::ext(name)).to_owned();
            if ct.is_empty() {
                let n = content.len().min(dm_shared_mimeprobe::SNIFF_LEN);
                ct = dm_shared_mimeprobe::detect_content_type(&content[..n]).to_owned();
            }
            set(&mut h, header::CONTENT_TYPE, &ct);
            ct
        }
    };
    let size = i64::try_from(content.len()).unwrap_or(i64::MAX);
    let mut ranges = match parse_range(&range, size) {
        Ok(v) => v,
        Err(ERR_NO_OVERLAP) if size == 0 => Vec::new(),
        Err(e) => {
            if e == ERR_NO_OVERLAP {
                set(&mut h, header::CONTENT_RANGE, &format!("bytes */{size}"));
            }
            return serve_error(h, e, StatusCode::RANGE_NOT_SATISFIABLE);
        }
    };
    if ranges.iter().map(|r| r.length).sum::<i64>() > size {
        ranges.clear();
    }
    let mut status = StatusCode::OK;
    let body = match ranges.len() {
        0 => content,
        1 => {
            status = StatusCode::PARTIAL_CONTENT;
            set(
                &mut h,
                header::CONTENT_RANGE,
                &ranges[0].content_range(size),
            );
            slice(&content, ranges[0])
        }
        _ => {
            status = StatusCode::PARTIAL_CONTENT;
            let (boundary, b) = multipart_ranges(&ranges, &ctype, &content);
            set(
                &mut h,
                header::CONTENT_TYPE,
                &format!("multipart/byteranges; boundary={boundary}"),
            );
            b
        }
    };
    set(&mut h, header::ACCEPT_RANGES, "bytes");
    if !ranges.is_empty() || get(&h, &header::CONTENT_ENCODING).is_empty() {
        set(&mut h, header::CONTENT_LENGTH, &body.len().to_string());
    }
    let body = if r.method == Method::HEAD {
        Bytes::new()
    } else {
        body
    };
    respond(h, status, body)
}

/// Go `localRedirect`: 301 과 상대 `Location`. 경로에 `%2F` 가 있으면 404 다.
pub(crate) fn local_redirect(r: &Req, h: HeaderMap, new_path: &str) -> Response {
    let escaped = crate::serve::escaped_path(r.uri.path(), &r.path);
    if escaped.contains("%2f") || escaped.contains("%2F") {
        return go_error(h, "404 page not found", StatusCode::NOT_FOUND);
    }
    let mut loc = new_path.to_owned();
    if !r.raw_query.is_empty() {
        loc.push('?');
        loc.push_str(&r.raw_query);
    }
    let mut h = h;
    set(&mut h, header::LOCATION, &loc);
    respond(h, StatusCode::MOVED_PERMANENTLY, Bytes::new())
}

/// Go `url.URL{Path: name}.String()` (상대 경로 하나).
fn url_path_string(name: &str) -> String {
    let mut out = String::new();
    if let Some(i) = name.find(':')
        && !name[..i].contains('/')
    {
        out.push_str("./");
    }
    for &c in name.as_bytes() {
        if crate::serve::should_escape_path(c) {
            out.push_str(&format!("%{c:02X}"));
        } else {
            out.push(char::from(c));
        }
    }
    out
}

/// Go `dirList`: 항목은 이름순이고 디렉터리에는 `/` 가 붙는다.
pub(crate) fn dir_list(mut h: HeaderMap, mut entries: Vec<(String, bool)>) -> Response {
    entries.sort_by(|a, b| a.0.cmp(&b.0));
    set(&mut h, header::CONTENT_TYPE, DIR_LIST_CONTENT_TYPE);
    let mut out = String::from(
        "<!doctype html>\n<meta name=\"viewport\" content=\"width=device-width\">\n<pre>\n",
    );
    for (name, is_dir) in entries {
        let name = if is_dir { format!("{name}/") } else { name };
        out.push_str(&format!(
            "<a href=\"{}\">{}</a>\n",
            url_path_string(&name),
            crate::access_denied::html_escape(&name)
        ));
    }
    out.push_str("</pre>\n");
    respond(h, StatusCode::OK, Bytes::from(out))
}
