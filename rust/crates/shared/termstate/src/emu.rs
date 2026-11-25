//! alacritty_terminal 을 쓰는 유일한 모듈이다. 판을 올리면 비교 시험(`testdata`)을 다시 돌린다.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use alacritty_terminal::event::{Event, EventListener};
use alacritty_terminal::grid::{Cursor as ACursor, Dimensions, Grid};
use alacritty_terminal::index::{Column, Line};
use alacritty_terminal::term::cell::{Cell as ACell, Flags};
use alacritty_terminal::term::{Config, Term, TermMode};
use alacritty_terminal::vte::ansi::{
    CharsetIndex, Color as AColor, CursorShape, NamedColor, Processor, StandardCharset, Timeout,
};

use otter_shared_linestore::{LineStore, split_for_rows};

use crate::hist;
use crate::scan::Scan;
use crate::snap::{self, CursorState, GridState, Pen, State};
use crate::{Attrs, Cell, Color, Cursor, Handover, Link, Modes, MouseMode, Row, Snapshot};

type Title = Arc<Mutex<Option<String>>>;
type Replies = Arc<Mutex<Vec<u8>>>;

/// 제목과 DA·DSR·커서 위치 질의의 답(D-23)만 적어 두고 나머지 사건(색 질의·클립보드 등)은 버린다.
/// 답을 PTY 에 쓸지는 도구가 정한다.
struct Quiet {
    title: Title,
    replies: Replies,
}

impl EventListener for Quiet {
    fn send_event(&self, event: Event) {
        let t = match event {
            Event::Title(t) => Some(t),
            Event::ResetTitle => None,
            Event::PtyWrite(r) if is_status_reply(&r) => {
                let mut g = self.replies.lock().unwrap_or_else(|e| e.into_inner());
                g.extend_from_slice(r.as_bytes());
                return;
            }
            _ => return,
        };
        *self.title.lock().unwrap_or_else(|e| e.into_inner()) = t;
    }
}

/// DA(`CSI ? … c`·`CSI > … c`)·DSR(`CSI 0 n`)·커서 위치(`CSI r ; c R`)의 답이다. 모드(`$y`)·키보드
/// (`u`) 답은 브라우저 xterm 이 내지 않으므로 데몬도 내지 않는다.
fn is_status_reply(r: &str) -> bool {
    let Some(body) = r.strip_prefix("\x1b[") else {
        return false;
    };
    let body = body.strip_prefix(['?', '>']).unwrap_or(body);
    let Some((last, params)) = body.as_bytes().split_last() else {
        return false;
    };
    matches!(last, b'c' | b'n' | b'R') && params.iter().all(|b| b.is_ascii_digit() || *b == b';')
}

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

/// 에뮬레이터가 화면 위에 남기는 기록 줄 수다. 넘는 줄은 줄 저장소로 옮긴다(EMULATOR §6, D-14).
pub const EMU_KEEP: usize = 1_000;
/// 넣기 조각 하나가 기록으로 밀어 올릴 수 있는 행 수다([`split_for_rows`] 상한). 이만큼 넘을 때까지는
/// 걸친 논리 줄이 끝나기를 기다리고, 넘으면 끊어 옮긴다.
const SLACK: usize = 256;

/// 도구 하나의 화면 상태다. 에뮬레이터 화면·짧은 기록과, 그 위의 줄 저장소를 함께 든다.
pub struct Screen {
    term: Term<Quiet>,
    parser: Processor<NoSync>,
    scan: Scan,
    /// 바닥 상태에서 끊긴 UTF-8 글자의 앞 바이트다. 글자가 다 모일 때까지 파서에 넣지 않는다
    /// (vte 0.15.0 이 이어 읽을 때 뒤 글자를 삼킨다 — `utf8_split_across_feeds_keeps_following_char`).
    carry: Vec<u8>,
    title: Title,
    replies: Replies,
    keep: usize,
    store: LineStore,
}

/// 에뮬레이터 기록 상한이다. ED2·CSI S 처럼 조각 나누기가 세지 않는 밀어 올림(화면 한 벌)까지 담는다.
fn emu_cap(keep: usize, rows: u16) -> usize {
    keep + 2 * SLACK + usize::from(rows)
}

impl Screen {
    /// `store_cap` 은 줄 저장소의 상한(논리 줄 수)이다. 크기 0 은 1 로 올린다.
    pub fn new(cols: u16, rows: u16, store_cap: usize) -> Self {
        Self::with_keep(cols, rows, EMU_KEEP, store_cap)
    }

    pub(crate) fn with_keep(cols: u16, rows: u16, keep: usize, store_cap: usize) -> Self {
        let cfg = Config {
            scrolling_history: emu_cap(keep, rows.max(1)),
            ..Config::default()
        };
        let title = Title::default();
        let replies = Replies::default();
        let quiet = Quiet {
            title: Arc::clone(&title),
            replies: Arc::clone(&replies),
        };
        Self {
            term: Term::new(cfg, &Size::new(cols, rows), quiet),
            parser: Processor::new(),
            scan: Scan::default(),
            carry: Vec::new(),
            title,
            replies,
            keep,
            store: LineStore::new(store_cap),
        }
    }

    pub fn feed(&mut self, bytes: &[u8]) {
        let cols = usize::from(self.size().0);
        for piece in split_for_rows(bytes, cols, SLACK) {
            self.feed_piece(piece);
            self.settle_history();
            if self.scan.take_reset() {
                // RIS 는 alacritty 의 제목을 지우지만 사건을 보내지 않는다. 설정을 다시 걸면 지금 제목을 보낸다.
                self.reload_options();
            }
        }
    }

    /// 지금까지 모인 질의의 답을 꺼낸다(D-23).
    pub fn take_replies(&mut self) -> Vec<u8> {
        std::mem::take(&mut *self.replies.lock().unwrap_or_else(|e| e.into_inner()))
    }

    fn reload_options(&mut self) {
        let cfg = Config {
            scrolling_history: emu_cap(self.keep, self.size().1),
            ..Config::default()
        };
        self.term.set_options(cfg);
    }

    /// 에뮬레이터 기록이 `keep` 을 넘으면 넘는 만큼 오래된 논리 줄을 저장소로 옮긴다.
    /// 걸친 논리 줄은 끝날 때까지 기다리고, `SLACK` 을 넘게 밀리면 끊어 옮긴다.
    fn settle_history(&mut self) {
        let alt = self.term.mode().contains(TermMode::ALT_SCREEN);
        if self.scan.take_history_cleared() && !alt {
            self.store.clear();
        }
        if alt {
            return;
        }
        let g = self.term.grid();
        let hl = g.history_size();
        let Some(excess) = hl.checked_sub(self.keep).filter(|e| *e > 0) else {
            return;
        };
        let rows: Vec<Row> = (0..hl)
            .take(excess)
            .map(|i| row_of(g, -i32::try_from(hl - i).unwrap_or(i32::MAX)))
            .collect();
        let (lines, moved) = hist::complete_lines(&rows, excess, excess > SLACK);
        for l in lines {
            self.store.push(l);
        }
        self.drop_oldest(moved);
    }

    fn feed_piece(&mut self, bytes: &[u8]) {
        let rows = self.size().1;
        self.scan.feed(bytes, rows);
        let hold = if self.scan.in_ground() {
            self.scan.pending().len()
        } else {
            0
        };
        if self.carry.is_empty() && hold == 0 {
            self.parser.advance(&mut self.term, bytes);
            return;
        }
        let mut buf = std::mem::take(&mut self.carry);
        buf.extend_from_slice(bytes);
        let cut = buf.len().saturating_sub(hold);
        self.parser.advance(&mut self.term, &buf[..cut]);
        self.carry = buf.split_off(cut);
    }

    /// 끝나지 않은 시퀀스·UTF-8 바이트다(시험용).
    #[cfg(test)]
    pub(crate) fn unfinished(&self) -> Vec<u8> {
        self.scan.pending().to_vec()
    }

    pub fn resize(&mut self, cols: u16, rows: u16) {
        self.term.resize(Size::new(cols, rows));
        self.scan.resized();
        self.reload_options();
    }

    /// 지금 화면을 다시 그리는 ANSI 다(화면 + 기록 `history` 줄, 대체 화면이면 가려진 주 화면도).
    /// 새 터미널에 `bytes` 를 넣고, 이어서 원래 출력을 지금까지 넣은 끝에서 `back` 바이트 앞부터
    /// 넣으면 이 화면에서 그대로 이어진다.
    pub fn snapshot(&mut self, history: usize) -> Snapshot {
        let st = self.state_from(history, true);
        Snapshot {
            bytes: snap::encode(&st),
            back: st.back,
            first_line: st.first_line,
        }
    }

    /// 데몬 교체로 넘길 화면 상태다. 에뮬레이터 기록은 모두 스냅숏에, 저장소는 그림으로 담는다.
    pub fn handover(&mut self) -> Handover {
        let st = self.state_from(usize::MAX, false);
        Handover {
            snapshot: snap::encode(&st),
            back: st.back,
            store: self.store.export(),
        }
    }

    /// [`handover`](Self::handover) 의 스냅숏과 저장소 그림으로 되세운다. 그림이 깨졌으면 저장소는 비운 채
    /// 시작한다(화면은 되세운다).
    pub fn restore(cols: u16, rows: u16, store_cap: usize, snapshot: &[u8], store: &[u8]) -> Self {
        Self::restore_with_keep(cols, rows, EMU_KEEP, store_cap, snapshot, store)
    }

    pub(crate) fn restore_with_keep(
        cols: u16,
        rows: u16,
        keep: usize,
        store_cap: usize,
        snapshot: &[u8],
        store: &[u8],
    ) -> Self {
        let mut s = Self::with_keep(cols, rows, keep, store_cap);
        s.feed(snapshot);
        // 스냅숏을 넣는 동안 `keep` 을 넘어 옮겨진 줄은 넘겨받은 저장소 뒤에 잇는다.
        let moved = s.store.lines(s.store.first(), s.store.len()).1;
        let mut st =
            LineStore::import(store_cap, store).unwrap_or_else(|| LineStore::new(store_cap));
        for l in moved {
            st.push(l);
        }
        s.store = st;
        s.take_replies();
        s
    }

    #[cfg(test)]
    pub(crate) fn state(&mut self, history: usize) -> State {
        self.state_from(history, true)
    }

    /// `from_store` 가 거짓이면 에뮬레이터 기록만 싣는다.
    fn state_from(&mut self, history: usize, from_store: bool) -> State {
        let back = self.scan.rewind();
        let (main, alt) = if self.term.mode().contains(TermMode::ALT_SCREEN) {
            let alt = grid_state(self.term.grid(), 0);
            // alacritty 는 가려진 주 화면을 내지 않는다. 화면을 바꿔 읽고 되돌린다.
            // 대체 화면에서 주 화면으로 가는 바꾸기는 격자만 바꾼다. 되돌아가는 바꾸기는 대체 화면을
            // 지우고(복사본을 되씌움) 주 화면의 저장 커서를 커서로 덮는다. 대체 화면에 들어갈 때
            // 저장 커서 = 커서이므로 보통은 바뀌는 것이 없다. 대체 화면 안에서 크기를 바꾸면 재흐름이
            // 커서만 옮겨 둘이 갈리고, 이때 저장 커서가 커서로 바뀐다. alacritty 는 1049l 에서 커서를
            // 되돌리지 않으므로(커서가 그대로) 나간 뒤 화면은 같다. 바뀐 저장 커서는 주 화면에서 DECRC 를
            // 쓸 때만 드러난다(`known_gap_main_saved_cursor_after_resize_in_alt`).
            let keep: Grid<ACell> = self.term.grid().clone();
            self.term.swap_alt();
            let mut main = grid_state(self.term.grid(), history);
            main.saved = main.cursor.clone();
            self.term.swap_alt();
            *self.term.grid_mut() = keep;
            (main, Some(alt))
        } else {
            (grid_state(self.term.grid(), history), None)
        };
        let want = if from_store {
            history.saturating_sub(main.history.len())
        } else {
            0
        };
        let (first_line, older) = hist::newest_rows(&self.store, want, usize::from(self.size().0));
        State {
            first_line,
            older,
            cols: self.size().0,
            main,
            alt,
            modes: self.modes(),
            cursor_style: decscusr(&self.term),
            title: self.title.lock().unwrap_or_else(|e| e.into_inner()).clone(),
            region: self.scan.region(),
            shift_out: self.scan.shift_out(),
            pending: if back == 0 {
                self.scan.pending().to_vec()
            } else {
                Vec::new()
            },
            back,
        }
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
        Some(row_of(g, line))
    }

    /// 가장 오래된 기록 `n` 줄을 지운다. 상한은 그대로다.
    fn drop_oldest(&mut self, n: usize) {
        let cap = emu_cap(self.keep, self.size().1);
        let g = self.term.grid_mut();
        let left = g.history_size().saturating_sub(n);
        g.update_history(left);
        g.update_history(cap);
    }

    /// 줄 저장소다(위로 받기 FR-TRM-5 가 읽는다).
    pub fn store(&self) -> &LineStore {
        &self.store
    }

    /// 줄 저장소 상한을 바꾼다(D-25 `termHistoryLines`). 줄이면 곧바로 버린다.
    pub fn set_store_cap(&mut self, cap: usize) {
        self.store.set_cap(cap);
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

fn grid_state(g: &Grid<ACell>, history: usize) -> GridState {
    let rows = i32::try_from(g.screen_lines()).unwrap_or(i32::MAX);
    let hist = i32::try_from(g.history_size().min(history)).unwrap_or(i32::MAX);
    GridState {
        history: (-hist..0).map(|l| row_of(g, l)).collect(),
        rows: (0..rows).map(|l| row_of(g, l)).collect(),
        cursor: cursor_state(&g.cursor),
        saved: cursor_state(&g.saved_cursor),
    }
}

fn row_of(g: &Grid<ACell>, line: i32) -> Row {
    let r = &g[Line(line)];
    let cols = g.columns();
    Row {
        cells: (0..cols).map(|x| cell(&r[Column(x)])).collect(),
        wrapped: r[Column(cols - 1)].flags.contains(Flags::WRAPLINE),
    }
}

fn cursor_state(c: &ACursor<ACell>) -> CursorState {
    let t = cell(&c.template);
    let idx = [
        CharsetIndex::G0,
        CharsetIndex::G1,
        CharsetIndex::G2,
        CharsetIndex::G3,
    ];
    CursorState {
        col: to_u16(c.point.column.0),
        row: u16::try_from(c.point.line.0).unwrap_or(0),
        pending_wrap: c.input_needs_wrap,
        pen: Pen {
            fg: t.fg,
            bg: t.bg,
            underline: t.underline,
            attrs: t.attrs,
            link: t.link,
        },
        line_drawing: idx.map(|i| c.charsets[i] == StandardCharset::SpecialCharacterAndLineDrawing),
    }
}

/// 기본 모양과 다르면 DECSCUSR 값이다.
fn decscusr(t: &Term<Quiet>) -> Option<u8> {
    let s = t.cursor_style();
    if s == Config::default().default_cursor_style {
        return None;
    }
    let steady = u8::from(!s.blinking);
    match s.shape {
        CursorShape::Block => Some(1 + steady),
        CursorShape::Underline => Some(3 + steady),
        CursorShape::Beam => Some(5 + steady),
        CursorShape::HollowBlock | CursorShape::Hidden => None,
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

const ATTRS: [(Flags, Attrs); 11] = [
    (Flags::BOLD, Attrs::BOLD),
    (Flags::DIM, Attrs::DIM),
    (Flags::ITALIC, Attrs::ITALIC),
    (Flags::UNDERLINE, Attrs::UNDERLINE),
    (Flags::DOUBLE_UNDERLINE, Attrs::DOUBLE_UNDERLINE),
    (Flags::UNDERCURL, Attrs::UNDERCURL),
    (Flags::DOTTED_UNDERLINE, Attrs::DOTTED_UNDERLINE),
    (Flags::DASHED_UNDERLINE, Attrs::DASHED_UNDERLINE),
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
        underline: c.underline_color().map_or(Color::Default, color),
        link: c.hyperlink().map(|h| Link {
            id: h.id().to_string(),
            uri: h.uri().to_string(),
        }),
    }
}
