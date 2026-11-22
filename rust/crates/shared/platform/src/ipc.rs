//! dongminal(웹서버) ↔ dongminald(데몬) 사이의 로컬 전송 (FR-XIP-1). 로컬 전용이다.
//!
//! 유닉스 도메인 소켓이다. Windows 도 AF_UNIX 를 쓴다 — Windows 10 1803 부터 있고, 이 트랙의
//! 최소 버전은 ConPTY 때문에 1809 다 (C-1). std 가 Windows AF_UNIX 를 내지 않으므로 직접 부른다.
//!
//! 오류 문구는 Go `*net.OpError` 와 같다: `dial unix <경로>: connect: <errno>`,
//! `read unix ->/경로: i/o timeout` 처럼.

#[cfg(unix)]
#[path = "ipc/sys_unix.rs"]
mod sys;
#[cfg(windows)]
#[path = "ipc/sys_windows.rs"]
mod sys;

use std::fs;
use std::io::{self, Read, Write};
use std::net::Shutdown;
use std::path::{Path, PathBuf};
use std::time::Duration;

use dm_gocompat::oserr::{path_error, raw_os_error, syscall_error};

/// 종단 파일의 이름. 홈 안의 다른 파일들과 함께 쓰이므로 내보낸다.
pub const SOCKET_FILE_NAME: &str = "paned.sock";

/// 종단 파일의 모드 (04-secops P1-6).
const SOCKET_MODE: u32 = 0o600;

/// 로컬 전송.
pub trait Ipc: Send + Sync {
    /// home 에 대응하는 종단 주소.
    fn endpoint(&self, home: &Path) -> PathBuf;
    fn listen(&self, endpoint: &Path) -> io::Result<IpcListener>;
    /// timeout 이 0 이면 기다림에 끝이 없다 (Go `net.DialTimeout`).
    fn dial(&self, endpoint: &Path, timeout: Duration) -> io::Result<IpcStream>;
    /// 종단이 놓여 있는지. **살아 있는지가 아니다** — 살아 있는지는 호출자가 dial 로 확인한다.
    /// 이 둘을 섞으면 죽은 종단을 치우지 못한다.
    fn exists(&self, endpoint: &Path) -> bool;
    /// 잔여 종단을 치운다. 없는 종단을 지우는 것은 오류가 아니다.
    fn remove(&self, endpoint: &Path) -> io::Result<()>;
}

/// 받는 쪽 종단. Drop 하면 소켓 파일을 지운다 (Go `UnixListener.Close` 의 unlink).
#[derive(Debug)]
pub struct IpcListener {
    sock: sys::Socket,
    /// getsockname 이 돌려준 이름. 오류 문구와 unlink 에 쓴다.
    local: Option<String>,
    path: PathBuf,
}

/// 연결 하나. `&IpcStream` 도 Read·Write 이므로 읽는 스레드와 쓰는 스레드가 나눠 쓸 수 있다.
#[derive(Debug)]
pub struct IpcStream {
    sock: sys::Socket,
    local: Option<String>,
    peer: Option<String>,
}

/// home 의 IPC 종단과 같은 폴더(0700)에 사는 소켓 name 의 경로.
pub fn sibling_socket(home: &Path, name: &str) -> PathBuf {
    crate::atomic::parent_dir(&crate::current().ipc.endpoint(home)).join(name)
}

/// Go `*net.OpError{Op, Net: "unix", Source, Addr, Err}` 문구를 담는다.
fn op_error(op: &str, source: Option<&str>, addr: Option<&str>, err: io::Error) -> io::Error {
    let head = format!("{op} unix");
    match (source, addr) {
        (Some(s), Some(a)) => path_error(&head, &format!("{s}->{a}"), err),
        (Some(n), None) | (None, Some(n)) => path_error(&head, n, err),
        (None, None) => syscall_error(&head, err),
    }
}

/// errno 이면 Go `wrapSyscallError(call, err)` 처럼 감싼다. 시간 초과는 그대로 둔다.
fn wrap_syscall(call: &str, err: io::Error) -> io::Error {
    if raw_os_error(&err).is_some() {
        syscall_error(call, err)
    } else {
        err
    }
}

/// Go `os.ErrDeadlineExceeded`.
pub(crate) fn timeout_error() -> io::Error {
    io::Error::new(io::ErrorKind::TimedOut, "i/o timeout")
}

fn path_str(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

impl IpcListener {
    /// 연결 하나를 받는다.
    pub fn accept(&self) -> io::Result<IpcStream> {
        match self.sock.accept() {
            Ok((sock, peer)) => {
                let local = sock.local_name();
                Ok(IpcStream { sock, local, peer })
            }
            Err(e) => Err(op_error(
                "accept",
                None,
                self.local.as_deref(),
                wrap_syscall(sys::ACCEPT_CALL, e),
            )),
        }
    }
}

impl Drop for IpcListener {
    fn drop(&mut self) {
        let unlink = match &self.local {
            Some(n) if n.starts_with('@') => None,
            Some(n) => Some(PathBuf::from(n)),
            None => Some(self.path.clone()),
        };
        if let Some(p) = unlink {
            let _ = fs::remove_file(p);
        }
    }
}

impl IpcStream {
    /// 읽기 시간 제한. `None` 이면 끝없이 기다린다. 넘기면 `ErrorKind::TimedOut`.
    pub fn set_read_timeout(&self, d: Option<Duration>) -> io::Result<()> {
        self.sock.set_timeout(sys::Dir::Read, d)
    }

    /// 쓰기 시간 제한. `None` 이면 끝없이 기다린다. 넘기면 `ErrorKind::TimedOut`.
    pub fn set_write_timeout(&self, d: Option<Duration>) -> io::Result<()> {
        self.sock.set_timeout(sys::Dir::Write, d)
    }

    /// 읽기·쓰기 방향을 닫는다. 다른 스레드에서 막혀 있는 read 를 깨운다.
    pub fn shutdown(&self, how: Shutdown) -> io::Result<()> {
        self.sock
            .shutdown(how)
            .map_err(|e| self.op_err("close", wrap_syscall("shutdown", e)))
    }

    /// std 의 소켓으로 바꾼다. `tokio::net::UnixStream::from_std` 에 넘길 수 있다 (FR-RSP-33).
    /// 바꾼 뒤의 오류 문구는 Go 모양이 아니다.
    #[cfg(unix)]
    pub fn into_std(self) -> std::os::unix::net::UnixStream {
        self.sock.into_std()
    }

    fn op_err(&self, op: &str, e: io::Error) -> io::Error {
        op_error(op, self.local.as_deref(), self.peer.as_deref(), e)
    }

    fn do_read(&self, buf: &mut [u8]) -> io::Result<usize> {
        self.sock
            .read(buf)
            .map_err(|e| self.op_err("read", wrap_syscall(sys::READ_CALL, e)))
    }

    fn do_write(&self, buf: &[u8]) -> io::Result<usize> {
        self.sock
            .write(buf)
            .map_err(|e| self.op_err("write", wrap_syscall(sys::WRITE_CALL, e)))
    }
}

impl Read for IpcStream {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        self.do_read(buf)
    }
}

impl Read for &IpcStream {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        self.do_read(buf)
    }
}

impl Write for IpcStream {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.do_write(buf)
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl Write for &IpcStream {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.do_write(buf)
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[cfg(unix)]
mod raw_unix {
    use std::os::fd::{AsFd, AsRawFd, BorrowedFd, RawFd};

    impl AsFd for super::IpcStream {
        fn as_fd(&self) -> BorrowedFd<'_> {
            self.sock.as_fd()
        }
    }
    impl AsRawFd for super::IpcStream {
        fn as_raw_fd(&self) -> RawFd {
            self.sock.as_fd().as_raw_fd()
        }
    }
    impl AsFd for super::IpcListener {
        fn as_fd(&self) -> BorrowedFd<'_> {
            self.sock.as_fd()
        }
    }
    impl AsRawFd for super::IpcListener {
        fn as_raw_fd(&self) -> RawFd {
            self.sock.as_fd().as_raw_fd()
        }
    }
}

#[cfg(windows)]
mod raw_windows {
    use std::os::windows::io::{AsRawSocket, RawSocket};

    impl AsRawSocket for super::IpcStream {
        fn as_raw_socket(&self) -> RawSocket {
            self.sock.raw()
        }
    }
    impl AsRawSocket for super::IpcListener {
        fn as_raw_socket(&self) -> RawSocket {
            self.sock.raw()
        }
    }
}

/// 유닉스 도메인 소켓 종단. 판정 하나만 OS 에 따라 갈린다.
struct UnixSocketIpc {
    /// 경로에 종단이 놓여 있는지. POSIX 는 소켓 비트를 보지만 Windows 의 AF_UNIX 종단은
    /// 재분석 지점으로 나타나 그 비트가 서지 않는다.
    is_endpoint: fn(&Path) -> bool,
}

impl Ipc for UnixSocketIpc {
    fn endpoint(&self, home: &Path) -> PathBuf {
        home.join(SOCKET_FILE_NAME)
    }

    fn listen(&self, endpoint: &Path) -> io::Result<IpcListener> {
        let name = path_str(endpoint);
        let sock =
            sys::Socket::listen(endpoint).map_err(|e| op_error("listen", None, Some(&name), e))?;
        let ln = IpcListener {
            local: sock.local_name(),
            sock,
            path: endpoint.to_path_buf(),
        };
        // 04-secops P1-6: 소켓을 0600 으로 못박는다. umask 가 정한 모드(흔히 0755)면 같은 호스트의
        // 다른 UID 가 붙을 수 있고, 인증 없는 데몬 IPC 에서 그것은 사용자의 PTY 전부다. 만든 뒤에
        // 거는 경합은 소켓이 사는 0700 디렉터리가 막는다.
        if let Err(e) = sys::chmod(endpoint, SOCKET_MODE) {
            drop(ln);
            return Err(path_error("chmod", &name, e));
        }
        // FR-RSP-6: Windows 의 chmod 는 읽기 전용 속성뿐이라 다른 사용자를 막지 못한다(Go 기준선의
        // 약점). 소유자 전용 DACL 로 막는다. POSIX 는 할 일이 없다.
        if let Err(e) = sys::restrict_to_owner(endpoint) {
            drop(ln);
            return Err(path_error("setsecurityinfo", &name, e));
        }
        Ok(ln)
    }

    fn dial(&self, endpoint: &Path, timeout: Duration) -> io::Result<IpcStream> {
        match sys::Socket::connect(endpoint, timeout) {
            Ok(sock) => Ok(IpcStream {
                local: sock.local_name(),
                peer: sock.peer_name().or_else(|| Some(path_str(endpoint))),
                sock,
            }),
            Err(e) => Err(op_error("dial", None, Some(&path_str(endpoint)), e)),
        }
    }

    fn exists(&self, endpoint: &Path) -> bool {
        (self.is_endpoint)(endpoint)
    }

    fn remove(&self, endpoint: &Path) -> io::Result<()> {
        match sys::remove(endpoint) {
            Ok(()) => Ok(()),
            Err(e) if sys::is_not_exist(&e) => Ok(()),
            Err(e) => Err(path_error("remove", &path_str(endpoint), e)),
        }
    }
}

/// 소유자 전용 DACL 의 SDDL. 상속을 끊고(`P`) 그 사용자와 SYSTEM 에만 모든 권한(`FA`)을 준다.
#[cfg_attr(not(windows), allow(dead_code))]
fn owner_only_sddl(user_sid: &str) -> String {
    format!("D:P(A;;FA;;;{user_sid})(A;;FA;;;SY)")
}

/// 소켓 비트를 본다 — 종전 cli/proc.go 의 판정과 같다. 심볼릭 링크는 따라간다 (Go `os.Stat`).
fn posix_is_endpoint(p: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::FileTypeExt;
        fs::metadata(p).is_ok_and(|m| m.file_type().is_socket())
    }
    #[cfg(not(unix))]
    {
        let _ = p;
        false
    }
}

/// 존재만으로 판정한다. Windows 의 AF_UNIX 종단에는 소켓 비트가 없다. std 의 metadata 는
/// 재분석 지점을 따라가려다 AF_UNIX 종단에서 실패하므로, 링크가 아닌 재분석 지점은 lstat 으로 본다
/// (Go `os.Stat` 도 이름 대리가 아닌 재분석 지점은 따라가지 않는다).
fn windows_is_endpoint(p: &Path) -> bool {
    fs::metadata(p).is_ok() || fs::symlink_metadata(p).is_ok_and(|m| !m.file_type().is_symlink())
}

static CURRENT: UnixSocketIpc = UnixSocketIpc {
    is_endpoint: if cfg!(windows) {
        windows_is_endpoint
    } else {
        posix_is_endpoint
    },
};

pub(crate) fn current() -> &'static dyn Ipc {
    &CURRENT
}

#[cfg(test)]
mod tests;
