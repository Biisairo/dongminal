//! 바인드 주소 하나를 읽는 방법 (TLS-2). 여기에 TLS 는 없다.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

use crate::DEFAULT_HOST;

/// 대괄호·대소문자·후행 점을 걷어낸다. 각각 한 번만 뗀다(Go `TrimPrefix`/`TrimSuffix`).
fn normalize_host(host: &str) -> String {
    let h = host.trim().to_lowercase();
    let h = h.strip_prefix('[').unwrap_or(&h);
    let h = h.strip_suffix(']').unwrap_or(h);
    h.strip_suffix('.').unwrap_or(h).to_owned()
}

/// Go `netip.ParseAddr` 의 결과. `zoned` 는 IPv6 zone(`%eth0`)이 붙었는지다.
struct Parsed {
    addr: IpAddr,
    zoned: bool,
}

fn parse_addr(s: &str) -> Option<Parsed> {
    match s.find(['.', ':', '%'])? {
        i if s.as_bytes()[i] == b'.' => s.parse::<Ipv4Addr>().ok().map(|a| Parsed {
            addr: IpAddr::V4(a),
            zoned: false,
        }),
        i if s.as_bytes()[i] == b':' => {
            let (addr, zoned) = match s.split_once('%') {
                Some((_, "")) => return None,
                Some((a, _)) => (a, true),
                None => (s, false),
            };
            addr.parse::<Ipv6Addr>().ok().map(|a| Parsed {
                addr: IpAddr::V6(a),
                zoned,
            })
        }
        _ => None,
    }
}

fn is_loopback(p: &Parsed) -> bool {
    p.addr.to_canonical().is_loopback()
}

/// zone 이 붙은 `::` 는 Go 에서 미지정 주소와 같지 않다.
fn is_unspecified(p: &Parsed) -> bool {
    !p.zoned && p.addr.is_unspecified()
}

/// host 가 모든 인터페이스를 뜻하는 미지정 주소(`0.0.0.0`·`::`)인지 본다.
pub fn is_unspecified_host(host: &str) -> bool {
    parse_addr(&normalize_host(host)).is_some_and(|p| is_unspecified(&p))
}

/// host 에 바인드했을 때 이 기계 밖에서 닿는지 본다. loopback 만 로컬이고,
/// 해석되지 않는 이름은 노출로 본다.
pub fn is_exposed_host(host: &str) -> bool {
    let mut h = normalize_host(host);
    if h.is_empty() {
        h = DEFAULT_HOST.to_owned();
    }
    if h == "localhost" {
        return false;
    }
    match parse_addr(&h) {
        Some(p) => !is_loopback(&p),
        None => true,
    }
}

/// host 에 뜬 서버를 실제로 두드릴 주소. 미지정 주소만 `DEFAULT_HOST` 로 바꾼다.
pub fn dial_host(host: &str) -> String {
    let h = normalize_host(host);
    if h.is_empty() || is_unspecified_host(&h) {
        return DEFAULT_HOST.to_owned();
    }
    h
}

/// Go `net.JoinHostPort` — 콜론이 든 호스트는 대괄호로 싼다. 주소 조립의 한 자리다.
pub fn join_host_port(host: &str, port: &str) -> String {
    if host.contains(':') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    }
}

/// listen 에 그대로 넘길 주소. 미지정 주소를 바꾸지 않는다 (FR-STR-20).
pub fn listen_addr(host: &str, port: &str) -> String {
    join_host_port(&normalize_host(host), port)
}

/// 그 서버를 두드릴 http URL.
pub fn base_url(host: &str, port: &str) -> String {
    format!("http://{}", join_host_port(&dial_host(host), port))
}

/// 기동 로그와 `start` 출력이 함께 쓰는 표시.
pub fn exposure_label(host: &str) -> &'static str {
    if is_exposed_host(host) {
        "exposed"
    } else {
        "local-only"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // TLS-2: 노출 판정이 한 벌이다.
    #[test]
    fn exposed_host() {
        for (host, want) in [
            ("127.0.0.1", false),
            ("127.0.0.53", false),
            ("::1", false),
            ("localhost", false),
            ("LocalHost", false),
            ("[::1]", false),
            ("", false),
            ("0.0.0.0", true),
            ("::", true),
            ("[::]", true),
            ("192.168.1.5", true),
            ("10.0.0.2", true),
            ("172.16.0.1", true),
            ("8.8.8.8", true),
            ("fe80::1", true),
            ("myhost.local", true),
            // Go netip 경계: 4in6 는 풀어서 보고, zone 은 loopback 판정에 무관하다.
            ("::ffff:127.0.0.1", false),
            ("::1%lo0", false),
            ("::1%", true),
            ("127.000.0.1", true),
            ("localhost.", false),
            (" 127.0.0.1 ", false),
        ] {
            assert_eq!(is_exposed_host(host), want, "is_exposed_host({host:?})");
        }
    }

    #[test]
    fn unspecified_host() {
        for (host, want) in [
            ("0.0.0.0", true),
            ("::", true),
            ("[::]", true),
            ("::%eth0", false),
            ("::ffff:0.0.0.0", false),
            ("", false),
            ("127.0.0.1", false),
        ] {
            assert_eq!(
                is_unspecified_host(host),
                want,
                "is_unspecified_host({host:?})"
            );
        }
    }

    #[test]
    fn dial() {
        for (host, want) in [
            ("0.0.0.0", DEFAULT_HOST),
            ("::", DEFAULT_HOST),
            ("[::]", DEFAULT_HOST),
            ("", DEFAULT_HOST),
            ("192.168.1.5", "192.168.1.5"),
            ("127.0.0.1", "127.0.0.1"),
            ("::1", "::1"),
            ("localhost", "localhost"),
        ] {
            assert_eq!(dial_host(host), want, "dial_host({host:?})");
        }
    }

    #[test]
    fn label() {
        assert_eq!(exposure_label("127.0.0.1"), "local-only");
        assert_eq!(exposure_label("192.168.1.5"), "exposed");
    }

    // FR-STR-20 · TC-STR-5: 판정과 조립은 다른 일이다.
    #[test]
    fn listen() {
        for (host, port, want) in [
            ("::1", "9911", "[::1]:9911"),
            ("[::1]", "9911", "[::1]:9911"),
            ("::", "9911", "[::]:9911"),
            ("0.0.0.0", "9911", "0.0.0.0:9911"),
            ("127.0.0.1", "9911", "127.0.0.1:9911"),
            ("localhost", "9911", "localhost:9911"),
            ("", "9911", ":9911"),
        ] {
            assert_eq!(
                listen_addr(host, port),
                want,
                "listen_addr({host:?}, {port:?})"
            );
        }
    }

    // listen_addr 의 결과가 실제 listen 이 받는 것인지는 platform 의 tcp_listen 시험이 본다
    // (platform 이 otterenv 에 의존하므로 여기서 platform 리슨을 부를 수 없다).

    #[test]
    fn base() {
        for (host, port, want) in [
            ("0.0.0.0", "9911", "http://127.0.0.1:9911"),
            ("::", "9911", "http://127.0.0.1:9911"),
            ("", "9911", "http://127.0.0.1:9911"),
            ("::1", "9911", "http://[::1]:9911"),
            ("192.168.1.5", "9911", "http://192.168.1.5:9911"),
            ("localhost", "9911", "http://localhost:9911"),
        ] {
            assert_eq!(base_url(host, port), want, "base_url({host:?}, {port:?})");
        }
    }
}
