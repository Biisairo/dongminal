//! `dongminal service install` — 이 OS 의 감독자에 넣을 정의를 만든다 (SEC-23).

use crate::backup::flag_value;
use crate::options::{Common, ParseError, invalid, unknown_flag};

/// `dongminal service` 의 옵션이다.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ServiceOpts {
    pub common: Common,
    pub sub: String,
    pub out: String,
}

pub fn parse_service(args: &[String]) -> Result<ServiceOpts, ParseError> {
    let mut o = ServiceOpts::default();
    let mut i = 0;
    while i < args.len() {
        let a = args[i].as_str();
        if a == "-h" || a == "--help" {
            return Err(ParseError::Help);
        } else if a == "--out" || a.starts_with("--out=") {
            let (v, adv) = flag_value(args, i, "--out")?;
            o.out = v;
            i += adv;
        } else if a.starts_with('-') {
            if !o.common.take(args, &mut i)? {
                return Err(unknown_flag("service", a));
            }
        } else if o.sub.is_empty() {
            o.sub = a.to_owned();
        } else {
            return Err(invalid(format!("service: 인자가 너무 많습니다: {a}")));
        }
        i += 1;
    }
    if o.sub != "install" {
        return Err(invalid("service: 하위 명령은 install 입니다"));
    }
    Ok(o)
}
