//! Go `net/netip`·`net.SplitHostPort`·`net/url` 중 접근 판정이 쓰는 부분이다.
//!
//! 판정 규칙(무엇을 주소·대역·포트로 받는가)이 관측 동작이라 Go 와 같게 둔다.

use std::fmt;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

/// Go `netip.Addr`. IPv6 의 zone 과 4in6 을 IPv4 와 가른다 — 같음 판정도 그렇다.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) struct Addr {
    pub(crate) ip: IpAddr,
    pub(crate) zone: String,
}

impl Addr {
    pub(crate) fn from_ip(ip: IpAddr) -> Addr {
        Addr {
            ip,
            zone: String::new(),
        }
    }

    fn is_4in6(&self) -> bool {
        matches!(self.ip, IpAddr::V6(v6) if v6.to_ipv4_mapped().is_some())
    }

    /// Go `Addr.Unmap`: 4in6 이면 IPv4 로 푼다(zone 은 버린다).
    pub(crate) fn unmap(&self) -> Addr {
        match self.ip {
            IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
                Some(v4) => Addr::from_ip(IpAddr::V4(v4)),
                None => self.clone(),
            },
            IpAddr::V4(_) => self.clone(),
        }
    }

    pub(crate) fn is_loopback(&self) -> bool {
        match self.ip {
            IpAddr::V4(v4) => v4.is_loopback(),
            IpAddr::V6(v6) => v6.is_loopback(),
        }
    }
}

impl fmt::Display for Addr {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.ip {
            IpAddr::V4(v4) => write!(f, "{v4}"),
            IpAddr::V6(v6) => {
                if self.is_4in6() {
                    if let Some(v4) = v6.to_ipv4_mapped() {
                        write!(f, "::ffff:{v4}")?;
                    }
                } else {
                    write!(f, "{v6}")?;
                }
                if !self.zone.is_empty() {
                    write!(f, "%{}", self.zone)?;
                }
                Ok(())
            }
        }
    }
}

/// Go `netip.ParseAddr`. 처음 만나는 `.`·`:`·`%` 가 형식을 정한다.
pub(crate) fn parse_addr(s: &str) -> Option<Addr> {
    let i = s.find(['.', ':', '%'])?;
    match s.as_bytes()[i] {
        b'.' => s
            .parse::<Ipv4Addr>()
            .ok()
            .map(|a| Addr::from_ip(IpAddr::V4(a))),
        b':' => {
            let (base, zone) = match s.split_once('%') {
                Some((_, "")) => return None,
                Some((b, z)) => (b, z),
                None => (s, ""),
            };
            base.parse::<Ipv6Addr>().ok().map(|a| Addr {
                ip: IpAddr::V6(a),
                zone: zone.to_owned(),
            })
        }
        _ => None,
    }
}

/// Go `netip.Prefix`. 주소는 가리지 않은 그대로 둔다 — `Contains` 가 가린다.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Prefix {
    ip: IpAddr,
    bits: u8,
}

/// Go `netip.ParsePrefix`.
pub(crate) fn parse_prefix(s: &str) -> Option<Prefix> {
    let i = s.rfind('/')?;
    let addr = parse_addr(&s[..i])?;
    if !addr.zone.is_empty() {
        return None;
    }
    let bits_str = &s[i + 1..];
    let first = *bits_str.as_bytes().first()?;
    if bits_str.len() > 1 && !(b'1'..=b'9').contains(&first) {
        return None;
    }
    if !bits_str.bytes().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let bits: u32 = bits_str.parse().ok()?;
    let max = match addr.ip {
        IpAddr::V4(_) => 32,
        IpAddr::V6(_) => 128,
    };
    if bits > max {
        return None;
    }
    Some(Prefix {
        ip: addr.ip,
        bits: u8::try_from(bits).ok()?,
    })
}

impl Prefix {
    /// Go `Prefix.Contains`. zone 이 있거나 주소 체계가 다르면 거짓이다(4in6 은 IPv6 다).
    pub(crate) fn contains(&self, a: &Addr) -> bool {
        if !a.zone.is_empty() {
            return false;
        }
        match (self.ip, a.ip) {
            (IpAddr::V4(p), IpAddr::V4(x)) => masked_eq(
                u128::from(p.to_bits()),
                u128::from(x.to_bits()),
                self.bits,
                32,
            ),
            (IpAddr::V6(p), IpAddr::V6(x)) => masked_eq(p.to_bits(), x.to_bits(), self.bits, 128),
            _ => false,
        }
    }
}

fn masked_eq(p: u128, x: u128, bits: u8, width: u32) -> bool {
    let bits = u32::from(bits);
    if bits == 0 {
        return true;
    }
    let shift = width - bits;
    (p >> shift) == (x >> shift)
}

/// Go `net.SplitHostPort`. 실패면 `None` 이다(오류 문구를 쓰는 자리가 없다).
pub(crate) fn split_host_port(hostport: &str) -> Option<(&str, &str)> {
    let i = hostport.rfind(':')?;
    let (host, port) = if hostport.starts_with('[') {
        let end = hostport.find(']')?;
        if end + 1 == hostport.len() {
            return None;
        }
        if end + 1 != i {
            return None;
        }
        let host = &hostport[1..end];
        if host.contains('[') || host.contains(']') {
            return None;
        }
        (host, &hostport[i + 1..])
    } else {
        let host = &hostport[..i];
        if host.contains(':') {
            return None;
        }
        if host.contains('[') || host.contains(']') {
            return None;
        }
        (host, &hostport[i + 1..])
    };
    if hostport[i + 1..].contains('[') || hostport[i + 1..].contains(']') {
        return None;
    }
    Some((host, port))
}

/// Go `url.Parse` 가 `scheme://authority...` 에서 꺼내는 값이다.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct UrlAuth {
    /// 소문자로 바꾼 스킴. 스킴이 없으면 비어 있다.
    pub(crate) scheme: String,
    /// Go `URL.Host`(퍼센트 디코딩 뒤).
    pub(crate) host: String,
}

impl UrlAuth {
    /// Go `URL.Hostname`.
    pub(crate) fn hostname(&self) -> &str {
        let (host, _) = split_host_port_lax(&self.host);
        match host.strip_prefix('[') {
            Some(h) => h.find(']').map_or(h, |i| &h[..i]),
            None => host,
        }
    }

    /// Go `URL.Port`.
    pub(crate) fn port(&self) -> &str {
        split_host_port_lax(&self.host).1
    }
}

/// Go `url.splitHostPort`(포트 검사 없이 마지막 `:` 뒤가 숫자일 때만 가른다).
fn split_host_port_lax(hostport: &str) -> (&str, &str) {
    let Some(colon) = hostport.rfind(':') else {
        return (hostport, "");
    };
    let port = &hostport[colon + 1..];
    if !port.bytes().all(|c| c.is_ascii_digit()) {
        return (hostport, "");
    }
    let mut host = &hostport[..colon];
    if host.starts_with('[') && host.ends_with(']') {
        host = &host[1..host.len() - 1];
        return (host, port);
    }
    (host, port)
}

/// Go `url.Parse` 의 부분. 실패면 `None` 이다.
pub(crate) fn parse_url(raw: &str) -> Option<UrlAuth> {
    let (rest, frag) = match raw.split_once('#') {
        Some((r, f)) => (r, Some(f)),
        None => (raw, None),
    };
    if let Some(f) = frag {
        unescape(f, Mode::Fragment)?;
    }
    if rest.bytes().any(|c| c < 0x20 || c == 0x7f) {
        return None;
    }
    let (scheme, rest) = get_scheme(rest)?;
    let scheme = scheme.to_ascii_lowercase();
    let rest = match rest.find('?') {
        Some(i) => &rest[..i],
        None => rest,
    };
    if !rest.starts_with('/') {
        if !scheme.is_empty() {
            return Some(UrlAuth {
                scheme,
                host: String::new(),
            });
        }
        if let Some(colon) = rest.find(':') {
            let slash = rest.find('/');
            if slash.is_none_or(|s| colon < s) {
                return None;
            }
        }
    }
    let mut host = String::new();
    if (!scheme.is_empty() || !rest.starts_with("///")) && rest.starts_with("//") {
        let after = &rest[2..];
        let authority = match after.find('/') {
            Some(i) => &after[..i],
            None => after,
        };
        host = parse_authority(authority)?;
        let path = &after[authority.len()..];
        if !path.is_empty() && !path.starts_with('/') {
            return None;
        }
        unescape(path, Mode::Path)?;
    } else {
        unescape(rest, Mode::Path)?;
    }
    Some(UrlAuth { scheme, host })
}

fn get_scheme(raw: &str) -> Option<(&str, &str)> {
    for (i, c) in raw.bytes().enumerate() {
        match c {
            b'a'..=b'z' | b'A'..=b'Z' => {}
            b'0'..=b'9' | b'+' | b'-' | b'.' => {
                if i == 0 {
                    return Some(("", raw));
                }
            }
            b':' => {
                if i == 0 {
                    return None;
                }
                return Some((&raw[..i], &raw[i + 1..]));
            }
            _ => return Some(("", raw)),
        }
    }
    Some(("", raw))
}

fn parse_authority(authority: &str) -> Option<String> {
    let host = match authority.rfind('@') {
        Some(i) => {
            if !valid_userinfo(&authority[..i]) {
                return None;
            }
            unescape(&authority[..i], Mode::UserPassword)?;
            &authority[i + 1..]
        }
        None => authority,
    };
    parse_host(host)
}

fn valid_userinfo(s: &str) -> bool {
    s.bytes().all(|c| {
        c.is_ascii_alphanumeric()
            || matches!(
                c,
                b'-' | b'.'
                    | b'_'
                    | b':'
                    | b'~'
                    | b'!'
                    | b'$'
                    | b'&'
                    | b'\''
                    | b'('
                    | b')'
                    | b'*'
                    | b'+'
                    | b','
                    | b';'
                    | b'='
                    | b'%'
                    | b'@'
            )
            || c >= 0x80
    })
}

fn parse_host(host: &str) -> Option<String> {
    if host.starts_with('[') {
        let i = host.rfind(']')?;
        let colon_port = &host[i + 1..];
        if !valid_optional_port(colon_port) {
            return None;
        }
        let inner = &host[..i];
        if let Some(z) = inner.find("%25") {
            let h1 = unescape(&inner[..z], Mode::Host)?;
            let h2 = unescape(&inner[z..], Mode::Zone)?;
            let h3 = unescape(colon_port, Mode::Host)?;
            return Some(h1 + &h2 + "]" + &h3);
        }
        let addr = &inner[1..];
        if !addr.contains(':') || addr.parse::<Ipv6Addr>().is_err() {
            return None;
        }
    } else if let Some(i) = host.rfind(':')
        && !valid_optional_port(&host[i..])
    {
        return None;
    }
    unescape(host, Mode::Host)
}

fn valid_optional_port(port: &str) -> bool {
    if port.is_empty() {
        return true;
    }
    let Some(digits) = port.strip_prefix(':') else {
        return false;
    };
    digits.bytes().all(|c| c.is_ascii_digit())
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    Path,
    Host,
    Zone,
    UserPassword,
    Fragment,
}

fn unhex(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}

/// Go `url.unescape`. 결과가 UTF-8 이 아니어도 바이트 그대로 문자열로 본다.
fn unescape(s: &str, mode: Mode) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'%' => {
                if i + 2 >= b.len() {
                    return None;
                }
                let (h, l) = (unhex(b[i + 1])?, unhex(b[i + 2])?);
                if mode == Mode::Host && h < 8 && &s[i..i + 3] != "%25" {
                    return None;
                }
                if mode == Mode::Zone {
                    let v = h << 4 | l;
                    if &s[i..i + 3] != "%25" && v != b' ' && should_escape(v, Mode::Host) {
                        return None;
                    }
                }
                out.push(h << 4 | l);
                i += 3;
            }
            c => {
                if matches!(mode, Mode::Host | Mode::Zone) && c < 0x80 && should_escape(c, mode) {
                    return None;
                }
                out.push(c);
                i += 1;
            }
        }
    }
    Some(String::from_utf8_lossy(&out).into_owned())
}

/// Go `url.shouldEscape` 의 host·zone 갈래.
fn should_escape(c: u8, mode: Mode) -> bool {
    if c.is_ascii_alphanumeric() {
        return false;
    }
    if matches!(mode, Mode::Host | Mode::Zone)
        && matches!(
            c,
            b'!' | b'$'
                | b'&'
                | b'\''
                | b'('
                | b')'
                | b'*'
                | b'+'
                | b','
                | b';'
                | b'='
                | b':'
                | b'['
                | b']'
                | b'<'
                | b'>'
                | b'"'
        )
    {
        return false;
    }
    !matches!(c, b'-' | b'_' | b'.' | b'~')
}
