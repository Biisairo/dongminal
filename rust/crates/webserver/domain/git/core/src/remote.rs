//! URL 자격증명 마스킹 (FR-GIT-104). 이 저장소의 유일한 URL 마스킹 규칙이다.

use std::sync::OnceLock;

use regex::Regex;

/// URL 의 userinfo 다. 콜론이 없어도 지운다. Go `\s` 는 ASCII 공백 다섯이다.
fn remote_creds() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"([a-zA-Z][a-zA-Z0-9+.\-]*://)[^/@\t\n\x0C\r ]+@").expect("고정 정규식")
    })
}

/// 자격증명을 지운다. 저장 전에 부른다 (FR-GIT-104, V43).
pub fn sanitize_remote(s: &str) -> String {
    if !s.contains("://") {
        return s.to_owned();
    }
    remote_creds().replace_all(s, "${1}***@").into_owned()
}

pub fn sanitize_argv<S: AsRef<str>>(argv: &[S]) -> Vec<String> {
    argv.iter().map(|a| sanitize_remote(a.as_ref())).collect()
}
