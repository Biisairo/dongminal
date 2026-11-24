//! POSIX 유닉스 도메인 소켓. Go `net` 의 unix 경로와 같은 시스템 호출 순서·오류 이름을 쓴다.

use std::io;
use std::mem;
use std::net::Shutdown;
use std::os::fd::{AsFd, AsRawFd, BorrowedFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::ffi::OsStrExt;
use std::path::Path;
use std::time::{Duration, Instant};

use otter_gocompat::oserr::syscall_error;

#[cfg(target_os = "linux")]
pub(super) const ACCEPT_CALL: &str = "accept4";
#[cfg(not(target_os = "linux"))]
pub(super) const ACCEPT_CALL: &str = "accept";
pub(super) const READ_CALL: &str = "read";
pub(super) const WRITE_CALL: &str = "write";

/// Go `syscall.SOMAXCONN`.
const SOMAXCONN: i32 = 0x80;
/// Go 가 backlog 를 자르는 상한 (uint16).
#[cfg(not(target_os = "linux"))]
const MAX_BACKLOG_U16: u32 = (1 << 16) - 1;

pub(super) enum Dir {
    Read,
    Write,
}

#[derive(Debug)]
pub(super) struct Socket(OwnedFd);

fn last() -> io::Error {
    io::Error::last_os_error()
}

fn cvt(r: libc::c_int) -> io::Result<libc::c_int> {
    if r == -1 { Err(last()) } else { Ok(r) }
}

fn is_errno(e: &io::Error, codes: &[i32]) -> bool {
    e.raw_os_error().is_some_and(|c| codes.contains(&c))
}

/// CLOEXEC 를 건 새 스트림 소켓. darwin 은 SIGPIPE 대신 EPIPE 를 받게 한다.
fn new_socket() -> io::Result<OwnedFd> {
    #[cfg(target_os = "linux")]
    let ty = libc::SOCK_STREAM | libc::SOCK_CLOEXEC;
    #[cfg(not(target_os = "linux"))]
    let ty = libc::SOCK_STREAM;
    // SAFETY: 인자는 정수뿐이다.
    let fd = cvt(unsafe { libc::socket(libc::AF_UNIX, ty, 0) })
        .map_err(|e| syscall_error("socket", e))?;
    // SAFETY: socket 이 막 돌려준, 아무도 소유하지 않은 fd 다.
    let fd = unsafe { OwnedFd::from_raw_fd(fd) };
    prepare(fd.as_raw_fd())?;
    Ok(fd)
}

/// 새 fd(소켓·accept 결과)에 OS 별 기본 설정을 건다.
fn prepare(fd: RawFd) -> io::Result<()> {
    #[cfg(not(target_os = "linux"))]
    {
        // SAFETY: fd 는 호출자가 소유한 열린 fd 다.
        cvt(unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) })?;
    }
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        let one: libc::c_int = 1;
        // SAFETY: one 은 호출 동안 살아 있고 크기를 정확히 넘긴다.
        cvt(unsafe {
            libc::setsockopt(
                fd,
                libc::SOL_SOCKET,
                libc::SO_NOSIGPIPE,
                (&one as *const libc::c_int).cast(),
                mem::size_of::<libc::c_int>() as libc::socklen_t,
            )
        })?;
    }
    let _ = fd;
    Ok(())
}

fn set_nonblocking(fd: RawFd, on: bool) -> io::Result<()> {
    // SAFETY: fd 는 호출자가 소유한 열린 fd 다.
    let flags = cvt(unsafe { libc::fcntl(fd, libc::F_GETFL) })?;
    let flags = if on {
        flags | libc::O_NONBLOCK
    } else {
        flags & !libc::O_NONBLOCK
    };
    // SAFETY: 위와 같다.
    cvt(unsafe { libc::fcntl(fd, libc::F_SETFL, flags) })?;
    Ok(())
}

/// Go `(*SockaddrUnix).sockaddr` 의 길이 규칙. 어기면 EINVAL 이다.
fn sockaddr(path: &Path) -> io::Result<(libc::sockaddr_un, libc::socklen_t)> {
    let name = path.as_os_str().as_bytes();
    let n = name.len();
    // SAFETY: sockaddr_un 은 정수 배열 필드뿐이라 0 이 유효한 값이다.
    let mut sa: libc::sockaddr_un = unsafe { mem::zeroed() };
    let cap = sa.sun_path.len();
    let einval = || io::Error::from_raw_os_error(libc::EINVAL);
    #[cfg(target_os = "linux")]
    let len = {
        if n > cap {
            return Err(einval());
        }
        let abstract_ = n > 0 && (name[0] == b'@' || name[0] == 0);
        if n == cap && !abstract_ {
            return Err(einval());
        }
        for (d, s) in sa.sun_path.iter_mut().zip(name) {
            *d = *s as libc::c_char;
        }
        let mut sl = 2 + n;
        if abstract_ {
            sa.sun_path[0] = 0;
        } else if n > 0 {
            sl += 1;
        }
        sl
    };
    #[cfg(not(target_os = "linux"))]
    let len = {
        if n >= cap || n == 0 {
            return Err(einval());
        }
        for (d, s) in sa.sun_path.iter_mut().zip(name) {
            *d = *s as libc::c_char;
        }
        sa.sun_len = (3 + n) as u8;
        3 + n
    };
    sa.sun_family = libc::AF_UNIX as libc::sa_family_t;
    Ok((sa, len as libc::socklen_t))
}

/// Go `anyToSockaddr` 의 AF_UNIX 해석. 해석하지 못하면 `None`(Go 의 nil 주소)이다.
fn parse_name(sa: &libc::sockaddr_un) -> Option<String> {
    if sa.sun_family as i32 != libc::AF_UNIX {
        return None;
    }
    // c_char 는 대상에 따라 i8·u8 이다.
    #[allow(clippy::unnecessary_cast)]
    let path: Vec<u8> = sa.sun_path.iter().map(|&c| c as u8).collect();
    #[cfg(target_os = "linux")]
    let bytes = {
        let mut path = path;
        if path[0] == 0 {
            path[0] = b'@';
        }
        let n = path.iter().position(|&b| b == 0).unwrap_or(path.len());
        path.truncate(n);
        path
    };
    #[cfg(not(target_os = "linux"))]
    let bytes = {
        let l = sa.sun_len as usize;
        if l < 2 || l > mem::size_of::<libc::sockaddr_un>() {
            return None;
        }
        let n = (l - 2).min(path.len());
        let n = path[..n].iter().position(|&b| b == 0).unwrap_or(n);
        path[..n].to_vec()
    };
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

type NameFn =
    unsafe extern "C" fn(libc::c_int, *mut libc::sockaddr, *mut libc::socklen_t) -> libc::c_int;

fn sock_name(fd: RawFd, f: NameFn) -> Option<String> {
    // SAFETY: 0 이 유효한 sockaddr_un 값이다.
    let mut sa: libc::sockaddr_un = unsafe { mem::zeroed() };
    let mut len = mem::size_of::<libc::sockaddr_un>() as libc::socklen_t;
    // SAFETY: sa 와 len 은 호출 동안 살아 있고, len 은 sa 의 크기다.
    let r = unsafe { f(fd, (&mut sa as *mut libc::sockaddr_un).cast(), &mut len) };
    if r == -1 {
        return None;
    }
    parse_name(&sa)
}

/// Go `maxListenerBacklog`.
#[cfg(target_os = "linux")]
fn max_listener_backlog() -> i32 {
    let Ok(s) = std::fs::read_to_string("/proc/sys/net/core/somaxconn") else {
        return SOMAXCONN;
    };
    let first = s.lines().next().unwrap_or("");
    let Some(field) = first.split_whitespace().next() else {
        return SOMAXCONN;
    };
    match field.parse::<u64>() {
        Ok(0) | Err(_) => SOMAXCONN,
        Ok(n) => i32::try_from(n).unwrap_or(i32::MAX),
    }
}

/// Go `maxListenerBacklog`.
#[cfg(not(target_os = "linux"))]
fn max_listener_backlog() -> i32 {
    let mut n: u32 = 0;
    let mut len = mem::size_of::<u32>();
    // SAFETY: 이름은 NUL 로 끝나고, n·len 은 호출 동안 살아 있으며 len 은 n 의 크기다.
    let r = unsafe {
        libc::sysctlbyname(
            c"kern.ipc.somaxconn".as_ptr(),
            (&mut n as *mut u32).cast(),
            &mut len,
            std::ptr::null_mut(),
            0,
        )
    };
    if r == -1 || n == 0 {
        return SOMAXCONN;
    }
    n.min(MAX_BACKLOG_U16) as i32
}

impl Socket {
    pub(super) fn listen(path: &Path) -> io::Result<Socket> {
        let fd = new_socket()?;
        let (sa, len) = sockaddr(path).map_err(|e| syscall_error("bind", e))?;
        // SAFETY: sa 는 len 바이트까지 유효한 sockaddr_un 이다.
        cvt(unsafe {
            libc::bind(
                fd.as_raw_fd(),
                (&sa as *const libc::sockaddr_un).cast(),
                len,
            )
        })
        .map_err(|e| syscall_error("bind", e))?;
        // SAFETY: 인자는 정수뿐이다.
        cvt(unsafe { libc::listen(fd.as_raw_fd(), max_listener_backlog()) })
            .map_err(|e| syscall_error("listen", e))?;
        Ok(Socket(fd))
    }

    /// Go `netFD.connect`: 논블로킹으로 걸고, 진행 중이면 쓰기 가능을 기다린다.
    pub(super) fn connect(path: &Path, timeout: Duration) -> io::Result<Socket> {
        let fd = new_socket()?;
        let raw = fd.as_raw_fd();
        let (sa, len) = sockaddr(path).map_err(|e| syscall_error("connect", e))?;
        set_nonblocking(raw, true).map_err(|e| syscall_error("setnonblock", e))?;
        let deadline = (!timeout.is_zero()).then(|| Instant::now() + timeout);
        // SAFETY: sa 는 len 바이트까지 유효한 sockaddr_un 이다.
        let r = unsafe { libc::connect(raw, (&sa as *const libc::sockaddr_un).cast(), len) };
        if r == -1 {
            let e = last();
            if !is_errno(&e, &[libc::EINPROGRESS, libc::EALREADY, libc::EINTR]) {
                return Err(syscall_error("connect", e));
            }
            wait_connected(raw, deadline)?;
        }
        set_nonblocking(raw, false).map_err(|e| syscall_error("setnonblock", e))?;
        Ok(Socket(fd))
    }

    pub(super) fn accept(&self) -> io::Result<(Socket, Option<String>)> {
        loop {
            // SAFETY: 0 이 유효한 sockaddr_un 값이다.
            let mut sa: libc::sockaddr_un = unsafe { mem::zeroed() };
            let mut len = mem::size_of::<libc::sockaddr_un>() as libc::socklen_t;
            let p = (&mut sa as *mut libc::sockaddr_un).cast();
            // SAFETY: sa·len 은 호출 동안 살아 있고, len 은 sa 의 크기다.
            #[cfg(target_os = "linux")]
            let r = unsafe { libc::accept4(self.raw(), p, &mut len, libc::SOCK_CLOEXEC) };
            // SAFETY: 위와 같다.
            #[cfg(not(target_os = "linux"))]
            let r = unsafe { libc::accept(self.raw(), p, &mut len) };
            if r == -1 {
                let e = last();
                if is_errno(&e, &[libc::EINTR, libc::ECONNABORTED]) {
                    continue;
                }
                return Err(e);
            }
            // SAFETY: accept 가 막 돌려준, 아무도 소유하지 않은 fd 다.
            let fd = unsafe { OwnedFd::from_raw_fd(r) };
            prepare(r)?;
            return Ok((Socket(fd), parse_name(&sa)));
        }
    }

    pub(super) fn read(&self, buf: &mut [u8]) -> io::Result<usize> {
        loop {
            // SAFETY: buf 는 len 바이트까지 쓸 수 있다.
            let n = unsafe { libc::read(self.raw(), buf.as_mut_ptr().cast(), buf.len()) };
            if n >= 0 {
                return Ok(n as usize);
            }
            let e = last();
            match e.kind() {
                io::ErrorKind::Interrupted => continue,
                io::ErrorKind::WouldBlock => return Err(super::timeout_error()),
                _ => return Err(e),
            }
        }
    }

    pub(super) fn write(&self, buf: &[u8]) -> io::Result<usize> {
        #[cfg(target_os = "linux")]
        let flags = libc::MSG_NOSIGNAL;
        #[cfg(not(target_os = "linux"))]
        let flags = 0;
        loop {
            // SAFETY: buf 는 len 바이트까지 읽을 수 있다.
            let n = unsafe { libc::send(self.raw(), buf.as_ptr().cast(), buf.len(), flags) };
            if n >= 0 {
                return Ok(n as usize);
            }
            let e = last();
            match e.kind() {
                io::ErrorKind::Interrupted => continue,
                io::ErrorKind::WouldBlock => return Err(super::timeout_error()),
                _ => return Err(e),
            }
        }
    }

    pub(super) fn set_timeout(&self, dir: Dir, d: Option<Duration>) -> io::Result<()> {
        let tv = match d {
            Some(d) if d.is_zero() => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "cannot set a 0 duration timeout",
                ));
            }
            Some(d) => {
                let mut tv = libc::timeval {
                    // time_t 는 지원 대상 모두 64비트다. 이름 대신 `as _` 로 libc 가 대상별 타입을 고른다.
                    tv_sec: d.as_secs().min(i64::MAX as u64) as _,
                    tv_usec: d.subsec_micros() as _,
                };
                if tv.tv_sec == 0 && tv.tv_usec == 0 {
                    tv.tv_usec = 1;
                }
                tv
            }
            None => libc::timeval {
                tv_sec: 0,
                tv_usec: 0,
            },
        };
        let opt = match dir {
            Dir::Read => libc::SO_RCVTIMEO,
            Dir::Write => libc::SO_SNDTIMEO,
        };
        // SAFETY: tv 는 호출 동안 살아 있고 크기를 정확히 넘긴다.
        cvt(unsafe {
            libc::setsockopt(
                self.raw(),
                libc::SOL_SOCKET,
                opt,
                (&tv as *const libc::timeval).cast(),
                mem::size_of::<libc::timeval>() as libc::socklen_t,
            )
        })?;
        Ok(())
    }

    pub(super) fn shutdown(&self, how: Shutdown) -> io::Result<()> {
        let how = match how {
            Shutdown::Read => libc::SHUT_RD,
            Shutdown::Write => libc::SHUT_WR,
            Shutdown::Both => libc::SHUT_RDWR,
        };
        // SAFETY: 인자는 정수뿐이다.
        cvt(unsafe { libc::shutdown(self.raw(), how) })?;
        Ok(())
    }

    /// 물려받은 fd 를 소유한다. AF_UNIX 스트림 소켓이 아니면 오류다(fd 는 닫지 않고 돌려준다).
    pub(super) fn from_inherited(fd: RawFd) -> io::Result<Socket> {
        let mut ty: libc::c_int = 0;
        let mut len = mem::size_of::<libc::c_int>() as libc::socklen_t;
        // SAFETY: ty·len 은 호출 동안 살아 있고, len 은 ty 의 크기다. 닫힌 fd 면 EBADF 다.
        cvt(unsafe {
            libc::getsockopt(
                fd,
                libc::SOL_SOCKET,
                libc::SO_TYPE,
                (&mut ty as *mut libc::c_int).cast(),
                &mut len,
            )
        })
        .map_err(|e| syscall_error("getsockopt", e))?;
        // SAFETY: 0 이 유효한 sockaddr_un 값이다.
        let mut sa: libc::sockaddr_un = unsafe { mem::zeroed() };
        let mut slen = mem::size_of::<libc::sockaddr_un>() as libc::socklen_t;
        // SAFETY: sa·slen 은 호출 동안 살아 있고, slen 은 sa 의 크기다.
        cvt(unsafe {
            libc::getsockname(fd, (&mut sa as *mut libc::sockaddr_un).cast(), &mut slen)
        })
        .map_err(|e| syscall_error("getsockname", e))?;
        if ty != libc::SOCK_STREAM || libc::c_int::from(sa.sun_family) != libc::AF_UNIX {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "file does not refer to a unix stream socket",
            ));
        }
        // SAFETY: 호출자 계약 — 물려받아 아무도 쥐지 않은 열린 fd 다(위의 getsockopt 가 열림을 확인했다).
        let fd = unsafe { OwnedFd::from_raw_fd(fd) };
        prepare(fd.as_raw_fd())?;
        Ok(Socket(fd))
    }

    /// close-on-exec 를 건 복제다.
    pub(super) fn try_clone_fd(&self) -> io::Result<OwnedFd> {
        // SAFETY: 인자는 정수뿐이고 self.raw() 는 열린 fd 다.
        let r = cvt(unsafe { libc::fcntl(self.raw(), libc::F_DUPFD_CLOEXEC, 0) })
            .map_err(|e| syscall_error("dup", e))?;
        // SAFETY: fcntl 이 막 돌려준, 아무도 소유하지 않은 fd 다.
        Ok(unsafe { OwnedFd::from_raw_fd(r) })
    }

    pub(super) fn local_name(&self) -> Option<String> {
        sock_name(self.raw(), libc::getsockname)
    }

    pub(super) fn peer_name(&self) -> Option<String> {
        sock_name(self.raw(), libc::getpeername)
    }

    pub(super) fn into_std(self) -> std::os::unix::net::UnixStream {
        std::os::unix::net::UnixStream::from(self.0)
    }

    pub(super) fn as_fd(&self) -> BorrowedFd<'_> {
        self.0.as_fd()
    }

    fn raw(&self) -> RawFd {
        self.0.as_raw_fd()
    }
}

/// 진행 중인 connect 를 deadline 까지 기다린다. 넘기면 Go 처럼 `i/o timeout` 이다.
fn wait_connected(fd: RawFd, deadline: Option<Instant>) -> io::Result<()> {
    loop {
        let ms = match deadline {
            None => -1,
            Some(t) => {
                let left = t.saturating_duration_since(Instant::now());
                if left.is_zero() {
                    return Err(super::timeout_error());
                }
                left.as_millis().clamp(1, i32::MAX as u128) as i32
            }
        };
        let mut pfd = libc::pollfd {
            fd,
            events: libc::POLLOUT,
            revents: 0,
        };
        // SAFETY: pfd 는 호출 동안 살아 있는 한 개짜리 배열이다.
        let r = unsafe { libc::poll(&mut pfd, 1, ms) };
        if r == -1 {
            let e = last();
            if e.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(syscall_error("connect", e));
        }
        if r == 0 {
            continue;
        }
        let mut err: libc::c_int = 0;
        let mut len = mem::size_of::<libc::c_int>() as libc::socklen_t;
        // SAFETY: err·len 은 호출 동안 살아 있고 len 은 err 의 크기다.
        cvt(unsafe {
            libc::getsockopt(
                fd,
                libc::SOL_SOCKET,
                libc::SO_ERROR,
                (&mut err as *mut libc::c_int).cast(),
                &mut len,
            )
        })
        .map_err(|e| syscall_error("getsockopt", e))?;
        match err {
            0 | libc::EISCONN => return Ok(()),
            libc::EINPROGRESS | libc::EALREADY | libc::EINTR => continue,
            e => return Err(syscall_error("connect", io::Error::from_raw_os_error(e))),
        }
    }
}

pub(super) fn chmod(path: &Path, mode: u32) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
}

/// Go `os.Remove`: unlink 하고, 안 되면 rmdir 한다. 둘 다 실패하면 rmdir 오류가 ENOTDIR 일 때만
/// unlink 오류를 고른다.
pub(super) fn remove(path: &Path) -> io::Result<()> {
    let e = match std::fs::remove_file(path) {
        Ok(()) => return Ok(()),
        Err(e) => e,
    };
    match std::fs::remove_dir(path) {
        Ok(()) => Ok(()),
        Err(e1) if e1.raw_os_error() == Some(libc::ENOTDIR) => Err(e),
        Err(e1) => Err(e1),
    }
}

/// Go `os.IsNotExist`.
pub(super) fn is_not_exist(e: &io::Error) -> bool {
    e.raw_os_error() == Some(libc::ENOENT)
}

/// POSIX 는 chmod 0600 과 0700 디렉터리가 막는다. 더 할 일이 없다.
pub(super) fn restrict_to_owner(_path: &Path) -> io::Result<()> {
    Ok(())
}
