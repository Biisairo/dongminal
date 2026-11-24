//! 오래 걸리는 쓰기(fetch·push·pull·commit 등)를 잡으로 돌린다 (FR-GIT-104~108, REPO_FIX 01).

use std::collections::{BTreeMap, HashMap};
use std::panic::AssertUnwindSafe;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use otter_gocompat::strconv::quote;
use otter_webserver_domain_git_core::{
    self as core, BoxFut, Ctx, CtxError, Kind, LockInfo, Output, Service, UnguardedSpec, WriteSpec,
};
use otter_webserver_domain_git_write as write;
use serde::Serialize;
use tokio::sync::mpsc;

use crate::error::Error;
use crate::exclusion::{Exclusion, Keys, slots_of};
use crate::exec::{Emit, exec_stream_git};
use crate::kinds::{check_job_shape, check_unguarded_shape, indicator_kind, is_remote_kind};
use crate::result::JobResult;

/// 잡 하나가 들고 있는 줄 수다.
pub const JOB_LINE_CAP: usize = 2000;
/// 끝난 잡을 남겨 두는 시간이다.
pub const JOB_RETENTION: Duration = Duration::from_secs(5 * 60);
/// 줄 하나의 상한(바이트)이다.
pub const JOB_LINE_MAX: usize = 4096;

pub const LINE_STDOUT: &str = "stdout";
pub const LINE_STDERR: &str = "stderr";

pub const FIX_FETCH_REBASE: &str = "fetch_rebase";
pub const FIX_FETCH_MERGE: &str = "fetch_merge";
pub const FIX_FORCE_WITH_LEASE: &str = "force_with_lease";

/// 거부된 push 의 해결책. 순서가 곧 우선순위다 (FR-GIT-105).
pub const REMOTE_REJECT_OPTIONS: [&str; 3] =
    [FIX_FETCH_REBASE, FIX_FETCH_MERGE, FIX_FORCE_WITH_LEASE];

pub const ERROR_SERVER_SHUTDOWN: &str = "server_shutdown";
pub const ERROR_INDEX_LOCKED: &str = "index_locked";
pub const ERROR_TIMEOUT: &str = "git_timeout";

const LINE_TRIM_FACTOR: usize = 2;

const AUTH_PATTERNS: [&str; 6] = [
    "could not read ",
    "authentication failed",
    "permission denied (publickey)",
    "terminal prompts disabled",
    "no such identity",
    "host key verification failed",
];
const REJECT_PATTERNS: [&str; 4] = [
    "non-fast-forward",
    "! [rejected]",
    "fetch first",
    "stale info",
];

/// Options 의 할 일 (K-f). 화면은 이것을 쓴다.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename = "jobs.Fix")]
pub struct Fix {
    pub id: String,
    pub kind: String,
    pub body: BTreeMap<String, String>,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub confirm: String,
}

pub fn remote_reject_fixes() -> Vec<Fix> {
    let fix = |id: &str, kind: &str, key: &str, val: &str, confirm: &str| Fix {
        id: id.to_owned(),
        kind: kind.to_owned(),
        body: BTreeMap::from([(key.to_owned(), val.to_owned())]),
        confirm: confirm.to_owned(),
    };
    vec![
        fix(FIX_FETCH_REBASE, "pull", "mode", write::PULL_REBASE, ""),
        fix(FIX_FETCH_MERGE, "pull", "mode", write::PULL_DEFAULT, ""),
        fix(
            FIX_FORCE_WITH_LEASE,
            "push",
            "force",
            write::PUSH_LEASE,
            core::ACTION_FORCE_PUSH,
        ),
    ]
}

/// 잡의 관측 값이다.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename = "jobs.Job")]
pub struct Job {
    pub id: String,
    pub repo: String,
    pub kind: String,
    pub argv: Vec<String>,
    #[serde(rename = "startedUnixMs")]
    pub started: i64,
    pub done: bool,
    #[serde(rename = "exitCode")]
    pub exit_code: i32,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub err: String,
    pub canceled: bool,
    /// 안내만 한다 — 자격증명을 받지 않는다 (FR-GIT-104).
    #[serde(rename = "authRequired")]
    pub auth_required: bool,
    /// non-fast-forward 거부 (FR-GIT-105).
    pub rejected: bool,
    #[serde(skip_serializing_if = "otter_gocompat::json::is_empty")]
    pub options: Option<Vec<String>>,
    #[serde(skip_serializing_if = "otter_gocompat::json::is_empty")]
    pub fixes: Option<Vec<Fix>>,
    #[serde(rename = "stderrTail", skip_serializing_if = "String::is_empty")]
    pub stderr_tail: String,
    #[serde(skip_serializing_if = "otter_gocompat::json::is_empty")]
    pub slots: Option<Vec<String>>,
    pub indicator: bool,
    /// server_shutdown | index_locked | git_timeout.
    #[serde(rename = "errorCode", skip_serializing_if = "String::is_empty")]
    pub error_code: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lock: Option<LockInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<JobResult>,
}

/// 잡이 낸 줄 하나다.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename = "jobs.Line")]
pub struct Line {
    pub seq: u64,
    pub stream: String,
    pub text: String,
}

/// 완료 처리. 잡을 받아 고친 잡을 돌려준다 (발행 전에 돈다).
pub type Finisher = Box<dyn FnOnce(Ctx, Job) -> BoxFut<Job> + Send>;
pub type OnDone = Arc<dyn Fn(&Job) + Send + Sync>;
pub type OnChange = Arc<dyn Fn() + Send + Sync>;
pub type Clock = Arc<dyn Fn() -> SystemTime + Send + Sync>;
/// 잡의 실행기 (ctx, dir, argv, stdin, emit) → (exit, err).
pub type JobRunner = Arc<
    dyn Fn(Ctx, String, Vec<String>, String, Emit) -> BoxFut<(i32, Option<core::Error>)>
        + Send
        + Sync,
>;

/// [`Jobs::start`] 의 선택.
#[derive(Default)]
pub struct StartOptions {
    pub on_finish: Option<Finisher>,
}

pub fn on_finish(f: Finisher) -> StartOptions {
    StartOptions { on_finish: Some(f) }
}

/// [`Jobs::new`] 의 선택.
#[derive(Default)]
pub struct JobsOptions {
    pub exclusion: Option<Exclusion>,
    pub root: Option<Ctx>,
    pub ceiling: Option<Duration>,
    pub runner: Option<JobRunner>,
    pub on_done: Option<OnDone>,
    pub on_change: Option<OnChange>,
    pub clock: Option<Clock>,
    pub retention: Option<Duration>,
    pub line_cap: Option<usize>,
}

struct JobState {
    job: Job,
    keys: Keys,
    raw: Vec<String>,
    spec: WriteSpec,
    unguarded: String,
    ctx: Ctx,
    finish: Option<Finisher>,
    canceled: bool,
    finishing: bool,
    lines: Vec<Line>,
    stderr: Vec<String>,
    seq: u64,
    subs: HashMap<u64, mpsc::Sender<Line>>,
    done_at: SystemTime,
}

struct Inner {
    svc: Arc<Service>,
    run: JobRunner,
    ceiling: Duration,
    retention: Duration,
    line_cap: usize,
    now: Clock,
    on_done: Option<OnDone>,
    on_change: Option<OnChange>,
    root: Ctx,
    excl: Exclusion,
    st: Mutex<Table>,
}

#[derive(Default)]
struct Table {
    by_id: HashMap<String, JobState>,
    next_sub: u64,
}

/// 잡의 목록이다. 복제는 같은 목록을 가리킨다.
#[derive(Clone)]
pub struct Jobs {
    inner: Arc<Inner>,
}

/// 구독을 푼다. drop 해도 풀린다.
pub struct Unsubscribe {
    jobs: Jobs,
    id: String,
    sub: Option<u64>,
}

impl Unsubscribe {
    pub fn cancel(mut self) {
        self.free();
    }

    fn free(&mut self) {
        if let Some(sub) = self.sub.take() {
            let mut t = self.jobs.inner.lock();
            if let Some(st) = t.by_id.get_mut(&self.id) {
                st.subs.remove(&sub);
            }
        }
    }
}

impl Drop for Unsubscribe {
    fn drop(&mut self) {
        self.free();
    }
}

fn unix_ms(t: SystemTime) -> i64 {
    match t.duration_since(UNIX_EPOCH) {
        Ok(d) => i64::try_from(d.as_millis()).unwrap_or(i64::MAX),
        Err(e) => -i64::try_from(e.duration().as_millis()).unwrap_or(i64::MAX),
    }
}

fn default_runner() -> JobRunner {
    Arc::new(|ctx, dir, args, stdin, emit| Box::pin(exec_stream_git(ctx, dir, args, stdin, emit)))
}

impl Inner {
    fn lock(&self) -> MutexGuard<'_, Table> {
        self.st.lock().unwrap_or_else(|e| e.into_inner())
    }
}

impl Jobs {
    pub fn new(svc: Arc<Service>, o: JobsOptions) -> Self {
        let pos = |d: Option<Duration>, def: Duration| d.filter(|d| !d.is_zero()).unwrap_or(def);
        Jobs {
            inner: Arc::new(Inner {
                svc,
                run: o.runner.unwrap_or_else(default_runner),
                ceiling: pos(o.ceiling, core::JOB_CEILING),
                retention: pos(o.retention, JOB_RETENTION),
                line_cap: o.line_cap.filter(|n| *n > 0).unwrap_or(JOB_LINE_CAP),
                now: o.clock.unwrap_or_else(|| Arc::new(SystemTime::now)),
                on_done: o.on_done,
                on_change: o.on_change,
                root: o.root.unwrap_or_else(Ctx::background),
                excl: o.exclusion.unwrap_or_default(),
                st: Mutex::new(Table::default()),
            }),
        }
    }

    pub fn exclusion(&self) -> &Exclusion {
        &self.inner.excl
    }

    fn changed(&self) {
        if let Some(f) = &self.inner.on_change {
            f();
        }
    }

    /// 인가를 지난 잡을 띄운다. 종류와 argv 모양이 표에 맞아야 한다 (§6.1).
    pub fn start(
        &self,
        repo: &str,
        keys: Keys,
        kind: &str,
        spec: WriteSpec,
        opts: StartOptions,
    ) -> Result<Job, Error> {
        check_abs_repo(repo)?;
        core::guard_write_args(&spec.argv)?;
        check_job_shape(kind, &spec.argv, &spec.stdin)?;
        self.launch(repo, keys, kind, spec, String::new(), opts)
    }

    /// 인가를 건너뛰는 잡(submodule·worktree add). 사유를 반드시 받는다.
    pub fn start_unguarded(
        &self,
        repo: &str,
        keys: Keys,
        kind: &str,
        argv: Vec<String>,
        reason: &str,
        opts: StartOptions,
    ) -> Result<Job, Error> {
        check_abs_repo(repo)?;
        if reason.trim().is_empty() {
            return Err(core::Error::new(
                Kind::UnsafeArgument,
                "Reason 이 비었다 — 인가를 건너뛰는 사유를 적어야 한다",
            )
            .into());
        }
        if argv.is_empty() || kind.trim().is_empty() {
            return Err(core::Error::new(Kind::UnsafeArgument, "인자가 없다").into());
        }
        check_unguarded_shape(kind, &argv)?;
        let spec = WriteSpec {
            argv,
            destructive: true,
            stdin: String::new(),
        };
        self.launch(repo, keys, kind, spec, reason.to_owned(), opts)
    }

    fn launch(
        &self,
        repo: &str,
        keys: Keys,
        kind: &str,
        spec: WriteSpec,
        unguarded: String,
        opts: StartOptions,
    ) -> Result<Job, Error> {
        let id = otter_shared_uuid::new_string();
        let snapshot = {
            let mut t = self.inner.lock();
            self.sweep_locked(&mut t);
            self.inner.excl.claim(&keys, &slots_of(kind), &id)?;
            let ctx = self.inner.root.with_timeout(self.inner.ceiling);
            let st = JobState {
                job: Job {
                    id: id.clone(),
                    repo: repo.to_owned(),
                    kind: kind.to_owned(),
                    argv: core::sanitize_argv(&spec.argv),
                    started: unix_ms((self.inner.now)()),
                    exit_code: -1,
                    slots: Some(slots_of(kind)),
                    indicator: indicator_kind(kind),
                    ..Job::default()
                },
                keys,
                raw: spec.argv.clone(),
                spec,
                unguarded,
                ctx: ctx.clone(),
                finish: opts.on_finish,
                canceled: false,
                finishing: false,
                lines: Vec::new(),
                stderr: Vec::new(),
                seq: 0,
                subs: HashMap::new(),
                done_at: UNIX_EPOCH,
            };
            let snapshot = st.job.clone();
            t.by_id.insert(id.clone(), st);
            snapshot
        };
        self.changed();
        let me = self.clone();
        tokio::spawn(async move { me.run1(id).await });
        Ok(snapshot)
    }

    /// 진행 중인 잡을 취소한다. 끝났거나 완료 처리 중이면 false 다.
    pub fn cancel(&self, id: &str) -> bool {
        let ctx = {
            let mut t = self.inner.lock();
            let Some(st) = t.by_id.get_mut(id) else {
                return false;
            };
            if st.job.done || st.finishing {
                return false;
            }
            st.canceled = true;
            st.ctx.clone()
        };
        ctx.cancel();
        true
    }

    pub fn get(&self, id: &str) -> Option<Job> {
        let mut t = self.inner.lock();
        self.sweep_locked(&mut t);
        t.by_id.get(id).map(|st| st.job.clone())
    }

    /// 끝나지 않은 잡. 시작 시각, 같으면 id 순이다.
    pub fn active(&self) -> Vec<Job> {
        let mut t = self.inner.lock();
        self.sweep_locked(&mut t);
        let mut out: Vec<Job> = t
            .by_id
            .values()
            .filter(|st| !st.job.done)
            .map(|st| st.job.clone())
            .collect();
        out.sort_by(|a, b| a.started.cmp(&b.started).then_with(|| a.id.cmp(&b.id)));
        out
    }

    /// after_seq 뒤의 줄을 받는다. 끝난 잡이면 남은 줄을 주고 바로 닫힌다. 모르는 id 면 None.
    pub fn subscribe(
        &self,
        id: &str,
        after_seq: u64,
    ) -> Option<(mpsc::Receiver<Line>, Unsubscribe)> {
        let mut t = self.inner.lock();
        let cap = self.inner.line_cap;
        let sub_id = t.next_sub;
        t.next_sub += 1;
        let st = t.by_id.get_mut(id)?;
        let (tx, rx) = mpsc::channel(cap);
        for ln in visible_lines(&st.lines, cap) {
            if ln.seq > after_seq {
                let _ = tx.try_send(ln.clone());
            }
        }
        let sub = if st.job.done {
            None
        } else {
            st.subs.insert(sub_id, tx);
            Some(sub_id)
        };
        let unsub = Unsubscribe {
            jobs: self.clone(),
            id: id.to_owned(),
            sub,
        };
        Some((rx, unsub))
    }

    async fn run1(&self, id: String) {
        let Some((ctx, raw, stdin, repo)) = ({
            let t = self.inner.lock();
            t.by_id.get(&id).map(|st| {
                (
                    st.ctx.clone(),
                    st.raw.clone(),
                    st.spec.stdin.clone(),
                    st.job.repo.clone(),
                )
            })
        }) else {
            return;
        };
        let started = (self.inner.now)();
        let (exit, mut err) = self.run_guarded(&id, &ctx, repo, raw, stdin).await;
        if ctx.err() == Some(CtxError::DeadlineExceeded) {
            err = Some(core::Error::new(
                Kind::Timeout,
                format!(
                    "상한 {} 를 넘겨 종료했다",
                    otter_gocompat::time::format_std_duration(self.inner.ceiling)
                ),
            ));
        }
        let dur = (self.inner.now)()
            .duration_since(started)
            .unwrap_or_default();
        self.finish(&id, exit, err, dur).await;
        ctx.cancel();
    }

    async fn run_guarded(
        &self,
        id: &str,
        ctx: &Ctx,
        repo: String,
        raw: Vec<String>,
        stdin: String,
    ) -> (i32, Option<core::Error>) {
        let me = self.clone();
        let jid = id.to_owned();
        let emit: Emit = Arc::new(move |stream, text| me.append_line(&jid, stream, text));
        let run = Arc::clone(&self.inner.run);
        let c = ctx.clone();
        // 실행기 호출까지 띄운 작업 안에서 한다 — 동기 부분의 panic 도 이 잡의 실패다.
        match tokio::spawn(async move { run(c, repo, raw, stdin, emit).await }).await {
            Ok(r) => r,
            Err(e) => (
                -1,
                Some(core::Error::other(self.panic_err(id, "실행기", e))),
            ),
        }
    }

    fn panic_err(&self, id: &str, where_: &str, e: tokio::task::JoinError) -> String {
        let v = match e.try_into_panic() {
            Ok(p) => panic_text(p.as_ref()),
            Err(e) => e.to_string(),
        };
        let kind = self
            .inner
            .lock()
            .by_id
            .get(id)
            .map(|st| st.job.kind.clone())
            .unwrap_or_default();
        otter_shared_otterlog::errorf!(
            None,
            "git job panic id={id} kind={kind} where={where_}: {v}"
        );
        format!("{where_} panic: {v}")
    }

    fn append_line(&self, id: &str, stream: &str, text: &str) {
        let text = core::sanitize_remote(text);
        if text.is_empty() {
            return;
        }
        let stream = if stream == LINE_STDOUT {
            LINE_STDOUT
        } else {
            LINE_STDERR
        };
        let cap = self.inner.line_cap;
        let mut t = self.inner.lock();
        let Some(st) = t.by_id.get_mut(id) else {
            return;
        };
        if st.job.done {
            return;
        }
        st.seq += 1;
        let ln = Line {
            seq: st.seq,
            stream: stream.to_owned(),
            text: text.clone(),
        };
        st.lines.push(ln.clone());
        if st.lines.len() >= LINE_TRIM_FACTOR * cap {
            let drop = st.lines.len() - cap;
            st.lines.drain(..drop);
        }
        if stream == LINE_STDERR {
            st.stderr.push(text);
            if st.stderr.len() > core::DEFAULT_STDERR_TAIL_LINES {
                let drop = st.stderr.len() - core::DEFAULT_STDERR_TAIL_LINES;
                st.stderr.drain(..drop);
            }
        }
        for tx in st.subs.values() {
            let _ = tx.try_send(ln.clone());
        }
    }

    async fn finish(&self, id: &str, exit: i32, run_err: Option<core::Error>, dur: Duration) {
        let Some((mut final_, canceled, tail, finisher, unguarded, spec)) = ({
            let mut t = self.inner.lock();
            t.by_id.get_mut(id).map(|st| {
                st.finishing = true;
                (
                    st.job.clone(),
                    st.canceled,
                    st.stderr.join("\n"),
                    st.finish.take(),
                    st.unguarded.clone(),
                    st.spec.clone(),
                )
            })
        }) else {
            return;
        };
        let shutdown = self.inner.root.err().is_some();
        final_ = classify_outcome(final_, canceled, shutdown, run_err.as_ref(), exit, &tail);
        self.record_final(&final_, &tail, exit, dur, &unguarded, &spec);

        let fctx = self.inner.root.with_timeout(core::POST_PHASE_TIMEOUT);
        if final_.error_code.is_empty()
            && !final_.err.is_empty()
            && core::index_locked_stderr(&tail)
        {
            final_.error_code = ERROR_INDEX_LOCKED.to_owned();
            if !shutdown {
                final_.lock = self.inner.svc.index_lock_info(&fctx, &final_.repo).await;
            }
        }
        if let Some(on_done) = &self.inner.on_done {
            let snapshot = final_.clone();
            let r = std::panic::catch_unwind(AssertUnwindSafe(|| on_done(&snapshot)));
            if let Err(p) = r {
                let msg = self.panic_text_logged(id, "완료 훅(onDone)", p.as_ref());
                if final_.err.is_empty() {
                    final_.err = msg;
                }
            }
        }
        if let Some(f) = finisher {
            let before = final_.clone();
            let (c, j) = (fctx.clone(), final_.clone());
            match tokio::spawn(async move { f(c, j).await }).await {
                Ok(j) => final_ = j,
                Err(e) => {
                    let msg = self.panic_err(id, "완료 처리(finish)", e);
                    final_ = before;
                    if final_.err.is_empty() {
                        final_.err = msg;
                    }
                }
            }
        }
        fctx.cancel();
        {
            let mut t = self.inner.lock();
            let now = (self.inner.now)();
            if let Some(st) = t.by_id.get_mut(id) {
                st.job = final_.clone();
                st.done_at = now;
                self.inner
                    .excl
                    .free(&st.keys, &slots_of(&final_.kind), &final_.id);
                st.subs.clear();
            }
        }
        self.changed();
    }

    fn panic_text_logged(&self, id: &str, where_: &str, p: &(dyn std::any::Any + Send)) -> String {
        let v = panic_text(p);
        let kind = self
            .inner
            .lock()
            .by_id
            .get(id)
            .map(|st| st.job.kind.clone())
            .unwrap_or_default();
        otter_shared_otterlog::errorf!(
            None,
            "git job panic id={id} kind={kind} where={where_}: {v}"
        );
        format!("{where_} panic: {v}")
    }

    fn record_final(
        &self,
        final_: &Job,
        tail: &str,
        exit: i32,
        dur: Duration,
        unguarded: &str,
        spec: &WriteSpec,
    ) {
        let rec_err = (!final_.err.is_empty()).then(|| core::Error::other(final_.err.clone()));
        let out = Output {
            stderr: tail.to_owned(),
            exit_code: exit,
            duration_ms: i64::try_from(dur.as_millis()).unwrap_or(i64::MAX),
            ..Output::default()
        };
        if !unguarded.is_empty() {
            let us = UnguardedSpec {
                argv: final_.argv.clone(),
                reason: unguarded.to_owned(),
                ..UnguardedSpec::default()
            };
            self.inner
                .svc
                .record_unguarded(&final_.repo, &us, &out, rec_err.as_ref());
        } else {
            let ws = WriteSpec {
                argv: final_.argv.clone(),
                destructive: spec.destructive,
                stdin: spec.stdin.clone(),
            };
            self.inner
                .svc
                .record_write(&final_.repo, &ws, &out, rec_err.as_ref());
        }
    }

    /// 보존 중인 줄 수 (시험용).
    #[cfg(test)]
    pub(crate) fn stored_lines(&self, id: &str) -> usize {
        self.inner
            .lock()
            .by_id
            .get(id)
            .map_or(0, |st| st.lines.len())
    }

    fn sweep_locked(&self, t: &mut Table) {
        let now = (self.inner.now)();
        let retention = self.inner.retention;
        t.by_id
            .retain(|_, st| !(st.job.done && now >= st.done_at + retention));
    }
}

fn check_abs_repo(repo: &str) -> Result<(), Error> {
    if repo.trim().is_empty() || !otter_gocompat::filepath::is_abs(repo) {
        return Err(core::Error::new(
            Kind::UnsafeArgument,
            format!("cwd 는 절대 경로여야 한다: {}", quote(repo)),
        )
        .into());
    }
    Ok(())
}

fn panic_text(p: &(dyn std::any::Any + Send)) -> String {
    if let Some(s) = p.downcast_ref::<&str>() {
        return (*s).to_owned();
    }
    if let Some(s) = p.downcast_ref::<String>() {
        return s.clone();
    }
    "panic".to_owned()
}

fn visible_lines(lines: &[Line], cap: usize) -> &[Line] {
    if lines.len() > cap {
        &lines[lines.len() - cap..]
    } else {
        lines
    }
}

/// 실행 결과를 잡의 최종 상태로 옮긴다.
pub fn classify_outcome(
    mut f: Job,
    canceled: bool,
    shutdown: bool,
    run_err: Option<&core::Error>,
    exit: i32,
    tail: &str,
) -> Job {
    f.done = true;
    f.exit_code = exit;
    f.canceled = canceled;
    f.stderr_tail = tail.to_owned();
    let remote = is_remote_kind(&f.kind);
    if shutdown {
        f.canceled = false;
        f.error_code = ERROR_SERVER_SHUTDOWN.to_owned();
        f.err = "서버 종료로 중단했다 — 일부가 적용됐을 수 있다".to_owned();
    } else if canceled && remote {
        f.err = "취소했다. 원격에 일부가 적용됐을 수 있다".to_owned();
    } else if canceled {
        f.err = "취소했다. 일부가 적용됐을 수 있다 — 상태를 확인하라".to_owned();
    } else if let Some(e) = run_err.filter(|e| e.is(Kind::Timeout)) {
        f.error_code = ERROR_TIMEOUT.to_owned();
        f.err = core::sanitize_remote(&e.to_string());
    } else if let Some(e) = run_err {
        f.err = core::sanitize_remote(&e.to_string());
    } else if exit != 0 {
        f.err = format!("git {} 가 exit {exit} 로 끝났다", f.kind);
    }
    if !canceled && !shutdown && remote {
        f.auth_required = matches_any(tail, &AUTH_PATTERNS);
        f.rejected = matches_any(tail, &REJECT_PATTERNS);
        if f.rejected {
            f.options = Some(
                REMOTE_REJECT_OPTIONS
                    .iter()
                    .map(|s| (*s).to_owned())
                    .collect(),
            );
            f.fixes = Some(remote_reject_fixes());
        }
    }
    f
}

fn matches_any(s: &str, pats: &[&str]) -> bool {
    let low = s.to_lowercase();
    pats.iter().any(|p| low.contains(p))
}
