//! 차분 실행기 (RUST_PORT_SRS V-RSP-2). 요구사항은 `rust/parity/SPEC.md`, 사용법은 `README.md`.

pub mod http;
pub mod normalize;
pub mod runner;
pub mod scenario;
pub mod scenarios;

pub use normalize::Rule;
pub use runner::{Diff, Options, Report, Side, run_scenario};
pub use scenario::{Cli, Http, Scenario, Serve};
