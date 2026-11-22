//! POSIX 의사 터미널 — openpty 와 읽기 게이트 (DAEMON_SESSION_KEEP_SRS NFR-DSK-2).
//!
//! 자식은 새 세션의 리더가 되고 슬레이브를 제어 터미널로 삼는다(creack/pty 와 같다).
//! argv·환경은 자식에서 `execve` 로 직접 넘긴다 — std `Command::envs` 는 환경을 이름순으로
//! 정렬하므로, Go 가 넘기는 순서(중복 정리 뒤 원래 순서)를 지키려면 이 길뿐이다.

use std::ffi::CString;
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Condvar, Mutex, RwLock};

use dm_gocompat::oserr::{go_error_string, path_error};
use dm_gocompat::strconv::quote;

use super::{ProcSpec, Pty, Terminal, clamp_size, closed_error, dedup_env, env_key_as_is};
use crate::handover::{Frozen, Handover};

pub(crate) struct PosixPty;

fn errno() -> io::Error {
    io::Error::last_os_error()
}

fn cvt(r: libc::c_int) -> io::Result<libc::c_int> {
    if r == -1 { Err(errno()) } else { Ok(r) }
}

pub(crate) fn set_cloexec(fd: RawFd, on: bool) -> io::Result<()> {
    // SAFETY: fcntl 의 F_GETFD·F_SETFD 는 정수만 다룬다.
    let flags = cvt(unsafe { libc::fcntl(fd, libc::F_GETFD) })?;
    let flags = if on {
        flags | libc::FD_CLOEXEC
    } else {
        flags & !libc::FD_CLOEXEC
    };
    // SAFETY: 위와 같다.
    cvt(unsafe { libc::fcntl(fd, libc::F_SETFD, flags) }).map(|_| ())
}

fn set_nonblock(fd: RawFd) -> io::Result<()> {
    // SAFETY: fcntl 의 F_GETFL·F_SETFL 은 정수만 다룬다.
    let flags = cvt(unsafe { libc::fcntl(fd, libc::F_GETFL) })?;
    // SAFETY: 위와 같다.
    cvt(unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) }).map(|_| ())
}

fn get_winsize(fd: RawFd) -> io::Result<(u16, u16)> {
    // SAFETY: 0 으로 채운 winsize 는 유효하고, ioctl 은 그 주소에만 쓴다.
    let mut ws: libc::winsize = unsafe { std::mem::zeroed() };
    // SAFETY: ws 는 쓰기 가능한 winsize 다.
    cvt(unsafe { libc::ioctl(fd, libc::TIOCGWINSZ, &mut ws) })?;
    Ok((ws.ws_col, ws.ws_row))
}

fn set_winsize(fd: RawFd, cols: u16, rows: u16) -> io::Result<()> {
    let ws = libc::winsize {
        ws_row: rows,
        ws_col: cols,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    // SAFETY: ws 는 읽기 가능한 winsize 다.
    cvt(unsafe { libc::ioctl(fd, libc::TIOCSWINSZ, &ws) }).map(|_| ())
}

/// 마스터·슬레이브 한 쌍. 둘 다 close-on-exec 이다.
fn open_pty(cols: u16, rows: u16) -> io::Result<(OwnedFd, OwnedFd)> {
    let mut master: libc::c_int = -1;
    let mut slave: libc::c_int = -1;
    let mut ws = libc::winsize {
        ws_row: rows,
        ws_col: cols,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    // SAFETY: 두 정수와 winsize 의 주소를 넘긴다. 이름·termios 는 쓰지 않는다(null).
    cvt(unsafe {
        libc::openpty(
            &mut master,
            &mut slave,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &raw mut ws,
        )
    })?;
    // SAFETY: openpty 가 성공하면 두 fd 는 이 프로세스가 소유한 열린 fd 다.
    let (m, s) = unsafe { (OwnedFd::from_raw_fd(master), OwnedFd::from_raw_fd(slave)) };
    set_cloexec(m.as_raw_fd(), true)?;
    set_cloexec(s.as_raw_fd(), true)?;
    Ok((m, s))
}

/// 구분자가 없는 이름을 이 프로세스의 PATH 로 찾는다 (Go `exec.Command` 의 LookPath).
fn resolve(file: &str) -> Result<String, String> {
    crate::look_path(file)
        .ok_or_else(|| format!("exec: {}: executable file not found in $PATH", quote(file)))
}

/// 자식에서 쓸 argv·envp. fork 전에 모두 만들어 둔다(자식에서는 할당하지 않는다).
struct ExecImage {
    path: CString,
    _argv: Vec<CString>,
    _envp: Vec<CString>,
    argv_ptrs: Vec<*const libc::c_char>,
    envp_ptrs: Vec<*const libc::c_char>,
}

// SAFETY: 포인터는 같은 구조체가 소유한 CString 을 가리키며, 구조체는 만든 뒤 바뀌지 않는다.
unsafe impl Send for ExecImage {}
// SAFETY: 위와 같다. 읽기만 한다.
unsafe impl Sync for ExecImage {}

fn cstring(s: &str) -> io::Result<CString> {
    CString::new(s).map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "invalid argument"))
}

impl ExecImage {
    fn new(path: &str, args: &[String], env: &[String]) -> io::Result<Self> {
        let argv: Vec<CString> = args.iter().map(|a| cstring(a)).collect::<io::Result<_>>()?;
        let envp: Vec<CString> = env.iter().map(|e| cstring(e)).collect::<io::Result<_>>()?;
        let mut argv_ptrs: Vec<_> = argv.iter().map(|c| c.as_ptr()).collect();
        argv_ptrs.push(std::ptr::null());
        let mut envp_ptrs: Vec<_> = envp.iter().map(|c| c.as_ptr()).collect();
        envp_ptrs.push(std::ptr::null());
        Ok(ExecImage {
            path: cstring(path)?,
            _argv: argv,
            _envp: envp,
            argv_ptrs,
            envp_ptrs,
        })
    }
}

impl ExecImage {
    /// execve 를 부른다. 돌아오면 실패이고 그 errno 를 낸다. 자식에서만 부른다.
    fn exec(&self) -> io::Error {
        // SAFETY: 세 포인터 모두 self 가 소유한 NUL 종료 문자열과 null 로 끝나는 배열을 가리킨다.
        unsafe {
            libc::execve(
                self.path.as_ptr(),
                self.argv_ptrs.as_ptr(),
                self.envp_ptrs.as_ptr(),
            )
        };
        io::Error::last_os_error()
    }
}

impl Pty for PosixPty {
    fn start(&self, spec: ProcSpec, cols: u16, rows: u16) -> io::Result<Box<dyn Terminal>> {
        let wrap = |e: io::Error| {
            io::Error::new(
                e.kind(),
                format!(
                    "pty start {} (cwd={}): {}",
                    spec.path,
                    spec.dir,
                    go_error_string(&e)
                ),
            )
        };
        let (cols, rows) = clamp_size(cols, rows);
        let prog = if spec.path.contains('/') {
            spec.path.clone()
        } else {
            resolve(&spec.path).map_err(|m| wrap(io::Error::new(io::ErrorKind::NotFound, m)))?
        };
        if spec.args.is_empty() {
            return Err(wrap(io::Error::new(
                io::ErrorKind::InvalidInput,
                "argv 가 비었다",
            )));
        }
        if !spec.dir.is_empty()
            && let Err(e) = std::fs::metadata(&spec.dir)
        {
            return Err(wrap(path_error("chdir", &spec.dir, e)));
        }
        let env = dedup_env(&spec.env, env_key_as_is);
        let image = ExecImage::new(&prog, &spec.args, &env).map_err(wrap)?;
        let (master, slave) = open_pty(cols, rows).map_err(wrap)?;

        let mut cmd = Command::new(&prog);
        cmd.stdin(Stdio::from(slave.try_clone().map_err(wrap)?))
            .stdout(Stdio::from(slave.try_clone().map_err(wrap)?))
            .stderr(Stdio::from(slave));
        if !spec.dir.is_empty() {
            cmd.current_dir(&spec.dir);
        }
        // SAFETY: fork 뒤 exec 전에 돈다. setsid·ioctl·execve 는 async-signal-safe 이고, 쓰는
        // 메모리는 fork 전에 만든 image 뿐이다. execve 가 돌아오면 그 errno 를 낸다.
        unsafe {
            cmd.pre_exec(move || {
                if libc::setsid() == -1 {
                    return Err(io::Error::last_os_error());
                }
                if libc::ioctl(0, libc::TIOCSCTTY as _, 0) == -1 {
                    return Err(io::Error::last_os_error());
                }
                Err(image.exec())
            });
        }
        let child = cmd
            .spawn()
            .map_err(|e| wrap(path_error("fork/exec", &prog, e)))?;
        drop(cmd); // 부모 쪽 슬레이브를 닫아야 셸이 끝날 때 끝(EOF)이 온다.
        let pid = i32::try_from(child.id()).unwrap_or(0);
        let gate = match ReadGate::new() {
            Ok(g) => g,
            Err(e) => {
                let mut child = child;
                let _ = child.kill();
                return Err(e);
            }
        };
        Ok(Box::new(PosixTerminal::new(master, pid, Some(child), gate)))
    }
}

/// 넘겨받은 마스터 fd 와 셸 pid 로 터미널을 다시 만든다 (FR-DSK-21). exec 는 pid 를 바꾸지
/// 않으므로 셸은 여전히 이 프로세스의 자식이고, wait 는 waitpid 로 거둔다.
pub(crate) fn adopt_terminal(fd: usize, pid: i32) -> io::Result<Box<dyn Terminal>> {
    if pid <= 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("셸 pid 가 아닙니다: {pid}"),
        ));
    }
    let raw = RawFd::try_from(fd).map_err(|_| io::Error::from_raw_os_error(libc::EBADF))?;
    if let Err(e) = get_winsize(raw) {
        return Err(io::Error::new(
            e.kind(),
            format!("fd {fd} 는 의사 터미널이 아닙니다: {}", go_error_string(&e)),
        ));
    }
    set_cloexec(raw, true)?;
    let gate = ReadGate::new()?;
    // SAFETY: 이 fd 는 넘겨받은 것이고, 이제 이 터미널이 소유한다(호출자는 더 쓰지 않는다).
    let master = unsafe { OwnedFd::from_raw_fd(raw) };
    Ok(Box::new(PosixTerminal::new(master, pid, None, gate)))
}

/// ptmx 와 셸 프로세스를 한 덩어리로 든다. child 는 이 프로세스가 띄운 셸이고, 넘겨받은 셸이면 None 이다.
pub(crate) struct PosixTerminal {
    /// 열려 있으면 Some. 크기·쓰기·전경 조회는 읽기 잠금을 쥐고 쓴다 — 닫기와 경쟁하지 않는다.
    master: RwLock<Option<OwnedFd>>,
    /// 마스터 fd 번호. 닫힌 뒤에는 쓰지 않는다(게이트가 읽기를 먼저 물린다).
    raw: RawFd,
    gate: ReadGate,
    child: Mutex<Option<Child>>,
    spawned: bool,
    pid: i32,
    reaped: AtomicBool,
}

impl PosixTerminal {
    fn new(master: OwnedFd, pid: i32, child: Option<Child>, gate: ReadGate) -> Self {
        PosixTerminal {
            raw: master.as_raw_fd(),
            master: RwLock::new(Some(master)),
            gate,
            spawned: child.is_some(),
            child: Mutex::new(child),
            pid,
            reaped: AtomicBool::new(false),
        }
    }

    fn with_fd<T>(&self, f: impl FnOnce(RawFd) -> io::Result<T>) -> io::Result<T> {
        let g = self.master.read().unwrap_or_else(|e| e.into_inner());
        match g.as_ref() {
            Some(fd) => f(fd.as_raw_fd()),
            None => Err(closed_error()),
        }
    }

    fn signal(&self, sig: libc::c_int) -> io::Result<()> {
        if self.pid <= 0 {
            return Ok(());
        }
        if self.spawned && self.reaped.load(Ordering::Acquire) {
            return Err(io::Error::other("os: process already finished"));
        }
        // SAFETY: kill(2) 는 메모리를 건드리지 않는다.
        cvt(unsafe { libc::kill(self.pid, sig) }).map(|_| ())
    }
}

impl Terminal for PosixTerminal {
    fn read(&self, buf: &mut [u8]) -> io::Result<usize> {
        self.gate.read(self.raw, buf)
    }

    fn write(&self, buf: &[u8]) -> io::Result<usize> {
        self.with_fd(|fd| {
            let mut off = 0;
            while off < buf.len() {
                // SAFETY: buf[off..] 는 읽기 가능한 바이트다.
                let n = unsafe { libc::write(fd, buf[off..].as_ptr().cast(), buf.len() - off) };
                if n < 0 {
                    let e = errno();
                    if e.kind() == io::ErrorKind::Interrupted {
                        continue;
                    }
                    return Err(e);
                }
                off += n.unsigned_abs();
            }
            Ok(buf.len())
        })
    }

    fn close(&self) -> io::Result<()> {
        self.gate.close();
        let mut g = self.master.write().unwrap_or_else(|e| e.into_inner());
        match g.take() {
            Some(fd) => {
                drop(fd);
                Ok(())
            }
            None => Err(closed_error()),
        }
    }

    fn resize(&self, cols: u16, rows: u16) -> io::Result<()> {
        self.with_fd(|fd| set_winsize(fd, cols, rows))
    }

    fn size(&self) -> io::Result<(u16, u16)> {
        self.with_fd(get_winsize)
    }

    /// tcgetpgrp 로 전경 그룹을 읽고, 그것이 셸 자신의 그룹이면 없음이다.
    fn foreground_pgid(&self) -> Option<i32> {
        // SAFETY: tcgetpgrp 는 정수만 다룬다.
        let pgid = self
            .with_fd(|fd| cvt(unsafe { libc::tcgetpgrp(fd) }))
            .ok()?;
        if pgid <= 0 {
            return None;
        }
        // SAFETY: getpgid 는 정수만 다룬다.
        let shell = unsafe { libc::getpgid(self.pid()) };
        (shell != -1 && pgid != shell).then_some(pgid)
    }

    fn pid(&self) -> i32 {
        self.pid
    }

    fn wait(&self) -> io::Result<ExitStatus> {
        if self.spawned {
            let child = self.child.lock().unwrap_or_else(|e| e.into_inner()).take();
            let Some(mut child) = child else {
                return Err(io::Error::other("exec: Wait was already called"));
            };
            let st = child.wait();
            self.reaped.store(true, Ordering::Release);
            return st;
        }
        if self.pid <= 0 {
            return Ok(ExitStatus::from_raw(0));
        }
        let mut status: libc::c_int = 0;
        loop {
            // SAFETY: status 는 쓰기 가능한 정수다.
            if unsafe { libc::waitpid(self.pid, &mut status, 0) } != -1 {
                return Ok(ExitStatus::from_raw(status));
            }
            let e = errno();
            if e.kind() != io::ErrorKind::Interrupted {
                return Err(e);
            }
        }
    }

    fn terminate(&self) -> io::Result<()> {
        self.signal(libc::SIGTERM)
    }

    fn kill(&self) -> io::Result<()> {
        self.signal(libc::SIGKILL)
    }

    fn handover(&self) -> Option<&dyn Handover> {
        Some(self)
    }
}

impl Handover for PosixTerminal {
    fn freeze(&self) {
        self.gate.freeze();
    }
    fn thaw(&self) {
        self.gate.thaw();
    }
    fn master_fd(&self) -> usize {
        self.raw.unsigned_abs() as usize
    }
}

/// 마스터 fd 의 읽기를 멈출 수 있게 한다 (NFR-DSK-2). 읽기 전에 깨우기 파이프와 함께
/// poll 하고, 깨우기가 오면 읽지 않고 물러선다 — 멈춘 동안의 출력은 커널 버퍼에 남는다.
struct ReadGate {
    st: Mutex<GateState>,
    cv: Condvar,
    wake_r: RawFd,
    wake_w: RawFd,
}

#[derive(Default)]
struct GateState {
    frozen: bool,
    closed: bool,
    reading: bool,
}

impl ReadGate {
    fn new() -> io::Result<Self> {
        let mut p = [0 as libc::c_int; 2];
        // SAFETY: p 는 정수 두 개를 담는다.
        if unsafe { libc::pipe(p.as_mut_ptr()) } == -1 {
            let e = errno();
            return Err(io::Error::new(
                e.kind(),
                format!("깨우기 파이프: {}", go_error_string(&e)),
            ));
        }
        for fd in p {
            if let Err(e) = set_cloexec(fd, true).and_then(|()| set_nonblock(fd)) {
                // SAFETY: 방금 만든 파이프의 두 끝을 한 번씩 닫는다.
                unsafe {
                    libc::close(p[0]);
                    libc::close(p[1]);
                }
                return Err(io::Error::new(
                    e.kind(),
                    format!("깨우기 파이프: {}", go_error_string(&e)),
                ));
            }
        }
        Ok(ReadGate {
            st: Mutex::new(GateState::default()),
            cv: Condvar::new(),
            wake_r: p[0],
            wake_w: p[1],
        })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, GateState> {
        self.st.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn read(&self, fd: RawFd, buf: &mut [u8]) -> io::Result<usize> {
        {
            let mut st = self.lock();
            if st.closed {
                return Err(closed_error());
            }
            if st.frozen {
                return Err(io::Error::other(Frozen));
            }
            st.reading = true;
        }
        let res = self.read_once(fd, buf);
        let mut st = self.lock();
        st.reading = false;
        self.cv.notify_all();
        res
    }

    fn read_once(&self, fd: RawFd, buf: &mut [u8]) -> io::Result<usize> {
        loop {
            let mut fds = [
                libc::pollfd {
                    fd: self.wake_r,
                    events: libc::POLLIN,
                    revents: 0,
                },
                libc::pollfd {
                    fd,
                    events: libc::POLLIN,
                    revents: 0,
                },
            ];
            // SAFETY: fds 는 pollfd 두 개의 배열이다.
            if unsafe { libc::poll(fds.as_mut_ptr(), 2, -1) } == -1 {
                let e = errno();
                if e.kind() == io::ErrorKind::Interrupted {
                    continue;
                }
                return Err(e);
            }
            // 깨우기가 먼저다 — 출력과 깨우기가 함께 와도 읽지 않는다.
            if fds[0].revents != 0 {
                self.drain();
                if self.lock().closed {
                    return Err(closed_error());
                }
                return Err(io::Error::other(Frozen));
            }
            if fds[1].revents & libc::POLLNVAL != 0 {
                return Err(io::Error::from_raw_os_error(libc::EBADF));
            }
            // SAFETY: buf 는 쓰기 가능한 바이트다.
            let n = unsafe { libc::read(fd, buf.as_mut_ptr().cast(), buf.len()) };
            if n < 0 {
                let e = errno();
                if matches!(
                    e.kind(),
                    io::ErrorKind::Interrupted | io::ErrorKind::WouldBlock
                ) {
                    continue;
                }
                return Err(e);
            }
            // 셸이 끝나 슬레이브가 닫히면 macOS 는 오류 없이 0 바이트를 준다 — 끝이다.
            return Ok(n.unsigned_abs());
        }
    }

    fn drain(&self) {
        let mut b = [0u8; 64];
        // SAFETY: b 는 쓰기 가능한 64 바이트다. 깨우기 파이프는 논블로킹이다.
        while unsafe { libc::read(self.wake_r, b.as_mut_ptr().cast(), b.len()) } > 0 {}
    }

    fn poke(&self) {
        let one = [1u8];
        // SAFETY: one 은 읽기 가능한 1 바이트다.
        unsafe { libc::write(self.wake_w, one.as_ptr().cast(), 1) };
    }

    fn wait_readers(&self) {
        let mut st = self.lock();
        while st.reading {
            st = self.cv.wait(st).unwrap_or_else(|e| e.into_inner());
        }
    }

    /// 멈춤을 세우고, 기다리던 읽기를 깨워 물러설 때까지 기다린다.
    fn freeze(&self) {
        self.lock().frozen = true;
        self.poke();
        self.wait_readers();
    }

    fn thaw(&self) {
        self.lock().frozen = false;
        self.drain();
    }

    /// 읽기를 깨우고 파이프를 닫는다. 그 뒤의 read 는 닫힘 오류다.
    fn close(&self) {
        {
            let mut st = self.lock();
            if st.closed {
                return;
            }
            st.closed = true;
        }
        self.poke();
        self.wait_readers();
    }
}

impl Drop for ReadGate {
    fn drop(&mut self) {
        // SAFETY: 이 게이트가 만든 파이프를 한 번만 닫는다.
        unsafe {
            libc::close(self.wake_r);
            libc::close(self.wake_w);
        }
    }
}

#[cfg(test)]
mod tests;
