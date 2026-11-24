use std::path::PathBuf;

use serde::Deserialize;

use super::*;

/// 비교 시험의 줄 저장소 상한이다.
const HISTORY: usize = 1_000;
/// OSC 8 링크 칸의 밑줄은 xterm.js 만 칠한다. 2.4 직렬화기가 OSC 8 을 다시 내보내면 0 이 된다.
const VECTORS_LINK_UNDERLINE: usize = 4;

#[derive(Deserialize)]
struct Case {
    name: String,
    input: String,
    cols: u16,
    rows: u16,
    resize: Option<(u16, u16)>,
    after: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RefModes {
    app_cursor: bool,
    app_keypad: bool,
    bracketed_paste: bool,
    insert: bool,
    mouse: String,
    origin: bool,
    focus: bool,
    autowrap: bool,
}

#[derive(Deserialize)]
struct RefRow {
    t: Vec<String>,
    s: Vec<(usize, u8, String, String, String)>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Ref {
    cols: u16,
    rows: u16,
    alt: bool,
    cursor: (u16, u16),
    cursor_visible: bool,
    modes: RefModes,
    rows_data: Vec<RefRow>,
    wrapped: Vec<bool>,
    hist: Vec<String>,
}

type FlatCell = (String, u8, String, String, String);

fn testdata() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("testdata")
}

fn case(name: &str) -> Case {
    let all: Vec<Case> =
        serde_json::from_slice(&std::fs::read(testdata().join("cases.json")).unwrap()).unwrap();
    all.into_iter().find(|c| c.name == name).unwrap()
}

fn corpus(file: &str) -> Vec<u8> {
    std::fs::read(testdata().join("corpus").join(file)).unwrap()
}

fn color(c: Color) -> String {
    match c {
        Color::Default => "d".into(),
        Color::Indexed(i) => format!("p{i}"),
        Color::Rgb(r, g, b) => format!("#{r:02x}{g:02x}{b:02x}"),
    }
}

fn attrs(a: Attrs) -> String {
    [
        (Attrs::BOLD, 'b'),
        (Attrs::ITALIC, 'i'),
        (Attrs::ANY_UNDERLINE, 'u'),
        (Attrs::INVERSE, 'r'),
        (Attrs::DIM, 'd'),
        (Attrs::STRIKE, 's'),
        (Attrs::HIDDEN, 'h'),
    ]
    .into_iter()
    .filter(|(f, _)| a.intersects(*f))
    .map(|(_, c)| c)
    .collect()
}

fn flat(c: &Cell) -> FlatCell {
    (
        c.text.clone(),
        c.width,
        color(c.fg),
        color(c.bg),
        attrs(c.attrs),
    )
}

fn unpack(r: &RefRow) -> Vec<FlatCell> {
    let mut styles =
        r.s.iter()
            .flat_map(|(n, w, fg, bg, f)| std::iter::repeat_n((*w, fg, bg, f), *n));
    r.t.iter()
        .map(|t| {
            let (w, fg, bg, f) = styles.next().unwrap();
            (t.clone(), w, fg.clone(), bg.clone(), f.clone())
        })
        .collect()
}

fn mouse_name(m: MouseMode) -> &'static str {
    match m {
        MouseMode::None => "none",
        MouseMode::Click => "vt200",
        MouseMode::Drag => "drag",
        MouseMode::Motion => "any",
    }
}

fn row_text(r: &Row) -> String {
    let s: String = r
        .cells
        .iter()
        .filter(|c| c.width != 0)
        .map(|c| c.text.as_str())
        .collect();
    s.trim_end().to_string()
}

fn run(cs: &Case) -> Screen {
    let mut s = Screen::new(cs.cols, cs.rows, HISTORY);
    s.feed(&corpus(&cs.input));
    if let Some((c, r)) = cs.resize {
        s.resize(c, r);
    }
    if let Some(a) = &cs.after {
        s.feed(&corpus(a));
    }
    s
}

/// xterm 기준과 다른 곳을 모두 적는다. OSC 8 링크 칸의 밑줄만 다른 셀은 따로 센다.
fn compare(name: &str) -> (Vec<String>, usize) {
    let cs = case(name);
    let want: Ref = serde_json::from_slice(
        &std::fs::read(testdata().join("ref").join(format!("{name}.json"))).unwrap(),
    )
    .unwrap();
    let s = run(&cs);
    let mut diffs = Vec::new();
    let mut link_underline = 0;
    if s.size() != (want.cols, want.rows) {
        diffs.push(format!(
            "size {:?} != {:?}",
            s.size(),
            (want.cols, want.rows)
        ));
    }
    for (y, wr) in want.rows_data.iter().enumerate() {
        let line = i32::try_from(y).unwrap();
        let Some(row) = s.row(line) else {
            diffs.push(format!("row {y} 없음"));
            continue;
        };
        if row.wrapped != want.wrapped[y] {
            diffs.push(format!(
                "row {y} wrapped {} != {}",
                row.wrapped, want.wrapped[y]
            ));
        }
        for (x, (got, exp)) in row.cells.iter().zip(unpack(wr)).enumerate() {
            let g = flat(got);
            let leading_spacer = got.width == 0
                && row.wrapped
                && x + 1 == usize::from(want.cols)
                && (exp.0.as_str(), exp.1) == (" ", 1);
            if g == exp || leading_spacer {
                continue;
            }
            let only_underline = got.link.is_some()
                && exp.4.contains('u')
                && (g.0.as_str(), g.1, g.2.as_str(), g.3.as_str())
                    == (exp.0.as_str(), exp.1, exp.2.as_str(), exp.3.as_str())
                && g.4 == exp.4.replace('u', "");
            if only_underline {
                link_underline += 1;
            } else {
                diffs.push(format!("cell ({x},{y}) {g:?} != {exp:?}"));
            }
        }
        if row.cells.len() != usize::from(want.cols) {
            diffs.push(format!("row {y} 폭 {}", row.cells.len()));
        }
    }
    let cur = s.cursor();
    if (cur.col, cur.row) != want.cursor {
        diffs.push(format!(
            "cursor {:?} != {:?}",
            (cur.col, cur.row),
            want.cursor
        ));
    }
    if cur.visible != want.cursor_visible {
        diffs.push(format!("cursor visible {}", cur.visible));
    }
    let m = s.modes();
    let got_modes = (
        m.alt_screen,
        m.show_cursor,
        m.app_cursor,
        m.app_keypad,
        m.bracketed_paste,
        m.insert,
        mouse_name(m.mouse),
        m.origin,
        m.focus_report,
        m.autowrap,
    );
    let w = &want.modes;
    let want_modes = (
        want.alt,
        want.cursor_visible,
        w.app_cursor,
        w.app_keypad,
        w.bracketed_paste,
        w.insert,
        w.mouse.as_str(),
        w.origin,
        w.focus,
        w.autowrap,
    );
    if got_modes != want_modes {
        diffs.push(format!("modes {got_modes:?} != {want_modes:?}"));
    }
    if !want.alt {
        let n = want.hist.len().min(s.history_len());
        let hist: Vec<String> = (1..=n)
            .rev()
            .map(|k| row_text(&s.row(-i32::try_from(k).unwrap()).unwrap()))
            .collect();
        // xterm 은 직접 쓴 끝 공백을 남긴다. 글자만 견준다.
        let tail: Vec<String> = want.hist[want.hist.len() - n..]
            .iter()
            .map(|h| h.trim_end().to_string())
            .collect();
        if n != want.hist.len() || hist != tail {
            diffs.push(format!("hist {hist:?} != {tail:?}"));
        }
    }
    (diffs, link_underline)
}

fn assert_same(name: &str) {
    let (d, link) = compare(name);
    assert!(
        d.is_empty(),
        "{name}: xterm 과 다르다 ({}건)\n{}",
        d.len(),
        d.join("\n")
    );
    assert_eq!(link, 0, "{name}: 링크 밑줄 차이");
}

// ── xterm 비교 (FR-TRM-1, A-1) ──

#[test]
fn boundary_vectors_match_xterm_except_link_underline() {
    let (d, link) = compare("vectors");
    assert!(d.is_empty(), "vectors: {}", d.join("\n"));
    assert_eq!(link, VECTORS_LINK_UNDERLINE);
}

#[test]
fn unicode_widths_match_xterm() {
    assert_same("unicode");
}

/// Unicode 12 이후 이모지(🥲🫀🫠🫡🫨🩷)는 unicode-width 0.2 가 폭 2, xterm unicode11 이 폭 1 로 본다.
/// 글자 하나에 셀 다섯(글자·뒤칸·뒤 글자 밀림)이 어긋난다. 맞출지는 사용자 판단으로 남겼다(이슈 2.2 진행 기록).
#[test]
fn newer_emoji_width_differs_from_xterm_unicode11() {
    let (d, link) = compare("emoji-new");
    assert_eq!(link, 0);
    assert_eq!(d.len(), 15, "{}", d.join("\n"));
    assert!(
        d.iter().all(|l| l.starts_with("cell (")),
        "{}",
        d.join("\n")
    );
}

#[test]
fn vim_matches_xterm() {
    assert_same("vim");
    assert_same("vim-live");
}

#[test]
fn less_matches_xterm() {
    assert_same("less");
    assert_same("less-live");
}

#[test]
fn top_matches_xterm() {
    assert_same("top");
    assert_same("top-live");
}

#[test]
fn agent_sim_matches_xterm_with_history() {
    assert_same("sim-line");
    assert_same("sim-tui");
}

#[test]
fn alt_screen_round_trip_matches_xterm() {
    assert_same("alt-roundtrip");
}

#[test]
fn scroll_region_matches_xterm() {
    assert_same("decstbm");
}

#[test]
fn resize_reflow_matches_xterm() {
    assert_same("resize-wrap-grow");
    assert_same("resize-wrap-shrink");
    assert_same("resize-sim-line");
}

#[test]
fn resize_in_alt_screen_matches_xterm() {
    assert_same("resize-vim-live");
}

#[test]
fn output_after_resize_matches_xterm() {
    assert_same("resize-then-feed");
}

// ── 표면 ──

fn lines(n: usize) -> Vec<u8> {
    (0..n)
        .flat_map(|i| format!("L{i:02}\r\n").into_bytes())
        .collect()
}

fn text_at(s: &Screen, line: i32) -> String {
    row_text(&s.row(line).unwrap())
}

fn store_texts(s: &Screen) -> Vec<String> {
    let st = s.store();
    st.lines(st.first(), st.len())
        .1
        .iter()
        .map(|l| l.text().trim_end().to_string())
        .collect()
}

#[test]
fn history_over_keep_moves_to_store() {
    let mut s = Screen::with_keep(10, 5, 20, 1_000);
    s.feed(&lines(100));
    assert_eq!(s.history_len(), 20);
    assert_eq!(text_at(&s, -1), "L95");
    assert_eq!(text_at(&s, -20), "L76");
    assert_eq!(text_at(&s, 0), "L96");
    let want: Vec<String> = (0..76).map(|i| format!("L{i:02}")).collect();
    assert_eq!(store_texts(&s), want);
    assert_eq!((s.store().first(), s.store().end()), (0, 76));
}

#[test]
fn wrapped_line_moves_whole() {
    let mut s = Screen::with_keep(10, 3, 2, 1_000);
    let long = "a".repeat(25);
    s.feed(format!("{long}\r\nx\r\ny\r\nz\r\nw\r\nv\r\n").as_bytes());
    let texts = store_texts(&s);
    assert_eq!(texts.first().map(String::as_str), Some(long.as_str()));
    assert_eq!(&texts[1..], ["x"]);
}

#[test]
fn erase_saved_lines_clears_store_and_numbers_go_on() {
    let mut s = Screen::with_keep(10, 5, 20, 1_000);
    s.feed(&lines(100));
    s.feed(b"\x1b[3J");
    assert!(s.store().is_empty());
    assert_eq!(s.history_len(), 0);
    assert_eq!((s.store().first(), s.store().end()), (76, 76));
    s.feed(&lines(30));
    assert_eq!(s.store().first(), 76);
}

/// 64 KB 청크 하나로 수천 줄을 밀어도 줄을 잃지 않는다(2.3 에서 넘어온 연결 시험).
#[test]
fn burst_chunk_loses_no_lines() {
    let n = 6_000;
    let data: Vec<u8> = (0..n)
        .flat_map(|i| format!("line {i:05}\r\n").into_bytes())
        .collect();
    assert!(data.len() > 64 << 10);
    let mut s = Screen::new(80, 24, HISTORY_CAP);
    s.feed(&data);
    let hl = i32::try_from(s.history_len()).unwrap();
    let mut all = store_texts(&s);
    all.extend((-hl..24).map(|l| text_at(&s, l)).filter(|t| !t.is_empty()));
    let want: Vec<String> = (0..n).map(|i| format!("line {i:05}")).collect();
    assert_eq!(all, want);
}

#[test]
fn row_outside_screen_and_history_is_none() {
    let mut s = Screen::new(10, 5, 1_000);
    s.feed(&lines(7));
    let hl = i32::try_from(s.history_len()).unwrap();
    assert!(s.row(4).is_some());
    assert!(s.row(5).is_none());
    assert!(s.row(-hl).is_some());
    assert!(s.row(-hl - 1).is_none());
}

#[test]
fn wrapped_marks_rows_continued_by_autowrap() {
    let mut s = Screen::new(10, 5, 1_000);
    s.feed(b"abcdefghijKLM\r\nx");
    assert!(s.row(0).unwrap().wrapped);
    assert!(!s.row(1).unwrap().wrapped);
    assert_eq!(text_at(&s, 1), "KLM");
}

#[test]
fn wide_char_has_spacer_cell() {
    let mut s = Screen::new(10, 2, 1_000);
    s.feed("한a".as_bytes());
    let r = s.row(0).unwrap();
    assert_eq!((r.cells[0].text.as_str(), r.cells[0].width), ("한", 2));
    assert_eq!((r.cells[1].text.as_str(), r.cells[1].width), (" ", 0));
    assert_eq!((r.cells[2].text.as_str(), r.cells[2].width), ("a", 1));
}

#[test]
fn wide_char_pushed_to_next_row_leaves_dropped_cell() {
    let mut s = Screen::new(5, 2, 1_000);
    s.feed("abcd한".as_bytes());
    let r = s.row(0).unwrap();
    assert!(r.wrapped);
    assert_eq!((r.cells[4].text.as_str(), r.cells[4].width), (" ", 0));
    assert_eq!(text_at(&s, 0), "abcd");
    assert_eq!(text_at(&s, 1), "한");
}

#[test]
fn osc8_link_is_on_cells() {
    let mut s = Screen::new(20, 2, 1_000);
    s.feed(b"\x1b]8;id=k;https://ex.io\x1b\\go\x1b]8;;\x1b\\!");
    let r = s.row(0).unwrap();
    let want = Some(Link {
        id: "k".into(),
        uri: "https://ex.io".into(),
    });
    assert_eq!(r.cells[0].link, want);
    assert_eq!(r.cells[1].link, want);
    assert_eq!(r.cells[2].link, None);
}

#[test]
fn colors_and_attrs_are_read() {
    let mut s = Screen::new(10, 2, 1_000);
    s.feed(b"\x1b[1;3;31;48;5;200ma\x1b[0;38;2;1;2;3;9mb");
    let r = s.row(0).unwrap();
    let a = &r.cells[0];
    assert_eq!((a.fg, a.bg), (Color::Indexed(1), Color::Indexed(200)));
    assert!(a.attrs.contains(Attrs::BOLD.with(Attrs::ITALIC)));
    let b = &r.cells[1];
    assert_eq!((b.fg, b.bg), (Color::Rgb(1, 2, 3), Color::Default));
    assert_eq!(attrs(b.attrs), "s");
}

#[test]
fn resize_changes_size() {
    let mut s = Screen::new(80, 24, 1_000);
    s.resize(100, 30);
    assert_eq!(s.size(), (100, 30));
    assert_eq!(s.row(29).unwrap().cells.len(), 100);
}

#[test]
fn zero_size_is_clamped_to_one_cell() {
    let mut s = Screen::new(0, 0, 1_000);
    s.feed(b"x");
    assert_eq!(s.size(), (1, 1));
    s.resize(0, 5);
    assert_eq!(s.size(), (1, 5));
}

#[test]
fn queries_leave_screen_unchanged() {
    let mut s = Screen::new(10, 2, 1_000);
    s.feed(b"ab\x1b[c\x1b[>c\x1b[5n\x1b[6n\x1b]11;?\x07\x1b[18t");
    assert_eq!(text_at(&s, 0), "ab");
    let c = s.cursor();
    assert_eq!((c.col, c.row), (2, 0));
}

/// vte 0.15.0 은 앞 조각에서 끊긴 UTF-8 글자를 마저 읽을 때 뒤따르는 글자 하나를 삼킨다
/// (`advance_partial_utf8` 가 `valid_bytes - old_bytes` 만큼 건너뜀). PTY 읽기는 글자 한가운데서 끊긴다.
#[test]
fn utf8_split_across_feeds_keeps_following_char() {
    let mut s = Screen::new(10, 2, 1_000);
    s.feed(b"e\xcc");
    s.feed(b"\x81a\xcc");
    s.feed(b"\x8a|\xed");
    s.feed(b"\x95");
    s.feed(b"\x9cz");
    assert_eq!(text_at(&s, 0), "e\u{301}a\u{30a}|한z");
}

#[test]
fn synchronized_update_does_not_hold_bytes() {
    let mut s = Screen::new(10, 2, 1_000);
    s.feed(b"\x1b[?2026hab");
    assert_eq!(text_at(&s, 0), "ab");
}

#[test]
fn modes_follow_output() {
    let mut s = Screen::new(10, 2, 1_000);
    s.feed(b"\x1b[?1h\x1b=\x1b[?2004h\x1b[?1004h\x1b[?1002h\x1b[?1006h\x1b[?25l\x1b[4h");
    let m = s.modes();
    assert!(m.app_cursor && m.app_keypad && m.bracketed_paste && m.focus_report);
    assert!(m.sgr_mouse && m.insert && !m.show_cursor && m.autowrap);
    assert_eq!(m.mouse, MouseMode::Drag);
    s.feed(b"\x1b[?1003h");
    assert_eq!(s.modes().mouse, MouseMode::Motion);
}

#[test]
fn screen_is_send() {
    fn send<T: Send>() {}
    send::<Screen>();
}
