//! 주소·포트·지문 규칙과 출발지 상한 키. Go 의 `net/netip` 해석 규칙을 따른다.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

const MAX_HOST_LEN: usize = 253;
const MAX_LABEL_LEN: usize = 63;
const MAX_PORT: i64 = 65535;
pub(crate) const FINGERPRINT_LEN: usize = 64;
/// IPv6 출발지를 한 망으로 묶는 접두 길이.
const RATE_PREFIX_V6: u32 = 64;

/// Go `netip.ParseAddr` 와 같은 판정이다. IPv6 는 비지 않은 zone(`%eth0`)을 받는다.
pub(crate) fn parse_addr(s: &str) -> Option<(IpAddr, Option<&str>)> {
    match s.split_once('%') {
        None => s.parse::<IpAddr>().ok().map(|ip| (ip, None)),
        Some((base, zone)) => {
            if zone.is_empty() {
                return None;
            }
            base.parse::<Ipv6Addr>().ok().map(|ip| (IpAddr::V6(ip), Some(zone)))
        }
    }
}

/// IP 주소(zone 없음)이거나 LDH 규칙의 호스트 이름인가다. 허용 목록이다 —
/// 제어 문자·비 ASCII·포트·경로를 받지 않는다. 이 값은 화면과 터미널에 찍힌다.
pub fn valid_addr(a: &str) -> bool {
    if let Some((_, zone)) = parse_addr(a) {
        return zone.is_none();
    }
    if a.is_empty() || a.len() > MAX_HOST_LEN {
        return false;
    }
    a.split('.').all(valid_label)
}

/// DNS 레이블 하나: 영문·숫자·`-`, 1~63자, `-` 로 시작·끝나지 않는다.
fn valid_label(l: &str) -> bool {
    let b = l.as_bytes();
    !b.is_empty()
        && b.len() <= MAX_LABEL_LEN
        && b[0] != b'-'
        && b[b.len() - 1] != b'-'
        && b.iter().all(|c| c.is_ascii_alphanumeric() || *c == b'-')
}

pub fn valid_port(p: i64) -> bool {
    (1..=MAX_PORT).contains(&p)
}

pub(crate) fn valid_fingerprint(fp: &str) -> bool {
    fp.len() == FINGERPRINT_LEN && fp.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

/// 출발지 주소의 상한 키다. IPv6 는 /64 하나를 한 출발지로 센다 — 한 망이 연결마다 주소를
/// 바꿔 상한을 피하지 못하게 한다. IPv4(IPv4 사상 IPv6 포함)는 주소 하나다. 읽지 못한 값은
/// 그대로 키로 쓴다.
pub fn addr_rate_key(host: &str) -> String {
    let Some((ip, _)) = parse_addr(host) else {
        return host.to_string();
    };
    match unmap(ip) {
        IpAddr::V4(v4) => v4.to_string(),
        IpAddr::V6(v6) => {
            let masked = u128::from(v6) & (u128::MAX << (128 - RATE_PREFIX_V6));
            format!("{}/{RATE_PREFIX_V6}", Ipv6Addr::from(masked))
        }
    }
}

fn unmap(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V6(v6) => v6.to_ipv4_mapped().map_or(ip, |v4: Ipv4Addr| IpAddr::V4(v4)),
        v4 => v4,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn valid_addr_cases() {
        for a in ["10.0.0.1", "::1", "fe80::1", "office", "office.example.com", "a-b.c-d", "host.local"] {
            assert!(valid_addr(a), "{a}");
        }
        let long_label = format!("{}.com", "a".repeat(64));
        let long_host = format!("{}aa", "a.".repeat(127));
        for a in [
            "", "a b", "a/b", "a\x1b[31m", "fe80::1%eth0", "fe80::1%\x1b[2J", "한글.com", "-a.com", "a-.com",
            "a..b", "a_b.com", "user@h", "h:80", &long_label, &long_host,
        ] {
            assert!(!valid_addr(a), "{a:?}");
        }
    }

    #[test]
    fn rate_key_cases() {
        let same = |a: &str, b: &str| addr_rate_key(a) == addr_rate_key(b);
        assert!(same("2001:db8:1:2::1", "2001:db8:1:2:ffff::9"));
        assert!(!same("2001:db8:1:2::1", "2001:db8:1:3::1"));
        assert!(!same("10.0.0.1", "10.0.0.2"));
        assert!(same("::ffff:10.0.0.1", "10.0.0.1"));
        assert!(!addr_rate_key("not-an-ip").is_empty());
        assert_eq!(addr_rate_key("2001:db8:1:2::1"), "2001:db8:1:2::/64");
        assert_eq!(addr_rate_key("fe80::1%eth0"), "fe80::/64");
    }

    #[test]
    fn parse_addr_follows_netip() {
        assert!(parse_addr("fe80::1%eth0").is_some());
        assert!(parse_addr("fe80::1%").is_none());
        assert!(parse_addr("10.0.0.1%eth0").is_none());
        assert!(parse_addr("010.0.0.1").is_none());
    }
}
