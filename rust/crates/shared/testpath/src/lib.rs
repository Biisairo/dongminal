//! Go 기준선 `dongminal/internal/shared/testpath` 의 Rust 포팅. RUST_PORT_SRS 참고.
//!
//! 테스트가 OS 마다 달라지는 전제를 분기 없이 다루게 한다 (WINDOWS_TEST_PARITY_SRS
//! FR-WTP-10·11). 제품 코드는 이 crate 를 쓰지 않는다. dev-dependencies 로만 넣는다.
//!
//! Go 판은 `os.Setenv` 로 테스트 바이너리 전체의 환경을 바꿨다(`PinShell`·`IsolateToolHome`).
//! Rust 2024 에서 환경 변경은 `unsafe` 이므로, 여기서는 띄울 자식 프로세스에 넘길 값을
//! 돌려주고 부르는 쪽이 `Command::env` 로 심는다.

mod caps;
mod shell;
mod toolhome;

pub use caps::{foreground_groups, home_env, perm_checked, posix_shell, symlinks};
pub use shell::{pinned_shell, shells};
pub use toolhome::ToolHome;

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// 이 호스트에서 절대경로가 시작하는 자리다. POSIX `/`, Windows 현재 볼륨의 `C:\`.
fn volume_root() -> &'static Path {
    static ROOT: OnceLock<PathBuf> = OnceLock::new();
    ROOT.get_or_init(|| {
        let sep = PathBuf::from(std::path::MAIN_SEPARATOR_STR);
        std::path::absolute(&sep).unwrap_or(sep)
    })
}

/// 조각들을 이어 OS 형태의 절대경로를 만든다. 실재하지 않아도 된다.
pub fn abs(seg: &[&str]) -> PathBuf {
    let mut p = volume_root().to_path_buf();
    for s in seg {
        p.push(s);
    }
    p
}

/// 볼륨 루트 자신이다.
pub fn root() -> PathBuf {
    volume_root().to_path_buf()
}

/// 값을 JSON 문자열 리터럴로 만든다 — 바깥 따옴표까지 포함한다 (FR-WTP-20).
pub fn json_quote(s: &str) -> String {
    let mut out = Vec::new();
    dm_gocompat::json::append_string(&mut out, s.as_bytes(), true);
    String::from_utf8_lossy(&out).into_owned()
}

/// 값이 JSON 안에 적혔을 때의 모습이다 — 바깥 따옴표는 뺀다.
pub fn json_inner(s: &str) -> String {
    let q = json_quote(s);
    q[1..q.len() - 1].to_owned()
}

#[cfg(test)]
mod tests;
