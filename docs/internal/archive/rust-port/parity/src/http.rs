//! 최소 HTTP/1.1 클라이언트와 응답 해석 (SPEC FR-PAR-20·21).
//!
//! 와이어를 그대로 보려고 직접 구현한다. 요청마다 `Connection: close` 로 연결 하나를 쓴다.

use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::time::Duration;

/// 이름이 정확히 같으면 비교하는 헤더 (소문자).
const COMPARED_HEADERS: &[&str] = &[
    "cache-control",
    "content-security-policy",
    "content-type",
    "location",
    "permissions-policy",
    "referrer-policy",
    "set-cookie",
    "strict-transport-security",
    "vary",
    "www-authenticate",
    "x-content-type-options",
    "x-frame-options",
];
/// 이 접두어로 시작하면 비교하는 헤더 (소문자).
const COMPARED_PREFIXES: &[&str] = &["access-control-", "cross-origin-"];
const DATE_HEADER: &str = "date";
pub const PRESENT: &str = "<present>";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Response {
    /// 상태 줄에서 HTTP 판을 뗀 나머지. 예: `200 OK`.
    pub status: String,
    /// 받은 순서의 (원래 이름, 값).
    pub headers: Vec<(String, Vec<u8>)>,
    pub body: Vec<u8>,
}

impl Response {
    fn header(&self, lower: &str) -> Option<&[u8]> {
        self.headers
            .iter()
            .find(|(n, _)| n.eq_ignore_ascii_case(lower))
            .map(|(_, v)| v.as_slice())
    }

    /// 비교할 헤더를 `header:<소문자 이름>` → 값으로 모은다. 같은 이름이 여럿이면 줄바꿈으로 잇는다.
    pub fn compared_headers(&self, extra: &[String]) -> BTreeMap<String, Vec<u8>> {
        let mut out: BTreeMap<String, Vec<u8>> = BTreeMap::new();
        for (name, value) in &self.headers {
            let lower = name.to_ascii_lowercase();
            if lower == DATE_HEADER {
                out.insert(format!("header:{lower}"), PRESENT.as_bytes().to_vec());
                continue;
            }
            let wanted = COMPARED_HEADERS.contains(&lower.as_str())
                || COMPARED_PREFIXES.iter().any(|p| lower.starts_with(p))
                || extra.iter().any(|e| e.eq_ignore_ascii_case(&lower));
            if !wanted {
                continue;
            }
            let slot = out.entry(format!("header:{lower}")).or_default();
            if !slot.is_empty() {
                slot.push(b'\n');
            }
            slot.extend_from_slice(value);
        }
        out
    }
}

/// 원시 응답 바이트를 해석한다. `no_body` 는 HEAD 요청일 때 참이다.
pub fn parse_response(raw: &[u8], no_body: bool) -> Result<Response, String> {
    let head_end = find(raw, b"\r\n\r\n").ok_or("응답 머리의 끝(CRLF CRLF)이 없다")?;
    let head = std::str::from_utf8(&raw[..head_end]).map_err(|_| "응답 머리가 UTF-8 이 아니다")?;
    let rest = &raw[head_end + 4..];
    let mut lines = head.split("\r\n");
    let status_line = lines.next().unwrap_or_default();
    let status = match status_line.split_once(' ') {
        Some((proto, status)) if proto.starts_with("HTTP/") => status.to_string(),
        _ => return Err(format!("상태 줄이 잘못되었다: {status_line:?}")),
    };
    let mut headers = Vec::new();
    for line in lines {
        let (name, value) = line
            .split_once(':')
            .ok_or_else(|| format!("헤더 줄이 잘못되었다: {line:?}"))?;
        headers.push((name.to_string(), value.trim().as_bytes().to_vec()));
    }
    let mut resp = Response {
        status,
        headers,
        body: Vec::new(),
    };
    let code = resp.status.get(..3).unwrap_or_default();
    if no_body || code.starts_with('1') || code == "204" || code == "304" {
        return Ok(resp);
    }
    let chunked = resp.header("transfer-encoding").is_some_and(|v| {
        String::from_utf8_lossy(v)
            .to_ascii_lowercase()
            .contains("chunked")
    });
    resp.body = if chunked {
        dechunk(rest)?
    } else if let Some(len) = resp.header("content-length") {
        let len: usize = std::str::from_utf8(len)
            .ok()
            .and_then(|s| s.trim().parse().ok())
            .ok_or("Content-Length 가 숫자가 아니다")?;
        if rest.len() < len {
            return Err(format!(
                "본문이 짧다: Content-Length {len}, 받은 {}",
                rest.len()
            ));
        }
        rest[..len].to_vec()
    } else {
        rest.to_vec()
    };
    Ok(resp)
}

fn dechunk(mut data: &[u8]) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    loop {
        let line_end = find(data, b"\r\n").ok_or("chunk 크기 줄의 끝이 없다")?;
        let line = std::str::from_utf8(&data[..line_end])
            .map_err(|_| "chunk 크기 줄이 UTF-8 이 아니다")?;
        let size_hex = line.split(';').next().unwrap_or_default().trim();
        let size = usize::from_str_radix(size_hex, 16)
            .map_err(|_| format!("chunk 크기가 잘못되었다: {line:?}"))?;
        data = &data[line_end + 2..];
        if size == 0 {
            return Ok(out);
        }
        if data.len() < size + 2 || &data[size..size + 2] != b"\r\n" {
            return Err("chunk 가 잘렸다".to_string());
        }
        out.extend_from_slice(&data[..size]);
        data = &data[size + 2..];
    }
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

/// `127.0.0.1:port` 에 요청 하나를 보내고 연결이 닫힐 때까지 읽는다.
pub fn request(
    port: u16,
    method: &str,
    path: &str,
    headers: &[(String, String)],
    body: &[u8],
    timeout: Duration,
) -> Result<Response, String> {
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let mut stream =
        TcpStream::connect_timeout(&addr, timeout).map_err(|e| format!("연결 실패: {e}"))?;
    stream
        .set_read_timeout(Some(timeout))
        .map_err(|e| e.to_string())?;
    stream
        .set_write_timeout(Some(timeout))
        .map_err(|e| e.to_string())?;
    let mut req =
        format!("{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n");
    for (k, v) in headers {
        req.push_str(&format!("{k}: {v}\r\n"));
    }
    if !body.is_empty() || matches!(method, "POST" | "PUT" | "PATCH") {
        req.push_str(&format!("Content-Length: {}\r\n", body.len()));
    }
    req.push_str("\r\n");
    let mut wire = req.into_bytes();
    wire.extend_from_slice(body);
    stream
        .write_all(&wire)
        .map_err(|e| format!("요청 쓰기 실패: {e}"))?;
    let mut raw = Vec::new();
    stream
        .read_to_end(&mut raw)
        .map_err(|e| format!("응답 읽기 실패: {e}"))?;
    parse_response(&raw, method == "HEAD")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn content_length_body() {
        let r = parse_response(
            b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 2\r\n\r\nokEXTRA",
            false,
        )
        .unwrap();
        assert_eq!(r.status, "200 OK");
        assert_eq!(r.body, b"ok");
    }

    #[test]
    fn chunked_body_is_decoded() {
        let raw = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3;x=y\r\nabc\r\n2\r\nde\r\n0\r\nTrailer: t\r\n\r\n";
        assert_eq!(parse_response(raw, false).unwrap().body, b"abcde");
    }

    #[test]
    fn body_until_close_without_length() {
        assert_eq!(
            parse_response(b"HTTP/1.0 404 Not Found\r\n\r\nnope", false)
                .unwrap()
                .body,
            b"nope"
        );
    }

    #[test]
    fn head_and_204_have_no_body() {
        assert!(
            parse_response(b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\n", true)
                .unwrap()
                .body
                .is_empty()
        );
        assert!(
            parse_response(b"HTTP/1.1 204 No Content\r\n\r\n", false)
                .unwrap()
                .body
                .is_empty()
        );
    }

    #[test]
    fn malformed_responses_are_errors() {
        assert!(parse_response(b"garbage", false).is_err());
        assert!(parse_response(b"FOO 200 OK\r\n\r\n", false).is_err());
        assert!(parse_response(b"HTTP/1.1 200 OK\r\nContent-Length: 9\r\n\r\nab", false).is_err());
        assert!(
            parse_response(
                b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nab",
                false
            )
            .is_err()
        );
    }

    #[test]
    fn compared_headers_selection() {
        let raw = b"HTTP/1.1 200 OK\r\nDate: Mon, 23 Nov 2026 00:00:00 GMT\r\ncontent-type: text/html\r\nSet-Cookie: a=1\r\nSet-Cookie: b=2\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: 0\r\nX-Custom: v\r\nServer: x\r\n\r\n";
        let r = parse_response(raw, false).unwrap();
        let h = r.compared_headers(&["X-Custom".to_string()]);
        let keys: Vec<&str> = h.keys().map(String::as_str).collect();
        assert_eq!(
            keys,
            [
                "header:access-control-allow-origin",
                "header:content-type",
                "header:date",
                "header:set-cookie",
                "header:x-custom"
            ]
        );
        assert_eq!(h["header:set-cookie"], b"a=1\nb=2");
        assert_eq!(h["header:date"], PRESENT.as_bytes());
    }

    #[test]
    fn request_round_trip_against_local_listener() {
        let listener = std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            let mut buf = [0u8; 1024];
            let n = s.read(&mut buf).unwrap();
            let req = String::from_utf8_lossy(&buf[..n]).into_owned();
            s.write_all(b"HTTP/1.1 201 Created\r\nContent-Length: 2\r\n\r\nhi")
                .unwrap();
            req
        });
        let r = request(
            port,
            "POST",
            "/x?y=1",
            &[("X-A".into(), "b".into())],
            b"",
            Duration::from_secs(5),
        )
        .unwrap();
        assert_eq!(
            (r.status.as_str(), r.body.as_slice()),
            ("201 Created", b"hi".as_slice())
        );
        let req = server.join().unwrap();
        assert!(req.starts_with("POST /x?y=1 HTTP/1.1\r\n"), "{req}");
        assert!(
            req.contains("Connection: close\r\n")
                && req.contains("X-A: b\r\n")
                && req.contains("Content-Length: 0\r\n")
        );
    }
}
