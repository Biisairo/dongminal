//! Go `exec.LookPath` (go1.27.2, GODEBUG execerrdot 기본값). 셸·브라우저를 고르는 데 쓴다.
//!
//! [`try_look_path`] 는 "없음"과 Go `ErrDot`(상대경로로만 찾음)을 가른다 (FR-RDF-11). "찾았는가" 만
//! 보는 호출부는 `Option` 을 내는 [`look_path`] 를 쓴다. ErrDot 은 Go 에서 오류이므로 `None` 이다.

use dm_gocompat::filepath::{unix, windows};
use dm_gocompat::strconv::quote;

const DEFAULT_PATHEXT: &[&str] = &[".com", ".exe", ".bat", ".cmd"];

/// Go `exec.LookPath` 의 실패.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LookPathError {
    /// Go `exec.ErrNotFound`.
    NotFound,
    /// Go `exec.ErrDot`: 현재 디렉터리나 상대 PATH 항목에서만 찾았다. 실행하지 않는다.
    Dot,
}

impl LookPathError {
    /// 감싼 Go 오류의 `Error()` 문구.
    pub fn as_str(self) -> &'static str {
        match self {
            LookPathError::NotFound if cfg!(windows) => "executable file not found in %PATH%",
            LookPathError::NotFound => "executable file not found in $PATH",
            LookPathError::Dot => "cannot run executable found relative to current directory",
        }
    }
}

/// Go `(&exec.Error{Name: file, Err: err}).Error()`.
pub fn exec_error(file: &str, err: LookPathError) -> String {
    format!("exec: {}: {}", quote(file), err.as_str())
}

fn rejected(file: &str) -> bool {
    matches!(file, "" | "." | "..")
}

/// unix 판. `find` 는 Go `findExecutable` 이 성공하는가다.
#[cfg_attr(windows, allow(dead_code))]
pub(crate) fn look_path_unix(
    file: &str,
    path_env: &str,
    find: impl Fn(&str) -> bool,
) -> Result<String, LookPathError> {
    if rejected(file) {
        return Err(LookPathError::NotFound);
    }
    if file.contains('/') {
        return find(file)
            .then(|| file.to_owned())
            .ok_or(LookPathError::NotFound);
    }
    for dir in unix::split_list(path_env) {
        let dir = if dir.is_empty() { "." } else { dir.as_str() };
        let p = unix::join(&[dir, file]);
        if find(&p) {
            return unix::is_abs(&p).then_some(p).ok_or(LookPathError::Dot);
        }
    }
    Err(LookPathError::NotFound)
}

/// windows 판의 환경.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) struct WinEnv<'a> {
    /// `%path%`.
    pub path: &'a str,
    /// `%PATHEXT%`. 빈 값이면 기본 확장자 목록이다.
    pub pathext: &'a str,
    /// `NoDefaultCurrentDirectoryInExePath` 가 정의되어 있는가.
    pub no_cwd: bool,
}

#[cfg_attr(not(windows), allow(dead_code))]
fn path_ext(x: &str) -> Vec<String> {
    if x.is_empty() {
        return DEFAULT_PATHEXT.iter().map(|s| (*s).to_owned()).collect();
    }
    x.to_lowercase()
        .split(';')
        .filter(|e| !e.is_empty())
        .map(|e| {
            if e.starts_with('.') {
                e.to_owned()
            } else {
                format!(".{e}")
            }
        })
        .collect()
}

#[cfg_attr(not(windows), allow(dead_code))]
fn has_ext(file: &str) -> bool {
    match file.rfind('.') {
        Some(i) => file.rfind([':', '\\', '/']).is_none_or(|j| j < i),
        None => false,
    }
}

#[cfg_attr(not(windows), allow(dead_code))]
fn find_executable_win(file: &str, exts: &[String], chk: &impl Fn(&str) -> bool) -> Option<String> {
    if exts.is_empty() {
        return chk(file).then(|| file.to_owned());
    }
    if has_ext(file) && chk(file) {
        return Some(file.to_owned());
    }
    exts.iter().map(|e| format!("{file}{e}")).find(|f| chk(f))
}

/// windows 판. `chk` 는 Go `chkStat`(있고 디렉터리가 아니다), `same` 은 `os.SameFile` 이다.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn look_path_windows(
    file: &str,
    env: &WinEnv<'_>,
    chk: impl Fn(&str) -> bool,
    same: impl Fn(&str, &str) -> bool,
) -> Result<String, LookPathError> {
    if rejected(file) {
        return Err(LookPathError::NotFound);
    }
    let exts = path_ext(env.pathext);
    if file.contains([':', '\\', '/']) {
        return find_executable_win(file, &exts, &chk).ok_or(LookPathError::NotFound);
    }
    // 현재 디렉터리에서 찾은 것은 Go 에서 ErrDot 오류다. PATH 에서 같은 실체를 찾을 때만 살아난다.
    let mut dotf: Option<String> = None;
    if !env.no_cwd {
        dotf = find_executable_win(&windows::join(&[".", file]), &exts, &chk);
    }
    for dir in windows::split_list(env.path) {
        if dir.is_empty() {
            continue;
        }
        let Some(f) = find_executable_win(&windows::join(&[&dir, file]), &exts, &chk) else {
            continue;
        };
        if let Some(d) = &dotf
            && !same(d, &f)
        {
            return Err(LookPathError::Dot);
        }
        if !windows::is_abs(&f) {
            if dotf.is_none() {
                dotf = Some(f);
            }
            continue;
        }
        return Ok(f);
    }
    Err(if dotf.is_some() {
        LookPathError::Dot
    } else {
        LookPathError::NotFound
    })
}

/// 이 호스트의 `exec.LookPath`. 찾지 못했거나 ErrDot 이면 `None` 이다.
pub fn look_path(file: &str) -> Option<String> {
    try_look_path(file).ok()
}

/// `look_path` 와 같되, 검색 경로(unix `PATH`, windows `%path%`)를 인자로 받는다.
/// 시험이 프로세스 환경을 바꾸지 않고 검색 경로를 바꿔 볼 수 있게 한다.
pub fn look_path_in(file: &str, path_env: &str) -> Option<String> {
    try_look_path_in(file, path_env).ok()
}

/// 이 호스트의 `exec.LookPath`. 실패의 종류를 가른다.
pub fn try_look_path(file: &str) -> Result<String, LookPathError> {
    #[cfg(windows)]
    let path_env = super::os_env("path");
    #[cfg(not(windows))]
    let path_env = super::os_env("PATH");
    try_look_path_in(file, &path_env)
}

/// [`try_look_path`] 와 같되, 검색 경로를 인자로 받는다.
pub fn try_look_path_in(file: &str, path_env: &str) -> Result<String, LookPathError> {
    #[cfg(windows)]
    {
        use std::path::Path;
        let pathext = super::os_env("PATHEXT");
        let env = WinEnv {
            path: path_env,
            pathext: &pathext,
            no_cwd: std::env::var_os("NoDefaultCurrentDirectoryInExePath").is_some(),
        };
        look_path_windows(
            file,
            &env,
            |p| std::fs::metadata(p).is_ok_and(|m| !m.is_dir()),
            |a, b| match (
                crate::paths::file_id(Path::new(a)),
                crate::paths::file_id(Path::new(b)),
            ) {
                (Some(x), Some(y)) => x == y,
                _ => false,
            },
        )
    }
    #[cfg(not(windows))]
    {
        look_path_unix(file, path_env, find_executable_unix)
    }
}

/// Go `findExecutable`(unix): 디렉터리가 아니고, 유효 ID 로 실행할 수 있다. `faccessat` 이
/// ENOSYS·EPERM 이면 권한 비트로 내려간다.
#[cfg(unix)]
fn find_executable_unix(file: &str) -> bool {
    use std::os::unix::fs::PermissionsExt;
    let Ok(m) = std::fs::metadata(file) else {
        return false;
    };
    if m.is_dir() {
        return false;
    }
    match eaccess_x(file) {
        Ok(()) => true,
        Err(e) if matches!(e.raw_os_error(), Some(libc::ENOSYS) | Some(libc::EPERM)) => {
            m.permissions().mode() & 0o111 != 0
        }
        Err(_) => false,
    }
}

#[cfg(unix)]
fn eaccess_x(file: &str) -> std::io::Result<()> {
    let c = std::ffi::CString::new(file)?;
    // SAFETY: c 는 호출 동안 살아 있는 NUL 종료 문자열이고, faccessat 은 그것을 읽기만 한다.
    let rc = unsafe { libc::faccessat(libc::AT_FDCWD, c.as_ptr(), libc::X_OK, libc::AT_EACCESS) };
    if rc == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(test)]
mod tests {
    #[cfg(unix)]
    #[test]
    fn look_path_in_uses_given_search_path() {
        use std::os::unix::fs::PermissionsExt;
        let d = tempfile::tempdir().unwrap();
        let exe = d.path().join("dm-fake-tool");
        std::fs::write(&exe, b"#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755)).unwrap();
        let dir = d.path().to_str().unwrap();
        assert_eq!(
            crate::look_path_in("dm-fake-tool", dir).as_deref(),
            exe.to_str()
        );
        assert_eq!(
            crate::look_path_in("dm-fake-tool", "/nonexistent-dm-dir"),
            None
        );
        assert_eq!(crate::look_path_in("", dir), None);
    }

    // FR-RDF-11: go1.27.2 실측 — PATH 가 `.` 뿐이고 그 자리에 실행 파일이 있으면 ErrDot 이다.
    #[cfg(unix)]
    #[test]
    fn try_look_path_in_tells_dot_from_not_found() {
        use std::os::unix::fs::PermissionsExt;
        let d = tempfile::tempdir().unwrap();
        let exe = d.path().join("dm-fake-dot");
        std::fs::write(&exe, b"#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755)).unwrap();
        let rel = dm_gocompat::filepath::rel(
            &std::env::current_dir().unwrap().to_string_lossy(),
            &d.path().to_string_lossy(),
        )
        .unwrap();
        let e = crate::try_look_path_in("dm-fake-dot", &rel).unwrap_err();
        assert_eq!(e, crate::LookPathError::Dot);
        assert_eq!(
            crate::exec_error("dm-fake-dot", e),
            r#"exec: "dm-fake-dot": cannot run executable found relative to current directory"#
        );
        let e = crate::try_look_path_in("dm-no-such-dot", &rel).unwrap_err();
        assert_eq!(
            crate::exec_error("dm-no-such-dot", e),
            r#"exec: "dm-no-such-dot": executable file not found in $PATH"#
        );
        assert_eq!(crate::look_path_in("dm-fake-dot", &rel), None);
    }

    #[test]
    fn exec_error_matches_go() {
        let nf = if cfg!(windows) {
            "executable file not found in %PATH%"
        } else {
            "executable file not found in $PATH"
        };
        assert_eq!(
            crate::exec_error("x", crate::LookPathError::NotFound),
            format!(r#"exec: "x": {nf}"#)
        );
        assert_eq!(
            crate::exec_error("a\"b", crate::LookPathError::Dot),
            r#"exec: "a\"b": cannot run executable found relative to current directory"#
        );
    }

    use super::*;

    fn set(found: &'static [&'static str]) -> impl Fn(&str) -> bool {
        move |p| found.contains(&p)
    }

    #[test]
    fn unix_rules() {
        let find = set(&["/usr/bin/chromium", "/opt/x/tool", "./rel", "rel2/t"]);
        assert_eq!(
            look_path_unix("chromium", "/bin:/usr/bin", &find).as_deref(),
            Ok("/usr/bin/chromium")
        );
        assert_eq!(
            look_path_unix("nope", "/bin:/usr/bin", &find),
            Err(LookPathError::NotFound)
        );
        // 구분자가 있으면 PATH 를 보지 않는다.
        assert_eq!(
            look_path_unix("/opt/x/tool", "", &find).as_deref(),
            Ok("/opt/x/tool")
        );
        assert_eq!(
            look_path_unix("/opt/x/none", "/opt/x", &find),
            Err(LookPathError::NotFound)
        );
        // 빈 항목은 "." 이고, 상대경로로 찾은 것은 ErrDot 이다.
        let find = set(&["rel", "rel2/t"]);
        assert_eq!(
            look_path_unix("rel", ":/usr/bin", &find),
            Err(LookPathError::Dot)
        );
        assert_eq!(look_path_unix("t", "rel2", &find), Err(LookPathError::Dot));
        assert_eq!(
            look_path_unix("", "/", |_| true),
            Err(LookPathError::NotFound)
        );
        assert_eq!(
            look_path_unix("..", "/", |_| true),
            Err(LookPathError::NotFound)
        );
    }

    #[test]
    fn windows_rules() {
        let env = WinEnv {
            path: r"C:\a;;C:\b",
            pathext: "",
            no_cwd: true,
        };
        let chk = set(&[r"C:\b\chrome.exe", r"C:\b\tool.cmd"]);
        let same = |a: &str, b: &str| a == b;
        assert_eq!(
            look_path_windows("chrome.exe", &env, &chk, same).as_deref(),
            Ok(r"C:\b\chrome.exe")
        );
        assert_eq!(
            look_path_windows("tool", &env, &chk, same).as_deref(),
            Ok(r"C:\b\tool.cmd")
        );
        assert_eq!(
            look_path_windows("msedge.exe", &env, &chk, same),
            Err(LookPathError::NotFound)
        );

        // PATHEXT 는 소문자로, 점이 없으면 붙인다.
        let env2 = WinEnv {
            pathext: "EXE;;cmd",
            ..env
        };
        assert_eq!(path_ext(env2.pathext), [".exe", ".cmd"]);
        assert_eq!(path_ext(";"), Vec::<String>::new());

        // 현재 디렉터리에만 있으면 ErrDot.
        let cwd = WinEnv {
            path: r"C:\a",
            pathext: "",
            no_cwd: false,
        };
        let chk = set(&["pwsh.exe"]);
        assert_eq!(
            look_path_windows("pwsh.exe", &cwd, &chk, same),
            Err(LookPathError::Dot)
        );
        // 현재 디렉터리와 PATH 가 같은 실체면 PATH 의 것.
        let chk = set(&["pwsh.exe", r"C:\a\pwsh.exe"]);
        assert_eq!(
            look_path_windows("pwsh.exe", &cwd, &chk, |_, _| true).as_deref(),
            Ok(r"C:\a\pwsh.exe")
        );
        // 다르면 ErrDot.
        assert_eq!(
            look_path_windows("pwsh.exe", &cwd, &chk, |_, _| false),
            Err(LookPathError::Dot)
        );
        // 상대 PATH 항목도 ErrDot.
        let rel = WinEnv {
            path: r"rel;C:\z",
            pathext: "",
            no_cwd: true,
        };
        let chk = set(&[r"rel\x.exe"]);
        assert_eq!(
            look_path_windows("x.exe", &rel, &chk, same),
            Err(LookPathError::Dot)
        );
    }

    #[test]
    fn has_ext_rules() {
        assert!(has_ext("a.exe"));
        assert!(!has_ext("a"));
        assert!(!has_ext(r"C:\a.b\c"));
        assert!(has_ext(r"C:\a\c.x"));
    }
}
