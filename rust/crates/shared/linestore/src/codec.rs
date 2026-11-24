//! 블록 = 줄 여러 개를 바이트로 적어 deflate 한 것. 형식은 이 crate 안에서만 읽는다.

use std::io::{Read, Write};

use flate2::Compression;
use flate2::read::DeflateDecoder;
use flate2::write::DeflateEncoder;

use crate::line::{CellExt, Color, Line, Link, LinkRun, Style};

pub(crate) fn compress(lines: &[Line]) -> Vec<u8> {
    let mut raw = Vec::new();
    put(&mut raw, lines.len() as u64);
    for l in lines {
        put_line(&mut raw, l);
    }
    let mut enc = DeflateEncoder::new(Vec::new(), Compression::default());
    // Vec 에 쓰는 일은 실패하지 않는다.
    let _ = enc.write_all(&raw);
    let mut out = enc.finish().unwrap_or_default();
    out.shrink_to_fit();
    out
}

pub(crate) fn decompress(data: &[u8]) -> Option<Vec<Line>> {
    let mut raw = Vec::new();
    DeflateDecoder::new(data).read_to_end(&mut raw).ok()?;
    let mut r = Reader { buf: &raw, pos: 0 };
    let n = r.num()?;
    let mut lines = Vec::with_capacity(n.min(raw.len()));
    for _ in 0..n {
        lines.push(r.line()?);
    }
    Some(lines)
}

fn put(out: &mut Vec<u8>, mut v: u64) {
    loop {
        let b = (v & 0x7f) as u8;
        v >>= 7;
        if v == 0 {
            out.push(b);
            return;
        }
        out.push(b | 0x80);
    }
}

fn put_str(out: &mut Vec<u8>, s: &str) {
    put(out, s.len() as u64);
    out.extend_from_slice(s.as_bytes());
}

fn put_color(out: &mut Vec<u8>, c: Color) {
    match c {
        Color::Default => out.push(0),
        Color::Indexed(n) => out.extend_from_slice(&[1, n]),
        Color::Rgb(r, g, b) => out.extend_from_slice(&[2, r, g, b]),
    }
}

fn put_line(out: &mut Vec<u8>, l: &Line) {
    put_str(out, &l.text);
    put(out, u64::from(l.len));
    put(out, l.ext.len() as u64);
    for e in &l.ext {
        put(out, u64::from(e.cell));
        out.push(e.width);
        put(out, u64::from(e.chars));
    }
    put(out, l.styles.len() as u64);
    for (start, s) in &l.styles {
        put(out, u64::from(*start));
        put(out, u64::from(s.flags));
        put_color(out, s.fg);
        put_color(out, s.bg);
        put_color(out, s.underline);
    }
    put(out, l.links.len() as u64);
    for r in &l.links {
        put(out, u64::from(r.start));
        put(out, u64::from(r.end));
        put_str(out, &r.link.id);
        put_str(out, &r.link.uri);
    }
}

struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl Reader<'_> {
    fn byte(&mut self) -> Option<u8> {
        let b = *self.buf.get(self.pos)?;
        self.pos += 1;
        Some(b)
    }

    fn num(&mut self) -> Option<usize> {
        let mut v: u64 = 0;
        for shift in (0..64).step_by(7) {
            let b = self.byte()?;
            v |= u64::from(b & 0x7f) << shift;
            if b & 0x80 == 0 {
                return usize::try_from(v).ok();
            }
        }
        None
    }

    fn u32(&mut self) -> Option<u32> {
        u32::try_from(self.num()?).ok()
    }

    fn string(&mut self) -> Option<String> {
        let n = self.num()?;
        let end = self.pos.checked_add(n)?;
        let s = std::str::from_utf8(self.buf.get(self.pos..end)?).ok()?;
        self.pos = end;
        Some(s.to_owned())
    }

    fn color(&mut self) -> Option<Color> {
        match self.byte()? {
            0 => Some(Color::Default),
            1 => Some(Color::Indexed(self.byte()?)),
            2 => Some(Color::Rgb(self.byte()?, self.byte()?, self.byte()?)),
            _ => None,
        }
    }

    fn line(&mut self) -> Option<Line> {
        let text = self.string()?;
        let len = self.u32()?;
        let n = self.num()?;
        let mut ext = Vec::with_capacity(n.min(len as usize));
        for _ in 0..n {
            ext.push(CellExt {
                cell: self.u32()?,
                width: self.byte()?,
                chars: self.u32()?,
            });
        }
        let n = self.num()?;
        let mut styles = Vec::with_capacity(n.min(len as usize));
        for _ in 0..n {
            let start = self.u32()?;
            let flags = u16::try_from(self.num()?).ok()?;
            styles.push((
                start,
                Style {
                    flags,
                    fg: self.color()?,
                    bg: self.color()?,
                    underline: self.color()?,
                },
            ));
        }
        let n = self.num()?;
        let mut links = Vec::with_capacity(n.min(len as usize));
        for _ in 0..n {
            links.push(LinkRun {
                start: self.u32()?,
                end: self.u32()?,
                link: Link {
                    id: self.string()?,
                    uri: self.string()?,
                },
            });
        }
        Some(Line {
            text,
            len,
            ext,
            styles,
            links,
        })
    }
}
