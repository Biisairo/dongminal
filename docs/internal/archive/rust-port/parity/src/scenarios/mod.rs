//! 등록된 시나리오. 표면 목록과 담당 이슈는 `rust/parity/SURFACE.md`, 작성법은 `README.md`.

mod cli;
mod helper;
mod home;
mod http;

use crate::Scenario;

pub use cli::go_runtime_rule;

pub fn all() -> Vec<Scenario> {
    let mut out = cli::all();
    out.extend(helper::all());
    out.extend(http::all());
    out.extend(home::all());
    out
}
