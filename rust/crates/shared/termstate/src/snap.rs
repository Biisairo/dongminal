//! 화면 상태 → 최소 재그리기 ANSI (FR-TRM-4, A-2). 받는 쪽(xterm.js)이 다시 해석 없이 같은 화면을 그린다.
//!
//! 순서: RIS → (대체 화면이면 주 화면 기록·행·커서 → 1049h) → 지금 화면 행 → 저장 커서(DECSC)
//! → 스크롤 영역·원점 → 커서(줄바꿈 대기 포함) → 문자 집합 → 펜(SGR·OSC 8) → 모드 → 제목
//! → 삽입 모드 → (물리지 못한) 끝나지 않은 시퀀스 바이트. 행은 위에서부터 차례로 쓰고 자동 줄바꿈으로 감싼 행을 잇는다.
//! 지우기(ED2)는 쓰지 않는다 — alacritty 는 ED2 때 화면을 기록으로 밀어 올리고 xterm.js 는 그러지 않는다.

use std::fmt::Write as _;

use otter_shared_linestore::Line;

use crate::{Attrs, Color, Link, Modes, MouseMode, Row};

/// 이 글자부터는 xterm.js unicode11 과 폭이 다를 수 있어 뒤에 열을 다시 찍는다(2.2 결정, 새 이모지).
const WIDTH_RECHECK_FROM: char = '\u{1F000}';

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub(crate) struct Pen {
    pub fg: Color,
    pub bg: Color,
    pub underline: Color,
    pub attrs: Attrs,
    pub link: Option<Link>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub(crate) struct CursorState {
    pub col: u16,
    pub row: u16,
    pub pending_wrap: bool,
    pub pen: Pen,
    /// G0~G3 가 선 그리기 문자 집합인가.
    pub line_drawing: [bool; 4],
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub(crate) struct GridState {
    /// 오래된 것부터.
    pub history: Vec<Row>,
    pub rows: Vec<Row>,
    pub cursor: CursorState,
    pub saved: CursorState,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub(crate) struct State {
    pub cols: u16,
    /// 줄 저장소에서 꺼낸, 에뮬레이터 기록보다 오래된 논리 줄이다(오래된 것부터).
    pub older: Vec<Line>,
    pub first_line: u64,
    pub main: GridState,
    /// 대체 화면 중이면 그 화면이다. 그때 `main` 은 가려진 주 화면이다.
    pub alt: Option<GridState>,
    pub modes: Modes,
    /// DECSCUSR 값. 기본 모양이면 `None`.
    pub cursor_style: Option<u8>,
    pub title: Option<String>,
    pub region: Option<(u16, u16)>,
    pub shift_out: bool,
    /// 스냅숏 끝에 그대로 붙일 끝나지 않은 바이트다(물리지 못할 때만).
    pub pending: Vec<u8>,
    /// 오프셋을 물린 바이트 수다.
    pub back: usize,
}

pub(crate) fn encode(st: &State) -> Vec<u8> {
    let mut o = String::from("\x1bc");
    let cols = st.cols;
    // 저장소 줄은 지금 폭으로 받는 쪽이 감싼다(D-28). 끝에서 속성과 링크를 닫는다.
    for l in &st.older {
        o.push_str(&l.to_ansi());
        o.push_str("\r\n");
    }
    let active = match &st.alt {
        Some(alt) => {
            write_rows(&mut o, st.main.history.iter().chain(&st.main.rows), cols);
            place_cursor(&mut o, &st.main.cursor, &st.main.rows, 0);
            cursor_extras(&mut o, &st.main.cursor);
            o.push_str("\x1b[?1049h\x1b[H\x1b[0m\x1b(B\x1b)B\x1b*B\x1b+B");
            write_rows(&mut o, alt.rows.iter(), cols);
            alt
        }
        None => {
            write_rows(&mut o, st.main.history.iter().chain(&st.main.rows), cols);
            &st.main
        }
    };
    if active.saved != CursorState::default() {
        place_cursor(&mut o, &active.saved, &active.rows, 0);
        cursor_extras(&mut o, &active.saved);
        o.push_str("\x1b7\x1b[0m\x1b(B\x1b)B\x1b*B\x1b+B");
    }
    let mut top = 0;
    if let Some((t, b)) = st.region {
        let _ = write!(o, "\x1b[{t};{b}r");
        if st.modes.origin {
            top = t - 1;
        }
    }
    if st.modes.origin {
        o.push_str("\x1b[?6h");
    }
    let cur = &active.cursor;
    if cur.pending_wrap {
        place_cursor(&mut o, cur, &active.rows, top);
    }
    cursor_extras(&mut o, cur);
    if st.shift_out {
        o.push('\x0e');
    }
    modes(&mut o, &st.modes);
    if let Some(n) = st.cursor_style {
        let _ = write!(o, "\x1b[{n} q");
    }
    if let Some(t) = &st.title {
        let _ = write!(o, "\x1b]2;{t}\x07");
    }
    if !cur.pending_wrap && !rejoin(&mut o, cur, &active.rows, top) {
        place_cursor(&mut o, cur, &active.rows, top);
    }
    if st.modes.insert {
        o.push_str("\x1b[4h");
    }
    let mut out = o.into_bytes();
    out.extend_from_slice(&st.pending);
    out
}

fn is_blank(c: &crate::Cell) -> bool {
    c.text == " "
        && c.width == 1
        && c.fg == Color::Default
        && c.bg == Color::Default
        && c.underline == Color::Default
        && c.attrs.is_empty()
        && c.link.is_none()
}

fn write_rows<'a>(o: &mut String, rows: impl Iterator<Item = &'a Row>, cols: u16) {
    let mut prev_wrapped = None;
    for row in rows {
        if prev_wrapped == Some(false) {
            o.push_str("\r\n");
        }
        // 앞 행이 감싸 이어지면 이 행에 한 칸은 써야 받는 쪽에서도 앞 행이 감싼 행이 된다.
        let min = usize::from(prev_wrapped == Some(true));
        let end = if row.wrapped {
            row.cells.len()
        } else {
            row.cells
                .iter()
                .rposition(|c| !is_blank(c))
                .map_or(0, |i| i + 1)
                .max(min)
        };
        let mut pen = Pen::default();
        for (x, c) in row.cells[..end].iter().enumerate() {
            if c.width == 0 {
                continue;
            }
            set_pen(o, &mut pen, &cell_pen(c));
            o.push_str(&c.text);
            let next = x + 2;
            if c.width == 2
                && next < usize::from(cols)
                && c.text
                    .chars()
                    .next()
                    .is_some_and(|ch| ch >= WIDTH_RECHECK_FROM)
            {
                let _ = write!(o, "\x1b[{}G", next + 1);
            }
        }
        set_pen(o, &mut pen, &Pen::default());
        prev_wrapped = Some(row.wrapped);
    }
}

fn cell_pen(c: &crate::Cell) -> Pen {
    Pen {
        fg: c.fg,
        bg: c.bg,
        underline: c.underline,
        attrs: c.attrs,
        link: c.link.clone(),
    }
}

/// 커서를 둔다. 줄바꿈 대기면 마지막 칸의 글자를 다시 찍어 받는 쪽도 대기 상태가 되게 한다.
fn place_cursor(o: &mut String, cur: &CursorState, rows: &[Row], top: u16) {
    let row = usize::from(cur.row);
    let line = cur.row.saturating_sub(top) + 1;
    let cells = rows.get(row).map(|r| r.cells.as_slice()).unwrap_or(&[]);
    if cur.pending_wrap
        && let Some(last) = cells.last()
    {
        let (x, c) = if last.width == 0 && cells.len() >= 2 && cells[cells.len() - 2].width == 2 {
            (cells.len() - 1, &cells[cells.len() - 2])
        } else {
            (cells.len(), last)
        };
        let _ = write!(o, "\x1b[{line};{x}H");
        let mut pen = Pen::default();
        set_pen(o, &mut pen, &cell_pen(c));
        o.push_str(&c.text);
        set_pen(o, &mut pen, &Pen::default());
        return;
    }
    let _ = write!(o, "\x1b[{line};{}H", cur.col + 1);
}

/// 커서 바로 앞 칸을 펜 그대로 다시 찍어 커서를 둔다. xterm.js 는 결합 문자를 바로 앞에 찍은 글자에만
/// 붙인다(사이에 시퀀스가 하나라도 있으면 따로 한 칸을 차지한다). 그래서 이것이 마지막 출력이어야 한다.
/// 앞 칸의 꼴이 펜과 다르거나 선 그리기 문자 집합이면 하지 않는다.
fn rejoin(o: &mut String, cur: &CursorState, rows: &[Row], top: u16) -> bool {
    let Some(cells) = rows.get(usize::from(cur.row)).map(|r| r.cells.as_slice()) else {
        return false;
    };
    let col = usize::from(cur.col);
    let Some(mut x) = col.checked_sub(1) else {
        return false;
    };
    if cells.get(x).is_some_and(|c| c.width == 0) && x >= 1 && cells[x - 1].width == 2 {
        x -= 1;
    }
    let Some(c) = cells.get(x) else {
        return false;
    };
    // 다시 찍은 뒤 커서가 제자리여야 한다. 앞 행이 감싸 이어지면 0열에 찍을 때 alacritty 가
    // 앞 행 끝의 넓은 글자 자리 표시를 지운다.
    let row = usize::from(cur.row);
    let after_wrap = row > 0 && rows.get(row - 1).is_some_and(|r| r.wrapped);
    let plain = !(x == 0 && after_wrap)
        && x + usize::from(c.width) == col
        && c.text
            .chars()
            .next()
            .is_some_and(|ch| ch < WIDTH_RECHECK_FROM)
        && !cur.line_drawing.iter().any(|b| *b)
        && cell_pen(c) == cur.pen;
    if !plain {
        return false;
    }
    let line = cur.row.saturating_sub(top) + 1;
    let _ = write!(o, "\x1b[{line};{}H{}", x + 1, c.text);
    true
}

/// 커서에 딸린 문자 집합과 펜이다.
fn cursor_extras(o: &mut String, cur: &CursorState) {
    for (i, ld) in cur.line_drawing.iter().enumerate() {
        if *ld {
            o.push('\x1b');
            o.push(['(', ')', '*', '+'][i]);
            o.push('0');
        }
    }
    let mut pen = Pen::default();
    set_pen(o, &mut pen, &cur.pen);
}

fn set_pen(o: &mut String, cur: &mut Pen, want: &Pen) {
    if (cur.fg, cur.bg, cur.underline, cur.attrs) != (want.fg, want.bg, want.underline, want.attrs)
    {
        sgr(o, want);
    }
    if cur.link != want.link {
        match &want.link {
            Some(l) => {
                let _ = write!(o, "\x1b]8;id={};{}\x1b\\", l.id, l.uri);
            }
            None => o.push_str("\x1b]8;;\x1b\\"),
        }
    }
    *cur = want.clone();
}

fn sgr(o: &mut String, p: &Pen) {
    o.push_str("\x1b[0");
    for (a, code) in [
        (Attrs::BOLD, "1"),
        (Attrs::DIM, "2"),
        (Attrs::ITALIC, "3"),
        (Attrs::UNDERLINE, "4"),
        (Attrs::DOUBLE_UNDERLINE, "4:2"),
        (Attrs::UNDERCURL, "4:3"),
        (Attrs::DOTTED_UNDERLINE, "4:4"),
        (Attrs::DASHED_UNDERLINE, "4:5"),
        (Attrs::INVERSE, "7"),
        (Attrs::HIDDEN, "8"),
        (Attrs::STRIKE, "9"),
    ] {
        if p.attrs.contains(a) {
            o.push(';');
            o.push_str(code);
        }
    }
    color(o, p.fg, 30, 90, 38);
    color(o, p.bg, 40, 100, 48);
    match p.underline {
        Color::Default => {}
        Color::Indexed(i) => {
            let _ = write!(o, ";58;5;{i}");
        }
        Color::Rgb(r, g, b) => {
            let _ = write!(o, ";58;2;{r};{g};{b}");
        }
    }
    o.push('m');
}

/// 16색은 30~37·90~97 꼴로 쓴다(xterm 의 굵은 글자 밝게 하기가 이 꼴에만 걸린다).
fn color(o: &mut String, c: Color, base: u8, bright: u8, ext: u8) {
    match c {
        Color::Default => {}
        Color::Indexed(i) if i < 8 => {
            let _ = write!(o, ";{}", base + i);
        }
        Color::Indexed(i) if i < 16 => {
            let _ = write!(o, ";{}", bright + i - 8);
        }
        Color::Indexed(i) => {
            let _ = write!(o, ";{ext};5;{i}");
        }
        Color::Rgb(r, g, b) => {
            let _ = write!(o, ";{ext};2;{r};{g};{b}");
        }
    }
}

fn modes(o: &mut String, m: &Modes) {
    let mut set = |on: bool, default: bool, seq_on: &str, seq_off: &str| {
        if on != default {
            o.push_str(if on { seq_on } else { seq_off });
        }
    };
    set(m.show_cursor, true, "\x1b[?25h", "\x1b[?25l");
    set(m.autowrap, true, "\x1b[?7h", "\x1b[?7l");
    set(m.line_feed_new_line, false, "\x1b[20h", "\x1b[20l");
    set(m.app_cursor, false, "\x1b[?1h", "\x1b[?1l");
    set(m.app_keypad, false, "\x1b=", "\x1b>");
    set(m.bracketed_paste, false, "\x1b[?2004h", "\x1b[?2004l");
    set(m.focus_report, false, "\x1b[?1004h", "\x1b[?1004l");
    set(m.alternate_scroll, true, "\x1b[?1007h", "\x1b[?1007l");
    set(m.sgr_mouse, false, "\x1b[?1006h", "\x1b[?1006l");
    set(m.utf8_mouse, false, "\x1b[?1005h", "\x1b[?1005l");
    match m.mouse {
        MouseMode::None => {}
        MouseMode::Click => o.push_str("\x1b[?1000h"),
        MouseMode::Drag => o.push_str("\x1b[?1002h"),
        MouseMode::Motion => o.push_str("\x1b[?1003h"),
    }
}
