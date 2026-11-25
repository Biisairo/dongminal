//! 커널 프로세스 표를 libproc·sysctl 로 읽는다 (FR-XPI-3). 외부 프로세스를 띄우지 않는다.

use std::ffi::{c_int, c_uint, c_void};
use std::mem::{MaybeUninit, size_of};
use std::ptr;

use super::{Kernel, parse_procargs_argv0};

pub(crate) struct Libproc;

/// pid 목록 버퍼에 더하는 여유 칸 — 크기를 물은 뒤 읽기 전에 생긴 프로세스를 담는다.
const PID_LIST_SLACK: usize = 64;
/// pid 목록이 버퍼를 꽉 채웠을 때 버퍼를 두 배로 늘려 다시 읽는 최대 횟수.
const PID_LIST_RETRIES: usize = 4;

/// `fill(buf, bytes)` 는 libproc 의 pid 목록 함수다. 널 버퍼면 대략의 개수를, 아니면 채운 개수를
/// 돌려주고 실패는 음수다. 버퍼가 꽉 찼으면 잘렸을 수 있어 늘려 다시 읽는다.
fn list_pids(fill: impl Fn(*mut c_void, c_int) -> c_int) -> Option<Vec<i32>> {
    let hint = usize::try_from(fill(ptr::null_mut(), 0)).ok()?;
    let mut cap = hint + PID_LIST_SLACK;
    for _ in 0..PID_LIST_RETRIES {
        let mut buf: Vec<libc::pid_t> = vec![0; cap];
        let bytes = c_int::try_from(cap * size_of::<libc::pid_t>()).ok()?;
        let n = usize::try_from(fill(buf.as_mut_ptr().cast(), bytes)).ok()?;
        if n < cap {
            buf.truncate(n);
            return Some(buf);
        }
        cap *= 2;
    }
    None
}

/// `proc_pidinfo` 로 구조체 하나를 읽는다. 반환 크기가 구조체 크기와 다르면 실패다.
fn pid_info<T>(pid: i32, flavor: c_int) -> Option<T> {
    let size = c_int::try_from(size_of::<T>()).ok()?;
    let mut out = MaybeUninit::<T>::zeroed();
    // SAFETY: out 은 size 바이트의 쓰기 가능한 버퍼다. 커널은 buffersize 를 넘겨 쓰지 않는다.
    let n = unsafe { libc::proc_pidinfo(pid, flavor, 0, out.as_mut_ptr().cast(), size) };
    if n != size {
        return None;
    }
    // SAFETY: 커널이 구조체 전부(size 바이트)를 채웠다. 쓰는 구조체는 모두 정수·바이트 배열뿐이다.
    Some(unsafe { out.assume_init() })
}

/// `ps` 처럼 `KERN_PROCARGS2` 에서 argv[0] 를 읽는다. 다른 사용자의 보호된 프로세스는 거절된다.
fn argv0(pid: i32) -> Option<String> {
    let mut mib = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid];
    let mib_len = c_uint::try_from(mib.len()).ok()?;
    let mut size: libc::size_t = 0;
    // SAFETY: 출력 버퍼가 널이면 커널은 필요한 크기만 size 에 쓴다.
    let rc = unsafe {
        libc::sysctl(
            mib.as_mut_ptr(),
            mib_len,
            ptr::null_mut(),
            &mut size,
            ptr::null_mut(),
            0,
        )
    };
    if rc != 0 || size == 0 {
        return None;
    }
    let mut buf = vec![0u8; size];
    // SAFETY: buf 는 size 바이트다. 커널은 size 를 넘겨 쓰지 않고 실제로 쓴 길이를 size 에 돌려준다.
    let rc = unsafe {
        libc::sysctl(
            mib.as_mut_ptr(),
            mib_len,
            buf.as_mut_ptr().cast(),
            &mut size,
            ptr::null_mut(),
            0,
        )
    };
    if rc != 0 {
        return None;
    }
    buf.truncate(size);
    parse_procargs_argv0(&buf).filter(|s| !s.is_empty())
}

/// 커널의 프로세스 이름(`p_comm`, 16바이트까지). argv[0] 를 읽지 못할 때의 물러섬이다 —
/// 다른 사용자의 프로세스는 argv 도 `proc_name` 도 거절되지만 이 정보는 읽힌다.
fn comm(pid: i32) -> Option<String> {
    let info: libc::proc_bsdshortinfo = pid_info(pid, libc::PROC_PIDT_SHORTBSDINFO)?;
    let name: Vec<u8> = info
        .pbsi_comm
        .iter()
        .map(|c| c.to_ne_bytes()[0])
        .take_while(|&b| b != 0)
        .collect();
    (!name.is_empty()).then(|| String::from_utf8_lossy(&name).into_owned())
}

impl Kernel for Libproc {
    fn name(&self, pid: i32) -> Option<String> {
        argv0(pid).or_else(|| comm(pid))
    }

    fn cwd(&self, pid: i32) -> Option<String> {
        let info: libc::proc_vnodepathinfo = pid_info(pid, libc::PROC_PIDVNODEPATHINFO)?;
        let path: Vec<u8> = info
            .pvi_cdir
            .vip_path
            .iter()
            .flatten()
            .map(|c| c.to_ne_bytes()[0])
            .take_while(|&b| b != 0)
            .collect();
        (!path.is_empty()).then(|| String::from_utf8_lossy(&path).into_owned())
    }

    fn parent(&self, pid: i32) -> Option<i32> {
        let info: libc::proc_bsdshortinfo = pid_info(pid, libc::PROC_PIDT_SHORTBSDINFO)?;
        i32::try_from(info.pbsi_ppid).ok()
    }

    fn pids(&self) -> Option<Vec<i32>> {
        // SAFETY: list_pids 가 건네는 buf 는 bytes 바이트이거나 널(bytes 0)이다.
        list_pids(|buf, bytes| unsafe { libc::proc_listallpids(buf, bytes) })
    }

    fn children(&self, pid: i32) -> Option<Vec<i32>> {
        // SAFETY: list_pids 가 건네는 buf 는 bytes 바이트이거나 널(bytes 0)이다.
        list_pids(|buf, bytes| unsafe { libc::proc_listchildpids(pid, buf, bytes) })
    }
}
