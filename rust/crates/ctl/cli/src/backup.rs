//! `dongminal backup`·`restore` — 홈을 zip 하나로 담고 되돌린다 (G4-3).

use crate::options::{Common, ParseError, invalid, unknown_flag};

/// `dongminal backup` 의 옵션이다.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct BackupOpts {
    pub common: Common,
    pub out: String,
}

/// `dongminal restore` 의 옵션이다.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RestoreOpts {
    pub common: Common,
    pub zip: String,
    pub yes: bool,
}

pub fn parse_backup(args: &[String]) -> Result<BackupOpts, ParseError> {
    let mut o = BackupOpts::default();
    let mut i = 0;
    while i < args.len() {
        let a = args[i].as_str();
        if a == "-h" || a == "--help" {
            return Err(ParseError::Help);
        } else if a == "--out" || a.starts_with("--out=") {
            let (v, adv) = flag_value(args, i, "--out")?;
            o.out = v;
            i += adv;
        } else if !o.common.take(args, &mut i)? {
            return Err(unknown_flag("backup", a));
        }
        i += 1;
    }
    if o.out.is_empty() {
        return Err(invalid("backup: --out <파일.zip> 이 필요합니다"));
    }
    Ok(o)
}

pub fn parse_restore(args: &[String]) -> Result<RestoreOpts, ParseError> {
    let mut o = RestoreOpts::default();
    let mut i = 0;
    while i < args.len() {
        let a = args[i].as_str();
        if a == "-h" || a == "--help" {
            return Err(ParseError::Help);
        } else if a == "--yes" || a == "-y" {
            o.yes = true;
        } else if a.starts_with('-') {
            if !o.common.take(args, &mut i)? {
                return Err(unknown_flag("restore", a));
            }
        } else if o.zip.is_empty() {
            o.zip = a.to_owned();
        } else {
            return Err(invalid(format!("restore: 인자가 너무 많습니다: {a}")));
        }
        i += 1;
    }
    if o.zip.is_empty() {
        return Err(invalid("restore: 백업 파일(.zip)이 필요합니다"));
    }
    Ok(o)
}

/// `--name v` 와 `--name=v` 를 읽는다. 두 번째 값은 소비한 다음 인자 수다.
pub(crate) fn flag_value(
    args: &[String],
    i: usize,
    name: &str,
) -> Result<(String, usize), ParseError> {
    let a = args[i].as_str();
    if let Some(v) = a.strip_prefix(name).and_then(|r| r.strip_prefix('=')) {
        if v.is_empty() {
            return Err(invalid(format!("{name} 에 값이 없습니다")));
        }
        return Ok((v.to_owned(), 0));
    }
    if i + 1 >= args.len() {
        return Err(invalid(format!("{name} 에 값이 없습니다")));
    }
    Ok((args[i + 1].clone(), 1))
}
