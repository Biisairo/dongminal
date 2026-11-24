//! 경로·브랜치 이름 파생과 ref 인자 검사 (FR-WKT-3·6·13).

use otter_gocompat::filepath;
use otter_gocompat::strconv::quote;
use otter_webserver_domain_git_core as core;
use sha2::{Digest, Sha256};

use crate::error::{Error, Kind};

const SLUG_MAX: usize = 40;
const BUCKET_HASH_LEN: usize = 8;
const BRANCH_PREFIX: &str = "otter/";
const REF_FORBIDDEN: &str = "~^:?*[\\\"'`$;|&<>";

/// 사용자 worktree 영역의 저장소별 버킷 이름이다 (FR-WKT-13, V159):
/// `<베이스이름>-<정규화된 루트의 sha256 앞 8자리>`.
pub fn repo_bucket(root: &str) -> String {
    let clean = filepath::clean(root);
    let sum = hex::encode(Sha256::digest(clean.as_bytes()));
    format!(
        "{}-{}",
        safe_segment(&filepath::base(&clean), "repo"),
        &sum[..BUCKET_HASH_LEN]
    )
}

/// 브랜치 이름을 파생한다 (FR-WKT-3): `otter/<run.short>/<role>`. role 을 ASCII 로 환원할 수
/// 없으면 fallback, 그것도 없으면 `member` 다.
pub fn branch(run_short: &str, role: &str, fallback: &str) -> String {
    let mut name = slug(role);
    if name.is_empty() {
        name = slug(fallback);
    }
    if name.is_empty() {
        name = "member".to_owned();
    }
    format!("{BRANCH_PREFIX}{}/{name}", safe_segment(run_short, "run"))
}

pub(crate) fn safe_segment(s: &str, fallback: &str) -> String {
    let out = slug(s);
    if out.is_empty() {
        fallback.to_owned()
    } else {
        out
    }
}

/// 경로·ref 에 안전한 ASCII 만 남긴다. 앞의 - 를 뗀다(git 플래그 오인, FR-WKT-6).
fn slug(s: &str) -> String {
    let mut b = String::new();
    let mut prev_dash = false;
    for r in s.chars() {
        if r.is_ascii_alphanumeric() || r == '.' || r == '_' {
            b.push(r);
            prev_dash = false;
        } else if !b.is_empty() && !prev_dash {
            b.push('-');
            prev_dash = true;
        }
    }
    let trim = |s: &str| s.trim_matches(['-', '.']).to_owned();
    let out = trim(&b);
    if out.len() > SLUG_MAX {
        return trim(&out[..SLUG_MAX]);
    }
    out
}

/// 브랜치·base 인자를 검사한다 (FR-WKT-6). 바탕 규칙은 core 의 check_ref_arg 이고, 사유는
/// 이 패키지의 것으로 든다 — core 의 종류는 드러내지 않는다.
pub(crate) fn valid_ref(name: &str) -> Result<(), Error> {
    if let Err(e) = core::check_ref_arg("ref", name) {
        return Err(Error::new(Kind::UnsafeArgument, e));
    }
    let bad = || Error::new(Kind::UnsafeArgument, format!("잘못된 ref: {}", quote(name)));
    if name.ends_with(".lock") {
        return Err(bad());
    }
    if name.starts_with('/') || name.ends_with('/') || name.contains("//") {
        return Err(bad());
    }
    if name
        .chars()
        .any(|r| r <= ' ' || r == '\u{7f}' || REF_FORBIDDEN.contains(r))
    {
        return Err(Error::new(
            Kind::UnsafeArgument,
            format!("ref 에 쓸 수 없는 문자: {}", quote(name)),
        ));
    }
    Ok(())
}

/// 사용자 worktree 의 이름·브랜치를 검사한다 (FR-GIT-242). valid_ref 와 같은 규칙이다.
pub fn check_name(name: &str) -> Result<(), Error> {
    valid_ref(name)
}
