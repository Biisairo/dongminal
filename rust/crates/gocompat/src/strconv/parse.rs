//! Go `strconv.ParseBool`·`ParseUint(s, 10, 64)` (go1.27.2 `src/strconv/atob.go`·`atoi.go`).

use std::fmt;

/// Go `*strconv.NumError` 의 사유.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NumErrorKind {
    Syntax,
    Range,
}

/// Go `*strconv.NumError`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NumError {
    pub func: &'static str,
    pub num: String,
    pub kind: NumErrorKind,
}

impl fmt::Display for NumError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let why = match self.kind {
            NumErrorKind::Syntax => "invalid syntax",
            NumErrorKind::Range => "value out of range",
        };
        write!(
            f,
            "strconv.{}: parsing {}: {why}",
            self.func,
            super::quote(&self.num)
        )
    }
}

impl std::error::Error for NumError {}

/// Go `strconv.ParseBool`.
pub fn parse_bool(s: &str) -> Result<bool, NumError> {
    match s {
        "1" | "t" | "T" | "TRUE" | "true" | "True" => Ok(true),
        "0" | "f" | "F" | "FALSE" | "false" | "False" => Ok(false),
        _ => Err(NumError {
            func: "ParseBool",
            num: s.to_owned(),
            kind: NumErrorKind::Syntax,
        }),
    }
}

/// Go `strconv.ParseUint(s, 10, 64)`. 부호·`_`·공백을 받지 않는다. 넘치면 최댓값과 Range 오류다.
pub fn parse_uint10(s: &str) -> Result<u64, NumError> {
    let err = |kind| NumError {
        func: "ParseUint",
        num: s.to_owned(),
        kind,
    };
    if s.is_empty() || !s.bytes().all(|c| c.is_ascii_digit()) {
        return Err(err(NumErrorKind::Syntax));
    }
    let mut n: u64 = 0;
    for c in s.bytes() {
        n = match n
            .checked_mul(10)
            .and_then(|n| n.checked_add(u64::from(c - b'0')))
        {
            Some(n) => n,
            None => return Err(err(NumErrorKind::Range)),
        };
    }
    Ok(n)
}
