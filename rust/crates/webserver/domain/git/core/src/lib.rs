//! Go 기준선 `otterminal/internal/webserver/domain/git/core` 의 Rust 포팅. RUST_PORT_SRS 참고.
//!
//! otterminal 의 모든 git 실행이 통과하는 단일 지점이다 (GIT_SRS FR-GIT-1~8). 읽기는
//! `Service::exec`, 저장소를 바꾸는 것은 `Service::exec_write` 이며, 두 허용 목록의 교집합은
//! 비어 있어야 한다 (FR-GIT-95). 셸을 경유하지 않고 (FR-GIT-2), 실패를 빈 결과로 낮추지
//! 않는다 (FR-GIT-8).

#![forbid(unsafe_code)]

mod ctx;
mod destructive;
mod dirs;
mod error;
mod exclusion;
mod exec;
mod guard;
mod oid;
mod record;
mod recovery;
mod remote;
mod repo;
mod spawn;
mod time;
mod unguarded;
mod write;

pub use ctx::{Ctx, CtxError};
pub use destructive::*;
pub use error::{Error, ExecError, Kind, ctx_err, is_terminal, plain_exit};
pub use exclusion::{
    LOCK_WAIT, LockInfo, MANAGER_WRITE_TIMEOUT, POST_PHASE_TIMEOUT, PRE_PHASE_TIMEOUT,
    common_dir_key, exclusion_key, index_locked_stderr,
};
pub use exec::{
    BoxFut, Builder, DEFAULT_MAX_OUTPUT, DEFAULT_RECORD_CAP, DEFAULT_TIMEOUT, ENV_OVERRIDES,
    GitCommand, Output, Runner, Service, WriteRunner, command, env, launch_args, vanished_bin,
};
pub use guard::{
    CHECK_REF_FORMAT_BRANCH, CHECK_REF_FORMAT_NORMALIZE, check_ref_arg, rel_path, rel_path_detail,
};
pub use oid::{is_null_oid, is_oid};
pub use record::{Record, RecordSpan, Recorder, redact_secrets};
pub use recovery::{DEFAULT_HINT_CAP, Hint, HintLog};
pub use remote::{sanitize_argv, sanitize_remote};
pub use spawn::{Consumer, JOB_CEILING, KILL_GRACE, SpawnError, drain, exit_status_string, spawn};
pub use time::unix_sec_to_milli;
pub use unguarded::{
    TextFailure, TextRunner, Trim, UnguardedSpec, exec_unguarded, exec_unguarded_text,
    unguarded_text, unguarded_text_runner,
};
pub use write::{DEFAULT_STDERR_TAIL_LINES, WriteSpec, guard_write_args, is_write_command};

#[cfg(test)]
mod tests;
