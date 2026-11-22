//! Windows AF_UNIX (Windows 10 1803+). std 가 내지 않으므로 Winsock 을 직접 부른다.
//! 동기 API 다 (FR-RSP-33). 오류 이름은 Go `net` 의 Windows 경로(acceptex·wsarecv·wsasend)를 따른다.

use std::io;
use std::mem;
use std::net::Shutdown;
use std::os::windows::ffi::OsStrExt;
use std::path::Path;
use std::ptr;
use std::sync::OnceLock;
use std::time::Duration;

use dm_gocompat::oserr::syscall_error;
use windows_sys::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND, WIN32_ERROR};
use windows_sys::Win32::Networking::WinSock as ws;
use windows_sys::Win32::Storage::FileSystem::{
    DeleteFileW, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_READONLY, GetFileAttributesW,
    INVALID_FILE_ATTRIBUTES, RemoveDirectoryW, SetFileAttributesW,
};

pub(super) const ACCEPT_CALL: &str = "acceptex";
pub(super) const READ_CALL: &str = "wsarecv";
pub(super) const WRITE_CALL: &str = "wsasend";

/// Go `syscall.SOMAXCONN` (Windows). Winsock 이 "적당한 최대값" 으로 바꾼다.
const SOMAXCONN: i32 = 0x7fff_ffff;
/// Winsock 2.2.
const WINSOCK_VERSION: u16 = 0x0202;
/// Go `_ERROR_BAD_NETPATH` — `os.IsNotExist` 가 없다고 보는 코드 중 하나.
const ERROR_BAD_NETPATH: WIN32_ERROR = 53;
/// Go `syscall.S_IWRITE`.
const S_IWRITE: u32 = 0o200;

pub(super) enum Dir {
    Read,
    Write,
}

#[derive(Debug)]
pub(super) struct Socket(ws::SOCKET);

impl Drop for Socket {
    fn drop(&mut self) {
        // SAFETY: self.0 은 이 값만 소유한 열린 소켓이다.
        unsafe { ws::closesocket(self.0) };
    }
}

fn startup() {
    static STARTED: OnceLock<()> = OnceLock::new();
    STARTED.get_or_init(|| {
        // SAFETY: 0 이 유효한 WSADATA 값이고, data 는 호출 동안 살아 있다.
        let mut data: ws::WSADATA = unsafe { mem::zeroed() };
        // SAFETY: 위와 같다. 실패하면 뒤따르는 호출이 WSANOTINITIALISED 로 실패한다.
        unsafe { ws::WSAStartup(WINSOCK_VERSION, &mut data) };
    });
}

fn last() -> io::Error {
    // SAFETY: 인자가 없다.
    io::Error::from_raw_os_error(unsafe { ws::WSAGetLastError() })
}

fn cvt(r: i32) -> io::Result<i32> {
    if r == ws::SOCKET_ERROR {
        Err(last())
    } else {
        Ok(r)
    }
}

fn new_socket() -> io::Result<Socket> {
    startup();
    // SAFETY: 정수 인자와 null 프로토콜 정보만 넘긴다.
    let s = unsafe {
        ws::WSASocketW(
            i32::from(ws::AF_UNIX),
            ws::SOCK_STREAM,
            0,
            ptr::null(),
            0,
            ws::WSA_FLAG_NO_HANDLE_INHERIT,
        )
    };
    if s == ws::INVALID_SOCKET {
        return Err(syscall_error("socket", last()));
    }
    Ok(Socket(s))
}

/// Go `(*SockaddrUnix).sockaddr` (Windows) 의 길이 규칙. 경로는 UTF-8 바이트로 넣는다.
fn sockaddr(path: &Path) -> io::Result<(ws::SOCKADDR_UN, i32)> {
    let einval = || io::Error::from_raw_os_error(ws::WSAEINVAL);
    let name = path.to_str().ok_or_else(einval)?.as_bytes();
    let n = name.len();
    let mut sa = ws::SOCKADDR_UN {
        sun_family: ws::AF_UNIX,
        sun_path: [0; 108],
    };
    let cap = sa.sun_path.len();
    if n > cap {
        return Err(einval());
    }
    let abstract_ = n > 0 && (name[0] == b'@' || name[0] == 0);
    if n == cap && !abstract_ {
        return Err(einval());
    }
    for (d, s) in sa.sun_path.iter_mut().zip(name) {
        *d = *s as i8;
    }
    let mut sl = 2 + n;
    if abstract_ {
        sa.sun_path[0] = 0;
    } else if n > 0 {
        sl += 1;
    }
    Ok((sa, sl as i32))
}

/// Go `RawSockaddrAny.Sockaddr` 의 AF_UNIX 해석. 앞 NUL 은 `@` 로 보인다.
fn parse_name(sa: &ws::SOCKADDR_UN) -> Option<String> {
    if sa.sun_family != ws::AF_UNIX {
        return None;
    }
    let mut path: Vec<u8> = sa.sun_path.iter().map(|&c| c as u8).collect();
    if path[0] == 0 {
        path[0] = b'@';
    }
    let n = path.iter().position(|&b| b == 0).unwrap_or(path.len());
    path.truncate(n);
    Some(String::from_utf8_lossy(&path).into_owned())
}

type NameFn = unsafe extern "system" fn(ws::SOCKET, *mut ws::SOCKADDR, *mut i32) -> i32;

fn sock_name(s: ws::SOCKET, f: NameFn) -> Option<String> {
    let mut sa = ws::SOCKADDR_UN {
        sun_family: 0,
        sun_path: [0; 108],
    };
    let mut len = mem::size_of::<ws::SOCKADDR_UN>() as i32;
    // SAFETY: sa 와 len 은 호출 동안 살아 있고, len 은 sa 의 크기다.
    let r = unsafe { f(s, (&mut sa as *mut ws::SOCKADDR_UN).cast(), &mut len) };
    if r == ws::SOCKET_ERROR {
        return None;
    }
    parse_name(&sa)
}

impl Socket {
    pub(super) fn listen(path: &Path) -> io::Result<Socket> {
        let s = new_socket()?;
        let (sa, len) = sockaddr(path).map_err(|e| syscall_error("bind", e))?;
        // SAFETY: sa 는 len 바이트까지 유효한 SOCKADDR_UN 이다.
        cvt(unsafe { ws::bind(s.0, (&sa as *const ws::SOCKADDR_UN).cast(), len) })
            .map_err(|e| syscall_error("bind", e))?;
        // SAFETY: 인자는 정수뿐이다.
        cvt(unsafe { ws::listen(s.0, SOMAXCONN) }).map_err(|e| syscall_error("listen", e))?;
        Ok(s)
    }

    /// Go 는 unix 에 ConnectEx 를 쓰지 않고 블로킹 connect 를 부른다 — AF_UNIX connect 는 바로
    /// 끝나므로 timeout 이 쓰이지 않는다.
    pub(super) fn connect(path: &Path, _timeout: Duration) -> io::Result<Socket> {
        let s = new_socket()?;
        let (sa, len) = sockaddr(path).map_err(|e| syscall_error("connect", e))?;
        // SAFETY: sa 는 len 바이트까지 유효한 SOCKADDR_UN 이다.
        cvt(unsafe { ws::connect(s.0, (&sa as *const ws::SOCKADDR_UN).cast(), len) })
            .map_err(|e| syscall_error("connect", e))?;
        Ok(s)
    }

    pub(super) fn accept(&self) -> io::Result<(Socket, Option<String>)> {
        loop {
            let mut sa = ws::SOCKADDR_UN {
                sun_family: 0,
                sun_path: [0; 108],
            };
            let mut len = mem::size_of::<ws::SOCKADDR_UN>() as i32;
            // SAFETY: sa·len 은 호출 동안 살아 있고, len 은 sa 의 크기다.
            let s =
                unsafe { ws::accept(self.0, (&mut sa as *mut ws::SOCKADDR_UN).cast(), &mut len) };
            if s == ws::INVALID_SOCKET {
                let e = last();
                if e.raw_os_error() == Some(ws::WSAEINTR) {
                    continue;
                }
                return Err(e);
            }
            return Ok((Socket(s), parse_name(&sa)));
        }
    }

    pub(super) fn read(&self, buf: &mut [u8]) -> io::Result<usize> {
        let len = buf.len().min(i32::MAX as usize) as i32;
        // SAFETY: buf 는 len 바이트까지 쓸 수 있다.
        let n = unsafe { ws::recv(self.0, buf.as_mut_ptr(), len, 0) };
        if n == ws::SOCKET_ERROR {
            return Err(map_timeout(last()));
        }
        Ok(n as usize)
    }

    pub(super) fn write(&self, buf: &[u8]) -> io::Result<usize> {
        let len = buf.len().min(i32::MAX as usize) as i32;
        // SAFETY: buf 는 len 바이트까지 읽을 수 있다.
        let n = unsafe { ws::send(self.0, buf.as_ptr(), len, 0) };
        if n == ws::SOCKET_ERROR {
            return Err(map_timeout(last()));
        }
        Ok(n as usize)
    }

    pub(super) fn set_timeout(&self, dir: Dir, d: Option<Duration>) -> io::Result<()> {
        let ms: u32 = match d {
            Some(d) if d.is_zero() => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "cannot set a 0 duration timeout",
                ));
            }
            Some(d) => d.as_millis().clamp(1, u128::from(u32::MAX - 1)) as u32,
            None => 0,
        };
        let opt = match dir {
            Dir::Read => ws::SO_RCVTIMEO,
            Dir::Write => ws::SO_SNDTIMEO,
        };
        // SAFETY: ms 는 호출 동안 살아 있고 크기를 정확히 넘긴다.
        cvt(unsafe {
            ws::setsockopt(
                self.0,
                ws::SOL_SOCKET,
                opt,
                (&ms as *const u32).cast(),
                mem::size_of::<u32>() as i32,
            )
        })?;
        Ok(())
    }

    pub(super) fn shutdown(&self, how: Shutdown) -> io::Result<()> {
        let how = match how {
            Shutdown::Read => ws::SD_RECEIVE,
            Shutdown::Write => ws::SD_SEND,
            Shutdown::Both => ws::SD_BOTH,
        };
        // SAFETY: 인자는 정수뿐이다.
        cvt(unsafe { ws::shutdown(self.0, how) })?;
        Ok(())
    }

    pub(super) fn local_name(&self) -> Option<String> {
        sock_name(self.0, ws::getsockname)
    }

    pub(super) fn peer_name(&self) -> Option<String> {
        sock_name(self.0, ws::getpeername)
    }

    pub(super) fn raw(&self) -> std::os::windows::io::RawSocket {
        self.0 as std::os::windows::io::RawSocket
    }
}

fn map_timeout(e: io::Error) -> io::Error {
    if e.raw_os_error() == Some(ws::WSAETIMEDOUT) {
        super::timeout_error()
    } else {
        e
    }
}

fn wide(path: &Path) -> Vec<u16> {
    path.as_os_str().encode_wide().chain(Some(0)).collect()
}

fn last_os() -> io::Error {
    io::Error::last_os_error()
}

/// Go `syscall.Chmod` (Windows): 쓰기 비트에 따라 읽기 전용 속성만 바꾼다.
pub(super) fn chmod(path: &Path, mode: u32) -> io::Result<()> {
    let p = wide(path);
    // SAFETY: p 는 NUL 로 끝나는 UTF-16 이다.
    let attrs = unsafe { GetFileAttributesW(p.as_ptr()) };
    if attrs == INVALID_FILE_ATTRIBUTES {
        return Err(last_os());
    }
    let attrs = if mode & S_IWRITE != 0 {
        attrs & !FILE_ATTRIBUTE_READONLY
    } else {
        attrs | FILE_ATTRIBUTE_READONLY
    };
    // SAFETY: 위와 같다.
    if unsafe { SetFileAttributesW(p.as_ptr(), attrs) } == 0 {
        return Err(last_os());
    }
    Ok(())
}

/// Go `os.Remove` (Windows).
pub(super) fn remove(path: &Path) -> io::Result<()> {
    let p = wide(path);
    // SAFETY: p 는 NUL 로 끝나는 UTF-16 이다(아래 호출 모두 같다).
    if unsafe { DeleteFileW(p.as_ptr()) } != 0 {
        return Ok(());
    }
    let mut e = last_os();
    // SAFETY: 위와 같다.
    if unsafe { RemoveDirectoryW(p.as_ptr()) } != 0 {
        return Ok(());
    }
    let e1 = last_os();
    if e1.raw_os_error() != e.raw_os_error() {
        // SAFETY: 위와 같다.
        let a = unsafe { GetFileAttributesW(p.as_ptr()) };
        if a == INVALID_FILE_ATTRIBUTES {
            e = last_os();
        } else if a & FILE_ATTRIBUTE_DIRECTORY != 0 {
            e = e1;
        } else if a & FILE_ATTRIBUTE_READONLY != 0 {
            // SAFETY: 위와 같다.
            if unsafe { SetFileAttributesW(p.as_ptr(), a & !FILE_ATTRIBUTE_READONLY) } != 0 {
                // SAFETY: 위와 같다.
                if unsafe { DeleteFileW(p.as_ptr()) } != 0 {
                    return Ok(());
                }
                e = last_os();
            }
        }
    }
    Err(e)
}

/// Go `os.IsNotExist` (Windows).
pub(super) fn is_not_exist(e: &io::Error) -> bool {
    matches!(
        e.raw_os_error().map(|c| c as WIN32_ERROR),
        Some(ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND | ERROR_BAD_NETPATH)
    )
}
