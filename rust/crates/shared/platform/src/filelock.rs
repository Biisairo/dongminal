//! 배타 파일 락 (CLAUDE_ACCOUNTS_SRS FR-CAC-3).

use std::fmt;
use std::fs::{File, OpenOptions, TryLockError};
use std::io;
use std::path::Path;
use std::time::{Duration, Instant};

use crate::goerr::path_err;

const LOCK_RETRY: Duration = Duration::from_millis(100);
/// 락 파일 상위 디렉터리의 권한 (Go `os.MkdirAll(filepath.Dir(path), 0o700)`).
const LOCK_DIR_PERM: u32 = 0o700;

/// `lock_file` 의 오류.
#[derive(Debug)]
pub enum LockError {
    /// 기다림 한도 안에 락을 잡지 못했다.
    Timeout,
    Io(io::Error),
}

impl fmt::Display for LockError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            LockError::Timeout => f.write_str("락을 잡지 못했습니다"),
            LockError::Io(e) => e.fmt(f),
        }
    }
}

impl std::error::Error for LockError {}

/// 잡은 락. drop 하면 놓는다.
#[derive(Debug)]
pub struct FileLock {
    file: File,
}

impl Drop for FileLock {
    fn drop(&mut self) {
        let _ = self.file.unlock();
    }
}

/// path 에 배타 락을 잡는다. 잡을 수 없으면 0.1초 간격으로 다시 시도하고, timeout 이 지나면
/// `LockError::Timeout` 이다. 재진입하지 않는다. 상위 디렉터리는 0700 으로 만든다.
///
/// POSIX 는 flock, Windows 는 LockFileEx 다 — Go 판과 같은 파일을 두고 서로를 막는다.
pub fn lock_file(path: &Path, timeout: Duration) -> Result<FileLock, LockError> {
    let dir = crate::atomic::parent_dir(path);
    otter_gocompat::oserr::mkdir_all(&dir.to_string_lossy(), LOCK_DIR_PERM)
        .map_err(LockError::Io)?;
    let mut opts = OpenOptions::new();
    opts.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let file = opts
        .open(path)
        .map_err(|e| LockError::Io(path_err("open", path, e)))?;
    let deadline = Instant::now() + timeout;
    loop {
        match file.try_lock() {
            Ok(()) => return Ok(FileLock { file }),
            Err(TryLockError::WouldBlock) => {}
            Err(TryLockError::Error(e)) => return Err(LockError::Io(e)),
        }
        if Instant::now() > deadline {
            return Err(LockError::Timeout);
        }
        std::thread::sleep(LOCK_RETRY);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exclusive() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join(".lock");
        let held = lock_file(&p, Duration::from_secs(1)).unwrap();
        let start = Instant::now();
        let second = lock_file(&p, Duration::from_millis(300));
        assert!(matches!(second, Err(LockError::Timeout)), "{second:?}");
        assert!(
            start.elapsed() >= Duration::from_millis(250),
            "기다리지 않고 포기했다"
        );
        assert_eq!(LockError::Timeout.to_string(), "락을 잡지 못했습니다");
        drop(held);
        drop(lock_file(&p, Duration::from_secs(1)).expect("놓은 뒤에는 잡힌다"));
    }

    #[test]
    fn waits_for_release() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join(".lock");
        let held = lock_file(&p, Duration::from_secs(1)).unwrap();
        let t = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(150));
            drop(held);
        });
        drop(lock_file(&p, Duration::from_secs(2)).expect("놓이면 잡는다"));
        t.join().unwrap();
    }

    // FR-RDF-9: 상위를 만들 수 없으면 Go os.MkdirAll 처럼 막힌 그 칸의 경로로 낸다.
    #[test]
    fn mkdir_error_matches_go() {
        let d = tempfile::tempdir().unwrap();
        let blocker = d.path().join("f");
        std::fs::write(&blocker, "x").unwrap();
        let e = lock_file(&blocker.join("a").join(".lock"), Duration::from_secs(1)).unwrap_err();
        assert_eq!(
            e.to_string(),
            format!("mkdir {}: not a directory", blocker.display())
        );
    }

    #[test]
    fn creates_parent() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("a").join("b").join(".lock");
        drop(lock_file(&p, Duration::from_secs(1)).unwrap());
    }
}
