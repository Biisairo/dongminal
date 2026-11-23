//! Go 기준선 `dongminal/internal/ctl/cli` 의 Rust 포팅. RUST_PORT_SRS 참고.
//!
//! 액션 분기·옵션 해석·도움말과, 그 위에 선 명령들(`config`·`window`·`version`)이다.

mod actions;
mod backup;
mod config;
mod config_bind;
mod doctor;
mod doctor_probe;
mod env;
mod handoff;
mod health;
mod health_wait;
mod help;
mod homelayout;
mod http;
mod logcap;
mod migrate;
mod open;
mod options;
mod pending;
mod proc;
mod report;
mod rollback;
mod service;
mod session_keep;
mod shellwait;
mod staleness;
mod start;
mod stop;
mod uninstall;
mod update;
mod update_notice;
mod version;
mod wait;
mod window;

#[cfg(test)]
mod tests;

pub use actions::{Serve, ServeTarget, action_names, dispatch};
pub use backup::{BackupOpts, RestoreOpts, parse_backup, parse_restore};
pub use config::{ConfigOpts, parse_config, run_config};
pub use doctor::run_doctor;
pub use health::run_health;
pub use help::{
    help, unknown_action, usage, usage_backup, usage_config, usage_doctor, usage_health,
    usage_migrate, usage_restore, usage_rollback, usage_service, usage_start, usage_stop,
    usage_uninstall, usage_update, usage_verify, usage_window,
};
pub use homelayout::{HomeEntry, home_layout};
pub use logcap::{LOG_CHECK_EVERY, LOG_KEEP_BYTES, LOG_MAX_BYTES, watch_log_size};
pub use migrate::run_migrate;
pub use options::{
    Common, DEFAULT_HOST, DEFAULT_PORT, DoctorOpts, ENV_HOME, ENV_HOST, ENV_LOG, ENV_PORT,
    ENV_RESTART_RUNNER, ENV_TOOL_ID, EXPOSE_HOST, HealthOpts, MigrateOpts, ParseError, StartOpts,
    StopOpts, Target, VerifyOpts, WindowOpts, default_log_file, parse_doctor, parse_health,
    parse_migrate, parse_start, parse_stop, parse_verify, parse_window,
};
pub use rollback::{RollbackOpts, parse_rollback, run_rollback};
pub use service::{ServiceOpts, parse_service, run_service};
pub use staleness::{DAEMON_BUILD, DaemonState};
pub use start::run_start;
pub use stop::run_stop;
pub use uninstall::{UninstallOpts, parse_uninstall, run_uninstall};
pub use update::{UpdateOpts, parse_update, run_update};
pub use version::{GO_RUNTIME, VERSION, parse_version, run_version, usage_version};
pub use window::{Opener, run_window};
