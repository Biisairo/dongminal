//! Go 기준선 `dongminal/internal/shared/textenc` 의 Rust 포팅.
//!
//! 텍스트 파일의 인코딩 판별·엄격 디코드·재인코딩이다 (REPO_FIX 03 §3A-1·3A-2·3A-3).
//! 편집기의 파일 읽기·저장과 git diff 양쪽이 같은 규칙을 쓴다.
//!
//! **조용한 손실이 없다.** 엄격 디코드는 치환 문자 없이 풀리고 다시 인코딩했을 때
//! 원문과 바이트가 같아야 성공이다. 재인코딩은 표현할 수 없는 첫 문자의 위치를
//! 돌려주고 아무것도 쓰지 않는다.
//!
//! Go 는 `golang.org/x/text` 를, 이 crate 는 `encoding_rs` 를 쓴다. 둘 다 WHATWG
//! Encoding 표준의 표(EUC-KR=windows-949, Shift_JIS, windows-1252)를 따르지만 인코더가
//! 몇 글자에서 다르다. 그 차이(Shift_JIS 377자, windows-1252 미정의 5자)는 기준선과
//! 전수 대조해 덮어쓴다. UTF-16 은 encoding_rs 가 인코더를 주지 않으므로 직접 쓴다.

use encoding_rs::{EUC_KR, Encoding, SHIFT_JIS, WINDOWS_1252};

mod sjis_overrides;
use sjis_overrides::SJIS_ENCODE_OVERRIDES;

pub const UTF8: &str = "utf-8";
pub const UTF16LE: &str = "utf-16le";
pub const UTF16BE: &str = "utf-16be";
pub const CP949: &str = "cp949";
pub const SHIFT_JIS_ID: &str = "shift_jis";
pub const WIN1252: &str = "windows-1252";

/// "다른 인코딩으로 다시 열기" 가 제시하는 인코딩이다. 순서가 메뉴 순서다
/// (`GET /api/meta` 의 `encodings`, SERVER_DRIVEN_ACTIONS_SRS K-d).
pub const REOPEN_CHOICES: [&str; 4] = [UTF8, CP949, SHIFT_JIS_ID, WIN1252];

const BOM_UTF8: &[u8] = &[0xEF, 0xBB, 0xBF];
const BOM_UTF16LE: &[u8] = &[0xFF, 0xFE];
const BOM_UTF16BE: &[u8] = &[0xFE, 0xFF];

/// Windows-1252 에 정의되지 않은 바이트다 — 디코더가 C1 제어 문자로 통과시키지만
/// 그 파일이 1252 라는 근거가 아니다.
const WIN1252_UNDEFINED: [u8; 5] = [0x81, 0x8D, 0x8F, 0x90, 0x9D];

#[derive(Clone, Copy)]
enum Codec {
    Utf16 { le: bool },
    Legacy(&'static Encoding),
}

fn codec(id: &str) -> Option<Codec> {
    match id {
        UTF16LE => Some(Codec::Utf16 { le: true }),
        UTF16BE => Some(Codec::Utf16 { le: false }),
        CP949 => Some(Codec::Legacy(EUC_KR)),
        SHIFT_JIS_ID => Some(Codec::Legacy(SHIFT_JIS)),
        WIN1252 => Some(Codec::Legacy(WINDOWS_1252)),
        _ => None,
    }
}

impl Codec {
    /// 치환 없는 디코드다. 잘못된 입력이면 `None`.
    fn decode_strict(self, b: &[u8]) -> Option<String> {
        match self {
            Codec::Utf16 { le } => {
                if b.len() % 2 != 0 {
                    return None;
                }
                let units = b.chunks_exact(2).map(|p| {
                    if le {
                        u16::from_le_bytes([p[0], p[1]])
                    } else {
                        u16::from_be_bytes([p[0], p[1]])
                    }
                });
                char::decode_utf16(units).collect::<Result<String, _>>().ok()
            }
            Codec::Legacy(enc) => enc
                .decode_without_bom_handling_and_without_replacement(b)
                .map(|c| c.into_owned()),
        }
    }

    /// 치환 없는 인코드다. 표현할 수 없는 글자가 있으면 `None`.
    fn encode_strict(self, text: &str) -> Option<Vec<u8>> {
        match self {
            Codec::Utf16 { le } => {
                let mut out = Vec::with_capacity(text.len() * 2);
                for u in text.encode_utf16() {
                    out.extend_from_slice(&if le { u.to_le_bytes() } else { u.to_be_bytes() });
                }
                Some(out)
            }
            Codec::Legacy(enc) if enc == SHIFT_JIS => encode_sjis(text),
            Codec::Legacy(enc) if enc == WINDOWS_1252 => {
                // x/text 는 1252 의 미정의 자리(U+0081 등)를 인코딩하지 않는다.
                if text.chars().any(|c| (c as u32) < 0x100 && WIN1252_UNDEFINED.contains(&(c as u8))) {
                    return None;
                }
                encode_whatwg(enc, text)
            }
            Codec::Legacy(enc) => encode_whatwg(enc, text),
        }
    }
}

fn encode_whatwg(enc: &'static Encoding, text: &str) -> Option<Vec<u8>> {
    let (out, _, unmappable) = enc.encode(text);
    (!unmappable).then(|| out.into_owned())
}

fn sjis_override(c: char) -> Option<Option<[u8; 2]>> {
    SJIS_ENCODE_OVERRIDES
        .binary_search_by_key(&c, |(k, _)| *k)
        .ok()
        .map(|i| SJIS_ENCODE_OVERRIDES[i].1)
}

/// x/text 의 Shift_JIS 인코더와 같다: WHATWG 표에 예외 표를 덮어쓴다.
fn encode_sjis(text: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(text.len());
    let mut start = 0;
    for (i, c) in text.char_indices() {
        let Some(over) = sjis_override(c) else {
            continue;
        };
        out.extend(encode_whatwg(SHIFT_JIS, &text[start..i])?);
        out.extend_from_slice(&over?);
        start = i + c.len_utf8();
    }
    out.extend(encode_whatwg(SHIFT_JIS, &text[start..])?);
    Some(out)
}

/// `id` 가 이 crate 가 아는 인코딩인가다.
pub fn valid(id: &str) -> bool {
    id == UTF8 || codec(id).is_some()
}

/// 판별·디코드의 결과다. `text` 는 BOM 을 뗀 UTF-8 이다.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Decoded {
    pub text: String,
    pub enc: &'static str,
    pub bom: bool,
    pub decodable: bool,
}

fn static_id(id: &str) -> Option<&'static str> {
    [UTF8, UTF16LE, UTF16BE, CP949, SHIFT_JIS_ID, WIN1252]
        .into_iter()
        .find(|k| *k == id)
}

/// UTF-16 BOM 으로 시작하는가다 — UTF-32LE BOM(FF FE 00 00)은 아니다.
pub fn has_utf16_bom(b: &[u8]) -> bool {
    if b.starts_with(BOM_UTF16BE) {
        return true;
    }
    b.starts_with(BOM_UTF16LE) && !b.starts_with(&[0xFF, 0xFE, 0, 0])
}

/// §3A-1 순서로 판별한다: BOM → 유효한 UTF-8 → CP949 엄격 디코드 → 실패.
/// 실패면 `decodable=false` 이고 `text` 는 UTF-8 치환 디코드다.
pub fn detect(b: &[u8]) -> Decoded {
    let forced = if b.starts_with(BOM_UTF8) {
        Some(UTF8)
    } else if has_utf16_bom(b) && b.starts_with(BOM_UTF16LE) {
        Some(UTF16LE)
    } else if has_utf16_bom(b) {
        Some(UTF16BE)
    } else {
        None
    };
    if let Some(d) = forced.and_then(|id| decode_as(b, id)) {
        return d;
    }
    if let Ok(s) = std::str::from_utf8(b) {
        return Decoded {
            text: s.to_owned(),
            enc: UTF8,
            bom: false,
            decodable: true,
        };
    }
    if let Some(d) = decode_as(b, CP949) {
        return d;
    }
    Decoded {
        text: to_valid_utf8_replacing(b),
        enc: UTF8,
        bom: false,
        decodable: false,
    }
}

/// Go `strings.ToValidUTF8(s, "�")`: 잘못된 바이트의 **연속** 하나를 U+FFFD 하나로 바꾼다.
fn to_valid_utf8_replacing(b: &[u8]) -> String {
    let mut out = String::with_capacity(b.len());
    let mut in_invalid = false;
    for chunk in b.utf8_chunks() {
        let valid = chunk.valid();
        if !valid.is_empty() {
            out.push_str(valid);
            in_invalid = false;
        }
        if !chunk.invalid().is_empty() {
            if !in_invalid {
                out.push(char::REPLACEMENT_CHARACTER);
            }
            in_invalid = true;
        }
    }
    out
}

/// `id` 로 엄격 디코드한다. 그 인코딩의 BOM 으로 시작하면 떼고 `bom=true`.
/// 치환 문자가 생기거나(원문에 U+FFFD 가 있어도) 다시 인코딩한 바이트가 원문과 다르면 실패다.
pub fn decode_as(b: &[u8], id: &str) -> Option<Decoded> {
    let mut body = b;
    let mut bom = false;
    match id {
        UTF8 => {
            if let Some(rest) = b.strip_prefix(BOM_UTF8) {
                body = rest;
                bom = true;
            }
            let s = std::str::from_utf8(body).ok()?;
            return Some(Decoded {
                text: s.to_owned(),
                enc: UTF8,
                bom,
                decodable: true,
            });
        }
        UTF16LE => {
            if let Some(rest) = b.strip_prefix(BOM_UTF16LE) {
                body = rest;
                bom = true;
            }
        }
        UTF16BE => {
            if let Some(rest) = b.strip_prefix(BOM_UTF16BE) {
                body = rest;
                bom = true;
            }
        }
        WIN1252 => {
            if b.iter().any(|c| WIN1252_UNDEFINED.contains(c)) {
                return None;
            }
        }
        _ => {}
    }
    let c = codec(id)?;
    let text = c.decode_strict(body)?;
    if text.contains(char::REPLACEMENT_CHARACTER) {
        return None;
    }
    if c.encode_strict(&text)? != body {
        return None;
    }
    Some(Decoded {
        text,
        enc: static_id(id)?,
        bom,
        decodable: true,
    })
}

/// 대상 인코딩으로 표현할 수 없는 첫 문자다. `line` 은 1-기준, `col` 은 1-기준 UTF-16
/// 코드 단위(편집기의 열)다. JSON 필드는 `line`·`col`·`char` 다.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Unmappable {
    pub line: usize,
    pub col: usize,
    pub ch: String,
}

/// [`encode`] 의 실패다. 모르는 인코딩일 때뿐이며 문구는 Go `encoding.ErrInvalidUTF8` 과 같다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EncodeError;

impl std::fmt::Display for EncodeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("encoding: invalid UTF-8")
    }
}

impl std::error::Error for EncodeError {}

/// [`encode`] 의 결과다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Encoded {
    Bytes(Vec<u8>),
    /// 표현할 수 없는 글자가 있어 아무것도 만들지 않았다.
    Unmappable(Unmappable),
}

/// `text` 를 `id` 로 인코딩한다. UTF-8 은 `bom` 이면 BOM 을 붙이고, UTF-16 은 언제나 그
/// 순서의 BOM 을 붙인다. 그 밖의 인코딩은 표현할 수 없는 문자가 있으면 첫 위치를 돌려준다.
pub fn encode(text: &str, id: &str, bom: bool) -> Result<Encoded, EncodeError> {
    if id == UTF8 {
        let mut out = Vec::with_capacity(text.len() + 3);
        if bom {
            out.extend_from_slice(BOM_UTF8);
        }
        out.extend_from_slice(text.as_bytes());
        return Ok(Encoded::Bytes(out));
    }
    let c = codec(id).ok_or(EncodeError)?;
    if let Codec::Utf16 { le } = c {
        let mut out = if le { BOM_UTF16LE } else { BOM_UTF16BE }.to_vec();
        out.extend(c.encode_strict(text).unwrap_or_default());
        return Ok(Encoded::Bytes(out));
    }
    match c.encode_strict(text) {
        Some(out) => Ok(Encoded::Bytes(out)),
        None => Ok(Encoded::Unmappable(first_unmappable(text, c))),
    }
}

fn first_unmappable(text: &str, c: Codec) -> Unmappable {
    let (mut line, mut col) = (1, 1);
    let mut buf = [0u8; 4];
    for ch in text.chars() {
        if c.encode_strict(ch.encode_utf8(&mut buf)).is_none() {
            return Unmappable {
                line,
                col,
                ch: ch.to_string(),
            };
        }
        if ch == '\n' {
            line += 1;
            col = 1;
            continue;
        }
        col += ch.len_utf16();
    }
    Unmappable {
        line,
        col,
        ch: String::new(),
    }
}

#[cfg(test)]
mod tests;
