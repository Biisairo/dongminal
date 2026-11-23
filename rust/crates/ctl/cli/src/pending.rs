//! 실행을 아직 옮기지 않은 액션의 자리. 파서·도움말은 이미 Go 와 같다 — 인자 오류와 `--help` 는
//! 기준선과 바이트로 같고, 실행만 하위 이슈(6.1.2·6.1.3)가 채운다. 그때 이 모듈은 사라진다.

use std::io::Write;

pub(crate) fn not_ported(action: &str, issue: &str, stderr: &mut dyn Write) -> i32 {
    let _ = writeln!(
        stderr,
        "dongminal {action}: Rust 판에는 아직 없습니다 (rust-port {issue})"
    );
    1
}
