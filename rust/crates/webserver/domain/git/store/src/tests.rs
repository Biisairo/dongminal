//! Go store 시험의 Rust 판. 가짜 git 의 runner 는 동기 함수라 막는 시험은 다중 스레드
//! 런타임에서 돈다.

#![allow(clippy::type_complexity)]

use std::collections::HashMap;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, SystemTime};

use otter_webserver_domain_git_core::{
    Ctx, CtxError, Error as CoreError, Kind, Output, Runner, Service, is_terminal,
};
use otter_webserver_domain_git_query::{FileEntry, Status};
use tempfile::TempDir;

use crate::store::{Cached, prune_cache};
use crate::*;

const OID: &str = "# branch.oid 1111111111111111111111111111111111111111";
const HEAD: &str = "# branch.head main";

fn nul(recs: &[&str]) -> String {
    recs.join("\0") + "\0"
}

fn abs(p: &str) -> String {
    let root = if cfg!(windows) { "C:\\" } else { "/" };
    otter_gocompat::filepath::join(&[root, p])
}

/// 열릴 때까지 막는 문.
#[derive(Clone, Default)]
struct Gate(Arc<(Mutex<bool>, Condvar)>);

impl Gate {
    fn open(&self) {
        *self.0.0.lock().unwrap() = true;
        self.0.1.notify_all();
    }
    fn wait(&self) {
        let mut g = self.0.0.lock().unwrap();
        while !*g {
            g = self.0.1.wait(g).unwrap();
        }
    }
}

/// 명령별 호출 수를 세고, status 마다 순서대로 out·gate 를 쓴다.
#[derive(Clone)]
struct FakeGit {
    counts: Arc<Mutex<HashMap<String, usize>>>,
    git_dir: Arc<TempDir>,
    outs: Arc<Mutex<Vec<(String, Option<Gate>)>>>,
    n: Arc<Mutex<usize>>,
    hold: Arc<Mutex<HashMap<String, Gate>>>,
    entered: Arc<Mutex<Vec<String>>>,
}

impl FakeGit {
    fn new() -> Self {
        let git_dir = TempDir::new().unwrap();
        std::fs::write(git_dir.path().join("HEAD"), "ref: refs/heads/main\n").unwrap();
        FakeGit {
            counts: Arc::default(),
            git_dir: Arc::new(git_dir),
            outs: Arc::default(),
            n: Arc::default(),
            hold: Arc::default(),
            entered: Arc::default(),
        }
    }

    fn dir(&self) -> String {
        self.git_dir.path().to_string_lossy().into_owned()
    }

    fn count(&self, k: &str) -> usize {
        self.counts.lock().unwrap().get(k).copied().unwrap_or(0)
    }

    fn entered(&self) -> usize {
        self.entered.lock().unwrap().len()
    }

    fn runner(&self) -> Runner {
        let me = self.clone();
        Arc::new(move |_, dir: String, args: Vec<String>| {
            let mut key = args[0].clone();
            if args.len() > 1 && args[0] == "rev-parse" {
                key = format!("{key} {}", args[1]);
            }
            *me.counts.lock().unwrap().entry(key.clone()).or_default() += 1;
            let r: Result<Output, CoreError> = Ok(match key.as_str() {
                "rev-parse --show-toplevel" => {
                    me.entered.lock().unwrap().push(key.clone());
                    let held = me.hold.lock().unwrap().get("toplevel").cloned();
                    if let Some(g) = held {
                        g.wait();
                    }
                    out(&format!("{dir}\n"))
                }
                "rev-parse --absolute-git-dir" => {
                    let held = me.hold.lock().unwrap().get("gitdir").cloned();
                    if let Some(g) = held {
                        g.wait();
                    }
                    out(&format!("{0}\n{0}\n", me.dir()))
                }
                "status" => {
                    let i = {
                        let mut n = me.n.lock().unwrap();
                        *n += 1;
                        *n - 1
                    };
                    me.entered.lock().unwrap().push(dir.clone());
                    let held = me.hold.lock().unwrap().get(&dir).cloned();
                    if let Some(g) = held {
                        g.wait();
                    }
                    let (body, gate) = me
                        .outs
                        .lock()
                        .unwrap()
                        .get(i)
                        .cloned()
                        .unwrap_or_else(|| (nul(&[OID, HEAD, "? a.txt"]), None));
                    if let Some(g) = gate {
                        g.wait();
                    }
                    out(&body)
                }
                _ => Output::default(),
            });
            Box::pin(async move { r })
        })
    }

    fn service(&self) -> Arc<Service> {
        Arc::new(Service::builder().runner(self.runner()).build())
    }

    /// status 순번별 출력과 문.
    fn seq(&self, files: &[&str]) -> Vec<Gate> {
        let gates: Vec<Gate> = files.iter().map(|_| Gate::default()).collect();
        *self.outs.lock().unwrap() = files
            .iter()
            .zip(&gates)
            .map(|(f, g)| (nul(&[OID, HEAD, &format!("? {f}")]), Some(g.clone())))
            .collect();
        gates
    }
}

fn out(s: &str) -> Output {
    Output {
        stdout: s.as_bytes().to_vec(),
        ..Output::default()
    }
}

fn fixed(at: SystemTime) -> Clock {
    Arc::new(move || at)
}

/// 바꿀 수 있는 시계.
fn movable(at: SystemTime) -> (Clock, Arc<Mutex<SystemTime>>) {
    let t = Arc::new(Mutex::new(at));
    let t2 = t.clone();
    (Arc::new(move || *t2.lock().unwrap()), t)
}

fn store(g: &FakeGit, opts: StoreOptions) -> Arc<Store> {
    Store::new(g.service(), opts)
}

fn bg() -> Ctx {
    Ctx::background()
}

async fn until(mut f: impl FnMut() -> bool) {
    for _ in 0..300 {
        if f() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("조건이 3초 안에 서지 않았다");
}

fn untracked(o: &Observation) -> String {
    o.status
        .untracked
        .iter()
        .map(|e| e.path.as_str())
        .collect::<Vec<_>>()
        .join(",")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn status_single_flight() {
    let g = FakeGit::new();
    let gate = Gate::default();
    g.hold.lock().unwrap().insert(abs("r"), gate.clone());
    let st = store(&g, StoreOptions::default().clock(fixed(SystemTime::now())));
    let hs: Vec<_> = (0..10)
        .map(|_| {
            let st = st.clone();
            tokio::spawn(async move { st.status(&bg(), &abs("r")).await.0 })
        })
        .collect();
    until(|| g.entered() == 1).await;
    tokio::time::sleep(Duration::from_millis(30)).await;
    gate.open();
    for h in hs {
        let o = h.await.unwrap().unwrap();
        assert!(o.status.total == 1 && o.observed_at_unix_ms != 0);
    }
    assert_eq!(g.count("status"), 1);
}

#[tokio::test]
async fn status_ttl_cache_zero_and_observed() {
    let g = FakeGit::new();
    let st = store(&g, StoreOptions::default().clock(fixed(SystemTime::now())));
    assert!(!st.status(&bg(), &abs("r")).await.1);
    let (r, cached) = st.status(&bg(), &abs("r")).await;
    assert!(r.is_ok() && cached);
    assert_eq!(g.count("status"), 1);

    let g = FakeGit::new();
    let st = store(
        &g,
        StoreOptions::default()
            .status_ttl(Duration::ZERO)
            .clock(fixed(SystemTime::now())),
    );
    for _ in 0..3 {
        let (r, cached) = st.status(&bg(), &abs("r")).await;
        assert!(r.is_ok() && !cached);
    }
    assert_eq!(g.count("status"), 3);

    let g = FakeGit::new();
    let base = SystemTime::now();
    let (clock, t) = movable(base);
    let st = store(&g, StoreOptions::default().clock(clock));
    st.status(&bg(), &abs("r")).await.0.unwrap();
    *t.lock().unwrap() = base + Duration::from_secs(3600);
    let o = st.observed(&abs("r")).unwrap();
    assert!(
        o.status.total == 1
            && o.observed_at_unix_ms
                == base
                    .duration_since(SystemTime::UNIX_EPOCH)
                    .unwrap()
                    .as_millis() as i64
    );
    assert!(st.observed(&abs("none")).is_none());
    assert_eq!(g.count("status"), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn single_flight_is_per_repo() {
    let g = FakeGit::new();
    let gate = Gate::default();
    g.hold.lock().unwrap().insert(abs("slow"), gate.clone());
    let st = store(&g, StoreOptions::default().clock(fixed(SystemTime::now())));
    let st2 = st.clone();
    let slow = tokio::spawn(async move { st2.status(&bg(), &abs("slow")).await.0 });
    until(|| g.entered() == 1).await;
    st.status(&bg(), &abs("fast")).await.0.unwrap();
    gate.open();
    slow.await.unwrap().unwrap();
    assert_eq!(g.count("status"), 2);
}

#[tokio::test]
async fn observed_lru_cap() {
    let g = FakeGit::new();
    let st = store(
        &g,
        StoreOptions::default()
            .status_ttl(Duration::ZERO)
            .clock(fixed(SystemTime::now())),
    );
    let repos: Vec<String> = (0..=DEFAULT_OBSERVED_CAP)
        .map(|i| abs(&format!("r{i}")))
        .collect();
    for r in &repos {
        st.status(&bg(), r).await.0.unwrap();
    }
    assert!(st.observed(&repos[0]).is_none());
    assert!(repos[1..].iter().all(|r| st.observed(r).is_some()));
}

#[tokio::test]
async fn repo_root_ttl_and_prune() {
    let g = FakeGit::new();
    let base = SystemTime::now();
    let (clock, t) = movable(base);
    let st = store(&g, StoreOptions::default().clock(clock));
    assert_eq!(st.repo_root(&bg(), &abs("r")).await.unwrap(), abs("r"));
    st.repo_root(&bg(), &abs("r")).await.unwrap();
    assert_eq!(g.count("rev-parse --show-toplevel"), 1);
    *t.lock().unwrap() = base + DEFAULT_REPO_ROOT_TTL + Duration::from_secs(1);
    st.repo_root(&bg(), &abs("r")).await.unwrap();
    assert_eq!(g.count("rev-parse --show-toplevel"), 2);

    let g = FakeGit::new();
    let (clock, t) = movable(base);
    let st = store(&g, StoreOptions::default().clock(clock));
    let cwds: Vec<String> = (0..=DEFAULT_OBSERVED_CAP)
        .map(|i| abs(&format!("p{i}")))
        .collect();
    for (i, c) in cwds.iter().enumerate() {
        *t.lock().unwrap() = base + Duration::from_millis(i as u64);
        st.repo_root(&bg(), c).await.unwrap();
    }
    let before = g.count("rev-parse --show-toplevel");
    for c in &cwds[1..] {
        st.repo_root(&bg(), c).await.unwrap();
    }
    assert_eq!(g.count("rev-parse --show-toplevel"), before);
    assert!(st.lock().roots.len() <= DEFAULT_OBSERVED_CAP);
}

#[test]
fn prune_cache_expired_first() {
    let now = SystemTime::now();
    let mut m: HashMap<String, Cached<()>> = HashMap::from([
        (
            "old".into(),
            Cached {
                val: (),
                at: now - Duration::from_secs(3600),
            },
        ),
        (
            "fresh".into(),
            Cached {
                val: (),
                at: now - Duration::from_millis(2),
            },
        ),
        (
            "new".into(),
            Cached {
                val: (),
                at: now - Duration::from_millis(1),
            },
        ),
    ]);
    prune_cache(&mut m, 3, now, Some(Duration::from_secs(1)));
    assert!(!m.contains_key("old") && m.len() == 2);
    prune_cache(&mut m, 2, now, Some(Duration::from_secs(1)));
    assert!(!m.contains_key("fresh") && m.len() == 1);
    prune_cache(&mut m, 1, now, None);
    assert!(m.is_empty(), "만료 없는 캐시도 상한은 지킨다");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn repo_root_and_git_dirs_single_flight() {
    let g = FakeGit::new();
    let gate = Gate::default();
    g.hold
        .lock()
        .unwrap()
        .insert("toplevel".into(), gate.clone());
    let st = store(&g, StoreOptions::default().clock(fixed(SystemTime::now())));
    let hs: Vec<_> = (0..8)
        .map(|_| {
            let st = st.clone();
            tokio::spawn(async move { st.repo_root(&bg(), &abs("r")).await })
        })
        .collect();
    until(|| g.entered() == 1).await;
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert!(st.lock().root_flights.contains_key(&abs("r")));
    gate.open();
    for h in hs {
        assert_eq!(h.await.unwrap().unwrap(), abs("r"));
    }
    assert_eq!(g.count("rev-parse --show-toplevel"), 1);

    let g = FakeGit::new();
    let gate = Gate::default();
    g.hold.lock().unwrap().insert("gitdir".into(), gate.clone());
    let st = store(&g, StoreOptions::default().clock(fixed(SystemTime::now())));
    let hs: Vec<_> = (0..8)
        .map(|_| {
            let st = st.clone();
            tokio::spawn(async move { st.common_dir(&bg(), &abs("r")).await })
        })
        .collect();
    tokio::time::sleep(Duration::from_millis(50)).await;
    gate.open();
    for h in hs {
        h.await.unwrap().unwrap();
    }
    assert_eq!(g.count("rev-parse --absolute-git-dir"), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn forget_root_detaches_flight_and_clears() {
    let g = FakeGit::new();
    let gate = Gate::default();
    g.hold
        .lock()
        .unwrap()
        .insert("toplevel".into(), gate.clone());
    let st = store(&g, StoreOptions::default().clock(fixed(SystemTime::now())));
    let st2 = st.clone();
    let h = tokio::spawn(async move { st2.repo_root(&bg(), &abs("r")).await });
    until(|| g.entered() == 1).await;
    st.forget_root(&abs("r"));
    gate.open();
    h.await.unwrap().unwrap();
    assert!(!st.lock().roots.contains_key(&abs("r")));

    let sub = otter_gocompat::filepath::join(&[abs("r").as_str(), "sub"]);
    let fs_root = abs("");
    for forget in [abs("r"), fs_root] {
        let st = Store::new(Arc::new(Service::new()), StoreOptions::default());
        {
            let mut g = st.lock();
            for k in [abs("r"), sub.clone()] {
                g.roots.insert(
                    k.clone(),
                    Cached {
                        val: Ok(abs("r")),
                        at: SystemTime::now(),
                    },
                );
                g.dirs.insert(
                    k.clone(),
                    Cached {
                        val: (k.clone(), k),
                        at: SystemTime::now(),
                    },
                );
            }
        }
        st.forget_root(&forget);
        assert!(
            st.lock().roots.is_empty() && st.lock().dirs.is_empty(),
            "{forget}"
        );
    }
}

#[tokio::test]
async fn signature_caches_git_dirs_and_invalidate() {
    let g = FakeGit::new();
    let st = store(&g, StoreOptions::default().clock(fixed(SystemTime::now())));
    for _ in 0..3 {
        assert_eq!(
            st.signature(&bg(), &abs("r")).await.unwrap().ref_name,
            "refs/heads/main"
        );
    }
    assert_eq!(g.count("rev-parse --absolute-git-dir"), 1);

    st.status(&bg(), &abs("r")).await.0.unwrap();
    assert!(st.status(&bg(), &abs("r")).await.1);
    st.invalidate(&abs("r"));
    let (r, cached) = st.status(&bg(), &abs("r")).await;
    assert!(r.is_ok() && !cached);
    assert_eq!(g.count("status"), 2);
    st.invalidate(&abs("r"));
    assert!(st.observed(&abs("r")).is_some());
    st.invalidate(&abs("none"));
    assert!(st.observed(&abs("none")).is_none());
    let svc = Arc::new(Service::new());
    assert!(Arc::ptr_eq(
        Store::new(svc.clone(), StoreOptions::default()).service(),
        &svc
    ));
}

/// 4.14: gitdir 해석은 시간으로 만료되지 않는다. 다시 묻는 것은 `forget_dirs`·`forget_root` 뿐이다.
#[tokio::test]
async fn git_dirs_do_not_expire_by_time() {
    let g = FakeGit::new();
    let base = SystemTime::now();
    let (clock, t) = movable(base);
    let st = store(&g, StoreOptions::default().clock(clock));
    st.signature(&bg(), &abs("r")).await.unwrap();
    *t.lock().unwrap() = base + Duration::from_secs(24 * 3600);
    st.signature(&bg(), &abs("r")).await.unwrap();
    st.common_dir(&bg(), &abs("r")).await.unwrap();
    assert_eq!(
        g.count("rev-parse --absolute-git-dir"),
        1,
        "시간이 지났다고 gitdir 을 다시 물었다"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn forget_dirs_reresolves_and_detaches_flight() {
    let g = FakeGit::new();
    let st = store(&g, StoreOptions::default().clock(fixed(SystemTime::now())));
    st.signature(&bg(), &abs("r")).await.unwrap();
    st.signature(&bg(), &abs("other")).await.unwrap();
    st.forget_dirs(&abs("r"));
    assert!(
        st.lock().dirs.contains_key(&abs("other")),
        "다른 저장소의 해석까지 지웠다"
    );
    st.signature(&bg(), &abs("r")).await.unwrap();
    assert_eq!(g.count("rev-parse --absolute-git-dir"), 3);

    let gate = Gate::default();
    g.hold.lock().unwrap().insert("gitdir".into(), gate.clone());
    st.forget_dirs(&abs("r"));
    let st2 = st.clone();
    let h = tokio::spawn(async move { st2.common_dir(&bg(), &abs("r")).await });
    until(|| st.lock().dir_flights.contains_key(&abs("r"))).await;
    st.forget_dirs(&abs("r"));
    gate.open();
    h.await.unwrap().unwrap();
    assert!(
        !st.lock().dirs.contains_key(&abs("r")),
        "잊은 뒤 끝난 비행의 결과를 캐시에 올렸다"
    );
}

/// 캐시한 gitdir 로 signature 를 읽지 못하면(저장소가 옮겨졌거나 바뀌었다) 다음에 다시 해석한다.
#[tokio::test]
async fn signature_read_failure_forgets_dirs() {
    let g = FakeGit::new();
    let st = store(&g, StoreOptions::default().clock(fixed(SystemTime::now())));
    st.signature(&bg(), &abs("r")).await.unwrap();
    let head = g.git_dir.path().join("HEAD");
    std::fs::remove_file(&head).unwrap();
    assert!(st.signature(&bg(), &abs("r")).await.is_err());
    std::fs::write(&head, "ref: refs/heads/main\n").unwrap();
    st.signature(&bg(), &abs("r")).await.unwrap();
    assert_eq!(g.count("rev-parse --absolute-git-dir"), 2);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn first_caller_cancel_does_not_fail_joiner() {
    let g = FakeGit::new();
    let gates = g.seq(&["a.txt"]);
    let st = store(&g, StoreOptions::default().clock(fixed(SystemTime::now())));
    let ctx_a = bg().with_cancel();
    let (st_a, ca) = (st.clone(), ctx_a.clone());
    let a = tokio::spawn(async move { st_a.status(&ca, &abs("r")).await.0 });
    until(|| g.entered() == 1).await;
    let st_b = st.clone();
    let b = tokio::spawn(async move { st_b.status(&bg(), &abs("r")).await.0 });
    tokio::time::sleep(Duration::from_millis(20)).await;
    ctx_a.cancel();
    let ea = tokio::time::timeout(Duration::from_secs(3), a)
        .await
        .unwrap()
        .unwrap()
        .unwrap_err();
    assert!(
        ea.is_core(Kind::Canceled) && ea.core().unwrap().is_ctx(CtxError::Canceled),
        "{ea}"
    );
    assert_eq!(
        ea.to_string(),
        "git_canceled: status 를 기다리는 중: context canceled"
    );
    gates[0].open();
    assert_eq!(untracked(&b.await.unwrap().unwrap()), "a.txt");
    assert_eq!(*g.n.lock().unwrap(), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn invalidate_does_not_join_or_store_old_flight() {
    let g = FakeGit::new();
    let gates = g.seq(&["old.txt", "new.txt"]);
    let st = store(&g, StoreOptions::default().clock(fixed(SystemTime::now())));
    let s1 = st.clone();
    let old = tokio::spawn(async move { s1.status(&bg(), &abs("r")).await.0 });
    until(|| g.entered() == 1).await;
    st.invalidate(&abs("r"));
    let s2 = st.clone();
    let new = tokio::spawn(async move { s2.status(&bg(), &abs("r")).await.0 });
    until(|| g.entered() == 2).await;
    gates[1].open();
    assert_eq!(untracked(&new.await.unwrap().unwrap()), "new.txt");
    gates[0].open();
    assert_eq!(untracked(&old.await.unwrap().unwrap()), "old.txt");
    let (r, cached) = st.status(&bg(), &abs("r")).await;
    assert!(cached && untracked(&r.unwrap()) == "new.txt");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn evict_recreate_does_not_accept_old_flight() {
    let g = FakeGit::new();
    let gates = g.seq(&["old.txt", "mid.txt", "other.txt"]);
    let st = store(
        &g,
        StoreOptions::default()
            .clock(fixed(SystemTime::now()))
            .observed_cap(1),
    );
    let s1 = st.clone();
    let old = tokio::spawn(async move { s1.status(&bg(), &abs("r")).await });
    until(|| g.entered() == 1).await;
    st.invalidate(&abs("r"));
    let s2 = st.clone();
    let mid = tokio::spawn(async move { s2.status(&bg(), &abs("r")).await });
    until(|| g.entered() == 2).await;
    gates[1].open();
    let _ = mid.await.unwrap();
    let other = format!("{}-other", abs("r"));
    let s3 = st.clone();
    let o = tokio::spawn(async move { s3.status(&bg(), &other).await });
    until(|| g.entered() == 3).await;
    gates[2].open();
    let _ = o.await.unwrap();
    gates[0].open();
    let _ = old.await.unwrap();
    if let Some(obs) = st.observed(&abs("r")) {
        assert_ne!(untracked(&obs), "old.txt");
    }
}

#[test]
fn mark_deterministic_and_sensitive() {
    let mut a = Observation::default();
    a.status.branch = "main".into();
    let mut b = a.clone();
    assert!(mark(&a) == mark(&b) && !mark(&a).is_empty());
    b.status.untracked = vec![FileEntry {
        path: "x".into(),
        xy: "??".into(),
        ..FileEntry::default()
    }];
    assert_ne!(mark(&a), mark(&b));
    // 모든 Status 필드가 지문을 움직인다.
    let base = mark(&Observation::default());
    let edits: Vec<fn(&mut Status)> = vec![
        |s| s.repo = "x".into(),
        |s| s.oid = "x".into(),
        |s| s.branch = "x".into(),
        |s| s.detached = true,
        |s| s.initial = true,
        |s| s.upstream = "x".into(),
        |s| s.has_upstream = true,
        |s| s.ahead = 7,
        |s| s.behind = 7,
        |s| s.total = 7,
        |s| s.truncated = Some([("untracked".to_owned(), 9)].into()),
        |s| s.output_truncated = true,
        |s| s.operation.kind = "merge".into(),
    ];
    for (i, e) in edits.iter().enumerate() {
        let mut o = Observation::default();
        e(&mut o.status);
        assert_ne!(mark(&o), base, "{i}");
    }
    let one = |e: FileEntry| {
        let mut o = Observation::default();
        o.status.changes = vec![e];
        mark(&o)
    };
    let p = || FileEntry {
        path: "p".into(),
        xy: ".M".into(),
        ..FileEntry::default()
    };
    let r = one(p());
    for e in [
        FileEntry {
            orig_path: "q".into(),
            ..p()
        },
        FileEntry { score: 90, ..p() },
        FileEntry { dir: true, ..p() },
        FileEntry {
            sub: "S.M.".into(),
            ..p()
        },
    ] {
        assert_ne!(one(e), r);
    }
}

#[test]
fn mark_matches_go() {
    // go1.27.2 실측: store.Mark(Observation{}) 와 Branch="main" 의 값.
    let mut o = Observation::default();
    assert_eq!(mark(&o), GO_MARK_ZERO);
    o.status.branch = "main".into();
    assert_eq!(mark(&o), GO_MARK_MAIN);
}

const GO_MARK_ZERO: &str = "1dyuxhts8py4v";
const GO_MARK_MAIN: &str = "11scdfklsagxi";

#[test]
fn is_terminal_kinds() {
    for (k, want) in [
        (Kind::NotRepo, true),
        (Kind::RepoMissing, true),
        (Kind::GitMissing, true),
        (Kind::Timeout, false),
        (Kind::Canceled, false),
    ] {
        assert_eq!(is_terminal(&CoreError::new(k, "x")), want);
    }
    assert!(!is_terminal(&CoreError::other("exit 128")));
}
