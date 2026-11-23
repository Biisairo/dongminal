//! git 을 띄우는 자리 (REPO_FIX 01 P-1·P-3).

use std::fmt;
use std::io::{self, Read, Write};
use std::process::{Command, ExitStatus, Stdio};
use std::sync::Mutex;
use std::time::Duration;

use dm_gocompat::oserr::go_error_string;
use tokio::sync::{Notify, mpsc};

use crate::ctx::Ctx;

/// SIGTERM 뒤 SIGKILL 까지, 그리고 SIGKILL 뒤 파이프 회수까지의 유예다. 반환 상한은
/// 마감 + 2×KILL_GRACE 다.
pub const KILL_GRACE: Duration = Duration::from_secs(3);
/// 잡 하나의 상한이다 (O9).
pub const JOB_CEILING: Duration = Duration::from_secs(10 * 60);

/// 출력 소비자. spawn 이 돌아온 뒤에도 돌 수 있으므로 자기 버퍼를 스스로 보호한다.
pub type Consumer = Box<dyn FnOnce(Box<dyn Read + Send>) + Send>;

/// 띄우기 실패.
#[derive(Debug)]
pub enum SpawnError {
    /// 프로세스를 시작하지 못했다 (Go `*fs.PathError{Op: "fork/exec"}`).
    Start { program: String, err: io::Error },
    /// 그룹 배정에 실패했다. 자식은 끝냈다 — status 는 그 종료 상태다.
    Bind {
        err: io::Error,
        status: Option<ExitStatus>,
    },
}

impl fmt::Display for SpawnError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SpawnError::Start { program, err } => {
                write!(f, "fork/exec {program}: {}", go_error_string(err))
            }
            SpawnError::Bind { err, .. } => f.write_str(&go_error_string(err)),
        }
    }
}

impl std::error::Error for SpawnError {}

/// 떠 있는 spawn 의 수다 (REPO_FIX 01 §8).
pub(crate) struct Activity {
    n: Mutex<usize>,
    idle: Notify,
}

impl Activity {
    pub(crate) const fn new() -> Self {
        Activity {
            n: Mutex::new(0),
            idle: Notify::const_new(),
        }
    }

    fn enter(&self) -> ActivityGuard<'_> {
        *self.n.lock().unwrap_or_else(|e| e.into_inner()) += 1;
        ActivityGuard(self)
    }

    fn count(&self) -> usize {
        *self.n.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub(crate) async fn wait(&self, d: Duration) -> bool {
        let deadline = tokio::time::Instant::now() + d;
        loop {
            let notified = self.idle.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.count() == 0 {
                return true;
            }
            if tokio::time::timeout_at(deadline, notified).await.is_err() {
                return self.count() == 0;
            }
        }
    }
}

struct ActivityGuard<'a>(&'a Activity);

impl Drop for ActivityGuard<'_> {
    fn drop(&mut self) {
        let mut n = self.0.n.lock().unwrap_or_else(|e| e.into_inner());
        *n -= 1;
        if *n == 0 {
            self.0.idle.notify_waiters();
        }
    }
}

static SPAWNED: Activity = Activity::new();

/// 떠 있는 git 이 모두 끝날 때까지 d 만큼 기다린다. 끝났으면 참이다.
pub async fn drain(d: Duration) -> bool {
    SPAWNED.wait(d).await
}

/// cmd 를 새 그룹(POSIX 새 세션 / Windows Job Object)으로 띄우고 stdout·stderr 를 각
/// 소비자에게 흘린 뒤 신호 시퀀스대로 끝낸다.
///
/// A. ctx 가 끝나면: 그룹 terminate → 리더 종료 대기 ≤G → 안 끝나면 그룹 kill → 리더가
/// 끝나면 그룹 kill → 읽기 끝 대기 ≤G → 넘으면 읽기 스레드를 버린다.
/// B. 리더가 먼저 끝나면: 읽기 끝 대기 ≤G → 안 오면 그룹 kill → ≤G → 버린다.
///
/// 반환값은 리더의 종료 상태다.
pub async fn spawn(
    ctx: &Ctx,
    cmd: Command,
    stdin: Option<String>,
    stdout: Consumer,
    stderr: Consumer,
) -> Result<ExitStatus, SpawnError> {
    spawn_with(ctx, cmd, stdin, stdout, stderr, KILL_GRACE, &SPAWNED).await
}

pub(crate) async fn spawn_with(
    ctx: &Ctx,
    mut cmd: Command,
    stdin: Option<String>,
    stdout: Consumer,
    stderr: Consumer,
    grace: Duration,
    activity: &Activity,
) -> Result<ExitStatus, SpawnError> {
    let _active = activity.enter();
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    cmd.stdin(if stdin.is_some() {
        Stdio::piped()
    } else {
        Stdio::null()
    });
    let group = dm_shared_platform::current().process.new_group(&mut cmd);
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(err) => {
            let _ = group.close();
            let program = cmd.get_program().to_string_lossy().into_owned();
            return Err(SpawnError::Start { program, err });
        }
    };
    // Windows 는 여기서 Job 에 배정하고 중단된 자식을 재개한다 (FR-XPR-5).
    if let Err(err) = group.bind(&child) {
        let _ = group.kill();
        let _ = child.kill();
        let status = tokio::task::spawn_blocking(move || child.wait())
            .await
            .ok()
            .and_then(Result::ok);
        let _ = group.close();
        return Err(SpawnError::Bind { err, status });
    }

    let (tx, mut reads) = mpsc::channel::<()>(2);
    let mut left = 0usize;
    if let Some(r) = child.stdout.take() {
        left += 1;
        start_reader(Box::new(r), stdout, tx.clone());
    }
    if let Some(r) = child.stderr.take() {
        left += 1;
        start_reader(Box::new(r), stderr, tx.clone());
    }
    drop(tx);
    if let (Some(mut w), Some(data)) = (child.stdin.take(), stdin) {
        std::thread::spawn(move || {
            let _ = w.write_all(data.as_bytes());
        });
    }

    let mut wait = tokio::task::spawn_blocking(move || child.wait());
    let status = tokio::select! {
        r = &mut wait => r,
        _ = ctx.done() => {
            let _ = group.terminate();
            match tokio::time::timeout(grace, &mut wait).await {
                Ok(r) => r,
                Err(_) => {
                    let _ = group.kill();
                    wait.await
                }
            }
        }
    };
    let status = match status {
        Ok(Ok(st)) => Ok(st),
        Ok(Err(err)) => Err(err),
        Err(join) => Err(io::Error::other(join.to_string())),
    };

    if ctx.err().is_some() {
        // A: 리더는 끝났다 — 남은 자손을 지금 쓸어낸다.
        let _ = group.kill();
        wait_reads(&mut reads, &mut left, grace).await;
    } else if !wait_reads(&mut reads, &mut left, grace).await {
        // B
        let _ = group.kill();
        wait_reads(&mut reads, &mut left, grace).await;
    }
    let _ = group.close();
    // 리더 대기 자체의 실패는 종료 상태가 없는 실패다.
    status.map_err(|err| SpawnError::Bind { err, status: None })
}

fn start_reader(r: Box<dyn Read + Send>, consume: Consumer, done: mpsc::Sender<()>) {
    std::thread::spawn(move || {
        consume(r);
        let _ = done.blocking_send(());
    });
}

/// 남은 읽기가 d 안에 모두 끝나면 참이다.
async fn wait_reads(reads: &mut mpsc::Receiver<()>, left: &mut usize, d: Duration) -> bool {
    let deadline = tokio::time::Instant::now() + d;
    while *left > 0 {
        match tokio::time::timeout_at(deadline, reads.recv()).await {
            Ok(Some(())) => *left -= 1,
            // 보낸 쪽이 모두 사라졌다 — 읽기 스레드가 끝났다.
            Ok(None) => *left = 0,
            Err(_) => return false,
        }
    }
    true
}

/// Go `(*ProcessState).String()`. 신호로 끝난 상태의 문구에 쓴다.
pub fn exit_status_string(st: &ExitStatus) -> String {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        let mut res = match (st.code(), st.signal(), st.stopped_signal()) {
            (Some(code), _, _) => format!("exit status {code}"),
            (_, Some(sig), _) => format!("signal: {}", signal_name(sig)),
            (_, _, Some(sig)) => format!("stop signal: {}", signal_name(sig)),
            _ if st.continued() => "continued".to_owned(),
            _ => String::new(),
        };
        if st.core_dumped() {
            res.push_str(" (core dumped)");
        }
        res
    }
    #[cfg(not(unix))]
    {
        match st.code() {
            Some(code) if (code as u32) >= 1 << 16 => format!("exit status 0x{:x}", code as u32),
            Some(code) => format!("exit status {code}"),
            None => String::new(),
        }
    }
}

/// Go `syscall.Signal.String()` (go1.27.2 zerrors 표).
#[cfg(unix)]
fn signal_name(sig: i32) -> String {
    #[cfg(target_os = "macos")]
    const NAMES: [&str; 31] = [
        "hangup",
        "interrupt",
        "quit",
        "illegal instruction",
        "trace/BPT trap",
        "abort trap",
        "EMT trap",
        "floating point exception",
        "killed",
        "bus error",
        "segmentation fault",
        "bad system call",
        "broken pipe",
        "alarm clock",
        "terminated",
        "urgent I/O condition",
        "suspended (signal)",
        "suspended",
        "continued",
        "child exited",
        "stopped (tty input)",
        "stopped (tty output)",
        "I/O possible",
        "cputime limit exceeded",
        "filesize limit exceeded",
        "virtual timer expired",
        "profiling timer expired",
        "window size changes",
        "information request",
        "user defined signal 1",
        "user defined signal 2",
    ];
    #[cfg(not(target_os = "macos"))]
    const NAMES: [&str; 31] = [
        "hangup",
        "interrupt",
        "quit",
        "illegal instruction",
        "trace/breakpoint trap",
        "aborted",
        "bus error",
        "floating point exception",
        "killed",
        "user defined signal 1",
        "segmentation fault",
        "user defined signal 2",
        "broken pipe",
        "alarm clock",
        "terminated",
        "stack fault",
        "child exited",
        "continued",
        "stopped (signal)",
        "stopped",
        "stopped (tty input)",
        "stopped (tty output)",
        "urgent I/O condition",
        "CPU time limit exceeded",
        "file size limit exceeded",
        "virtual timer expired",
        "profiling timer expired",
        "window changed",
        "I/O possible",
        "power failure",
        "bad system call",
    ];
    match usize::try_from(sig) {
        Ok(i) if (1..=NAMES.len()).contains(&i) => NAMES[i - 1].to_owned(),
        _ => format!("signal {sig}"),
    }
}
