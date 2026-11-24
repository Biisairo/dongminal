//! git 관측을 서버가 밀어 준다 (GIT_PUSH_OBSERVE_SRS 묶음 W·S, GIT_DETECT_TIER_SRS,
//! GIT_WATCH_LEASE_SRS). 티커 하나가 회차를 돌고, 값이 바뀐 것만 `git_changed` 로 방송한다.

mod kick;
mod lease;
pub(crate) mod round;

use std::collections::HashMap;
use std::sync::atomic::AtomicU64;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, SystemTime};

use futures_util::future::BoxFuture;
use otter_webserver_domain_git_core::Ctx;
use otter_webserver_domain_git_query::{Error, Signature};
use otter_webserver_domain_git_store::{Observation, Store};

pub use kick::{GIT_KICK_COOLDOWN, GIT_KICK_DEBOUNCE};
pub use round::start_git_watch;

/// 감시 회차의 주기다 (FR-GPO-2).
pub const GIT_WATCH_INTERVAL: Duration = Duration::from_millis(1000);
/// 워크트리 회차의 간격(회차 수)이다 (FR-GDT-3).
pub const GIT_WATCH_WORKTREE_EVERY: u64 = 4;
/// 회차 하나의 시한이다 (FR-GDT-9, D-GDT-7).
pub const GIT_WATCH_ROUND_TIMEOUT: Duration = Duration::from_secs(20);
/// 한 회차에서 동시에 도는 관측 수의 상한이다 (FR-GDT-8).
pub const GIT_WATCH_PARALLEL: usize = 4;
/// 관심 표명의 수명이다 (FR-GPO-11).
pub const GIT_WATCH_TTL: Duration = Duration::from_secs(90);
/// 동시에 감시하는 저장소 수의 상한이다 (FR-GPO-12).
pub const GIT_WATCH_CAP: usize = 16;
/// 일시적 관측 실패 뒤 건너뛰는 시간의 상한이다 (min(2^(n-1), 30)s).
pub const GIT_WATCH_BACKOFF_MAX: Duration = Duration::from_secs(30);

/// 감시자가 필요로 하는 것 전부다. `Arc<Store>` 가 이것을 만족한다.
pub trait GitObserver: Send + Sync {
    /// TTL 캐시와 single-flight 를 지난다 (FR-GIT-21·63).
    fn status<'a>(
        &'a self,
        ctx: &'a Ctx,
        repo: &'a str,
    ) -> BoxFuture<'a, Result<Observation, Error>>;
    /// 1차 게이트다 (FR-GDT-1). git 을 실행하지 않는다.
    fn signature<'a>(
        &'a self,
        ctx: &'a Ctx,
        repo: &'a str,
    ) -> BoxFuture<'a, Result<Signature, Error>>;
    /// 세대를 올린다 (REPO_FIX 01 §4).
    fn invalidate(&self, repo: &str);
    /// 마지막 유효 관측이다.
    fn observed(&self, repo: &str) -> Option<Observation>;
    /// 루트 해석의 기억을 지운다 (FR-OPT-4-3).
    fn forget_root(&self, path: &str);
}

impl GitObserver for Arc<Store> {
    fn status<'a>(
        &'a self,
        ctx: &'a Ctx,
        repo: &'a str,
    ) -> BoxFuture<'a, Result<Observation, Error>> {
        Box::pin(async move { Store::status(self, ctx, repo).await.0 })
    }
    fn signature<'a>(
        &'a self,
        ctx: &'a Ctx,
        repo: &'a str,
    ) -> BoxFuture<'a, Result<Signature, Error>> {
        Box::pin(Store::signature(self, ctx, repo))
    }
    fn invalidate(&self, repo: &str) {
        Store::invalidate(self, repo);
    }
    fn observed(&self, repo: &str) -> Option<Observation> {
        Store::observed(self, repo)
    }
    fn forget_root(&self, path: &str) {
        Store::forget_root(self, path);
    }
}

/// 관측 식별자다. 정의는 `store::mark` 한 벌이다 (REPO_FIX 04 §3A-0 X5).
fn obs_mark(o: &Observation) -> String {
    otter_webserver_domain_git_store::mark(o)
}

/// 지연 실행. 돌려준 함수는 아직 돌지 않았으면 멈춘다 (Go `time.AfterFunc(...).Stop`).
pub type AfterFn =
    Arc<dyn Fn(Duration, Box<dyn FnOnce() + Send>) -> Box<dyn FnOnce() + Send> + Send + Sync>;
pub type RepoHook = Arc<dyn Fn(&str) + Send + Sync>;
/// 관측이 바뀐 저장소와 그 mark 를 받는다 (`git:<repo>` 토픽 발행, CHANNEL_PROTOCOL C4).
pub type MarkHook = Arc<dyn Fn(&str, &str) + Send + Sync>;
pub type WallClock = Arc<dyn Fn() -> SystemTime + Send + Sync>;

/// 기다리는 변화다: 기다리는가, 그 signature, 기다리기 시작한 시각.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct WatchPend {
    pub(crate) on: bool,
    pub(crate) sig: String,
    pub(crate) at: SystemTime,
}

impl Default for WatchPend {
    fn default() -> Self {
        WatchPend {
            on: false,
            sig: String::new(),
            at: SystemTime::UNIX_EPOCH,
        }
    }
}

pub(crate) struct Entry {
    last_mark: String,
    /// 마지막 관심 표명 시각
    seen_at: SystemTime,
    has_mark: bool,
    /// 1차 게이트의 직전 값 (FR-GDT-1·2).
    last_sig: String,
    has_sig: bool,
    /// 워크트리 회차의 위상 (FR-GDT-4).
    phase: u64,
    /// 이 저장소를 보는 신원들 (clientId[+갈래] → 구독의 epoch). 비어 있지 않으면 유휴로
    /// 만료되지 않는다 (FR-GWL-2).
    holders: HashMap<String, u64>,
    pend: WatchPend,
    fails: u32,
    retry_at: Option<SystemTime>,
}

#[derive(Default)]
struct KickState {
    debounce: Option<Box<dyn FnOnce() + Send>>,
    running: bool,
    cooling: bool,
    again: bool,
}

pub(crate) struct State {
    pub(crate) watch: HashMap<String, Entry>,
    /// 신원마다 가장 새로운 SSE 구독의 epoch (FR-GWL-3).
    live: HashMap<String, u64>,
    epoch: u64,
    round: u64,
    on_changed: Option<RepoHook>,
    on_baseline: Option<RepoHook>,
    on_mark: Option<MarkHook>,
    root: Option<Ctx>,
    kicks: HashMap<String, KickState>,
}

/// 관심 표명을 받아 두었다가 회차마다 그 저장소들을 확인한다.
pub struct GitWatcher {
    git: Option<Arc<dyn GitObserver>>,
    now: WallClock,
    ttl: Duration,
    cap: usize,
    /// 워크트리 회차의 간격. 0 이면 기본값이다 (FR-ELR-76).
    worktree_every: AtomicU64,
    /// 계기 관측의 시간을 주입하는 자리 (FR-ELR-75). 없으면 tokio 타이머다.
    after: Option<AfterFn>,
    pub(crate) mu: Mutex<State>,
}

/// 워크트리 회차 위상(FR-GDT-4)의 원천이다 (FNV-1a 64).
pub(crate) fn phase_hash(repo: &str) -> u64 {
    const OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
    const PRIME: u64 = 0x0000_0100_0000_01b3;
    repo.bytes()
        .fold(OFFSET, |h, b| (h ^ u64::from(b)).wrapping_mul(PRIME))
}

impl GitWatcher {
    pub fn new(git: Option<Arc<dyn GitObserver>>) -> Arc<GitWatcher> {
        GitWatcher::build(git, Arc::new(SystemTime::now), None)
    }

    fn build(
        git: Option<Arc<dyn GitObserver>>,
        now: WallClock,
        after: Option<AfterFn>,
    ) -> Arc<GitWatcher> {
        Arc::new(GitWatcher {
            git,
            now,
            ttl: GIT_WATCH_TTL,
            cap: GIT_WATCH_CAP,
            worktree_every: AtomicU64::new(0),
            after,
            mu: Mutex::new(State {
                watch: HashMap::new(),
                live: HashMap::new(),
                epoch: 0,
                round: 0,
                on_changed: None,
                on_baseline: None,
                on_mark: None,
                root: None,
                kicks: HashMap::new(),
            }),
        })
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        crate::lock(&self.mu)
    }

    /// 기준선 훅을 건다 (CODEMIRROR_MIGRATION_SRS §11.6 W).
    pub fn set_on_baseline(&self, f: Option<RepoHook>) {
        self.lock().on_baseline = f;
    }

    /// 방송 훅을 건다 (REPO_FIX 02 §3A-6).
    pub fn set_on_changed(&self, f: Option<RepoHook>) {
        self.lock().on_changed = f;
    }

    /// 관측 변화의 발행 훅을 건다 (`git:<repo>` 토픽, CHANNEL_PROTOCOL C4).
    pub fn set_on_mark(&self, f: Option<MarkHook>) {
        self.lock().on_mark = f;
    }

    /// 관측 변화를 발행하고 훅을 부른다.
    fn announce(&self, repo: &str, mark: &str) {
        let (m, f) = {
            let g = self.lock();
            (g.on_mark.clone(), g.on_changed.clone())
        };
        if let Some(m) = m {
            m(repo, mark);
        }
        if let Some(f) = f {
            f(repo);
        }
    }
}

#[cfg(test)]
impl GitWatcher {
    pub(crate) fn for_test(
        git: Arc<dyn GitObserver>,
        hub: Arc<dyn crate::CommandBroker>,
        now: WallClock,
        after: Option<AfterFn>,
        ttl: Duration,
        cap: usize,
    ) -> Arc<GitWatcher> {
        let w = GitWatcher::build(Some(git), now, after);
        let mut w = Arc::try_unwrap(w).ok().expect("새로 만든 Arc");
        w.ttl = ttl;
        w.cap = cap;
        w.set_on_mark(Some(Arc::new(move |repo: &str, mark: &str| {
            hub.broadcast(&crate::payloads::git_changed_payload(repo, mark));
        })));
        Arc::new(w)
    }

    pub(crate) fn holders(&self, repo: &str) -> usize {
        self.lock().watch.get(repo).map_or(0, |e| e.holders.len())
    }

    pub(crate) fn kick_pending(&self) -> usize {
        self.lock().kicks.len()
    }
}
