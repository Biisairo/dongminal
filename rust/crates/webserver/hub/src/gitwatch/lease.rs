//! 관심 표명·임차·축출 (FR-GPO-10~12 · GIT_WATCH_LEASE_SRS FR-GWL-1~8).

use std::collections::HashMap;
use std::time::{Duration, SystemTime};

use otter_gocompat::time::format_std_duration;
use otter_webserver_domain_git_store::Observation;

use super::{Entry, GitWatcher, State, WatchPend, obs_mark, phase_hash};

/// 임차인 키에서 신원과 갈래를 가른다. clientId 에 들 수 없는 글자다.
const HOLDER_SCOPE_SEP: &str = "\x1f";

fn holder_key(client_id: &str, scope: &str) -> String {
    if scope.is_empty() {
        client_id.to_owned()
    } else {
        format!("{client_id}{HOLDER_SCOPE_SEP}{scope}")
    }
}

fn since(now: SystemTime, then: SystemTime) -> Duration {
    now.duration_since(then).unwrap_or(Duration::ZERO)
}

/// Go `Duration.Truncate(time.Second)`.
fn truncate_secs(d: Duration) -> Duration {
    Duration::from_secs(d.as_secs())
}

impl GitWatcher {
    /// 임차인을 밝히지 않은 관심 표명이다 (FR-GPO-10). 수명은 `ttl` 이다.
    pub fn note(&self, repo: &str, obs: &Observation) {
        self.note_for(repo, obs, "");
    }

    /// 임차인을 밝힌 표명이다 (FR-GWL-1). 구독이 살아 있는 신원만 임차인이 된다 (FR-GWL-8).
    pub fn note_for(&self, repo: &str, obs: &Observation, client_id: &str) {
        self.note_scoped(repo, obs, client_id, "");
    }

    /// 갈래를 가진 임대다 (FR-OPT-4-3 · IPC-7).
    pub fn note_scoped(&self, repo: &str, obs: &Observation, client_id: &str, scope: &str) {
        if repo.is_empty() {
            return;
        }
        let mut g = self.lock();
        let now = (self.now)();
        let mark = obs_mark(obs);
        let ep = g.live.get(client_id).copied().unwrap_or(0);
        let holder = if client_id.is_empty() || ep == 0 {
            String::new()
        } else {
            holder_key(client_id, scope)
        };
        if let Some(e) = g.watch.get_mut(repo) {
            e.seen_at = now;
            if !holder.is_empty() {
                e.holders.insert(holder, ep);
            }
            // 기준선을 여기서 갱신하지 않는다 — 그 차이는 이미 방송으로 나갔다.
            return;
        }
        // 첫 표명은 기준선을 함께 받는다 — 브라우저가 방금 받은 관측이다.
        let mut e = Entry {
            last_mark: mark,
            seen_at: now,
            has_mark: true,
            last_sig: obs.signature.value.clone(),
            has_sig: !obs.signature.value.is_empty(),
            phase: phase_hash(repo),
            holders: HashMap::new(),
            pend: WatchPend::default(),
            fails: 0,
            retry_at: None,
        };
        if !holder.is_empty() {
            e.holders.insert(holder, ep);
        }
        g.watch.insert(repo.to_owned(), e);
        self.evict_locked(&mut g, now);
        let f = g.on_baseline.clone();
        drop(g);
        if let Some(f) = f {
            f(repo);
        }
    }

    /// 그 신원의 그 갈래 임대를 모든 저장소에서 놓는다 (FR-OPT-4-3). 감시는 걷지 않는다.
    pub fn release_scope(&self, client_id: &str, scope: &str) {
        if client_id.is_empty() {
            return;
        }
        let key = holder_key(client_id, scope);
        for e in self.lock().watch.values_mut() {
            e.holders.remove(&key);
        }
    }

    /// SSE 구독 하나를 신원에 결선한다 (FR-GWL-3). `FocusRegistry::attach_from` 과 같은 규약이다.
    pub fn attach(&self, client_id: &str) -> u64 {
        if client_id.is_empty() {
            return 0;
        }
        let mut g = self.lock();
        g.epoch += 1;
        let ep = g.epoch;
        g.live.insert(client_id.to_owned(), ep);
        ep
    }

    /// 그 신원을 모든 저장소의 임차인 목록에서 뺀다 (FR-GWL-3·4). grace period 는 없다.
    /// `ep` 가 그 신원의 최신 구독이 아니면 아무 일도 하지 않는다.
    pub fn detach(&self, client_id: &str, ep: u64) {
        if client_id.is_empty() || ep == 0 {
            return;
        }
        let mut g = self.lock();
        if g.live.get(client_id) != Some(&ep) {
            return;
        }
        g.live.remove(client_id);
        let scoped = format!("{client_id}{HOLDER_SCOPE_SEP}");
        for e in g.watch.values_mut() {
            e.holders
                .retain(|k, _| k != client_id && !k.starts_with(&scoped));
        }
    }

    /// 만료된 표명을 걷고, 그래도 상한을 넘으면 가장 오래된 것부터 뺀다 (FR-GPO-11·12).
    pub(super) fn evict_locked(&self, g: &mut State, now: SystemTime) {
        let ttl = self.ttl;
        g.watch.retain(|repo, e| {
            // FR-GWL-2: 임차인이 있으면 유휴로 걷지 않는다.
            if !e.holders.is_empty() || since(now, e.seen_at) <= ttl {
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
            let n = g.watch.get(&oldest).map_or(0, |e| e.holders.len());
            otter_shared_otterlog::infof!(
                None,
                "[gitwatch] 상한 초과로 감시를 퇴출한다 (repo={oldest} cap={} 임차인={n})",
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

    /// 지금 임대를 쥔 신원 수다 (FR-GWL-3).
    pub fn leases(&self) -> usize {
        self.lock().live.len()
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
        .filter(|(_, e)| e.holders.is_empty() != leased)
        .min_by_key(|(_, e)| e.seen_at)
        .map(|(r, _)| r.clone())
}
