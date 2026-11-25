//! git 관측을 서버가 밀어 준다 (GIT_PUSH_OBSERVE_SRS 묶음 W·S, GIT_DETECT_TIER_SRS,
//! GIT_WATCH_LEASE_SRS). 티커 하나가 회차를 돌고, 값이 바뀐 것만 `git_changed` 로 방송한다.

mod kick;
mod lease;
pub(crate) mod round;
mod tree;

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::{Duration, SystemTime};

use futures_util::future::BoxFuture;
use otter_webserver_domain_git_core::Ctx;
use otter_webserver_domain_git_query::{Error, Signature};
use otter_webserver_domain_git_store::{Observation, Store};
use tokio::sync::Notify;

pub use kick::{GIT_KICK_COOLDOWN, GIT_KICK_DEBOUNCE};
pub use round::start_git_watch;
pub use tree::{TreeEvent, TreeHook, TreeWatcher, WatchGuard};

pub use otter_shared_cadence::GIT_WATCH_FALLBACK_EVERY;
pub use otter_shared_cadence::GIT_WATCH_ROUND_EVERY as GIT_WATCH_INTERVAL;
/// 물러선 저장소가 워크트리 `git status` 를 도는 회차 간격(회차 수)이다 (D-61 Q5).
pub const GIT_WATCH_FALLBACK_ROUNDS: u64 = GIT_WATCH_FALLBACK_EVERY
    .as_millis()
    .div_ceil(GIT_WATCH_INTERVAL.as_millis()) as u64;
/// 회차 하나의 시한이다 (FR-GDT-9, D-GDT-7).
pub const GIT_WATCH_ROUND_TIMEOUT: Duration = Duration::from_secs(20);
/// 한 회차에서 동시에 도는 관측 수의 상한이다 (FR-GDT-8).
pub const GIT_WATCH_PARALLEL: usize = 4;
/// 관심 표명의 수명이다 (FR-GPO-11).
pub const GIT_WATCH_TTL: Duration = Duration::from_secs(90);
/// 동시에 감시하는 저장소 수의 상한이다 (FR-GPO-12).
pub const GIT_WATCH_CAP: usize = 16;
pub use otter_shared_cadence::GIT_WATCH_BACKOFF_MAX;

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
    /// 파일 감시가 없어 워크트리 회차로 물러섰다 (D-61 Q4).
    fallback: bool,
    /// 저장소 트리의 파일 감시. 항목과 함께 버려지면 감시가 멈춘다.
    tree: Option<WatchGuard>,
    /// 이 항목의 감시 세대. 늦게 온 감시 사건이 새 항목을 건드리지 않게 한다.
    watch_id: u64,
    /// `git:<repo>` 토픽에 구독자가 있다 (CHANNEL_PROTOCOL C4). 참이면 유휴로 만료되지 않는다 (FR-GWL-2).
    held: bool,
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
    round: u64,
    on_changed: Option<RepoHook>,
    on_baseline: Option<RepoHook>,
    on_mark: Option<MarkHook>,
    root: Option<Ctx>,
    kicks: HashMap<String, KickState>,
    tree: Option<Arc<dyn TreeWatcher>>,
    watch_ids: u64,
}

/// 관심 표명을 받아 두었다가 회차마다 그 저장소들을 확인한다.
pub struct GitWatcher {
    git: Option<Arc<dyn GitObserver>>,
    now: WallClock,
    ttl: Duration,
    cap: usize,
    /// 계기 관측의 시간을 주입하는 자리 (FR-ELR-75). 없으면 tokio 타이머다.
    after: Option<AfterFn>,
    /// 대상이 0 에서 생기면 멈춘 회차 주체를 깨운다 (D-61).
    wake: Notify,
    me: Weak<GitWatcher>,
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
        GitWatcher::build(
            git,
            Arc::new(SystemTime::now),
            None,
            GIT_WATCH_TTL,
            GIT_WATCH_CAP,
        )
    }

    fn build(
        git: Option<Arc<dyn GitObserver>>,
        now: WallClock,
        after: Option<AfterFn>,
        ttl: Duration,
        cap: usize,
    ) -> Arc<GitWatcher> {
        Arc::new_cyclic(|me| GitWatcher {
            git,
            now,
            ttl,
            cap,
            after,
            wake: Notify::new(),
            me: me.clone(),
            mu: Mutex::new(State {
                watch: HashMap::new(),
                round: 0,
                on_changed: None,
                on_baseline: None,
                on_mark: None,
                root: None,
                kicks: HashMap::new(),
                tree: None,
                watch_ids: 0,
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
        let w = GitWatcher::build(Some(git), now, after, ttl, cap);
        w.set_on_mark(Some(Arc::new(move |repo: &str, mark: &str| {
            hub.broadcast(&crate::payloads::git_changed_payload(repo, mark));
        })));
        w
    }

    /// 지금까지 돈 회차 수다.
    pub(crate) fn rounds(&self) -> u64 {
        self.lock().round
    }

    pub(crate) fn held(&self, repo: &str) -> bool {
        self.lock().watch.get(repo).is_some_and(|e| e.held)
    }

    pub(crate) fn kick_pending(&self) -> usize {
        self.lock().kicks.len()
    }
}
