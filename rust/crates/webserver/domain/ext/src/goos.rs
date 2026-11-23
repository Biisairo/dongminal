//! Go `os` 의 파일 함수 중 이 crate 가 쓰는 것. 동작(MkdirAll 의 단계, Remove 의 순서)과
//! 오류 문구(`open <경로>: <errno>`)가 Go 와 같다. 문구는 gocompat `oserr` 로 만든다.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::sync::atomic::{AtomicU32, Ordering};

use dm_gocompat::filepath;
use dm_gocompat::oserr::{link_error, path_error};

fn not_a_directory() -> io::Error {
    #[cfg(unix)]
    {
        io::Error::from_raw_os_error(20)
    }
    #[cfg(not(unix))]
    {
        io::Error::other("not a directory")
    }
}

/// Go `os.Open`.
pub(crate) fn open(p: &str) -> io::Result<File> {
    File::open(p).map_err(|e| path_error("open", p, e))
}

/// Go `os.ReadFile`.
pub(crate) fn read_file(p: &str) -> io::Result<Vec<u8>> {
    let mut f = open(p)?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf)
        .map_err(|e| path_error("read", p, e))?;
    Ok(buf)
}

/// Go `os.ReadDir`: (이름, 디렉터리인가) 를 이름 순으로. 링크는 따라가지 않는다.
pub(crate) fn read_dir(p: &str) -> io::Result<Vec<(String, bool)>> {
    let rd = fs::read_dir(p).map_err(|e| path_error("open", p, e))?;
    let mut out = Vec::new();
    for ent in rd {
        let ent = ent.map_err(|e| path_error("readdirent", p, e))?;
        let is_dir = ent.file_type().is_ok_and(|t| t.is_dir());
        out.push((ent.file_name().to_string_lossy().into_owned(), is_dir));
    }
    out.sort();
    Ok(out)
}

/// Go `os.Stat` 이 성공하는가.
pub(crate) fn exists(p: &str) -> bool {
    fs::metadata(p).is_ok()
}

/// Go `os.Lstat` 이 성공하는가.
pub(crate) fn lexists(p: &str) -> bool {
    fs::symlink_metadata(p).is_ok()
}

/// Go `os.Mkdir`.
fn mkdir(p: &str, perm: u32) -> io::Result<()> {
    let mut b = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        b.mode(perm);
    }
    #[cfg(not(unix))]
    let _ = perm;
    b.create(p).map_err(|e| path_error("mkdir", p, e))
}

/// Go `os.MkdirAll`. 실패한 그 칸의 경로로 오류를 낸다.
pub(crate) fn mkdir_all(p: &str, perm: u32) -> io::Result<()> {
    if let Ok(m) = fs::metadata(p) {
        if m.is_dir() {
            return Ok(());
        }
        return Err(path_error("mkdir", p, not_a_directory()));
    }
    let b = p.as_bytes();
    let mut i = b.len();
    while i > 0 && filepath::is_path_separator(b[i - 1]) {
        i -= 1;
    }
    let mut j = i;
    while j > 0 && !filepath::is_path_separator(b[j - 1]) {
        j -= 1;
    }
    if j > 1 {
        mkdir_all(&fix_root_directory(&p[..j - 1]), perm)?;
    }
    if let Err(e) = mkdir(p, perm) {
        if fs::symlink_metadata(p).is_ok_and(|m| m.is_dir()) {
            return Ok(());
        }
        return Err(e);
    }
    Ok(())
}

/// Go `fixRootDirectory`: Windows 의 `C:` 는 `C:\` 로 본다.
fn fix_root_directory(p: &str) -> String {
    if cfg!(windows) && p.len() == 2 && p.as_bytes()[1] == b':' {
        return format!("{p}\\");
    }
    p.to_owned()
}

/// Go `os.OpenFile(p, O_CREATE|O_WRONLY|O_TRUNC, perm)`.
pub(crate) fn create(p: &str, perm: u32) -> io::Result<File> {
    let mut o = OpenOptions::new();
    o.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        o.mode(perm);
    }
    #[cfg(not(unix))]
    let _ = perm;
    o.open(p).map_err(|e| path_error("open", p, e))
}

/// Go `os.WriteFile`.
pub(crate) fn write_file(p: &str, data: &[u8], perm: u32) -> io::Result<()> {
    let mut f = create(p, perm)?;
    f.write_all(data).map_err(|e| path_error("write", p, e))
}

/// Go `os.Remove`: 파일로 지우고, 안 되면 디렉터리로 지운다.
pub(crate) fn remove(p: &str) -> io::Result<()> {
    let e = match fs::remove_file(p) {
        Ok(()) => return Ok(()),
        Err(e) => e,
    };
    match fs::remove_dir(p) {
        Ok(()) => Ok(()),
        Err(e1) if is_not_dir(&e1) => Err(path_error("remove", p, e)),
        Err(e1) => Err(path_error("remove", p, e1)),
    }
}

fn is_not_dir(e: &io::Error) -> bool {
    #[cfg(unix)]
    {
        e.raw_os_error() == Some(20)
    }
    #[cfg(not(unix))]
    {
        e.kind() != io::ErrorKind::NotFound
    }
}

/// Go `os.RemoveAll`. 이 crate 는 결과를 쓰지 않는다 — 정리는 곁다리다.
pub(crate) fn remove_all(p: &str) {
    match fs::symlink_metadata(p) {
        Ok(m) if m.is_dir() => {
            let _ = fs::remove_dir_all(p);
        }
        Ok(_) => {
            let _ = fs::remove_file(p);
        }
        Err(_) => {}
    }
}

/// Go `os.Rename`.
pub(crate) fn rename(from: &str, to: &str) -> io::Result<()> {
    fs::rename(from, to).map_err(|e| link_error("rename", from, to, e))
}

fn next_random() -> String {
    static SEQ: AtomicU32 = AtomicU32::new(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    let n = nanos
        .wrapping_mul(2_654_435_761)
        .wrapping_add(SEQ.fetch_add(1, Ordering::Relaxed))
        .wrapping_add(std::process::id());
    n.to_string()
}

/// pattern 의 마지막 `*` 를 무작위 숫자로 바꾼 이름들 (Go `prefixAndSuffix`).
fn split_pattern(pattern: &str) -> (&str, &str) {
    match pattern.rfind('*') {
        Some(i) => (&pattern[..i], &pattern[i + 1..]),
        None => (pattern, ""),
    }
}

const TEMP_TRIES: usize = 10_000;

/// Go `os.CreateTemp(dir, pattern)`: 0600 으로 새로 만든 파일과 그 이름.
pub(crate) fn create_temp(dir: &str, pattern: &str) -> io::Result<(File, String)> {
    let (pre, suf) = split_pattern(pattern);
    let prefix = filepath::join(&[dir, pre]);
    let mut last = None;
    for _ in 0..TEMP_TRIES {
        let name = format!("{prefix}{}{suf}", next_random());
        let mut o = OpenOptions::new();
        o.read(true).write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            o.mode(0o600);
        }
        match o.open(&name) {
            Ok(f) => return Ok((f, name)),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => last = Some(e),
            Err(e) => return Err(path_error("open", &name, e)),
        }
    }
    let e = last.unwrap_or_else(|| io::Error::from(io::ErrorKind::AlreadyExists));
    Err(path_error("createtemp", &format!("{prefix}*{suf}"), e))
}

/// Go `os.MkdirTemp(dir, pattern)`: 0700 으로 새로 만든 디렉터리의 이름.
pub(crate) fn mkdir_temp(dir: &str, pattern: &str) -> io::Result<String> {
    let (pre, suf) = split_pattern(pattern);
    let prefix = filepath::join(&[dir, pre]);
    let mut last = None;
    for _ in 0..TEMP_TRIES {
        let name = format!("{prefix}{}{suf}", next_random());
        match mkdir(&name, 0o700) {
            Ok(()) => return Ok(name),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => last = Some(e),
            Err(e) => return Err(e),
        }
    }
    let e = last.unwrap_or_else(|| io::Error::from(io::ErrorKind::AlreadyExists));
    Err(path_error("mkdirtemp", &format!("{prefix}*{suf}"), e))
}
