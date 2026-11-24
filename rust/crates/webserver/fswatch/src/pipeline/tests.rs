//! Go `pipeline_test.go` (V-ELR-21·22).

use std::sync::Mutex as StdMutex;

use super::*;

struct Timer {
    at: Duration,
    seq: u64,
    f: Option<TimerFn>,
}

#[derive(Default)]
struct FakeInner {
    now: Duration,
    seq: u64,
    timers: Vec<Timer>,
}

/// 가짜 시계. advance 가 그 사이에 마감이 온 타이머를 차례로 부른다.
#[derive(Default)]
pub(crate) struct FakeClock(StdMutex<FakeInner>);

impl Clock for FakeClock {
    fn after_func(&self, d: Duration, f: TimerFn) {
        let mut g = self.0.lock().unwrap();
        g.seq += 1;
        let (at, seq) = (g.now + d, g.seq);
        g.timers.push(Timer {
            at,
            seq,
            f: Some(f),
        });
    }
}

impl FakeClock {
    pub(crate) fn now(&self) -> Duration {
        self.0.lock().unwrap().now
    }

    pub(crate) fn advance(&self, d: Duration) {
        let end = self.0.lock().unwrap().now + d;
        loop {
            let f = {
                let mut g = self.0.lock().unwrap();
                g.timers.retain(|t| t.f.is_some());
                g.timers.sort_by_key(|t| (t.at, t.seq));
                match g.timers.iter_mut().find(|t| t.at <= end) {
                    Some(t) => {
                        let at = t.at;
                        let f = t.f.take();
                        g.now = at;
                        f
                    }
                    None => {
                        g.now = end;
                        return;
                    }
                }
            };
            if let Some(f) = f {
                f();
            }
        }
    }
}

type Outs = Arc<StdMutex<Vec<(Duration, Vec<Change>, bool)>>>;

struct Fx {
    clk: Arc<FakeClock>,
    exists: Arc<StdMutex<HashMap<String, bool>>>,
    outs: Outs,
    p: Pipeline,
}

fn fx(nfc: bool) -> Fx {
    let clk = Arc::new(FakeClock::default());
    let exists: Arc<StdMutex<HashMap<String, bool>>> = Arc::default();
    let outs: Outs = Arc::default();
    let (e, o, c) = (Arc::clone(&exists), Arc::clone(&outs), Arc::clone(&clk));
    let p = Pipeline::new(PipelineOptions {
        clock: clk.clone(),
        exists: Arc::new(move |p| e.lock().unwrap().get(p).copied().unwrap_or(false)),
        case_sensitive: true,
        nfc,
        out: Arc::new(move |cs, ov| o.lock().unwrap().push((c.now(), cs.to_vec(), ov))),
    });
    Fx {
        clk,
        exists,
        outs,
        p,
    }
}

fn raw(n: &str, op: Op) -> RawEvent {
    RawEvent { name: n.into(), op }
}

impl Fx {
    fn got(&self) -> Vec<(Duration, Vec<Change>, bool)> {
        self.outs.lock().unwrap().clone()
    }
}

const SEC: Duration = Duration::from_secs(1);
const MS: Duration = Duration::from_millis(1);

#[test]
fn create_write_map_to_added_updated() {
    let f = fx(false);
    f.p.push(raw("/r/a", OP_CREATE));
    f.p.push(raw("/r/b", OP_WRITE));
    f.clk.advance(CHANGES_DELAY);
    let o = f.got();
    assert_eq!(o.len(), 1);
    assert_eq!(
        o[0].1,
        [
            Change::new("/r/a", Kind::Added),
            Change::new("/r/b", Kind::Updated)
        ]
    );
}

#[test]
fn chmod_ignored() {
    let f = fx(false);
    f.p.push(raw("/r/a", OP_CHMOD));
    f.clk.advance(SEC);
    assert!(f.got().is_empty());
}

#[test]
fn rename_recheck_exists_is_updated() {
    let f = fx(false);
    f.exists.lock().unwrap().insert("/r/a".into(), true);
    f.p.push(raw("/r/a", OP_RENAME));
    f.clk.advance(DELETE_RECHECK_DELAY - MS);
    assert!(f.got().is_empty(), "100ms 전에 나갔다");
    f.clk.advance(SEC);
    let o = f.got();
    assert_eq!(o.len(), 1);
    assert_eq!(o[0].1, [Change::new("/r/a", Kind::Updated)]);
}

#[test]
fn remove_recheck_missing_is_deleted() {
    let f = fx(false);
    f.p.push(raw("/r/a", OP_REMOVE));
    f.clk.advance(SEC);
    assert_eq!(f.got()[0].1, [Change::new("/r/a", Kind::Deleted)]);
}

#[test]
fn atomic_save_is_not_delete() {
    let f = fx(false);
    f.exists.lock().unwrap().insert("/r/a".into(), true);
    f.p.push(raw("/r/a.tmp", OP_CREATE));
    f.p.push(raw("/r/a.tmp", OP_RENAME));
    f.p.push(raw("/r/a", OP_RENAME));
    f.p.push(raw("/r/a", OP_CREATE));
    f.clk.advance(SEC);
    let for_a: Vec<Kind> = f
        .got()
        .into_iter()
        .flat_map(|o| o.1)
        .filter(|c| c.path == "/r/a")
        .map(|c| c.kind)
        .collect();
    assert!(!for_a.is_empty());
    assert!(!for_a.contains(&Kind::Deleted), "{for_a:?}");
}

#[test]
fn nfc_normalizes_base_name() {
    let f = fx(true);
    f.p.push(raw(
        &filepath::from_slash("/r/\u{1112}\u{1161}\u{11ab}.md"),
        OP_WRITE,
    ));
    f.clk.advance(SEC);
    let o = f.got();
    assert_eq!(o.len(), 1);
    assert_eq!(o[0].1[0].path, filepath::from_slash("/r/한.md"));
}

#[test]
fn batches_within_75ms() {
    let f = fx(false);
    f.p.push(raw("/r/a", OP_WRITE));
    f.clk.advance(50 * MS);
    f.p.push(raw("/r/b", OP_WRITE));
    f.clk.advance(24 * MS);
    assert!(f.got().is_empty());
    f.clk.advance(MS);
    let o = f.got();
    assert_eq!(o.len(), 1);
    assert_eq!(o[0].1.len(), 2);
}

#[test]
fn chunks_of_100_with_200ms_pause() {
    let f = fx(false);
    for i in 0..=CHUNK_SIZE {
        f.p.push(raw(&format!("/r/f{i:03}"), OP_WRITE));
    }
    f.clk.advance(SEC);
    let o = f.got();
    assert_eq!(o.len(), 2);
    assert_eq!((o[0].1.len(), o[1].1.len()), (CHUNK_SIZE, 1));
    assert!(o[1].0 - o[0].0 >= CHUNK_PAUSE);
}

#[test]
fn overflow_signals_once() {
    let f = fx(false);
    for i in 0..MAX_BUFFERED + 50 {
        f.p.push(raw(&format!("/r/f{i:05}"), OP_WRITE));
    }
    f.clk.advance(Duration::from_secs(3600));
    let o = f.got();
    assert_eq!(o.iter().filter(|x| x.2).count(), 1);
    assert!(o.iter().map(|x| x.1.len()).sum::<usize>() <= MAX_BUFFERED);
}

#[test]
fn real_clock_fires_in_order() {
    let (tx, rx) = std::sync::mpsc::channel();
    let t2 = tx.clone();
    RealClock.after_func(30 * MS, Box::new(move || t2.send(2).unwrap()));
    RealClock.after_func(5 * MS, Box::new(move || tx.send(1).unwrap()));
    assert_eq!(rx.recv_timeout(SEC).unwrap(), 1);
    assert_eq!(rx.recv_timeout(SEC).unwrap(), 2);
}
