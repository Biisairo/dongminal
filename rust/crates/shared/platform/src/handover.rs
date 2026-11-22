//! 데몬 교체(세션 유지 재시작)의 OS 쪽 (DAEMON_SESSION_KEEP_SRS FR-DSK-13·21·26·27).
//! POSIX 만 터미널을 넘긴다 (D-DSK-7). Windows 의 함수는 Go 와 같이 빈 답이나 오류다.

use std::collections::{HashMap, HashSet};
use std::fmt;
use std::io;

use crate::pty::Terminal;

/// 데몬 교체에 터미널이 내놓는 능력.
pub trait Handover: Send + Sync {
    /// 읽기를 멈춘다. 그 뒤 read 는 바이트를 가져가지 않고 [`Frozen`] 을 감싼 오류다.
    /// 그동안의 출력은 커널 버퍼에 남는다 (NFR-DSK-2). 기다리던 read 가 물러설 때까지 돌아오지 않는다.
    fn freeze(&self);
    /// freeze 를 되돌린다.
    fn thaw(&self);
    /// 의사 터미널 마스터 쪽 fd. exec 로 넘길 때 쓴다.
    fn master_fd(&self) -> usize;
}

/// freeze 된 터미널의 read 오류. 끝이 아니다 — thaw 뒤에 다시 읽는다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Frozen;

impl fmt::Display for Frozen {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("터미널 읽기가 멈춰 있다")
    }
}

impl std::error::Error for Frozen {}

/// 오류가 [`Frozen`] 인지.
pub fn is_frozen(e: &io::Error) -> bool {
    e.get_ref().is_some_and(|inner| inner.is::<Frozen>())
}

/// 직계 자식 하나와 그 제어 단말. tty 는 `/dev/` 를 뗀 이름이다.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChildTty {
    pub pid: i32,
    pub tty: String,
}

/// 넘겨받은 마스터 fd 와 셸 pid 로 터미널을 다시 만든다 (FR-DSK-21).
pub fn adopt_terminal(fd: usize, pid: i32) -> io::Result<Box<dyn Terminal>> {
    #[cfg(unix)]
    {
        crate::pty::posix::adopt_terminal(fd, pid)
    }
    #[cfg(windows)]
    {
        let _ = (fd, pid);
        Err(io::Error::other("Windows 는 터미널을 넘겨받지 못한다"))
    }
}

/// ps 의 단말 표기를 ptsname 의 꼴(`/dev` 를 뗀 것)에 맞춘다. macOS ps 는 `s012` 처럼 `tty` 를 뗀다.
#[cfg_attr(windows, allow(dead_code))]
fn normalize_tty(s: &str) -> String {
    let s = s.strip_prefix("/dev/").unwrap_or(s);
    if let Some(num) = s.strip_prefix('s')
        && num.parse::<i64>().is_ok()
    {
        return format!("tty{s}");
    }
    s.to_owned()
}

/// `ps -ax -o pid=,ppid=,tty=` 에서 ppid 의 직계 자식 중 단말이 있는 것. pid 순이다.
#[cfg_attr(windows, allow(dead_code))]
fn parse_child_ttys(out: &str, ppid: i32) -> Vec<ChildTty> {
    let mut kids: Vec<ChildTty> = out
        .lines()
        .filter_map(|line| {
            let f: Vec<&str> = line.split_whitespace().collect();
            if f.len() < 3 {
                return None;
            }
            let pid: i32 = f[0].parse().ok()?;
            let parent: i32 = f[1].parse().ok()?;
            if parent != ppid || f[2] == "??" || f[2] == "?" {
                return None;
            }
            Some(ChildTty {
                pid,
                tty: normalize_tty(f[2]),
            })
        })
        .collect();
    kids.sort_by_key(|k| k.pid);
    kids
}

#[cfg(unix)]
mod sys {
    use super::*;
    use std::os::fd::RawFd;

    #[cfg(target_os = "linux")]
    const FD_DIR: &str = "/proc/self/fd";
    #[cfg(not(target_os = "linux"))]
    const FD_DIR: &str = "/dev/fd";

    /// 이 프로세스의 열린 fd. 이름만 읽는다.
    fn open_fds() -> io::Result<Vec<RawFd>> {
        let mut fds = Vec::new();
        for e in std::fs::read_dir(FD_DIR)? {
            if let Ok(n) = e?.file_name().to_string_lossy().parse::<RawFd>() {
                fds.push(n);
            }
        }
        Ok(fds)
    }

    /// PTY 마스터 fd 의 짝 단말 경로. 마스터가 아니면 None.
    #[cfg(target_os = "linux")]
    fn pts_name(fd: RawFd) -> Option<String> {
        let mut n: libc::c_int = 0;
        // SAFETY: n 은 쓰기 가능한 정수다.
        if unsafe { libc::ioctl(fd, libc::TIOCGPTN, &mut n) } == -1 {
            return None;
        }
        Some(format!("/dev/pts/{n}"))
    }

    #[cfg(not(target_os = "linux"))]
    fn pts_name(fd: RawFd) -> Option<String> {
        let mut buf = [0u8; 128];
        // SAFETY: TIOCPTYGNAME 은 128 바이트 버퍼에 NUL 종료 이름을 쓴다.
        if unsafe { libc::ioctl(fd, libc::TIOCPTYGNAME as _, buf.as_mut_ptr()) } == -1 {
            return None;
        }
        let end = buf.iter().rposition(|&b| b != 0).map_or(0, |i| i + 1);
        Some(String::from_utf8_lossy(&buf[..end]).into_owned())
    }

    pub(super) fn pty_masters(skip: &HashSet<usize>) -> io::Result<HashMap<String, usize>> {
        let mut out = HashMap::new();
        for fd in open_fds()? {
            let u = fd.unsigned_abs() as usize;
            if fd <= 2 || skip.contains(&u) {
                continue;
            }
            if let Some(name) = pts_name(fd) {
                out.insert(name.strip_prefix("/dev/").unwrap_or(&name).to_owned(), u);
            }
        }
        Ok(out)
    }

    pub(super) fn child_ttys(ppid: i32) -> io::Result<Vec<ChildTty>> {
        let out = std::process::Command::new("ps")
            .args(["-ax", "-o", "pid=,ppid=,tty="])
            .stdin(std::process::Stdio::null())
            .output()?;
        if !out.status.success() {
            return Err(io::Error::other(match out.status.code() {
                Some(c) => format!("exit status {c}"),
                None => "signal: killed".to_owned(),
            }));
        }
        Ok(parse_child_ttys(
            &String::from_utf8_lossy(&out.stdout),
            ppid,
        ))
    }

    pub(super) fn command_name(pid: i32) -> String {
        let out = std::process::Command::new("ps")
            .args(["-o", "comm=", "-p", &pid.to_string()])
            .stdin(std::process::Stdio::null())
            .output();
        match out {
            Ok(o) if o.status.success() => {
                let s = String::from_utf8_lossy(&o.stdout).trim().to_owned();
                if s.is_empty() {
                    return "shell".to_owned();
                }
                std::path::Path::new(&s)
                    .file_name()
                    .map_or(s.clone(), |n| n.to_string_lossy().into_owned())
            }
            _ => "shell".to_owned(),
        }
    }

    /// AF_UNIX 소켓이 묶인 경로. Go `unix.Getsockname` 의 `SockaddrUnix.Name` 과 같다.
    fn unix_sock_name(fd: RawFd) -> Option<String> {
        // SAFETY: 0 으로 채운 sockaddr_un 은 유효한 값이다.
        let mut sa: libc::sockaddr_un = unsafe { std::mem::zeroed() };
        let mut len = std::mem::size_of::<libc::sockaddr_un>() as libc::socklen_t;
        // SAFETY: sa 와 len 은 쓰기 가능하고 len 은 sa 의 크기다.
        if unsafe { libc::getsockname(fd, (&raw mut sa).cast(), &mut len) } == -1 {
            return None;
        }
        if i32::from(sa.sun_family) != libc::AF_UNIX {
            return None;
        }
        let path: Vec<u8> = sa.sun_path.iter().map(|&c| c.to_ne_bytes()[0]).collect();
        let max = (len as usize)
            .saturating_sub(std::mem::offset_of!(libc::sockaddr_un, sun_path))
            .min(path.len());
        let raw = &path[..max];
        if cfg!(target_os = "linux") && raw.first() == Some(&0) && raw.len() > 1 {
            // 추상 소켓은 '@' 로 시작하게 적는다(Go 와 같다).
            return Some(format!("@{}", String::from_utf8_lossy(&raw[1..])));
        }
        let end = raw.iter().position(|&b| b == 0).unwrap_or(raw.len());
        Some(String::from_utf8_lossy(&raw[..end]).into_owned())
    }

    pub(super) fn close_sockets_bound_to(paths: &[&str]) -> usize {
        let want: HashSet<&str> = paths.iter().copied().collect();
        let Ok(fds) = open_fds() else {
            return 0;
        };
        let mut closed = 0;
        for fd in fds {
            if fd <= 2 {
                continue;
            }
            if unix_sock_name(fd).is_some_and(|n| want.contains(n.as_str()))
                // SAFETY: 이 경로에 묶인 소켓 fd 를 닫으라는 것이 이 함수의 계약이다.
                && unsafe { libc::close(fd) } == 0
            {
                closed += 1;
            }
        }
        closed
    }

    pub(super) fn set_close_on_exec(fd: usize, on: bool) -> io::Result<()> {
        let fd = RawFd::try_from(fd).map_err(|_| io::Error::from_raw_os_error(libc::EBADF))?;
        crate::pty::posix::set_cloexec(fd, on)
    }
}

/// 이 프로세스가 쥔 PTY 마스터 fd 를 짝 단말 이름(`/dev` 를 뗀 것)으로 묶는다. skip 의 fd 는 뺀다.
pub fn pty_masters(skip: &HashSet<usize>) -> io::Result<HashMap<String, usize>> {
    #[cfg(unix)]
    {
        sys::pty_masters(skip)
    }
    #[cfg(windows)]
    {
        let _ = skip;
        Ok(HashMap::new())
    }
}

/// ppid 의 직계 자식과 그 제어 단말. 단말이 없는 자식은 뺀다. pid 순이다.
pub fn child_ttys(ppid: i32) -> io::Result<Vec<ChildTty>> {
    #[cfg(unix)]
    {
        sys::child_ttys(ppid)
    }
    #[cfg(windows)]
    {
        let _ = ppid;
        Ok(Vec::new())
    }
}

/// pid 의 실행 파일 이름. 모르면 "shell" 이다.
pub fn command_name(pid: i32) -> String {
    #[cfg(unix)]
    {
        sys::command_name(pid)
    }
    #[cfg(windows)]
    {
        let _ = pid;
        "shell".to_owned()
    }
}

/// paths 에 묶인 유닉스 소켓 fd 를 모두 닫고 그 수를 돌려준다.
pub fn close_sockets_bound_to(paths: &[&str]) -> usize {
    #[cfg(unix)]
    {
        sys::close_sockets_bound_to(paths)
    }
    #[cfg(windows)]
    {
        let _ = paths;
        0
    }
}

/// fd 의 close-on-exec 표시를 세우거나 지운다.
pub fn set_close_on_exec(fd: usize, on: bool) -> io::Result<()> {
    #[cfg(unix)]
    {
        sys::set_close_on_exec(fd, on)
    }
    #[cfg(windows)]
    {
        let _ = (fd, on);
        Err(io::Error::other("지원하지 않는다"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frozen_roundtrip() {
        let e = io::Error::other(Frozen);
        assert!(is_frozen(&e));
        assert_eq!(e.to_string(), "터미널 읽기가 멈춰 있다");
        assert!(!is_frozen(&io::Error::other("x")));
    }

    #[test]
    fn normalize() {
        assert_eq!(normalize_tty("s012"), "ttys012");
        assert_eq!(normalize_tty("/dev/ttys003"), "ttys003");
        assert_eq!(normalize_tty("pts/4"), "pts/4");
        assert_eq!(normalize_tty("sx"), "sx");
    }

    #[test]
    fn child_ttys_parse() {
        let out = "  300   100 s012\n  200   100 ttys003\n  250   100 ??\n  260   999 s001\n  270   100 ?\n bad\n";
        assert_eq!(
            parse_child_ttys(out, 100),
            vec![
                ChildTty {
                    pid: 200,
                    tty: "ttys003".into()
                },
                ChildTty {
                    pid: 300,
                    tty: "ttys012".into()
                },
            ]
        );
    }

    #[cfg(unix)]
    #[test]
    fn real_pty_masters_and_child_ttys() {
        use crate::pty::{ProcSpec, Pty};
        let t = crate::pty::posix::PosixPty
            .start(
                ProcSpec {
                    path: "/bin/sh".into(),
                    args: vec!["sh".into(), "-c".into(), "sleep 30".into()],
                    env: vec![],
                    dir: String::new(),
                },
                80,
                24,
            )
            .unwrap();
        let master = t.handover().unwrap().master_fd();
        let masters = pty_masters(&HashSet::new()).unwrap();
        let tty = masters
            .iter()
            .find(|(_, fd)| **fd == master)
            .map(|(name, _)| name.clone())
            .expect("마스터 fd 를 찾지 못했다");
        assert!(
            !pty_masters(&HashSet::from([master]))
                .unwrap()
                .values()
                .any(|&fd| fd == master)
        );
        let me = i32::try_from(std::process::id()).unwrap();
        let kids = child_ttys(me).unwrap();
        assert!(
            kids.iter().any(|k| k.pid == t.pid() && k.tty == tty),
            "자식 {} 의 단말 {tty} 가 없다: {kids:?}",
            t.pid()
        );
        assert_eq!(command_name(t.pid()), "sleep"); // sh -c 가 sleep 으로 exec 한다
        assert_eq!(command_name(-5), "shell");
        let _ = t.kill();
        let _ = t.wait();
    }

    #[cfg(unix)]
    #[test]
    fn real_close_sockets_and_cloexec() {
        use std::os::fd::AsRawFd;
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("s.sock");
        let l = std::os::unix::net::UnixListener::bind(&p).unwrap();
        let fd = l.as_raw_fd().unsigned_abs() as usize;
        set_close_on_exec(fd, false).unwrap();
        // SAFETY: F_GETFD 는 정수만 다룬다.
        let flags = unsafe { libc::fcntl(l.as_raw_fd(), libc::F_GETFD) };
        assert_eq!(flags & libc::FD_CLOEXEC, 0);
        set_close_on_exec(fd, true).unwrap();
        let path = p.to_str().unwrap();
        assert_eq!(close_sockets_bound_to(&[path]), 1);
        std::mem::forget(l); // 이미 닫았다.
        assert_eq!(close_sockets_bound_to(&[path]), 0);
    }
}
