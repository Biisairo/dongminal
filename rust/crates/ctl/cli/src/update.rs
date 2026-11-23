//! `dongminal update` — 최신 판이 있는지 확인한다 (G3-3).

use crate::options::{ParseError, unknown_flag};

/// `dongminal update` 의 옵션이다. 공통 옵션을 받지 않는다.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct UpdateOpts {
    pub check: bool,
}

pub fn parse_update(args: &[String]) -> Result<UpdateOpts, ParseError> {
    let mut o = UpdateOpts::default();
    for a in args {
        match a.as_str() {
            "-h" | "--help" => return Err(ParseError::Help),
            "--check" => o.check = true,
            _ => return Err(unknown_flag("update", a)),
        }
    }
    Ok(o)
}
