//! 에뮬레이터 그리드 저장 공간의 할당 시험 (NFR-PRF-10, M4_MEMORY_DESIGN §2·§3·§4·§9).
//!
//! 스레드마다 살아 있는 바이트와 크기별 할당 횟수를 세는 할당자로 잰다. 시험은 병렬로 돌아도 서로의
//! 할당을 세지 않는다.

use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::{Cell, RefCell};

use otter_shared_termlimit::{ALAC_STORAGE_UNIT, HISTORY_LINES_DEFAULT};
use otter_shared_termstate::Screen;

/// 크기별 할당 횟수를 적는 칸 수다. 넘는 크기는 세지 않는다.
const SIZE_SLOTS: usize = 256;

thread_local! {
    static LIVE: Cell<isize> = const { Cell::new(0) };
    static RECORD: Cell<bool> = const { Cell::new(false) };
    static SIZES: RefCell<[(usize, usize); SIZE_SLOTS]> = const { RefCell::new([(0, 0); SIZE_SLOTS]) };
}

struct Counting;

fn note_alloc(size: usize) {
    let _ = LIVE.try_with(|l| l.set(l.get() + size as isize));
    let recording = RECORD.try_with(Cell::get).unwrap_or(false);
    if !recording {
        return;
    }
    let _ = SIZES.try_with(|s| {
        let Ok(mut s) = s.try_borrow_mut() else {
            return;
        };
        if let Some(slot) = s.iter_mut().find(|(sz, n)| *sz == size || *n == 0) {
            slot.0 = size;
            slot.1 += 1;
        }
    });
}

fn note_free(size: usize) {
    let _ = LIVE.try_with(|l| l.set(l.get() - size as isize));
}

// SAFETY: 모든 요청을 System 에 그대로 넘기고 수만 센다.
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        note_alloc(layout.size());
        // SAFETY: 호출자의 계약을 그대로 넘긴다.
        unsafe { System.alloc(layout) }
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        note_alloc(layout.size());
        // SAFETY: 호출자의 계약을 그대로 넘긴다.
        unsafe { System.alloc_zeroed(layout) }
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        note_free(layout.size());
        // SAFETY: 호출자의 계약을 그대로 넘긴다.
        unsafe { System.dealloc(ptr, layout) }
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        note_free(layout.size());
        note_alloc(new_size);
        // SAFETY: 호출자의 계약을 그대로 넘긴다.
        unsafe { System.realloc(ptr, layout, new_size) }
    }
}

#[global_allocator]
static ALLOC: Counting = Counting;

fn live() -> isize {
    LIVE.with(Cell::get)
}

/// `f` 가 하는 할당 중 가장 자주 나온 크기와 그 횟수다.
fn most_frequent_alloc(f: impl FnOnce()) -> (usize, usize) {
    SIZES.with(|s| *s.borrow_mut() = [(0, 0); SIZE_SLOTS]);
    RECORD.with(|r| r.set(true));
    f();
    RECORD.with(|r| r.set(false));
    SIZES.with(|s| {
        s.borrow()
            .iter()
            .copied()
            .max_by_key(|(_, n)| *n)
            .unwrap_or((0, 0))
    })
}

/// 행 하나를 담는 `Vec` 의 머리(포인터·용량·길이)와 alacritty `Row` 의 `occ` 다.
const ROW_HEAD: usize = 4 * std::mem::size_of::<usize>();
/// 파서·스캐너·제목 등 행 수와 무관한 몫의 여유다.
const FIXED_SLACK: usize = 256 << 10;

/// 측정용 짧은 줄이다.
fn short_lines(from: usize, n: usize) -> Vec<u8> {
    (from..from + n)
        .flat_map(|i| format!("line {i:05}\r\n").into_bytes())
        .collect()
}

/// 코드 줄의 글자 수다.
const CODE_WIDTH: usize = 120;

/// 코드 120자·색 6구간 줄이다.
fn code_lines(from: usize, n: usize) -> Vec<u8> {
    const SEGMENTS: usize = 6;
    let seg = CODE_WIDTH / SEGMENTS;
    let mut out = Vec::new();
    for i in from..from + n {
        let head = format!("{i:06} ");
        for k in 0..SEGMENTS {
            out.extend_from_slice(format!("\x1b[3{}m", 1 + k).as_bytes());
            let body: String = if k == 0 {
                format!("{head:<seg$}")
            } else {
                (0..seg)
                    .map(|j| char::from(b'a' + u8::try_from((i + j + k) % 26).unwrap_or(0)))
                    .collect()
            };
            out.extend_from_slice(body.as_bytes());
        }
        out.extend_from_slice(b"\x1b[0m\r\n");
    }
    out
}

/// 화면 한 벌을 채운 뒤 처음 기록이 생길 때 그리드는 [`ALAC_STORAGE_UNIT`] 행을 한 번에 잡는다.
/// alacritty `MAX_CACHE_SIZE` 를 비춘 상수가 맞는지 이 시험이 고정한다. 행 하나의 바이트를 돌려준다.
fn first_growth_row_bytes(cols: u16, rows: u16) -> usize {
    let mut s = Screen::new(cols, rows, HISTORY_LINES_DEFAULT);
    s.feed(&short_lines(0, usize::from(rows) - 1));
    assert_eq!(s.history_len(), 0);
    let (size, count) = most_frequent_alloc(|| s.feed(&short_lines(rows.into(), 1)));
    assert_eq!(s.history_len(), 1);
    assert_eq!(count, ALAC_STORAGE_UNIT, "{cols}x{rows} 첫 할당 행 수");
    assert!(size >= usize::from(cols), "{size}");
    size
}

/// 화면 상태를 만든 뒤 그리드가 더 잡을 수 있는 바이트의 상한이다: 저장 단위 하나 + 화면 `extra_rows` 행.
/// 화면 행과 대체 화면은 만들 때 이미 잡는다. 파서의 동기 갱신 버퍼(vte 2 MiB)도 만들 때 잡으므로 빠진다.
fn growth_bound(extra_rows: usize, row_bytes: usize) -> isize {
    let rows = ALAC_STORAGE_UNIT + extra_rows;
    isize::try_from(rows * (row_bytes + ROW_HEAD) + FIXED_SLACK).unwrap_or(isize::MAX)
}

/// 만든 뒤(`base`) 화면 상태가 더 쥔 바이트에서 줄 저장소 몫을 뺀 것이다.
fn grid_growth(s: &Screen, base: isize) -> isize {
    live() - base - isize::try_from(s.store().heap_bytes()).unwrap_or(isize::MAX)
}

fn fresh(cols: u16, rows: u16) -> (Screen, isize) {
    let s = Screen::new(cols, rows, HISTORY_LINES_DEFAULT);
    let base = live();
    (s, base)
}

type Gen = fn(usize, usize) -> Vec<u8>;

const KINDS: [(&str, Gen); 2] = [("짧은 줄", short_lines), ("코드 120자", code_lines)];
const SIZES_UNDER_TEST: [(u16, u16); 3] = [(120, 40), (80, 24), (200, 50)];
/// 한 번에 넣는 줄 수다(데몬의 읽기 조각처럼 나눠 넣는다).
const FEED_LINES: usize = 500;

fn feed_lines(s: &mut Screen, make: Gen, from: usize, n: usize) {
    let mut at = from;
    while at < from + n {
        let k = FEED_LINES.min(from + n - at);
        s.feed(&make(at, k));
        at += k;
    }
}

#[test]
fn first_growth_is_one_storage_unit() {
    for (cols, rows) in SIZES_UNDER_TEST {
        first_growth_row_bytes(cols, rows);
    }
}

#[test]
fn grid_stays_within_one_storage_unit_after_20k_lines() {
    for (cols, rows) in SIZES_UNDER_TEST {
        let row_bytes = first_growth_row_bytes(cols, rows);
        for (kind, make) in KINDS {
            let (mut s, base) = fresh(cols, rows);
            feed_lines(&mut s, make, 0, HISTORY_LINES_DEFAULT);
            let got = grid_growth(&s, base);
            let bound = growth_bound(0, row_bytes);
            println!("{cols}x{rows} {kind}: 그리드 {got} B, 상한 {bound} B");
            assert!(got <= bound, "{cols}x{rows} {kind}: {got} > {bound}");
        }
    }
}

/// 크기를 바꾼 뒤 다시 2만 줄을 넣어도 저장 단위 하나다(바꾸기가 저장 공간을 화면 + 기록으로 맞춘 뒤
/// 한 단위를 더 잡지 않는다). 새 화면과 새 대체 화면 행 몫을 더 준다.
#[test]
fn grid_stays_within_one_storage_unit_after_resize() {
    let pairs = [
        ((120, 40), (80, 24)),
        ((80, 24), (200, 50)),
        ((200, 50), (120, 40)),
    ];
    for ((c0, r0), (c1, r1)) in pairs {
        let row_bytes = first_growth_row_bytes(c1, r1);
        for (kind, make) in KINDS {
            let (mut s, base) = fresh(c0, r0);
            feed_lines(&mut s, make, 0, HISTORY_LINES_DEFAULT);
            s.resize(c1, r1);
            feed_lines(&mut s, make, HISTORY_LINES_DEFAULT, HISTORY_LINES_DEFAULT);
            let got = grid_growth(&s, base);
            let bound = growth_bound(2 * usize::from(r1), row_bytes);
            println!("{c0}x{r0}→{c1}x{r1} {kind}: 그리드 {got} B, 상한 {bound} B");
            assert!(got <= bound, "{c0}x{r0}→{c1}x{r1} {kind}: {got} > {bound}");
        }
    }
}

/// 옮겨 비우면 그리드는 화면(과 걸친 꼬리)만 남는다. 다시 출력이 오면 평소대로 한 단위를 잡는다.
#[test]
fn compact_frees_the_history_storage() {
    for (cols, rows) in SIZES_UNDER_TEST {
        let row_bytes = first_growth_row_bytes(cols, rows);
        for (kind, make) in KINDS {
            let (mut s, base) = fresh(cols, rows);
            feed_lines(&mut s, make, 0, HISTORY_LINES_DEFAULT);
            let before = grid_growth(&s, base);
            s.compact();
            // 화면 첫 행으로 이어지는 마지막 줄의 앞 행만 남는다(Q5).
            let tail = s.history_len();
            assert!(
                tail < CODE_WIDTH.div_ceil(usize::from(cols)),
                "{cols}x{rows} {kind}: {tail}"
            );
            let after = grid_growth(&s, base);
            println!("{cols}x{rows} {kind}: 비우기 앞 {before} B, 뒤 {after} B");
            let left =
                isize::try_from(tail * (row_bytes + ROW_HEAD) + FIXED_SLACK).unwrap_or(isize::MAX);
            assert!(after <= left, "{cols}x{rows} {kind}: {after} > {left}");
            feed_lines(&mut s, make, HISTORY_LINES_DEFAULT, ALAC_STORAGE_UNIT);
            let again = grid_growth(&s, base);
            let bound = growth_bound(0, row_bytes);
            assert!(again <= bound, "{cols}x{rows} {kind}: {again} > {bound}");
        }
    }
}
