//! `dm-parity --go <경로> --rust <경로> [--only <이름>]... [--list] [--keep]` (SPEC FR-PAR-40).

use std::path::PathBuf;
use std::process::ExitCode;

use dm_parity::{Options, run_scenario, scenarios};

const EXIT_DIFF: u8 = 1;
const EXIT_USAGE: u8 = 2;
const USAGE: &str = "사용법: dm-parity --go <Go 바이너리> --rust <Rust 바이너리> [--only <시나리오>]... [--list] [--keep]";

struct Args {
    go: Option<PathBuf>,
    rust: Option<PathBuf>,
    only: Vec<String>,
    list: bool,
    keep: bool,
}

fn parse(mut it: impl Iterator<Item = String>) -> Result<Args, String> {
    let mut a = Args {
        go: None,
        rust: None,
        only: Vec::new(),
        list: false,
        keep: false,
    };
    while let Some(arg) = it.next() {
        let mut value = |name: &str| it.next().ok_or_else(|| format!("{name} 에 값이 없다"));
        match arg.as_str() {
            "--go" => a.go = Some(PathBuf::from(value("--go")?)),
            "--rust" => a.rust = Some(PathBuf::from(value("--rust")?)),
            "--only" => a.only.push(value("--only")?),
            "--list" => a.list = true,
            "--keep" => a.keep = true,
            "-h" | "--help" => return Err(String::new()),
            other => return Err(format!("알 수 없는 인자: {other}")),
        }
    }
    Ok(a)
}

fn main() -> ExitCode {
    let args = match parse(std::env::args().skip(1)) {
        Ok(a) => a,
        Err(e) => {
            if !e.is_empty() {
                eprintln!("{e}");
            }
            eprintln!("{USAGE}");
            return ExitCode::from(EXIT_USAGE);
        }
    };
    let all = scenarios::all();
    if args.list {
        for s in &all {
            println!("{}", s.name());
        }
        return ExitCode::SUCCESS;
    }
    let unknown: Vec<&String> = args
        .only
        .iter()
        .filter(|n| !all.iter().any(|s| s.name() == n.as_str()))
        .collect();
    if !unknown.is_empty() {
        eprintln!("없는 시나리오: {unknown:?}");
        return ExitCode::from(EXIT_USAGE);
    }
    let (Some(go), Some(rust)) = (args.go, args.rust) else {
        eprintln!("{USAGE}");
        return ExitCode::from(EXIT_USAGE);
    };
    let mut opts = match Options::from_env() {
        Ok(o) => o,
        Err(e) => {
            eprintln!("{e}");
            return ExitCode::from(EXIT_USAGE);
        }
    };
    opts.keep = args.keep;
    let selected: Vec<_> = all
        .iter()
        .filter(|s| args.only.is_empty() || args.only.iter().any(|n| n == s.name()))
        .collect();
    let mut failed = 0;
    for s in &selected {
        let report = run_scenario(s, &go, &rust, &opts);
        if report.ok() {
            println!("ok    {}", report.scenario);
        } else {
            failed += 1;
            println!("DIFF  {}", report.scenario);
            for e in &report.errors {
                println!("  오류: {e}");
            }
            for d in &report.diffs {
                println!("{d}");
            }
        }
        if opts.keep {
            for r in &report.roots {
                println!("  뿌리: {}", r.display());
            }
        }
    }
    println!("{}개 중 {}개 다름", selected.len(), failed);
    if failed == 0 {
        ExitCode::SUCCESS
    } else {
        ExitCode::from(EXIT_DIFF)
    }
}
