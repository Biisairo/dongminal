use super::*;

/// Go `net/http/sniff_test.go` 의 sniffTests 를 그대로 옮겼다.
#[test]
fn detect_content_type_go_table() {
    let cases: &[(&str, &[u8], &str)] = &[
        ("Empty", b"", "text/plain; charset=utf-8"),
        ("Binary", &[1, 2, 3], "application/octet-stream"),
        ("HTML #1", b"<HtMl><bOdY>blah blah blah</body></html>", "text/html; charset=utf-8"),
        ("HTML #2", b"<HTML></HTML>", "text/html; charset=utf-8"),
        ("HTML #3", b"   <!DOCTYPE HTML>...", "text/html; charset=utf-8"),
        ("HTML #4", b"\r\n<html>...", "text/html; charset=utf-8"),
        ("Plain text", "This is not HTML. It has ☃ though.".as_bytes(), "text/plain; charset=utf-8"),
        ("XML", b"\n<?xml!", "text/xml; charset=utf-8"),
        ("Windows icon", b"\x00\x00\x01\x00", "image/x-icon"),
        ("Windows cursor", b"\x00\x00\x02\x00", "image/x-icon"),
        ("BMP", b"BM...", "image/bmp"),
        ("GIF 87a", b"GIF87a", "image/gif"),
        ("GIF 89a", b"GIF89a...", "image/gif"),
        ("WEBP", b"RIFF\x00\x00\x00\x00WEBPVP", "image/webp"),
        ("PNG", b"\x89PNG\x0D\x0A\x1A\x0A", "image/png"),
        ("JPEG", b"\xFF\xD8\xFF", "image/jpeg"),
        ("MIDI", b"MThd\x00\x00\x00\x06\x00\x01", "audio/midi"),
        ("MP3", b"ID3\x03\x00\x00\x00\x00\x0f", "audio/mpeg"),
        ("WAV #1", b"RIFFb\xb8\x00\x00WAVEfmt \x12\x00\x00\x00\x06", "audio/wave"),
        ("WAV #2", b"RIFF,\x00\x00\x00WAVEfmt \x12\x00\x00\x00\x06", "audio/wave"),
        (
            "AIFF #1",
            b"FORM\x00\x00\x00\x00AIFFCOMM\x00\x00\x00\x12\x00\x01\x00\x00\x57\x55\x00\x10\x40\x0d\xf3\x34",
            "audio/aiff",
        ),
        (
            "OGG",
            b"OggS\x00\x02\x00\x00\x00\x00\x00\x00\x00\x00\x7e\x46\x00\x00\x00\x00\x00\x00\x1f\xf6\xb4\xfc\x01\x1e\x01\x76\x6f\x72",
            "application/ogg",
        ),
        ("Not OGG 1", b"owow\x00", "application/octet-stream"),
        ("Not OGG 2", b"oooS\x00", "application/octet-stream"),
        ("Not OGG 3", b"oggS\x00", "application/octet-stream"),
        (
            "MP4",
            b"\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isom<\x06t\xbfmdat",
            "video/mp4",
        ),
        ("AVI #1", "RIFF,O\n\x00AVI LISTÀ".as_bytes(), "video/avi"),
        ("AVI #2", "RIFF,\n\x00\x00AVI LISTÀ".as_bytes(), "video/avi"),
        ("TTF I", b"\x00\x01\x00\x00\x00\x17\x01\x00\x00\x04\x01\x60\x4f", "font/ttf"),
        ("TTF II", b"\x00\x01\x00\x00\x00\x0e\x00\x80\x00\x03\x00\x60\x46", "font/ttf"),
        (
            "OTTO",
            b"\x4f\x54\x54\x4f\x00\x0e\x00\x80\x00\x03\x00\x60\x42\x41\x53\x45",
            "font/otf",
        ),
        (
            "woff",
            b"\x77\x4f\x46\x46\x00\x01\x00\x00\x00\x00\x30\x54\x00\x0d\x00\x00",
            "font/woff",
        ),
        ("woff2", b"\x77\x4f\x46\x32\x00\x01\x00\x00\x00", "font/woff2"),
        ("wasm", b"\x00\x61\x73\x6d\x01\x00", "application/wasm"),
        ("RAR 1.5", b"Rar!\x1A\x07\x00", "application/x-rar-compressed"),
        ("RAR 5", b"Rar!\x1A\x07\x01\x00", "application/x-rar-compressed"),
        ("Bad RAR 1.5", b"Rar \x1A\x07\x00", "application/octet-stream"),
        ("Bad RAR 5", b"Rar \x1A\x07\x01\x00", "application/octet-stream"),
    ];
    for (desc, data, want) in cases {
        assert_eq!(detect_content_type(data), *want, "{desc}");
    }
}

#[test]
fn detect_uses_only_first_512_bytes() {
    let mut b = vec![b'a'; SNIFF_LEN];
    b.push(0x01);
    assert_eq!(detect_content_type(&b), "text/plain; charset=utf-8");
}

#[test]
fn image_mime_cases() {
    assert_eq!(image_mime(b"\x89PNG\x0D\x0A\x1A\x0Arest"), "image/png");
    assert_eq!(image_mime(b"GIF89a"), "image/gif");
    assert_eq!(image_mime(b"<svg xmlns='x'/>"), SVG_MIME);
    assert_eq!(image_mime(b"<html><svg>"), "");
    assert_eq!(image_mime(b"plain text"), "");
    assert_eq!(image_mime(b""), "");
}

#[test]
fn image_mime_sniffs_head_but_svg_sees_all() {
    // 512 바이트 뒤의 루트도 SVG 판정은 본다 (Go 는 head 전체를 LooksLikeSVG 에 준다).
    let mut b = b"<!--".to_vec();
    b.extend(vec![b' '; 600]);
    b.extend(b"--><svg>");
    assert_eq!(image_mime(&b), SVG_MIME);
}

#[test]
fn looks_like_svg_cases() {
    let yes: &[&[u8]] = &[
        b"<svg>",
        b"<svg",
        b"<svg/>",
        b"<svg\n",
        b"\xef\xbb\xbf  <svg xmlns=\"http://www.w3.org/2000/svg\">",
        b"<?xml version=\"1.0\"?>\n<!-- c -->\n<!DOCTYPE svg PUBLIC \"x\">\n<svg>",
        b" \xef\xbb\xbf\n<svg>",
    ];
    for b in yes {
        assert!(looks_like_svg(b), "{:?}", String::from_utf8_lossy(b));
    }
    let no: &[&[u8]] = &[
        b"",
        b"<SVG>",
        b"<svgfoo>",
        b"<html><svg>",
        b"<?xml version=\"1.0\"",
        b"<!-- unterminated <svg>",
        b"<!DOCTYPE svg",
        b"text <svg>",
        b"\xef\xbb<svg>",
    ];
    for b in no {
        assert!(!looks_like_svg(b), "{:?}", String::from_utf8_lossy(b));
    }
}
