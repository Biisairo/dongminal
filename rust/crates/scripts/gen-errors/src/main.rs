//! 오류 카탈로그 생성기 (ERROR_CONTRACT_SRS FR-ERR-8). Go `scripts/gen-errors`.
//!
//!     gen-errors          # docs/external/errors.md 를 쓴다
//!     gen-errors -check   # 어긋나면 exit 1 (CI 가 부른다)
//!
//! 저장소 뿌리에서 돈다.

use std::process::ExitCode;

use otter_gocompat::flag::FlagSet;
use otter_gocompat::oserr::{go_error_string, path_error};

const OUT: &str = "docs/external/errors.md";
/// 생성물이 어긋났을 때 안내하는 명령이다.
const REGEN: &str = otter_ctl_errdoc::GENERATE;
/// 카탈로그의 원천이다.
const SOURCE: &str = "apierr 의 코드 안내(code_doc)";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().collect();
    let mut fs = FlagSet::new(args.first().map_or("", String::as_str));
    let check = fs.bool("check", false, "고치지 않고 어긋남만 본다");
    if let Err((code, msg)) = fs.parse_or_exit(args.get(1..).unwrap_or_default()) {
        eprint!("{msg}");
        return ExitCode::from(u8::try_from(code).unwrap_or(2));
    }

    let body = match otter_ctl_errdoc::render() {
        Ok(b) => b,
        Err(e) => {
            eprintln!("카탈로그를 만들지 못했습니다: {e}");
            return ExitCode::FAILURE;
        }
    };
    if fs.get(check) {
        let Ok(cur) = std::fs::read(OUT) else {
            eprintln!("{OUT} 가 없습니다 — `{REGEN}` 를 돌리세요");
            return ExitCode::FAILURE;
        };
        if cur != body.as_bytes() {
            eprintln!("{OUT} 가 {SOURCE} 와 어긋납니다.");
            eprintln!("  `{REGEN}` 를 돌려 다시 만드세요.");
            eprintln!("  (이 파일은 생성물입니다 — 직접 고치지 마세요.)");
            return ExitCode::FAILURE;
        }
        println!("error-docs ok ({OUT})");
        return ExitCode::SUCCESS;
    }
    if let Err(e) = std::fs::write(OUT, &body) {
        eprintln!("{}", go_error_string(&path_error("open", OUT, e)));
        return ExitCode::FAILURE;
    }
    println!("✅ {OUT}");
    ExitCode::SUCCESS
}
