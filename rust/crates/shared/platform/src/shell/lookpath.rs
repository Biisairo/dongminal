//! Go `exec.LookPath` (go1.27.2, GODEBUG execerrdot 기본값). 셸·브라우저를 고르는 데 쓴다.
//!
//! [`try_look_path`] 는 "없음"과 Go `ErrDot`(상대경로로만 찾음)을 가른다 (FR-RDF-11). "찾았는가" 만
//! 보는 호출부는 `Option` 을 내는 [`look_path`] 를 쓴다. ErrDot 은 Go 에서 오류이므로 `None` 이다.

use dm_gocompat::filepath::{unix, windows};
use dm_gocompat::strconv::quote;

const DEFAULT_PATHEXT: &[&str] = &[".com", ".exe", ".bat", ".cmd"];

/// Go `exec.LookPath` 의 실패.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LookPathError {
    /// Go `exec.ErrNotFound`.
    NotFound,
    /// Go `exec.ErrDot`: 현재 디렉터리나 상대 PATH 항목에서만 찾았다. 실행하지 않는다.
    Dot,
    /// 명시 경로에서 Go `findExecutable` 이 낸 원인의 `Error()` 문구.
    Find(String),
}

impl LookPathError {
    /// 감싼 Go 오류의 `Error()` 문구.
    pub fn as_str(&self) -> &str {
        match self {
            LookPathError::NotFound if cfg!(windows) => "executable file not found in %PATH%",
            LookPathError::NotFound => "executable file not found in $PATH",
            LookPathError::Dot => "cannot run executable found relative to current directory",
            LookPathError::Find(m) => m,
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

/// unix 판. `find` 는 Go `findExecutable` 이고, 실패는 그 원인의 문구다.
#[cfg_attr(windows, allow(dead_code))]
pub(crate) fn look_path_unix(
    file: &str,
    path_env: &str,
    find: impl Fn(&str) -> Result<(), String>,
) -> Result<String, LookPathError> {
    if rejected(file) {
        return Err(LookPathError::NotFound);
    }
    if file.contains('/') {
        return find(file)
            .map(|()| file.to_owned())
            .map_err(LookPathError::Find);
    }
    for dir in unix::split_list(path_env) {
        let dir = if dir.is_empty() { "." } else { dir.as_str() };
        let p = unix::join(&[dir, file]);
        if find(&p).is_ok() {
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

/// Go `fs.ErrNotExist.Error()`.
const ERR_NOT_EXIST: &str = "file does not exist";

/// Go `findExecutable`(windows).
#[cfg_attr(not(windows), allow(dead_code))]
fn find_executable_win(
    file: &str,
    exts: &[String],
    chk: &impl Fn(&str) -> Result<(), String>,
) -> Result<String, LookPathError> {
    if exts.is_empty() {
        return chk(file)
            .map(|()| file.to_owned())
            .map_err(LookPathError::Find);
    }
    if has_ext(file) && chk(file).is_ok() {
        return Ok(file.to_owned());
    }
    if let Some(f) = exts
        .iter()
        .map(|e| format!("{file}{e}"))
        .find(|f| chk(f).is_ok())
    {
        return Ok(f);
    }
    Err(if has_ext(file) {
        LookPathError::Find(ERR_NOT_EXIST.to_owned())
    } else {
        LookPathError::NotFound
    })
}

/// windows 판. `chk` 는 Go `chkStat`(있고 디렉터리가 아니다)이고 실패는 그 문구, `same` 은
/// `os.SameFile` 이다.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn look_path_windows(
    file: &str,
    env: &WinEnv<'_>,
    chk: impl Fn(&str) -> Result<(), String>,
    same: impl Fn(&str, &str) -> bool,
) -> Result<String, LookPathError> {
    if rejected(file) {
        return Err(LookPathError::NotFound);
    }
    let exts = path_ext(env.pathext);
    if file.contains([':', '\\', '/']) {
        return find_executable_win(file, &exts, &chk);
    }
    // 현재 디렉터리에서 찾은 것은 Go 에서 ErrDot 오류다. PATH 에서 같은 실체를 찾을 때만 살아난다.
    let mut dotf: Option<String> = None;
    if !env.no_cwd {
        dotf = find_executable_win(&windows::join(&[".", file]), &exts, &chk).ok();
    }
    for dir in windows::split_list(env.path) {
        if dir.is_empty() {
            continue;
        }
        let Ok(f) = find_executable_win(&windows::join(&[&dir, file]), &exts, &chk) else {
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

/// Go `exec.Command(name, ..)` 가 실행할 경로. 이름이 `filepath.Base(name)` 와 같으면(구분자가 없으면)
/// LookPath 를 거치고, 실패(ErrDot 포함)는 Go `exec.Error` 문구다. 그 밖의 이름은 그대로 둔다.
/// std `Command::new` 에 맨 이름을 주면 std 가 PATH 를 직접 훑어 ErrDot 거절을 건너뛴다.
pub fn command_path(name: &str) -> Result<String, String> {
    #[cfg(windows)]
    let path_env = super::os_env("path");
    #[cfg(not(windows))]
    let path_env = super::os_env("PATH");
    command_path_in(name, &path_env)
}

/// [`command_path`] 와 같되, 검색 경로를 인자로 받는다.
pub fn command_path_in(name: &str, path_env: &str) -> Result<String, String> {
    if dm_gocompat::filepath::base(name) != name {
        return Ok(name.to_owned());
    }
    try_look_path_in(name, path_env).map_err(|e| exec_error(name, e))
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
        look_path_windows(file, &env, chk_stat_windows, |a, b| {
            match (
                crate::paths::file_id(Path::new(a)),
                crate::paths::file_id(Path::new(b)),
            ) {
                (Some(x), Some(y)) => x == y,
                _ => false,
            }
        })
    }
    #[cfg(not(windows))]
    {
        look_path_unix(file, path_env, find_executable_unix)
    }
}

/// Go `fs.ErrPermission.Error()`.
const ERR_PERMISSION: &str = "permission denied";

/// Go `chkStat`(windows): 있고 디렉터리가 아니다. Go `os.Stat` 은 없는 파일에
/// `GetFileAttributesEx`, 그 밖의 실패에 `CreateFile` 을 op 로 싣는다.
#[cfg(windows)]
fn chk_stat_windows(file: &str) -> Result<(), String> {
    use dm_gocompat::oserr::{go_error_string, path_error};
    match std::fs::metadata(file) {
        Ok(m) if m.is_dir() => Err(ERR_PERMISSION.to_owned()),
        Ok(_) => Ok(()),
        Err(e) => {
            let op = if e.kind() == std::io::ErrorKind::NotFound {
                "GetFileAttributesEx"
            } else {
                "CreateFile"
            };
            Err(go_error_string(&path_error(op, file, e)))
        }
    }
}

/// Go `findExecutable`(unix): 디렉터리가 아니고, 유효 ID 로 실행할 수 있다. `faccessat` 이
/// ENOSYS·EPERM 이면 권한 비트로 내려간다. 실패는 Go 의 원인 문구다.
#[cfg(unix)]
fn find_executable_unix(file: &str) -> Result<(), String> {
    use dm_gocompat::oserr::{errno_string, go_error_string, path_error};
    use std::os::unix::fs::PermissionsExt;
    let m = std::fs::metadata(file).map_err(|e| go_error_string(&path_error("stat", file, e)))?;
    if m.is_dir() {
        return Err(errno_string(libc::EISDIR));
    }
    match eaccess_x(file) {
        Ok(()) => Ok(()),
        Err(e) if matches!(e.raw_os_error(), Some(libc::ENOSYS) | Some(libc::EPERM)) => {
            if m.permissions().mode() & 0o111 != 0 {
                Ok(())
            } else {
                Err(ERR_PERMISSION.to_owned())
            }
        }
        Err(e) => Err(go_error_string(&e)),
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

    // 10.5b: Go exec.Command 처럼 맨 이름만 LookPath 를 거친다. ErrDot 이면 실행할 경로를 주지 않는다.
    #[cfg(unix)]
    #[test]
    fn command_path_in_follows_exec_command() {
        use std::os::unix::fs::PermissionsExt;
        let d = tempfile::tempdir().unwrap();
        let exe = d.path().join("dm-dot-cmd");
        std::fs::write(&exe, b"#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755)).unwrap();
        let rel = dm_gocompat::filepath::rel(
            &std::env::current_dir().unwrap().to_string_lossy(),
            &d.path().to_string_lossy(),
        )
        .unwrap();
        assert_eq!(
            crate::command_path_in("dm-dot-cmd", &rel).unwrap_err(),
            r#"exec: "dm-dot-cmd": cannot run executable found relative to current directory"#
        );
        let dir = d.path().to_string_lossy().into_owned();
        assert_eq!(
            crate::command_path_in("dm-dot-cmd", &dir).unwrap(),
            exe.to_string_lossy()
        );
        assert_eq!(
            crate::command_path_in("./dm-dot-cmd", &rel).unwrap(),
            "./dm-dot-cmd"
        );
    }

    // 10.5b: go1.27.2 실측 — 명시 경로를 찾지 못하면 findExecutable 의 원인을 싣는다.
    #[cfg(unix)]
    #[test]
    fn explicit_path_errors_match_go() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path().to_string_lossy().into_owned();
        std::fs::write(format!("{r}/plain"), "x").unwrap();
        std::fs::create_dir(format!("{r}/dir")).unwrap();
        let msg = |p: String| crate::exec_error(&p, crate::try_look_path_in(&p, "").unwrap_err());
        assert_eq!(
            msg(format!("{r}/missing")),
            format!(r#"exec: "{r}/missing": stat {r}/missing: no such file or directory"#)
        );
        assert_eq!(
            msg(format!("{r}/dir")),
            format!(r#"exec: "{r}/dir": is a directory"#)
        );
        assert_eq!(
            msg(format!("{r}/plain/x")),
            format!(r#"exec: "{r}/plain/x": stat {r}/plain/x: not a directory"#)
        );
        // root 는 실행 권한 검사를 건너뛴다.
        if std::fs::File::open("/etc/sudoers").is_err() {
            assert_eq!(
                msg(format!("{r}/plain")),
                format!(r#"exec: "{r}/plain": permission denied"#)
            );
        }
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

    fn set(found: &'static [&'static str]) -> impl Fn(&str) -> Result<(), String> {
        move |p| {
            if found.contains(&p) {
                Ok(())
            } else {
                Err(format!("stat {p}: no such file or directory"))
            }
        }
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
        // 명시 경로의 실패는 Go findExecutable 의 원인 그대로다.
        assert_eq!(
            look_path_unix("/opt/x/none", "/opt/x", &find),
            Err(LookPathError::Find(
                "stat /opt/x/none: no such file or directory".into()
            ))
        );
        // 빈 항목은 "." 이고, 상대경로로 찾은 것은 ErrDot 이다.
        let find = set(&["rel", "rel2/t"]);
        assert_eq!(
            look_path_unix("rel", ":/usr/bin", &find),
            Err(LookPathError::Dot)
        );
        assert_eq!(look_path_unix("t", "rel2", &find), Err(LookPathError::Dot));
        assert_eq!(
            look_path_unix("", "/", |_| Ok(())),
            Err(LookPathError::NotFound)
        );
        assert_eq!(
            look_path_unix("..", "/", |_| Ok(())),
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

    // 10.5b: Windows 명시 경로 — Go findExecutable·chkStat 의 원인 그대로다.
    #[test]
    fn windows_explicit_path_errors() {
        let env = WinEnv {
            path: r"C:\a",
            pathext: "",
            no_cwd: true,
        };
        let chk = set(&[]);
        let same = |a: &str, b: &str| a == b;
        assert_eq!(
            look_path_windows(r"C:\x\tool", &env, &chk, same),
            Err(LookPathError::NotFound)
        );
        assert_eq!(
            look_path_windows(r"C:\x\a.exe", &env, &chk, same),
            Err(LookPathError::Find("file does not exist".into()))
        );
        let noext = WinEnv {
            pathext: ";",
            ..env
        };
        assert_eq!(
            look_path_windows(r"C:\x\a.exe", &noext, &chk, same),
            Err(LookPathError::Find(
                r"stat C:\x\a.exe: no such file or directory".into()
            ))
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
