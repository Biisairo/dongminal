//! 쓰기의 잡 경로 (Go `gitjob.go` 와 `handlers_git_remote.go` 의 공용 부분).
//!
//! 분 단위가 될 수 있는 쓰기는 응답을 붙잡지 않고 잡으로 띄워 식별자를 곧바로 준다 (FR-GIT-102).

use std::sync::Arc;

use dm_webserver_domain_git_core::{self as core, Ctx, Hint, WriteSpec};
use dm_webserver_domain_git_jobs::{
    self as jobs, Finisher, Job, JobResult, Jobs, JobsOptions, Keys, SLOT_INDEX,
};
use dm_webserver_domain_git_query::Status;
use dm_webserver_domain_git_store::Store;
use http::StatusCode;

use crate::GitServer;
use crate::answers::slots_answer;
use crate::reply::{Bare, Obj, git_error_code, git_json, git_tail, obj};
use crate::write::{GitWrite, git_status_delta};

/// `git_jobs_changed` SSE 본문이다 — 목록을 싣지 않는 "다시 받으라" 신호다 (FR-OPT-4-4).
const JOBS_CHANGED_PAYLOAD: &[u8] = br#"{"action":"git_jobs_changed"}"#;

/// 그 종류의 잡이 index 칸을 쥐는가 — 잡이 끝난 뒤 상태를 다시 찍을지의 근거다.
pub(crate) fn uses_index(kind: &str) -> bool {
    jobs::slots_of(kind).iter().any(|s| s == SLOT_INDEX)
}

/// 잡이 성공으로 끝났는가.
pub(crate) fn job_succeeded(jb: &Job) -> bool {
    jb.err.is_empty() && jb.exit_code == 0
}

impl GitServer {
    /// 원격 작업의 수명을 쥔 허브다. 처음 쓸 때 만든다.
    pub(crate) fn jobs_hub(&self, git: &Arc<Store>) -> Jobs {
        let mut slot = self.jobs.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(j) = &*slot {
            return j.clone();
        }
        let store = Arc::clone(git);
        let commands = self.commands.clone();
        let j = Jobs::new(
            Arc::clone(git.service()),
            JobsOptions {
                on_done: Some(Arc::new(move |jb: &Job| store.invalidate(&jb.repo))),
                on_change: Some(Arc::new(move || {
                    if let Some(c) = &commands {
                        c.broadcast(JOBS_CHANGED_PAYLOAD);
                    }
                })),
                exclusion: Some(self.exclusion()),
                root: Some(git.root().clone()),
                runner: self.job_runner.clone(),
                ..JobsOptions::default()
            },
        );
        *slot = Some(j.clone());
        j
    }

    /// 잡의 칸 키다. git 이 없으면 기본 실행기로 common-dir 을 푼다.
    pub(crate) async fn job_keys(&self, ctx: &Ctx, root: &str) -> Result<Keys, crate::reply::WErr> {
        match &self.git {
            Some(git) => Ok(self.git_keys(git, ctx, root).await?),
            None => Ok(Keys {
                top: core::exclusion_key(root),
                common: core::common_dir_key(None, ctx, root).await?,
            }),
        }
    }

    /// index 를 쓰는 잡이 끝나면 상태를 다시 찍어 결과에 싣는다 (FR-GIT-104). 실패한 잡은
    /// 실행 전과 견줘 부분 적용을 밝힌다.
    pub(crate) fn index_finisher(
        &self,
        git: &Arc<Store>,
        root: &str,
        before: Status,
        extra: Option<Finisher>,
    ) -> Finisher {
        let git = Arc::clone(git);
        let root = root.to_owned();
        Box::new(move |ctx: Ctx, mut jb: Job| {
            Box::pin(async move {
                if ctx.err().is_some() {
                    return jb;
                }
                let mut res = JobResult::default();
                match git.status(&ctx, &root).await.0 {
                    Err(e) => res.status_error = git_tail(&e.to_string()),
                    Ok(obs) => {
                        if !jb.err.is_empty() {
                            let changed = git_status_delta(&before, &obs.status);
                            if !changed.is_empty() {
                                res.partial = true;
                                res.changed = Some(changed);
                            }
                        }
                        res.status = Some(obs.status);
                    }
                }
                jb.result = Some(res);
                match extra {
                    Some(f) => f(ctx, jb).await,
                    None => jb,
                }
            })
        })
    }
}

impl GitWrite<'_> {
    /// 쓰기 명령 하나를 잡으로 띄운다. 끝나면 index 상태를 다시 찍는다.
    pub(crate) async fn start_write_job(
        &mut self,
        spec: WriteSpec,
        before: Status,
        extra: Option<Finisher>,
        hint: Option<Hint>,
    ) {
        if self.stop() || spec.argv.is_empty() {
            return;
        }
        let git = self.git();
        let finish = jobs::on_finish(self.s.index_finisher(&git, &self.root, before, extra));
        let root = self.root.clone();
        let kind = spec.argv[0].clone();
        self.launch_job(
            &kind.clone(),
            move |h, k| {
                let jb = h.start(&root, k, &kind, spec, finish)?;
                if let Some(hint) = hint {
                    git.service().add_hint(hint);
                }
                Ok(jb)
            },
            None,
        )
        .await;
    }

    /// 잡 시작의 공통 절차다: 키 → 요청 생존 → 칸 판정 → 시작 → `{requested, repo, job}`.
    pub(crate) async fn launch_job<F>(&mut self, kind: &str, start: F, extra: Option<&Obj>)
    where
        F: FnOnce(&Jobs, Keys) -> Result<Job, jobs::Error>,
    {
        if self.stop() {
            return;
        }
        let mut keys = self.keys.clone();
        if keys.top.is_empty() {
            match self.s.job_keys(&self.ctx(), &self.root).await {
                Ok(k) => keys = k,
                Err(e) => return self.reject(&*e),
            }
        }
        if self.r.ctx.err().is_some() {
            return self.reject(&Bare(core::Kind::Canceled));
        }
        let a = slots_answer(&self.s.exclusion(), &keys, &jobs::slots_of(kind));
        if !a.ok {
            let applied = self.applied.clone();
            return self.reject_answer(&a, applied.as_ref());
        }
        let git = self.git();
        match start(&self.s.jobs_hub(&git), keys) {
            Err(e) => {
                let (code, name) = git_error_code(&e);
                let msg = git_tail(&e.to_string());
                match self.applied.clone() {
                    Some(applied) => self.reject_body(code, name, &msg, Some(&applied)),
                    None => self.reject_with(code, name, &msg),
                }
            }
            Ok(jb) => {
                let mut body =
                    obj! {"requested" => self.requested, "repo" => self.root, "job" => jb};
                if let Some(extra) = extra {
                    body.extend(extra.clone());
                }
                self.respond(git_json(StatusCode::OK, &body));
            }
        }
    }
}
