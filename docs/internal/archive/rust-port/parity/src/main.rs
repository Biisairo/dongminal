//! `dm-parity --go <경로> --rust <경로> [--issues <폴더>] [--only <이름>]... [--list] [--keep]`
//! (SPEC FR-PAR-40·42).

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::process::ExitCode;

use dm_parity::issues::{ENV_ISSUES_DIR, Verdict, load_status, verdict};
use dm_parity::{Options, run_scenario, scenarios};

const EXIT_DIFF: u8 = 1;
const EXIT_USAGE: u8 = 2;
const USAGE: &str = "사용법: dm-parity --go <Go 바이너리> --rust <Rust 바이너리> [--issues <이슈 폴더>] [--only <시나리오>]... [--list] [--keep]";

struct Args {
    go: Option<PathBuf>,
    rust: Option<PathBuf>,
    issues: Option<PathBuf>,
    only: Vec<String>,
    list: bool,
    keep: bool,
}

fn parse(mut it: impl Iterator<Item = String>) -> Result<Args, String> {
    let mut a = Args {
        go: None,
        rust: None,
        issues: std::env::var_os(ENV_ISSUES_DIR).map(PathBuf::from),
        only: Vec::new(),
        list: false,
        keep: false,
    };
    while let Some(arg) = it.next() {
        let mut value = |name: &str| it.next().ok_or_else(|| format!("{name} 에 값이 없다"));
        match arg.as_str() {
            "--go" => a.go = Some(PathBuf::from(value("--go")?)),
            "--rust" => a.rust = Some(PathBuf::from(value("--rust")?)),
            "--issues" => a.issues = Some(PathBuf::from(value("--issues")?)),
            "--only" => a.only.push(value("--only")?),
            "--list" => a.list = true,
            "--keep" => a.keep = true,
            "-h" | "--help" => return Err(String::new()),
            other => return Err(format!("알 수 없는 인자: {other}")),
        }
    }
    Ok(a)
}

fn usage_error(msg: &str) -> ExitCode {
    if !msg.is_empty() {
        eprintln!("{msg}");
    }
    eprintln!("{USAGE}");
    ExitCode::from(EXIT_USAGE)
}

fn main() -> ExitCode {
    let args = match parse(std::env::args().skip(1)) {
        Ok(a) => a,
        Err(e) => return usage_error(&e),
    };
    let all = scenarios::all();
    if args.list {
        for s in &all {
            println!("{}\t{}", s.name(), s.owner_issue().unwrap_or("-"));
        }
        return ExitCode::SUCCESS;
    }
    let unknown: Vec<&String> = args
        .only
        .iter()
        .filter(|n| !all.iter().any(|s| s.name() == n.as_str()))
        .collect();
    if !unknown.is_empty() {
        return usage_error(&format!("없는 시나리오: {unknown:?}"));
    }
    let (Some(go), Some(rust)) = (args.go, args.rust) else {
        return usage_error("");
    };
    let mut opts = match Options::from_env() {
        Ok(o) => o,
        Err(e) => return usage_error(&e),
    };
    opts.keep = args.keep;
    let selected: Vec<_> = all
        .iter()
        .filter(|s| args.only.is_empty() || args.only.iter().any(|n| n == s.name()))
        .collect();
    let statuses = match &args.issues {
        Some(dir) => match load_status(dir) {
            Ok(m) => m,
            Err(e) => return usage_error(&e),
        },
        None if selected.iter().any(|s| s.owner_issue().is_some()) => {
            return usage_error(&format!(
                "담당 이슈가 있는 시나리오는 --issues 나 {ENV_ISSUES_DIR} 가 필요하다"
            ));
        }
        None => BTreeMap::new(),
    };
    let (mut same, mut differ, mut pending) = (0, 0, 0);
    for s in &selected {
        let report = run_scenario(s, &go, &rust, &opts);
        match verdict(&report, s.owner_issue(), &statuses) {
            Verdict::Same => {
                same += 1;
                println!("ok    {}", report.scenario);
            }
            Verdict::Pending { issue, status } => {
                pending += 1;
                println!(
                    "PEND  {} (담당 {issue}: {status}, 차이 {}개)",
                    report.scenario,
                    report.diffs.len()
                );
                if let Some(d) = report.diffs.first() {
                    println!("{d}");
                }
            }
            Verdict::Differ => {
                differ += 1;
                println!("DIFF  {}", report.scenario);
                for e in &report.errors {
                    println!("  오류: {e}");
                }
                for d in &report.diffs {
                    println!("{d}");
                }
            }
        }
        if opts.keep {
            for r in &report.roots {
                println!("  뿌리: {}", r.display());
            }
        }
    }
    println!(
        "{}개 중 같음 {same}, 다름 {differ}, 보류 {pending}",
        selected.len()
    );
    if differ == 0 {
        ExitCode::SUCCESS
    } else {
        ExitCode::from(EXIT_DIFF)
    }
}
