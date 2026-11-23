//! Go 기준선 `dongminal/internal/helper/runtimebin` 의 Rust 포팅. RUST_PORT_SRS 참고.
//!
//! dongminal 바이너리가 argv0 이름에 따라 `dmctl`·`edit`·`download`·`detach`·`open-url`·
//! 에이전트 셈으로 동작하게 하는 multi-call 분기다.
//!
//! ```ignore
//! if let Some(code) = dm_helper_runtimebin::dispatch(std::env::args_os()) {
//!     std::process::exit(code);
//! }
//! ```

mod argparse;
mod budgets;
mod ctx;
mod detach;
mod dmctl;
mod download;
mod edit;
mod helptext;
mod http;
mod openurl;
mod report;

#[cfg(test)]
mod tests;

use std::ffi::OsString;
use std::io;
use std::path::Path;

pub use ctx::{Ctx, Env};
pub use dmctl::rows::match_fold;

/// 헬퍼 하나의 진입점이다. `args` 는 argv0 을 뺀 인자다.
pub type RunFn = fn(&mut Ctx<'_>, &[String]) -> i32;

/// argv0 이름에 해당하는 헬퍼다. 없으면 `None` — 제어 CLI 의 몫이다.
pub fn helper(name: &str) -> Option<RunFn> {
    match name {
        "dmctl" => Some(dmctl::run_dmctl),
        "edit" => Some(edit::run_edit),
        "download" => Some(download::run_download),
        "detach" => Some(detach::run_detach),
        // VIEWER_URL_OPEN_SRS FR-VUO-12: BROWSER 는 실행 파일을 요구하므로 헬퍼로 선다.
        "open-url" => Some(openurl::run_open_url),
        _ => None,
    }
}

/// argv[0] 에서 실행 파일의 이름을 뽑는다. 실행 파일의 확장자(`.exe`·`.com`·`.bat`·`.cmd`,
/// 대소문자 무시)만 뗀다 — 다른 점은 이름의 일부일 수 있다.
pub fn helper_name(arg0: &str) -> String {
    let name = dm_gocompat::filepath::base(arg0);
    let ext = dm_gocompat::filepath::ext(&name);
    for want in [".exe", ".com", ".bat", ".cmd"] {
        if ext.eq_ignore_ascii_case(want) {
            return name[..name.len() - want.len()].to_owned();
        }
    }
    name
}

/// argv[0] 의 이름이 헬퍼이면 그 헬퍼를 프로세스의 표준 입출력으로 실행하고 종료 코드를
/// 돌려준다. 헬퍼가 아니면 `None`.
pub fn dispatch<I: IntoIterator<Item = OsString>>(argv: I) -> Option<i32> {
    let argv: Vec<String> = argv.into_iter().map(os_to_string).collect();
    let arg0 = argv.first()?;
    let run = helper(&helper_name(arg0))?;
    let env = Env::process();
    let (mut out, mut err, mut inp) = (io::stdout(), io::stderr(), io::stdin());
    let mut ctx = Ctx::new(&mut out, &mut err, &mut inp, &env);
    Some(run(&mut ctx, &argv[1..]))
}

fn os_to_string(s: OsString) -> String {
    s.into_string()
        .unwrap_or_else(|s| s.to_string_lossy().into_owned())
}

/// env 의 인스턴스 홈 아래 에이전트 훅 자리다. 홈을 모르면 빈 문자열이다.
pub(crate) fn agent_hooks_dir_in(env: &Env) -> String {
    let home = env.get(dm_shared_dmenv::ENV_HOME);
    if home.is_empty() {
        return String::new();
    }
    let bin = Path::new(&home).join(dm_shared_dmenv::BIN_DIR);
    dm_shared_dmenv::agent_hooks_dir_in(&bin)
        .to_string_lossy()
        .into_owned()
}

/// 이 프로세스가 속한 인스턴스의 에이전트 훅 자리다. 홈(`DONGMINAL_HOME`)을 모르면 빈 문자열이다.
pub fn agent_hooks_dir() -> String {
    let home = Env::process().get(dm_shared_dmenv::ENV_HOME);
    if home.is_empty() {
        return String::new();
    }
    let bin = Path::new(&home).join(dm_shared_dmenv::BIN_DIR);
    dm_shared_dmenv::agent_hooks_dir_in(&bin)
        .to_string_lossy()
        .into_owned()
}
