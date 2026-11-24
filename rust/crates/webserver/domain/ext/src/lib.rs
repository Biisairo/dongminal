//! Go 기준선 `otterminal/internal/webserver/domain/ext` 의 Rust 포팅. RUST_PORT_SRS 참고.
//!
//! 언어 서버가 **플러그인으로 오는** 자리다 (LSP_PLUGIN_SRS). 서버 목록은 코드가 아니라
//! 매니페스트에 있다 (FR-EXT-1). 이름이 `plugin` 이 아닌 것은 Claude Code 플러그인과 가르기
//! 위해서다 (§1.3).

mod builtin;
mod ctx;
mod env;
mod error;
mod fetch;
mod goos;
mod install;
mod load;
mod locate;
mod manifest;
mod service;

pub use builtin::{builtins, deploy};
pub use ctx::{Ctx, CtxError};
pub use env::{isolated_env, isolated_env_with_path, managed_bin_dir};
pub use error::{Error, Sentinel};
pub use fetch::{BoxFuture, EXTRACT_RATIO, Fetch, HttpFetch, MAX_ARCHIVE_BYTES, fetch_archive};
pub use install::{
    Exec, ExecResult, HostExec, INSTALL_TIMEOUT, INSTALL_WAIT_DELAY, Installer, OUTPUT_TAIL,
    Outcome,
};
pub use load::{load, packs, runtimes, server_for_ext};
pub use locate::{
    DIR_NAME, Locator, LookPath, MISSING_NOT_FETCHED, MISSING_RUNTIME, MISSING_TARGET,
    MISSING_TOOL, Missing, ORIGIN_CONFIG, ORIGIN_MANAGED, ORIGIN_PATH, Status, cache_dir,
    host_look_path, managed_exe, managed_exe_found, plugin_dir, plugins_dir, root_in, runtime_dir,
    runtime_exe, runtimes_dir,
};
pub use manifest::{
    KIND_RUNTIME, KIND_SERVER, MANIFEST_NAME, Manifest, SOURCE_ARCHIVE, SOURCE_NPM,
    SOURCE_TOOLCHAIN, Server, Source, Target, current_target, parse_manifest, target_name,
};
pub use service::{Service, missing_text};

#[cfg(test)]
mod tests;
