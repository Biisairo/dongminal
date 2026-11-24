//! Go 기준선 `dongminal/internal/shared/dmenv` 의 Rust 포팅. RUST_PORT_SRS 참고.
//!
//! 프로세스들이 공유하는 실행 환경 계약이다 — 자식 프로세스에 심는 환경변수 이름,
//! 홈 아래 파일 이름, 바인드 주소 판정.

mod host;
mod names;
mod tuning;

pub use host::{
    base_url, dial_host, exposure_label, is_exposed_host, is_unspecified_host, join_host_port,
    listen_addr,
};
pub use names::*;
pub use tuning::{flag_env, millis_env, or};

use std::path::{Path, PathBuf};

/// multi-call 로 서는 헬퍼의 이름 전부다. `runtimebin` 의 디스패치 표와 같아야 한다.
pub fn helper_names() -> &'static [&'static str] {
    &["dmctl", "edit", "download", "detach", "open-url"]
}

/// bin 디렉터리의 에이전트 훅·오버레이 자산 자리 (OMP_AGENT_SUPPORT_SRS FR-OMP-10·21).
pub fn agent_hooks_dir_in(bin_dir: &Path) -> PathBuf {
    bin_dir.join("agent-hooks")
}

/// bin 디렉터리의 shim 폴더 (CLAUDE_ACCOUNTS_SRS FR-CAC-83).
pub fn agent_shims_dir_in(bin_dir: &Path) -> PathBuf {
    bin_dir.join("agent-shims")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn helper_names_match_go() {
        assert_eq!(
            helper_names(),
            ["dmctl", "edit", "download", "detach", "open-url"]
        );
    }

    #[test]
    fn agent_dirs() {
        let bin = Path::new("/h/bin");
        assert_eq!(agent_hooks_dir_in(bin), Path::new("/h/bin/agent-hooks"));
        assert_eq!(agent_shims_dir_in(bin), Path::new("/h/bin/agent-shims"));
    }
}
