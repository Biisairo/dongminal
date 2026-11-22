//! Go 기준선 `dongminal/internal/shared/release` 의 Rust 포팅. RUST_PORT_SRS 참고.
//!
//! **최신 릴리스가 무엇인가** 하나만 안다 (UPDATE_NOTICE_SRS FR-UPD-5).

use std::time::Duration;

/// 릴리스가 사는 저장소다. 릴리스를 발행하는 곳과 같아야 한다.
pub const REPO: &str = "Biisairo/dongminal";

/// 최신 릴리스를 묻는 자리다.
pub const API: &str = "https://api.github.com/repos/Biisairo/dongminal/releases/latest";

/// 확인에 주는 시간이다.
pub const TIMEOUT: Duration = Duration::from_secs(5);

/// a 가 b 보다 새로운가다. 문자열 비교가 아니다.
pub fn newer(a: &str, b: &str) -> bool {
    let (pa, pb) = (parts(a), parts(b));
    for i in 0..3 {
        if pa[i] != pb[i] {
            return pa[i] > pb[i];
        }
    }
    false
}

/// 그 판이 견줄 수 있는 것인가다. 개발 빌드는 기준이 없다 (FR-UPD-9b).
pub fn comparable(v: &str) -> bool {
    let v = v.trim();
    !v.is_empty() && v != "dev"
}

/// `v1.2.3` 을 [1, 2, 3] 으로 읽는다. 읽지 못한 자리는 0 이다.
fn parts(v: &str) -> [i64; 3] {
    let mut out = [0i64; 3];
    let s = v.trim();
    let mut s = s.strip_prefix('v').unwrap_or(s);
    // 사전 릴리스·빌드 메타는 버린다 (`1.2.3-rc1+abc`).
    if let Some(i) = s.find(['-', '+']) {
        s = &s[..i];
    }
    for (i, part) in s.splitn(3, '.').enumerate() {
        if let Ok(n) = part.parse::<i64>() {
            out[i] = n;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn newer_is_semver_not_string() {
        for (a, b, want) in [
            ("v1.10.0", "v1.9.0", true),
            ("v1.9.0", "v1.10.0", false),
            ("v2.0.0", "v1.99.99", true),
            ("v1.0.1", "v1.0.0", true),
            ("v1.0.0", "v1.0.0", false),
            ("1.2.3", "v1.2.2", true),
            ("v1.2.3-rc1", "v1.2.3", false),
        ] {
            assert_eq!(newer(a, b), want, "newer({a:?},{b:?})");
        }
    }

    #[test]
    fn comparable_cases() {
        for (v, want) in [("v1.0.0", true), ("dev", false), ("", false), ("  ", false)] {
            assert_eq!(comparable(v), want, "comparable({v:?})");
        }
    }

    #[test]
    fn parts_edge_cases() {
        assert_eq!(parts("v1.2.3.4"), [1, 2, 0]);
        assert_eq!(parts(" v1.x.3+meta "), [1, 0, 3]);
        assert_eq!(parts("+1.2"), [0, 0, 0]);
        assert_eq!(parts("1.+2"), [1, 0, 0]);
        assert_eq!(parts("99999999999999999999.1"), [0, 1, 0]);
        assert_eq!(parts(""), [0, 0, 0]);
    }

    #[test]
    fn api_is_repo_url() {
        assert_eq!(
            API,
            format!("https://api.github.com/repos/{REPO}/releases/latest")
        );
    }
}
