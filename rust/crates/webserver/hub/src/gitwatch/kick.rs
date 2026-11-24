//! 계기 관측 — 감시 이벤트가 저장소 관측을 당긴다 (EDITOR_LIVE_RELOAD_SRS FR-ELR-75).

use std::sync::Arc;
use std::time::Duration;

use otter_webserver_domain_git_core::Ctx;

use super::{GIT_WATCH_ROUND_TIMEOUT, GitWatcher};

/// 감시 이벤트가 저장소 관측을 당기는 규칙이다 (VS Code `@debounce(1000)` 과 `status()` 뒤
/// `timeout(5000)`).
pub const GIT_KICK_DEBOUNCE: Duration = Duration::from_millis(1000);
pub const GIT_KICK_COOLDOWN: Duration = Duration::from_millis(5000);

impl GitWatcher {
    /// 감시 이벤트의 경로들을 받아, 그 경로를 품는 감시 중 저장소를 곧 관측하게 한다.
    /// `.git/` 아래 경로는 계기가 아니다 — signature 회차가 이미 본다.
    pub fn kick(self: &Arc<Self>, paths: &[String]) {
        let sep = std::path::MAIN_SEPARATOR_STR;
        let mut g = self.lock();
        let repos: Vec<String> = g
            .watch
            .keys()
            .filter(|repo| {
                let prefix = format!("{}{sep}", repo.strip_suffix(sep).unwrap_or(repo));
                let dot_git = format!("{prefix}.git");
                let dot_git_dir = format!("{dot_git}{sep}");
                paths.iter().any(|p| {
                    p.starts_with(&prefix) && *p != dot_git && !p.starts_with(&dot_git_dir)
                })
            })
            .cloned()
            .collect();
        for repo in repos {
            let k = g.kicks.entry(repo.clone()).or_default();
            if let Some(stop) = k.debounce.take() {
                stop();
            }
            let w = self.clone();
            k.debounce =
                Some(self.after_func(GIT_KICK_DEBOUNCE, Box::new(move || w.kick_fire(&repo))));
        }
    }

    fn after_func(&self, d: Duration, f: Box<dyn FnOnce() + Send>) -> Box<dyn FnOnce() + Send> {
        if let Some(after) = &self.after {
            return after(d, f);
        }
        let h = tokio::spawn(async move {
            tokio::time::sleep(d).await;
            f();
        });
        Box::new(move || h.abort())
    }

    /// debounce 가 끝난 순간이다. 관측 중이거나 쉬는 중이면 한 번으로 모은다.
    fn kick_fire(self: &Arc<Self>, repo: &str) {
        {
            let mut g = self.lock();
            let Some(k) = g.kicks.get_mut(repo) else {
                return;
            };
            k.debounce = None;
            if k.running || k.cooling {
                k.again = true;
                return;
            }
            k.running = true;
        }
        self.spawn_kick_run(repo.to_owned());
    }

    fn spawn_kick_run(self: &Arc<Self>, repo: String) {
        let w = self.clone();
        tokio::spawn(async move { w.kick_run(&repo).await });
    }

    async fn kick_run(self: &Arc<Self>, repo: &str) {
        let root = self.lock().root.clone().unwrap_or_else(Ctx::background);
        let ctx = root.with_timeout(GIT_WATCH_ROUND_TIMEOUT);
        self.observe(&ctx, repo, 0, true).await;
        ctx.cancel();
        let mut g = self.lock();
        let Some(k) = g.kicks.get_mut(repo) else {
            return;
        };
        k.running = false;
        k.cooling = true;
        let w = self.clone();
        let r = repo.to_owned();
        drop(self.after_func(GIT_KICK_COOLDOWN, Box::new(move || w.kick_cool(&r))));
    }

    fn kick_cool(self: &Arc<Self>, repo: &str) {
        {
            let mut g = self.lock();
            let Some(k) = g.kicks.get_mut(repo) else {
                return;
            };
            k.cooling = false;
            if !k.again {
                if k.debounce.is_none() {
                    g.kicks.remove(repo);
                }
                return;
            }
            k.again = false;
            k.running = true;
        }
        self.spawn_kick_run(repo.to_owned());
    }
}
