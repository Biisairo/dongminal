//! Go `os` 함수의 동작과 오류 문구 (`os.MkdirAll`·`os.Mkdir`·`os.ReadFile`·`os.Remove`·`os.Chtimes`).

use std::fs;
use std::io;
use std::path::Path;
use std::time::{Duration, SystemTime};

use otter_gocompat::oserr::path_error;
use otter_shared_platform::{FileLock, LockError};
use tokio::runtime::{Handle, RuntimeFlavor};

fn s(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

/// Go `os.Mkdir(p, mode)`.
pub(crate) fn mkdir(p: &Path, mode: u32) -> io::Result<()> {
    #[cfg_attr(not(unix), allow(unused_mut))]
    let mut b = fs::DirBuilder::new();
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut b, mode);
    #[cfg(not(unix))]
    let _ = mode;
    b.create(p).map_err(|e| path_error("mkdir", &s(p), e))
}

/// Go `os.MkdirAll(p, mode)`.
pub(crate) fn mkdir_all(p: &Path, mode: u32) -> io::Result<()> {
    otter_gocompat::oserr::mkdir_all(&s(p), mode)
}

/// Go `os.ReadFile(p)`.
pub(crate) fn read_file(p: &Path) -> io::Result<Vec<u8>> {
    fs::read(p).map_err(|e| path_error("open", &s(p), e))
}

/// Go `os.Remove(p)`: 파일, 아니면 빈 디렉터리를 지운다.
pub(crate) fn remove(p: &Path) -> io::Result<()> {
    match fs::remove_file(p) {
        Ok(()) => Ok(()),
        Err(e) => {
            if fs::symlink_metadata(p).is_ok_and(|m| m.is_dir()) {
                return fs::remove_dir(p).map_err(|e| path_error("remove", &s(p), e));
            }
            Err(path_error("remove", &s(p), e))
        }
    }
}

/// `remove` 이되 없는 것은 성공이다.
pub(crate) fn remove_if_exists(p: &Path) -> io::Result<()> {
    match remove(p) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        r => r,
    }
}

/// Go `os.Chtimes(p, t, t)`. 디렉터리에도 쓴다.
pub(crate) fn chtimes(p: &Path, t: SystemTime) -> io::Result<()> {
    let mut o = fs::OpenOptions::new();
    #[cfg(unix)]
    o.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
        const FILE_WRITE_ATTRIBUTES: u32 = 0x0100;
        o.access_mode(FILE_WRITE_ATTRIBUTES)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS);
    }
    let f = o.open(p).map_err(|e| path_error("chtimes", &s(p), e))?;
    f.set_times(fs::FileTimes::new().set_accessed(t).set_modified(t))
        .map_err(|e| path_error("chtimes", &s(p), e))
}

/// 락 대기·키체인 같은 블로킹 호출을 tokio 작업 스레드 밖에서 부른다 (FR-RDF-2). 다중 스레드
/// 런타임의 작업 스레드면 그 스레드의 다른 task 를 다른 스레드로 넘기고 f 를 부른다. 그 밖(blocking
/// 풀, 런타임 밖, current_thread 런타임)에서는 그대로 부른다.
pub(crate) fn off_worker<T>(f: impl FnOnce() -> T) -> T {
    match Handle::try_current() {
        Ok(h) if h.runtime_flavor() == RuntimeFlavor::MultiThread => tokio::task::block_in_place(f),
        _ => f(),
    }
}

/// 작업 스레드를 막지 않는 [`otter_shared_platform::lock_file`] 이다.
pub(crate) fn lock_file(path: &Path, timeout: Duration) -> Result<FileLock, LockError> {
    off_worker(|| otter_shared_platform::lock_file(path, timeout))
}
