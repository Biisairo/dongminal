//! 이름 없는 인계 파일 (Go swap `anonFile`). 데몬 교체 상태를 새 이미지에 fd 로 넘긴다.

use std::fs::File;
use std::io;
use std::path::Path;

/// 이름 없는 읽기·쓰기 파일이다. linux 는 memfd(close-on-exec), 그 밖은 dir 에 0600 으로 만들고 곧바로
/// 지운 임시 파일이다 (Go `os.CreateTemp(dir, ".handover-*")` + `os.Remove`).
pub fn anon_file(dir: &Path) -> io::Result<File> {
    imp(dir)
}

#[cfg(target_os = "linux")]
fn imp(_dir: &Path) -> io::Result<File> {
    use std::os::fd::FromRawFd;
    // SAFETY: 이름은 NUL 로 끝나는 정적 문자열이고 플래그는 정수다.
    let fd = unsafe { libc::memfd_create(c"otterminal-handover".as_ptr(), libc::MFD_CLOEXEC) };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: memfd_create 가 막 돌려준, 아무도 소유하지 않은 fd 다.
    Ok(unsafe { File::from_raw_fd(fd) })
}

#[cfg(not(target_os = "linux"))]
fn imp(dir: &Path) -> io::Result<File> {
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    /// Go `os.CreateTemp` 의 재시도 상한.
    const MAX_TRIES: u32 = 10_000;
    static SEQ: AtomicU32 = AtomicU32::new(0);
    let seed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0)
        ^ std::process::id().rotate_left(16);
    for _ in 0..MAX_TRIES {
        let n = seed.wrapping_add(
            SEQ.fetch_add(1, Ordering::Relaxed)
                .wrapping_mul(2_654_435_761),
        );
        let path = dir.join(format!(".handover-{n}"));
        let mut opts = std::fs::OpenOptions::new();
        opts.read(true).write(true).create_new(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut opts, 0o600);
        match opts.open(&path) {
            Ok(f) => {
                std::fs::remove_file(&path)?;
                return Ok(f);
            }
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        }
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "anon_file: 이름을 고르지 못했다",
    ))
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Seek, SeekFrom, Write};

    #[test]
    fn anon_file_is_nameless_and_readable() {
        let dir = tempfile::tempdir().unwrap();
        let mut f = super::anon_file(dir.path()).unwrap();
        f.write_all(b"{\"version\":1}").unwrap();
        f.seek(SeekFrom::Start(0)).unwrap();
        let mut s = String::new();
        f.read_to_string(&mut s).unwrap();
        assert_eq!(s, "{\"version\":1}");
        assert_eq!(
            std::fs::read_dir(dir.path()).unwrap().count(),
            0,
            "이름이 남았다"
        );
    }
}
