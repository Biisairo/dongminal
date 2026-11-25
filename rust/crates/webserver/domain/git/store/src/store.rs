//! status·repo root·gitdir 캐시와 single-flight.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use otter_gocompat::filepath;
use otter_webserver_domain_git_core::{Ctx, DEFAULT_TIMEOUT, Service, ctx_err};
use otter_webserver_domain_git_query::{self as query, Error, Signature, Status};
use serde::Serialize;
use tokio::sync::Notify;

/// O3. status 폴링 주기(1s)보다 짧다.
pub const DEFAULT_STATUS_TTL: Duration = Duration::from_millis(200);
pub const DEFAULT_REPO_ROOT_TTL: Duration = Duration::from_secs(2);
/// 관측값을 들고 있을 리포 수 상한.
pub const DEFAULT_OBSERVED_CAP: usize = 64;

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct Observation {
    pub status: Status,
    pub signature: Signature,
    #[serde(rename = "observedAtUnixMs")]
    pub observed_at_unix_ms: i64,
}

pub type Clock = Arc<dyn Fn() -> SystemTime + Send + Sync>;

/// 한 번의 비행. 결과는 한 번만 채워지고 기다리던 쪽 모두가 같은 값을 받는다.
pub(crate) struct Flight<T> {
    done: Notify,
    result: OnceLock<T>,
}

impl<T: Clone> Flight<T> {
    fn new() -> Arc<Self> {
        Arc::new(Flight {
            done: Notify::new(),
            result: OnceLock::new(),
        })
    }

    fn finish(&self, v: T) {
        let _ = self.result.set(v);
        self.done.notify_waiters();
    }

    /// 끝나면 Some, ctx 가 먼저 끝나면 None.
    async fn wait(&self, ctx: &Ctx) -> Option<T> {
        loop {
            let notified = self.done.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if let Some(v) = self.result.get() {
                return Some(v.clone());
            }
            tokio::select! {
                _ = &mut notified => {}
                _ = ctx.done() => return self.result.get().cloned(),
            }
        }
    }
}

pub(crate) type StatusResult = Result<Observation, Error>;
pub(crate) type RootResult = Result<String, Error>;
pub(crate) type DirsResult = Result<(String, String), Error>;

pub(crate) struct RepoState {
    /// 이 상태가 만들어질 때 받은 고유 번호 (Go 의 포인터 동일성).
    id: u64,
    generation: u64,
    inflight: Option<(Arc<Flight<StatusResult>>, u64)>,
    obs: Observation,
    at: Option<SystemTime>,
    valid: bool,
}

pub(crate) struct Cached<T> {
    pub(crate) val: T,
    pub(crate) at: SystemTime,
}

#[derive(Default)]
pub(crate) struct Inner {
    pub(crate) generation: u64,
    pub(crate) states: HashMap<String, RepoState>,
    /// 앞이 최근 사용.
    pub(crate) lru: Vec<String>,
    pub(crate) roots: HashMap<String, Cached<RootResult>>,
    pub(crate) dirs: HashMap<String, Cached<(String, String)>>,
    pub(crate) root_flights: HashMap<String, Arc<Flight<RootResult>>>,
    pub(crate) dir_flights: HashMap<String, Arc<Flight<DirsResult>>>,
}

impl Inner {
    fn next_generation(&mut self) -> u64 {
        self.generation += 1;
        self.generation
    }

    fn touch(&mut self, repo: &str) {
        if let Some(i) = self.lru.iter().position(|r| r == repo) {
            let r = self.lru.remove(i);
            self.lru.insert(0, r);
        }
    }
}

/// Store 의 선택 사항.
#[derive(Default)]
pub struct StoreOptions {
    status_ttl: Option<Duration>,
    root: Option<Ctx>,
    clock: Option<Clock>,
    observed_cap: Option<usize>,
}

impl StoreOptions {
    /// 0 이면 캐시하지 않는다(single-flight 만).
    pub fn status_ttl(mut self, d: Duration) -> Self {
        self.status_ttl = Some(d);
        self
    }

    /// 서버 수명 문맥. 비행은 이것에서 파생한다 (S-1).
    pub fn root(mut self, ctx: Ctx) -> Self {
        self.root = Some(ctx);
        self
    }

    pub fn clock(mut self, now: Clock) -> Self {
        self.clock = Some(now);
        self
    }

    #[cfg(test)]
    pub(crate) fn observed_cap(mut self, n: usize) -> Self {
        self.observed_cap = Some(n);
        self
    }
}

pub struct Store {
    svc: Arc<Service>,
    root: Ctx,
    now: Clock,
    status_ttl: Duration,
    repo_root_ttl: Duration,
    observed_cap: usize,
    pub(crate) mu: Mutex<Inner>,
}

fn since(now: SystemTime, at: Option<SystemTime>) -> Duration {
    match at {
        Some(at) => now.duration_since(at).unwrap_or(Duration::ZERO),
        None => Duration::MAX,
    }
}

fn unix_ms(t: SystemTime) -> i64 {
    match t.duration_since(UNIX_EPOCH) {
        Ok(d) => d.as_millis() as i64,
        Err(e) => -(e.duration().as_millis() as i64),
    }
}

impl Store {
    pub fn new(svc: Arc<Service>, opts: StoreOptions) -> Arc<Store> {
        Arc::new(Store {
            svc,
            root: opts.root.unwrap_or_default(),
            now: opts.clock.unwrap_or_else(|| Arc::new(SystemTime::now)),
            status_ttl: opts.status_ttl.unwrap_or(DEFAULT_STATUS_TTL),
            repo_root_ttl: DEFAULT_REPO_ROOT_TTL,
            observed_cap: opts.observed_cap.unwrap_or(DEFAULT_OBSERVED_CAP),
            mu: Mutex::new(Inner::default()),
        })
    }

    pub(crate) fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.mu.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn service(&self) -> &Arc<Service> {
        &self.svc
    }

    pub fn root(&self) -> &Ctx {
        &self.root
    }

    pub async fn common_dir(self: &Arc<Self>, ctx: &Ctx, repo: &str) -> Result<String, Error> {
        Ok(self.git_dirs(ctx, repo).await?.1)
    }

    /// 리포의 관측값이다. 두 번째 값은 캐시나 진행 중 비행을 받았는가다.
    pub async fn status(self: &Arc<Self>, ctx: &Ctx, repo: &str) -> (StatusResult, bool) {
        let (flight, joined) = {
            let mut g = self.lock();
            let now = (self.now)();
            self.state_locked(&mut g, repo);
            let s = g.states.get_mut(repo).expect("state_locked 가 만들었다");
            if s.valid && !self.status_ttl.is_zero() && since(now, s.at) < self.status_ttl {
                return (Ok(s.obs.clone()), true);
            }
            match &s.inflight {
                Some((f, generation)) if *generation == s.generation => (f.clone(), true),
                _ => {
                    let f = Flight::new();
                    s.inflight = Some((f.clone(), s.generation));
                    let (id, generation) = (s.id, s.generation);
                    self.spawn_fly(repo.to_owned(), f.clone(), id, generation);
                    (f, false)
                }
            }
        };
        match flight.wait(ctx).await {
            Some(r) => (r, joined),
            None => (Err(waiting(ctx, "status 를 기다리는 중")), joined),
        }
    }

    fn spawn_fly(
        self: &Arc<Self>,
        repo: String,
        f: Arc<Flight<StatusResult>>,
        id: u64,
        generation: u64,
    ) {
        let me = self.clone();
        tokio::spawn(async move {
            let ctx = me.root.with_timeout(DEFAULT_TIMEOUT);
            let res = me.observe(&ctx, &repo).await;
            {
                let mut g = me.lock();
                let now = (me.now)();
                let mut promote = false;
                if let Some(s) = g.states.get_mut(&repo)
                    && s.id == id
                {
                    if s.inflight.as_ref().is_some_and(|(x, _)| Arc::ptr_eq(x, &f)) {
                        s.inflight = None;
                    }
                    if let Ok(obs) = &res
                        && s.generation == generation
                    {
                        s.obs = obs.clone();
                        s.at = Some(now);
                        s.valid = true;
                        promote = true;
                    }
                }
                if promote {
                    g.touch(&repo);
                }
                me.evict_locked(&mut g);
            }
            f.finish(res);
        });
    }

    /// 다음 status 가 git 을 다시 보게 한다. 진행 중 비행의 결과는 캐시에 오르지 않는다.
    pub fn invalidate(&self, repo: &str) {
        let mut g = self.lock();
        let next = g.next_generation();
        if let Some(s) = g.states.get_mut(repo) {
            s.at = None;
            s.generation = next;
        }
    }

    /// 마지막 관측값이다. TTL 을 보지 않고 git 을 실행하지 않는다.
    pub fn observed(&self, repo: &str) -> Option<Observation> {
        let mut g = self.lock();
        let obs = g
            .states
            .get(repo)
            .filter(|s| s.valid)
            .map(|s| s.obs.clone())?;
        g.touch(repo);
        Some(obs)
    }

    pub async fn signature(self: &Arc<Self>, ctx: &Ctx, repo: &str) -> Result<Signature, Error> {
        let (git_dir, common) = self.git_dirs(ctx, repo).await?;
        self.read_signature(repo, &git_dir, &common)
    }

    /// 캐시한 gitdir 로 읽지 못하면 그 해석을 잊는다 — 저장소가 옮겨졌거나 바뀌었을 수 있다.
    fn read_signature(&self, repo: &str, git_dir: &str, common: &str) -> Result<Signature, Error> {
        let r = query::read_signature(git_dir, common);
        if r.is_err() {
            self.forget_dirs(repo);
        }
        r
    }

    /// cwd 의 저장소 루트다. 실패도 TTL 동안 캐시한다.
    pub async fn repo_root(self: &Arc<Self>, ctx: &Ctx, cwd: &str) -> RootResult {
        let f = {
            let mut g = self.lock();
            let now = (self.now)();
            if let Some(e) = g.roots.get(cwd)
                && since(now, Some(e.at)) < self.repo_root_ttl
            {
                return e.val.clone();
            }
            match g.root_flights.get(cwd) {
                Some(f) => f.clone(),
                None => {
                    let f = Flight::new();
                    g.root_flights.insert(cwd.to_owned(), f.clone());
                    let me = self.clone();
                    let (cwd, f2) = (cwd.to_owned(), f.clone());
                    tokio::spawn(async move {
                        let ctx = me.root.with_timeout(DEFAULT_TIMEOUT);
                        let res: RootResult =
                            me.svc.repo_root(&ctx, &cwd).await.map_err(Error::from);
                        {
                            let mut g = me.lock();
                            if g.root_flights
                                .get(&cwd)
                                .is_some_and(|x| Arc::ptr_eq(x, &f2))
                            {
                                g.root_flights.remove(&cwd);
                                let now = (me.now)();
                                prune_cache(
                                    &mut g.roots,
                                    me.observed_cap,
                                    now,
                                    Some(me.repo_root_ttl),
                                );
                                g.roots.insert(
                                    cwd,
                                    Cached {
                                        val: res.clone(),
                                        at: now,
                                    },
                                );
                            }
                        }
                        f2.finish(res);
                    });
                    f
                }
            }
        };
        wait_or(f, ctx, "저장소 루트를 기다리는 중").await
    }

    /// 그 경로(와 그 아래)의 루트·gitdir 해석 기억을 지운다 (FR-RTU-28).
    pub fn forget_root(&self, path: &str) {
        if path.is_empty() {
            return;
        }
        let path = filepath::clean(path);
        let sep = filepath::SEPARATOR.to_string();
        let prefix = if path.ends_with(&sep) {
            path.clone()
        } else {
            format!("{path}{sep}")
        };
        let under = |k: &String| *k == path || k.starts_with(&prefix);
        let mut g = self.lock();
        g.roots.retain(|k, _| !under(k));
        g.root_flights.retain(|k, _| !under(k));
        g.dirs.retain(|k, _| !under(k));
        g.dir_flights.retain(|k, _| !under(k));
    }

    /// 그 저장소의 gitdir 해석을 지운다. 진행 중 비행의 결과는 캐시에 오르지 않는다.
    pub fn forget_dirs(&self, repo: &str) {
        let mut g = self.lock();
        g.dirs.remove(repo);
        g.dir_flights.remove(repo);
    }

    /// gitdir·common_dir 해석이다. 시간으로 만료되지 않는다 — `.git` 이 바뀌면 감시가
    /// `forget_dirs` 로, 저장소가 사라지면 `forget_root` 로 지운다.
    async fn git_dirs(self: &Arc<Self>, ctx: &Ctx, repo: &str) -> DirsResult {
        let f = {
            let mut g = self.lock();
            if let Some(e) = g.dirs.get(repo) {
                return Ok(e.val.clone());
            }
            match g.dir_flights.get(repo) {
                Some(f) => f.clone(),
                None => {
                    let f = Flight::new();
                    g.dir_flights.insert(repo.to_owned(), f.clone());
                    let me = self.clone();
                    let (repo, f2) = (repo.to_owned(), f.clone());
                    tokio::spawn(async move {
                        let ctx = me.root.with_timeout(DEFAULT_TIMEOUT);
                        let res: DirsResult =
                            me.svc.git_dirs(&ctx, &repo).await.map_err(Error::from);
                        {
                            let mut g = me.lock();
                            if g.dir_flights
                                .get(&repo)
                                .is_some_and(|x| Arc::ptr_eq(x, &f2))
                            {
                                g.dir_flights.remove(&repo);
                                if let Ok(v) = &res {
                                    let now = (me.now)();
                                    prune_cache(&mut g.dirs, me.observed_cap, now, None);
                                    g.dirs.insert(
                                        repo,
                                        Cached {
                                            val: v.clone(),
                                            at: now,
                                        },
                                    );
                                }
                            }
                        }
                        f2.finish(res);
                    });
                    f
                }
            }
        };
        wait_or(f, ctx, "gitdir 해석을 기다리는 중").await
    }

    async fn observe(self: &Arc<Self>, ctx: &Ctx, repo: &str) -> StatusResult {
        let mut status = query::status_of(&self.svc, ctx, repo).await?;
        let (git_dir, common) = self.git_dirs(ctx, repo).await?;
        let signature = self.read_signature(repo, &git_dir, &common)?;
        status.operation = query::detect_operation(&git_dir);
        Ok(Observation {
            status,
            signature,
            observed_at_unix_ms: unix_ms((self.now)()),
        })
    }

    fn state_locked(&self, g: &mut Inner, repo: &str) {
        if g.states.contains_key(repo) {
            g.touch(repo);
            return;
        }
        let generation = g.next_generation();
        g.states.insert(
            repo.to_owned(),
            RepoState {
                id: generation,
                generation,
                inflight: None,
                obs: Observation::default(),
                at: None,
                valid: false,
            },
        );
        g.lru.insert(0, repo.to_owned());
    }

    /// 상한을 넘으면 오래된 것부터 버린다. 비행 중인 상태는 건너뛴다.
    fn evict_locked(&self, g: &mut Inner) {
        while g.lru.len() > self.observed_cap {
            let Some(i) = g
                .lru
                .iter()
                .rposition(|r| g.states.get(r).is_some_and(|s| s.inflight.is_none()))
            else {
                return;
            };
            let r = g.lru.remove(i);
            g.states.remove(&r);
        }
    }
}

fn waiting(ctx: &Ctx, what: &str) -> Error {
    ctx_err(ctx, what)
        .map(Error::from)
        .unwrap_or_else(|| Error::other(what))
}

async fn wait_or<T: Clone>(
    f: Arc<Flight<Result<T, Error>>>,
    ctx: &Ctx,
    what: &str,
) -> Result<T, Error> {
    match f.wait(ctx).await {
        Some(r) => r,
        None => Err(waiting(ctx, what)),
    }
}

/// 상한에 닿으면 만료된 것(ttl 이 있을 때)을 버리고, 그래도 차 있으면 가장 오래된 것부터 버린다.
pub(crate) fn prune_cache<V>(
    m: &mut HashMap<String, Cached<V>>,
    cap: usize,
    now: SystemTime,
    ttl: Option<Duration>,
) {
    if m.len() < cap {
        return;
    }
    if let Some(ttl) = ttl {
        m.retain(|_, v| since(now, Some(v.at)) < ttl);
    }
    while m.len() >= cap {
        let Some(oldest) = m.iter().min_by_key(|(_, v)| v.at).map(|(k, _)| k.clone()) else {
            return;
        };
        m.remove(&oldest);
    }
}
