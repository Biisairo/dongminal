//! Go 기준선 `otterminal/internal/shared/mimeprobe` 의 Rust 포팅.
//!
//! **바이트의 앞머리로 그림인지**를 판정한다. 이 판정이 참이면 그 바이트가 추론된
//! MIME 으로 우리 출처에서 인라인으로 나간다 — `/api/file/raw`(FR-DRV-24)와
//! `/api/git/blob`(FR-M9-21).

mod sniff;

pub use sniff::detect_content_type;

/// 판정에 쓰는 앞머리의 길이다. `http.DetectContentType` 이 보는 만큼이다.
pub const SNIFF_LEN: usize = sniff::SNIFF_LEN;

/// SVG 가 나갈 때의 MIME 이다. `DetectContentType` 은 SVG 를 `text/plain` 으로 본다.
pub const SVG_MIME: &str = "image/svg+xml";

/// 앞머리가 **그림이면** 그 MIME 을, 아니면 빈 문자열을 준다. 확장자는 근거가 아니다
/// (FR-EVW-2). SVG 는 [`looks_like_svg`] 로 따로 본다.
pub fn image_mime(head: &[u8]) -> &'static str {
    let sniff = &head[..head.len().min(SNIFF_LEN)];
    let m = detect_content_type(sniff);
    if m.starts_with("image/") {
        return m;
    }
    if looks_like_svg(head) {
        return SVG_MIME;
    }
    ""
}

fn trim_left<'a>(mut b: &'a [u8], cut: &[u8]) -> &'a [u8] {
    while let Some((&c, rest)) = b.split_first() {
        if !cut.contains(&c) {
            break;
        }
        b = rest;
    }
    b
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

/// **내용으로** SVG 를 판정한다 (FR-DRV-24 ①). XML 선언·주석·DOCTYPE 을 건너뛰고
/// 루트 요소가 `<svg` 인지 본다. 대문자 `<SVG` 는 받지 않는다.
pub fn looks_like_svg(head: &[u8]) -> bool {
    // Go `bytes.TrimLeft(head, "\xef\xbb\xbf \t\r\n")` 는 이 글자들의 **집합**을 걷는다.
    // cutset 이 잘못된 UTF-8 이 아니므로 룬 단위로 비교하며, U+FEFF 와 공백 넷이 그 집합이다.
    let mut b = trim_left_bom_ws(head);
    while !b.is_empty() {
        if b.starts_with(b"<?") {
            let Some(i) = find(b, b"?>") else {
                return false;
            };
            b = &b[i + 2..];
        } else if b.starts_with(b"<!--") {
            let Some(i) = find(b, b"-->") else {
                return false;
            };
            b = &b[i + 3..];
        } else if b.starts_with(b"<!") {
            let Some(i) = b.iter().position(|&c| c == b'>') else {
                return false;
            };
            b = &b[i + 1..];
        } else {
            if !b.starts_with(b"<svg") {
                return false;
            }
            if b.len() == 4 {
                return true;
            }
            return matches!(b[4], b' ' | b'\t' | b'\r' | b'\n' | b'>' | b'/');
        }
        b = trim_left(b, b" \t\r\n");
    }
    false
}

/// 앞쪽의 U+FEFF(EF BB BF)와 ` \t\r\n` 을 순서 없이 걷는다.
fn trim_left_bom_ws(mut b: &[u8]) -> &[u8] {
    loop {
        if let Some(rest) = b.strip_prefix(b"\xef\xbb\xbf") {
            b = rest;
        } else if let Some((&c, rest)) = b.split_first()
            && matches!(c, b' ' | b'\t' | b'\r' | b'\n')
        {
            b = rest;
        } else {
            return b;
        }
    }
}

#[cfg(test)]
mod tests;
