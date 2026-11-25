use super::line::tests::rich_line;
use super::*;

fn plain(s: &str) -> Line {
    let mut b = LineBuilder::new();
    for ch in s.chars() {
        b.push(&ch.to_string(), 1, Style::default(), None);
    }
    b.finish()
}

fn filled(cap: usize, n: u32) -> LineStore {
    let mut s = LineStore::new(cap);
    for i in 0..n {
        assert_eq!(s.push(rich_line(i)), u64::from(i));
    }
    s
}

#[test]
fn lines_come_back_equal_from_hot_and_compressed_blocks() {
    let n = (BLOCK_LINES * 3 + 17) as u32;
    let s = filled(DEFAULT_CAP, n);
    assert_eq!((s.first(), s.end(), s.len()), (0, u64::from(n), n as usize));
    let (from, got) = s.lines(0, n as usize);
    assert_eq!(from, 0);
    let want: Vec<Line> = (0..n).map(rich_line).collect();
    assert_eq!(got, want);
}

#[test]
fn a_range_across_block_edges_starts_at_the_asked_number() {
    let s = filled(DEFAULT_CAP, (BLOCK_LINES * 2 + 5) as u32);
    // 압축 블록 둘과 풀린 블록에 걸친다.
    let from = (BLOCK_LINES - 3) as u64;
    let (start, got) = s.lines(from, BLOCK_LINES + 8);
    assert_eq!(start, from);
    let want: Vec<Line> = (from as u32..from as u32 + BLOCK_LINES as u32 + 8)
        .map(rich_line)
        .collect();
    assert_eq!(got, want);
    let (start, got) = s.lines((BLOCK_LINES * 2 + 1) as u64, 100);
    assert_eq!(start, (BLOCK_LINES * 2 + 1) as u64);
    assert_eq!(got.len(), 4, "끝에서 잘린다");
}

#[test]
fn reading_outside_the_kept_range_is_clamped() {
    let s = filled(DEFAULT_CAP, 10);
    assert_eq!(s.lines(10, 5), (10, vec![]));
    assert_eq!(s.lines(100, 5).1, vec![]);
    assert_eq!(s.lines(3, 0).1, vec![]);
    assert_eq!(s.lines(u64::MAX, usize::MAX).1, vec![]);
}

#[test]
fn over_the_cap_the_oldest_block_goes_and_numbers_keep_rising() {
    let cap = 1000;
    let mut s = LineStore::new(cap);
    let mut last_first = 0;
    for i in 0..(cap * 5) as u64 {
        assert_eq!(s.push(plain(&format!("n{i}"))), i);
        assert!(s.len() >= cap.min(i as usize + 1), "상한만큼은 늘 남긴다");
        assert!(s.len() < cap + BLOCK_LINES, "넘친 블록은 버린다");
        assert!(s.first() >= last_first, "첫 번호는 줄지 않는다");
        last_first = s.first();
    }
    assert_eq!(s.end(), (cap * 5) as u64);
    assert!(s.first() > 0);
    assert_eq!(s.first() % BLOCK_LINES as u64, 0, "블록 단위로 버린다");
    assert_eq!(s.lines(0, 3).1, vec![], "버린 구간은 비어 온다");
    let (from, got) = s.lines(0, s.first() as usize + 1);
    assert_eq!(from, s.first(), "남은 첫 줄부터 잘린다");
    assert_eq!(got, vec![plain(&format!("n{}", s.first()))]);
    let (_, tail) = s.lines(s.end() - 1, 1);
    assert_eq!(tail, vec![plain(&format!("n{}", cap * 5 - 1))]);
}

#[test]
fn clear_empties_the_store_and_numbering_continues() {
    let mut s = filled(DEFAULT_CAP, 600);
    s.clear();
    assert!(s.is_empty());
    assert_eq!((s.first(), s.end()), (600, 600));
    assert_eq!(s.lines(0, 1000).1, vec![]);
    assert_eq!(s.push(plain("after")), 600);
    assert_eq!(s.lines(0, 1000), (600, vec![plain("after")]));
}

#[test]
fn default_cap_is_the_history_lines_default() {
    assert_eq!(DEFAULT_CAP, otter_shared_termlimit::HISTORY_LINES_DEFAULT);
    assert_eq!(LineStore::default().cap(), DEFAULT_CAP);
    assert_eq!(BLOCK_LINES, otter_shared_termlimit::STORE_BLOCK_LINES);
}

// ── 크기 어림 (NFR-PRF-10, 터미널당 8 MB) ──

/// 크기 어림의 기준 줄 수다. 기본값(2만)보다 큰 5만 줄을 참고로 잰다(D-55).
const REF_LINES: usize = 50_000;

/// 결정적인 의사 난수(xorshift) — 시험이 늘 같은 줄을 만든다.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }

    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

const WORDS: [&str; 24] = [
    "error",
    "warning:",
    "compiling",
    "src/lib.rs:42:7",
    "the",
    "agent",
    "tool_use",
    "Read",
    "function",
    "let",
    "=",
    "{",
    "}",
    "return",
    "cargo",
    "test",
    "ok",
    "FAILED",
    "→",
    "한글",
    "출력을",
    "저장소",
    "0x7ffe3a",
    "1732451234",
];

/// agent-sim 꼴의 줄: 길이 0~200칸, 색 구간 몇 개, 가끔 링크·넓은 글자.
fn realistic_line(r: &mut Rng) -> Line {
    let mut b = LineBuilder::new();
    let target = r.below(160) as usize + if r.below(10) == 0 { 0 } else { 8 };
    let mut style = Style::default();
    let link = Link {
        id: String::new(),
        uri: format!("https://example.com/p/{}", r.below(1000)),
    };
    let mut cols = 0;
    while cols < target {
        if r.below(6) == 0 {
            style = match r.below(4) {
                0 => Style::default(),
                1 => Style {
                    fg: Color::Indexed(r.below(16) as u8),
                    ..Style::default()
                },
                2 => Style {
                    fg: Color::Rgb(r.below(256) as u8, 120, 80),
                    flags: flags::BOLD,
                    ..Style::default()
                },
                _ => Style {
                    flags: flags::DIM,
                    ..Style::default()
                },
            };
        }
        let linked = r.below(40) == 0;
        let word = if r.below(3) == 0 {
            format!("{}", r.next() % 100_000)
        } else {
            WORDS[r.below(WORDS.len() as u64) as usize].to_owned()
        };
        for ch in word.chars() {
            let w = if (ch as u32) >= 0xac00 { 2 } else { 1 };
            b.push(&ch.to_string(), w, style, linked.then_some(&link));
            cols += usize::from(w);
        }
        b.push(" ", 1, style, None);
        cols += 1;
    }
    b.finish()
}

#[test]
fn fifty_thousand_realistic_lines_fit_well_under_eight_megabytes() {
    let mut r = Rng(0x2545_f491_4f6c_dd1d);
    let mut s = LineStore::new(REF_LINES);
    let mut text = 0;
    for _ in 0..REF_LINES {
        let l = realistic_line(&mut r);
        text += l.text().len();
        s.push(l);
    }
    let bytes = s.heap_bytes();
    assert!(text > 3_000_000, "표본이 너무 작다: {text}");
    assert!(
        bytes < 4 * 1024 * 1024,
        "저장소 {bytes} 바이트(글자 {text})"
    );
}

#[cfg(unix)]
fn max_rss_bytes() -> u64 {
    // SAFETY: rusage 를 0 으로 채워 넘기고 getrusage 가 채운다.
    let mut ru: libc::rusage = unsafe { std::mem::zeroed() };
    // SAFETY: 위에서 만든 rusage 를 가리키는 올바른 포인터다.
    let rc = unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut ru) };
    assert_eq!(rc, 0);
    let v = ru.ru_maxrss as u64;
    if cfg!(target_os = "macos") {
        v
    } else {
        v * 1024
    }
}

/// 측정: 터미널 12개 × 5만 줄. 저장소 몫의 RSS 증가분이 터미널당 8 MB 이하인가.
/// 데몬 전체(링 + 에뮬레이터 + 저장소)의 측정은 연결(2.4) 뒤 2.10 이 한다.
#[cfg(unix)]
#[test]
#[ignore = "측정 시험 — cargo test -p otter-shared-linestore --lib -- --ignored --nocapture"]
fn measure_twelve_terminals_of_fifty_thousand_lines() {
    let before = max_rss_bytes();
    let mut r = Rng(0x9e37_79b9_7f4a_7c15);
    let mut stores: Vec<LineStore> = (0..12).map(|_| LineStore::new(REF_LINES)).collect();
    for _ in 0..REF_LINES {
        for s in &mut stores {
            s.push(realistic_line(&mut r));
        }
    }
    let after = max_rss_bytes();
    let heap: usize = stores.iter().map(LineStore::heap_bytes).sum();
    let per_rss = (after - before) / 12;
    println!(
        "터미널당 RSS 증가 {:.2} MB, 저장소 어림 {:.2} MB",
        per_rss as f64 / 1048576.0,
        heap as f64 / 12.0 / 1048576.0
    );
    assert!(per_rss <= 8 * 1024 * 1024);
}

#[test]
fn lowering_the_cap_drops_old_blocks_at_once_and_raising_it_keeps_more() {
    let mut s = LineStore::new(5_000);
    for i in 0..5_000 {
        s.push(plain(&format!("n{i}")));
    }
    assert!(s.len() >= 5_000);
    s.set_cap(1_000);
    assert_eq!(s.cap(), 1_000);
    assert!(
        s.len() >= 1_000 && s.len() < 1_000 + BLOCK_LINES,
        "{}",
        s.len()
    );
    assert_eq!(s.end(), 5_000, "번호는 그대로다");
    let (from, got) = s.lines(s.first(), 1);
    assert_eq!(got, vec![plain(&format!("n{from}"))]);

    let before = (s.first(), s.len());
    s.set_cap(3_000);
    assert_eq!(
        (s.first(), s.len()),
        before,
        "올려도 버린 줄은 돌아오지 않는다"
    );
    for i in 5_000..8_000 {
        s.push(plain(&format!("n{i}")));
    }
    assert!(
        s.len() >= 3_000 && s.len() < 3_000 + BLOCK_LINES,
        "{}",
        s.len()
    );
}

// ── 인계 (D-27): 블록과 번호를 그대로 넘긴다 ──

#[test]
fn export_and_import_keep_lines_and_numbers() {
    let mut s = LineStore::new(1_000);
    for i in 0..1_700u32 {
        s.push(rich_line(i));
    }
    s.clear();
    for i in 0..(BLOCK_LINES as u32 * 2 + 7) {
        s.push(rich_line(i));
    }
    let img = s.export();
    let t = LineStore::import(1_000, &img).expect("되읽기");
    assert_eq!((t.first(), t.end(), t.cap()), (s.first(), s.end(), 1_000));
    assert_eq!(t.lines(t.first(), t.len()), s.lines(s.first(), s.len()));
    let mut t = t;
    assert_eq!(t.push(plain("next")), s.end(), "번호가 이어진다");
}

#[test]
fn import_applies_the_new_cap() {
    let mut s = LineStore::new(5_000);
    for i in 0..5_000 {
        s.push(plain(&format!("n{i}")));
    }
    let t = LineStore::import(1_000, &s.export()).unwrap();
    assert!(
        t.len() >= 1_000 && t.len() < 1_000 + BLOCK_LINES,
        "{}",
        t.len()
    );
    assert_eq!(t.end(), 5_000);
}

#[test]
fn empty_store_round_trips() {
    let mut s = LineStore::new(1_000);
    for i in 0..10 {
        s.push(plain(&format!("n{i}")));
    }
    s.clear();
    let t = LineStore::import(1_000, &s.export()).unwrap();
    assert!(t.is_empty());
    assert_eq!((t.first(), t.end()), (10, 10));
}

#[test]
fn broken_images_are_refused() {
    let mut s = LineStore::new(1_000);
    for i in 0..300 {
        s.push(plain(&format!("n{i}")));
    }
    let img = s.export();
    assert!(LineStore::import(1_000, &[]).is_none());
    assert!(
        LineStore::import(1_000, &img[..img.len() - 1]).is_none(),
        "잘린 자료"
    );
    let mut other = img.clone();
    other[0] = 99;
    assert!(LineStore::import(1_000, &other).is_none(), "모르는 형식");
    let mut long = img.clone();
    long.push(0);
    assert!(LineStore::import(1_000, &long).is_none(), "남는 바이트");
}
