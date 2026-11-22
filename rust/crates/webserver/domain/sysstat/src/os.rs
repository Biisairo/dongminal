//! 플랫폼별 [`Reader`] 다. 이 crate 의 `unsafe` 는 전부 이 모듈에 있다 (C-RSP-4 예외).

use crate::Reader;

/// 이 플랫폼의 [`Reader`] 다.
pub fn new_reader() -> Box<dyn Reader> {
    Box::new(imp::OsReader)
}

/// statfs 로 디스크 사용률을 낸다 (FR-STAT-5).
#[cfg(any(target_os = "macos", target_os = "linux"))]
fn disk_percent_statfs(path: &str) -> Result<f64, crate::Error> {
    use crate::Error;
    let st = nix::sys::statfs::statfs(path)
        .map_err(|e| Error::Os(format!("statfs {path}: {}", e.desc().to_lowercase())))?;
    #[allow(clippy::useless_conversion, clippy::unnecessary_cast)]
    let blocks = st.blocks() as u64;
    #[allow(clippy::useless_conversion, clippy::unnecessary_cast)]
    let avail = st.blocks_available() as u64;
    if blocks == 0 {
        return Err(Error::Os(format!("statfs {path}: blocks=0")));
    }
    let used = blocks.wrapping_sub(avail);
    Ok((used as f64 / blocks as f64 * 1000.0).round() / 10.0)
}

#[cfg(target_os = "macos")]
mod imp {
    use std::sync::OnceLock;
    use std::time::SystemTime;

    use crate::procparse::{parse_sysctl_u64, unix_secs};
    use crate::{CpuTicks, Error, MemError, MemInfo, Reader};

    // libc 는 mach_host_self 를 deprecated 로 두고 host_page_size 는 싣지 않는다.
    // 둘 다 libSystem 의 공개 심볼이다.
    unsafe extern "C" {
        fn mach_host_self() -> libc::mach_port_t;
        fn host_page_size(
            host: libc::host_t,
            out_page_size: *mut libc::vm_size_t,
        ) -> libc::kern_return_t;
    }

    /// macOS 커널을 직접 읽는다. 외부 프로세스를 띄우지 않는다 (FR-STAT-6).
    pub(super) struct OsReader;

    /// host 포트다. mach_host_self 는 부를 때마다 send right 참조를 늘리므로 한 번만 얻는다
    /// (FR-ATF-45).
    fn mach_host() -> libc::host_t {
        static HOST: OnceLock<libc::host_t> = OnceLock::new();
        // SAFETY: mach_host_self 는 인자가 없고 늘 현재 host 의 포트 이름을 돌려준다.
        *HOST.get_or_init(|| unsafe { mach_host_self() })
    }

    fn sysctl_bytes(name: &std::ffi::CStr) -> Result<Vec<u8>, Error> {
        let label = name.to_string_lossy();
        let mut len: libc::size_t = 0;
        // SAFETY: oldp 가 널이면 커널은 필요한 길이만 len 에 쓴다. name 은 NUL 로 끝난다.
        let rc = unsafe {
            libc::sysctlbyname(
                name.as_ptr(),
                std::ptr::null_mut(),
                &mut len,
                std::ptr::null_mut(),
                0,
            )
        };
        if rc != 0 {
            return Err(Error::Os(format!(
                "sysctl {label}: {}",
                std::io::Error::last_os_error()
            )));
        }
        let mut buf = vec![0u8; len];
        // SAFETY: buf 는 len 바이트이고 커널은 그 안에서만 쓰고 실제 길이를 len 에 남긴다.
        let rc = unsafe {
            libc::sysctlbyname(
                name.as_ptr(),
                buf.as_mut_ptr().cast(),
                &mut len,
                std::ptr::null_mut(),
                0,
            )
        };
        if rc != 0 {
            return Err(Error::Os(format!(
                "sysctl {label}: {}",
                std::io::Error::last_os_error()
            )));
        }
        buf.truncate(len);
        Ok(buf)
    }

    fn mem_total() -> Result<u64, Error> {
        parse_sysctl_u64(&sysctl_bytes(c"hw.memsize")?)
    }

    /// host_statistics(HOST_CPU_LOAD_INFO) 의 누적 tick 이다.
    fn mach_cpu_ticks() -> Result<CpuTicks, Error> {
        let mut info = libc::host_cpu_load_info {
            cpu_ticks: [0; libc::CPU_STATE_MAX as usize],
        };
        let mut count = libc::HOST_CPU_LOAD_INFO_COUNT;
        // SAFETY: info 는 HOST_CPU_LOAD_INFO_COUNT 개의 integer_t 크기이고, count 가 그 크기를 알린다.
        let kr = unsafe {
            libc::host_statistics(
                mach_host(),
                libc::HOST_CPU_LOAD_INFO,
                (&raw mut info).cast(),
                &mut count,
            )
        };
        if kr != libc::KERN_SUCCESS {
            return Err(Error::Os(format!(
                "host_statistics(HOST_CPU_LOAD_INFO): kr={kr}"
            )));
        }
        let t = |i: libc::c_int| u64::from(info.cpu_ticks[i as usize]);
        Ok(CpuTicks {
            user: t(libc::CPU_STATE_USER),
            system: t(libc::CPU_STATE_SYSTEM),
            idle: t(libc::CPU_STATE_IDLE),
            nice: t(libc::CPU_STATE_NICE),
        })
    }

    /// 사용 중 바이트 = (wired + active + compressed) × 페이지 크기 (FR-STAT-15·16).
    fn mach_mem_used() -> Result<u64, Error> {
        // SAFETY: vm_statistics64 는 정수 필드만 있는 C 구조체라 0 으로 채운 값이 유효하다.
        let mut vm: libc::vm_statistics64 = unsafe { std::mem::zeroed() };
        let mut count = libc::HOST_VM_INFO64_COUNT;
        // SAFETY: vm 은 HOST_VM_INFO64_COUNT 개의 integer_t 크기이고, count 가 그 크기를 알린다.
        let kr = unsafe {
            libc::host_statistics64(
                mach_host(),
                libc::HOST_VM_INFO64,
                (&raw mut vm).cast(),
                &mut count,
            )
        };
        if kr != libc::KERN_SUCCESS {
            return Err(Error::Os(format!(
                "host_statistics64(HOST_VM_INFO64): kr={kr}"
            )));
        }
        let mut ps: libc::vm_size_t = 0;
        // SAFETY: ps 는 쓰기 가능한 vm_size_t 하나다.
        let kr = unsafe { host_page_size(mach_host(), &mut ps) };
        if kr != libc::KERN_SUCCESS {
            return Err(Error::Os(format!("host_page_size: kr={kr}")));
        }
        if ps == 0 {
            return Err(Error::Os("host_page_size: 0".to_owned()));
        }
        let pages = u64::from(vm.wire_count)
            + u64::from(vm.active_count)
            + u64::from(vm.compressor_page_count);
        Ok(pages.wrapping_mul(ps as u64))
    }

    impl Reader for OsReader {
        fn cpu_ticks(&self) -> Result<CpuTicks, Error> {
            mach_cpu_ticks()
        }

        fn mem(&self) -> Result<MemInfo, MemError> {
            let total = mem_total().map_err(|error| MemError { total: 0, error })?;
            let used = mach_mem_used().map_err(|error| MemError { total, error })?;
            Ok(MemInfo {
                total,
                used: used.min(total),
            })
        }

        /// kern.boottime(struct timeval)의 tv_sec 다. 32비트 tv_sec 인 응답도 받는다.
        fn boot_time(&self) -> Result<SystemTime, Error> {
            let b = sysctl_bytes(c"kern.boottime")?;
            if b.len() < 4 {
                return Err(Error::Os(format!(
                    "sysctl kern.boottime: 응답이 {} 바이트",
                    b.len()
                )));
            }
            let sec = if b.len() >= 8 {
                parse_sysctl_u64(&b[..8])? as i64
            } else {
                i64::from(u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
            };
            if sec <= 0 {
                return Err(Error::Os(format!("sysctl kern.boottime: tv_sec={sec}")));
            }
            Ok(unix_secs(sec))
        }

        fn disk_percent(&self, path: &str) -> Result<f64, Error> {
            super::disk_percent_statfs(path)
        }
    }
}

#[cfg(target_os = "linux")]
mod imp {
    use std::time::SystemTime;

    use crate::procparse::{parse_proc_meminfo, parse_proc_stat_boot_time, parse_proc_stat_cpu};
    use crate::{CpuTicks, Error, MemError, MemInfo, Reader};

    const PROC_STAT_PATH: &str = "/proc/stat";
    const PROC_MEMINFO_PATH: &str = "/proc/meminfo";

    /// /proc 과 statfs 로 읽는다 (FR-XSY-2).
    pub(super) struct OsReader;

    fn read(path: &str) -> Result<String, Error> {
        std::fs::read_to_string(path).map_err(|e| Error::Os(format!("open {path}: {e}")))
    }

    impl Reader for OsReader {
        fn cpu_ticks(&self) -> Result<CpuTicks, Error> {
            parse_proc_stat_cpu(&read(PROC_STAT_PATH)?)
        }

        fn mem(&self) -> Result<MemInfo, MemError> {
            read(PROC_MEMINFO_PATH)
                .and_then(|s| parse_proc_meminfo(&s))
                .map_err(|error| MemError { total: 0, error })
        }

        fn boot_time(&self) -> Result<SystemTime, Error> {
            parse_proc_stat_boot_time(&read(PROC_STAT_PATH)?)
        }

        fn disk_percent(&self, path: &str) -> Result<f64, Error> {
            super::disk_percent_statfs(path)
        }
    }
}

#[cfg(windows)]
mod imp {
    use std::time::{Duration, SystemTime};

    use windows_sys::Win32::Foundation::FILETIME;
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    use windows_sys::Win32::System::SystemInformation::{
        GetTickCount64, GlobalMemoryStatusEx, MEMORYSTATUSEX,
    };
    use windows_sys::Win32::System::Threading::GetSystemTimes;

    use crate::{CpuTicks, Error, MemError, MemInfo, Reader};

    /// WinAPI 로 직접 읽는다 (FR-XSY-3).
    pub(super) struct OsReader;

    fn ticks(ft: FILETIME) -> u64 {
        (u64::from(ft.dwHighDateTime) << 32) | u64::from(ft.dwLowDateTime)
    }

    fn last_error(what: &str) -> Error {
        Error::Os(format!("{what}: {}", std::io::Error::last_os_error()))
    }

    impl Reader for OsReader {
        /// GetSystemTimes 의 누적 시간(100ns)을 tick 으로 쓴다. kernel 에 idle 이 들어 있으므로 뺀다.
        fn cpu_ticks(&self) -> Result<CpuTicks, Error> {
            let z = FILETIME {
                dwLowDateTime: 0,
                dwHighDateTime: 0,
            };
            let (mut idle, mut kernel, mut user) = (z, z, z);
            // SAFETY: 세 포인터 모두 쓰기 가능한 FILETIME 하나씩을 가리킨다.
            let ok = unsafe { GetSystemTimes(&mut idle, &mut kernel, &mut user) };
            if ok == 0 {
                return Err(last_error("GetSystemTimes"));
            }
            let (idle, kernel) = (ticks(idle), ticks(kernel));
            if kernel < idle {
                return Err(Error::Os("GetSystemTimes: kernel < idle".to_owned()));
            }
            Ok(CpuTicks {
                user: ticks(user),
                system: kernel - idle,
                idle,
                nice: 0,
            })
        }

        /// GlobalMemoryStatusEx 의 "사용 가능" 을 그대로 믿는다 (FR-XSY-4).
        fn mem(&self) -> Result<MemInfo, MemError> {
            // SAFETY: MEMORYSTATUSEX 는 정수 필드만 있는 C 구조체라 0 으로 채운 값이 유효하다.
            let mut st: MEMORYSTATUSEX = unsafe { std::mem::zeroed() };
            st.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
            // SAFETY: st 는 dwLength 를 채운 MEMORYSTATUSEX 다.
            let ok = unsafe { GlobalMemoryStatusEx(&mut st) };
            if ok == 0 {
                return Err(MemError {
                    total: 0,
                    error: last_error("GlobalMemoryStatusEx"),
                });
            }
            if st.ullTotalPhys == 0 {
                return Err(MemError {
                    total: 0,
                    error: Error::Os("GlobalMemoryStatusEx: total=0".to_owned()),
                });
            }
            let used = if st.ullAvailPhys < st.ullTotalPhys {
                st.ullTotalPhys - st.ullAvailPhys
            } else {
                st.ullTotalPhys
            };
            Ok(MemInfo {
                total: st.ullTotalPhys,
                used,
            })
        }

        /// 가동 시간을 지금에서 뺀다. 부팅 시각을 직접 주는 API 가 없다.
        fn boot_time(&self) -> Result<SystemTime, Error> {
            // SAFETY: 인자가 없는 순수 조회다.
            let ms = unsafe { GetTickCount64() };
            if ms == 0 {
                return Err(Error::Os("GetTickCount64: 0".to_owned()));
            }
            Ok(SystemTime::now() - Duration::from_millis(ms))
        }

        /// 분모는 전체, 남은 양은 **호출자가 쓸 수 있는** 양이다 (할당량 계정).
        fn disk_percent(&self, path: &str) -> Result<f64, Error> {
            if path.contains('\0') {
                return Err(Error::Os(format!("경로 변환 {path}: invalid argument")));
            }
            let wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
            let (mut free_caller, mut total, mut free) = (0u64, 0u64, 0u64);
            // SAFETY: wide 는 NUL 로 끝나는 UTF-16 이고, 세 출력 포인터는 쓰기 가능한 u64 다.
            let ok = unsafe {
                GetDiskFreeSpaceExW(wide.as_ptr(), &mut free_caller, &mut total, &mut free)
            };
            if ok == 0 {
                return Err(last_error(&format!("GetDiskFreeSpaceEx {path}")));
            }
            if total == 0 {
                return Err(Error::Os(format!("GetDiskFreeSpaceEx {path}: total=0")));
            }
            let used = total.wrapping_sub(free_caller);
            Ok((used as f64 / total as f64 * 1000.0).round() / 10.0)
        }
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
mod imp {
    use std::time::SystemTime;

    use crate::{CpuTicks, Error, MemError, MemInfo, Reader};

    /// 지원하지 않는 플랫폼이다. 모든 지표가 [`Error::Unsupported`] 다.
    pub(super) struct OsReader;

    impl Reader for OsReader {
        fn cpu_ticks(&self) -> Result<CpuTicks, Error> {
            Err(Error::Unsupported)
        }
        fn mem(&self) -> Result<MemInfo, MemError> {
            Err(MemError {
                total: 0,
                error: Error::Unsupported,
            })
        }
        fn boot_time(&self) -> Result<SystemTime, Error> {
            Err(Error::Unsupported)
        }
        fn disk_percent(&self, _: &str) -> Result<f64, Error> {
            Err(Error::Unsupported)
        }
    }
}
