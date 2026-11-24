//! git 토픽 — `git:<repo>` · `git.jobs` · `gitjob:<id>` (`docs/internal/perf/CHANNEL_PROTOCOL.md`
//! §5.2 C4). 브라우저의 git 폴링과 git job SSE 를 대신한다.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use otter_webserver_domain_git_core::Ctx;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::Server;
use crate::channel::Seed;

const GIT_PREFIX: &str = "git:";
const GIT_JOBS: &str = "git.jobs";
const GITJOB_PREFIX: &str = "gitjob:";

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn mark_value(repo: &str, mark: &str) -> Value {
    json!({"repo": repo, "mark": mark})
}

impl Server {
    /// git 토픽의 seed·수요·발행 훅을 건다. `new` 가 한 번 부른다.
    pub(crate) fn wire_git_topics(&self) {
        let me = self.me.clone();
        self.topics.register_seed(GIT_PREFIX, move |topic| {
            let me = me.clone();
            Box::pin(async move {
                let s = me.upgrade()?;
                let repo = topic.strip_prefix(GIT_PREFIX)?.to_owned();
                let mark = s.git_mark(&repo).await.0;
                Some(Seed::Full(mark_value(&repo, &mark)))
            })
        });

        // 구독자가 있는 동안 감시를 쥔다. 늦게 끝난 관측이 이미 놓은 임대를 다시 쥐지 않게
        // 저장소마다 세대를 센다.
        let gens: Arc<Mutex<HashMap<String, u64>>> = Arc::default();
        let me = self.me.clone();
        self.topics.on_demand(GIT_PREFIX, move |topic, active| {
            let (Some(s), Some(repo)) = (me.upgrade(), topic.strip_prefix(GIT_PREFIX)) else {
                return;
            };
            let Some(w) = s.git_watch.clone() else {
                return;
            };
            let round = {
                let mut g = lock(&gens);
                let n = g.entry(repo.to_owned()).or_default();
                *n += 1;
                *n
            };
            if !active {
                w.release_topic(repo);
                return;
            }
            let (repo, gens) = (repo.to_owned(), gens.clone());
            tokio::spawn(async move {
                if let (_, Some(obs)) = s.git_mark(&repo).await
                    && lock(&gens).get(&repo) == Some(&round)
                {
                    w.hold_topic(&repo, &obs);
                }
            });
        });

        if let Some(w) = &self.git_watch {
            let me = self.me.clone();
            w.set_on_mark(Some(Arc::new(move |repo: &str, mark: &str| {
                if let Some(s) = me.upgrade() {
                    s.topics
                        .publish_full(&format!("{GIT_PREFIX}{repo}"), mark_value(repo, mark));
                }
            })));
        }

        let me = self.me.clone();
        self.topics.register_seed(GIT_JOBS, move |_| {
            let me = me.clone();
            Box::pin(async move { Some(Seed::Full(me.upgrade()?.git_jobs_value())) })
        });

        let me = self.me.clone();
        self.topics.register_seed(GITJOB_PREFIX, move |topic| {
            let me = me.clone();
            Box::pin(async move {
                let s = me.upgrade()?;
                let id = topic.strip_prefix(GITJOB_PREFIX)?;
                s.deps.git.as_ref()?.job_feed(id).map(|_| Seed::Event)
            })
        });

        let relays: Arc<Mutex<HashMap<String, CancellationToken>>> = Arc::default();
        let me = self.me.clone();
        self.topics.on_demand(GITJOB_PREFIX, move |topic, active| {
            let Some(s) = me.upgrade() else {
                return;
            };
            if let Some(t) = lock(&relays).remove(topic) {
                t.cancel();
            }
            if !active {
                s.topics.forget_idle(topic);
                return;
            }
            let id = topic.strip_prefix(GITJOB_PREFIX).unwrap_or_default();
            let Some(mut feed) = s.deps.git.as_ref().and_then(|g| g.job_feed(id)) else {
                return;
            };
            let stop = CancellationToken::new();
            lock(&relays).insert(topic.to_owned(), stop.clone());
            let topic = topic.to_owned();
            tokio::spawn(async move {
                loop {
                    let v = tokio::select! {
                        () = stop.cancelled() => return,
                        v = feed.next() => v,
                    };
                    let Some(v) = v else {
                        return;
                    };
                    s.topics.publish_event(&topic, v);
                }
            });
        });
    }

    /// `git.jobs` 의 값이다. git 이 없으면 빈 목록이다.
    pub(crate) fn git_jobs_value(&self) -> Value {
        let jobs = self
            .deps
            .git
            .as_ref()
            .and_then(|g| g.active_jobs())
            .unwrap_or_default();
        json!({"jobs": jobs})
    }

    /// 그 저장소의 지금 mark 와 관측. 관측하지 못하면 빈 mark 다(감시의 결정적 오류와 같은 값).
    async fn git_mark(
        &self,
        repo: &str,
    ) -> (
        String,
        Option<otter_webserver_domain_git_store::Observation>,
    ) {
        let Some(store) = self.deps.git_store.clone() else {
            return (String::new(), None);
        };
        match store.status(&Ctx::background(), repo).await.0 {
            Ok(obs) => (otter_webserver_domain_git_store::mark(&obs), Some(obs)),
            Err(_) => (String::new(), None),
        }
    }
}
