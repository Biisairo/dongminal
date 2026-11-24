use std::io::{BufReader, Cursor, Read};

use crate::codec::{ERR_HEADER_TOO_LARGE, MAX_FRAME, read_frame, write_frame};

fn read(raw: &str) -> std::io::Result<Vec<u8>> {
    read_frame(&mut BufReader::new(Cursor::new(raw.as_bytes().to_vec())))
}

#[test]
fn write_frame_shape() {
    let body = br#"{"jsonrpc":"2.0","id":1,"method":"initialize"}"#;
    let mut buf = Vec::new();
    write_frame(&mut buf, body).unwrap();
    assert_eq!(
        buf,
        [
            format!("Content-Length: {}\r\n\r\n", body.len()).as_bytes(),
            body
        ]
        .concat()
    );
}

#[test]
fn read_frame_sequence() {
    let msgs = [
        r#"{"id":1}"#,
        r#"{"id":2,"x":"한글도 바이트 길이로 센다"}"#,
        r#"{"id":3}"#,
    ];
    let mut buf = Vec::new();
    for m in msgs {
        write_frame(&mut buf, m.as_bytes()).unwrap();
    }
    let mut r = BufReader::new(Cursor::new(buf));
    for want in msgs {
        assert_eq!(read_frame(&mut r).unwrap(), want.as_bytes());
    }
    assert_eq!(read_frame(&mut r).unwrap_err().to_string(), "EOF");
}

#[test]
fn read_frame_header_tolerance() {
    let body = r#"{"ok":true}"#;
    let raw = format!(
        "content-length: {}\r\nContent-Type: application/vscode-jsonrpc; charset=utf-8\r\n\r\n{body}",
        body.len()
    );
    assert_eq!(read(&raw).unwrap(), body.as_bytes());
}

#[test]
fn read_frame_bad_header() {
    for (raw, want) in [
        ("\r\n{}", "lsp: frame without Content-Length"),
        (
            "Content-Length: abc\r\n\r\n{}",
            r#"lsp: bad Content-Length " abc": strconv.Atoi: parsing "abc": invalid syntax"#,
        ),
        (
            "Content-Length: -3\r\n\r\n{}",
            "lsp: frame without Content-Length",
        ),
        (
            "X-Nothing: 1\r\n\r\n{}",
            "lsp: frame without Content-Length",
        ),
        (
            "Content-Length: 99999999999999999999\r\n\r\n",
            r#"lsp: bad Content-Length " 99999999999999999999": strconv.Atoi: parsing "99999999999999999999": value out of range"#,
        ),
    ] {
        assert_eq!(read(raw).unwrap_err().to_string(), want, "{raw:?}");
    }
    assert_eq!(
        read("Content-Length: 5\r\n\r\n{}").unwrap_err().to_string(),
        "unexpected EOF"
    );
}

#[test]
fn read_frame_too_large() {
    let e = read(&format!("Content-Length: {}\r\n\r\n", MAX_FRAME + 1)).unwrap_err();
    assert_eq!(
        e.to_string(),
        format!("lsp: frame too large ({} > {MAX_FRAME})", MAX_FRAME + 1)
    );
}

struct Endless(u8);

impl Read for Endless {
    fn read(&mut self, p: &mut [u8]) -> std::io::Result<usize> {
        p.fill(self.0);
        Ok(p.len())
    }
}

#[test]
fn read_frame_header_line_cap() {
    let e = read_frame(&mut BufReader::new(Endless(b'a'))).unwrap_err();
    assert_eq!(e.to_string(), ERR_HEADER_TOO_LARGE);
}

#[test]
fn read_frame_header_total_cap() {
    let raw = "X-Pad: 1\r\n".repeat(8 * 1024) + "Content-Length: 2\r\n\r\n{}";
    assert_eq!(read(&raw).unwrap_err().to_string(), ERR_HEADER_TOO_LARGE);
}

#[test]
fn read_frame_header_at_line_cap() {
    let pad = format!("X-Pad: {}", "a".repeat(1024 - "X-Pad: \r\n".len()));
    assert_eq!(
        read(&format!("{pad}\r\nContent-Length: 2\r\n\r\n{{}}")).unwrap(),
        b"{}"
    );
}

#[test]
fn limit_text_is_editor_limit() {
    assert_eq!(crate::MAX_TEXT_BYTES, dm_shared_editorlimit::FILE_MAX_BYTES);
}
