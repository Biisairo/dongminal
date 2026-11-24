//! 공유 상수 대조 (SERVER_DRIVEN_ACTIONS_SRS FR-SDA-81 · K-j · TC-SDA-11). Go `scripts/check-shared-constants`.
//!
//! 서버가 보낼 수 없는 상수(연결이 끊긴 순간에 쓰는 코드·부팅 전에 필요한 값 등)는 화면과 서버에 두
//! 벌로 남는다. 그 두 벌이 같은지 여기서 본다. 서버 쪽은 Rust 소스를 읽는다. 저장소 뿌리에서 돈다.

mod check;

use std::process::ExitCode;

use dm_gocompat::oserr::{go_error_string, path_error};

use check::{LOCALES, NEEDED, Sources, check};

fn read(path: &str) -> Result<String, ExitCode> {
    match std::fs::read(path) {
        Ok(raw) => Ok(String::from_utf8_lossy(&raw).into_owned()),
        Err(e) => {
            eprintln!("{}", go_error_string(&path_error("open", path, e)));
            Err(ExitCode::FAILURE)
        }
    }
}

fn main() -> ExitCode {
    let mut s = Sources {
        indicator_kinds: dm_webserver_domain_git_jobs::indicator_kinds(),
        ..Sources::default()
    };
    for p in NEEDED {
        match read(p) {
            Ok(v) => s.files.insert(p.to_owned(), v),
            Err(code) => return code,
        };
    }
    for l in LOCALES {
        match read(&format!("web/js/i18n/{l}.js")) {
            Ok(v) => s.locales.insert(l.to_owned(), v),
            Err(code) => return code,
        };
    }
    let bad = check(&s);
    if !bad.is_empty() {
        eprintln!("화면과 서버의 공유 상수가 어긋났습니다 — 두 쪽을 함께 고치세요:");
        for b in bad {
            eprintln!("  {b}");
        }
        return ExitCode::FAILURE;
    }
    println!("shared-constants ok (K9·K10·K12·K13·K17·K-h)");
    ExitCode::SUCCESS
}

#[cfg(test)]
mod tests;
