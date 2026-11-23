//! Go `os` 의 두 동작 — `MkdirAll` 의 오류 문구와 `UserHomeDir`.

use std::fs;
use std::io;

use dm_gocompat::filepath;
use dm_gocompat::oserr::path_error;

#[cfg(unix)]
const DIR_PERM: u32 = 0o755;

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

fn mkdir(p: &str) -> io::Result<()> {
    #[cfg(unix)]
    let r = {
        use std::os::unix::fs::DirBuilderExt;
        fs::DirBuilder::new().mode(DIR_PERM).create(p)
    };
    #[cfg(not(unix))]
    let r = fs::create_dir(p);
    r.map_err(|e| path_error("mkdir", p, e))
}

/// Go `os.MkdirAll(p, 0o755)`. 실패한 그 칸의 경로로 오류를 낸다.
pub(crate) fn mkdir_all(p: &str) -> io::Result<()> {
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
        let parent = &p[..j - 1];
        if cfg!(windows) && parent.len() == 2 && parent.as_bytes()[1] == b':' {
            mkdir_all(&format!("{parent}\\"))?;
        } else {
            mkdir_all(parent)?;
        }
    }
    if let Err(e) = mkdir(p) {
        if fs::symlink_metadata(p).is_ok_and(|m| m.is_dir()) {
            return Ok(());
        }
        return Err(e);
    }
    Ok(())
}

/// Go `os.UserHomeDir`.
pub(crate) fn user_home_dir() -> Result<String, String> {
    let (env, missing) = if cfg!(windows) {
        ("USERPROFILE", "%userprofile% is not defined")
    } else {
        ("HOME", "$HOME is not defined")
    };
    match std::env::var(env) {
        Ok(v) if !v.is_empty() => Ok(v),
        _ => Err(missing.to_owned()),
    }
}
