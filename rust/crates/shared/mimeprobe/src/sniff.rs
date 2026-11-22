//! Go `net/http.DetectContentType`(go1.27.2 `net/http/internal/sniff.go`)의 판정 알고리즘이다.
//! 표의 순서가 곧 우선순위다.

/// 판정에 쓰는 앞머리의 최대 길이다.
pub const SNIFF_LEN: usize = 512;

enum Sig {
    Html(&'static [u8]),
    Masked {
        mask: &'static [u8],
        pat: &'static [u8],
        skip_ws: bool,
        ct: &'static str,
    },
    Exact(&'static [u8], &'static str),
    Mp4,
    Text,
}

const fn masked(mask: &'static [u8], pat: &'static [u8], ct: &'static str) -> Sig {
    Sig::Masked {
        mask,
        pat,
        skip_ws: false,
        ct,
    }
}

const HTML: &str = "text/html; charset=utf-8";

static SIGNATURES: &[Sig] = &[
    Sig::Html(b"<!DOCTYPE HTML"),
    Sig::Html(b"<HTML"),
    Sig::Html(b"<HEAD"),
    Sig::Html(b"<SCRIPT"),
    Sig::Html(b"<IFRAME"),
    Sig::Html(b"<H1"),
    Sig::Html(b"<DIV"),
    Sig::Html(b"<FONT"),
    Sig::Html(b"<TABLE"),
    Sig::Html(b"<A"),
    Sig::Html(b"<STYLE"),
    Sig::Html(b"<TITLE"),
    Sig::Html(b"<B"),
    Sig::Html(b"<BODY"),
    Sig::Html(b"<BR"),
    Sig::Html(b"<P"),
    Sig::Html(b"<!--"),
    Sig::Masked {
        mask: b"\xFF\xFF\xFF\xFF\xFF",
        pat: b"<?xml",
        skip_ws: true,
        ct: "text/xml; charset=utf-8",
    },
    Sig::Exact(b"%PDF-", "application/pdf"),
    Sig::Exact(b"%!PS-Adobe-", "application/postscript"),
    // UTF BOM
    masked(b"\xFF\xFF\x00\x00", b"\xFE\xFF\x00\x00", "text/plain; charset=utf-16be"),
    masked(b"\xFF\xFF\x00\x00", b"\xFF\xFE\x00\x00", "text/plain; charset=utf-16le"),
    masked(b"\xFF\xFF\xFF\x00", b"\xEF\xBB\xBF\x00", "text/plain; charset=utf-8"),
    // 그림
    Sig::Exact(b"\x00\x00\x01\x00", "image/x-icon"),
    Sig::Exact(b"\x00\x00\x02\x00", "image/x-icon"),
    Sig::Exact(b"BM", "image/bmp"),
    Sig::Exact(b"GIF87a", "image/gif"),
    Sig::Exact(b"GIF89a", "image/gif"),
    masked(
        b"\xFF\xFF\xFF\xFF\x00\x00\x00\x00\xFF\xFF\xFF\xFF\xFF\xFF",
        b"RIFF\x00\x00\x00\x00WEBPVP",
        "image/webp",
    ),
    Sig::Exact(b"\x89PNG\x0D\x0A\x1A\x0A", "image/png"),
    Sig::Exact(b"\xFF\xD8\xFF", "image/jpeg"),
    // 소리·영상
    masked(
        b"\xFF\xFF\xFF\xFF\x00\x00\x00\x00\xFF\xFF\xFF\xFF",
        b"FORM\x00\x00\x00\x00AIFF",
        "audio/aiff",
    ),
    masked(b"\xFF\xFF\xFF", b"ID3", "audio/mpeg"),
    masked(b"\xFF\xFF\xFF\xFF\xFF", b"OggS\x00", "application/ogg"),
    masked(
        b"\xFF\xFF\xFF\xFF\xFF\xFF\xFF\xFF",
        b"MThd\x00\x00\x00\x06",
        "audio/midi",
    ),
    masked(
        b"\xFF\xFF\xFF\xFF\x00\x00\x00\x00\xFF\xFF\xFF\xFF",
        b"RIFF\x00\x00\x00\x00AVI ",
        "video/avi",
    ),
    masked(
        b"\xFF\xFF\xFF\xFF\x00\x00\x00\x00\xFF\xFF\xFF\xFF",
        b"RIFF\x00\x00\x00\x00WAVE",
        "audio/wave",
    ),
    Sig::Mp4,
    Sig::Exact(b"\x1A\x45\xDF\xA3", "video/webm"),
    // 글꼴
    masked(
        b"\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\xFF\xFF",
        b"\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00LP",
        "application/vnd.ms-fontobject",
    ),
    Sig::Exact(b"\x00\x01\x00\x00", "font/ttf"),
    Sig::Exact(b"OTTO", "font/otf"),
    Sig::Exact(b"ttcf", "font/collection"),
    Sig::Exact(b"wOFF", "font/woff"),
    Sig::Exact(b"wOF2", "font/woff2"),
    // 압축
    Sig::Exact(b"\x1F\x8B\x08", "application/x-gzip"),
    Sig::Exact(b"PK\x03\x04", "application/zip"),
    Sig::Exact(b"Rar!\x1A\x07\x00", "application/x-rar-compressed"),
    Sig::Exact(b"Rar!\x1A\x07\x01\x00", "application/x-rar-compressed"),
    Sig::Exact(b"\x00\x61\x73\x6D", "application/wasm"),
    Sig::Text,
];

fn is_ws(b: u8) -> bool {
    matches!(b, b'\t' | b'\n' | b'\x0c' | b'\r' | b' ')
}

fn is_tt(b: u8) -> bool {
    matches!(b, b' ' | b'>')
}

impl Sig {
    fn matches(&self, data: &[u8], first_non_ws: usize) -> Option<&'static str> {
        match self {
            Sig::Exact(sig, ct) => data.starts_with(sig).then_some(*ct),
            Sig::Masked {
                mask,
                pat,
                skip_ws,
                ct,
            } => {
                let d = if *skip_ws {
                    &data[first_non_ws..]
                } else {
                    data
                };
                if pat.len() != mask.len() || d.len() < pat.len() {
                    return None;
                }
                pat.iter()
                    .zip(mask.iter())
                    .zip(d)
                    .all(|((p, m), b)| b & m == *p)
                    .then_some(*ct)
            }
            Sig::Html(h) => {
                let d = &data[first_non_ws..];
                if d.len() < h.len() + 1 {
                    return None;
                }
                for (i, &b) in h.iter().enumerate() {
                    let mut db = d[i];
                    if b.is_ascii_uppercase() {
                        db &= 0xDF;
                    }
                    if b != db {
                        return None;
                    }
                }
                is_tt(d[h.len()]).then_some(HTML)
            }
            Sig::Mp4 => mp4(data),
            Sig::Text => {
                let bad = data[first_non_ws..]
                    .iter()
                    .any(|&b| matches!(b, 0x00..=0x08 | 0x0B | 0x0E..=0x1A | 0x1C..=0x1F));
                (!bad).then_some("text/plain; charset=utf-8")
            }
        }
    }
}

fn mp4(data: &[u8]) -> Option<&'static str> {
    if data.len() < 12 {
        return None;
    }
    let box_size = u32::from_be_bytes([data[0], data[1], data[2], data[3]]) as usize;
    if data.len() < box_size || !box_size.is_multiple_of(4) {
        return None;
    }
    if &data[4..8] != b"ftyp" {
        return None;
    }
    let mut st = 8;
    while st < box_size {
        // 12 는 major brand 의 판 번호다 — 건너뛴다.
        if st != 12 && &data[st..st + 3] == b"mp4" {
            return Some("video/mp4");
        }
        st += 4;
    }
    None
}

/// Go `http.DetectContentType` 과 같다. 앞 512 바이트만 보고, 모르면
/// `application/octet-stream` 이다.
pub fn detect_content_type(data: &[u8]) -> &'static str {
    let data = &data[..data.len().min(SNIFF_LEN)];
    let first_non_ws = data.iter().position(|&b| !is_ws(b)).unwrap_or(data.len());
    SIGNATURES
        .iter()
        .find_map(|s| s.matches(data, first_non_ws))
        .unwrap_or("application/octet-stream")
}
