//! Go `exec.LookPath` (go1.27.2, GODEBUG execerrdot 기본값). 셸·브라우저를 고르는 데 쓴다.
//!
//! 호출부는 오류의 종류를 보지 않고 "찾았는가" 만 보므로 `Option` 으로 낸다. 상대경로로 찾은
//! 결과(Go `ErrDot`)는 Go 에서 오류이므로 `None` 이다.

use dm_gocompat::filepath::{unix, windows};

const DEFAULT_PATHEXT: &[&str] = &[".com", ".exe", ".bat", ".cmd"];

fn rejected(file: &str) -> bool {
    matches!(file, "" | "." | "..")
}

/// unix 판. `find` 는 Go `findExecutable` 이 성공하는가다.
#[cfg_attr(windows, allow(dead_code))]
pub(crate) fn look_path_unix(
    file: &str,
    path_env: &str,
    find: impl Fn(&str) -> bool,
) -> Option<String> {
    if rejected(file) {
        return None;
    }
    if file.contains('/') {
        return find(file).then(|| file.to_owned());
    }
    for dir in unix::split_list(path_env) {
        let dir = if dir.is_empty() { "." } else { dir.as_str() };
        let p = unix::join(&[dir, file]);
        if find(&p) {
            return unix::is_abs(&p).then_some(p);
        }
    }
    None
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
) -> Option<String> {
    if rejected(file) {
        return None;
    }
    let exts = path_ext(env.pathext);
    if file.contains([':', '\\', '/']) {
        return find_executable_win(file, &exts, &chk);
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
            return None;
        }
        if !windows::is_abs(&f) {
            if dotf.is_none() {
                dotf = Some(f);
            }
            continue;
        }
        return Some(f);
    }
    None
}

/// 이 호스트의 `exec.LookPath`.
pub(crate) fn look_path(file: &str) -> Option<String> {
    #[cfg(windows)]
    {
        use std::path::Path;
        let path = super::os_env("path");
        let pathext = super::os_env("PATHEXT");
        let env = WinEnv {
            path: &path,
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
        look_path_unix(file, &super::os_env("PATH"), find_executable_unix)
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
    use super::*;

    fn set(found: &'static [&'static str]) -> impl Fn(&str) -> bool {
        move |p| found.contains(&p)
    }

    #[test]
    fn unix_rules() {
        let find = set(&["/usr/bin/chromium", "/opt/x/tool", "./rel", "rel2/t"]);
        assert_eq!(
            look_path_unix("chromium", "/bin:/usr/bin", &find).as_deref(),
            Some("/usr/bin/chromium")
        );
        assert_eq!(look_path_unix("nope", "/bin:/usr/bin", &find), None);
        // 구분자가 있으면 PATH 를 보지 않는다.
        assert_eq!(
            look_path_unix("/opt/x/tool", "", &find).as_deref(),
            Some("/opt/x/tool")
        );
        assert_eq!(look_path_unix("/opt/x/none", "/opt/x", &find), None);
        // 빈 항목은 "." 이고, 상대경로로 찾은 것은 ErrDot 이다.
        let find = set(&["rel", "rel2/t"]);
        assert_eq!(look_path_unix("rel", ":/usr/bin", &find), None);
        assert_eq!(look_path_unix("t", "rel2", &find), None);
        assert_eq!(look_path_unix("", "/", |_| true), None);
        assert_eq!(look_path_unix("..", "/", |_| true), None);
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
            Some(r"C:\b\chrome.exe")
        );
        assert_eq!(
            look_path_windows("tool", &env, &chk, same).as_deref(),
            Some(r"C:\b\tool.cmd")
        );
        assert_eq!(look_path_windows("msedge.exe", &env, &chk, same), None);

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
        assert_eq!(look_path_windows("pwsh.exe", &cwd, &chk, same), None);
        // 현재 디렉터리와 PATH 가 같은 실체면 PATH 의 것.
        let chk = set(&["pwsh.exe", r"C:\a\pwsh.exe"]);
        assert_eq!(
            look_path_windows("pwsh.exe", &cwd, &chk, |_, _| true).as_deref(),
            Some(r"C:\a\pwsh.exe")
        );
        // 다르면 ErrDot.
        assert_eq!(
            look_path_windows("pwsh.exe", &cwd, &chk, |_, _| false),
            None
        );
        // 상대 PATH 항목도 ErrDot.
        let rel = WinEnv {
            path: r"rel;C:\z",
            pathext: "",
            no_cwd: true,
        };
        let chk = set(&[r"rel\x.exe"]);
        assert_eq!(look_path_windows("x.exe", &rel, &chk, same), None);
    }

    #[test]
    fn has_ext_rules() {
        assert!(has_ext("a.exe"));
        assert!(!has_ext("a"));
        assert!(!has_ext(r"C:\a.b\c"));
        assert!(has_ext(r"C:\a\c.x"));
    }
}
