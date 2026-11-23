//! Go `os.MkdirAll` (os/path.go). 알고리즘과 오류 문구가 같다 (FR-RDF-9).

use std::fs;
use std::io;

use super::path_error;
use crate::filepath;

/// Go `os.MkdirAll(path, perm)`. 있는 것이 디렉터리가 아니면 `mkdir <path>: not a directory`,
/// 조상에서 막히면 막힌 그 칸의 경로로 `*os.PathError` 문구를 낸다.
pub fn mkdir_all(path: &str, perm: u32) -> io::Result<()> {
    if let Ok(m) = fs::metadata(path) {
        if m.is_dir() {
            return Ok(());
        }
        return Err(path_error("mkdir", path, not_a_directory()));
    }
    let b = path.as_bytes();
    let mut i = b.len();
    while i > 0 && filepath::is_path_separator(b[i - 1]) {
        i -= 1;
    }
    while i > 0 && !filepath::is_path_separator(b[i - 1]) {
        i -= 1;
    }
    let parent = &path[..i.saturating_sub(1)];
    if parent.len() > filepath::volume_name(path).len() {
        mkdir_all(parent, perm)?;
    }
    if let Err(e) = mkdir(path, perm) {
        if fs::symlink_metadata(path).is_ok_and(|m| m.is_dir()) {
            return Ok(());
        }
        return Err(path_error("mkdir", path, e));
    }
    Ok(())
}

fn mkdir(path: &str, perm: u32) -> io::Result<()> {
    #[cfg_attr(not(unix), expect(unused_mut))]
    let mut b = fs::DirBuilder::new();
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut b, perm);
    #[cfg(not(unix))]
    let _ = perm;
    b.create(path)
}

/// Go `syscall.ENOTDIR`.
fn not_a_directory() -> io::Error {
    #[cfg(unix)]
    {
        // darwin·linux 모두 20 이다.
        io::Error::from_raw_os_error(20)
    }
    #[cfg(not(unix))]
    {
        // Go Windows 의 ENOTDIR 은 syscall 이 지어낸 Errno 이고 문구는 표의 것이다.
        io::Error::new(io::ErrorKind::NotADirectory, "not a directory")
    }
}
