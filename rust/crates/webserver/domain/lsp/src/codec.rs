//! LSP base protocol 프레이밍: `Content-Length: N\r\n\r\n<본문>`. 오류 문구는 Go 와 같다.

use std::io::{self, BufRead, Write};

use otter_gocompat::strconv::quote;

use crate::service::MAX_TEXT_BYTES;

/// 프레임 본문의 상한. 편집기 본문 상한과 같다.
pub(crate) const MAX_FRAME: i64 = otter_shared_editorlimit::body_max_bytes(MAX_TEXT_BYTES);

/// 머리 한 줄과 머리 전체의 바이트 상한.
const MAX_HEADER_LINE: usize = 1024;
const MAX_HEADER_BYTES: usize = 8 * MAX_HEADER_LINE;

/// Go `ErrHeaderTooLarge`.
pub const ERR_HEADER_TOO_LARGE: &str = "lsp: header too large";

fn err(msg: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, msg.into())
}

/// Go `io.EOF`·`io.ErrUnexpectedEOF`.
fn eof(unexpected: bool) -> io::Error {
    let msg = if unexpected { "unexpected EOF" } else { "EOF" };
    io::Error::new(io::ErrorKind::UnexpectedEof, msg)
}

/// 프레임 하나를 쓴다.
pub fn write_frame(w: &mut dyn Write, body: &[u8]) -> io::Result<()> {
    w.write_all(format!("Content-Length: {}\r\n\r\n", body.len()).as_bytes())?;
    w.write_all(body)
}

/// 프레임 하나를 읽는다. 머리는 대소문자를 가리지 않고 Content-Length 만 본다.
pub fn read_frame(r: &mut dyn BufRead) -> io::Result<Vec<u8>> {
    let mut n: i64 = -1;
    let mut left = MAX_HEADER_BYTES as i64;
    loop {
        let raw = read_header_line(r, &mut left)?;
        let line = raw.trim_end_matches(['\r', '\n']);
        if line.is_empty() {
            break;
        }
        let Some((k, v)) = line.split_once(':') else {
            continue;
        };
        if !k.trim().eq_ignore_ascii_case("content-length") {
            continue;
        }
        n = atoi(v.trim())
            .map_err(|e| err(format!("lsp: bad Content-Length {}: {e}", quote(v))))?;
    }
    if n < 0 {
        return Err(err("lsp: frame without Content-Length"));
    }
    if n > MAX_FRAME {
        return Err(err(format!("lsp: frame too large ({n} > {MAX_FRAME})")));
    }
    let mut body = vec![0u8; n as usize];
    let mut got = 0;
    while got < body.len() {
        match r.read(&mut body[got..]) {
            Ok(0) => return Err(eof(got > 0)),
            Ok(k) => got += k,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) => return Err(e),
        }
    }
    Ok(body)
}

fn read_header_line(r: &mut dyn BufRead, left: &mut i64) -> io::Result<String> {
    let mut line = Vec::new();
    let mut b = [0u8; 1];
    loop {
        match r.read(&mut b) {
            Ok(0) => return Err(eof(false)),
            Ok(_) => {}
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        }
        line.push(b[0]);
        *left -= 1;
        if line.len() > MAX_HEADER_LINE || *left < 0 {
            return Err(err(ERR_HEADER_TOO_LARGE));
        }
        if b[0] == b'\n' {
            return Ok(String::from_utf8_lossy(&line).into_owned());
        }
    }
}

/// Go `strconv.Atoi` (64비트 int).
fn atoi(s: &str) -> Result<i64, String> {
    let fail = |why: &str| format!("strconv.Atoi: parsing {}: {why}", quote(s));
    let (neg, digits) = match s.as_bytes().first() {
        Some(b'-') => (true, &s[1..]),
        Some(b'+') => (false, &s[1..]),
        _ => (false, s),
    };
    if digits.is_empty() || !digits.bytes().all(|c| c.is_ascii_digit()) {
        return Err(fail("invalid syntax"));
    }
    let mut v: i128 = 0;
    for c in digits.bytes() {
        v = v * 10 + i128::from(c - b'0');
        if v > i128::from(i64::MAX) + 1 {
            return Err(fail("value out of range"));
        }
    }
    let v = if neg { -v } else { v };
    i64::try_from(v).map_err(|_| fail("value out of range"))
}
