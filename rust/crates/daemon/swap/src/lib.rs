//! Go 기준선 `dongminal/internal/daemon/swap` 의 Rust 포팅. RUST_PORT_SRS 참고.
//!
//! 데몬 교체(세션 유지 재시작)의 데몬 쪽이다 (DAEMON_SESSION_KEEP_SRS 묶음 H·R). 교체 요청을
//! 검사하고(FR-DSK-11), 새 바이너리를 미리 실행해 인계 판을 맞춰 본 뒤(FR-DSK-12), 도구를 멈추고
//! 인계 상태를 fd 로 넘겨 exec 한다. exec 뒤의 새 데몬은 그 상태로 도구를 되살린다.

mod recover;
mod reload;
mod restore;
mod state;
mod validate;

pub use recover::{Orphan, close_inherited_sockets, find_orphans, recover};
pub use reload::{Deps, ExecFn, PREFLIGHT_WITHIN, PreflightFn, Reloader};
pub use restore::{inherit_listeners, restore};
pub use state::{State, read_state, write_state};
pub use validate::{Env, Gate, preflight, validate};

#[cfg(all(test, unix))]
mod tests;
