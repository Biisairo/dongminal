//! Go `os`·`syscall` 오류의 문구 (RUST_PORT_SRS FR-RSP-35).
//!
//! - errno 문구는 Go `syscall.Errno.Error()` 와 같다. unix 는 Go 의 표(소문자)를 쓴다.
//!   Windows 는 Go 처럼 FormatMessageW 를 영어(US)로 먼저 부른다(C-RSP-4 의 예외 자리).
//! - [`path_error`]·[`link_error`]·[`syscall_error`] 는 Go `*os.PathError`·`*os.LinkError`·
//!   `*os.SyscallError` 문구를 담은 `io::Error` 를 만든다. `ErrorKind` 는 원래 오류의 것을 지키고,
//!   [`raw_os_error`] 로 원래 errno 를 꺼낼 수 있다.

#[cfg(any(
    all(
        target_os = "macos",
        any(target_arch = "aarch64", target_arch = "x86_64")
    ),
    all(
        target_os = "linux",
        any(target_arch = "aarch64", target_arch = "x86_64")
    ),
))]
mod errno_table;
#[cfg(windows)]
mod windows;

use std::fmt;
use std::io;

/// Go `syscall.Errno(code).Error()`.
pub fn errno_string(code: i32) -> String {
    #[cfg(any(
        all(
            target_os = "macos",
            any(target_arch = "aarch64", target_arch = "x86_64")
        ),
        all(
            target_os = "linux",
            any(target_arch = "aarch64", target_arch = "x86_64")
        ),
    ))]
    {
        match errno_table::ERRORS.binary_search_by_key(&code, |&(n, _)| n) {
            Ok(i) if !errno_table::ERRORS[i].1.is_empty() => errno_table::ERRORS[i].1.to_owned(),
            _ => format!("errno {code}"),
        }
    }
    #[cfg(windows)]
    {
        windows::errno_string(code)
    }
    #[cfg(not(any(
        windows,
        all(
            target_os = "macos",
            any(target_arch = "aarch64", target_arch = "x86_64")
        ),
        all(
            target_os = "linux",
            any(target_arch = "aarch64", target_arch = "x86_64")
        ),
    )))]
    {
        // 대상 플랫폼 밖: std 문구에서 ` (os error N)` 꼬리를 뗀다.
        let full = io::Error::from_raw_os_error(code).to_string();
        let tail = format!(" (os error {code})");
        full.strip_suffix(&tail).unwrap_or(&full).to_owned()
    }
}

/// Go `*os.PathError`: `op path: 문구`.
#[derive(Debug)]
pub struct GoPathError {
    pub op: String,
    pub path: String,
    pub err: io::Error,
}

/// Go `*os.LinkError`: `op old new: 문구`.
#[derive(Debug)]
pub struct GoLinkError {
    pub op: String,
    pub old: String,
    pub new: String,
    pub err: io::Error,
}

/// Go `*os.SyscallError`: `syscall: 문구`.
#[derive(Debug)]
pub struct GoSyscallError {
    pub syscall: String,
    pub err: io::Error,
}

impl fmt::Display for GoPathError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{} {}: {}",
            self.op,
            self.path,
            go_error_string(&self.err)
        )
    }
}

impl fmt::Display for GoLinkError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{} {} {}: {}",
            self.op,
            self.old,
            self.new,
            go_error_string(&self.err)
        )
    }
}

impl fmt::Display for GoSyscallError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.syscall, go_error_string(&self.err))
    }
}

impl std::error::Error for GoPathError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.err)
    }
}

impl std::error::Error for GoLinkError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.err)
    }
}

impl std::error::Error for GoSyscallError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.err)
    }
}

/// Go `&os.PathError{Op: op, Path: path, Err: err}` 를 담은 `io::Error`.
pub fn path_error(op: &str, path: &str, err: io::Error) -> io::Error {
    io::Error::new(
        err.kind(),
        GoPathError {
            op: op.to_owned(),
            path: path.to_owned(),
            err,
        },
    )
}

/// Go `&os.LinkError{Op: op, Old: old, New: new, Err: err}` 를 담은 `io::Error`.
pub fn link_error(op: &str, old: &str, new: &str, err: io::Error) -> io::Error {
    io::Error::new(
        err.kind(),
        GoLinkError {
            op: op.to_owned(),
            old: old.to_owned(),
            new: new.to_owned(),
            err,
        },
    )
}

/// Go `os.NewSyscallError(syscall, err)` 를 담은 `io::Error`.
pub fn syscall_error(syscall: &str, err: io::Error) -> io::Error {
    io::Error::new(
        err.kind(),
        GoSyscallError {
            syscall: syscall.to_owned(),
            err,
        },
    )
}

/// 안쪽 원인. Go 오류 타입으로 감쌌으면 감싼 오류를 돌려준다.
fn inner(e: &io::Error) -> Option<&io::Error> {
    let r = e.get_ref()?;
    if let Some(p) = r.downcast_ref::<GoPathError>() {
        return Some(&p.err);
    }
    if let Some(l) = r.downcast_ref::<GoLinkError>() {
        return Some(&l.err);
    }
    r.downcast_ref::<GoSyscallError>().map(|s| &s.err)
}

/// 원래 errno. [`path_error`] 등으로 감싼 `io::Error` 도 안쪽까지 따라간다.
pub fn raw_os_error(e: &io::Error) -> Option<i32> {
    if let Some(code) = e.raw_os_error() {
        return Some(code);
    }
    inner(e).and_then(raw_os_error)
}

/// Go `err.Error()` 와 같은 문구. errno 면 Go 의 errno 문구, Go 오류 타입이면 그 형식,
/// 그 밖에는 `Display` 그대로다.
pub fn go_error_string(e: &io::Error) -> String {
    if let Some(code) = e.raw_os_error() {
        return errno_string(code);
    }
    match e.get_ref() {
        Some(inner) => inner.to_string(),
        None => e.to_string(),
    }
}

#[cfg(test)]
mod tests;
