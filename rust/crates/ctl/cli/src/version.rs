//! `otterminal version` (RELEASE_SRS FR-RVN-1..3).

use std::io::Write;

use crate::options::{ParseError, unknown_flag};

/// 이 바이너리의 판이다. 빌드 때 `OTTERMINAL_BUILD_VERSION` 으로 새긴다 (FR-RSP-11).
/// 새기지 않으면 `dev` 다 — 소스 빌드와 릴리스 산출물이 구별되어야 한다 (FR-RVN-2).
pub const VERSION: &str = match option_env!("OTTERMINAL_BUILD_VERSION") {
    Some(v) => v,
    None => "dev",
};

/// `version` 출력의 셋째 칸. Go 판은 `runtime.Version()` 을 찍었다. Rust 판은 관측 표면을 기준선과
/// 바이트로 맞추려고(FR-RSP-3) 기준선의 go 런타임 판을 그대로 찍는다.
pub const GO_RUNTIME: &str = "go1.27.2";

/// 옵션이 없으므로 -h/--help 만 받고 나머지는 옵션 오류다 (FR-CLI-6/7).
pub fn parse_version(args: &[String]) -> Result<(), ParseError> {
    match args.first().map(String::as_str) {
        None => Ok(()),
        Some("-h" | "--help") => Err(ParseError::Help),
        Some(a) => Err(unknown_flag("version", a)),
    }
}

pub fn usage_version() -> String {
    "사용법: otterminal version

판·대상(OS/아키텍처)·go 런타임을 찍는다. --version 도 같다.
"
    .to_owned()
}

/// 대상과 런타임을 함께 찍는다 — darwin 은 amd64/arm64 를 잘못 받아도 Rosetta 로 돌아
/// 증상만으로는 구별되지 않는다 (FR-RVN-3).
pub fn run_version(stdout: &mut dyn Write) -> i32 {
    let _ = writeln!(
        stdout,
        "otterminal {VERSION} {} {GO_RUNTIME}",
        otter_shared_platform::build_target()
    );
    0
}
