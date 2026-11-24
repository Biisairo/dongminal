//! 동작 사유 문구 대조 (SERVER_DRIVEN_ACTIONS_SRS FR-SDA-8 · M-7). Go `scripts/check-action-reasons`.
//!
//! 서버의 판정이 낼 수 있는 사유 코드(action catalog)마다 화면 카탈로그에 ko·en 문구(`why.<코드>`)가
//! 있어야 한다. 저장소 뿌리에서 돈다.

use std::collections::BTreeMap;
use std::process::ExitCode;

use otter_gocompat::oserr::{go_error_string, path_error};

const LOCALES: [&str; 2] = ["ko", "en"];

fn main() -> ExitCode {
    let mut src = BTreeMap::new();
    for l in LOCALES {
        let path = format!("web/js/i18n/{l}.js");
        match std::fs::read(&path) {
            Ok(raw) => {
                src.insert(l.to_owned(), String::from_utf8_lossy(&raw).into_owned());
            }
            Err(e) => {
                eprintln!("{}", go_error_string(&path_error("open", &path, e)));
                return ExitCode::FAILURE;
            }
        }
    }
    let catalog = otter_webserver_action::catalog();
    let missing = otter_webserver_action::missing_phrases(&catalog, &src);
    if !missing.is_empty() {
        eprintln!("사유 코드에 문구가 없습니다 — web/js/i18n/<로케일>.js 에 더하세요:");
        for m in missing {
            eprintln!("  {m}");
        }
        return ExitCode::FAILURE;
    }
    println!("action-reasons ok ({} actions)", catalog.len());
    ExitCode::SUCCESS
}
