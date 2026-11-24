//! 논리 줄 한 개 — 글자 + 속성 구간 + OSC 8 링크 구간 (D-28).

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum Color {
    #[default]
    Default,
    Indexed(u8),
    Rgb(u8, u8, u8),
}

/// 셀 속성 깃발. 값은 저장 형식의 일부라 바꾸지 않는다.
pub mod flags {
    pub const BOLD: u16 = 1;
    pub const DIM: u16 = 1 << 1;
    pub const ITALIC: u16 = 1 << 2;
    pub const UNDERLINE: u16 = 1 << 3;
    pub const DOUBLE_UNDERLINE: u16 = 1 << 4;
    pub const UNDERCURL: u16 = 1 << 5;
    pub const DOTTED_UNDERLINE: u16 = 1 << 6;
    pub const DASHED_UNDERLINE: u16 = 1 << 7;
    pub const INVERSE: u16 = 1 << 8;
    pub const HIDDEN: u16 = 1 << 9;
    pub const STRIKEOUT: u16 = 1 << 10;
    pub const ANY_UNDERLINE: u16 =
        UNDERLINE | DOUBLE_UNDERLINE | UNDERCURL | DOTTED_UNDERLINE | DASHED_UNDERLINE;
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct Style {
    pub fg: Color,
    pub bg: Color,
    pub underline: Color,
    pub flags: u16,
}

/// OSC 8 링크. `id` 는 비어 있을 수 있다.
#[derive(Clone, Debug, Default, PartialEq, Eq, Hash)]
pub struct Link {
    pub id: String,
    pub uri: String,
}

/// 폭이 1 이 아니거나 글자가 여럿(결합 문자)인 셀만 따로 적는다.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct CellExt {
    pub(crate) cell: u32,
    pub(crate) width: u8,
    pub(crate) chars: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct LinkRun {
    pub(crate) start: u32,
    pub(crate) end: u32,
    pub(crate) link: Link,
}

/// 자동 줄바꿈으로 감싼 행을 합친 줄. 뒤쪽의 기본 속성 빈칸은 두지 않는다.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Line {
    pub(crate) text: String,
    pub(crate) len: u32,
    pub(crate) ext: Vec<CellExt>,
    pub(crate) styles: Vec<(u32, Style)>,
    pub(crate) links: Vec<LinkRun>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Cell<'a> {
    pub text: &'a str,
    pub width: u8,
    pub style: Style,
    pub link: Option<&'a Link>,
}

impl Line {
    /// 셀 수(넓은 글자도 한 셀).
    pub fn len(&self) -> usize {
        self.len as usize
    }

    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    /// 화면 칸 수(넓은 글자는 두 칸).
    pub fn columns(&self) -> usize {
        self.len as usize + self.ext.iter().map(|e| e.width as usize).sum::<usize>()
            - self.ext.len()
    }

    pub fn text(&self) -> &str {
        &self.text
    }

    pub fn cells(&self) -> Cells<'_> {
        Cells {
            line: self,
            idx: 0,
            byte: 0,
            ext: 0,
            style: 0,
            link: 0,
        }
    }

    /// 지금 폭 `cols` 로 다시 감싼다. 넓은 글자가 행 끝에 들어가지 않으면 그 칸을 비우고 다음 행으로 넘긴다(xterm 과 같다).
    pub fn wrap(&self, cols: usize) -> Vec<Line> {
        let cols = cols.max(1);
        let mut rows = Vec::new();
        let mut row = LineBuilder::new();
        let mut used = 0usize;
        for c in self.cells() {
            let w = c.width as usize;
            if used > 0 && used + w > cols {
                rows.push(std::mem::take(&mut row).finish());
                used = 0;
            }
            row.push(c.text, c.width, c.style, c.link);
            used += w;
        }
        rows.push(row.finish());
        rows
    }

    /// 줄 하나를 ANSI 로 쓴다. 끝에서 속성과 링크를 닫는다. 줄바꿈은 붙이지 않는다.
    pub fn to_ansi(&self) -> String {
        let mut out = String::with_capacity(self.text.len() + 16);
        let mut style = Style::default();
        let mut link: Option<&Link> = None;
        for c in self.cells() {
            if c.link != link {
                match c.link {
                    Some(l) => push_osc8(&mut out, &l.id, &l.uri),
                    None => push_osc8(&mut out, "", ""),
                }
                link = c.link;
            }
            if c.style != style {
                push_sgr(&mut out, &c.style);
                style = c.style;
            }
            out.push_str(c.text);
        }
        if link.is_some() {
            push_osc8(&mut out, "", "");
        }
        if style != Style::default() {
            out.push_str("\x1b[0m");
        }
        out
    }

    /// 대략의 힙 바이트(풀린 줄의 크기 어림).
    pub(crate) fn heap_bytes(&self) -> usize {
        self.text.capacity()
            + self.ext.capacity() * std::mem::size_of::<CellExt>()
            + self.styles.capacity() * std::mem::size_of::<(u32, Style)>()
            + self.links.capacity() * std::mem::size_of::<LinkRun>()
            + self
                .links
                .iter()
                .map(|r| r.link.id.capacity() + r.link.uri.capacity())
                .sum::<usize>()
    }
}

fn push_osc8(out: &mut String, id: &str, uri: &str) {
    out.push_str("\x1b]8;");
    if !id.is_empty() {
        out.push_str("id=");
        out.push_str(id);
    }
    out.push(';');
    out.push_str(uri);
    out.push_str("\x1b\\");
}

fn push_color(out: &mut String, c: Color, base: u8, bright: u8, ext: u8) {
    use std::fmt::Write;
    let _ = match c {
        Color::Default => Ok(()),
        Color::Indexed(n) if n < 8 && base != 0 => write!(out, ";{}", base + n),
        Color::Indexed(n) if n < 16 && bright != 0 => write!(out, ";{}", bright + n - 8),
        Color::Indexed(n) => write!(out, ";{ext};5;{n}"),
        Color::Rgb(r, g, b) => write!(out, ";{ext};2;{r};{g};{b}"),
    };
}

fn push_sgr(out: &mut String, s: &Style) {
    out.push_str("\x1b[0");
    const CODES: [(u16, &str); 11] = [
        (flags::BOLD, ";1"),
        (flags::DIM, ";2"),
        (flags::ITALIC, ";3"),
        (flags::UNDERLINE, ";4"),
        (flags::DOUBLE_UNDERLINE, ";4:2"),
        (flags::UNDERCURL, ";4:3"),
        (flags::DOTTED_UNDERLINE, ";4:4"),
        (flags::DASHED_UNDERLINE, ";4:5"),
        (flags::INVERSE, ";7"),
        (flags::HIDDEN, ";8"),
        (flags::STRIKEOUT, ";9"),
    ];
    for (f, code) in CODES {
        if s.flags & f != 0 {
            out.push_str(code);
        }
    }
    push_color(out, s.fg, 30, 90, 38);
    push_color(out, s.bg, 40, 100, 48);
    push_color(out, s.underline, 0, 0, 58);
    out.push('m');
}

pub struct Cells<'a> {
    line: &'a Line,
    idx: u32,
    byte: usize,
    ext: usize,
    style: usize,
    link: usize,
}

impl<'a> Iterator for Cells<'a> {
    type Item = Cell<'a>;

    fn next(&mut self) -> Option<Cell<'a>> {
        let line = self.line;
        if self.idx >= line.len {
            return None;
        }
        let (width, chars) = match line.ext.get(self.ext) {
            Some(e) if e.cell == self.idx => {
                self.ext += 1;
                (e.width, e.chars)
            }
            _ => (1, 1),
        };
        let rest = &line.text[self.byte..];
        let end = rest
            .char_indices()
            .nth(chars as usize)
            .map_or(rest.len(), |(i, _)| i);
        let text = &rest[..end];
        self.byte += end;
        while line
            .styles
            .get(self.style + 1)
            .is_some_and(|(s, _)| *s <= self.idx)
        {
            self.style += 1;
        }
        let style = match line.styles.get(self.style) {
            Some((s, st)) if *s <= self.idx => *st,
            _ => Style::default(),
        };
        while line.links.get(self.link).is_some_and(|r| r.end <= self.idx) {
            self.link += 1;
        }
        let link = match line.links.get(self.link) {
            Some(r) if r.start <= self.idx => Some(&r.link),
            _ => None,
        };
        self.idx += 1;
        Some(Cell {
            text,
            width,
            style,
            link,
        })
    }
}

/// 셀을 왼쪽부터 넣어 [`Line`] 을 만든다. 넓은 글자의 뒤 칸(spacer)과 감싼 행 끝의 빈 칸은 넣지 않는다.
#[derive(Default)]
pub struct LineBuilder {
    line: Line,
    keep: Keep,
}

/// 마지막으로 빈칸이 아닌 셀까지의 길이. `finish` 가 뒤쪽 빈칸을 여기서 자른다.
#[derive(Default, Clone, Copy)]
struct Keep {
    len: u32,
    text: usize,
    ext: usize,
}

impl LineBuilder {
    pub fn new() -> Self {
        Self::default()
    }

    /// 셀 하나. `text` 가 비면 빈칸, `width` 는 1 또는 2 로 맞춘다.
    pub fn push(&mut self, text: &str, width: u8, style: Style, link: Option<&Link>) {
        let text = if text.is_empty() { " " } else { text };
        let width = width.clamp(1, 2);
        let l = &mut self.line;
        let idx = l.len;
        let chars = text.chars().count() as u32;
        if width != 1 || chars != 1 {
            l.ext.push(CellExt {
                cell: idx,
                width,
                chars,
            });
        }
        l.text.push_str(text);
        let cur = l.styles.last().map_or(Style::default(), |(_, s)| *s);
        if cur != style {
            l.styles.push((idx, style));
        }
        if let Some(link) = link {
            match l.links.last_mut() {
                Some(r) if r.end == idx && r.link == *link => r.end = idx + 1,
                _ => l.links.push(LinkRun {
                    start: idx,
                    end: idx + 1,
                    link: link.clone(),
                }),
            }
        }
        l.len = idx + 1;
        let blank = text == " " && width == 1 && style == Style::default() && link.is_none();
        if !blank {
            self.keep = Keep {
                len: l.len,
                text: l.text.len(),
                ext: l.ext.len(),
            };
        }
    }

    pub fn finish(self) -> Line {
        let mut l = self.line;
        let k = self.keep;
        l.len = k.len;
        l.text.truncate(k.text);
        l.ext.truncate(k.ext);
        l.styles.retain(|(s, _)| *s < k.len);
        l.text.shrink_to_fit();
        l.ext.shrink_to_fit();
        l.styles.shrink_to_fit();
        l.links.shrink_to_fit();
        l
    }
}

#[cfg(test)]
#[path = "line_tests.rs"]
pub(crate) mod tests;
