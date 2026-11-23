//! Claude Code 의 npm proper-lockfile 과 호환되는 디렉터리 락 (FR-CAC-30 ②, cswap
//! `claude_locks.py`). mkdir 의 원자성이 상호 배제이고, 잡은 쪽은 mtime 을 주기적으로 갱신한다.
//! mtime 이 staleness 보다 오래된 락은 버려진 것으로 보고 가져온다.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant, SystemTime};

use crate::DIR_MODE;
use crate::error::{Error, Sentinel};
use crate::fsutil;
use crate::paths::ClaudePaths;

pub(crate) const CRED_LOCK_STALE: Duration = Duration::from_secs(60);
pub(crate) const CONFIG_LOCK_STALE: Duration = Duration::from_secs(10);
const TAKEOVER_STALE: Duration = Duration::from_secs(5);
const TAKEOVER_SUFFIX: &str = ".takeover";
pub const DEFAULT_LOCK_WAIT: Duration = Duration::from_secs(9);
const DIR_LOCK_POLL_MIN: Duration = Duration::from_millis(250);
const DIR_LOCK_POLL_JITTER_MS: u64 = 250;
/// 낡은 잠금을 걷지 못했을 때(다른 쪽이 먼저 걷는 중) 다시 보기까지의 틈이다.
const STALE_RETRY_WAIT: Duration = Duration::from_millis(50);
/// 잡은 동안 mtime 을 갱신하는 주기다.
const DIR_LOCK_TOUCH: Duration = Duration::from_secs(3);

/// 잡은 디렉터리 락. drop 하면 갱신을 멈추고 디렉터리를 지운다.
#[derive(Debug)]
pub(crate) struct DirLock {
    dir: PathBuf,
    stop: Option<mpsc::Sender<()>>,
    toucher: Option<thread::JoinHandle<()>>,
}

impl Drop for DirLock {
    fn drop(&mut self) {
        drop(self.stop.take());
        if let Some(h) = self.toucher.take() {
            let _ = h.join();
        }
        let _ = fsutil::remove(&self.dir);
    }
}

fn age(p: &Path) -> io::Result<Duration> {
    let m = fs::metadata(p)?.modified()?;
    Ok(SystemTime::now().duration_since(m).unwrap_or_default())
}

pub(crate) fn acquire_dir_lock(
    dir: &Path,
    staleness: Duration,
    timeout: Duration,
) -> Result<DirLock, Error> {
    acquire_dir_lock_with(dir, staleness, timeout, DIR_LOCK_TOUCH)
}

pub(crate) fn acquire_dir_lock_with(
    dir: &Path,
    staleness: Duration,
    timeout: Duration,
    touch: Duration,
) -> Result<DirLock, Error> {
    fsutil::mkdir_all(
        &dir.parent().map(Path::to_path_buf).unwrap_or_default(),
        DIR_MODE,
    )?;
    let start = Instant::now();
    loop {
        match fsutil::mkdir(dir, DIR_MODE) {
            Ok(()) => break,
            Err(e) if e.kind() != io::ErrorKind::AlreadyExists => return Err(e.into()),
            Err(_) => {}
        }
        if start.elapsed() > timeout {
            return Err(Sentinel::ClaudeLockTimeout.into());
        }
        match age(dir) {
            Err(e) if e.kind() == io::ErrorKind::NotFound => continue,
            Ok(a) if a > staleness => {
                if !remove_if_still_stale(dir, staleness) {
                    thread::sleep(STALE_RETRY_WAIT);
                }
                continue;
            }
            _ => {}
        }
        let jitter = rand::random_range(0..DIR_LOCK_POLL_JITTER_MS);
        thread::sleep(DIR_LOCK_POLL_MIN + Duration::from_millis(jitter));
    }
    let (tx, rx) = mpsc::channel::<()>();
    let d = dir.to_path_buf();
    let toucher = thread::spawn(move || {
        while let Err(mpsc::RecvTimeoutError::Timeout) = rx.recv_timeout(touch) {
            if fsutil::chtimes(&d, SystemTime::now()).is_err() {
                return;
            }
        }
    });
    Ok(DirLock {
        dir: dir.to_path_buf(),
        stop: Some(tx),
        toucher: Some(toucher),
    })
}

/// takeover 디렉터리 아래에서 낡은 락을 지운다. 두 대기자가 동시에 지우다 새 주인의 락을 지우는
/// 일을 막는다.
fn remove_if_still_stale(dir: &Path, staleness: Duration) -> bool {
    let mut tk = dir.as_os_str().to_owned();
    tk.push(TAKEOVER_SUFFIX);
    let tk = PathBuf::from(tk);
    if fsutil::mkdir(&tk, DIR_MODE).is_err() {
        if age(&tk).is_ok_and(|a| a > TAKEOVER_STALE) {
            let _ = fsutil::remove(&tk);
        }
        return false;
    }
    let out = match age(dir) {
        Ok(a) if a > staleness => fsutil::remove(dir).is_ok(),
        _ => false,
    };
    let _ = fsutil::remove(&tk);
    out
}

/// Claude Code 의 락 셋. drop 하면 잡은 반대 순서로 놓는다.
#[derive(Debug)]
pub(crate) struct ClaudeLock(Vec<DirLock>);

impl Drop for ClaudeLock {
    fn drop(&mut self) {
        while let Some(l) = self.0.pop() {
            drop(l);
        }
    }
}

/// Claude Code 의 자격증명 락 둘과 설정 락을 이 순서로 잡는다.
pub(crate) fn lock_claude(p: &ClaudePaths, timeout: Duration) -> Result<ClaudeLock, Error> {
    let mut held = ClaudeLock(Vec::with_capacity(3));
    for d in p.cred_lock_dirs() {
        held.0.push(acquire_dir_lock(&d, CRED_LOCK_STALE, timeout)?);
    }
    held.0.push(acquire_dir_lock(
        &p.config_lock_dir(),
        CONFIG_LOCK_STALE,
        timeout,
    )?);
    Ok(held)
}
