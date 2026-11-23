use std::io;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, TcpStream};
use std::sync::atomic::{AtomicU16, Ordering};

use super::*;

/// 운영 범위(60147 미만)를 피한다.
const PORT_LO: u16 = 64000;
const PORT_HI: u16 = 64500;

static NEXT_PORT: AtomicU16 = AtomicU16::new(0);

fn next_port() -> u16 {
    let _ = NEXT_PORT.compare_exchange(
        0,
        PORT_LO + (std::process::id() % 300) as u16,
        Ordering::SeqCst,
        Ordering::SeqCst,
    );
    let p = NEXT_PORT.fetch_add(1, Ordering::SeqCst);
    if p >= PORT_HI {
        NEXT_PORT.store(PORT_LO + 1, Ordering::SeqCst);
        return PORT_LO;
    }
    p
}

/// 빈 포트를 찾을 때까지 `host:port` 로 리슨한다.
fn listen_free(host: &str) -> (u16, TcpListener) {
    for _ in 0..(PORT_HI - PORT_LO) {
        let p = next_port();
        let addr = if host.contains(':') {
            format!("[{host}]:{p}")
        } else {
            format!("{host}:{p}")
        };
        if let Ok(ln) = listen_tcp(&addr) {
            return (p, ln);
        }
    }
    panic!("{host} 에 빈 포트로 리슨하지 못했다");
}

fn caps(ipv4: bool, ipv6: bool, ipv4map: bool) -> IpStackCaps {
    IpStackCaps {
        ipv4,
        ipv6,
        ipv4map,
    }
}

/// Go `favoriteAddrFamily(tcp, listen)` + `ipToSockaddr`.
#[test]
fn listen_plan_table() {
    let v4 = |s: &str| Some(s.parse::<IpAddr>().unwrap());
    let any6 = SocketAddr::new(IpAddr::V6(Ipv6Addr::UNSPECIFIED), 65001);
    let any4 = SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), 65001);
    let bsd = V6ONLY_NEEDS_IPV4MAP;
    let full = caps(true, true, true);
    let nomap = caps(true, true, false);
    let no4 = caps(false, true, false);

    // 와일드카드는 IPv4-mapped 를 지원하면 [::] 이중 스택이다 — 명시한 0.0.0.0 도 그렇다.
    for host in [None, v4("0.0.0.0"), v4("::"), v4("::ffff:0.0.0.0")] {
        let p = listen_plan(host, 65001, full);
        assert_eq!(p.addr, any6, "{host:?}");
        assert_eq!(p.v6only, Some(false), "{host:?}");
    }
    // IPv4-mapped 가 없으면 빈 호스트와 0.0.0.0 은 IPv4 로 떨어진다.
    for host in [None, v4("0.0.0.0"), v4("::ffff:0.0.0.0")] {
        let p = listen_plan(host, 65001, nomap);
        assert_eq!(p.addr, any4, "{host:?}");
        assert_eq!(p.v6only, None, "{host:?}");
    }
    // `::` 는 제 계열(AF_INET6)을 지킨다. BSD 는 이때 IPV6_V6ONLY 를 건드리지 않는다.
    let p = listen_plan(v4("::"), 65001, nomap);
    assert_eq!(p.addr, any6);
    assert_eq!(p.v6only, (!bsd).then_some(false));
    // IPv4 가 없으면 IPv6 와일드카드다.
    let p = listen_plan(None, 65001, no4);
    assert_eq!(p.addr, any6);
    assert_eq!(p.v6only, (!bsd).then_some(false));
    // 와일드카드가 아니면 주소의 계열이다. 4in6 은 IPv4 다.
    let p = listen_plan(v4("127.0.0.1"), 65001, full);
    assert_eq!(p.addr, "127.0.0.1:65001".parse().unwrap());
    assert_eq!(p.v6only, None);
    let p = listen_plan(v4("::ffff:127.0.0.1"), 65001, full);
    assert_eq!(p.addr, "127.0.0.1:65001".parse().unwrap());
    let p = listen_plan(v4("::1"), 65001, full);
    assert_eq!(p.addr, "[::1]:65001".parse().unwrap());
    assert_eq!(p.v6only, Some(false));
}

#[test]
fn probe_bind_ok_table() {
    assert!(probe_bind_ok(&Ok(())));
    assert!(!probe_bind_ok(&Err(io::Error::from(
        io::ErrorKind::AddrNotAvailable
    ))));
    assert_eq!(
        probe_bind_ok(&Err(io::Error::from(io::ErrorKind::PermissionDenied))),
        cfg!(unix)
    );
}

#[test]
fn canonical_addr_unmaps_4in6() {
    let a = |s: &str| s.parse::<SocketAddr>().unwrap();
    assert_eq!(
        canonical_addr(a("[::ffff:127.0.0.1]:65001")),
        a("127.0.0.1:65001")
    );
    assert_eq!(canonical_addr(a("[::1]:65001")), a("[::1]:65001"));
    assert_eq!(canonical_addr(a("127.0.0.1:65001")), a("127.0.0.1:65001"));
}

/// Go `net.SplitHostPort` 의 성공·실패 표.
#[test]
fn split_host_port_table() {
    for (in_, want) in [
        (":9911", Some(("", "9911"))),
        ("127.0.0.1:9911", Some(("127.0.0.1", "9911"))),
        ("[::1]:9911", Some(("::1", "9911"))),
        ("localhost:http", Some(("localhost", "http"))),
        ("::1:9911", None),
        ("[::1]", None),
        ("[::1]x:9911", None),
        ("a[b:9911", None),
        ("a:9[911", None),
        ("noport", None),
    ] {
        assert_eq!(split_host_port(in_), want, "{in_:?}");
    }
}

/// 빈 호스트 리슨은 127.0.0.1 과 ::1 양쪽으로 붙는다 (Go `net.Listen("tcp", ":port")`).
#[test]
fn listen_tcp_empty_host_is_dual_stack() {
    let caps = ip_stack_caps();
    if !caps.ipv4map || !caps.ipv6 {
        eprintln!("IPv6/IPv4-mapped 가 없는 호스트라 건너뛴다: {caps:?}");
        return;
    }
    let (p, ln) = listen_free("");
    let local = ln.local_addr().unwrap();
    assert_eq!(local.ip(), IpAddr::V6(Ipv6Addr::UNSPECIFIED));
    assert_eq!(local.port(), p);
    TcpStream::connect(("127.0.0.1", p)).expect("127.0.0.1 로 붙지 못했다");
    let (_, peer) = ln.accept().unwrap();
    assert_eq!(canonical_addr(peer).ip(), IpAddr::V4(Ipv4Addr::LOCALHOST));
    TcpStream::connect(("::1", p)).expect("::1 로 붙지 못했다");
    let (_, peer) = ln.accept().unwrap();
    assert_eq!(peer.ip(), IpAddr::V6(Ipv6Addr::LOCALHOST));
}

/// 명시한 루프백은 그 주소에만 리슨한다.
#[test]
fn listen_tcp_loopback_host_is_v4_only() {
    let (p, ln) = listen_free("127.0.0.1");
    assert_eq!(
        ln.local_addr().unwrap(),
        format!("127.0.0.1:{p}").parse().unwrap()
    );
}

/// 이미 쓰는 포트면 bind 의 `io::Error` 를 포장 없이 준다 — 호출자가 Go 꼴로 감싼다.
#[test]
fn listen_tcp_in_use_is_raw_bind_error() {
    let (p, _held) = listen_free("127.0.0.1");
    let err = listen_tcp(&format!("127.0.0.1:{p}")).unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::AddrInUse);
    assert!(err.raw_os_error().is_some(), "{err:?}");
}

// dmenv::listen_addr 의 결과는 실제 리슨(Go net.Listen("tcp"))이 받는 것이어야 한다 — dmenv 에서 옮긴 시험.
#[test]
fn dmenv_listen_addr_is_listenable() {
    for host in ["127.0.0.1", "::1", ""] {
        let bound = (PORT_LO..PORT_HI)
            .any(|port| listen_tcp(&dm_shared_dmenv::listen_addr(host, &port.to_string())).is_ok());
        assert!(bound, "{host:?} 에 리슨하지 못했다");
    }
}
