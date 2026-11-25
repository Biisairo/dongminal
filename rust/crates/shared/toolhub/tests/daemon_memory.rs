//! 도구 하나가 데몬에서 쓰는 살아 있는 힙 (NFR-PRF-10, D-55·D-57, PERF 4.1.3 `M4_MEMORY_DESIGN.md` §9).
//!
//! 도구 12대(120×40)에 출력을 읽기 스레드로 넣고, 출력 중과 유휴 비우기 뒤의 살아 있는 힙을 잰다.
//! 판정 지표는 물리 사용량(D-57)이고 그것은 격리 인스턴스에서 잰다. 여기 값은 참고다 — 도구마다 vte 파서가
//! 미리 잡는 동기 버퍼(건드리지 않아 물리 사용량에는 없다)가 살아 있는 힙에는 든다. 그래서 "빈 도구" 를 함께 적는다.
//!
//! 사용: `cargo test --release -p otter-shared-toolhub --test daemon_memory -- --ignored --nocapture`

use std::alloc::{GlobalAlloc, Layout, System};
use std::collections::VecDeque;
use std::io;
use std::sync::atomic::{AtomicIsize, Ordering::SeqCst};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use otter_shared_otterenv::ENV_SCREEN_IDLE_COMPACT_MS;
use otter_shared_outbuf::Stream;
use otter_shared_platform::{Handover, Terminal};
use otter_shared_termlimit::{HISTORY_LINES_DEFAULT, OUTPUT_RING_BYTES};
use otter_shared_toolhub::{Tool, ToolManager};
use tokio_util::sync::CancellationToken;

static LIVE: AtomicIsize = AtomicIsize::new(0);

struct Counting;

// SAFETY: 모든 요청을 System 에 그대로 넘기고 크기만 센다.
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        LIVE.fetch_add(layout.size() as isize, SeqCst);
        // SAFETY: 호출자의 계약을 그대로 넘긴다.
        unsafe { System.alloc(layout) }
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        LIVE.fetch_add(layout.size() as isize, SeqCst);
        // SAFETY: 호출자의 계약을 그대로 넘긴다.
        unsafe { System.alloc_zeroed(layout) }
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        LIVE.fetch_sub(layout.size() as isize, SeqCst);
        // SAFETY: 호출자의 계약을 그대로 넘긴다.
        unsafe { System.dealloc(ptr, layout) }
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        LIVE.fetch_add(new_size as isize - layout.size() as isize, SeqCst);
        // SAFETY: 호출자의 계약을 그대로 넘긴다.
        unsafe { System.realloc(ptr, layout, new_size) }
    }
}

#[global_allocator]
static ALLOC: Counting = Counting;

const TOOLS: usize = 12;
const COLS: u16 = 120;
const ROWS: u16 = 40;
/// 참고 기록(D-55): 이전 기본값.
const OLD_DEFAULT_LINES: usize = 50_000;
/// 시험의 유휴 비우기 시간이다. 출력 중 값을 잰 뒤에 비우도록 넉넉히 둔다.
const IDLE_MS: &str = "3000";
const MB: f64 = 1_000_000.0;

/// 넣은 바이트를 읽기 스레드에 조각으로 내주는 터미널이다. 바이트가 없으면 기다린다. 읽은 조각은 곧바로
/// 놓는다 — 쌓아 둔 입력이 살아 있는 힙에 남지 않게.
#[derive(Default)]
struct FeedTerm {
    queue: Mutex<VecDeque<Vec<u8>>>,
    ready: Condvar,
}

/// 조각 하나의 크기다. 읽기 스레드의 버퍼보다 작다.
const PIECE: usize = 4096;

impl FeedTerm {
    fn push(&self, b: &[u8]) {
        self.queue
            .lock()
            .unwrap()
            .extend(b.chunks(PIECE).map(<[u8]>::to_vec));
        self.ready.notify_one();
    }
}

struct Shared(Arc<FeedTerm>);

impl Terminal for Shared {
    fn read(&self, buf: &mut [u8]) -> io::Result<usize> {
        let mut q = self.0.queue.lock().unwrap();
        while q.is_empty() {
            q = self.0.ready.wait(q).unwrap();
        }
        let piece = q.pop_front().unwrap_or_default();
        if q.is_empty() {
            q.shrink_to_fit();
        }
        buf[..piece.len()].copy_from_slice(&piece);
        Ok(piece.len())
    }
    fn write(&self, b: &[u8]) -> io::Result<usize> {
        Ok(b.len())
    }
    fn close(&self) -> io::Result<()> {
        Ok(())
    }
    fn resize(&self, _: u16, _: u16) -> io::Result<()> {
        Ok(())
    }
    fn size(&self) -> io::Result<(u16, u16)> {
        Ok((COLS, ROWS))
    }
    fn foreground_pgid(&self) -> Option<i32> {
        None
    }
    fn pid(&self) -> i32 {
        0
    }
    fn wait(&self) -> io::Result<std::process::ExitStatus> {
        Err(io::Error::other("fake"))
    }
    fn terminate(&self) -> io::Result<()> {
        Ok(())
    }
    fn kill(&self) -> io::Result<()> {
        Ok(())
    }
    fn handover(&self) -> Option<&dyn Handover> {
        None
    }
}

/// 결정적인 의사 난수다.
struct Lcg(u64);

impl Lcg {
    fn next(&mut self, n: usize) -> usize {
        self.0 = self
            .0
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        ((self.0 >> 33) as usize) % n
    }
}

const WORDS: &[&str] = &[
    "the",
    "agent",
    "reads",
    "files",
    "edits",
    "code",
    "runs",
    "tests",
    "and",
    "reports",
    "results",
    "while",
    "streaming",
    "tokens",
    "to",
    "terminal",
    "with",
    "colours",
    "spinners",
    "diffs",
];
const CODE: &[&str] = &[
    "let",
    "mut",
    "fn",
    "impl",
    "self.store.push(line);",
    "Option<usize>",
    "->",
    "match",
    "Some(x)",
    "=>",
    "None,",
    "pub(crate)",
    "use std::sync::Arc;",
    "if",
    "else",
    "return",
    "for i in 0..rows {",
    "}",
    "&mut",
    "Vec::with_capacity(n)",
    "as u16",
    "// 주석",
];
const COLORS: &[u8] = &[31, 32, 33, 34, 35, 36, 90];

/// agent-sim 처럼 색 하나와 낱말 4~14개인 짧은 줄이다.
fn short_lines(n: usize) -> Vec<u8> {
    let mut r = Lcg(7);
    let mut out = String::new();
    for i in 0..n {
        let k = 4 + r.next(11);
        let words: Vec<&str> = (0..k).map(|_| WORDS[r.next(WORDS.len())]).collect();
        out.push_str(&format!(
            "\x1b[{}m● \x1b[0m{} {i}\r\n",
            COLORS[i % COLORS.len()],
            words.join(" ")
        ));
    }
    out.into_bytes()
}

/// 코드 118자를 색 6구간으로 칠한 줄이다(`pfmem-scripts/longgen.py` 와 같은 모양).
fn code_lines(n: usize) -> Vec<u8> {
    let mut r = Lcg(3);
    let mut out = Vec::new();
    for _ in 0..n {
        let mut t = String::new();
        while t.len() < 118 {
            t.push_str(CODE[r.next(CODE.len())]);
            t.push(' ');
        }
        let t: String = t.chars().take(118).collect();
        let chars: Vec<char> = t.chars().collect();
        let mut cuts: Vec<usize> = (0..5).map(|_| 1 + r.next(chars.len() - 1)).collect();
        cuts.sort_unstable();
        cuts.dedup();
        cuts.push(chars.len());
        let mut p = 0;
        for c in cuts {
            let piece: String = chars[p..c].iter().collect();
            out.extend_from_slice(
                format!("\x1b[{}m{piece}", COLORS[r.next(COLORS.len())]).as_bytes(),
            );
            p = c;
        }
        out.extend_from_slice(b"\x1b[0m\r\n");
    }
    out
}

fn live() -> f64 {
    LIVE.load(SeqCst) as f64
}

fn wait_until(what: &str, limit: Duration, cond: impl Fn() -> bool) {
    let t0 = Instant::now();
    while !cond() {
        assert!(t0.elapsed() < limit, "{what}: {limit:?} 안에 되지 않았다");
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// 도구 12대에 `data` 를 넣은 뒤 (빈 도구, 출력 중, 비운 뒤) 도구당 바이트다.
fn measure(m: &ToolManager, tag: &str, lines: usize, data: &[u8]) -> (f64, f64, f64) {
    m.set_history_lines(lines);
    let base = live();
    let mut feeds = Vec::new();
    let mut tools: Vec<Arc<Tool>> = Vec::new();
    for i in 0..TOOLS {
        let f = Arc::new(FeedTerm::default());
        let p = Tool::on_term(
            &format!("{tag}-{i}"),
            "m",
            Box::new(Shared(Arc::clone(&f))),
            false,
            None,
            None,
            Stream::new(OUTPUT_RING_BYTES),
        );
        m.adopt(Arc::clone(&p));
        p.spawn_reader();
        feeds.push(f);
        tools.push(p);
    }
    let empty = (live() - base) / TOOLS as f64;
    for f in &feeds {
        f.push(data);
    }
    let want = i64::try_from(data.len()).unwrap();
    wait_until("출력", Duration::from_secs(600), || {
        tools.iter().all(|p| p.stream().unwrap().offset() == want)
    });
    let feeding = (live() - base) / TOOLS as f64;
    assert!(
        tools
            .iter()
            .all(|p| p.with_screen(|s, _| s.history_len()).unwrap() > 0),
        "출력 중 값을 재기 전에 비웠다 — {ENV_SCREEN_IDLE_COMPACT_MS} 를 늘린다"
    );
    wait_until("비우기", Duration::from_secs(60), || {
        tools
            .iter()
            .all(|p| p.with_screen(|s, _| s.history_len()).unwrap() == 0)
    });
    let idle = (live() - base) / TOOLS as f64;
    (empty, feeding, idle)
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "측정(NFR-PRF-10): --release --ignored --nocapture"]
async fn measure_daemon_memory_per_terminal() {
    // SAFETY: 이 시험 바이너리의 시험은 이것 하나이고, 환경을 읽는 등록부를 만들기 전에 한 번 쓴다.
    unsafe { std::env::set_var(ENV_SCREEN_IDLE_COMPACT_MS, IDLE_MS) };
    let m = ToolManager::new("", None);
    let cancel = CancellationToken::new();
    m.spawn_screen_compactor(cancel.clone());

    println!("도구 {TOOLS}대 {COLS}x{ROWS}, 도구당 살아 있는 힙(MB)");
    println!("| 출력 | 기록 줄 | 빈 도구 | 출력 중 | 비운 뒤 |");
    println!("|---|---|---|---|---|");
    let mut rows = Vec::new();
    for lines in [HISTORY_LINES_DEFAULT, OLD_DEFAULT_LINES] {
        // 저장소가 차고 넘치게 상한보다 조금 더 넣는다.
        let n = lines + lines / 4;
        for (name, data) in [("짧은 줄", short_lines(n)), ("코드 120자", code_lines(n))] {
            let m2 = m.clone();
            let tag = format!("{lines}-{name}");
            let (e, f, i) = tokio::task::spawn_blocking(move || measure(&m2, &tag, lines, &data))
                .await
                .unwrap();
            println!(
                "| {name} | {lines} | {:.2} | {:.2} | {:.2} |",
                e / MB,
                f / MB,
                i / MB
            );
            rows.push((lines, f, i));
        }
    }
    cancel.cancel();
    for (lines, feeding, idle) in rows {
        assert!(idle < feeding, "{lines}: 비운 뒤가 출력 중보다 작지 않다");
    }
}
