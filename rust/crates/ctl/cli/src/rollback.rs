//! `dongminal rollback` — 상태 파일을 백업 세대로 되돌린다 (G3-2·G4-4).

use dm_gocompat::strconv::quote;

use crate::options::{Common, ParseError, atoi, invalid};

/// `dongminal rollback` 의 옵션이다. 공통 파서를 쓰지 않는다 — `--home` 만 받는다.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RollbackOpts {
    pub common: Common,
    /// 되돌릴 세대다. 0 이면 목록만 보인다.
    pub gen_no: i64,
    /// 되돌릴 상태 파일이다. 비면 `workspace.json` 이다.
    pub file: String,
}

pub fn parse_rollback(args: &[String]) -> Result<RollbackOpts, ParseError> {
    let mut o = RollbackOpts::default();
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "-h" | "--help" => return Err(ParseError::Help),
            "--gen" => {
                if i + 1 >= args.len() {
                    return Err(invalid("--gen 에 번호가 필요합니다"));
                }
                i += 1;
                match atoi(&args[i]) {
                    Some(n) if n >= 1 => o.gen_no = n,
                    _ => {
                        return Err(invalid(format!(
                            "--gen 은 1 이상의 번호입니다: {}",
                            quote(&args[i])
                        )));
                    }
                }
            }
            "--file" => {
                if i + 1 >= args.len() {
                    return Err(invalid("--file 에 이름이 필요합니다"));
                }
                i += 1;
                o.file = args[i].clone();
            }
            "--home" => {
                if i + 1 >= args.len() {
                    return Err(invalid("--home 에 경로가 필요합니다"));
                }
                i += 1;
                o.common.home = args[i].clone();
            }
            a => return Err(invalid(format!("알 수 없는 인자: {}", quote(a)))),
        }
        i += 1;
    }
    Ok(o)
}
