use super::*;

fn x(n: usize) -> Vec<u8> {
    vec![b'x'; n]
}

fn since_ok(s: &Stream, off: i64) -> Option<(Vec<u8>, i64)> {
    match s.since(off) {
        (Some(d), end) => Some((d, end)),
        (None, _) => None,
    }
}

// --- restore_test.go

#[test]
fn restore_continues_coordinates() {
    let s = Stream::restore(16, b"hello", 1000);
    assert_eq!(s.offset(), 1000);
    assert_eq!(s.snapshot().0, b"hello");
    assert_eq!(s.feed(b"!").1, 1001);
    assert_eq!(since_ok(&s, 999), Some((b"o!".to_vec(), 1001)));
}

#[test]
fn restore_keeps_tail_within_max() {
    let s = Stream::restore(4, b"abcdefgh", 8);
    assert_eq!(s.snapshot().0, b"efgh");
    assert_eq!(s.offset(), 8);
}

// --- resume_test.go

#[test]
fn feed_returns_end_offset() {
    let s = Stream::new(100);
    assert_eq!(s.feed(b"abc").1, 3);
    assert_eq!(s.feed(b"de").1, 5);
    assert_eq!(s.offset(), 5);
}

#[test]
fn feed_end_survives_compaction() {
    let s = Stream::new(100);
    let mut end = 0;
    for _ in 0..5 {
        end = s.feed(&x(50)).1;
    }
    assert_eq!(end, 250);
}

#[test]
fn since_inside_window() {
    let s = Stream::new(100);
    s.feed(b"hello");
    s.feed(b"world");
    assert_eq!(since_ok(&s, 5), Some((b"world".to_vec(), 10)));
}

#[test]
fn since_from_zero() {
    let s = Stream::new(100);
    s.feed(b"abcde");
    assert_eq!(since_ok(&s, 0).map(|v| v.0), Some(b"abcde".to_vec()));
}

#[test]
fn since_at_end() {
    let s = Stream::new(100);
    s.feed(b"abc");
    assert_eq!(since_ok(&s, 3), Some((Vec::new(), 3)));
}

#[test]
fn since_empty_stream() {
    let s = Stream::new(100);
    assert_eq!(since_ok(&s, 0), Some((Vec::new(), 0)));
}

#[test]
fn since_negative() {
    let s = Stream::new(100);
    s.feed(b"abc");
    assert_eq!(s.since(-1), (None, 3));
}

#[test]
fn since_beyond_end() {
    let s = Stream::new(100);
    s.feed(b"abc");
    assert_eq!(s.since(4), (None, 3));
}

#[test]
fn since_outside_window_after_compaction() {
    let s = Stream::new(100);
    s.feed(&x(250));
    assert!(since_ok(&s, 0).is_none());
    let (d, end) = since_ok(&s, 150).expect("off=150");
    assert_eq!((d.len(), end), (100, 250));
    assert!(since_ok(&s, 149).is_none());
}

#[test]
fn since_window_matches_snapshot() {
    let s = Stream::new(100);
    let (_, end) = s.feed(&x(150));
    let (snap, _) = s.snapshot();
    let (d, _) = since_ok(&s, end - snap.len() as i64).expect("in window");
    assert_eq!(d, snap);
    assert!(since_ok(&s, end - snap.len() as i64 - 1).is_none());
}

#[test]
fn since_isolation() {
    let s = Stream::new(100);
    s.feed(b"hello");
    let (d, _) = since_ok(&s, 0).unwrap();
    s.feed(b"world");
    assert_eq!(d, b"hello");
}

#[test]
fn since_after_close() {
    let s = Stream::new(100);
    s.feed(b"abc");
    s.close();
    assert!(since_ok(&s, 3).is_some());
}

// --- stream_test.go

#[test]
fn feed_below_max() {
    let s = Stream::new(100);
    assert_eq!(s.feed(&x(50)).0, 0);
    assert_eq!(s.len(), 50);
}

#[test]
fn feed_above_max() {
    let s = Stream::new(100);
    s.feed(&x(250));
    let (snap, st) = s.snapshot();
    assert_eq!(snap.len(), 100);
    assert_eq!(st.total_bytes_drop, 150);
}

#[test]
fn multiple_feeds() {
    let s = Stream::new(100);
    s.feed(&[b'A'; 50]);
    s.feed(&[b'B'; 50]);
    s.feed(&[b'C'; 50]);
    let (snap, _) = s.snapshot();
    assert_eq!(snap.len(), 100);
    assert!(snap[50..].iter().all(|&b| b == b'C'));
    assert!(snap[..50].iter().all(|&b| b == b'B'));
}

#[test]
fn no_phantom_drops() {
    let s = Stream::new(100);
    for _ in 0..5 {
        s.feed(&x(50));
    }
    let (_, st) = s.snapshot();
    assert_eq!(st.total_bytes_drop, 150);
    assert_eq!(st.total_bytes_in, 250);
}

#[test]
fn snapshot_isolation() {
    let s = Stream::new(100);
    s.feed(b"hello");
    let (snap, _) = s.snapshot();
    s.feed(b"world");
    assert_eq!(snap, b"hello");
}

#[test]
fn feed_max_to_2max_no_drop_count() {
    let s = Stream::new(100);
    assert_eq!(s.feed(&x(150)).0, 0);
    assert_eq!(s.len(), 100);
    let (snap, st) = s.snapshot();
    assert_eq!(snap.len(), 100);
    assert_eq!(st.total_bytes_drop, 0);
    assert_eq!(st.total_bytes_in, 150);
}

#[test]
fn feed_above_2max_compaction() {
    let s = Stream::new(100);
    assert_eq!(s.feed(&x(250)).0, 150);
    let (snap, st) = s.snapshot();
    assert_eq!(snap.len(), 100);
    assert_eq!(st.total_bytes_drop, 150);
    assert_eq!(st.total_bytes_in, 250);
}

#[test]
fn close_then_feed() {
    let s = Stream::new(100);
    s.feed(b"data");
    s.close();
    assert_eq!(s.len(), 0);
    s.feed(b"more");
    assert_eq!(s.snapshot().0, b"more");
    assert_eq!(s.offset(), 8);
}

#[test]
fn snapshot_stats() {
    let s = Stream::new(100);
    s.feed(&[b'a'; 50]);
    let (snap, st) = s.snapshot();
    assert_eq!(snap.len(), 50);
    assert_eq!(
        st,
        Stats {
            total_bytes_in: 50,
            total_bytes_drop: 0,
            retained: 50
        }
    );
}

#[test]
fn len_above_max() {
    let s = Stream::new(100);
    s.feed(&x(200));
    assert_eq!(s.len(), 100);
}

#[test]
fn feed_does_not_retain_input() {
    let s = Stream::new(100);
    let mut raw = b"hello".to_vec();
    s.feed(&raw);
    raw.copy_from_slice(b"XXXXX");
    assert_eq!(s.snapshot().0, b"hello");
}

// --- ring_test.go: 종전 구현(2*max 까지 키우고 넘치면 max 로 compaction)과 같아야 한다.

struct RefStream {
    buf: Vec<u8>,
    max: usize,
    total_in: i64,
    total_drop: i64,
}

impl RefStream {
    fn feed(&mut self, p: &[u8]) -> (usize, i64) {
        self.total_in += p.len() as i64;
        self.buf.extend_from_slice(p);
        let mut dropped = 0;
        if self.buf.len() > self.max && self.buf.len() > 2 * self.max {
            let over = self.buf.len() - self.max;
            self.buf.drain(..over);
            dropped = over;
            self.total_drop += over as i64;
        }
        (dropped, self.total_in)
    }

    fn retained(&self) -> usize {
        self.buf.len().min(self.max)
    }

    fn since(&self, off: i64) -> (Option<Vec<u8>>, i64) {
        let end = self.total_in;
        if off < 0 || off > end {
            return (None, end);
        }
        let ret = self.retained();
        let start = end - ret as i64;
        if off < start {
            return (None, end);
        }
        let tail = &self.buf[self.buf.len() - ret..];
        (Some(tail[(off - start) as usize..].to_vec()), end)
    }

    fn snapshot(&self) -> (Vec<u8>, Stats) {
        let out = self.buf[self.buf.len() - self.retained()..].to_vec();
        let st = Stats {
            total_bytes_in: self.total_in,
            total_bytes_drop: self.total_drop,
            retained: out.len(),
        };
        (out, st)
    }
}

/// 결정론적 의사 난수(splitmix64)다. 시험 재현용이다.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

#[test]
fn ring_matches_reference() {
    for max in [0usize, 1, 7, 100, 4096] {
        for seed in 1..=40u64 {
            let mut rng = Rng(seed * 1000 + max as u64);
            let s = Stream::new(max);
            let mut r = RefStream {
                buf: Vec::new(),
                max,
                total_in: 0,
                total_drop: 0,
            };
            let mut fed: u8 = 0;
            for step in 0..300 {
                if rng.below(40) == 0 {
                    s.close();
                    r.buf.clear();
                } else {
                    let mut n = rng.below(3 * max as u64 + 3) as usize;
                    if rng.below(4) == 0 {
                        n = rng.below(8) as usize;
                    }
                    let p: Vec<u8> = (0..n)
                        .map(|_| {
                            fed = fed.wrapping_add(1);
                            fed
                        })
                        .collect();
                    assert_eq!(
                        s.feed(&p),
                        r.feed(&p),
                        "max={max} seed={seed} step={step} feed({n})"
                    );
                }
                assert_eq!(
                    s.snapshot(),
                    r.snapshot(),
                    "max={max} seed={seed} step={step}"
                );
                assert_eq!(s.len(), r.retained());
                let end = r.total_in;
                let m = max as i64;
                let rnd = rng.below(max as u64 + 2) as i64;
                for off in [-1, 0, end, end + 1, end - m, end - m - 1, end - rnd] {
                    assert_eq!(
                        s.since(off),
                        r.since(off),
                        "max={max} seed={seed} step={step} since({off})"
                    );
                }
            }
        }
    }
}

#[test]
fn ring_no_preallocation() {
    const MAX: usize = 1 << 20;
    let s = Stream::new(MAX);
    s.feed(b"hi");
    assert!(s.capacity() < MAX, "cap={}", s.capacity());
}

#[test]
fn ring_no_reallocation_when_full() {
    const MAX: usize = 1 << 16;
    let s = Stream::new(MAX);
    let chunk = x(8 << 10);
    for _ in 0..2 * MAX / chunk.len() {
        s.feed(&chunk);
    }
    assert_eq!(s.capacity(), MAX);
    let base = s.buf_ptr();
    for _ in 0..100 {
        s.feed(&chunk);
    }
    assert_eq!(s.capacity(), MAX);
    assert_eq!(s.buf_ptr(), base, "찬 뒤 feed 가 버퍼를 바꿨다");
}
