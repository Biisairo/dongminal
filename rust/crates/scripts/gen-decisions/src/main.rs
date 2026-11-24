//! 결정 색인 생성기 (M5 `G8-1`). Go `scripts/gen-decisions`.
//!
//!     gen-decisions          # docs/internal/decisions.md 를 쓴다
//!     gen-decisions -check   # 어긋나면 exit 1 (CI 가 부른다)
//!
//! 저장소 뿌리에서 돈다.

use std::path::Path;
use std::process::ExitCode;

use otter_gocompat::flag::FlagSet;
use otter_gocompat::oserr::{go_error_string, path_error};

const SRC_DIR: &str = "docs/internal";
const OUT: &str = "docs/internal/decisions.md";
/// 생성물이 어긋났을 때 안내하는 명령이다.
const REGEN: &str = otter_ctl_decidx::GENERATE;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().collect();
    let mut fs = FlagSet::new(args.first().map_or("", String::as_str));
    let check = fs.bool("check", false, "고치지 않고 어긋남만 본다");
    if let Err((code, msg)) = fs.parse_or_exit(args.get(1..).unwrap_or_default()) {
        eprint!("{msg}");
        return ExitCode::from(u8::try_from(code).unwrap_or(2));
    }

    let entries = match otter_ctl_decidx::collect(Path::new(SRC_DIR)) {
        Ok(e) => e,
        Err(e) => {
            eprintln!("{}", go_error_string(&e));
            return ExitCode::FAILURE;
        }
    };
    let body = otter_ctl_decidx::render(&entries);

    if fs.get(check) {
        let Ok(cur) = std::fs::read(OUT) else {
            eprintln!("{OUT} 가 없습니다 — `{REGEN}` 를 돌리세요");
            return ExitCode::FAILURE;
        };
        if cur != body.as_bytes() {
            eprintln!("{OUT} 가 SRS 의 결정과 어긋납니다.");
            eprintln!("  `{REGEN}` 를 돌려 다시 만드세요.");
            eprintln!("  (이 파일은 생성물입니다 — 직접 고치지 마세요.)");
            return ExitCode::FAILURE;
        }
        println!("decisions ok ({}건)", entries.len());
        return ExitCode::SUCCESS;
    }
    if let Err(e) = std::fs::write(OUT, &body) {
        eprintln!("{}", go_error_string(&path_error("open", OUT, e)));
        return ExitCode::FAILURE;
    }
    println!("✅ {OUT} ({}건)", entries.len());
    ExitCode::SUCCESS
}
