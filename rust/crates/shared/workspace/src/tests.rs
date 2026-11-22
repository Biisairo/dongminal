use std::collections::{BTreeSet, HashSet};
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use super::*;

// ── 가짜 ──

#[derive(Default)]
struct FakeLive(Mutex<HashSet<String>>);

impl FakeLive {
    fn of(ids: &[&str]) -> Arc<Self> {
        Arc::new(Self(Mutex::new(ids.iter().map(|s| (*s).to_owned()).collect())))
    }
    fn set(&self, id: &str, live: bool) {
        let mut g = self.0.lock().unwrap();
        if live {
            g.insert(id.to_owned());
        } else {
            g.remove(id);
        }
    }
}

impl Liveness for FakeLive {
    fn is_live(&self, id: &str) -> bool {
        self.0.lock().unwrap().contains(id)
    }
}

#[derive(Default)]
struct MemState {
    data: Vec<u8>,
    empty: bool,
    wrote: usize,
}

#[derive(Default)]
struct MemPersister(Mutex<MemState>);

impl MemPersister {
    fn empty() -> Arc<Self> {
        Arc::new(Self(Mutex::new(MemState {
            empty: true,
            ..Default::default()
        })))
    }
    fn with(data: &str) -> Arc<Self> {
        Arc::new(Self(Mutex::new(MemState {
            data: data.as_bytes().to_vec(),
            ..Default::default()
        })))
    }
    fn wrote(&self) -> usize {
        self.0.lock().unwrap().wrote
    }
    fn data(&self) -> Vec<u8> {
        self.0.lock().unwrap().data.clone()
    }
}

impl Persister for MemPersister {
    fn read(&self) -> io::Result<Vec<u8>> {
        let g = self.0.lock().unwrap();
        if g.empty {
            return Err(io::ErrorKind::NotFound.into());
        }
        Ok(g.data.clone())
    }
    fn write(&self, b: &[u8]) -> io::Result<()> {
        let mut g = self.0.lock().unwrap();
        g.data = b.to_vec();
        g.empty = false;
        g.wrote += 1;
        Ok(())
    }
}

/// 느린 디스크를 흉내 낸다 — 재려는 상황을 만드는 주입 지연이다.
struct SlowPersister {
    inner: Arc<MemPersister>,
    delay: Duration,
}

impl Persister for SlowPersister {
    fn read(&self) -> io::Result<Vec<u8>> {
        self.inner.read()
    }
    fn write(&self, b: &[u8]) -> io::Result<()> {
        std::thread::sleep(self.delay);
        self.inner.write(b)
    }
}

/// 모든 쓰기를 release 까지 막는다.
struct GatedPersister {
    entered: AtomicUsize,
    wrote: AtomicUsize,
    release: Mutex<bool>,
    cv: Condvar,
}

impl GatedPersister {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            entered: AtomicUsize::new(0),
            wrote: AtomicUsize::new(0),
            release: Mutex::new(false),
            cv: Condvar::new(),
        })
    }
    fn open(&self) {
        *self.release.lock().unwrap() = true;
        self.cv.notify_all();
    }
}

impl Persister for GatedPersister {
    fn read(&self) -> io::Result<Vec<u8>> {
        Err(io::ErrorKind::NotFound.into())
    }
    fn write(&self, _: &[u8]) -> io::Result<()> {
        self.entered.fetch_add(1, Ordering::SeqCst);
        let mut g = self.release.lock().unwrap();
        while !*g {
            g = self.cv.wait(g).unwrap();
        }
        self.wrote.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}

struct ErrorPersister(Option<io::ErrorKind>);

impl Persister for ErrorPersister {
    fn read(&self) -> io::Result<Vec<u8>> {
        match self.0 {
            Some(k) => Err(io::Error::new(k, "disk fail")),
            None => Ok(Vec::new()),
        }
    }
    fn write(&self, _: &[u8]) -> io::Result<()> {
        Ok(())
    }
}

#[derive(Default)]
struct FailingStore {
    blob: Mutex<Vec<u8>>,
    fail: AtomicBool,
}

impl Persister for FailingStore {
    fn read(&self) -> io::Result<Vec<u8>> {
        Ok(self.blob.lock().unwrap().clone())
    }
    fn write(&self, b: &[u8]) -> io::Result<()> {
        if self.fail.load(Ordering::SeqCst) {
            return Err(io::Error::other("disk full"));
        }
        *self.blob.lock().unwrap() = b.to_vec();
        Ok(())
    }
}

fn wait_for(cond: impl Fn() -> bool, timeout: Duration, msg: &str) {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if cond() {
            return;
        }
        std::thread::sleep(Duration::from_millis(2));
    }
    panic!("timeout waiting for {msg}");
}

fn wait_persist(cond: impl Fn() -> bool) -> bool {
    for _ in 0..200 {
        if cond() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    false
}

// ── 픽스처 ──

const SAMPLE_WS: &str = r#"{
  "activeWindow": "s1",
  "schemaVersion": 2, "windows": [
    {
      "id": "s1",
      "name": "main",
      "focusedPane": "r1",
      "layout": {
        "type": "split",
        "direction": "row",
        "children": [
          {
            "type": "pane",
            "id": "r1",
            "activeTab": "t1",
            "tabs": [
              {"id": "t1", "name": "build", "toolId": "10"},
              {"id": "t2", "name": "run",   "toolId": "11"}
            ]
          },
          {
            "type": "pane",
            "id": "r2",
            "activeTab": "t3",
            "tabs": [
              {"id": "t3", "name": "logs", "toolId": "12"}
            ]
          }
        ]
      }
    }
  ]
}"#;

const SAMPLE_V1: &str = r#"{
  "activeSession": "s1",
  "sessions": [
    {"id":"s1","name":"main","focusedRegion":"r1","layout":{
      "type":"region","id":"r1","activeTab":"t1",
      "tabs":[{"id":"t1","name":"build","toolId":"10"}]}}
  ]
}"#;

const SAMPLE_V2: &str = SAMPLE_WS;

const GOOD_WS: &str = r#"{"schemaVersion":2,"windows":[]}"#;

/// ws 와 색인은 같고 바이트만 다른 본문이다.
fn variant_ws(ws: &str, n: usize) -> Vec<u8> {
    ws.replacen('{', &format!(r#"{{"_n":{n},"#), 1).into_bytes()
}

fn live3() -> Arc<FakeLive> {
    FakeLive::of(&["10", "11", "12"])
}

fn mgr(live: Arc<dyn Liveness>, store: Arc<dyn Persister>) -> Manager {
    Manager::new(live, store).unwrap()
}

const U_WINDOW: &str = "550e8400-e29b-41d4-a716-4466554400a1";
const U_PANE: &str = "550e8400-e29b-41d4-a716-4466554400a2";
const U_TAB: &str = "550e8400-e29b-41d4-a716-4466554400a3";
const U_TOOL_ID: &str = "9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f";
const LEGACY_ID: &str = "267";

fn blob_with_tool(tool_id: &str) -> String {
    format!(
        r#"{{"activeWindow":"{U_WINDOW}","schemaVersion":2,"windows":[{{"id":"{U_WINDOW}","name":"Main","focusedPane":"{U_PANE}","layout":{{"type":"pane","id":"{U_PANE}","activeTab":"{U_TAB}","tabs":[{{"id":"{U_TAB}","name":"Shell","toolId":"{tool_id}"}}]}}}}]}}"#
    )
}

fn manager_with_blob(live: &[&str], blob: &str) -> Manager {
    let m = mgr(FakeLive::of(live), Arc::new(ErrorPersister(None)));
    if !blob.is_empty() {
        m.save(blob.as_bytes(), "").unwrap();
    }
    m
}

fn sorted(s: HashSet<String>) -> Vec<String> {
    s.into_iter().collect::<BTreeSet<_>>().into_iter().collect()
}

// ── 저장·큐 ──

#[test]
fn save_is_non_blocking() {
    let store = Arc::new(SlowPersister {
        inner: MemPersister::empty(),
        delay: Duration::from_millis(100),
    });
    let m = mgr(live3(), store);
    let start = Instant::now();
    m.save(SAMPLE_WS.as_bytes(), "").unwrap();
    assert!(start.elapsed() < Duration::from_millis(20), "{:?}", start.elapsed());
}

#[test]
fn save_coalescing() {
    let store = GatedPersister::new();
    let m = mgr(live3(), store.clone());
    const N: usize = 10;
    for _ in 0..N {
        m.save(SAMPLE_WS.as_bytes(), "").unwrap();
    }
    wait_for(
        || store.entered.load(Ordering::SeqCst) > 0,
        Duration::from_secs(5),
        "쓰기가 첫 뭉치를 집어 문에서 막히기",
    );
    store.open();
    m.close();
    let got = store.wrote.load(Ordering::SeqCst);
    assert!(got < N && got <= 2, "writes={got}");
}

#[test]
fn close_flushes_pending() {
    let inner = MemPersister::empty();
    let store = Arc::new(SlowPersister {
        inner: inner.clone(),
        delay: Duration::from_millis(30),
    });
    let m = mgr(live3(), store);
    m.save(SAMPLE_WS.as_bytes(), "").unwrap();
    m.close();
    assert!(inner.wrote() >= 1);
    assert_eq!(inner.data(), SAMPLE_WS.as_bytes());
}

#[test]
fn close_is_idempotent_and_later_saves_stay_in_memory() {
    let store = MemPersister::empty();
    let m = mgr(live3(), store.clone());
    m.close();
    m.close();
    assert_eq!(m.save(SAMPLE_WS.as_bytes(), "").unwrap(), 1);
    std::thread::sleep(Duration::from_millis(20));
    assert_eq!(store.wrote(), 0);
    assert_eq!(m.raw().as_slice(), SAMPLE_WS.as_bytes());
}

#[test]
fn save_stale() {
    let m = mgr(live3(), MemPersister::empty());
    assert_eq!(m.current_rev(), 0);
    assert_eq!(m.save(SAMPLE_WS.as_bytes(), "").unwrap(), 1);
    for bad in ["0", "abc", "+1", " 1", "-1"] {
        let e = m.save(SAMPLE_WS.as_bytes(), bad).unwrap_err();
        assert!(e.is_stale(), "{bad}");
        assert_eq!(e.to_string(), "workspace: stale revision");
    }
    assert_eq!(m.save(&variant_ws(SAMPLE_WS, 2), "1").unwrap(), 2);
}

#[test]
fn save_rev_increment() {
    let store = MemPersister::empty();
    let m = mgr(live3(), store.clone());
    for i in 1..=5u64 {
        assert_eq!(m.save(&variant_ws(SAMPLE_WS, i as usize), "").unwrap(), i);
        assert_eq!(m.current_rev(), i);
        for _ in 0..100 {
            if store.wrote() >= i as usize {
                break;
            }
            std::thread::sleep(Duration::from_millis(1));
        }
    }
    m.close();
    assert_eq!(store.wrote(), 5);
    assert_eq!(m.raw().as_slice(), variant_ws(SAMPLE_WS, 5).as_slice());
    assert_eq!(m.labels()["10"], "W1.P1.T1");
    let entries = m.entries();
    assert_eq!(entries.len(), 3);
    assert_eq!(entries.iter().filter(|e| e.is_active).count(), 1);
}

#[test]
fn snapshot_coherent() {
    let m = mgr(live3(), MemPersister::empty());
    let (raw, rev) = m.snapshot();
    assert_eq!((raw.len(), rev), (0, 0));
    m.save(SAMPLE_WS.as_bytes(), "").unwrap();
    let (raw, rev) = m.snapshot();
    assert_eq!(rev, 1);
    assert_eq!(raw.as_slice(), SAMPLE_WS.as_bytes());
}

#[test]
fn snapshot_concurrent_coherence() {
    let m = Arc::new(mgr(live3(), MemPersister::empty()));
    m.save(SAMPLE_WS.as_bytes(), "").unwrap();
    let stop = Arc::new(AtomicBool::new(false));
    let mut hs = Vec::new();
    {
        let (m, stop) = (m.clone(), stop.clone());
        hs.push(std::thread::spawn(move || {
            let mut if_match = "1".to_owned();
            let mut n = 0usize;
            while !stop.load(Ordering::SeqCst) {
                n += 1;
                match m.save(&variant_ws(SAMPLE_WS, n), &if_match) {
                    Ok(rev) => if_match = rev.to_string(),
                    Err(e) if e.is_stale() => if_match = m.current_rev().to_string(),
                    Err(e) => panic!("{e}"),
                }
            }
        }));
    }
    for _ in 0..4 {
        let (m, stop) = (m.clone(), stop.clone());
        hs.push(std::thread::spawn(move || {
            for _ in 0..2000 {
                if stop.load(Ordering::SeqCst) {
                    return;
                }
                let (raw, rev) = m.snapshot();
                assert!(rev > 0 && !raw.is_empty(), "rev={rev} len={}", raw.len());
            }
        }));
    }
    // 스레드들이 실제로 겹쳐 도는 창이다.
    std::thread::sleep(Duration::from_millis(50));
    stop.store(true, Ordering::SeqCst);
    for h in hs {
        h.join().unwrap();
    }
}

// FR-OPT-5-1: raw 바이트가 같은 저장은 무동작이다.
#[test]
fn save_same_raw_is_noop() {
    let store = MemPersister::empty();
    let m = mgr(live3(), store.clone());
    let hooks = Arc::new(AtomicUsize::new(0));
    let h = hooks.clone();
    m.set_on_index_update(move || {
        h.fetch_add(1, Ordering::SeqCst);
    });
    assert_eq!(m.save(SAMPLE_WS.as_bytes(), "0").unwrap(), 1);
    assert_eq!(m.save(SAMPLE_WS.as_bytes(), "1").unwrap(), 1);
    assert_eq!(hooks.load(Ordering::SeqCst), 1);
    m.close();
    assert_eq!(store.wrote(), 1);
    assert!(m.save(SAMPLE_WS.as_bytes(), "0").unwrap_err().is_stale());
}

#[test]
fn tab_ids_after_save() {
    let m = mgr(live3(), MemPersister::empty());
    assert!(m.tab_ids().is_empty());
    m.save(SAMPLE_WS.as_bytes(), "").unwrap();
    let got = m.tab_ids();
    for want in ["t1", "t2", "t3"] {
        assert!(got.contains(want), "{want}");
    }
}

#[test]
fn on_index_update_fires_on_save() {
    let m = mgr(live3(), MemPersister::empty());
    let calls = Arc::new(AtomicUsize::new(0));
    let c = calls.clone();
    m.set_on_index_update(move || {
        c.fetch_add(1, Ordering::SeqCst);
    });
    m.save(SAMPLE_WS.as_bytes(), "").unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

// M8 `GO-34`: 훅은 내부 잠금 밖에서, rev 순서로 불린다.
#[test]
fn on_index_update_runs_outside_lock_in_rev_order() {
    let m = Arc::new(mgr(live3(), MemPersister::empty()));
    let seq = Arc::new(Mutex::new(Vec::<String>::new()));
    let (rel_tx, rel_rx) = mpsc::channel::<()>();
    let rel_rx = Mutex::new(rel_rx);
    let (ent_tx, ent_rx) = mpsc::channel::<()>();
    let ent_tx = Mutex::new(ent_tx);
    let n = AtomicUsize::new(0);
    let s = seq.clone();
    m.set_on_index_update(move || {
        let i = n.fetch_add(1, Ordering::SeqCst) + 1;
        s.lock().unwrap().push(format!("s{i}"));
        ent_tx.lock().unwrap().send(()).unwrap();
        if i == 1 {
            rel_rx.lock().unwrap().recv().unwrap();
        }
        s.lock().unwrap().push(format!("e{i}"));
    });
    let m1 = m.clone();
    let first = std::thread::spawn(move || m1.save(SAMPLE_WS.as_bytes(), "").map(|_| ()));
    ent_rx.recv().unwrap();
    let m2 = m.clone();
    let second =
        std::thread::spawn(move || m2.save(&variant_ws(SAMPLE_WS, 2), "").map(|_| ()));
    wait_for(
        || m.current_rev() == 2,
        Duration::from_secs(2),
        "훅 #1 이 막힌 동안 두 번째 Save 의 색인 교체",
    );
    rel_tx.send(()).unwrap();
    ent_rx.recv().unwrap();
    first.join().unwrap().unwrap();
    second.join().unwrap().unwrap();
    assert_eq!(seq.lock().unwrap().join(","), "s1,e1,s2,e2");
}

// FR-OPT-8-4: 색인 교체가 Changes 구독을 울린다.
#[test]
fn changes_fire_on_index_replace() {
    let m = mgr(live3(), MemPersister::empty());
    let c = m.changes();
    assert!(!c.fired());
    m.save(SAMPLE_WS.as_bytes(), "").unwrap();
    assert!(c.fired());
    let c2 = m.changes();
    m.save(SAMPLE_WS.as_bytes(), "1").unwrap();
    assert!(!c2.fired(), "같은 본문 무동작은 울리지 않는다");
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let mut c3 = m.changes();
    let m = Arc::new(m);
    let m2 = m.clone();
    let h = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(10));
        m2.save(&variant_ws(SAMPLE_WS, 3), "").unwrap();
    });
    rt.block_on(async {
        tokio::time::timeout(Duration::from_secs(5), c3.wait())
            .await
            .unwrap();
    });
    h.join().unwrap();
}

// ── 영속 실패 (`GO-10`) ──

fn failing() -> Arc<FailingStore> {
    let st = Arc::new(FailingStore::default());
    *st.blob.lock().unwrap() = GOOD_WS.as_bytes().to_vec();
    st.fail.store(true, Ordering::SeqCst);
    st
}

#[test]
fn persist_err_is_remembered_and_is_a_class() {
    let st = failing();
    let m = mgr(live3(), st);
    m.save(&variant_ws(GOOD_WS, 1), "").unwrap();
    assert!(wait_persist(|| !m.persist_err().is_empty()));
    assert_eq!(m.persist_err(), PERSIST_FAILED);
}

#[test]
fn persist_err_clears_on_success() {
    let st = failing();
    let m = mgr(live3(), st.clone());
    m.save(&variant_ws(GOOD_WS, 1), "").unwrap();
    assert!(wait_persist(|| !m.persist_err().is_empty()));
    st.fail.store(false, Ordering::SeqCst);
    m.save(&variant_ws(GOOD_WS, 2), "").unwrap();
    assert!(wait_persist(|| m.persist_err().is_empty()));
}

#[test]
fn same_body_retries_after_persist_failure() {
    let st = failing();
    let m = mgr(live3(), st.clone());
    let body = variant_ws(GOOD_WS, 1);
    m.save(&body, "").unwrap();
    assert!(wait_persist(|| !m.persist_err().is_empty()));
    st.fail.store(false, Ordering::SeqCst);
    assert_eq!(m.save(&body, "").unwrap(), 2);
    assert!(wait_persist(|| m.persist_err().is_empty()));
}

// ── 기동 ──

#[test]
fn new_read_error() {
    let e = Manager::new(
        live3(),
        Arc::new(ErrorPersister(Some(io::ErrorKind::PermissionDenied))),
    )
    .err()
    .unwrap();
    assert_eq!(e.to_string(), "workspace read: disk fail");
}

#[test]
fn empty_manager() {
    let m = mgr(live3(), MemPersister::empty());
    assert!(m.raw().is_empty());
    assert_eq!(m.current_rev(), 0);
    assert!(m.labels().is_empty());
    assert!(m.entries().is_empty());
    assert_eq!(m.resolve("").unwrap_err().to_string(), "빈 id");
    assert!(m.resolve("UNKNOWN").is_err());
}

#[test]
fn save_invalid_json() {
    let m = mgr(live3(), MemPersister::empty());
    assert_eq!(
        m.save(b"not json", "").unwrap_err().to_string(),
        "workspace parse: invalid character 'o' in literal null (expecting 'u')"
    );
}

#[test]
fn new_rejects_v1_schema() {
    let e = Manager::new(live3(), MemPersister::with(SAMPLE_V1))
        .err()
        .unwrap();
    assert!(e.is_schema_too_old());
    assert_eq!(e.to_string(), SCHEMA_TOO_OLD_MSG);
    assert!(e.to_string().contains("migrate"));
}

#[test]
fn new_accepts_v2_schema() {
    let m = mgr(live3(), MemPersister::with(SAMPLE_V2));
    assert_eq!(m.entries().len(), 3);
}

#[test]
fn new_missing_file_is_not_an_error() {
    let m = mgr(live3(), MemPersister::empty());
    assert!(m.entries().is_empty());
    assert_eq!(m.load_err(), "");
}

// 격리할 수 없는 저장소는 종전대로 빈 인덱스로 지나간다.
#[test]
fn new_malformed_json_stays_tolerant() {
    let m = mgr(live3(), MemPersister::with(r#"{"windows":"#));
    assert!(m.entries().is_empty());
    assert_eq!(m.load_err(), LOAD_EMPTY);
}

#[test]
fn save_rejects_v1_and_missing_schema_version() {
    let m = mgr(live3(), MemPersister::empty());
    let e = m.save(SAMPLE_V1.as_bytes(), "").unwrap_err();
    assert!(e.is_schema_too_old());
    assert_eq!(e.to_string(), format!("workspace parse: {SCHEMA_TOO_OLD_MSG}"));
    let blob = r#"{"windows":[{"id":"s1","name":"w","layout":{"type":"pane","id":"r1","activeTab":"t1","tabs":[{"id":"t1","name":"a","toolId":"10"}]}}]}"#;
    assert!(m.save(blob.as_bytes(), "").unwrap_err().is_schema_too_old());
    let e = m
        .save(br#"{"schemaVersion":3,"windows":[]}"#, "")
        .unwrap_err();
    assert!(e.is_schema_too_new());
}

// ── 파일 저장소: 격리·복구 (V-SFD-10~14) ──

fn file_manager(dir: &Path) -> Result<Manager, Error> {
    Manager::new(
        live3(),
        Arc::new(FilePersister::new(dir.join("workspace.json"))),
    )
}

fn corrupt_copies(dir: &Path) -> Vec<String> {
    std::fs::read_dir(dir)
        .unwrap()
        .filter_map(|e| {
            let n = e.unwrap().file_name().to_string_lossy().into_owned();
            n.contains(".corrupt-").then_some(n)
        })
        .collect()
}

fn write_file(p: &Path, body: &str) {
    std::fs::write(p, body).unwrap();
}

#[test]
fn corrupt_workspace_is_quarantined() {
    let d = tempfile::tempdir().unwrap();
    write_file(&d.path().join("workspace.json"), "{ this is not json");
    let _m = file_manager(d.path()).unwrap();
    let got = corrupt_copies(d.path());
    assert_eq!(got.len(), 1, "{got:?}");
    let ts = got[0].strip_prefix("workspace.json.corrupt-").unwrap();
    assert_eq!(ts.len(), "20060102T150405Z".len());
    assert!(ts.ends_with('Z') && ts.as_bytes()[8] == b'T');
}

#[test]
fn corrupt_workspace_restores_from_generation() {
    let d = tempfile::tempdir().unwrap();
    let p = d.path().join("workspace.json");
    write_file(&p, "{ broken");
    write_file(&d.path().join("workspace.json.bak.1"), GOOD_WS);
    let m = file_manager(d.path()).unwrap();
    assert_eq!(m.raw().as_slice(), GOOD_WS.as_bytes());
    assert_eq!(m.load_err(), LOAD_RESTORED);
}

#[test]
fn corrupt_workspace_skips_bad_generation() {
    let d = tempfile::tempdir().unwrap();
    write_file(&d.path().join("workspace.json"), "{ broken");
    write_file(&d.path().join("workspace.json.bak.1"), "{ also broken");
    write_file(&d.path().join("workspace.json.bak.2"), GOOD_WS);
    let m = file_manager(d.path()).unwrap();
    assert_eq!(m.raw().as_slice(), GOOD_WS.as_bytes());
}

#[test]
fn corrupt_workspace_with_no_generation_is_empty() {
    let d = tempfile::tempdir().unwrap();
    write_file(&d.path().join("workspace.json"), "{ broken");
    let m = file_manager(d.path()).unwrap();
    assert_eq!(m.load_err(), LOAD_EMPTY);
}

#[test]
fn healthy_workspace_is_untouched() {
    let d = tempfile::tempdir().unwrap();
    write_file(&d.path().join("workspace.json"), GOOD_WS);
    let m = file_manager(d.path()).unwrap();
    assert_eq!(m.load_err(), "");
    assert!(corrupt_copies(d.path()).is_empty());
}

#[test]
fn schema_too_new_is_rejected_without_quarantine() {
    let d = tempfile::tempdir().unwrap();
    write_file(
        &d.path().join("workspace.json"),
        r#"{"schemaVersion":3,"windows":[]}"#,
    );
    let e = file_manager(d.path()).err().unwrap();
    assert!(e.is_schema_too_new());
    assert_eq!(e.to_string(), SCHEMA_TOO_NEW_MSG);
    assert!(corrupt_copies(d.path()).is_empty());
}

// 복원한 판은 아직 디스크에 없으므로 같은 본문 저장도 써야 한다 (FR-SFD-12).
#[test]
fn restored_body_is_written_on_same_save() {
    let d = tempfile::tempdir().unwrap();
    write_file(&d.path().join("workspace.json"), "{ broken");
    write_file(&d.path().join("workspace.json.bak.1"), GOOD_WS);
    let m = file_manager(d.path()).unwrap();
    assert_eq!(m.save(GOOD_WS.as_bytes(), "").unwrap(), 1);
    m.close();
    assert_eq!(
        std::fs::read(d.path().join("workspace.json")).unwrap(),
        GOOD_WS.as_bytes()
    );
}

#[test]
fn file_persister_writes_generations() {
    let d = tempfile::tempdir().unwrap();
    let m = file_manager(d.path()).unwrap();
    m.save(&variant_ws(GOOD_WS, 1), "").unwrap();
    m.close();
    let m = file_manager(d.path()).unwrap();
    m.save(&variant_ws(GOOD_WS, 2), "").unwrap();
    m.close();
    assert_eq!(
        std::fs::read(d.path().join("workspace.json.bak.1")).unwrap(),
        variant_ws(GOOD_WS, 1)
    );
}

#[cfg(unix)]
#[test]
fn file_persister_read_error_is_go_shaped() {
    let d = tempfile::tempdir().unwrap();
    std::fs::create_dir(d.path().join("workspace.json")).unwrap();
    let e = file_manager(d.path()).err().unwrap();
    assert_eq!(
        e.to_string(),
        format!(
            "workspace read: read {}: is a directory",
            d.path().join("workspace.json").display()
        )
    );
}

// ── 색인 ──

#[test]
fn build_index_empty() {
    for b in [&b""[..]] {
        let ix = parse::build_index(b).unwrap();
        assert!(ix.labels.is_empty() && ix.entries.is_empty());
    }
    assert!(parse::build_index(b"bad").is_err());
}

#[test]
fn build_index_active() {
    let data = r#"{"activeWindow":"s1","schemaVersion": 2, "windows":[{"id":"s1","name":"x","focusedPane":"r1","layout":{"type":"pane","id":"r1","activeTab":"t1","tabs":[{"id":"t1","name":"a","toolId":"1"}]}}]}"#;
    let ix = parse::build_index(data.as_bytes()).unwrap();
    assert_eq!(ix.entries.len(), 1);
    assert!(ix.entries[0].is_active);
}

#[test]
fn build_index_populates_uuid_fields() {
    let data = r#"{
		"activeWindow":"550e8400-e29b-41d4-a716-446655440001",
		"schemaVersion": 2, "windows":[{
			"id":"550e8400-e29b-41d4-a716-446655440001",
			"name":"Main",
			"focusedPane":"550e8400-e29b-41d4-a716-446655440002",
			"layout":{
				"type":"pane",
				"id":"550e8400-e29b-41d4-a716-446655440002",
				"activeTab":"550e8400-e29b-41d4-a716-446655440003",
				"tabs":[{
					"id":"550e8400-e29b-41d4-a716-446655440003",
					"name":"Shell",
					"toolId":"pty-1"
				}]
			}
		}]
	}"#;
    let ix = parse::build_index(data.as_bytes()).unwrap();
    assert_eq!(
        ix.entries,
        [TabEntry {
            tool_id: "pty-1".into(),
            label: "W1.P1.T1".into(),
            window_name: "Main".into(),
            tab_name: "Shell".into(),
            is_active: true,
            window_uuid: "550e8400-e29b-41d4-a716-446655440001".into(),
            pane_uuid: "550e8400-e29b-41d4-a716-446655440002".into(),
            tab_uuid: "550e8400-e29b-41d4-a716-446655440003".into(),
            short_code: "550e8400".into(),
        }]
    );
}

#[test]
fn build_index_empty_uuids_are_tolerated() {
    let data = r#"{"activeWindow":"s1","schemaVersion": 2, "windows":[{"id":"s1","name":"x","focusedPane":"r1","layout":{"type":"pane","id":"r1","activeTab":"t1","tabs":[{"id":"t1","name":"a","toolId":"1"}]}}]}"#;
    let ix = parse::build_index(data.as_bytes()).unwrap();
    let e = &ix.entries[0];
    assert_eq!((e.tool_id.as_str(), e.label.as_str()), ("1", "W1.P1.T1"));
    assert_eq!(
        (e.window_uuid.as_str(), e.pane_uuid.as_str(), e.tab_uuid.as_str()),
        ("s1", "r1", "t1")
    );
    assert_eq!(e.short_code, "t1");
}

#[test]
fn short_code_cases() {
    for (i, w) in [
        ("", ""),
        ("abc", "abc"),
        ("01234567", "01234567"),
        ("0123456789abcdef", "01234567"),
        ("550e8400-e29b-41d4-a716-446655440000", "550e8400"),
    ] {
        assert_eq!(short_code(i), w);
    }
}

#[test]
fn labels_use_w_prefix_and_old_s_label_is_rejected() {
    let m = mgr(live3(), MemPersister::with(SAMPLE_V2));
    let l = m.labels();
    assert_eq!(l["10"], "W1.P1.T1");
    assert_eq!(l["11"], "W1.P1.T2");
    assert_eq!(l["12"], "W1.P2.T1");
    assert_eq!(m.resolve("W1.P2.T1").unwrap(), "12");
    assert!(m.resolve("S1.P2.T1").is_err());
}

#[test]
fn build_index_reads_focused_pane_and_active_window() {
    let m = mgr(live3(), MemPersister::with(SAMPLE_V2));
    let active: Vec<_> = m.entries().into_iter().filter(|e| e.is_active).collect();
    assert_eq!(active.len(), 1);
    assert_eq!(active[0].tool_id, "10");
}

// type:"region" 은 더 이상 탭 보유자로 인식되지 않는다. "pane" 은 브라우저 값이다.
#[test]
fn layout_type_constant_matches_browser() {
    let blob = r#"{"schemaVersion":2,"windows":[{"id":"s1","name":"w","layout":
	  {"type":"pane","id":"r1","activeTab":"t1","tabs":[{"id":"t1","name":"a","toolId":"10"}]}}]}"#;
    assert_eq!(mgr(live3(), MemPersister::with(blob)).entries().len(), 1);
    let old = blob.replace(r#""type":"pane""#, r#""type":"region""#);
    assert_eq!(mgr(live3(), MemPersister::with(&old)).entries().len(), 0);
}

// FR-EM-18: Run 접합 필드는 없거나 있어도 동작이 같다.
#[test]
fn run_seam_fields() {
    assert_eq!(mgr(live3(), MemPersister::with(SAMPLE_V2)).entries().len(), 3);
    let blob = r#"{"schemaVersion":2,"windows":[{"id":"s1","name":"team","ownerRunId":"run-7",
	  "layout":{"type":"pane","id":"r1","activeTab":"t1",
	    "tabs":[{"id":"t1","name":"writer","toolId":"10","runId":"run-7"}]}}]}"#;
    assert_eq!(mgr(live3(), MemPersister::with(blob)).entries().len(), 1);
    assert_eq!(sorted(referenced_tool_ids(blob.as_bytes()).unwrap()), ["10"]);
}

// ── 참조 추출 (FR-EM-14) ──

#[test]
fn referenced_tool_ids_cases() {
    assert_eq!(
        sorted(referenced_tool_ids(SAMPLE_V2.as_bytes()).unwrap()),
        ["10", "11", "12"]
    );
    let nested = r#"{"schemaVersion":2,"windows":[{"id":"s1","name":"w","layout":{
	  "type":"split","children":[
	    {"type":"pane","id":"r1","tabs":[{"id":"t1","toolId":"1"}]},
	    {"type":"split","children":[
	      null,
	      {"type":"pane","id":"r2","tabs":[{"id":"t2","toolId":"2"}]},
	      {"type":"pane","id":"r3","tabs":[{"id":"t3","toolId":"3"}]}]}]}}]}"#;
    assert_eq!(
        sorted(referenced_tool_ids(nested.as_bytes()).unwrap()),
        ["1", "2", "3"]
    );
    let editor = r#"{"schemaVersion":2,"windows":[{"id":"s1","name":"w","layout":
	  {"type":"pane","id":"r1","tabs":[
	    {"id":"t1","type":"editor","filePath":"/a.md"},
	    {"id":"t2","type":"terminal","toolId":"7"}]}}]}"#;
    assert_eq!(sorted(referenced_tool_ids(editor.as_bytes()).unwrap()), ["7"]);
    assert!(referenced_tool_ids(b"").unwrap().is_empty());
    assert!(referenced_tool_ids(SAMPLE_V1.as_bytes()).is_err());
    assert!(referenced_tool_ids(br#"{"windows":"#).is_err());
}

// ── Window 목록 (FR-SBX-8/9·18/19) ──

const SAMPLE_SANDBOX_WS: &str = r#"{
  "schemaVersion": 2,
  "activeWindow": "w1",
  "windows": [
    {"id":"w1","name":"host","focusedPane":"p1","layout":{"type":"pane","id":"p1","tabs":[]}},
    {"id":"w2","name":"box","sandbox":"scratch","focusedPane":"p2","layout":{"type":"pane","id":"p2","tabs":[]}}
  ]
}"#;

#[test]
fn windows_of_reads_sandbox_and_tabless_windows() {
    let got = parse::windows_of(SAMPLE_SANDBOX_WS.as_bytes());
    assert_eq!(
        got,
        [
            WindowInfo {
                uuid: "w1".into(),
                sandbox: String::new()
            },
            WindowInfo {
                uuid: "w2".into(),
                sandbox: "scratch".into()
            }
        ]
    );
    assert!(parse::windows_of(b"").is_empty());
    let m = mgr(live3(), MemPersister::with(SAMPLE_SANDBOX_WS));
    assert_eq!(m.windows().len(), 2);
}

// ── 해석 ──

#[test]
fn resolve_by_label() {
    let m = mgr(live3(), MemPersister::with(SAMPLE_WS));
    m.save(SAMPLE_WS.as_bytes(), "").unwrap();
    for (i, w) in [
        ("W1.P1.T1", "10"),
        ("w1.p1.t2", "11"),
        ("W1.P2.T1", "12"),
        ("11", "11"),
        ("  11\n", "11"),
    ] {
        assert_eq!(m.resolve(i).unwrap(), w, "{i}");
    }
    assert_eq!(
        m.resolve("W9.P9.T9").unwrap_err().to_string(),
        "id 해석 실패: W9.P9.T9 (list_workspace 로 확인)"
    );
}

#[test]
fn resolve_dead_tool() {
    let live = live3();
    let m = mgr(live.clone(), MemPersister::with(SAMPLE_WS));
    live.set("11", false);
    assert_eq!(
        m.resolve("w1.p1.t2").unwrap_err().to_string(),
        "라벨 W1.P1.T2 은 toolId=11 가리키지만 도구가 존재하지 않음"
    );
    assert_eq!(
        m.resolve("11").unwrap_err().to_string(),
        "toolId=11 존재하지 않음"
    );
    assert_eq!(m.resolve("W1.P1.T1").unwrap(), "10");
}

#[test]
fn resolve_strict_accepts_tool_id_and_uuid() {
    let m = manager_with_blob(&[U_TOOL_ID], &blob_with_tool(U_TOOL_ID));
    for input in [U_TOOL_ID.to_owned(), U_TAB.to_owned(), U_TAB.to_uppercase()] {
        assert_eq!(m.resolve_strict(&input).unwrap(), U_TOOL_ID);
    }
}

#[test]
fn resolve_strict_rejects_coordinate_label() {
    let m = manager_with_blob(&[U_TOOL_ID], &blob_with_tool(U_TOOL_ID));
    assert_eq!(m.resolve("W1.P1.T1").unwrap(), U_TOOL_ID);
    for input in ["W1.P1.T1", "w1.p1.t1", "W1.p1.T1", "W12.P3.T45"] {
        let e = m.resolve_strict(input).unwrap_err();
        assert!(e.is_label_identifier());
        assert_eq!(
            e.to_string(),
            format!(
                "좌표 라벨({input})은 이 명령에서 쓸 수 없다 — uuid 를 쓴다.\n라벨은 창·분할 칸이 닫히면 다시 계산돼 다른 탭을 가리킨다.\nuuid 는 `dmctl list-workspace` 의 uuid= 컬럼, 또는 생성 명령(new-tab/split-*)의 응답에 있다."
            )
        );
    }
}

#[test]
fn resolve_strict_non_label_failures_unchanged() {
    let m = manager_with_blob(&[], &blob_with_tool(U_TOOL_ID));
    for (input, want) in [
        (U_TOOL_ID, format!("toolId={U_TOOL_ID} 존재하지 않음")),
        (
            "550e8400-e29b-41d4-a716-4466554400ff",
            "id 해석 실패: 550e8400-e29b-41d4-a716-4466554400ff (list_workspace 로 확인)".into(),
        ),
        ("nope", "id 해석 실패: nope (list_workspace 로 확인)".into()),
        ("4.1.1", "id 해석 실패: 4.1.1 (list_workspace 로 확인)".into()),
        ("W1.P1", "id 해석 실패: W1.P1 (list_workspace 로 확인)".into()),
        ("W1.P1.T1x", "id 해석 실패: W1.P1.T1x (list_workspace 로 확인)".into()),
        ("W١.P1.T1", "id 해석 실패: W١.P1.T1 (list_workspace 로 확인)".into()),
    ] {
        let e = m.resolve_strict(input).unwrap_err();
        assert!(!e.is_label_identifier(), "{input}");
        assert_eq!(e.to_string(), want);
        assert_eq!(m.resolve(input).unwrap_err().to_string(), want);
    }
    assert!(m.resolve_strict("   ").is_err());
}

#[test]
fn resolve_strict_lookup_beats_shape() {
    let m = manager_with_blob(&["W1.P1.T1"], &blob_with_tool("W1.P1.T1"));
    assert_eq!(m.resolve_strict("W1.P1.T1").unwrap(), "W1.P1.T1");
}

#[test]
fn resolve_label_stage_survives() {
    let m = manager_with_blob(&[LEGACY_ID], &blob_with_tool(LEGACY_ID));
    for input in [LEGACY_ID, U_TAB, "W1.P1.T1", "w1.p1.t1"] {
        assert_eq!(m.resolve(input).unwrap(), LEGACY_ID);
    }
}

#[test]
fn resolve_uuid_form_tool_id_and_dead_or_unknown() {
    let m = manager_with_blob(&[U_TOOL_ID], &blob_with_tool(U_TOOL_ID));
    assert_eq!(m.resolve(U_TOOL_ID).unwrap(), U_TOOL_ID);
    let m = manager_with_blob(&[], &blob_with_tool(U_TOOL_ID));
    for input in [U_TOOL_ID, LEGACY_ID, "550e8400-e29b-41d4-a716-4466554400ff"] {
        assert!(m.resolve(input).is_err());
    }
    assert_eq!(
        m.resolve(U_TAB).unwrap_err().to_string(),
        format!("tab id {U_TAB} 은 toolId={U_TOOL_ID} 가리키지만 도구가 존재하지 않음")
    );
}

#[test]
fn coordinate_of_cases() {
    let m = manager_with_blob(&[U_TOOL_ID], &blob_with_tool(U_TOOL_ID));
    assert_eq!(m.coordinate_of(U_TOOL_ID).unwrap(), U_TOOL_ID);
    let m = manager_with_blob(&[LEGACY_ID], &blob_with_tool(LEGACY_ID));
    assert_eq!(m.coordinate_of(U_TAB).unwrap(), "W1.P1.T1");
    for input in ["W1.P1.T1", LEGACY_ID, "", "4.1.1", "W4.P1.T1"] {
        assert_eq!(m.coordinate_of(input).unwrap(), input);
    }
    assert_eq!(
        m.coordinate_of("ffffffff-ffff-7fff-bfff-ffffffffffff")
            .unwrap_err()
            .to_string(),
        "id 해석 실패: ffffffff-ffff-7fff-bfff-ffffffffffff (list_workspace 로 확인)"
    );
    let m = manager_with_blob(&[], &blob_with_tool(LEGACY_ID));
    assert_eq!(
        m.coordinate_of(U_TAB).unwrap_err().to_string(),
        format!("tab id {U_TAB} 은 toolId={LEGACY_ID} 가리키지만 도구가 존재하지 않음")
    );
}

#[test]
fn coordinate_of_short_tab_id_translates() {
    let blob = r#"{"activeWindow":"s2","schemaVersion": 2, "windows":[
		{"id":"s1","name":"a","focusedPane":"r1","layout":{"type":"pane","id":"r1","activeTab":"t1","tabs":[{"id":"t1","name":"shA","toolId":"303"}]}},
		{"id":"s2","name":"b","focusedPane":"r2","layout":{"type":"pane","id":"r2","activeTab":"t42","tabs":[{"id":"t42","name":"shB","toolId":"342"}]}}
	]}"#;
    let m = manager_with_blob(&["303", "342"], blob);
    assert_eq!(m.coordinate_of("t1").unwrap(), "W1.P1.T1");
    assert_eq!(m.coordinate_of("t42").unwrap(), "W2.P1.T1");
    assert_eq!(m.resolve("t42").unwrap(), "342");
    for input in ["", "4.1.1", "W2.P1.T1", "342"] {
        assert_eq!(m.coordinate_of(input).unwrap(), input);
    }
}

#[test]
fn resolve_uuid_stable_across_label_reflow() {
    let tab_a = "550e8400-e29b-41d4-a716-446655440aaa";
    let tab_b = "550e8400-e29b-41d4-a716-446655440bbb";
    let win = |id: &str, name: &str, tab: &str, tool: &str| {
        format!(
            r#"{{"id":"{id}","name":"{name}","focusedPane":"r{id}","layout":{{"type":"pane","id":"r{id}","activeTab":"{tab}","tabs":[{{"id":"{tab}","name":"x","toolId":"{tool}"}}]}}}}"#
        )
    };
    let blob1 = format!(
        r#"{{"activeWindow":"sa","schemaVersion":2,"windows":[{},{}]}}"#,
        win("sa", "A", tab_a, "10"),
        win("sb", "B", tab_b, "20")
    );
    let m = manager_with_blob(&["10", "20"], &blob1);
    assert_eq!(m.resolve(tab_b).unwrap(), "20");
    assert_eq!(m.resolve("W2.P1.T1").unwrap(), "20");
    let blob2 = format!(
        r#"{{"activeWindow":"sb","schemaVersion":2,"windows":[{}]}}"#,
        win("sb", "B", tab_b, "20")
    );
    m.save(blob2.as_bytes(), "1").unwrap();
    assert_eq!(m.resolve("W1.P1.T1").unwrap(), "20");
    assert_eq!(m.resolve(tab_b).unwrap(), "20");
    assert!(m.resolve(tab_a).is_err());
    assert!(m.resolve("550e8400").is_err(), "short code 는 거부한다 (NFR-UID-4)");
    assert!(m.is_known_tab_id(&tab_b.to_uppercase()));
    assert!(!m.is_known_tab_id(tab_a));
    assert!(!m.is_known_tab_id(""));
}

// Go strings.ToLower 는 문자 하나를 문자 하나로 바꾼다 (끝 시그마 규칙 없음, İ → i).
#[test]
fn uuid_index_uses_go_simple_lowercase() {
    let blob = r#"{"activeWindow":"s","schemaVersion":2,"windows":[{"id":"s","name":"x","focusedPane":"r","layout":{"type":"pane","id":"r","activeTab":"ΑΣ","tabs":[{"id":"ΑΣ","name":"a","toolId":"1"},{"id":"İd","name":"b","toolId":"2"}]}}]}"#;
    let m = manager_with_blob(&["1", "2"], blob);
    assert_eq!(m.resolve("ασ").unwrap(), "1");
    assert!(m.resolve("ας").is_err());
    assert_eq!(m.resolve("id").unwrap(), "2");
}

// ── Run 표식 (M8 D-A-13) ──

#[test]
fn apply_run_marks_cases() {
    let blob = br#"{"windows":[{"id":"w1","extra":1,"layout":{"type":"split","children":[
	  {"type":"pane","id":"p1","tabs":[{"id":"t1","toolId":"x","foo":"bar"},{"id":"t2"}]},
	  {"type":"pane","id":"p2","tabs":[{"id":"t3","runId":"old"}]}]}},
	  {"id":"w2","layout":{"type":"pane","id":"p3","tabs":[{"id":"t4"}]}}]}"#;
    let mut tree: serde_json::Map<String, serde_json::Value> =
        json::unmarshal(blob).unwrap();
    let tabs: HashSet<String> = ["t1", "t3"].map(String::from).into();
    assert!(apply_run_marks(&mut tree, &tabs, "w1", true, "run-1"));
    let out = String::from_utf8(json::marshal(&tree).unwrap()).unwrap();
    for want in [
        r#"{"foo":"bar","id":"t1","runId":"run-1","toolId":"x"}"#,
        r#"{"id":"t3","runId":"run-1"}"#,
        r#""ownerRunId":"run-1""#,
        r#""extra":1"#,
        r#"{"id":"t2"}"#,
        r#"{"id":"t4"}"#,
    ] {
        assert!(out.contains(want), "{want} 가 없다:\n{out}");
    }
    assert!(!apply_run_marks(&mut tree, &tabs, "w1", true, "run-1"));
    assert!(apply_run_marks(&mut tree, &tabs, "w1", false, ""));
    let out = String::from_utf8(json::marshal(&tree).unwrap()).unwrap();
    assert!(!out.contains("runId") && !out.contains("ownerRunId"), "{out}");
    let mut broken: serde_json::Map<String, serde_json::Value> =
        json::unmarshal(br#"{"windows":"x"}"#).unwrap();
    assert!(!apply_run_marks(&mut broken, &tabs, "w1", true, "r"));
}

// Go `id, _ := m["id"].(string)`: id 가 없으면 "" 로 비교한다.
#[test]
fn apply_run_marks_missing_ids_compare_as_empty() {
    let mut tree: serde_json::Map<String, serde_json::Value> = json::unmarshal(
        br#"{"windows":[{"layout":{"type":"pane","tabs":[{"name":"n"}]}}]}"#,
    )
    .unwrap();
    let tabs: HashSet<String> = [String::new()].into();
    assert!(apply_run_marks(&mut tree, &tabs, "", true, "r"));
    let out = String::from_utf8(json::marshal(&tree).unwrap()).unwrap();
    assert_eq!(
        out,
        r#"{"windows":[{"layout":{"tabs":[{"name":"n","runId":"r"}],"type":"pane"},"ownerRunId":"r"}]}"#
    );
}

// ── Go json 디코딩 의미 (go1.27.2 실측값) ──

fn decode_err(blob: &str) -> String {
    decode_state(blob.as_bytes()).unwrap_err().to_string()
}

#[test]
fn decode_errors_match_go() {
    for (blob, want) in [
        (
            r#"{"windows":"#,
            "unexpected end of JSON input",
        ),
        (
            r#"{"schemaVersion":"2"}"#,
            "json: cannot unmarshal string into Go struct field WsState.schemaVersion of type int",
        ),
        (
            r#"{"schemaVersion":2,"windows":[{"layout":{"tabs":[{"id":3}]}}]}"#,
            "json: cannot unmarshal number into Go struct field WsState.windows.0.layout.tabs.0.id of type string",
        ),
        (
            r#"{"windows":[{"layout":1}]}"#,
            "json: cannot unmarshal number into Go struct field WsState.windows.0.layout of type workspace.WsLayout",
        ),
        (
            r#"{"windows":[{"layout":{"tabs":[1]}}]}"#,
            "json: cannot unmarshal number into WsState.windows.0.layout.tabs.0 of type workspace.WsTab",
        ),
        (
            r#"{"windowGroups":[{"tree":{"root":1.5}}]}"#,
            "json: cannot unmarshal number 1.5 into Go struct field WsState.windowGroups.0.tree.root of type int",
        ),
        (
            r#"{"windowGroups":[{"tree":"x"}]}"#,
            "json: cannot unmarshal string into Go struct field WsState.windowGroups.0.tree of type workspace.WsGroupTree",
        ),
        (
            r#"{"schemaVersion":2.0}"#,
            "json: cannot unmarshal number 2.0 into Go struct field WsState.schemaVersion of type int",
        ),
        (
            r#"{"schemaVersion":99999999999999999999}"#,
            "json: cannot unmarshal number 99999999999999999999 into Go struct field WsState.schemaVersion of type int",
        ),
    ] {
        assert_eq!(decode_err(blob), want, "{blob}");
    }
}

// slice 타입 이름도 Go 와 같다 (go_type!).
#[test]
fn decode_error_slice_type_name() {
    assert_eq!(
        decode_err(r#"{"windows":[{"layout":{"children":[null,{"type":"pane","tabs":{}}]}}]}"#),
        "json: cannot unmarshal object into Go struct field WsState.windows.0.layout.children.1.tabs of type []workspace.WsTab"
    );
    assert_eq!(
        decode_err(r#"{"schemaVersion":2,"windows":{}}"#),
        "json: cannot unmarshal object into Go struct field WsState.windows of type []workspace.WsWindow"
    );
}

#[test]
fn decode_is_case_insensitive_and_last_duplicate_wins() {
    let s = decode_state(
        br#"{"Windows":[{"ID":"a","LAYOUT":{"type":"pane"}}],"schemaversion":2}"#,
    )
    .unwrap()
    .unwrap();
    assert_eq!(s.schema_version, 2);
    assert_eq!(s.windows[0].id, "a");
    assert_eq!(s.windows[0].layout.as_ref().unwrap().kind, "pane");
    let s = decode_state(
        br#"{"windows":[{"id":"a"},{"id":"b","id":"c"}],"schemaVersion":2,"schemaVersion":null}"#,
    )
    .unwrap()
    .unwrap();
    assert_eq!(
        s.windows.iter().map(|w| w.id.as_str()).collect::<Vec<_>>(),
        ["a", "c"]
    );
    assert!(s.windows[0].layout.is_none());
}
