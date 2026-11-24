//! alacritty_terminal 을 쓰는 유일한 모듈이다. 판을 올리면 비교 시험(`testdata`)을 다시 돌린다.

use std::time::Duration;

use alacritty_terminal::event::EventListener;
use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::index::{Column, Line};
use alacritty_terminal::term::cell::{Cell as ACell, Flags};
use alacritty_terminal::term::{Config, Term, TermMode};
use alacritty_terminal::vte::ansi::{Color as AColor, NamedColor, Processor, Timeout};

use crate::{Attrs, Cell, Color, Cursor, Link, Modes, MouseMode, Row};

/// 답장·제목·클립보드 같은 사건을 모두 버린다. 답장(`PtyWrite`)을 PTY 에 쓰지 않는다.
struct Quiet;

impl EventListener for Quiet {}

/// 동기 갱신(DECSET 2026)이 바이트를 붙잡지 않게 한다. 화면은 언제나 넣은 바이트 끝까지의 상태다.
#[derive(Default)]
struct NoSync;

impl Timeout for NoSync {
    fn set_timeout(&mut self, _: Duration) {}
    fn clear_timeout(&mut self) {}
    fn pending_timeout(&self) -> bool {
        false
    }
}

struct Size {
    cols: usize,
    rows: usize,
}

impl Size {
    fn new(cols: u16, rows: u16) -> Self {
        Self {
            cols: usize::from(cols.max(1)),
            rows: usize::from(rows.max(1)),
        }
    }
}

impl Dimensions for Size {
    fn total_lines(&self) -> usize {
        self.rows
    }
    fn screen_lines(&self) -> usize {
        self.rows
    }
    fn columns(&self) -> usize {
        self.cols
    }
}

/// 도구 하나의 화면 상태다.
pub struct Screen {
    term: Term<Quiet>,
    parser: Processor<NoSync>,
    history: usize,
}

impl Screen {
    /// `history` 는 에뮬레이터가 화면 위에 드는 기록 줄 수의 상한이다. 크기 0 은 1 로 올린다.
    pub fn new(cols: u16, rows: u16, history: usize) -> Self {
        let cfg = Config {
            scrolling_history: history,
            ..Config::default()
        };
        Self {
            term: Term::new(cfg, &Size::new(cols, rows), Quiet),
            parser: Processor::new(),
            history,
        }
    }

    pub fn feed(&mut self, bytes: &[u8]) {
        self.parser.advance(&mut self.term, bytes);
    }

    pub fn resize(&mut self, cols: u16, rows: u16) {
        self.term.resize(Size::new(cols, rows));
    }

    /// `(cols, rows)`.
    pub fn size(&self) -> (u16, u16) {
        let g = self.term.grid();
        (to_u16(g.columns()), to_u16(g.screen_lines()))
    }

    /// 화면 위에 지금 든 기록 줄 수다. 대체 화면에서는 0 이다.
    pub fn history_len(&self) -> usize {
        self.term.grid().history_size()
    }

    /// `0..rows` 는 화면, `-1` 은 가장 새 기록, `-history_len` 은 가장 오래된 기록이다.
    pub fn row(&self, line: i32) -> Option<Row> {
        let g = self.term.grid();
        let rows = i32::try_from(g.screen_lines()).ok()?;
        let hist = i32::try_from(g.history_size()).ok()?;
        if line >= rows || line < -hist {
            return None;
        }
        let r = &g[Line(line)];
        let cols = g.columns();
        Some(Row {
            cells: (0..cols).map(|x| cell(&r[Column(x)])).collect(),
            wrapped: r[Column(cols - 1)].flags.contains(Flags::WRAPLINE),
        })
    }

    /// 가장 오래된 기록 `n` 줄을 지운다. 상한은 그대로다.
    pub fn drop_oldest(&mut self, n: usize) {
        let g = self.term.grid_mut();
        let keep = g.history_size().saturating_sub(n);
        g.update_history(keep);
        g.update_history(self.history);
    }

    pub fn cursor(&self) -> Cursor {
        let p = self.term.grid().cursor.point;
        Cursor {
            col: to_u16(p.column.0),
            row: u16::try_from(p.line.0).unwrap_or(0),
            visible: self.term.mode().contains(TermMode::SHOW_CURSOR),
        }
    }

    pub fn modes(&self) -> Modes {
        let m = *self.term.mode();
        let mouse = if m.contains(TermMode::MOUSE_MOTION) {
            MouseMode::Motion
        } else if m.contains(TermMode::MOUSE_DRAG) {
            MouseMode::Drag
        } else if m.contains(TermMode::MOUSE_REPORT_CLICK) {
            MouseMode::Click
        } else {
            MouseMode::None
        };
        Modes {
            alt_screen: m.contains(TermMode::ALT_SCREEN),
            show_cursor: m.contains(TermMode::SHOW_CURSOR),
            app_cursor: m.contains(TermMode::APP_CURSOR),
            app_keypad: m.contains(TermMode::APP_KEYPAD),
            bracketed_paste: m.contains(TermMode::BRACKETED_PASTE),
            focus_report: m.contains(TermMode::FOCUS_IN_OUT),
            mouse,
            sgr_mouse: m.contains(TermMode::SGR_MOUSE),
            utf8_mouse: m.contains(TermMode::UTF8_MOUSE),
            alternate_scroll: m.contains(TermMode::ALTERNATE_SCROLL),
            origin: m.contains(TermMode::ORIGIN),
            autowrap: m.contains(TermMode::LINE_WRAP),
            insert: m.contains(TermMode::INSERT),
            line_feed_new_line: m.contains(TermMode::LINE_FEED_NEW_LINE),
        }
    }
}

fn to_u16(v: usize) -> u16 {
    u16::try_from(v).unwrap_or(u16::MAX)
}

fn color(c: AColor) -> Color {
    match c {
        AColor::Spec(r) => Color::Rgb(r.r, r.g, r.b),
        AColor::Indexed(i) => Color::Indexed(i),
        AColor::Named(n) => {
            let i = n as usize;
            let dim = NamedColor::DimBlack as usize;
            let idx = if i < 16 {
                Some(i)
            } else if (dim..dim + 8).contains(&i) {
                Some(i - dim)
            } else {
                None
            };
            idx.and_then(|i| u8::try_from(i).ok())
                .map_or(Color::Default, Color::Indexed)
        }
    }
}

const ATTRS: [(Flags, Attrs); 7] = [
    (Flags::BOLD, Attrs::BOLD),
    (Flags::DIM, Attrs::DIM),
    (Flags::ITALIC, Attrs::ITALIC),
    (Flags::ALL_UNDERLINES, Attrs::UNDERLINE),
    (Flags::INVERSE, Attrs::INVERSE),
    (Flags::HIDDEN, Attrs::HIDDEN),
    (Flags::STRIKEOUT, Attrs::STRIKE),
];

fn cell(c: &ACell) -> Cell {
    let fl = c.flags;
    let spacer = fl.intersects(Flags::WIDE_CHAR_SPACER | Flags::LEADING_WIDE_CHAR_SPACER);
    let mut text = if spacer || c.c == '\t' {
        " ".to_string()
    } else {
        c.c.to_string()
    };
    if let Some(z) = c.zerowidth() {
        text.extend(z.iter());
    }
    let width = if spacer {
        0
    } else if fl.contains(Flags::WIDE_CHAR) {
        2
    } else {
        1
    };
    let attrs = ATTRS
        .iter()
        .filter(|(f, _)| fl.intersects(*f))
        .fold(Attrs::default(), |a, (_, b)| a.with(*b));
    Cell {
        text,
        width,
        fg: color(c.fg),
        bg: color(c.bg),
        attrs,
        link: c.hyperlink().map(|h| Link {
            id: h.id().to_string(),
            uri: h.uri().to_string(),
        }),
    }
}
