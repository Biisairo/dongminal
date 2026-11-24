//! dmctl 하위 명령의 인자 표 (OPTIMIZE_REFACTOR_SRS FR-OPT-9-2). 값 플래그는 `--k v` 와
//! `--k=v` 를 모두 받는다. `-h`·`--help` 는 그 자리에서 멈춘다.

use crate::ctx::{Ctx, errf, outf};

#[derive(Default)]
pub(crate) struct ArgSpec<'a> {
    /// `-h`·`--help` 에 stdout 으로 쓰는 것이다.
    pub help: &'a str,
    /// 값을 받는 플래그다. 설정자가 오류를 내면 그 자리에서 멈춘다.
    pub vals: &'a [&'a str],
    pub bools: &'a [&'a str],
    /// 참이면 플래그가 아닌 인자와 `--` 뒤를 모두 rest 에 모은다. 이때 `-h`·`--help` 는
    /// 호출자의 몫이라 건너뛰고, `-` 로 시작하는 모르는 것은 오류다.
    pub rest: bool,
    /// `--k=` 처럼 값이 빈 등호 형을 모르는 인자로 본다.
    pub strict_eq: bool,
    /// rest 가 있어도 `-h`·`--help` 를 이 spec 의 도움말로 받는다.
    pub rest_help: bool,
    /// rest 모드에서 `-` 하나를 위치 인자로 받는다.
    pub dash: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum ArgError {
    NeedsValue(String),
    Unknown(String),
    /// (플래그, 설정자의 오류)
    Invalid(String, String),
}

/// 설정자다. 불리언 플래그는 값이 `None` 이다.
pub(crate) type Setter<'s> = dyn FnMut(&str, Option<&str>) -> Result<(), String> + 's;

pub(crate) fn unknown_arg(a: &str) -> String {
    format!("unknown argument: {a}")
}

pub(crate) fn is_help_arg(a: &str) -> bool {
    a == "-h" || a == "--help"
}

impl ArgSpec<'_> {
    /// 인자를 앞에서부터 읽는다. `Ok(true)` 이면 도움말 인자를 만나 멈췄다.
    pub fn parse(
        &self,
        args: &[String],
        rest: &mut Vec<String>,
        set: &mut Setter<'_>,
    ) -> Result<bool, ArgError> {
        let mut i = 0;
        while i < args.len() {
            let a = args[i].as_str();
            if is_help_arg(a) {
                if self.rest && !self.rest_help {
                    i += 1;
                    continue;
                }
                return Ok(true);
            }
            if self.rest && a == "--" {
                rest.extend_from_slice(&args[i + 1..]);
                return Ok(false);
            }
            if self.bools.contains(&a) {
                set(a, None).map_err(|e| ArgError::Invalid(a.to_owned(), e))?;
                i += 1;
                continue;
            }
            if self.vals.contains(&a) {
                if i + 1 >= args.len() {
                    return Err(ArgError::NeedsValue(a.to_owned()));
                }
                i += 1;
                set(a, Some(&args[i])).map_err(|e| ArgError::Invalid(a.to_owned(), e))?;
                i += 1;
                continue;
            }
            if let Some(eq) = a.find('=')
                && eq > 0
                && !(self.strict_eq && eq == a.len() - 1)
                && self.vals.contains(&&a[..eq])
            {
                let k = &a[..eq];
                set(k, Some(&a[eq + 1..])).map_err(|e| ArgError::Invalid(k.to_owned(), e))?;
                i += 1;
                continue;
            }
            if self.rest && (!a.starts_with('-') || (self.dash && a == "-")) {
                rest.push(a.to_owned());
                i += 1;
                continue;
            }
            return Err(ArgError::Unknown(a.to_owned()));
        }
        Ok(false)
    }

    /// parse 에 공통 응답을 입힌다: 도움말은 stdout 에 쓰고 0, 오류는 `<prefix>: …` 를
    /// stderr 에 쓰고 2. `None` 일 때만 호출자가 계속한다.
    pub fn run(
        &self,
        ctx: &mut Ctx<'_>,
        prefix: &str,
        args: &[String],
        rest: &mut Vec<String>,
        set: &mut Setter<'_>,
    ) -> Option<i32> {
        match self.parse(args, rest, set) {
            Ok(true) => {
                outf!(ctx, "{}", self.help);
                Some(0)
            }
            Ok(false) => None,
            Err(e) => {
                match e {
                    ArgError::NeedsValue(a) => errf!(ctx, "{prefix}: flag {a} requires value\n"),
                    ArgError::Invalid(_, msg) => errf!(ctx, "{prefix}: {msg}\n"),
                    ArgError::Unknown(a) => errf!(ctx, "{prefix}: {}\n", unknown_arg(&a)),
                }
                Some(2)
            }
        }
    }
}

/// Go `strconv.Atoi`: 10진 정수, 앞의 `+`·`-` 허용, int64 범위.
pub(crate) fn atoi(s: &str) -> Option<i64> {
    let digits = s.strip_prefix(['+', '-']).unwrap_or(s);
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    s.parse::<i64>().ok()
}
