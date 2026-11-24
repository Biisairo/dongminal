//! 이 기계의 호스트 이름 (Go `os.Hostname`).

use std::io;

/// 커널이 알리는 호스트 이름이다. 실패 문구는 Go `*os.SyscallError` 와 같다.
pub fn hostname() -> io::Result<String> {
    sys::hostname()
}

#[cfg(unix)]
mod sys {
    use std::io;

    /// Go darwin 은 sysctl kern.hostname, linux 는 uname 의 nodename 이다. gethostname 이 둘과 같은
    /// 값을 낸다.
    const SYSCALL: &str = if cfg!(target_os = "linux") {
        "uname"
    } else {
        "sysctl kern.hostname"
    };
    /// 호스트 이름의 상한(MAXHOSTNAMELEN)에 끝의 NUL 한 칸이다.
    const BUF_LEN: usize = 257;

    pub(super) fn hostname() -> io::Result<String> {
        let mut buf = [0u8; BUF_LEN];
        // SAFETY: buf 는 BUF_LEN 바이트의 쓰기 가능한 지역 배열이고, 길이를 그대로 넘긴다.
        let r = unsafe { libc::gethostname(buf.as_mut_ptr().cast(), buf.len()) };
        if r != 0 {
            return Err(otter_gocompat::oserr::syscall_error(
                SYSCALL,
                io::Error::last_os_error(),
            ));
        }
        let n = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
        Ok(String::from_utf8_lossy(&buf[..n]).into_owned())
    }
}

#[cfg(windows)]
mod sys {
    use std::io;

    use windows_sys::Win32::Foundation::ERROR_MORE_DATA;
    use windows_sys::Win32::System::SystemInformation::{
        ComputerNamePhysicalDnsHostname, GetComputerNameExW,
    };

    const SYSCALL: &str = "ComputerNameEx";
    /// Go 가 처음 잡는 버퍼 길이(UTF-16 단위)다.
    const FIRST_LEN: u32 = 64;

    pub(super) fn hostname() -> io::Result<String> {
        let mut n = FIRST_LEN;
        loop {
            let mut b = vec![0u16; n as usize];
            let cap = n;
            // SAFETY: b 는 n 개의 u16 을 담는 버퍼이고, n 에 그 길이를 담아 넘긴다. 함수는 n 이하로만
            // 쓰고 n 을 쓴 길이(또는 필요한 길이)로 바꾼다.
            let ok = unsafe {
                GetComputerNameExW(ComputerNamePhysicalDnsHostname, b.as_mut_ptr(), &mut n)
            };
            if ok != 0 {
                let len = (n as usize).min(b.len());
                let end = b[..len].iter().position(|&c| c == 0).unwrap_or(len);
                return Ok(String::from_utf16_lossy(&b[..end]));
            }
            let err = io::Error::last_os_error();
            if err.raw_os_error() != Some(ERROR_MORE_DATA as i32) || n <= cap {
                return Err(otter_gocompat::oserr::syscall_error(SYSCALL, err));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hostname_is_not_empty() {
        let h = hostname().unwrap();
        assert!(!h.is_empty());
        assert!(!h.contains('\0'));
    }

    #[cfg(unix)]
    #[test]
    fn hostname_matches_hostname_command() {
        let out = std::process::Command::new("hostname").output().unwrap();
        assert!(out.status.success());
        assert_eq!(
            hostname().unwrap(),
            String::from_utf8_lossy(&out.stdout).trim_end()
        );
    }
}
