//! Go `net.Listen("tcp", addr)` 의 주소 계열 판정이다 (`net/ipsock_posix.go`).
//!
//! 와일드카드(빈 호스트·`0.0.0.0`·`::`)는 IPv4-mapped 를 지원하면 `[::]` 에 IPV6_V6ONLY=0 으로
//! 이중 스택 리슨한다. IPV6_V6ONLY 는 플랫폼 기본값(Windows 는 켜짐)에 기대지 않고 명시한다.

use std::io;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, TcpListener, ToSocketAddrs};
use std::sync::OnceLock;

use socket2::{Domain, Protocol, Socket, Type};

/// Go `syscall.SOMAXCONN`(Windows)·`somaxconn`(unix) 자리다. 커널이 상한으로 줄인다.
const LISTEN_BACKLOG: i32 = i32::MAX;

/// Go `sockopt_bsd.go` 는 IPv4-mapped 를 지원할 때만 IPV6_V6ONLY 를 건드린다.
const V6ONLY_NEEDS_IPV4MAP: bool = cfg!(any(
    target_os = "macos",
    target_os = "ios",
    target_os = "freebsd",
    target_os = "netbsd",
    target_os = "openbsd",
    target_os = "dragonfly"
));

/// Go `supportsIPv4map` 가 탐지 없이 거짓을 주는 OS 다.
const NO_IPV4MAP_OS: bool = cfg!(any(target_os = "openbsd", target_os = "dragonfly"));

/// Go `ipStackCapabilities`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct IpStackCaps {
    pub(crate) ipv4: bool,
    pub(crate) ipv6: bool,
    pub(crate) ipv4map: bool,
}

/// 소켓 하나를 어떻게 열지다. `addr` 가 IPv6 면 AF_INET6 이다.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct ListenPlan {
    pub(crate) addr: SocketAddr,
    /// `None` 이면 IPV6_V6ONLY 를 건드리지 않는다.
    pub(crate) v6only: Option<bool>,
}

/// Go `ipStackCaps.probe` 의 결과다. 한 번만 잰다 (Go `sync.Once`).
pub(crate) fn ip_stack_caps() -> IpStackCaps {
    static CAPS: OnceLock<IpStackCaps> = OnceLock::new();
    *CAPS.get_or_init(probe)
}

fn probe() -> IpStackCaps {
    let ipv4 = Socket::new(Domain::IPV4, Type::STREAM, Some(Protocol::TCP)).is_ok();
    let ipv6 = probe_v6(Ipv6Addr::LOCALHOST, true);
    let ipv4map = !NO_IPV4MAP_OS && probe_v6(Ipv4Addr::LOCALHOST.to_ipv6_mapped(), false);
    IpStackCaps {
        ipv4,
        ipv6,
        ipv4map,
    }
}

fn probe_v6(ip: Ipv6Addr, v6only: bool) -> bool {
    let Ok(s) = Socket::new(Domain::IPV6, Type::STREAM, Some(Protocol::TCP)) else {
        return false;
    };
    let _ = s.set_only_v6(v6only);
    probe_bind_ok(&s.bind(&SocketAddr::new(IpAddr::V6(ip), 0).into()))
}

/// 보안 정책(BPF·seccomp·SELinux)이 막은 바인드는 지원으로 본다 (go.dev/issue/77430).
/// Go 의 `syscall.EPERM`·`EACCES` 는 Windows 의 WSAEACCES 와 다른 값이라 Windows 에서는 맞지 않는다.
pub(crate) fn probe_bind_ok(res: &io::Result<()>) -> bool {
    match res {
        Ok(()) => true,
        Err(e) => cfg!(unix) && e.kind() == io::ErrorKind::PermissionDenied,
    }
}

/// Go `favoriteAddrFamily(network="tcp", mode="listen")` 와 `ipToSockaddr` 다.
/// `ip` 가 `None` 이면 빈 호스트다.
pub(crate) fn listen_plan(ip: Option<IpAddr>, port: u16, caps: IpStackCaps) -> ListenPlan {
    let ip = ip.map(|i| i.to_canonical());
    let wildcard = ip.is_none_or(|i| i.is_unspecified());
    let v6 = if wildcard && (caps.ipv4map || !caps.ipv4) {
        true
    } else {
        matches!(ip, Some(IpAddr::V6(_)))
    };
    if !v6 {
        let a = match ip {
            Some(IpAddr::V4(a)) => a,
            _ => Ipv4Addr::UNSPECIFIED,
        };
        return ListenPlan {
            addr: SocketAddr::new(IpAddr::V4(a), port),
            v6only: None,
        };
    }
    let a = match ip {
        Some(IpAddr::V6(a)) => a,
        _ => Ipv6Addr::UNSPECIFIED,
    };
    ListenPlan {
        addr: SocketAddr::new(IpAddr::V6(a), port),
        v6only: (!V6ONLY_NEEDS_IPV4MAP || caps.ipv4map).then_some(false),
    }
}

/// Go `net.Listen("tcp", addr)`. 이름 호스트는 풀어서 첫 IPv4(없으면 첫 주소)를 쓴다.
///
/// 실패하면 bind·listen 의 `io::Error` 를 그대로 준다. Go `net.OpError` 꼴(`listen tcp {addr}: ...`)의
/// 포장은 호출자가 한다. 돌려주는 리스너는 블로킹이다 — 비동기 쪽은 호출자가 `from_std` 한다.
pub fn listen_tcp(addr: &str) -> io::Result<TcpListener> {
    let Some((host, port)) = split_host_port(addr) else {
        return TcpListener::bind(addr);
    };
    let Ok(port) = port.parse::<u16>() else {
        return TcpListener::bind(addr);
    };
    let ip = if host.is_empty() {
        None
    } else if let Ok(ip) = host.parse::<IpAddr>() {
        Some(ip)
    } else {
        let addrs: Vec<SocketAddr> = (host, port).to_socket_addrs()?.collect();
        match addrs.iter().find(|a| a.is_ipv4()).or(addrs.first()) {
            Some(a) => Some(a.ip()),
            None => return TcpListener::bind(addr),
        }
    };
    open(&listen_plan(ip, port, ip_stack_caps()))
}

fn open(plan: &ListenPlan) -> io::Result<TcpListener> {
    let domain = if plan.addr.is_ipv6() {
        Domain::IPV6
    } else {
        Domain::IPV4
    };
    let s = Socket::new(domain, Type::STREAM, Some(Protocol::TCP))?;
    if let Some(v6only) = plan.v6only {
        // Go 도 이 setsockopt 의 실패를 버린다.
        let _ = s.set_only_v6(v6only);
    }
    // Go `setDefaultListenerSockopts`: unix 만 SO_REUSEADDR 를 켠다.
    #[cfg(unix)]
    s.set_reuse_address(true)?;
    s.bind(&plan.addr.into())?;
    s.listen(LISTEN_BACKLOG)?;
    Ok(s.into())
}

/// Go 는 IPv4-mapped 주소를 IPv4 로 보인다(`IP.String`). 이중 스택 리스너가 받은 주소를 맞춘다.
pub fn canonical_addr(a: SocketAddr) -> SocketAddr {
    match a {
        SocketAddr::V6(v6) => match v6.ip().to_ipv4_mapped() {
            Some(v4) => SocketAddr::new(IpAddr::V4(v4), v6.port()),
            None => a,
        },
        SocketAddr::V4(_) => a,
    }
}

/// Go `net.SplitHostPort`. 오류면 `None` 이다.
fn split_host_port(hostport: &str) -> Option<(&str, &str)> {
    let i = hostport.rfind(':')?;
    let host = if hostport.starts_with('[') {
        let end = hostport.find(']')?;
        if end + 1 == hostport.len() || end + 1 != i {
            return None;
        }
        &hostport[1..end]
    } else {
        let host = &hostport[..i];
        if host.contains(':') {
            return None;
        }
        host
    };
    if host.contains(['[', ']']) || hostport[i + 1..].contains(['[', ']']) {
        return None;
    }
    Some((host, &hostport[i + 1..]))
}

#[cfg(test)]
mod tests;
