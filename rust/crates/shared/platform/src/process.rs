//! pid 로 지목한 프로세스의 생명주기 제어 (FR-XPR-1).
//!
//! POSIX 의 신호와 Windows 의 종료 API 는 의미론이 정확히 겹치지 않는다. 호출부는
//! "정중히 요청한다(terminate)" 와 "즉시 끝낸다(kill)" 두 가지만 안다.

use std::io;
use std::process::{Child, Command};

/// "정중히 종료하라" 는 요청으로 받아들일 신호.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ShutdownSignal {
    /// SIGINT · Windows 의 Ctrl+C·Ctrl+Break.
    Interrupt,
    /// SIGTERM.
    Terminate,
    /// SIGHUP.
    Hangup,
}

/// 프로세스 생명주기 제어.
pub trait Process: Send + Sync {
    /// pid 가 살아 있는지. 확인할 수 없으면 살아 있는 것으로 본다 — 없는 것으로 오판하면
    /// 낡은 pidfile 로 알고 살아 있는 데몬을 잃는다.
    fn alive(&self, pid: i32) -> bool;
    /// 정중한 종료를 요청한다. pid 가 0 이하면 아무것도 하지 않는다.
    fn terminate(&self, pid: i32) -> io::Result<()>;
    /// 즉시 종료다. pid 가 0 이하면 아무것도 하지 않는다.
    fn kill(&self, pid: i32) -> io::Result<()>;
    /// 부모와 수명·제어 터미널을 분리해 띄우도록 cmd 를 준비한다. spawn **전에** 부른다.
    /// POSIX 는 새 세션(setsid), Windows 는 `CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP` 이다.
    ///
    /// Windows 의 std `Command` 는 생성 플래그를 읽을 수 없어 OR 하지 못하고 덮어쓴다.
    /// POSIX 에서 호출자가 `process_group` 을 걸었다면 setsid 와 겹쳐 spawn 이 실패한다.
    fn detach(&self, cmd: &mut Command);
    /// "정중히 종료하라" 로 받아들일 신호들. 실제로 전달되는 신호만 나열한다.
    fn shutdown_signals(&self) -> &'static [ShutdownSignal];
    /// cmd 와 그 자손 전체를 한 묶음으로 만들 준비를 하고 그 핸들을 낸다. spawn **전에** 부른다.
    /// POSIX 는 새 세션, Windows 는 Job Object(자식은 중단된 채로 뜬다)다.
    fn new_group(&self, cmd: &mut Command) -> Box<dyn Group>;
}

/// 프로세스 묶음. POSIX 프로세스 그룹 / Windows Job Object. 자손까지 닿는 것이 존재 이유다.
pub trait Group: Send + Sync {
    /// spawn **직후에 반드시** 부른다. POSIX 는 그룹 리더를 기억하고, Windows 는 Job 에
    /// 배정한 뒤 중단된 자식을 재개한다 — 부르지 않으면 자식이 영영 시작되지 않는다 (FR-XPR-5).
    fn bind(&self, child: &Child) -> io::Result<()>;
    /// 묶음 전체에 정중한 종료를 요청한다. bind 전이면 아무것도 하지 않는다.
    fn terminate(&self) -> io::Result<()>;
    /// 묶음 전체를 즉시 끝낸다. bind 전이면 아무것도 하지 않는다.
    fn kill(&self) -> io::Result<()>;
    /// 묶음의 자원을 놓는다. POSIX 는 할 일이 없다. Windows 는 Job 핸들을 닫으며 남은 구성원이
    /// 함께 끝난다. 여러 번 불려도 안전하다. drop 은 이것을 부르지 않는다(Go 와 같다).
    fn close(&self) -> io::Result<()>;
}

pub(crate) fn current() -> &'static dyn Process {
    #[cfg(unix)]
    {
        &posix::PosixProcess
    }
    #[cfg(windows)]
    {
        &windows::WindowsProcess
    }
}

#[cfg(unix)]
pub(crate) mod posix {
    use super::*;
    use std::os::unix::process::CommandExt;
    use std::sync::atomic::{AtomicI32, Ordering};

    pub(crate) struct PosixProcess;

    fn kill(pid: i32, sig: libc::c_int) -> io::Result<()> {
        // SAFETY: kill(2) 는 메모리를 건드리지 않는다. 잘못된 pid 는 errno 로 돌아온다.
        if unsafe { libc::kill(pid, sig) } == 0 {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        }
    }

    /// 새 세션으로 띄운다. 새 세션의 리더는 곧 새 그룹의 리더이고, 제어 터미널이 없다
    /// (REPO_FIX 01 P-2).
    fn new_session(cmd: &mut Command) {
        // SAFETY: fork 뒤 exec 전에 도는 클로저다. setsid(2) 는 async-signal-safe 이고
        // 할당·잠금을 하지 않는다.
        unsafe {
            cmd.pre_exec(|| {
                if libc::setsid() == -1 {
                    return Err(io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }

    impl Process for PosixProcess {
        /// 신호 0 으로 본다. EPERM 은 "있는데 내 것이 아니다" 이므로 살아 있다.
        fn alive(&self, pid: i32) -> bool {
            if pid <= 0 {
                return false;
            }
            match kill(pid, 0) {
                Ok(()) => true,
                Err(e) => e.raw_os_error() == Some(libc::EPERM),
            }
        }

        fn terminate(&self, pid: i32) -> io::Result<()> {
            if pid <= 0 {
                return Ok(());
            }
            kill(pid, libc::SIGTERM)
        }

        fn kill(&self, pid: i32) -> io::Result<()> {
            if pid <= 0 {
                return Ok(());
            }
            kill(pid, libc::SIGKILL)
        }

        fn detach(&self, cmd: &mut Command) {
            new_session(cmd);
        }

        /// SIGHUP 은 제어 터미널이 사라진 것이고, SIGTERM 은 관리자의 종료 요청이다.
        fn shutdown_signals(&self) -> &'static [ShutdownSignal] {
            &[
                ShutdownSignal::Interrupt,
                ShutdownSignal::Terminate,
                ShutdownSignal::Hangup,
            ]
        }

        fn new_group(&self, cmd: &mut Command) -> Box<dyn Group> {
            new_session(cmd);
            Box::new(PosixGroup {
                pid: AtomicI32::new(0),
            })
        }
    }

    /// setsid 로 만든 세션의 그룹. 리더의 pid 가 곧 pgid 다.
    struct PosixGroup {
        pid: AtomicI32,
    }

    impl PosixGroup {
        fn signal(&self, sig: libc::c_int) -> io::Result<()> {
            let pid = self.pid.load(Ordering::Acquire);
            if pid <= 0 {
                return Ok(());
            }
            kill(-pid, sig)
        }
    }

    impl Group for PosixGroup {
        fn bind(&self, child: &Child) -> io::Result<()> {
            let pid = i32::try_from(child.id()).map_err(io::Error::other)?;
            self.pid.store(pid, Ordering::Release);
            Ok(())
        }
        fn terminate(&self) -> io::Result<()> {
            self.signal(libc::SIGTERM)
        }
        fn kill(&self) -> io::Result<()> {
            self.signal(libc::SIGKILL)
        }
        fn close(&self) -> io::Result<()> {
            Ok(())
        }
    }
}

#[cfg(windows)]
pub(crate) mod windows {
    use super::*;
    use std::os::windows::process::CommandExt;
    use std::sync::Mutex;

    use dm_gocompat::oserr::go_error_string;
    use windows_sys::Win32::Foundation::{
        CloseHandle, ERROR_ACCESS_DENIED, HANDLE, INVALID_HANDLE_VALUE, STILL_ACTIVE,
    };
    use windows_sys::Win32::System::Console::{CTRL_BREAK_EVENT, GenerateConsoleCtrlEvent};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, TH32CS_SNAPTHREAD, THREADENTRY32, Thread32First, Thread32Next,
    };
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject,
    };
    use windows_sys::Win32::System::Threading::{
        CREATE_NEW_PROCESS_GROUP, CREATE_NO_WINDOW, CREATE_SUSPENDED, GetExitCodeProcess,
        OpenProcess, OpenThread, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SET_QUOTA,
        PROCESS_TERMINATE, ResumeThread, THREAD_SUSPEND_RESUME, TerminateProcess,
    };

    pub(crate) struct WindowsProcess;

    /// 소유한 핸들. drop 하면 닫는다.
    struct Owned(HANDLE);

    impl Drop for Owned {
        fn drop(&mut self) {
            // SAFETY: Owned 는 열린 핸들만 담고, 여기서 한 번만 닫는다.
            unsafe { CloseHandle(self.0) };
        }
    }

    fn open_process(access: u32, pid: u32) -> io::Result<Owned> {
        // SAFETY: 포인터 인자가 없다. 실패하면 null 이 온다.
        let h = unsafe { OpenProcess(access, 0, pid) };
        if h.is_null() {
            return Err(io::Error::last_os_error());
        }
        Ok(Owned(h))
    }

    fn ctrl_break(group_pid: u32) -> bool {
        // SAFETY: 포인터 인자가 없다.
        unsafe { GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT, group_pid) != 0 }
    }

    fn kill_pid(pid: u32) -> io::Result<()> {
        let h = open_process(PROCESS_TERMINATE, pid)?;
        // SAFETY: h 는 PROCESS_TERMINATE 권한으로 연 유효한 핸들이다.
        if unsafe { TerminateProcess(h.0, 1) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    fn pid_u32(pid: i32) -> u32 {
        pid.unsigned_abs()
    }

    impl Process for WindowsProcess {
        /// 핸들을 열지 못한 이유가 권한이면 존재하는 것이다.
        fn alive(&self, pid: i32) -> bool {
            if pid <= 0 {
                return false;
            }
            let h = match open_process(PROCESS_QUERY_LIMITED_INFORMATION, pid_u32(pid)) {
                Ok(h) => h,
                Err(e) => return e.raw_os_error() == Some(ERROR_ACCESS_DENIED as i32),
            };
            let mut code = 0u32;
            // SAFETY: h 는 유효한 핸들이고 code 는 쓰기 가능한 u32 다.
            if unsafe { GetExitCodeProcess(h.0, &mut code) } == 0 {
                return true;
            }
            code == STILL_ACTIVE as u32
        }

        /// Ctrl+Break 로 정중히 요청한다. 닿지 않으면 즉시 종료로 물러선다 (FR-XPR-3).
        fn terminate(&self, pid: i32) -> io::Result<()> {
            if pid <= 0 {
                return Ok(());
            }
            if ctrl_break(pid_u32(pid)) {
                return Ok(());
            }
            kill_pid(pid_u32(pid))
        }

        fn kill(&self, pid: i32) -> io::Result<()> {
            if pid <= 0 {
                return Ok(());
            }
            kill_pid(pid_u32(pid))
        }

        fn detach(&self, cmd: &mut Command) {
            cmd.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);
        }

        /// SIGTERM·SIGHUP 은 전달되지 않으므로 나열하지 않는다.
        fn shutdown_signals(&self) -> &'static [ShutdownSignal] {
            &[ShutdownSignal::Interrupt]
        }

        fn new_group(&self, cmd: &mut Command) -> Box<dyn Group> {
            let g = match create_job() {
                Ok(job) => WindowsGroup {
                    state: Mutex::new(GroupState {
                        job: Some(job),
                        pid: None,
                    }),
                    err: None,
                },
                Err(msg) => WindowsGroup {
                    state: Mutex::new(GroupState {
                        job: None,
                        pid: None,
                    }),
                    err: Some(msg),
                },
            };
            if g.err.is_none() {
                cmd.creation_flags(CREATE_SUSPENDED | CREATE_NEW_PROCESS_GROUP);
            }
            Box::new(g)
        }
    }

    /// 마지막 핸들이 닫히면 남은 구성원을 함께 끝내는 Job.
    fn create_job() -> Result<Owned, String> {
        // SAFETY: null 보안 속성과 null 이름은 허용된 인자다.
        let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if job.is_null() {
            return Err(format!(
                "create job object: {}",
                go_error_string(&io::Error::last_os_error())
            ));
        }
        let job = Owned(job);
        // SAFETY: 0 으로 채운 구조체는 유효한 값이다(정수·포인터 필드뿐이다).
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        // SAFETY: job 은 유효한 Job 핸들이고, info 의 주소와 크기를 정확히 넘긴다.
        let ok = unsafe {
            SetInformationJobObject(
                job.0,
                JobObjectExtendedLimitInformation,
                (&raw const info).cast(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if ok == 0 {
            return Err(format!(
                "set job limits: {}",
                go_error_string(&io::Error::last_os_error())
            ));
        }
        Ok(job)
    }

    struct GroupState {
        job: Option<Owned>,
        pid: Option<u32>,
    }

    struct WindowsGroup {
        state: Mutex<GroupState>,
        err: Option<String>,
    }

    // SAFETY: HANDLE 은 커널 객체의 불투명한 번호다. 어느 스레드에서 써도 되고, 접근은 Mutex 가 묶는다.
    unsafe impl Send for WindowsGroup {}
    // SAFETY: 위와 같다.
    unsafe impl Sync for WindowsGroup {}

    impl WindowsGroup {
        fn lock(&self) -> std::sync::MutexGuard<'_, GroupState> {
            self.state.lock().unwrap_or_else(|e| e.into_inner())
        }

        fn failed(&self) -> Option<io::Error> {
            self.err.as_ref().map(|m| io::Error::other(m.clone()))
        }
    }

    impl Group for WindowsGroup {
        /// 자식을 Job 에 넣고 재개한다. 이 순서가 뒤집히면 배정 전에 손자가 생길 수 있다.
        fn bind(&self, child: &Child) -> io::Result<()> {
            if let Some(e) = self.failed() {
                return Err(e);
            }
            let mut st = self.lock();
            let Some(job) = st.job.as_ref() else {
                return Err(io::Error::other("bind: 프로세스가 시작되지 않았다"));
            };
            let pid = child.id();
            let h = open_process(PROCESS_SET_QUOTA | PROCESS_TERMINATE, pid).map_err(|e| {
                io::Error::new(
                    e.kind(),
                    format!("bind: open process: {}", go_error_string(&e)),
                )
            })?;
            // SAFETY: 두 핸들 모두 유효하다.
            if unsafe { AssignProcessToJobObject(job.0, h.0) } == 0 {
                let e = io::Error::last_os_error();
                return Err(io::Error::new(
                    e.kind(),
                    format!("bind: assign to job: {}", go_error_string(&e)),
                ));
            }
            resume_process(pid).map_err(|m| io::Error::other(format!("bind: {m}")))?;
            st.pid = Some(pid);
            Ok(())
        }

        /// 그룹 전체에 Ctrl+Break. 닿지 않으면 즉시 종료로 물러선다.
        fn terminate(&self) -> io::Result<()> {
            if let Some(e) = self.failed() {
                return Err(e);
            }
            let pid = {
                let st = self.lock();
                if st.job.is_none() {
                    return Ok(());
                }
                st.pid
            };
            if pid.is_some_and(ctrl_break) {
                return Ok(());
            }
            self.kill()
        }

        fn kill(&self) -> io::Result<()> {
            if let Some(e) = self.failed() {
                return Err(e);
            }
            let st = self.lock();
            let Some(job) = st.job.as_ref() else {
                return Ok(());
            };
            // SAFETY: job 은 유효한 Job 핸들이다.
            if unsafe { TerminateJobObject(job.0, 1) } == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        }

        fn close(&self) -> io::Result<()> {
            let mut st = self.lock();
            if let Some(job) = st.job.take() {
                let raw = job.0;
                std::mem::forget(job);
                // SAFETY: 열린 Job 핸들을 한 번만 닫는다(take 로 꺼냈다).
                if unsafe { CloseHandle(raw) } == 0 {
                    return Err(io::Error::last_os_error());
                }
            }
            Ok(())
        }
    }

    /// pid 의 스레드를 모두 재개한다. std 는 스레드 핸들을 내주지 않으므로 스냅샷으로 되찾는다.
    fn resume_process(pid: u32) -> Result<(), String> {
        // SAFETY: 포인터 인자가 없다.
        let snap = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
        if snap == INVALID_HANDLE_VALUE {
            return Err(format!(
                "thread snapshot: {}",
                go_error_string(&io::Error::last_os_error())
            ));
        }
        let snap = Owned(snap);
        // SAFETY: 0 으로 채운 THREADENTRY32 는 유효한 값이다.
        let mut entry: THREADENTRY32 = unsafe { std::mem::zeroed() };
        entry.dwSize = std::mem::size_of::<THREADENTRY32>() as u32;
        let mut resumed = 0;
        // SAFETY: snap 은 유효한 스냅샷이고 entry 의 dwSize 를 채웠다.
        let mut more = unsafe { Thread32First(snap.0, &mut entry) } != 0;
        while more {
            if entry.th32OwnerProcessID == pid {
                // SAFETY: 포인터 인자가 없다.
                let th = unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID) };
                if !th.is_null() {
                    let th = Owned(th);
                    // SAFETY: th 는 THREAD_SUSPEND_RESUME 권한으로 연 유효한 핸들이다.
                    if unsafe { ResumeThread(th.0) } != u32::MAX {
                        resumed += 1;
                    }
                }
            }
            // SAFETY: 위와 같다.
            more = unsafe { Thread32Next(snap.0, &mut entry) } != 0;
        }
        if resumed == 0 {
            return Err(format!("pid {pid} 의 스레드를 재개하지 못했다"));
        }
        Ok(())
    }
}

#[cfg(all(test, unix))]
mod tests;
