use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use futures_util::future::BoxFuture;
use otter_webserver_domain_git_core::{self as core, Ctx};
use otter_webserver_domain_git_query::{Error, FileEntry, Signature};
use otter_webserver_domain_git_store::Observation;

use super::FakeBroker;
use crate::gitwatch::round::{need_status, pending_step, settles_pending};
use crate::gitwatch::{WatchPend, phase_hash};
use crate::lock;
use crate::*;

#[derive(Default)]
struct Sig {
    sigs: HashMap<String, String>,
    files: HashMap<String, Vec<String>>,
    errs: HashMap<String, Error>,
    sig_errs: HashMap<String, Error>,
    calls: usize,
    sig_calls: usize,
    invalidated: usize,
    forgot: Vec<String>,
}

#[derive(Default, Clone)]
struct FakeSigner(Arc<Mutex<Sig>>);

impl FakeSigner {
    fn with(sigs: &[(&str, &str)]) -> FakeSigner {
        let f = FakeSigner::default();
        for (r, s) in sigs {
            f.set_sig(r, s);
        }
        f
    }
    fn s(&self) -> std::sync::MutexGuard<'_, Sig> {
        lock(&self.0)
    }
    fn set_sig(&self, r: &str, v: &str) {
        self.s().sigs.insert(r.into(), v.into());
    }
    fn set_files(&self, r: &str, f: &[&str]) {
        self.s()
            .files
            .insert(r.into(), f.iter().map(|s| (*s).to_owned()).collect());
    }
    fn calls(&self) -> usize {
        self.s().calls
    }
    fn obs(&self, repo: &str) -> Option<Observation> {
        let s = self.s();
        if s.errs.contains_key(repo) {
            return None;
        }
        let mut o = Observation {
            signature: Signature {
                value: s.sigs.get(repo).cloned().unwrap_or_default(),
                ..Default::default()
            },
            ..Default::default()
        };
        for p in s.files.get(repo).into_iter().flatten() {
            o.status.untracked.push(FileEntry {
                path: p.clone(),
                xy: "??".into(),
                ..Default::default()
            });
        }
        Some(o)
    }
}

impl GitObserver for FakeSigner {
    fn status<'a>(
        &'a self,
        _: &'a Ctx,
        repo: &'a str,
    ) -> BoxFuture<'a, Result<Observation, Error>> {
        Box::pin(async move {
            self.s().calls += 1;
            if let Some(e) = self.s().errs.get(repo) {
                return Err(e.clone());
            }
            Ok(self.obs(repo).unwrap_or_default())
        })
    }
    fn signature<'a>(
        &'a self,
        _: &'a Ctx,
        repo: &'a str,
    ) -> BoxFuture<'a, Result<Signature, Error>> {
        Box::pin(async move {
            let mut s = self.s();
            s.sig_calls += 1;
            if let Some(e) = s.sig_errs.get(repo) {
                return Err(e.clone());
            }
            Ok(Signature {
                value: s.sigs.get(repo).cloned().unwrap_or_default(),
                ..Default::default()
            })
        })
    }
    fn invalidate(&self, _: &str) {
        self.s().invalidated += 1;
    }
    fn observed(&self, _: &str) -> Option<Observation> {
        None
    }
    fn forget_root(&self, path: &str) {
        self.s().forgot.push(path.into());
    }
}

type Now = Arc<Mutex<SystemTime>>;

fn watcher(sig: &FakeSigner, br: &Arc<FakeBroker>) -> (Arc<GitWatcher>, Now) {
    watcher_cap(sig, br, GIT_WATCH_CAP, None)
}

fn watcher_cap(
    sig: &FakeSigner,
    br: &Arc<FakeBroker>,
    cap: usize,
    after: Option<AfterFn>,
) -> (Arc<GitWatcher>, Now) {
    let now: Now = Arc::new(Mutex::new(SystemTime::now()));
    let n2 = now.clone();
    let w = GitWatcher::for_test(
        Arc::new(sig.clone()),
        br.clone(),
        Arc::new(move || *lock(&n2)),
        after,
        GIT_WATCH_TTL,
        cap,
    );
    (w, now)
}

fn advance(now: &Now, d: Duration) {
    *lock(now) += d;
}

fn note(w: &GitWatcher, sig: &FakeSigner, repo: &str) {
    w.note(repo, &sig.obs(repo).unwrap_or_default());
}

async fn tick(w: &GitWatcher) -> usize {
    w.tick(&Ctx::background()).await
}

fn changed(br: &FakeBroker) -> Vec<(String, String)> {
    br.sent()
        .iter()
        .filter_map(|p| {
            let rest = p.strip_prefix(r#"{"action":"git_changed","args":{"mark":""#)?;
            let (mark, rest) = rest.split_once(r#"","repo":""#)?;
            Some((rest.strip_suffix(r#""}}"#)?.to_owned(), mark.to_owned()))
        })
        .collect()
}

fn repos(br: &FakeBroker) -> Vec<String> {
    changed(br).into_iter().map(|(r, _)| r).collect()
}

fn missing() -> Error {
    core::Error::new(core::Kind::RepoMissing, "no such gitdir").into()
}

#[tokio::test]
async fn broadcasts_only_on_change() {
    let sig = FakeSigner::with(&[("/r", "a")]);
    let br = FakeBroker::new();
    let (w, _) = watcher(&sig, &br);
    note(&w, &sig, "/r");
    tick(&w).await;
    tick(&w).await;
    assert_eq!(br.count(), 0, "값이 그대로인데 방송했다 (G-1)");
    sig.set_sig("/r", "b");
    assert_eq!(tick(&w).await, 1);
    assert_eq!(repos(&br), vec!["/r"]);
    tick(&w).await;
    assert_eq!(repos(&br).len(), 1, "같은 변화를 두 번 알렸다 (G-2)");
}

#[tokio::test]
async fn no_interest_no_read() {
    let sig = FakeSigner::with(&[("/r", "a")]);
    let (w, _) = watcher(&sig, &FakeBroker::new());
    for _ in 0..5 {
        tick(&w).await;
    }
    assert_eq!(sig.calls() + sig.s().sig_calls, 0);
}

#[tokio::test]
async fn interest_expires_and_note_refreshes() {
    let sig = FakeSigner::with(&[("/r", "a")]);
    let (w, now) = watcher(&sig, &FakeBroker::new());
    note(&w, &sig, "/r");
    assert_eq!(w.watching(), 1);
    advance(&now, GIT_WATCH_TTL / 2);
    tick(&w).await;
    assert_eq!(w.watching(), 1);
    note(&w, &sig, "/r");
    advance(&now, GIT_WATCH_TTL - Duration::from_secs(1));
    tick(&w).await;
    assert_eq!(w.watching(), 1, "갱신된 표명이 만료됐다 (G-4b)");
    advance(&now, GIT_WATCH_TTL);
    tick(&w).await;
    assert_eq!(w.watching(), 0, "TTL 을 넘겼는데 남아 있다 (G-4)");
}

#[tokio::test]
async fn cap_evicts_oldest() {
    let sig = FakeSigner::default();
    let (w, now) = watcher(&sig, &FakeBroker::new());
    for i in 0..GIT_WATCH_CAP + 3 {
        note(&w, &sig, &format!("{}:/r", (b'a' + i as u8) as char));
        advance(&now, Duration::from_millis(1));
    }
    assert_eq!(w.watching(), GIT_WATCH_CAP);
    assert!(!w.held("a:/r"));
    assert!(
        !lock(&w.mu).watch.contains_key("a:/r"),
        "가장 오래된 표명이 살아남았다"
    );
}

#[tokio::test]
async fn cap_evicts_unleased_first() {
    let sig = FakeSigner::default();
    let (w, now) = watcher_cap(&sig, &FakeBroker::new(), 2, None);
    w.hold_topic("/leased", &sig.obs("/leased").unwrap_or_default());
    advance(&now, Duration::from_millis(1));
    note(&w, &sig, "/b");
    advance(&now, Duration::from_millis(1));
    note(&w, &sig, "/c");
    let g = lock(&w.mu);
    assert!(g.watch.contains_key("/leased") && !g.watch.contains_key("/b"));
}

#[tokio::test]
async fn error_drops_repo_and_notifies() {
    let sig = FakeSigner::with(&[("/ok", "a"), ("/gone", "x")]);
    let br = FakeBroker::new();
    let (w, _) = watcher(&sig, &br);
    note(&w, &sig, "/ok");
    note(&w, &sig, "/gone");
    sig.s().errs.insert("/gone".into(), missing());
    sig.set_sig("/gone", "y");
    tick(&w).await;
    assert_eq!(w.watching(), 1);
    assert_eq!(changed(&br), vec![("/gone".to_owned(), String::new())]);
    assert_eq!(sig.s().forgot, vec!["/gone"]);
    br.reset();
    sig.set_sig("/ok", "b");
    tick(&w).await;
    assert_eq!(repos(&br), vec!["/ok"]);
}

#[tokio::test]
async fn terminal_signature_error_drops() {
    let sig = FakeSigner::with(&[("/gone", "x")]);
    let br = FakeBroker::new();
    let (w, _) = watcher(&sig, &br);
    note(&w, &sig, "/gone");
    sig.s().sig_errs.insert("/gone".into(), missing());
    tick(&w).await;
    assert_eq!(w.watching(), 0);
    assert_eq!(
        sig.calls(),
        0,
        "signature 가 결정적 오류면 status 를 돌리지 않는다"
    );
    assert_eq!(changed(&br), vec![("/gone".to_owned(), String::new())]);
}

#[tokio::test]
async fn first_gate_is_signature() {
    let sig = FakeSigner::with(&[("/r", "a")]);
    let (w, _) = watcher(&sig, &FakeBroker::new());
    note(&w, &sig, "/r");
    for _ in 0..GIT_WATCH_WORKTREE_EVERY {
        tick(&w).await;
    }
    assert_eq!(sig.s().sig_calls as u64, GIT_WATCH_WORKTREE_EVERY);
    assert_eq!(sig.calls(), 1, "워크트리 회차가 하나가 아니다 (FR-GDT-3)");
}

#[tokio::test]
async fn signature_change_forces_status_and_invalidates() {
    let sig = FakeSigner::with(&[("/r", "a")]);
    let br = FakeBroker::new();
    let (w, _) = watcher(&sig, &br);
    note(&w, &sig, "/r");
    for _ in 0..GIT_WATCH_WORKTREE_EVERY * 2 {
        let before = sig.calls();
        tick(&w).await;
        if sig.calls() != before {
            continue;
        }
        sig.set_sig("/r", "b");
        let inv = sig.s().invalidated;
        tick(&w).await;
        assert_eq!(sig.calls(), before + 1);
        assert_eq!(
            sig.s().invalidated,
            inv + 1,
            "관측 전에 Invalidate 하지 않았다"
        );
        assert_eq!(repos(&br).len(), 1);
        return;
    }
    panic!("워크트리 회차가 아닌 회차를 찾지 못했다");
}

#[tokio::test]
async fn signature_error_falls_back_to_status() {
    let sig = FakeSigner::with(&[("/r", "a")]);
    let (w, _) = watcher(&sig, &FakeBroker::new());
    note(&w, &sig, "/r");
    sig.s()
        .sig_errs
        .insert("/r".into(), Error::other("gitdir 을 읽을 수 없다"));
    tick(&w).await;
    assert_eq!(sig.calls(), 1);
}

#[test]
fn worktree_phase_spread_and_fnv() {
    let seen: std::collections::HashSet<u64> = ["/a", "/b", "/c", "/d", "/e", "/f", "/g", "/h"]
        .iter()
        .map(|r| phase_hash(r) % GIT_WATCH_WORKTREE_EVERY)
        .collect();
    assert!(seen.len() >= 2);
    // Go hash/fnv New64a 의 알려진 값.
    assert_eq!(phase_hash(""), 0xcbf29ce484222325);
    assert_eq!(phase_hash("a"), 0xaf63dc4c8601ec8c);
}

#[tokio::test]
async fn worktree_and_file_state_changes_broadcast() {
    let sig = FakeSigner::with(&[("/r", "same")]);
    sig.set_files("/r", &["a.txt"]);
    let br = FakeBroker::new();
    let (w, _) = watcher(&sig, &br);
    note(&w, &sig, "/r");
    tick(&w).await;
    sig.set_files("/r", &["b.txt"]);
    for _ in 0..GIT_WATCH_WORKTREE_EVERY {
        tick(&w).await;
    }
    assert_eq!(repos(&br).len(), 1, "목록이 바뀌었는데 알리지 않았다 (G-9)");
    for _ in 0..GIT_WATCH_WORKTREE_EVERY {
        tick(&w).await;
    }
    assert_eq!(repos(&br).len(), 1);
}

#[tokio::test]
async fn change_right_after_note_and_renote_keep_baseline() {
    let sig = FakeSigner::with(&[("/r", "s")]);
    sig.set_files("/r", &[]);
    let br = FakeBroker::new();
    let (w, _) = watcher(&sig, &br);
    w.set_worktree_every(1);
    note(&w, &sig, "/r");
    sig.set_files("/r", &["raced.txt"]);
    note(&w, &sig, "/r"); // 재표명은 기준선을 덮지 않는다
    tick(&w).await;
    assert_eq!(repos(&br).len(), 1, "표명 직후의 변화를 놓쳤다 (G-10)");
}

#[tokio::test]
async fn transient_errors_keep_watch_and_back_off() {
    let sig = FakeSigner::with(&[("/r", "a")]);
    let br = FakeBroker::new();
    let (w, now) = watcher(&sig, &br);
    w.set_worktree_every(1);
    note(&w, &sig, "/r");
    sig.s().errs.insert("/r".into(), Error::other("index.lock"));
    tick(&w).await;
    assert_eq!((w.watching(), sig.calls()), (1, 1));
    tick(&w).await;
    assert_eq!(sig.calls(), 1, "백오프(1s) 동안 건너뛴다");
    advance(&now, Duration::from_secs(1));
    tick(&w).await;
    assert_eq!(sig.calls(), 2);
    advance(&now, Duration::from_secs(1));
    tick(&w).await;
    assert_eq!(sig.calls(), 2, "두 번째 실패 뒤는 2s 다");
    advance(&now, Duration::from_secs(1));
    sig.s().errs.clear();
    sig.set_sig("/r", "b");
    tick(&w).await;
    assert_eq!(repos(&br), vec!["/r"], "회복 뒤 기준선과 비교해 알린다");
}

#[tokio::test]
async fn hooks_called() {
    let sig = FakeSigner::with(&[("/r", "a")]);
    let (w, _) = watcher(&sig, &FakeBroker::new());
    let seen = Arc::new(Mutex::new(Vec::<String>::new()));
    let (s1, s2) = (seen.clone(), seen.clone());
    w.set_on_baseline(Some(Arc::new(move |r: &str| {
        lock(&s1).push(format!("base:{r}"))
    })));
    w.set_on_changed(Some(Arc::new(move |r: &str| {
        lock(&s2).push(format!("chg:{r}"))
    })));
    note(&w, &sig, "/r");
    note(&w, &sig, "/r");
    sig.set_sig("/r", "b");
    tick(&w).await;
    assert_eq!(*lock(&seen), vec!["base:/r", "chg:/r"]);
}

#[tokio::test]
async fn round_honours_context() {
    let sig = FakeSigner::with(&[("/a", "1"), ("/b", "1")]);
    let (w, _) = watcher(&sig, &FakeBroker::new());
    note(&w, &sig, "/a");
    note(&w, &sig, "/b");
    let ctx = Ctx::background().with_cancel();
    ctx.cancel();
    w.tick(&ctx).await;
    assert_eq!(sig.s().sig_calls, 0, "취소된 회차가 저장소를 시작했다");
}

#[test]
fn pure_steps() {
    let t0 = SystemTime::UNIX_EPOCH + Duration::from_secs(5);
    let idle = WatchPend::default();
    assert_eq!(
        pending_step(&idle, "a", true, "a", true, t0),
        (idle.clone(), false)
    );
    assert_eq!(
        pending_step(&idle, "a", true, "b", false, t0),
        (idle.clone(), false)
    );
    let (p, inv) = pending_step(&idle, "a", true, "b", true, t0);
    assert!(inv && p.on && p.sig == "b" && p.at == t0);
    let (p2, inv2) = pending_step(&p, "a", true, "b", true, t0 + Duration::from_secs(1));
    assert!(!inv2 && p2 == p, "같은 변화를 기다리는 중이면 합류만 한다");
    let (_, inv3) = pending_step(&idle, "", false, "a", true, t0);
    assert!(inv3, "기준선이 없으면 변화다");
    assert!(!need_status(false, false, false, false));
    assert!(need_status(true, false, false, false) && need_status(false, true, false, false));
    assert!(need_status(false, false, true, false) && need_status(false, false, false, true));
    assert!(settles_pending(true, &p));
    assert!(!settles_pending(false, &p) && !settles_pending(true, &idle));
}

// ── 계기 관측 (FR-ELR-75) ──

#[derive(Default)]
struct Timer {
    at: Duration,
    f: Option<Box<dyn FnOnce() + Send>>,
    stopped: bool,
}

type Timers = (Duration, Vec<Arc<Mutex<Timer>>>);

#[derive(Default, Clone)]
struct KickClock(Arc<Mutex<Timers>>);

impl KickClock {
    fn after(&self) -> AfterFn {
        let c = self.clone();
        Arc::new(move |d, f| {
            let mut g = lock(&c.0);
            let t = Arc::new(Mutex::new(Timer {
                at: g.0 + d,
                f: Some(f),
                stopped: false,
            }));
            g.1.push(t.clone());
            Box::new(move || lock(&t).stopped = true)
        })
    }

    async fn advance(&self, d: Duration) {
        let end = lock(&self.0).0 + d;
        loop {
            let next = {
                let mut g = lock(&self.0);
                g.1.sort_by_key(|t| lock(t).at);
                let next =
                    g.1.iter()
                        .find(|t| {
                            let t = lock(t);
                            !t.stopped && t.at <= end
                        })
                        .cloned();
                match next {
                    Some(t) => {
                        let mut tg = lock(&t);
                        tg.stopped = true;
                        g.0 = tg.at;
                        tg.f.take()
                    }
                    None => {
                        g.0 = end;
                        None
                    }
                }
            };
            let Some(f) = next else {
                return;
            };
            f();
            for _ in 0..20 {
                tokio::task::yield_now().await;
            }
        }
    }
}

fn kick_fx() -> (Arc<GitWatcher>, FakeSigner, Arc<FakeBroker>, KickClock) {
    let sig = FakeSigner::with(&[("/r", "a")]);
    let br = FakeBroker::new();
    let clk = KickClock::default();
    let (w, _) = watcher_cap(&sig, &br, GIT_WATCH_CAP, Some(clk.after()));
    note(&w, &sig, "/r");
    (w, sig, br, clk)
}

fn paths(p: &[&str]) -> Vec<String> {
    p.iter().map(|s| (*s).to_owned()).collect()
}

#[tokio::test]
async fn kick_observes_after_debounce() {
    let (w, sig, br, clk) = kick_fx();
    sig.set_files("/r", &["new.txt"]);
    w.kick(&paths(&["/r/new.txt"]));
    clk.advance(GIT_KICK_DEBOUNCE - Duration::from_millis(1))
        .await;
    assert_eq!(sig.calls(), 0);
    clk.advance(Duration::from_millis(1)).await;
    assert_eq!(sig.calls(), 1);
    assert!(sig.s().invalidated > 0, "관측 전에 Invalidate 하지 않았다");
    assert_eq!(repos(&br), vec!["/r"]);
}

#[tokio::test]
async fn kick_debounce_restarts() {
    let (w, sig, _, clk) = kick_fx();
    w.kick(&paths(&["/r/a"]));
    clk.advance(Duration::from_millis(600)).await;
    w.kick(&paths(&["/r/b"]));
    clk.advance(Duration::from_millis(600)).await;
    assert_eq!(sig.calls(), 0);
    clk.advance(Duration::from_millis(400)).await;
    assert_eq!(sig.calls(), 1);
}

#[tokio::test]
async fn kick_cooldown_coalesces() {
    let (w, sig, _, clk) = kick_fx();
    w.kick(&paths(&["/r/a"]));
    clk.advance(GIT_KICK_DEBOUNCE).await;
    assert_eq!(sig.calls(), 1);
    for _ in 0..3 {
        clk.advance(Duration::from_millis(300)).await;
        w.kick(&paths(&["/r/a"]));
    }
    clk.advance(GIT_KICK_COOLDOWN - Duration::from_secs(2))
        .await;
    assert_eq!(sig.calls(), 1, "쉬는 동안 관측했다");
    clk.advance(Duration::from_secs(2)).await;
    assert_eq!(sig.calls(), 2, "쉬는 동안 온 계기들을 한 번으로 모은다");
    clk.advance(GIT_KICK_COOLDOWN * 2).await;
    assert_eq!(sig.calls(), 2);
    assert_eq!(w.kick_pending(), 0, "끝난 계기 상태가 남았다");
}

#[tokio::test]
async fn kick_ignores_dot_git_outside_and_unwatched() {
    let (w, sig, _, clk) = kick_fx();
    w.kick(&paths(&["/r/.git", "/r/.git/index", "/rx/a", "/other/a"]));
    clk.advance(GIT_KICK_DEBOUNCE * 2).await;
    assert_eq!(sig.calls(), 0);
    assert_eq!(w.kick_pending(), 0);
}

/// TC-CH4-1: `git:<repo>` 토픽 구독이 쥐는 임대는 TTL 로 걷히지 않고, 놓으면 그때부터 TTL 이다.
#[tokio::test]
async fn topic_hold_outlives_ttl_and_release_starts_ttl() {
    let sig = FakeSigner::with(&[("/r", "a")]);
    let (w, now) = watcher(&sig, &FakeBroker::new());
    w.hold_topic("/r", &sig.obs("/r").unwrap_or_default());
    w.hold_topic("/r", &sig.obs("/r").unwrap_or_default());
    assert!(w.held("/r"));
    advance(&now, GIT_WATCH_TTL * 3);
    tick(&w).await;
    assert_eq!(w.watching(), 1, "토픽이 쥔 감시가 TTL 로 걷혔다");
    w.release_topic("/r");
    advance(&now, GIT_WATCH_TTL - Duration::from_secs(1));
    tick(&w).await;
    assert_eq!(w.watching(), 1, "놓자마자 걷혔다");
    advance(&now, GIT_WATCH_TTL);
    tick(&w).await;
    assert_eq!(w.watching(), 0, "놓은 뒤 TTL 을 넘겼는데 남아 있다");
}

/// TC-CH4-2: 관측 변화는 mark 훅으로 나간다 — 방송 경로는 없다.
#[tokio::test]
async fn change_goes_to_mark_hook() {
    let sig = FakeSigner::with(&[("/r", "a")]);
    let got: Arc<Mutex<Vec<(String, String)>>> = Arc::default();
    let w = GitWatcher::new(Some(Arc::new(sig.clone())));
    let g2 = got.clone();
    w.set_on_mark(Some(Arc::new(move |r: &str, m: &str| {
        lock(&g2).push((r.to_owned(), m.to_owned()));
    })));
    w.hold_topic("/r", &sig.obs("/r").unwrap_or_default());
    sig.set_sig("/r", "b");
    tick(&w).await;
    let v = lock(&got).clone();
    assert_eq!(v.len(), 1, "{v:?}");
    assert_eq!(v[0].0, "/r");
}
