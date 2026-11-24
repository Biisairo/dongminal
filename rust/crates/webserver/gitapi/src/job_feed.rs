//! 원격 작업 하나의 출력 흐름 — 채널의 `gitjob:<id>` 토픽이 싣는다 (FR-GIT-103 ·
//! `docs/internal/perf/CHANNEL_PROTOCOL.md` C4). 보존된 줄부터 흘리고 끝 하나로 마친다.

use otter_webserver_domain_git_jobs::{Jobs, Line, Unsubscribe};
use serde_json::{Value, json};
use tokio::sync::mpsc;

use crate::GitServer;

/// 잡 하나의 흐름이다. 버리면 구독을 놓는다.
pub struct JobFeed {
    rx: mpsc::Receiver<Line>,
    hub: Jobs,
    id: String,
    done: bool,
    _unsub: Unsubscribe,
}

impl JobFeed {
    /// 다음 항목: `{"kind":"line","line":…}` 들, 그다음 `{"kind":"done","job":…}` 하나, 그 뒤 `None`.
    pub async fn next(&mut self) -> Option<Value> {
        if self.done {
            return None;
        }
        if let Some(ln) = self.rx.recv().await {
            return Some(json!({"kind":"line","line":ln}));
        }
        self.done = true;
        let job = match self.hub.get(&self.id) {
            Some(jb) => serde_json::to_value(&jb).unwrap_or(Value::Null),
            None => json!({"id": self.id, "done": true}),
        };
        Some(json!({"kind":"done","job":job}))
    }
}

impl GitServer {
    /// 그 잡의 흐름. 잡이 없거나 git 이 없으면 `None`.
    pub fn job_feed(&self, id: &str) -> Option<JobFeed> {
        let hub = self.jobs_hub(self.git.as_ref()?);
        let (rx, unsub) = hub.subscribe(id, 0)?;
        Some(JobFeed {
            rx,
            hub,
            id: id.to_owned(),
            done: false,
            _unsub: unsub,
        })
    }
}
