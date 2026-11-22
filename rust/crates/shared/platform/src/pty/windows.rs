//! Windows 의사 콘솔(ConPTY). Windows 10 1809 이상 (CROSS_PLATFORM_SRS C-1, FR-XPT-1).
//!
//! 프로세스를 스스로 띄운다 — STARTUPINFOEX 의 PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE 속성은
//! std `Command` 로 실을 수 없다. 표준 입출력은 지정만 하고 비워 둔다(STARTF_USESTDHANDLES):
//! 부모의 핸들을 물려주면 자식이 의사 콘솔이 아니라 그것을 쓴다.

use std::fs::File;
use std::io::{self, Read, Write};
use std::os::windows::io::FromRawHandle;
use std::os::windows::process::ExitStatusExt;
use std::process::ExitStatus;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};

use dm_gocompat::oserr::go_error_string;
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
use windows_sys::Win32::System::Console::{
    COORD, ClosePseudoConsole, CreatePseudoConsole, HPCON, ResizePseudoConsole,
};
use windows_sys::Win32::System::Pipes::CreatePipe;
use windows_sys::Win32::System::Threading::{
    CREATE_UNICODE_ENVIRONMENT, CreateProcessW, DeleteProcThreadAttributeList,
    EXTENDED_STARTUPINFO_PRESENT, GetExitCodeProcess, INFINITE, InitializeProcThreadAttributeList,
    PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, PROCESS_INFORMATION, STARTF_USESTDHANDLES, STARTUPINFOEXW,
    UpdateProcThreadAttribute, WaitForSingleObject,
};

use super::{
    ProcSpec, Pty, Terminal, clamp_size, closed_error, compose_command_line, dedup_env, env_block,
    env_key_folded,
};
use crate::handover::Handover;

pub(crate) struct WindowsPty;

fn coord(cols: u16, rows: u16) -> COORD {
    COORD {
        X: cols as i16,
        Y: rows as i16,
    }
}

fn wrapped(prefix: &str, e: &io::Error) -> io::Error {
    io::Error::new(e.kind(), format!("{prefix}: {}", go_error_string(e)))
}

fn einval(prefix: &str) -> io::Error {
    wrapped(prefix, &io::Error::from_raw_os_error(87))
}

fn close_handle(h: usize) {
    if h != 0 {
        // SAFETY: 열린 핸들을 한 번만 닫는다(부르는 쪽이 소유권을 넘긴다).
        unsafe { CloseHandle(h as HANDLE) };
    }
}

fn pipe() -> io::Result<(usize, usize)> {
    let mut r: HANDLE = std::ptr::null_mut();
    let mut w: HANDLE = std::ptr::null_mut();
    // SAFETY: r·w 는 쓰기 가능한 핸들 자리다. 보안 속성은 null 이다.
    if unsafe { CreatePipe(&mut r, &mut w, std::ptr::null(), 0) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok((r as usize, w as usize))
}

fn utf16z(s: &str) -> Option<Vec<u16>> {
    if s.contains('\0') {
        return None;
    }
    Some(s.encode_utf16().chain(std::iter::once(0)).collect())
}

impl Pty for WindowsPty {
    fn start(&self, spec: ProcSpec, cols: u16, rows: u16) -> io::Result<Box<dyn Terminal>> {
        let (cols, rows) = clamp_size(cols, rows);
        let (in_read, in_write) = pipe().map_err(|e| wrapped("입력 파이프", &e))?;
        let (out_read, out_write) = match pipe() {
            Ok(p) => p,
            Err(e) => {
                close_handle(in_read);
                close_handle(in_write);
                return Err(wrapped("출력 파이프", &e));
            }
        };
        let mut hpc: HPCON = 0;
        // SAFETY: 두 파이프 끝은 유효한 핸들이고 hpc 는 쓰기 가능하다.
        let hr = unsafe {
            CreatePseudoConsole(
                coord(cols, rows),
                in_read as HANDLE,
                out_write as HANDLE,
                0,
                &mut hpc,
            )
        };
        if hr != 0 {
            for h in [in_read, in_write, out_read, out_write] {
                close_handle(h);
            }
            return Err(wrapped(
                "CreatePseudoConsole",
                &io::Error::from_raw_os_error(hr),
            ));
        }
        // 의사 콘솔이 자기 사본을 쥔다. 우리 쪽은 닫아야 EOF 가 제대로 온다.
        close_handle(in_read);
        close_handle(out_write);

        let pi = match start_in_pseudo_console(&spec, hpc) {
            Ok(pi) => pi,
            Err(e) => {
                // SAFETY: 방금 만든 의사 콘솔을 한 번 닫는다.
                unsafe { ClosePseudoConsole(hpc) };
                close_handle(in_write);
                close_handle(out_read);
                return Err(e);
            }
        };
        // SAFETY: 두 파이프 끝은 이 터미널이 소유한다.
        let (input, output) = unsafe {
            (
                File::from_raw_handle(in_write as HANDLE),
                File::from_raw_handle(out_read as HANDLE),
            )
        };
        let inner = Arc::new(Inner {
            hpc,
            hpc_closed: Mutex::new(false),
            input: Mutex::new(Some(Arc::new(input))),
            output: Mutex::new(Some(Arc::new(output))),
            thread: Mutex::new(pi.hThread as usize),
            pid: i32::try_from(pi.dwProcessId).unwrap_or(0),
            size: Mutex::new((cols, rows)),
            exit: Mutex::new(None),
            exited: Condvar::new(),
            closed: AtomicBool::new(false),
        });
        let process = pi.hProcess as usize;
        let reaper = inner.clone();
        std::thread::spawn(move || reaper.reap(process));
        Ok(Box::new(WindowsTerminal(inner)))
    }
}

fn start_in_pseudo_console(spec: &ProcSpec, hpc: HPCON) -> io::Result<PROCESS_INFORMATION> {
    let mut size = 0usize;
    // SAFETY: null 목록으로 필요한 크기만 묻는다.
    unsafe { InitializeProcThreadAttributeList(std::ptr::null_mut(), 1, 0, &mut size) };
    let mut buf = vec![0usize; size.div_ceil(std::mem::size_of::<usize>()).max(1)];
    let list = buf.as_mut_ptr().cast();
    // SAFETY: buf 는 size 바이트 이상이고 usize 로 정렬되어 있다.
    if unsafe { InitializeProcThreadAttributeList(list, 1, 0, &mut size) } == 0 {
        return Err(wrapped("속성 목록", &io::Error::last_os_error()));
    }
    struct ListGuard(*mut core::ffi::c_void);
    impl Drop for ListGuard {
        fn drop(&mut self) {
            // SAFETY: 초기화한 목록을 한 번 지운다.
            unsafe { DeleteProcThreadAttributeList(self.0) };
        }
    }
    let _guard = ListGuard(list);
    // SAFETY: lpValue 는 HPCON 값 자체다(포인터가 아니다) — ConPTY 의 문서화된 규약이다.
    let ok = unsafe {
        UpdateProcThreadAttribute(
            list,
            0,
            PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE as usize,
            hpc as *const core::ffi::c_void,
            std::mem::size_of::<HPCON>(),
            std::ptr::null_mut(),
            std::ptr::null(),
        )
    };
    if ok == 0 {
        return Err(wrapped("속성 설정", &io::Error::last_os_error()));
    }
    // SAFETY: 0 으로 채운 STARTUPINFOEXW 는 유효한 값이다.
    let mut si: STARTUPINFOEXW = unsafe { std::mem::zeroed() };
    si.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
    si.StartupInfo.dwFlags |= STARTF_USESTDHANDLES;
    si.lpAttributeList = list;

    let mut cmdline = utf16z(&compose_command_line(&spec.args)).ok_or_else(|| einval("명령줄"))?;
    let dir = if spec.dir.is_empty() {
        None
    } else {
        Some(utf16z(&spec.dir).ok_or_else(|| einval("작업 디렉터리"))?)
    };
    let env = env_block(&dedup_env(&spec.env, env_key_folded)).map_err(|()| einval("환경 변수"))?;
    // SAFETY: 0 으로 채운 PROCESS_INFORMATION 은 유효한 값이다.
    let mut pi: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
    // SAFETY: 모든 포인터는 이 함수가 살아 있는 동안 유효한 버퍼를 가리킨다. si 는 STARTUPINFOEXW 이고
    // EXTENDED_STARTUPINFO_PRESENT 를 함께 넘긴다.
    let ok = unsafe {
        CreateProcessW(
            std::ptr::null(),
            cmdline.as_mut_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            1,
            EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT,
            env.as_ref().map_or(std::ptr::null(), |b| b.as_ptr().cast()),
            dir.as_ref().map_or(std::ptr::null(), |d| d.as_ptr()),
            (&raw const si).cast(),
            &mut pi,
        )
    };
    if ok == 0 {
        return Err(wrapped(
            &format!("CreateProcess {}", spec.path),
            &io::Error::last_os_error(),
        ));
    }
    Ok(pi)
}

struct Inner {
    hpc: HPCON,
    /// 의사 콘솔을 닫았는가. 닫기는 한 번만 한다.
    hpc_closed: Mutex<bool>,
    /// 파이프 끝. 닫기는 자리에서 꺼낸다 — 막힌 read 가 쥔 사본은 그 read 가 끝난 뒤에 닫힌다.
    input: Mutex<Option<Arc<File>>>,
    output: Mutex<Option<Arc<File>>>,
    thread: Mutex<usize>,
    pid: i32,
    size: Mutex<(u16, u16)>,
    exit: Mutex<Option<u32>>,
    exited: Condvar,
    closed: AtomicBool,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl Inner {
    /// 프로세스가 끝나기를 기다려 종료 코드를 남기고, 의사 콘솔을 닫아 출력 파이프에 EOF 가 오게 한다.
    fn reap(&self, process: usize) {
        let mut code = 0u32;
        if process != 0 {
            // SAFETY: process 는 CreateProcessW 가 준 유효한 핸들이다.
            if unsafe { WaitForSingleObject(process as HANDLE, INFINITE) } == 0 {
                // SAFETY: 위와 같고, code 는 쓰기 가능하다.
                unsafe { GetExitCodeProcess(process as HANDLE, &mut code) };
            }
            close_handle(process);
        }
        *lock(&self.exit) = Some(code);
        self.exited.notify_all();
        self.close_pseudo_console();
    }

    fn close_pseudo_console(&self) {
        let mut closed = lock(&self.hpc_closed);
        if !*closed {
            *closed = true;
            // SAFETY: 이 의사 콘솔을 한 번만 닫는다(hpc_closed 가 지킨다).
            unsafe { ClosePseudoConsole(self.hpc) };
        }
    }
}

// SAFETY: Inner 의 핸들은 커널 객체의 불투명한 번호이고, 바뀌는 상태는 모두 Mutex 가 묶는다.
unsafe impl Send for Inner {}
// SAFETY: 위와 같다.
unsafe impl Sync for Inner {}

struct WindowsTerminal(Arc<Inner>);

fn take(slot: &Mutex<Option<Arc<File>>>) -> io::Result<Arc<File>> {
    lock(slot).clone().ok_or_else(closed_error)
}

impl Terminal for WindowsTerminal {
    /// 깨진 파이프는 std 가 `Ok(0)`(끝)으로 준다.
    fn read(&self, buf: &mut [u8]) -> io::Result<usize> {
        let f = take(&self.0.output)?;
        (&*f).read(buf)
    }

    fn write(&self, buf: &[u8]) -> io::Result<usize> {
        let f = take(&self.0.input)?;
        (&*f).write_all(buf)?;
        Ok(buf.len())
    }

    fn close(&self) -> io::Result<()> {
        if self.0.closed.swap(true, Ordering::AcqRel) {
            return Ok(());
        }
        self.0.close_pseudo_console();
        lock(&self.0.input).take();
        lock(&self.0.output).take();
        close_handle(std::mem::take(&mut *lock(&self.0.thread)));
        Ok(())
    }

    fn resize(&self, cols: u16, rows: u16) -> io::Result<()> {
        let closed = lock(&self.0.hpc_closed);
        if *closed {
            return Err(io::Error::other("의사 콘솔이 닫혔습니다"));
        }
        // SAFETY: hpc 는 열려 있다(hpc_closed 잠금을 쥔 채다).
        let hr = unsafe { ResizePseudoConsole(self.0.hpc, coord(cols, rows)) };
        drop(closed);
        if hr != 0 {
            return Err(wrapped(
                "ResizePseudoConsole",
                &io::Error::from_raw_os_error(hr),
            ));
        }
        *lock(&self.0.size) = (cols, rows);
        Ok(())
    }

    fn size(&self) -> io::Result<(u16, u16)> {
        Ok(*lock(&self.0.size))
    }

    fn foreground_pgid(&self) -> Option<i32> {
        None
    }

    fn pid(&self) -> i32 {
        self.0.pid
    }

    fn wait(&self) -> io::Result<ExitStatus> {
        let mut exit = lock(&self.0.exit);
        loop {
            if let Some(code) = *exit {
                return Ok(ExitStatus::from_raw(code));
            }
            exit = self.0.exited.wait(exit).unwrap_or_else(|e| e.into_inner());
        }
    }

    fn terminate(&self) -> io::Result<()> {
        crate::process::current().terminate(self.0.pid)
    }

    fn kill(&self) -> io::Result<()> {
        crate::process::current().kill(self.0.pid)
    }

    fn handover(&self) -> Option<&dyn Handover> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resize_after_close_errors() {
        let t = WindowsTerminal(Arc::new(Inner {
            hpc: 0,
            hpc_closed: Mutex::new(true),
            input: Mutex::new(None),
            output: Mutex::new(None),
            thread: Mutex::new(0),
            pid: 0,
            size: Mutex::new((80, 24)),
            exit: Mutex::new(Some(0)),
            exited: Condvar::new(),
            closed: AtomicBool::new(false),
        }));
        assert!(t.resize(100, 40).is_err());
        assert_eq!(t.size().unwrap(), (80, 24), "실패한 resize 가 값을 바꿨다");
    }
}
