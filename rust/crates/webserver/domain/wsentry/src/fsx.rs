//! Go `os` 의 두 동작 — `MkdirAll` 의 오류 문구와 `UserHomeDir`.

use std::io;

const DIR_PERM: u32 = 0o755;

/// Go `os.MkdirAll(p, 0o755)`.
pub(crate) fn mkdir_all(p: &str) -> io::Result<()> {
    dm_gocompat::oserr::mkdir_all(p, DIR_PERM)
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
