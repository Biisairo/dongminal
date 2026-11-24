//! 스냅숏 시험 (FR-TRM-4, A-2). 오라클: 새 에뮬레이터에 `스냅숏(k)` 을 넣은 상태 = 바이트[..k] 를 넣은 상태,
//! 그리고 둘 다 바이트[k..] 를 더 넣은 뒤의 상태가 같다. xterm.js 쪽 확인은 `testdata/check-snap.mjs`.

use std::path::PathBuf;

use super::*;
use crate::snap::State;

/// 줄 저장소 상한이자 스냅숏에 싣는 기록 행 수다. 시험에서는 모두 싣는다.
const HIST: usize = 1_000_000;

fn corpus(file: &str) -> Vec<u8> {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("testdata")
        .join("corpus")
        .join(file);
    std::fs::read(p).unwrap()
}

/// 이름 없는 OSC 8 링크는 alacritty 가 전역 번호로 id 를 붙인다. 시험의 두 에뮬레이터는 번호가 달라 지운다.
fn norm(mut s: State) -> State {
    let fix = |l: &mut Option<Link>| {
        if let Some(l) = l
            && l.id.ends_with("_alacritty")
        {
            l.id.clear();
        }
    };
    // 에뮬레이터 기록과 저장소의 경계는 두 쪽이 다를 수 있다. 기록 전체를 논리 줄로 펴서 견준다.
    let rows = std::mem::take(&mut s.main.history);
    let (tail, _) = crate::hist::complete_lines(&rows, rows.len(), true);
    s.older.extend(tail);
    s.older = s
        .older
        .iter()
        .map(|l| {
            let mut b = otter_shared_linestore::LineBuilder::new();
            for c in l.cells() {
                let link = c.link.map(|k| otter_shared_linestore::Link {
                    id: if k.id.ends_with("_alacritty") {
                        String::new()
                    } else {
                        k.id.clone()
                    },
                    uri: k.uri.clone(),
                });
                b.push(c.text, c.width, c.style, link.as_ref());
            }
            b.finish()
        })
        .collect();
    let grids = std::iter::once(&mut s.main).chain(s.alt.as_mut());
    for g in grids {
        for r in g.history.iter_mut().chain(g.rows.iter_mut()) {
            for c in &mut r.cells {
                fix(&mut c.link);
            }
        }
        fix(&mut g.cursor.pen.link);
        fix(&mut g.saved.pen.link);
    }
    s
}

fn first_diff(a: &State, b: &State) -> String {
    if a.older != b.older {
        let i = a.older.iter().zip(&b.older).position(|(x, y)| x != y);
        return format!(
            "기록 줄 수 {} != {}, 처음 다른 줄 {i:?}: {:?} != {:?}",
            a.older.len(),
            b.older.len(),
            i.and_then(|i| a.older.get(i)).map(|l| l.text()),
            i.and_then(|i| b.older.get(i)).map(|l| l.text()),
        );
    }
    let empty = crate::snap::GridState::default();
    let pairs = [
        ("main", &a.main, &b.main),
        (
            "alt",
            a.alt.as_ref().unwrap_or(&empty),
            b.alt.as_ref().unwrap_or(&empty),
        ),
    ];
    for (name, x, y) in pairs {
        if x.history.len() != y.history.len() {
            return format!(
                "{name} 기록 줄 수 {} != {}",
                x.history.len(),
                y.history.len()
            );
        }
        for (i, (p, q)) in x.history.iter().zip(&y.history).enumerate() {
            if p != q {
                return format!("{name} 기록 {i}: {p:?}\n!= {q:?}");
            }
        }
        for (i, (p, q)) in x.rows.iter().zip(&y.rows).enumerate() {
            if p.wrapped != q.wrapped {
                return format!("{name} 행 {i} wrapped {} != {}", p.wrapped, q.wrapped);
            }
            for (j, (c, d)) in p.cells.iter().zip(&q.cells).enumerate() {
                if c != d {
                    return format!("{name} 행 {i} 칸 {j}: {c:?}\n!= {d:?}");
                }
            }
        }
        if x.cursor != y.cursor {
            return format!("{name} 커서 {:?} != {:?}", x.cursor, y.cursor);
        }
        if x.saved != y.saved {
            return format!("{name} 저장 커서 {:?} != {:?}", x.saved, y.saved);
        }
    }
    if a.alt != b.alt {
        return format!("대체 화면 {:?}\n!= {:?}", a.alt, b.alt);
    }
    let rest = |s: &State| {
        format!(
            "{:?} {:?} {:?} {:?} {} {:?}",
            s.modes, s.cursor_style, s.title, s.region, s.shift_out, s.pending
        )
    };
    format!("{}\n!= {}", rest(a), rest(b))
}

/// 나머지 바이트까지 넣어 보는 분할점 간격이다. 시퀀스 한가운데인 분할점은 모두 넣어 본다.
const REST_EVERY: usize = 16;
/// 이보다 긴 자료는 바닥 상태 분할점을 이 간격으로만 본다(시퀀스 한가운데는 모두 본다).
const DENSE_MAX: usize = 2_048;
const SPARSE_EVERY: usize = 7;

/// 바이트[..k] 의 스냅숏으로 이어 받은 쪽이 원본과 같은 상태인가. 분할점은 오름차순이어야 한다.
/// 원본은 한 벌을 앞으로만 먹인다. 원본 + 바이트[k..] 는 늘 전체를 먹인 상태(`full`)와 같다.
fn check_points(data: &[u8], size: (u16, u16), ks: impl Iterator<Item = usize>) {
    check_points_keep(data, size, EMU_KEEP, ks);
}

fn check_points_keep(
    data: &[u8],
    (cols, rows): (u16, u16),
    keep: usize,
    ks: impl Iterator<Item = usize>,
) {
    check_points_from(
        &|| Screen::with_keep(cols, rows, keep, HIST),
        keep,
        data,
        ks,
    );
}

/// `setup` 이 만든 화면(크기를 바꾼 뒤 등)에서 시작해 `data` 를 나눠 넣는다.
fn check_points_from(
    setup: &dyn Fn() -> Screen,
    keep: usize,
    data: &[u8],
    ks: impl Iterator<Item = usize>,
) {
    let mut whole = setup();
    whole.feed(data);
    let full = norm(whole.state(HIST));
    let mut a = setup();
    let mut fed = 0;
    let mut errs = Vec::new();
    let sparse = data.len() > DENSE_MAX;
    for k in ks {
        a.feed(&data[fed..k]);
        fed = k;
        if sparse && k % SPARSE_EVERY != 0 && a.unfinished().is_empty() && k != data.len() {
            continue;
        }
        let snap = a.snapshot(HIST);
        let (cols, rows) = a.size();
        let mut b = Screen::with_keep(cols, rows, keep, HIST);
        b.feed(&snap.bytes);
        let mid = !a.unfinished().is_empty();
        // 원본이 물렸으면 받는 쪽은 끝나지 않은 바이트가 없어야 하고, 붙였으면 같은 바이트를 들고 있어야 한다.
        let mut sa = norm(a.state(HIST));
        sa.pending = if sa.back > 0 {
            Vec::new()
        } else {
            a.unfinished()
        };
        sa.back = 0;
        let mut sb = norm(b.state(HIST));
        sb.pending = b.unfinished();
        sb.back = 0;
        if sa != sb {
            errs.push(format!("k={k} 스냅숏 직후: {}", first_diff(&sa, &sb)));
            continue;
        }
        if k % REST_EVERY != 0 && !mid && k != data.len() {
            continue;
        }
        b.feed(&data[k - snap.back..]);
        let sb = norm(b.state(HIST));
        if full != sb {
            errs.push(format!("k={k} 나머지 뒤: {}", first_diff(&full, &sb)));
        }
    }
    assert!(
        errs.is_empty(),
        "{}건 어긋남, 처음:\n{}",
        errs.len(),
        errs.first().map_or("", String::as_str)
    );
}

fn check_every(data: &[u8], size: (u16, u16)) {
    check_points(data, size, 0..=data.len());
}

/// 결정적인 의사 난수 분할점 `n` 개와 끝.
fn sampled(len: usize, n: usize, seed: u64) -> impl Iterator<Item = usize> {
    let mut x = seed;
    (0..n)
        .map(move |_| {
            x = x
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            usize::try_from(x >> 33).unwrap_or(0) % (len + 1)
        })
        .chain(std::iter::once(len))
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
}

// ── 녹화·경계 벡터: 모든 분할점 (이스케이프·UTF-8 한가운데 포함) ──

#[test]
fn every_split_of_boundary_vectors() {
    check_every(&corpus("vectors.bin"), (80, 24));
    check_every(&corpus("unicode.bin"), (80, 24));
    check_every(&corpus("emoji-new.bin"), (80, 24));
}

#[test]
fn every_split_of_alt_screen_and_scroll_region() {
    check_every(&corpus("alt-roundtrip.bin"), (80, 24));
    check_every(&corpus("decstbm.bin"), (80, 24));
    check_every(&corpus("wrap.bin"), (40, 10));
}

#[test]
fn every_split_of_vim() {
    check_every(&corpus("vim.bin"), (100, 30));
    check_every(&corpus("vim-live.bin"), (100, 30));
}

#[test]
fn every_split_of_less_and_top() {
    check_every(&corpus("less.bin"), (100, 30));
    check_every(&corpus("less-live.bin"), (100, 30));
    check_every(&corpus("top.bin"), (100, 30));
    check_every(&corpus("top-live.bin"), (100, 30));
}

#[test]
fn sampled_splits_of_agent_sim() {
    let line = corpus("sim-line.bin");
    check_points(&line, (120, 40), sampled(line.len(), 60, 1));
    let tui = corpus("sim-tui.bin");
    check_points(&tui, (120, 40), sampled(tui.len(), 60, 2));
}

#[test]
fn split_after_resize() {
    let mut data = corpus("wrap.bin");
    let size = (45, 18);
    let mut a = Screen::new(60, 15, HIST);
    a.feed(&data);
    a.resize(size.0, size.1);
    let snap = a.snapshot(HIST);
    assert_eq!(snap.back, 0);
    data = [snap.bytes, corpus("decstbm.bin")].concat();
    check_every(&data, size);
}

// ── 상태 하나씩 왕복 (모든 분할점) ──

fn round_trip(cases: &[&[u8]], size: (u16, u16)) {
    for c in cases {
        let data = [*c, b"Z\r\nnext".as_slice()].concat();
        check_every(&data, size);
    }
}

#[test]
fn input_modes_round_trip() {
    round_trip(
        &[
            b"\x1b[?1h",
            b"\x1b=",
            b"\x1b[?2004h",
            b"\x1b[?1004h",
            b"\x1b[?1000h",
            b"\x1b[?1002h\x1b[?1006h",
            b"\x1b[?1003h\x1b[?1005h",
            b"\x1b[?1007l",
            b"\x1b[?25l",
            b"\x1b[5 q",
            b"\x1b[4 q",
        ],
        (20, 5),
    );
}

#[test]
fn print_modes_round_trip() {
    round_trip(
        &[
            b"abc\x1b[?7lxxxxxxxxxxxxxxxxxxxxxxxxx",
            b"abc\x1b[1G\x1b[4h",
            b"\x1b[20h",
            b"\x1b[3;10r\x1b[?6h\x1b[2;3Hx",
            b"\x1b[2;4r\x1b[4;1H\n\n\nscrolled",
        ],
        (20, 12),
    );
}

#[test]
fn charsets_round_trip() {
    round_trip(
        &[
            b"\x1b(0lqk",
            b"\x1b)0\x0eabc",
            b"\x1b)0\x0eab\x0fcd",
            b"\x1b*0\x1b+0",
        ],
        (20, 5),
    );
}

#[test]
fn pen_and_links_round_trip() {
    round_trip(
        &[
            b"\x1b[1;2;3;7;8;9;31;42mpen",
            b"\x1b[4:2;58;5;9mx\x1b[4:3;58;2;1;2;3my\x1b[4:4mz\x1b[4:5mw",
            b"\x1b[38;5;200;48;2;9;8;7mx",
            b"\x1b[93;104mbright",
            b"\x1b]8;id=a;http://x\x1b\\ab",
            b"\x1b]8;;http://noid\x1b\\ab\x1b]8;;\x1b\\c",
            b"\x1b[44m\x1b[K",
        ],
        (20, 5),
    );
}

#[test]
fn cursor_state_round_trip() {
    round_trip(
        &[
            b"\x1b[3;5H\x1b[32m\x1b(0\x1b7\x1b[1;1H\x1b[0m\x1b(B",
            b"xxxxxxxxxxxxxxxxxxxx",
            b"xxxxxxxxxxxxxxxxxx\xed\x95\x9c",
            b"xxxxxxxxxxxxxxxxxxx\xed\x95\x9c",
            b"\x1b]2;title one\x07",
            b"\x1b]0;both\x1b\\",
        ],
        (20, 5),
    );
}

#[test]
fn alt_screen_keeps_main_screen() {
    round_trip(
        &[
            b"main1\r\nmain2\x1b[31m\x1b[?1049h\x1b[Halt\x1b[5;5H",
            b"m\x1b[?1049h\x1b[2;3r\x1b[?1h\x1b7\x1b[4;4Ha",
            b"xxxxxxxxxxxxxxxxxxxx\x1b[?1049hyy",
            b"\x1b[?1049hA\x1b[?1049lB",
            b"\x1b[?47hA",
        ],
        (20, 6),
    );
}

/// 가려진 주 화면 읽기(swap_alt 왕복)가 저장 커서를 건드리지 않는가: 대체 화면 안팎의 DECSC·DECRC.
#[test]
fn alt_screen_round_trip_keeps_saved_cursors() {
    round_trip(
        &[
            b"main\x1b[2;3H\x1b[32m\x1b7\x1b[5;1H\x1b[?47hA\x1b[?47l\x1b8m",
            b"main\x1b[2;3H\x1b7\x1b[?1049h\x1b[4;6H\x1b[33m\x1b7\x1b[1;1Hx\x1b8y\x1b[?1049lz",
            b"\x1b[?1047h\x1b[2;2Ha\x1b7\x1b[?1047l\x1b8b",
        ],
        (20, 6),
    );
}

/// 대체 화면 안에서 크기를 바꾼 뒤의 스냅숏이다. 가려진 주 화면도 새 크기로 재흐름된다.
#[test]
fn alt_screen_after_resize() {
    let pre: &[u8] = b"main1\r\nmain2\x1b[2;2H\x1b7\x1b[?1049h\x1b[Halt\x1b[3;3H";
    let setup = || {
        let mut s = Screen::with_keep(20, 6, EMU_KEEP, HIST);
        s.feed(pre);
        s.resize(13, 8);
        s
    };
    let data = b"\x1b[2;5Hxy\x1b7\x1b[1;1H\x1b8z\x1b[?1049lback";
    check_points_from(&setup, EMU_KEEP, data, 0..=data.len());
    let setup_main = || {
        let mut s = Screen::with_keep(20, 6, EMU_KEEP, HIST);
        s.feed(b"\x1b[?1049hA\x1b[?1049l0123456789012345678901234\r\nq\x1b[2;5r");
        s.resize(9, 4);
        s
    };
    check_points_from(
        &setup_main,
        EMU_KEEP,
        b"\x1b[?1049hB\x1b[?1049lC\n\n\nD",
        0..=19,
    );
}

// ── 스캐너가 alacritty 와 어긋날 수 있는 자리 ──

/// DECSTBM 인자에 하위 인자(`:`)가 섞이면 vte 는 첫 하위 인자를 쓴다. 스캐너도 같아야 한다.
#[test]
fn scanner_follows_decstbm_with_subparams() {
    check_every(b"\x1b[2:1;4r\x1b[4;1H\n\nab", (20, 6));
    check_every(b"\x1b[;5r\x1b[5;1H\n\ncd\x1b[1:9:9;3:1r\n\nef", (20, 6));
}

/// RIS 는 alacritty 의 제목을 지우지만 제목 사건을 보내지 않는다. 사본도 지워야 한다.
#[test]
fn scanner_resets_title_on_ris() {
    let mut s = Screen::new(20, 3, HIST);
    s.feed(b"\x1b]2;old\x07ab\x1bc");
    assert_eq!(s.state(0).title, None);
    s.feed(b"\x1b]2;new\x07\x1bc\x1b]2;after\x07");
    assert_eq!(s.state(0).title.as_deref(), Some("after"));
}

/// 알려진 빈틈: 사용자 탭 정지(HTS·TBC)는 alacritty 가 공개하지 않아 스냅숏에 싣지 않는다.
/// 바뀐 탭 정지를 쓰는 출력은 스냅숏 뒤에서 기본 탭(8칸)으로 간다.
#[test]
fn known_gap_custom_tab_stops_are_not_carried() {
    let pre: &[u8] = b"\x1b[3g\x1b[1;5H\x1bH\r";
    let rest: &[u8] = b"\tX";
    let mut a = Screen::new(20, 3, HIST);
    a.feed(pre);
    let mut b = Screen::new(20, 3, HIST);
    b.feed(&a.snapshot(HIST).bytes);
    a.feed(rest);
    b.feed(rest);
    let x = |s: &Screen| s.row(0).unwrap().cells.iter().position(|c| c.text == "X");
    assert_eq!((x(&a), x(&b)), (Some(4), Some(8)));
}

/// 알려진 빈틈: 지난 대체 화면에서 DECSC 한 자리는 대체 화면 격자에 남아, 다음 대체 화면의 DECRC 가
/// 그리로 간다(alacritty·xterm.js 둘 다). 주 화면에 있는 동안의 스냅숏은 가려진 대체 화면 격자를 싣지 않는다.
#[test]
fn known_gap_alt_saved_cursor_from_previous_alt_session() {
    let pre: &[u8] = b"\x1b[?1049h\x1b[3;3H\x1b7\x1b[?1049l";
    let rest: &[u8] = b"\x1b[?1049h\x1b8q";
    let mut a = Screen::new(20, 6, HIST);
    a.feed(pre);
    let mut b = Screen::new(20, 6, HIST);
    b.feed(&a.snapshot(HIST).bytes);
    a.feed(rest);
    b.feed(rest);
    let q = |s: &Screen| {
        (0..6).find_map(|y| {
            let x = s.row(y)?.cells.iter().position(|c| c.text == "q")?;
            Some((x, y))
        })
    };
    assert_eq!((q(&a), q(&b)), (Some((2, 2)), Some((0, 0))));
}

/// 알려진 빈틈: 대체 화면 안에서 크기를 바꿔 주 화면 커서가 재흐름으로 옮겨진 뒤 스냅숏을 만들면,
/// 주 화면의 저장 커서(대체 화면에 들어갈 때의 자리)가 지금 커서로 바뀐다(원본과 스냅숏 모두).
/// 대체 화면을 나온 뒤 화면은 같고, 주 화면에서 DECRC 를 쓸 때만 다르다.
#[test]
fn known_gap_main_saved_cursor_after_resize_in_alt() {
    let pre: &[u8] = b"main line one that wraps around\r\nmain2\x1b[2;2H\x1b[?1049h\x1b[Halt";
    let mut whole = Screen::new(20, 6, HIST);
    whole.feed(pre);
    whole.resize(13, 8);
    let mut a = Screen::new(20, 6, HIST);
    a.feed(pre);
    a.resize(13, 8);
    let mut b = Screen::new(13, 8, HIST);
    b.feed(&a.snapshot(HIST).bytes);
    let exit: &[u8] = b"\x1b[?1049l";
    for s in [&mut whole, &mut a, &mut b] {
        s.feed(exit);
    }
    assert_eq!(whole.cursor(), b.cursor());
    let saved = |s: &mut Screen| {
        let c = s.state(0).main.saved;
        (c.col, c.row)
    };
    assert_ne!(saved(&mut whole), saved(&mut b));
    assert_eq!(saved(&mut a), saved(&mut b));
}

/// 알려진 빈틈: 화면 밖을 가리키는 DECSTBM(위 ≥ 화면 행 수)은 alacritty 가 빈 영역으로 둔다.
/// DECSTBM 으로 다시 만들 수 없어 스냅숏을 받은 쪽은 앞 영역을 그대로 둔다.
#[test]
fn known_gap_scroll_region_below_screen() {
    let mut a = Screen::new(20, 6, HIST);
    a.feed(b"\x1b[2;4r\x1b[99;100r");
    let mut b = Screen::new(20, 6, HIST);
    b.feed(&a.snapshot(HIST).bytes);
    assert_eq!((a.state(0).region, b.state(0).region), (Some((7, 6)), None));
}

/// 에뮬레이터 기록을 짧게 두어 줄 저장소를 거치는 분할점 시험이다.
#[test]
fn splits_through_line_store() {
    let mut data = Vec::new();
    for i in 0..60 {
        data.extend_from_slice(format!("\x1b[3{}mline {i} ", i % 8).as_bytes());
        data.extend(std::iter::repeat_n(b'x', i % 23));
        data.extend_from_slice("\x1b]8;;http://e\x1b\\한\x1b]8;;\x1b\\\x1b[0m\r\n".as_bytes());
    }
    check_points_keep(&data, (12, 6), 5, 0..=data.len());
    let line = corpus("sim-line.bin");
    check_points_keep(&line, (120, 40), 50, sampled(line.len(), 20, 3));
}

#[test]
fn snapshot_takes_old_lines_from_store() {
    let mut s = Screen::with_keep(10, 5, 20, 1_000);
    s.feed(
        &(0..100)
            .flat_map(|i| format!("L{i:02}\r\n").into_bytes())
            .collect::<Vec<_>>(),
    );
    let snap = s.snapshot(50);
    assert_eq!(snap.first_line, 46);
    let mut b = Screen::new(10, 5, 1_000);
    b.feed(&snap.bytes);
    let hl = i32::try_from(b.history_len()).unwrap();
    let first = b.row(-hl).unwrap();
    let t: String = first.cells.iter().map(|c| c.text.as_str()).collect();
    assert_eq!((hl, t.trim_end()), (50, "L46"));
}

#[test]
fn history_and_wrapped_rows_round_trip() {
    let mut data = Vec::new();
    for i in 0..40 {
        data.extend_from_slice(format!("line {i} ").as_bytes());
        data.extend(std::iter::repeat_n(b'x', i));
        data.extend_from_slice("한\r\n".as_bytes());
    }
    check_every(&data, (12, 6));
}

// ── 바이트 꼴 ──

fn text(s: &mut Screen) -> String {
    String::from_utf8(s.snapshot(HIST).bytes).unwrap()
}

#[test]
fn new_emoji_gets_column_reset_but_hangul_does_not() {
    let mut s = Screen::new(20, 3, HIST);
    s.feed("🫠a".as_bytes());
    assert!(text(&mut s).contains("🫠\x1b[3Ga"));
    let mut s = Screen::new(20, 3, HIST);
    s.feed("한a".as_bytes());
    assert!(text(&mut s).contains("한a"));
}

#[test]
fn unfinished_sequence_moves_offset_back() {
    let mut s = Screen::new(20, 3, HIST);
    s.feed(b"ab\x1b[3");
    assert_eq!(s.snapshot(HIST).back, 3);
    s.feed(b"1m\xed\x95");
    assert_eq!(s.snapshot(HIST).back, 2);
    s.feed(b"\x9c\x1b]2;ti");
    let snap = s.snapshot(HIST);
    assert_eq!(snap.back, 6);
    assert!(!snap.bytes.ends_with(b"ti"));
}

/// 시퀀스 안에서 실행된 C0 는 이미 화면에 들어갔다. 물리면 두 번 실행되므로 끝나지 않은 바이트를 붙인다.
#[test]
fn control_inside_sequence_is_carried_raw() {
    let mut s = Screen::new(20, 3, HIST);
    s.feed(b"ab\x1b[3\n");
    let snap = s.snapshot(HIST);
    assert_eq!(snap.back, 0);
    assert!(snap.bytes.ends_with(b"\x1b[3"));
    check_every(b"ab\x1b[3\n1mX\x1b]2;a\x08b\x07c", (20, 3));
}

#[test]
fn snapshot_does_not_use_erase_display() {
    let mut s = Screen::new(120, 40, HIST);
    s.feed(&corpus("sim-tui.bin"));
    assert!(!text(&mut s).contains("\x1b[2J"));
}

#[test]
fn snapshot_size_follows_screen_not_output() {
    let tui = corpus("sim-tui.bin");
    let mut half = Screen::new(120, 40, HIST);
    half.feed(&tui[..tui.len() / 2]);
    let mut full = Screen::new(120, 40, HIST);
    full.feed(&tui);
    let (h, f) = (half.snapshot(0).bytes.len(), full.snapshot(0).bytes.len());
    assert!(f < 20_000, "{f}");
    assert!(f < h * 2 && h < f * 2, "{h} {f}");
}

// ── xterm.js 확인용 내보내기 (`testdata/check-snap.mjs`) ──

/// `OTTER_SNAP_OUT=<dir> cargo test -p otter-shared-termstate --lib export_snapshots -- --ignored`
#[test]
#[ignore = "xterm.js 확인용 자료를 만든다 — testdata/check-snap.mjs 가 읽는다"]
fn export_snapshots_for_xterm() {
    let Some(dir) = std::env::var_os("OTTER_SNAP_OUT").map(PathBuf::from) else {
        return;
    };
    std::fs::create_dir_all(&dir).unwrap();
    let cases: [(&str, (u16, u16)); 14] = [
        ("vectors.bin", (80, 24)),
        ("unicode.bin", (80, 24)),
        ("emoji-new.bin", (80, 24)),
        ("alt-roundtrip.bin", (80, 24)),
        ("decstbm.bin", (80, 24)),
        ("wrap.bin", (40, 10)),
        ("vim.bin", (100, 30)),
        ("vim-live.bin", (100, 30)),
        ("less.bin", (100, 30)),
        ("less-live.bin", (100, 30)),
        ("top.bin", (100, 30)),
        ("top-live.bin", (100, 30)),
        ("sim-line.bin", (120, 40)),
        ("sim-tui.bin", (120, 40)),
    ];
    let mut manifest = Vec::new();
    for (i, (file, (cols, rows))) in cases.into_iter().enumerate() {
        let data = corpus(file);
        let mut a = Screen::new(cols, rows, HIST);
        let mut fed = 0;
        for k in sampled(data.len(), 40, 100 + i as u64) {
            a.feed(&data[fed..k]);
            fed = k;
            let name = format!("{file}.{k}.snap");
            let snap = a.snapshot(HIST);
            std::fs::write(dir.join(&name), &snap.bytes).unwrap();
            let back = snap.back;
            manifest.push(format!(
                r#"{{"input":"{file}","cols":{cols},"rows":{rows},"k":{k},"back":{back},"snap":"{name}"}}"#
            ));
        }
    }
    std::fs::write(
        dir.join("manifest.json"),
        format!("[{}]\n", manifest.join(",\n")),
    )
    .unwrap();
}

/// 깨움 예산(NFR-PRF-14) 판단용 측정이다. 릴리스로 돌린다:
/// `cargo test --release -p otter-shared-termstate --lib measure_snapshot -- --ignored --nocapture`
#[test]
#[ignore = "측정 — 릴리스로 돌린다"]
fn measure_snapshot_5000_rows() {
    use std::time::Instant;
    for (name, data) in [
        ("sim-line x8", corpus("sim-line.bin").repeat(8)),
        ("sim-tui x8", corpus("sim-tui.bin").repeat(8)),
    ] {
        let mut s = Screen::new(120, 40, HISTORY_CAP);
        s.feed(&data);
        let mut best = u128::MAX;
        let mut len = 0;
        for _ in 0..5 {
            let t = Instant::now();
            let snap = s.snapshot(5_000);
            best = best.min(t.elapsed().as_micros());
            len = snap.bytes.len();
        }
        let screen_only = s.snapshot(0).bytes.len();
        let hist = s.history_len() + s.store().len();
        println!(
            "{name}: 기록 {hist}줄, 스냅숏(5000행) {len} B, 화면만 {screen_only} B, 만들기 {best} µs"
        );
    }
}
