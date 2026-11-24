//! 이 기계의 인터페이스 주소 (Go `net.InterfaceAddrs`).

use std::io;
use std::net::IpAddr;

/// 모든 인터페이스(꺼진 것 포함)의 IPv4·IPv6 주소다. IPv6 링크 로컬 주소에 커널이 끼워 넣은
/// 범위 번호는 Go 처럼 지운다.
pub fn interface_addrs() -> io::Result<Vec<IpAddr>> {
    sys::interface_addrs()
}

#[cfg(unix)]
mod sys {
    use std::io;
    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

    /// 실패 문구의 머리다. Go 는 `*net.OpError{Op: "route", Net: "ip+net"}` 로 감싼다.
    const SYSCALL: &str = if cfg!(target_os = "linux") {
        "route ip+net: netlinkrib"
    } else {
        "route ip+net: sysctl"
    };

    pub(super) fn interface_addrs() -> io::Result<Vec<IpAddr>> {
        let mut head: *mut libc::ifaddrs = std::ptr::null_mut();
        // SAFETY: head 는 지역 포인터이고, 성공하면 커널이 할당한 목록의 머리를 받는다. 아래에서
        // freeifaddrs 로 한 번만 놓는다.
        if unsafe { libc::getifaddrs(&mut head) } != 0 {
            return Err(otter_gocompat::oserr::syscall_error(
                SYSCALL,
                io::Error::last_os_error(),
            ));
        }
        let mut out = Vec::new();
        let mut cur = head;
        while !cur.is_null() {
            // SAFETY: cur 는 getifaddrs 가 준 목록의 null 이 아닌 원소이고, freeifaddrs 전까지 살아 있다.
            let ifa = unsafe { &*cur };
            if let Some(ip) = sockaddr_ip(ifa.ifa_addr) {
                out.push(ip);
            }
            cur = ifa.ifa_next;
        }
        // SAFETY: head 는 getifaddrs 가 성공해 준 목록의 머리다. 이 뒤로 목록을 읽지 않는다.
        unsafe { libc::freeifaddrs(head) };
        Ok(out)
    }

    fn sockaddr_ip(sa: *const libc::sockaddr) -> Option<IpAddr> {
        if sa.is_null() {
            return None;
        }
        // SAFETY: sa 는 getifaddrs 원소의 null 이 아닌 주소이며 최소 sockaddr 크기다.
        let family = i32::from(unsafe { (*sa).sa_family });
        match family {
            libc::AF_INET => {
                // SAFETY: family 가 AF_INET 이면 sa 는 sockaddr_in 을 가리킨다.
                let sin = unsafe { &*sa.cast::<libc::sockaddr_in>() };
                Some(IpAddr::V4(Ipv4Addr::from(u32::from_be(
                    sin.sin_addr.s_addr,
                ))))
            }
            libc::AF_INET6 => {
                // SAFETY: family 가 AF_INET6 이면 sa 는 sockaddr_in6 을 가리킨다.
                let sin6 = unsafe { &*sa.cast::<libc::sockaddr_in6>() };
                let mut b = sin6.sin6_addr.s6_addr;
                clear_embedded_scope(&mut b);
                Some(IpAddr::V6(Ipv6Addr::from(b)))
            }
            _ => None,
        }
    }

    /// BSD 계열 커널은 링크 로컬·인터페이스 로컬 주소의 3·4번째 바이트에 범위 번호를 끼워 둔다.
    /// Go 는 그 자리를 0 으로 지운다(linux 는 끼우지 않는다).
    fn clear_embedded_scope(b: &mut [u8; 16]) {
        if cfg!(target_os = "linux") {
            return;
        }
        let link_local_unicast = b[0] == 0xfe && b[1] & 0xc0 == 0x80;
        let local_multicast = b[0] == 0xff && (b[1] == 0x01 || b[1] & 0x0f == 0x02);
        if link_local_unicast || local_multicast {
            b[2] = 0;
            b[3] = 0;
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn embedded_scope_cleared_off_linux() {
            let mut b = [0xfe, 0x80, 0x00, 0x04, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1];
            clear_embedded_scope(&mut b);
            let want = if cfg!(target_os = "linux") {
                0x04
            } else {
                0x00
            };
            assert_eq!(b[3], want);
            let mut g = [0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1];
            clear_embedded_scope(&mut g);
            assert_eq!(g[2..4], [0x0d, 0xb8]);
        }
    }
}

#[cfg(windows)]
mod sys {
    use std::io;
    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

    use windows_sys::Win32::Foundation::{ERROR_BUFFER_OVERFLOW, ERROR_SUCCESS};
    use windows_sys::Win32::NetworkManagement::IpHelper::{
        GAA_FLAG_INCLUDE_PREFIX, GetAdaptersAddresses, IP_ADAPTER_ADDRESSES_LH,
    };
    use windows_sys::Win32::Networking::WinSock::{
        AF_INET, AF_INET6, AF_UNSPEC, SOCKADDR, SOCKADDR_IN, SOCKADDR_IN6,
    };

    const SYSCALL: &str = "route ip+net: getadaptersaddresses";
    /// Go 가 처음 잡는 버퍼 크기(바이트)다.
    const FIRST_LEN: u32 = 15000;

    pub(super) fn interface_addrs() -> io::Result<Vec<IpAddr>> {
        let mut len = FIRST_LEN;
        let buf = loop {
            // IP_ADAPTER_ADDRESSES_LH 의 정렬(8)을 지키려 u64 로 잡는다.
            let mut buf = vec![0u64; (len as usize).div_ceil(8)];
            // SAFETY: buf 는 len 바이트 이상의 쓰기 가능한 버퍼이고 len 에 그 크기를 담아 넘긴다.
            let r = unsafe {
                GetAdaptersAddresses(
                    u32::from(AF_UNSPEC),
                    GAA_FLAG_INCLUDE_PREFIX,
                    std::ptr::null(),
                    buf.as_mut_ptr().cast(),
                    &mut len,
                )
            };
            if r == ERROR_SUCCESS {
                if len == 0 {
                    return Ok(Vec::new());
                }
                break buf;
            }
            if r != ERROR_BUFFER_OVERFLOW {
                return Err(otter_gocompat::oserr::syscall_error(
                    SYSCALL,
                    io::Error::from_raw_os_error(r as i32),
                ));
            }
        };
        let mut out = Vec::new();
        let mut aa = buf.as_ptr().cast::<IP_ADAPTER_ADDRESSES_LH>();
        while !aa.is_null() {
            // SAFETY: aa 는 buf 안의 어댑터 목록 원소이고 buf 가 살아 있는 동안 유효하다.
            let a = unsafe { &*aa };
            let mut uni = a.FirstUnicastAddress;
            while !uni.is_null() {
                // SAFETY: 같은 buf 안의 단일 주소 목록 원소다.
                let u = unsafe { &*uni };
                if let Some(ip) = sockaddr_ip(u.Address.lpSockaddr) {
                    out.push(ip);
                }
                uni = u.Next;
            }
            let mut any = a.FirstAnycastAddress;
            while !any.is_null() {
                // SAFETY: 같은 buf 안의 애니캐스트 주소 목록 원소다.
                let n = unsafe { &*any };
                if let Some(ip) = sockaddr_ip(n.Address.lpSockaddr) {
                    out.push(ip);
                }
                any = n.Next;
            }
            aa = a.Next;
        }
        Ok(out)
    }

    fn sockaddr_ip(sa: *const SOCKADDR) -> Option<IpAddr> {
        if sa.is_null() {
            return None;
        }
        // SAFETY: sa 는 GetAdaptersAddresses 가 채운 null 이 아닌 소켓 주소다.
        match unsafe { (*sa).sa_family } {
            AF_INET => {
                // SAFETY: 주소 체계가 AF_INET 이면 SOCKADDR_IN 이다.
                let sin = unsafe { &*sa.cast::<SOCKADDR_IN>() };
                // SAFETY: S_un 의 어느 갈래든 같은 4바이트다.
                let v = unsafe { sin.sin_addr.S_un.S_addr };
                Some(IpAddr::V4(Ipv4Addr::from(u32::from_be(v))))
            }
            AF_INET6 => {
                // SAFETY: 주소 체계가 AF_INET6 이면 SOCKADDR_IN6 이다.
                let sin6 = unsafe { &*sa.cast::<SOCKADDR_IN6>() };
                // SAFETY: u 의 어느 갈래든 같은 16바이트다.
                let b = unsafe { sin6.sin6_addr.u.Byte };
                Some(IpAddr::V6(Ipv6Addr::from(b)))
            }
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn includes_loopback() {
        let addrs = interface_addrs().unwrap();
        assert!(addrs.iter().any(|a| a.is_loopback()), "{addrs:?}");
    }
}
