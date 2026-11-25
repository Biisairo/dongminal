//! 감시 회차 — 1차 게이트(signature)와 2차 관측(status), 탈락·백오프 (FR-GDT-1~10).

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use otter_gocompat::time::format_std_duration;
use otter_webserver_domain_git_core::Ctx;
use otter_webserver_domain_git_query::Error;
use tokio_util::sync::CancellationToken;

use super::{
    GIT_WATCH_BACKOFF_MAX, GIT_WATCH_FALLBACK_ROUNDS, GIT_WATCH_INTERVAL, GIT_WATCH_PARALLEL,
    GIT_WATCH_ROUND_TIMEOUT, GitWatcher, WatchPend, obs_mark,
};

/// Go `core.IsTerminal(err)` — 다시 물어도 같은 답일 실패인가.
fn is_terminal(e: &Error) -> bool {
    e.core()
        .is_some_and(otter_webserver_domain_git_core::is_terminal)
}

fn unix_milli(t: SystemTime) -> i64 {
    match t.duration_since(UNIX_EPOCH) {
        Ok(d) => d.as_millis() as i64,
        Err(e) => -(e.duration().as_millis() as i64),
    }
}

/// 회차를 도는 주체다 (FR-GPO-13). 대상이 없으면 첫 표명·임대가 깨울 때까지 잔다 (D-61).
/// 종료가 진행 중인 회차를 취소하고, 회차마다 시한을 건다 (FR-GDT-10).
pub fn start_git_watch(w: Arc<GitWatcher>, stop: CancellationToken) {
    tokio::spawn(async move {
        let root = Ctx::from_token(stop.child_token());
        w.lock().root = Some(root.clone());
        loop {
            if w.watching() == 0 {
                tokio::select! {
                    _ = w.wake.notified() => continue,
                    _ = stop.cancelled() => return,
                }
            }
            tokio::select! {
                _ = tokio::time::sleep(GIT_WATCH_INTERVAL) => {
                    let ctx = root.with_timeout(GIT_WATCH_ROUND_TIMEOUT);
                    w.tick(&ctx).await;
                    ctx.cancel();
                }
                _ = stop.cancelled() => return,
            }
        }
    });
}

impl GitWatcher {
    /// 회차 하나다 (FR-GPO-3). 직전 값과 다를 때만 방송하고, 방송한 수를 돌려준다. 회차를
    /// 상한 병렬로 돌고(FR-GDT-8), 시한이 끝나면 남은 저장소를 시작하지 않는다 (FR-GDT-9).
    pub async fn tick(&self, ctx: &Ctx) -> usize {
        if self.git.is_none() {
            return 0;
        }
        let (round, repos) = {
            let mut g = self.lock();
            let now = (self.now)();
            self.evict_locked(&mut g, now);
            let round = g.round;
            g.round += 1;
            (round, g.watch.keys().cloned().collect::<Vec<_>>())
        };
        let sent = AtomicUsize::new(0);
        // 시한도 취소로 본다 — fanout 은 토큰만 보므로 마감을 토큰으로 옮긴다.
        let cancel = CancellationToken::new();
        if ctx.err().is_some() {
            cancel.cancel();
        }
        let run = otter_shared_fanout::each(&cancel, GIT_WATCH_PARALLEL, repos.len(), |i| {
            let (repos, sent) = (&repos, &sent);
            async move {
                if self.observe(ctx, &repos[i], round, false).await {
                    sent.fetch_add(1, Ordering::SeqCst);
                }
            }
        });
        tokio::pin!(run);
        tokio::select! {
            biased;
            _ = &mut run => {}
            _ = ctx.done() => {
                cancel.cancel();
                (&mut run).await;
            }
        }
        sent.load(Ordering::SeqCst)
    }

    /// 저장소 하나의 회차다. 방송했으면 참이다. 2단이다 (FR-GDT-1·2): 1차는 signature,
    /// 2차 `git status` 는 ① signature 변화(pending) ② 워크트리 회차(파일 감시가 없어 물러선
    /// 저장소만, D-61) ③ signature 실패 ④ 계기(force) 때만 돈다. 결정적 오류만 감시에서 빼고, 일시적 오류는 백오프한다
    /// (REPO_FIX 02 §3A-1).
    pub(super) async fn observe(&self, ctx: &Ctx, repo: &str, round: u64, force: bool) -> bool {
        let Some(git) = self.git.clone() else {
            return false;
        };
        {
            let g = self.lock();
            match g.watch.get(repo) {
                Some(e) if e.retry_at.is_none_or(|r| (self.now)() >= r) => {}
                _ => return false,
            }
        }

        let sig = git.signature(ctx, repo).await;
        if let Err(e) = &sig
            && is_terminal(e)
        {
            return self.drop_repo(repo, e);
        }

        let (pending, pending_at, need, invalidate, worktree_round) = {
            let mut g = self.lock();
            let now = (self.now)();
            let Some(e) = g.watch.get_mut(repo) else {
                return false; // 회차 중에 만료·퇴출됐다
            };
            // FR-GDT-4 / D-GDT-2: 워크트리 회차를 저장소마다 어긋나게 돈다.
            let worktree_round =
                e.fallback && round.wrapping_add(e.phase) % GIT_WATCH_FALLBACK_ROUNDS == 0;
            let (sig_value, sig_ok) = match &sig {
                Ok(s) => (s.value.as_str(), true),
                Err(_) => ("", false),
            };
            let (next, inv) = pending_step(&e.pend, &e.last_sig, e.has_sig, sig_value, sig_ok, now);
            e.pend = next;
            let need = need_status(e.pend.on, worktree_round, !sig_ok, force);
            (e.pend.on, e.pend.at, need, inv || force, worktree_round)
        };

        // FR-GDT-7: 2차를 건너뛴 회차는 방송하지 않는다.
        if !need {
            return false;
        }
        if invalidate {
            git.invalidate(repo);
        }
        // 감시가 없으니 `.git` 변화도 물러섬 회차에서 다시 해석해 본다.
        if worktree_round {
            git.forget_dirs(repo);
        }

        let mut res = git.status(ctx, repo).await;
        if res.is_err() && pending {
            // 회차 시한이 놓친 관측을 flight 가 끝내 Store 에 남겼을 수 있다.
            if let Some(last) = git.observed(repo)
                && last.observed_at_unix_ms >= unix_milli(pending_at)
            {
                res = Ok(last);
            }
        }
        let obs = match res {
            Ok(o) => o,
            Err(e) => {
                if is_terminal(&e) {
                    return self.drop_repo(repo, &e);
                }
                self.fail(repo, &e, pending && ctx.err().is_some());
                return false;
            }
        };

        let mark = obs_mark(&obs);
        let (first, changed) = {
            let mut g = self.lock();
            let Some(e) = g.watch.get_mut(repo) else {
                return false;
            };
            e.fails = 0;
            e.retry_at = None;
            if settles_pending(pending, &e.pend) {
                e.last_sig = e.pend.sig.clone();
                e.has_sig = true;
                e.pend.on = false;
            }
            let first = !e.has_mark;
            let changed = e.has_mark && e.last_mark != mark;
            e.last_mark = mark.clone();
            e.has_mark = true;
            (first, changed)
        };
        if first || !changed {
            return false;
        }
        self.announce(repo, &mark);
        true
    }

    /// 결정적 오류의 저장소를 감시에서 빼고 `git_changed`(mark:"")를 한 번 알린다 (FR-RMS-6).
    fn drop_repo(&self, repo: &str, err: &Error) -> bool {
        if self.lock().watch.remove(repo).is_none() {
            return false;
        }
        // FR-GLW-7: 탈락은 저장소가 읽히지 않은 것이다 (FR-GPO-5).
        otter_shared_otterlog::errorf!(
            None,
            "[gitwatch] 저장소를 읽을 수 없어 감시에서 뺀다 (repo={repo} err={err})"
        );
        if let Some(git) = &self.git {
            git.forget_root(repo);
        }
        self.announce(repo, "");
        true
    }

    /// 일시적 관측 실패다. 기준선·임대·pending 을 그대로 두고 연속 실패 n 에 따라
    /// min(2^(n-1), 30)s 동안 건너뛴다. 회차 시한이 놓친 관측은 n 을 올리지 않는다.
    fn fail(&self, repo: &str, err: &Error, round_timeout: bool) {
        if round_timeout {
            return;
        }
        let (n, wait) = {
            let mut g = self.lock();
            let now = (self.now)();
            let Some(e) = g.watch.get_mut(repo) else {
                return;
            };
            e.fails += 1;
            let n = e.fails;
            let wait = if n <= 5 {
                Duration::from_secs(1 << (n - 1))
            } else {
                GIT_WATCH_BACKOFF_MAX
            };
            e.retry_at = Some(now + wait);
            (n, wait)
        };
        if n == 1 || n % 10 == 0 {
            otter_shared_otterlog::infof!(
                None,
                "[gitwatch] 관측 실패 — 감시는 유지하고 {} 뒤 다시 본다 (repo={repo} n={n} err={err})",
                format_std_duration(wait)
            );
        }
    }
}

/// 1차 게이트 한 번의 pending 전이다 (FR-GDT-1·2). 무효화가 필요한지도 돌려준다.
pub(crate) fn pending_step(
    cur: &WatchPend,
    last_sig: &str,
    has_sig: bool,
    sig: &str,
    sig_ok: bool,
    now: SystemTime,
) -> (WatchPend, bool) {
    if !sig_ok || (has_sig && last_sig == sig) {
        return (cur.clone(), false);
    }
    if cur.on && cur.sig == sig {
        return (cur.clone(), false);
    }
    (
        WatchPend {
            on: true,
            sig: sig.to_owned(),
            at: now,
        },
        true,
    )
}

/// 2차(`git status`)를 돌릴 회차인가다.
pub(crate) fn need_status(
    pending: bool,
    worktree_round: bool,
    sig_failed: bool,
    force: bool,
) -> bool {
    pending || worktree_round || sig_failed || force
}

/// 관측이 성립한 뒤 기다리던 signature 를 확정할 때인가다.
pub(crate) fn settles_pending(waited: bool, cur: &WatchPend) -> bool {
    waited && cur.on && !cur.sig.is_empty()
}
