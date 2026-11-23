//! Go `os` 함수의 동작과 오류 문구 (`os.MkdirAll`·`os.Mkdir`·`os.ReadFile`·`os.Remove`·`os.Chtimes`).

use std::fs;
use std::io;
use std::path::Path;
use std::time::SystemTime;

use dm_gocompat::oserr::path_error;

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
    match fs::metadata(p) {
        Ok(m) if m.is_dir() => return Ok(()),
        Ok(_) => {
            let e = io::Error::new(io::ErrorKind::NotADirectory, "not a directory");
            return Err(path_error("mkdir", &s(p), e));
        }
        Err(_) => {}
    }
    if let Some(parent) = p.parent().filter(|q| !q.as_os_str().is_empty()) {
        mkdir_all(parent, mode)?;
    }
    if let Err(e) = mkdir(p, mode) {
        if fs::symlink_metadata(p).is_ok_and(|m| m.is_dir()) {
            return Ok(());
        }
        return Err(e);
    }
    Ok(())
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
