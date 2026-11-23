//! Go `manager_test.go`·`fsnotify_test.go` (V-ELR-23~26).

use std::collections::BTreeMap;
use std::sync::Mutex as StdMutex;
use std::sync::mpsc::{self, Sender};
use std::time::{Duration, Instant};

use super::*;
use crate::coalesce::Kind;
use crate::pipeline::tests::FakeClock;
use crate::pipeline::{OP_REMOVE, OP_WRITE};

#[derive(Default)]
struct FakeState {
    watched: BTreeMap<String, u32>,
    adds: u32,
    fail_add: HashSet<String>,
}

#[derive(Clone, Default)]
struct FakeBackend {
    st: Arc<StdMutex<FakeState>>,
    tx: Arc<StdMutex<Option<Sender<BackendMsg>>>>,
}

impl Backend for FakeBackend {
    fn add(&mut self, p: &str) -> Result<(), String> {
        let mut s = self.st.lock().unwrap();
        if s.fail_add.contains(p) {
            return Err("nope".into());
        }
        *s.watched.entry(p.into()).or_default() += 1;
        s.adds += 1;
        Ok(())
    }
    fn remove(&mut self, p: &str) -> Result<(), String> {
        self.st.lock().unwrap().watched.remove(p);
        Ok(())
    }
    fn close(&mut self) {
        self.tx.lock().unwrap().take();
    }
}

impl FakeBackend {
    fn list(&self) -> Vec<String> {
        self.st.lock().unwrap().watched.keys().cloned().collect()
    }
    fn send(&self, m: BackendMsg) {
        if let Some(tx) = self.tx.lock().unwrap().as_ref() {
            let _ = tx.send(m);
        }
    }
}

type Emitted = Arc<StdMutex<(Vec<Change>, u32)>>;

struct Fx {
    clk: Arc<FakeClock>,
    backends: Arc<StdMutex<Vec<FakeBackend>>>,
    emitted: Emitted,
    m: Manager,
}

impl Drop for Fx {
    fn drop(&mut self) {
        self.m.close();
    }
}

fn fx_with(watchable: WatchableFn, exists: bool) -> Fx {
    let clk = Arc::new(FakeClock::default());
    let backends: Arc<StdMutex<Vec<FakeBackend>>> = Arc::default();
    let emitted: Emitted = Arc::default();
    let (b2, e2) = (Arc::clone(&backends), Arc::clone(&emitted));
    let m = Manager::new(ManagerOptions {
        new_backend: Arc::new(move || {
            let (tx, rx) = mpsc::channel();
            let b = FakeBackend::default();
            *b.tx.lock().unwrap() = Some(tx);
            b2.lock().unwrap().push(b.clone());
            Ok((Box::new(b) as Box<dyn Backend>, rx))
        }),
        clock: clk.clone(),
        case_sensitive: true,
        nfc: false,
        watchable,
        exists: Arc::new(move |_| exists),
        emit: Arc::new(move |c, ov| {
            let mut g = e2.lock().unwrap();
            g.0.extend_from_slice(c);
            if ov {
                g.1 += 1;
            }
        }),
    });
    Fx {
        clk,
        backends,
        emitted,
        m,
    }
}

fn fx() -> Fx {
    fx_with(Arc::new(|_| true), true)
}

impl Fx {
    fn backend(&self) -> FakeBackend {
        self.backends.lock().unwrap().last().unwrap().clone()
    }
    fn count(&self) -> usize {
        self.backends.lock().unwrap().len()
    }
}

fn dirs(pairs: &[(&str, &str)]) -> Vec<Dir> {
    pairs
        .iter()
        .map(|(p, r)| Dir {
            path: (*p).into(),
            real: (*r).into(),
        })
        .collect()
}

fn wait_for(cond: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(2);
    while Instant::now() < deadline {
        if cond() {
            return;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    panic!("조건이 서지 않았다");
}

#[test]
fn set_requires_attach() {
    let f = fx();
    assert_eq!(f.m.set("c1", &dirs(&[("/a", "/a")])), Err(NotAttached));
    assert_eq!(f.m.set("", &dirs(&[("/a", "/a")])), Err(NotAttached));
    assert_eq!(NotAttached.to_string(), "fswatch: client not attached");
}

#[test]
fn shared_dir_watched_once_and_lease_scoped() {
    let f = fx();
    let e1 = f.m.attach("c1");
    let e2 = f.m.attach("c2");
    f.m.set("c1", &dirs(&[("/a", "/a"), ("/b", "/b")])).unwrap();
    f.m.set("c2", &dirs(&[("/a", "/a")])).unwrap();
    let b = f.backend();
    assert_eq!(b.list(), ["/a", "/b"]);
    assert_eq!(b.st.lock().unwrap().adds, 2);
    f.m.detach("c1", e1);
    assert_eq!(b.list(), ["/a"]);
    f.m.detach("c2", e2);
    assert!(b.list().is_empty());
}

#[test]
fn set_replaces_whole_set() {
    let f = fx();
    f.m.attach("c1");
    f.m.set("c1", &dirs(&[("/a", "/a"), ("/b", "/b")])).unwrap();
    let got = f.m.set("c1", &dirs(&[("/c", "/c"), ("/b", "/b")])).unwrap();
    assert_eq!(got, ["/b", "/c"]);
    assert_eq!(f.backend().list(), ["/b", "/c"]);
}

#[test]
fn stale_detach_ignored() {
    let f = fx();
    let old = f.m.attach("c1");
    f.m.attach("c1");
    f.m.set("c1", &dirs(&[("/a", "/a")])).unwrap();
    f.m.detach("c1", old);
    assert_eq!(f.backend().list().len(), 1);
}

#[test]
fn failed_add_excluded() {
    let f = fx();
    f.m.attach("c1");
    f.m.set("c1", &[]).unwrap();
    f.backend()
        .st
        .lock()
        .unwrap()
        .fail_add
        .insert("/bad".into());
    assert_eq!(
        f.m.set("c1", &dirs(&[("/ok", "/ok"), ("/bad", "/bad")]))
            .unwrap(),
        ["/ok"]
    );
}

#[test]
fn unwatchable_excluded() {
    let f = fx_with(Arc::new(|p| p != "/Volumes/x"), true);
    f.m.attach("c1");
    let got =
        f.m.set("c1", &dirs(&[("/Volumes/x", "/Volumes/x"), ("/ok", "/ok")]))
            .unwrap();
    assert_eq!(got, ["/ok"]);
}

#[test]
fn events_use_registered_spellings() {
    let f = fx();
    f.m.attach("c1");
    f.m.attach("c2");
    let p = filepath::from_slash;
    f.m.set("c1", &dirs(&[(&p("/link/d"), &p("/real/d"))]))
        .unwrap();
    f.m.set("c2", &dirs(&[(&p("/real/d"), &p("/real/d"))]))
        .unwrap();
    f.m.handle_raw(RawEvent {
        name: p("/real/d/x.txt"),
        op: OP_WRITE,
    });
    f.clk.advance(Duration::from_secs(1));
    let got = f.emitted.lock().unwrap().0.clone();
    assert_eq!(
        got,
        [
            Change::new(p("/link/d/x.txt"), Kind::Updated),
            Change::new(p("/real/d/x.txt"), Kind::Updated)
        ]
    );
}

#[test]
fn events_outside_watched_dirs_dropped() {
    let f = fx();
    f.m.attach("c1");
    f.m.set("c1", &dirs(&[("/a", "/a")])).unwrap();
    f.m.handle_raw(RawEvent {
        name: "/zzz/x".into(),
        op: OP_WRITE,
    });
    f.clk.advance(Duration::from_secs(1));
    assert!(f.emitted.lock().unwrap().0.is_empty());
}

#[test]
fn watched_dir_itself_deleted() {
    let f = fx_with(Arc::new(|_| true), false);
    f.m.attach("c1");
    f.m.set("c1", &dirs(&[("/a/sub", "/a/sub")])).unwrap();
    f.m.handle_raw(RawEvent {
        name: "/a/sub".into(),
        op: OP_REMOVE,
    });
    f.clk.advance(Duration::from_secs(1));
    assert_eq!(
        f.emitted.lock().unwrap().0,
        [Change::new("/a/sub", Kind::Deleted)]
    );
}

#[test]
fn restarts_on_error_up_to_five() {
    let f = fx();
    f.m.attach("c1");
    f.m.set("c1", &dirs(&[("/a", "/a")])).unwrap();
    for i in 1..=MAX_RESTARTS as usize {
        f.backend()
            .send(BackendMsg::Error(BackendError::Other("boom".into())));
        wait_for(|| f.count() == i + 1 && f.backend().list() == ["/a"]);
    }
    f.backend()
        .send(BackendMsg::Error(BackendError::Other("boom".into())));
    std::thread::sleep(Duration::from_millis(50));
    assert_eq!(f.count(), MAX_RESTARTS as usize + 1);
}

#[test]
fn no_restart_on_exhaustion() {
    let f = fx();
    f.m.attach("c1");
    f.m.set("c1", &dirs(&[("/a", "/a")])).unwrap();
    f.backend().send(BackendMsg::Error(BackendError::Exhausted(
        "too many open files".into(),
    )));
    std::thread::sleep(Duration::from_millis(80));
    assert_eq!(f.count(), 1);
}

#[test]
fn overflow_error_signals_overflow() {
    let f = fx();
    f.m.attach("c1");
    f.m.set("c1", &dirs(&[("/a", "/a")])).unwrap();
    f.backend().send(BackendMsg::Error(BackendError::Overflow));
    wait_for(|| f.emitted.lock().unwrap().1 == 1);
    assert_eq!(f.count(), 1);
}

// 실제 백엔드(notify)로 일반 쓰기·원자적 쓰기·추가·삭제가 이벤트로 나오는지 잰다.
#[cfg(not(windows))]
#[test]
fn real_backend_reports_changes() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = filepath::eval_symlinks(&tmp.path().to_string_lossy()).unwrap();
    let file = filepath::join(&[dir.as_str(), "a.txt"]);
    std::fs::write(&file, "one\n").unwrap();
    let seen: Arc<StdMutex<HashMap<String, Vec<Kind>>>> = Arc::default();
    let s2 = Arc::clone(&seen);
    let m = Manager::new(ManagerOptions::defaults(Arc::new(move |c, _| {
        let mut g = s2.lock().unwrap();
        for x in c {
            g.entry(x.path.clone()).or_default().push(x.kind);
        }
    })));
    m.attach("c1");
    let got = m
        .set(
            "c1",
            &[Dir {
                path: dir.clone(),
                real: dir.clone(),
            }],
        )
        .unwrap();
    assert_eq!(got.len(), 1);
    let has = |p: &str, k: Kind| seen.lock().unwrap().get(p).is_some_and(|v| v.contains(&k));
    let wait = |cond: &dyn Fn() -> bool| {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !cond() {
            assert!(Instant::now() < deadline, "이벤트가 오지 않았다");
            std::thread::sleep(Duration::from_millis(10));
        }
    };
    let reset = || seen.lock().unwrap().clear();

    std::fs::write(&file, "two\n").unwrap();
    wait(&|| has(&file, Kind::Updated));

    reset();
    let tmpf = filepath::join(&[dir.as_str(), ".a.txt.tmp"]);
    std::fs::write(&tmpf, "three\n").unwrap();
    std::fs::rename(&tmpf, &file).unwrap();
    wait(&|| has(&file, Kind::Updated) || has(&file, Kind::Added));
    assert!(!has(&file, Kind::Deleted), "원자적 저장이 삭제로 보였다");

    reset();
    let nf = filepath::join(&[dir.as_str(), "b.txt"]);
    std::fs::write(&nf, "x").unwrap();
    wait(&|| has(&nf, Kind::Added));

    reset();
    std::fs::remove_file(&nf).unwrap();
    wait(&|| has(&nf, Kind::Deleted));
    m.close();
}

#[cfg(windows)]
#[test]
fn watchable_windows_never() {
    let tmp = tempfile::tempdir().unwrap();
    assert!(!crate::os::watchable(&tmp.path().to_string_lossy()));
}
