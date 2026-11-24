use serde_json::Value;

use super::*;

pub(crate) fn rich_line(seed: u32) -> Line {
    let link = Link {
        id: format!("k{seed}"),
        uri: format!("https://example.com/{seed}"),
    };
    let red = Style {
        fg: Color::Indexed(1),
        ..Style::default()
    };
    let fancy = Style {
        fg: Color::Rgb(1, 2, 3),
        bg: Color::Indexed(200),
        underline: Color::Rgb(9, 8, 7),
        flags: flags::BOLD | flags::UNDERCURL | flags::STRIKEOUT,
    };
    let mut b = LineBuilder::new();
    for ch in format!("line {seed} ").chars() {
        b.push(&ch.to_string(), 1, Style::default(), None);
    }
    b.push("한", 2, red, None);
    b.push("e\u{301}", 1, red, None);
    b.push(" ", 1, fancy, None);
    for ch in "link".chars() {
        b.push(&ch.to_string(), 1, fancy, Some(&link));
    }
    b.push("漢", 2, Style::default(), Some(&link));
    b.push("x", 1, Style::default(), None);
    b.finish()
}

#[test]
fn cells_return_what_was_pushed() {
    let l = rich_line(7);
    let cells: Vec<Cell<'_>> = l.cells().collect();
    assert_eq!(cells.len(), l.len());
    assert_eq!(cells.len(), "line 7 ".len() + 3 + 4 + 2);
    assert_eq!(cells[7].text, "한");
    assert_eq!(cells[7].width, 2);
    assert_eq!(cells[7].style.fg, Color::Indexed(1));
    assert_eq!(cells[8].text, "e\u{301}");
    assert_eq!(cells[8].width, 1);
    assert_eq!(
        cells[10].style.flags,
        flags::BOLD | flags::UNDERCURL | flags::STRIKEOUT
    );
    assert_eq!(
        cells[10].link.map(|k| k.uri.as_str()),
        Some("https://example.com/7")
    );
    assert_eq!(cells[14].text, "漢");
    assert_eq!(cells[14].style, Style::default());
    assert!(cells[14].link.is_some());
    assert!(cells[15].link.is_none());
    assert_eq!(cells[15].text, "x");
    assert_eq!(l.columns(), l.len() + 2);
    assert_eq!(l.links.len(), 1, "같은 링크가 이어지면 구간 하나");
}

#[test]
fn trailing_default_blanks_are_dropped_but_styled_blanks_stay() {
    let mut b = LineBuilder::new();
    b.push("a", 1, Style::default(), None);
    b.push(" ", 1, Style::default(), None);
    let bg = Style {
        bg: Color::Indexed(2),
        ..Style::default()
    };
    b.push(" ", 1, bg, None);
    for _ in 0..77 {
        b.push(" ", 1, Style::default(), None);
    }
    let l = b.finish();
    assert_eq!(l.len(), 3);
    assert_eq!(l.text(), "a  ");
    assert_eq!(l.styles, vec![(2, bg)]);

    let mut b = LineBuilder::new();
    for _ in 0..80 {
        b.push("", 1, Style::default(), None);
    }
    assert_eq!(b.finish(), Line::default());
}

#[test]
fn trimming_drops_style_runs_that_start_in_the_tail() {
    let mut b = LineBuilder::new();
    b.push("a", 1, Style::default(), None);
    let bold = Style {
        flags: flags::BOLD,
        ..Style::default()
    };
    b.push("b", 1, bold, None);
    b.push(" ", 1, Style::default(), None);
    let l = b.finish();
    assert_eq!(l.styles, vec![(1, bold)]);
}

#[test]
fn ansi_writes_styles_and_links_and_closes_them() {
    let l = rich_line(1);
    let a = l.to_ansi();
    assert!(a.starts_with("line 1 \x1b[0;31m한e\u{301}"), "{a:?}");
    assert!(
        a.contains("\x1b[0;1;4:3;9;38;2;1;2;3;48;5;200;58;2;9;8;7m "),
        "{a:?}"
    );
    assert!(
        a.contains("\x1b]8;id=k1;https://example.com/1\x1b\\"),
        "{a:?}"
    );
    assert!(a.contains("\x1b]8;;\x1b\\x"), "링크를 닫고 x: {a:?}");
    assert!(
        !a.ends_with("\x1b[0m"),
        "끝 셀이 기본 속성이면 닫을 것이 없다: {a:?}"
    );

    let mut b = LineBuilder::new();
    let link = Link {
        id: String::new(),
        uri: "u".into(),
    };
    b.push(
        "z",
        1,
        Style {
            fg: Color::Indexed(9),
            ..Style::default()
        },
        Some(&link),
    );
    assert_eq!(
        b.finish().to_ansi(),
        "\x1b]8;;u\x1b\\\x1b[0;91mz\x1b]8;;\x1b\\\x1b[0m"
    );
}

#[test]
fn wrap_of_empty_line_is_one_empty_row() {
    assert_eq!(Line::default().wrap(10), vec![Line::default()]);
}

#[test]
fn wrap_keeps_cells_and_their_attributes() {
    let l = rich_line(3);
    let rows = l.wrap(5);
    let back: Vec<(String, u8, Style, Option<Link>)> = rows
        .iter()
        .flat_map(|r| {
            r.cells()
                .map(|c| (c.text.to_owned(), c.width, c.style, c.link.cloned()))
        })
        .collect();
    let orig: Vec<(String, u8, Style, Option<Link>)> = l
        .cells()
        .map(|c| (c.text.to_owned(), c.width, c.style, c.link.cloned()))
        .collect();
    // 행 끝의 기본 빈칸은 행마다 잘린다. 비교는 빈칸을 뺀 셀로.
    let strip = |v: Vec<(String, u8, Style, Option<Link>)>| {
        v.into_iter()
            .filter(|c| !(c.0 == " " && c.2 == Style::default() && c.3.is_none()))
            .collect::<Vec<_>>()
    };
    assert_eq!(strip(back), strip(orig));
    assert!(rows.iter().all(|r| r.columns() <= 5));
}

// ── xterm.js 재흐름 기준 (testdata/reflow.json, gen-reflow.mjs) ──

fn wide(c: char) -> bool {
    matches!(c as u32, 0x1100..=0x115f | 0x2e80..=0xa4cf | 0xac00..=0xd7a3 | 0xf900..=0xfaff | 0xff00..=0xff60)
}

fn combining(c: char) -> bool {
    matches!(c as u32, 0x0300..=0x036f)
}

fn color_of(v: &Value) -> Color {
    match v {
        Value::Number(n) => Color::Indexed(n.as_u64().unwrap_or(0) as u8),
        Value::String(s) => {
            let n = u32::from_str_radix(&s[1..], 16).unwrap_or(0);
            Color::Rgb((n >> 16) as u8, (n >> 8) as u8, n as u8)
        }
        _ => Color::Default,
    }
}

fn build(segs: &Value) -> Line {
    let mut b = LineBuilder::new();
    for seg in segs.as_array().into_iter().flatten() {
        let mut style = Style {
            fg: color_of(&seg["fg"]),
            bg: color_of(&seg["bg"]),
            ..Style::default()
        };
        for f in seg["f"].as_str().unwrap_or("").chars() {
            style.flags |= match f {
                'b' => flags::BOLD,
                'd' => flags::DIM,
                'i' => flags::ITALIC,
                'u' => flags::UNDERLINE,
                'r' => flags::INVERSE,
                'h' => flags::HIDDEN,
                's' => flags::STRIKEOUT,
                _ => 0,
            };
        }
        let link = seg["link"].as_str().map(|u| Link {
            id: String::new(),
            uri: u.to_owned(),
        });
        let chars: Vec<char> = seg["t"].as_str().unwrap_or("").chars().collect();
        let mut i = 0;
        while i < chars.len() {
            let mut cell = chars[i].to_string();
            let w = if wide(chars[i]) { 2 } else { 1 };
            i += 1;
            while i < chars.len() && combining(chars[i]) {
                cell.push(chars[i]);
                i += 1;
            }
            b.push(&cell, w, style, link.as_ref());
        }
    }
    b.finish()
}

fn xterm_color(c: Color) -> String {
    match c {
        Color::Default => "d".into(),
        Color::Indexed(n) => format!("p{n}"),
        Color::Rgb(r, g, b) => format!("#{r:02x}{g:02x}{b:02x}"),
    }
}

fn xterm_cell(text: &str, width: u8, s: Style, linked: bool) -> Value {
    let mut f = String::new();
    let underline = s.flags & flags::ANY_UNDERLINE != 0 || linked;
    for (on, ch) in [
        (s.flags & flags::BOLD != 0, 'b'),
        (s.flags & flags::ITALIC != 0, 'i'),
        (underline, 'u'),
        (s.flags & flags::INVERSE != 0, 'r'),
        (s.flags & flags::DIM != 0, 'd'),
        (s.flags & flags::STRIKEOUT != 0, 's'),
        (s.flags & flags::HIDDEN != 0, 'h'),
    ] {
        if on {
            f.push(ch);
        }
    }
    serde_json::json!([text, width, xterm_color(s.fg), xterm_color(s.bg), f])
}

/// xterm 의 행 꼴로 편다: 넓은 글자 뒤에 폭 0 칸, 남는 칸은 기본 빈칸.
fn as_xterm_row(row: &Line, cols: usize) -> Vec<Value> {
    let mut out = Vec::new();
    for c in row.cells() {
        out.push(xterm_cell(c.text, c.width, c.style, c.link.is_some()));
        if c.width == 2 {
            out.push(xterm_cell(" ", 0, c.style, c.link.is_some()));
        }
    }
    while out.len() < cols {
        out.push(xterm_cell(" ", 1, Style::default(), false));
    }
    out
}

#[test]
fn wrap_matches_xterm_reflow() {
    let fixture: Value =
        serde_json::from_str(include_str!("../testdata/reflow.json")).unwrap_or(Value::Null);
    let cases = fixture["cases"].as_array().cloned().unwrap_or_default();
    assert!(cases.len() >= 10, "기준 자료가 비었다");
    for case in cases {
        let name = case["name"].as_str().unwrap_or("");
        let to = case["to"].as_u64().unwrap_or(0) as usize;
        let want = case["rows"].as_array().cloned().unwrap_or_default();
        let lines = case["lines"].as_array().cloned().unwrap_or_default();
        assert_eq!(want.len(), lines.len(), "{name}");
        for (i, (segs, want)) in lines.iter().zip(want).enumerate() {
            let got: Vec<Value> = build(segs)
                .wrap(to)
                .iter()
                .map(|r| Value::Array(as_xterm_row(r, to)))
                .collect();
            assert_eq!(Value::Array(got), want, "{name} 줄 {i}");
        }
    }
}
