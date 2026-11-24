//! 관심 표명·임차·축출 (FR-GPO-10~12 · GIT_WATCH_LEASE_SRS FR-GWL-1~8).

use std::collections::HashMap;
use std::time::{Duration, SystemTime};

use otter_gocompat::time::format_std_duration;
use otter_webserver_domain_git_store::Observation;

use super::{Entry, GitWatcher, State, WatchPend, obs_mark, phase_hash};

fn since(now: SystemTime, then: SystemTime) -> Duration {
    now.duration_since(then).unwrap_or(Duration::ZERO)
}

/// Go `Duration.Truncate(time.Second)`.
fn truncate_secs(d: Duration) -> Duration {
    Duration::from_secs(d.as_secs())
}

impl GitWatcher {
    /// 관심 표명이다 (FR-GPO-10). 수명은 `ttl` 이다.
    pub fn note(&self, repo: &str, obs: &Observation) {
        self.note_held(repo, obs, false);
    }

    /// `git:<repo>` 토픽에 구독자가 있는 동안의 임대다 (CHANNEL_PROTOCOL C4). 구독자가 몇이든
    /// 임대는 하나다 — 토픽이 구독자 수를 센다.
    pub fn hold_topic(&self, repo: &str, obs: &Observation) {
        self.note_held(repo, obs, true);
    }

    /// 토픽의 마지막 구독자가 떠났다. 그 뒤로는 관심 표명의 수명(`ttl`)을 따른다.
    pub fn release_topic(&self, repo: &str) {
        let now = (self.now)();
        if let Some(e) = self.lock().watch.get_mut(repo) {
            e.held = false;
            e.seen_at = now;
        }
    }

    fn note_held(&self, repo: &str, obs: &Observation, hold: bool) {
        if repo.is_empty() {
            return;
        }
        let mut g = self.lock();
        let now = (self.now)();
        let mark = obs_mark(obs);
        if let Some(e) = g.watch.get_mut(repo) {
            e.seen_at = now;
            e.held |= hold;
            // 기준선을 여기서 갱신하지 않는다 — 그 차이는 이미 방송으로 나갔다.
            return;
        }
        // 첫 표명은 기준선을 함께 받는다 — 브라우저가 방금 받은 관측이다.
        let e = Entry {
            last_mark: mark,
            seen_at: now,
            has_mark: true,
            last_sig: obs.signature.value.clone(),
            has_sig: !obs.signature.value.is_empty(),
            phase: phase_hash(repo),
            held: hold,
            pend: WatchPend::default(),
            fails: 0,
            retry_at: None,
        };
        g.watch.insert(repo.to_owned(), e);
        self.evict_locked(&mut g, now);
        let f = g.on_baseline.clone();
        drop(g);
        if let Some(f) = f {
            f(repo);
        }
    }

    /// 만료된 표명을 걷고, 그래도 상한을 넘으면 가장 오래된 것부터 뺀다 (FR-GPO-11·12).
    pub(super) fn evict_locked(&self, g: &mut State, now: SystemTime) {
        let ttl = self.ttl;
        g.watch.retain(|repo, e| {
            // FR-GWL-2: 임차인이 있으면 유휴로 걷지 않는다.
            if e.held || since(now, e.seen_at) <= ttl {
                return true;
            }
            // FR-GLW-7: 만료는 브라우저가 말을 멈춘 것이다.
            otter_shared_otterlog::infof!(
                None,
                "[gitwatch] 관심 표명 만료 — 감시를 걷는다 (repo={repo} idle={})",
                format_std_duration(truncate_secs(since(now, e.seen_at)))
            );
            false
        });
        // 상한 퇴출 (FR-GPO-12 · FR-GWL-6). 임차인 없는 것이 먼저 나간다.
        while g.watch.len() > self.cap {
            let (oldest, leased) = match oldest_watch(&g.watch, false) {
                Some(r) => (r, false),
                None => match oldest_watch(&g.watch, true) {
                    Some(r) => (r, true),
                    None => return,
                },
            };
            otter_shared_otterlog::infof!(
                None,
                "[gitwatch] 상한 초과로 감시를 퇴출한다 (repo={oldest} cap={} 임대={leased})",
                self.cap
            );
            if leased {
                otter_shared_otterlog::infof!(
                    None,
                    "[gitwatch] 퇴출된 저장소에 임차인이 남아 있었다 — 상한이 부족하다 (repo={oldest})"
                );
            }
            g.watch.remove(&oldest);
        }
    }

    /// 지금 감시 중인 저장소 수다.
    pub fn watching(&self) -> usize {
        self.lock().watch.len()
    }
}

/// 표명이 가장 오래된 항목이다. `leased` 는 임차인이 있는 것을 볼지 가른다.
fn oldest_watch(watch: &HashMap<String, Entry>, leased: bool) -> Option<String> {
    watch
        .iter()
        .filter(|(_, e)| e.held == leased)
        .min_by_key(|(_, e)| e.seen_at)
        .map(|(r, _)| r.clone())
}
