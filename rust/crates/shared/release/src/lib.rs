//! Go 기준선 `dongminal/internal/shared/release` 의 Rust 포팅. RUST_PORT_SRS 참고.
//!
//! **최신 릴리스가 무엇인가** 하나만 안다 (UPDATE_NOTICE_SRS FR-UPD-5).

use std::fmt;
use std::time::Duration;

use serde::Deserialize;

/// 릴리스가 사는 저장소다. 릴리스를 발행하는 곳과 같아야 한다.
pub const REPO: &str = "Biisairo/dongminal";

/// 최신 릴리스를 묻는 자리다.
pub const API: &str = "https://api.github.com/repos/Biisairo/dongminal/releases/latest";

/// 확인에 주는 시간이다.
pub const TIMEOUT: Duration = Duration::from_secs(5);

/// 응답 본문을 읽는 상한이다 (Go `io.LimitReader(res.Body, 1<<20)`).
const BODY_LIMIT: usize = 1 << 20;

/// Go `http.Client` 가 싣는 User-Agent. GitHub API 는 이것이 없으면 거절한다.
const USER_AGENT: &str = "Go-http-client/1.1";

/// NFR-UPD-4: 요청이 싣는 것은 이 한 줄뿐이다.
const ACCEPT: &str = "application/vnd.github+json";

/// 확인 실패. `Display` 는 Go `err.Error()` 의 문구다(전송 오류는 근사).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Error(String);

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Error {}

#[derive(Deserialize, Default)]
#[serde(default)]
struct LatestBody {
    tag_name: String,
    html_url: String,
}

/// 최신 태그와 그 릴리스 링크를 읽는다. `url` 이 비면 [`API`].
pub async fn latest(url: &str) -> Result<(String, String), Error> {
    let url = if url.is_empty() { API } else { url };
    // reqwest 의 rustls-no-provider 는 프로세스 공통 암호 공급자를 요구한다. 이미 있으면 그대로 쓴다.
    let _ = rustls::crypto::ring::default_provider().install_default();
    let transport =
        |e: reqwest::Error| Error(format!("Get {}: {e}", dm_gocompat::strconv::quote(url)));
    let client = reqwest::Client::builder()
        .timeout(TIMEOUT)
        .user_agent(USER_AGENT)
        .build()
        .map_err(transport)?;
    let mut res = client
        .get(url)
        .header(reqwest::header::ACCEPT, ACCEPT)
        .send()
        .await
        .map_err(transport)?;
    if res.status() != reqwest::StatusCode::OK {
        return Err(Error(format!("응답 {}", res.status().as_u16())));
    }
    let mut body = Vec::new();
    while body.len() < BODY_LIMIT {
        match res.chunk().await.map_err(transport)? {
            Some(c) => body.extend_from_slice(&c),
            None => break,
        }
    }
    body.truncate(BODY_LIMIT);
    let b: LatestBody = dm_gocompat::json::Decoder::new()
        .decode(&body)
        .map_err(|e| Error(e.to_string()))?;
    if b.tag_name.is_empty() {
        return Err(Error("태그가 비었습니다".into()));
    }
    Ok((b.tag_name, b.html_url))
}

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
mod server_tests;

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
