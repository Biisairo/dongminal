//! 호스트 능력. OS 이름이 아니라 능력의 이름으로 묻는다 (FR-XBD-3).

/// 이 OS 에서 홈 디렉터리를 정하는 환경변수 이름이다 (FR-WTP-9).
pub fn home_env() -> &'static str {
    if cfg!(windows) { "USERPROFILE" } else { "HOME" }
}

/// 이 호스트가 유닉스 권한 비트를 보존하는가 (FR-WTP-32).
pub fn perm_checked() -> bool {
    cfg!(unix)
}

/// 이 OS 에 전경 프로세스 그룹이 있는가 (CROSS_PLATFORM_SRS FR-XPT-5).
pub fn foreground_groups() -> bool {
    cfg!(unix)
}

/// 이 OS 가 `#!/bin/sh` 스크립트를 실행할 수 있는가.
pub fn posix_shell() -> bool {
    cfg!(unix)
}

/// 이 호스트가 권한 없이 심링크를 만들 수 있는가 (LEFTOVERS_SRS FR-LFT-2).
pub fn symlinks() -> bool {
    cfg!(unix)
}
