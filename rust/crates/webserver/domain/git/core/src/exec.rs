//! git 실행 단일 지점 (FR-GIT-1~8).

use std::borrow::Cow;
use std::future::Future;
use std::io::Read;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use otter_gocompat::{filepath, strconv::quote};

use crate::ctx::{Ctx, CtxError};
use crate::error::{Error, ExecError, Kind, classify};
use crate::guard::guard_args;
use crate::record::{Record, RecordSpan, Recorder, new_record};
use crate::recovery::HintLog;
use crate::spawn::{SpawnError, exit_status_string, spawn};

/// FR-GIT-3.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);
/// 1MiB, FR-GIT-6.
pub const DEFAULT_MAX_OUTPUT: usize = 1 << 20;
/// FR-GIT-5 링 버퍼 길이.
pub const DEFAULT_RECORD_CAP: usize = 500;

pub type BoxFut<T> = Pin<Box<dyn Future<Output = T> + Send>>;

/// git 한 번이다. 테스트가 결정론적이려면 주입 가능해야 한다 (FR-GIT-4).
pub type Runner =
    Arc<dyn Fn(Ctx, String, Vec<String>) -> BoxFut<Result<Output, Error>> + Send + Sync>;

/// stdin 을 받는 실행 한 번이다.
pub type WriteRunner =
    Arc<dyn Fn(Ctx, String, Vec<String>, String) -> BoxFut<Result<Output, Error>> + Send + Sync>;

/// 실행 한 번의 결과다. stdout 은 바이트 그대로다 (Go string 은 바이트열이다).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Output {
    pub stdout: Vec<u8>,
    pub stderr: String,
    pub exit_code: i32,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
    pub duration_ms: i64,
}

impl Output {
    /// stdout 을 문자열로 본다. 잘못된 UTF-8 은 U+FFFD 로 바뀐다.
    pub fn stdout_str(&self) -> Cow<'_, str> {
        String::from_utf8_lossy(&self.stdout)
    }
}

pub struct Service {
    run: Runner,
    write_run: Option<WriteRunner>,
    pub(crate) timeout: Duration,
    pub(crate) max_output: usize,
    pub(crate) rec: Arc<Recorder>,
    pub(crate) hints: HintLog,
    own_run: bool,
    path_env: Option<String>,
}

/// Service 의 선택 사항 (Go `Option`).
#[derive(Default)]
pub struct Builder {
    run: Option<Runner>,
    write_run: Option<WriteRunner>,
    timeout: Duration,
    max_output: usize,
    rec: Option<Arc<Recorder>>,
    path_env: Option<String>,
}

impl Builder {
    pub fn runner(mut self, r: Runner) -> Self {
        self.run = Some(r);
        self
    }

    /// 쓰기 실행기를 주입한다. runner 는 쓰기를 대신 막아 주지 않는다.
    pub fn write_runner(mut self, r: WriteRunner) -> Self {
        self.write_run = Some(r);
        self
    }

    /// 0 이면 DEFAULT_TIMEOUT 이다.
    pub fn timeout(mut self, d: Duration) -> Self {
        self.timeout = d;
        self
    }

    /// 0 이면 DEFAULT_MAX_OUTPUT 이다.
    pub fn max_output(mut self, n: usize) -> Self {
        self.max_output = n;
        self
    }

    pub fn recorder(mut self, rec: Arc<Recorder>) -> Self {
        self.rec = Some(rec);
        self
    }

    /// git 을 찾을 검색 경로. 시험이 프로세스 환경을 바꾸지 않고 PATH 를 바꿔 본다.
    #[cfg(test)]
    pub(crate) fn path_env(mut self, p: &str) -> Self {
        self.path_env = Some(p.to_owned());
        self
    }

    pub fn build(self) -> Service {
        let timeout = if self.timeout.is_zero() {
            DEFAULT_TIMEOUT
        } else {
            self.timeout
        };
        let max_output = if self.max_output == 0 {
            DEFAULT_MAX_OUTPUT
        } else {
            self.max_output
        };
        // Service 는 항상 기록을 갖는다 (FR-GIT-5).
        let rec = self
            .rec
            .unwrap_or_else(|| Arc::new(Recorder::new(DEFAULT_RECORD_CAP)));
        let (run, own_run) = match self.run {
            Some(r) => (r, false),
            None => (capped_runner(max_output, self.path_env.clone()), true),
        };
        Service {
            run,
            write_run: self.write_run,
            timeout,
            max_output,
            rec,
            hints: HintLog::default(),
            own_run,
            path_env: self.path_env,
        }
    }
}

fn capped_runner(limit: usize, path_env: Option<String>) -> Runner {
    Arc::new(move |ctx, dir, args| {
        let path_env = path_env.clone();
        Box::pin(async move { exec_git(&ctx, &dir, &args, limit, "", path_env.as_deref()).await })
    })
}

pub(crate) fn default_write_runner(limit: usize, path_env: Option<String>) -> WriteRunner {
    Arc::new(move |ctx, dir, args, stdin| {
        let path_env = path_env.clone();
        Box::pin(
            async move { exec_git(&ctx, &dir, &args, limit, &stdin, path_env.as_deref()).await },
        )
    })
}

impl Default for Service {
    fn default() -> Self {
        Self::new()
    }
}

impl Service {
    pub fn new() -> Self {
        Builder::default().build()
    }

    pub fn builder() -> Builder {
        Builder::default()
    }

    /// 출력 상한만 n 인 Service (FR-OPT-15-1). 실행기·시한·실행 기록은 원본과 나누고, 복구
    /// 기록은 나누지 않는다 — 조회 전용이다.
    pub fn sized(&self, n: usize) -> Service {
        let run = if self.own_run {
            capped_runner(n, self.path_env.clone())
        } else {
            self.run.clone()
        };
        Service {
            run,
            write_run: self.write_run.clone(),
            timeout: self.timeout,
            max_output: n,
            rec: self.rec.clone(),
            hints: HintLog::default(),
            own_run: self.own_run,
            path_env: self.path_env.clone(),
        }
    }

    /// 최근 기록이다 (최신이 마지막). n 이 0 이면 보유분 전부다.
    pub fn records(&self, n: usize) -> Vec<Record> {
        self.rec.recent(n)
    }

    /// Seq 가 after 보다 큰 기록과 링의 범위다 (FR-OPT-4-8).
    pub fn records_since(&self, after: u64, epoch: &str) -> (Vec<Record>, RecordSpan) {
        self.rec.since(after, epoch)
    }

    pub fn recorder(&self) -> &Arc<Recorder> {
        &self.rec
    }

    /// 출력 상한이다 (FR-GIT-6).
    pub fn max_output(&self) -> usize {
        self.max_output
    }

    pub(crate) fn path_env(&self) -> Option<String> {
        self.path_env.clone()
    }

    /// 읽기의 단일 진입점이다 (FR-GIT-1). 거부된 호출도 기록에 남는다 (FR-GIT-5).
    pub async fn exec<S: AsRef<str>>(
        &self,
        ctx: &Ctx,
        dir: &str,
        args: &[S],
    ) -> Result<Output, Error> {
        let args: Vec<String> = args.iter().map(|a| a.as_ref().to_owned()).collect();
        let rec =
            |out: &Output, err: Option<&Error>| self.rec.add(new_record(dir, &args, out, err));
        if let Err(e) = check_cwd(dir).and_then(|_| guard_args(&args)) {
            return reject(e, rec);
        }
        // 호출자가 더 짧은 마감을 주면 그것이 이긴다 (FR-GIT-3).
        let ctx2 = ctx.with_timeout(self.timeout);
        let res = (self.run)(ctx2.clone(), dir.to_owned(), args.clone()).await;
        let res = finish_exec(&ctx2, dir, &args, res);
        match &res {
            Ok(out) => rec(out, None),
            Err(e) => rec(e.output().unwrap_or(&Output::default()), Some(e)),
        }
        res
    }

    pub(crate) fn write_runner(&self) -> WriteRunner {
        match &self.write_run {
            Some(r) => r.clone(),
            None => default_write_runner(self.max_output, self.path_env.clone()),
        }
    }

    pub(crate) fn injected_write_runner(&self) -> Option<WriteRunner> {
        self.write_run.clone()
    }
}

/// 세 진입점의 공통 전제다. 상대 경로는 해석 기준이 없다.
pub(crate) fn check_cwd(dir: &str) -> Result<(), Error> {
    if dir.trim().is_empty() || !filepath::is_abs(dir) {
        return Err(Error::new(
            Kind::UnsafeArgument,
            format!("cwd 는 절대 경로여야 한다: {}", quote(dir)),
        ));
    }
    Ok(())
}

/// 세 진입점의 오류 분류다 (FR-OPT-7-1). 실패해도 출력을 오류에 싣는다.
pub(crate) fn finish_exec(
    ctx: &Ctx,
    dir: &str,
    argv: &[String],
    res: Result<Output, Error>,
) -> Result<Output, Error> {
    match res {
        Ok(out) if out.exit_code != 0 => {
            let kind = classify(ctx, &out.stderr);
            let xe = ExecError::new(
                argv.to_vec(),
                dir.to_owned(),
                out.exit_code,
                out.stderr.clone(),
                kind,
            );
            Err(Error::from_exec(xe).with_output(out))
        }
        Ok(out) => Ok(out),
        Err(e) => {
            let out = e.output().cloned().unwrap_or_default();
            let e = match (e.kind(), classify(ctx, &out.stderr)) {
                // 분류되지 않은 runner 오류에도 종류를 붙인다 (FR-GIT-8). Go `%v` 라 사슬은 끊긴다.
                (None, Some(k)) => Error::new(k, e.message()),
                _ => e,
            };
            Err(e.with_output(out))
        }
    }
}

/// 실행 없이 거부한다. exit -1 은 "프로세스가 뜨지도 않았다" 는 표시다.
pub(crate) fn reject(
    err: Error,
    rec: impl FnOnce(&Output, Option<&Error>),
) -> Result<Output, Error> {
    let out = Output {
        exit_code: -1,
        ..Output::default()
    };
    rec(&out, Some(&err));
    Err(err.with_output(out))
}

fn elapsed_ms(started: Instant) -> i64 {
    started.elapsed().as_millis() as i64
}

/// 기본 실행이다. 셸을 경유하지 않는다 (FR-GIT-2).
pub(crate) async fn exec_git(
    ctx: &Ctx,
    dir: &str,
    args: &[String],
    limit: usize,
    stdin: &str,
    path_env: Option<&str>,
) -> Result<Output, Error> {
    let started = Instant::now();
    let gc = match command_in(dir, args, stdin, path_env) {
        Ok(c) => c,
        Err(e) => {
            return Err(e.with_output(Output {
                exit_code: -1,
                duration_ms: elapsed_ms(started),
                ..Output::default()
            }));
        }
    };
    let stdout = Arc::new(CappedBuffer::new(limit));
    let stderr = Arc::new(CappedBuffer::new(limit));
    let res = spawn(ctx, gc.cmd, gc.stdin, stdout.consumer(), stderr.consumer()).await;

    let mut out = Output {
        stdout: stdout.bytes(),
        stderr: String::from_utf8_lossy(&stderr.bytes()).into_owned(),
        exit_code: -1,
        stdout_truncated: stdout.is_truncated(),
        stderr_truncated: stderr.is_truncated(),
        duration_ms: elapsed_ms(started),
    };
    let joined = args.join(" ");
    match ctx.err() {
        Some(CtxError::DeadlineExceeded) => {
            let msg = format!("git {joined} 가 {}ms 에서 마감을 넘겼다", out.duration_ms);
            return Err(Error::new(Kind::Timeout, msg).with_output(out));
        }
        // stderr 의 `signal: killed` 로 판정하지 않는다 (FR-GIT-217).
        Some(CtxError::Canceled) => {
            let msg = format!("git {joined} 를 호출자가 취소했다");
            return Err(Error::new(Kind::Canceled, msg).with_output(out));
        }
        None => {}
    }
    let run_err = match res {
        Ok(st) => {
            out.exit_code = st.code().unwrap_or(-1);
            if st.success() || out.exit_code > 0 {
                return Ok(out);
            }
            exit_status_string(&st)
        }
        Err(SpawnError::Bind { err, status }) => {
            out.exit_code = status.and_then(|s| s.code()).unwrap_or(-1);
            if out.exit_code > 0 {
                return Ok(out);
            }
            otter_gocompat::oserr::go_error_string(&err)
        }
        Err(e @ SpawnError::Start { .. }) => {
            // 캐시된 bin 이 사라졌으면 캐시를 버리고 부재로 답한다 (FR-OPT-7-1).
            if vanished_bin(&gc.bin, &e) {
                return Err(Error::new(Kind::GitMissing, &e).with_output(out));
            }
            // FR-RMS-2: 작업 디렉터리가 실제로 없을 때만 소실이다.
            if not_exist(dir) {
                return Err(
                    Error::new(Kind::RepoMissing, format!("chdir {dir}: {e}")).with_output(out)
                );
            }
            e.to_string()
        }
    };
    Err(Error::other(format!("git {joined}: {run_err}")).with_output(out))
}

fn not_exist(p: &str) -> bool {
    matches!(std::fs::metadata(p), Err(e) if e.kind() == std::io::ErrorKind::NotFound)
}

/// 띄울 준비가 된 git 프로세스. 띄우는 것은 호출자다 — `spawn` 으로 띄워야 그룹·신호
/// 시퀀스가 붙는다.
pub struct GitCommand {
    pub cmd: std::process::Command,
    /// 찾은 git 실행 파일 (Go `cmd.Path`).
    pub bin: String,
    /// 빈 stdin 에는 파이프를 만들지 않는다.
    pub stdin: Option<String>,
}

/// git 프로세스 하나를 만든다 — 동기 실행과 잡이 함께 쓰는 유일한 기동 자리다
/// (FR-OPT-7-1). bin 탐색·launch_args·환경·디렉터리·stdin 을 한 번에 붙인다.
pub fn command<S: AsRef<str>>(dir: &str, args: &[S], stdin: &str) -> Result<GitCommand, Error> {
    command_in(dir, args, stdin, None)
}

pub(crate) fn command_in<S: AsRef<str>>(
    dir: &str,
    args: &[S],
    stdin: &str,
    path_env: Option<&str>,
) -> Result<GitCommand, Error> {
    let bin = look_git(path_env).map_err(|m| Error::new(Kind::GitMissing, m))?;
    let mut cmd = std::process::Command::new(&bin);
    cmd.args(launch_args(args)).current_dir(dir);
    for (k, v) in ENV_OVERRIDES {
        cmd.env(k, v);
    }
    Ok(GitCommand {
        cmd,
        bin,
        stdin: (!stdin.is_empty()).then(|| stdin.to_owned()),
    })
}

/// git 실행 파일의 탐색 결과다. 키는 PATH 값이다. 찾지 못한 결과는 담지 않는다.
static GIT_BIN: Mutex<Option<(String, String)>> = Mutex::new(None);

fn os_path_env() -> String {
    std::env::var_os("PATH")
        .map(|v| v.to_string_lossy().into_owned())
        .unwrap_or_default()
}

pub(crate) fn look_git(path_env: Option<&str>) -> Result<String, String> {
    let path = path_env.map_or_else(os_path_env, str::to_owned);
    let mut cache = GIT_BIN.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((p, bin)) = cache.as_ref()
        && *p == path
    {
        return Ok(bin.clone());
    }
    let bin = otter_shared_platform::try_look_path_in("git", &path)
        .map_err(|e| otter_shared_platform::exec_error("git", e))?;
    *cache = Some((path, bin.clone()));
    Ok(bin)
}

/// 기동 실패가 캐시된 bin 이 사라진 탓인지 본다. 그렇다면 캐시를 버린다 (FR-OPT-7-1).
pub fn vanished_bin(bin: &str, err: &SpawnError) -> bool {
    if !matches!(err, SpawnError::Start { .. }) || !not_exist(bin) {
        return false;
    }
    forget_git();
    true
}

pub(crate) fn forget_git() {
    *GIT_BIN.lock().unwrap_or_else(|e| e.into_inner()) = None;
}

/// 가드를 지난 argv 앞에 사용자 설정을 중립화하는 전역 인자를 붙인다 (REPO_FIX 01 P-4).
pub fn launch_args<S: AsRef<str>>(args: &[S]) -> Vec<String> {
    let mut v = vec!["-c".to_owned(), "log.showSignature=false".to_owned()];
    v.extend(args.iter().map(|a| a.as_ref().to_owned()));
    v
}

/// git 이 사람을 기다리거나 로케일에 흔들리지 않게 하는 환경이다. 순서가 곧 Go 의 순서다.
pub const ENV_OVERRIDES: [(&str, &str); 10] = [
    ("GIT_TERMINAL_PROMPT", "0"),
    ("GIT_ASKPASS", ""),
    ("SSH_ASKPASS", ""),
    ("SSH_ASKPASS_REQUIRE", "never"),
    ("GIT_OPTIONAL_LOCKS", "0"),
    ("GIT_PAGER", "cat"),
    ("PAGER", "cat"),
    ("GIT_EDITOR", "true"),
    ("GIT_SEQUENCE_EDITOR", "true"),
    ("LC_ALL", "C"),
];

/// Go `Env()`: 프로세스 환경 뒤에 ENV_OVERRIDES 를 붙인 `KEY=VALUE` 목록.
pub fn env() -> Vec<String> {
    std::env::vars_os()
        .map(|(k, v)| format!("{}={}", k.to_string_lossy(), v.to_string_lossy()))
        .chain(ENV_OVERRIDES.iter().map(|(k, v)| format!("{k}={v}")))
        .collect()
}

/// 상한까지만 보존하고 초과분을 버린다 (FR-GIT-6). 소비 스레드가 spawn 반환 뒤에도 돌 수
/// 있으므로 잠금을 갖는다.
pub(crate) struct CappedBuffer {
    limit: usize,
    inner: Mutex<(Vec<u8>, bool)>,
}

impl CappedBuffer {
    pub(crate) fn new(limit: usize) -> Self {
        CappedBuffer {
            limit,
            inner: Mutex::new((Vec::new(), false)),
        }
    }

    /// 버린 분량도 썼다고 답한다.
    pub(crate) fn write(&self, p: &[u8]) -> usize {
        let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let room = self.limit.saturating_sub(g.0.len());
        if room >= p.len() {
            g.0.extend_from_slice(p);
        } else {
            g.0.extend_from_slice(&p[..room]);
            g.1 = true;
        }
        p.len()
    }

    pub(crate) fn bytes(&self) -> Vec<u8> {
        self.inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .0
            .clone()
    }

    pub(crate) fn is_truncated(&self) -> bool {
        self.inner.lock().unwrap_or_else(|e| e.into_inner()).1
    }

    fn consumer(self: &Arc<Self>) -> crate::spawn::Consumer {
        let me = self.clone();
        Box::new(move |mut r: Box<dyn Read + Send>| {
            let mut buf = [0u8; 32 * 1024];
            loop {
                match r.read(&mut buf) {
                    Ok(0) => return,
                    Ok(n) => {
                        me.write(&buf[..n]);
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
                    Err(_) => return,
                }
            }
        })
    }
}
