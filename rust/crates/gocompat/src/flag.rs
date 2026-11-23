//! Go `flag` 패키지 중 저장소가 쓰는 범위: bool 플래그, 파싱 규칙, 오류·사용법 문구, 종료 코드.
//!
//! 저장소의 쓰임은 `scripts/gen-errors`·`scripts/gen-decisions` 의
//! `flag.Bool("check", false, ...)` + `flag.Parse()` 뿐이다.

use std::fmt;

/// [`FlagSet::bool`] 이 돌려주는 손잡이.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BoolFlag(usize);

#[derive(Debug, Clone)]
struct Entry {
    name: String,
    usage: String,
    default: bool,
    value: bool,
}

/// `Parse` 의 실패. `Display` 는 Go 의 오류 문구다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParseError {
    /// `-h`·`-help` (Go `flag.ErrHelp`).
    Help,
    /// 그 밖의 오류. 문구는 Go `f.failf` 와 같다.
    Invalid(String),
}

impl fmt::Display for ParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ParseError::Help => f.write_str("flag: help requested"),
            ParseError::Invalid(msg) => f.write_str(msg),
        }
    }
}

impl std::error::Error for ParseError {}

/// Go `*flag.FlagSet`.
#[derive(Debug, Clone)]
pub struct FlagSet {
    name: String,
    flags: Vec<Entry>,
    args: Vec<String>,
}

/// Go `strconv.ParseBool`.
fn parse_bool(s: &str) -> Option<bool> {
    match s {
        "1" | "t" | "T" | "TRUE" | "true" | "True" => Some(true),
        "0" | "f" | "F" | "FALSE" | "false" | "False" => Some(false),
        _ => None,
    }
}

/// Go `flag.UnquoteUsage`: 사용법 안의 첫 `` `이름` `` 을 꺼낸다. bool 은 없으면 이름이 비어 있다.
fn unquote_usage(usage: &str) -> (String, String) {
    if let Some(i) = usage.find('`')
        && let Some(j) = usage[i + 1..].find('`')
    {
        let j = i + 1 + j;
        let name = usage[i + 1..j].to_owned();
        return (
            name.clone(),
            format!("{}{}{}", &usage[..i], name, &usage[j + 1..]),
        );
    }
    (String::new(), usage.to_owned())
}

impl FlagSet {
    /// Go `flag.NewFlagSet(name, ...)`. 명령줄 전체(`flag.CommandLine`)면 이름은 `os.Args[0]` 이다.
    pub fn new(name: &str) -> Self {
        Self {
            name: name.to_owned(),
            flags: Vec::new(),
            args: Vec::new(),
        }
    }

    /// Go `fs.Bool(name, value, usage)`.
    pub fn bool(&mut self, name: &str, default: bool, usage: &str) -> BoolFlag {
        self.flags.push(Entry {
            name: name.to_owned(),
            usage: usage.to_owned(),
            default,
            value: default,
        });
        BoolFlag(self.flags.len() - 1)
    }

    /// 플래그의 현재 값.
    pub fn get(&self, flag: BoolFlag) -> bool {
        self.flags.get(flag.0).is_some_and(|e| e.value)
    }

    /// Go `fs.Args()`: 플래그 뒤에 남은 인자.
    pub fn args(&self) -> &[String] {
        &self.args
    }

    /// Go 의 기본 `Usage` 출력(`Usage of NAME:` + `PrintDefaults`).
    pub fn usage(&self) -> String {
        let mut out = if self.name.is_empty() {
            "Usage:\n".to_owned()
        } else {
            format!("Usage of {}:\n", self.name)
        };
        let mut sorted: Vec<&Entry> = self.flags.iter().collect();
        sorted.sort_by(|a, b| a.name.cmp(&b.name));
        for e in sorted {
            let mut line = format!("  -{}", e.name);
            let (name, usage) = unquote_usage(&e.usage);
            if !name.is_empty() {
                line.push(' ');
                line.push_str(&name);
            }
            if line.len() <= 4 {
                line.push('\t');
            } else {
                line.push_str("\n    \t");
            }
            line.push_str(&usage.replace('\n', "\n    \t"));
            if e.default {
                line.push_str(" (default true)");
            }
            out.push_str(&line);
            out.push('\n');
        }
        out
    }

    /// Go `fs.Parse(args)`(ContinueOnError). 오류면 Go 가 출력에 쓰는 문구와 함께 돌려준다:
    /// [`ParseError::Help`] 는 [`FlagSet::usage`] 만, 그 밖은 `오류\n` + 사용법.
    pub fn parse(&mut self, args: &[String]) -> Result<(), ParseError> {
        let mut rest: &[String] = args;
        while let Some(arg) = rest.first() {
            let b = arg.as_bytes();
            if b.len() < 2 || b[0] != b'-' {
                break;
            }
            let mut minuses = 1;
            if b[1] == b'-' {
                minuses += 1;
                if b.len() == 2 {
                    rest = &rest[1..];
                    break;
                }
            }
            let name = &arg[minuses..];
            if name.is_empty() || name.starts_with('-') || name.starts_with('=') {
                self.args = rest.to_vec();
                return Err(ParseError::Invalid(format!("bad flag syntax: {arg}")));
            }
            rest = &rest[1..];
            let (name, value) = match name.split_once('=') {
                Some((n, v)) => (n, Some(v)),
                None => (name, None),
            };
            let Some(idx) = self.flags.iter().position(|e| e.name == name) else {
                self.args = rest.to_vec();
                if name == "help" || name == "h" {
                    return Err(ParseError::Help);
                }
                return Err(ParseError::Invalid(format!(
                    "flag provided but not defined: -{name}"
                )));
            };
            match value {
                None => self.flags[idx].value = true,
                Some(v) => match parse_bool(v) {
                    Some(b) => self.flags[idx].value = b,
                    None => {
                        self.args = rest.to_vec();
                        return Err(ParseError::Invalid(format!(
                            "invalid boolean value {} for -{name}: parse error",
                            crate::strconv::quote(v)
                        )));
                    }
                },
            }
        }
        self.args = rest.to_vec();
        Ok(())
    }

    /// Go `flag.Parse()`(ExitOnError) 의 결과: 실패하면 (종료 코드, stderr 에 쓸 바이트).
    /// `-h` 는 0, 그 밖의 오류는 2 다.
    pub fn parse_or_exit(&mut self, args: &[String]) -> Result<(), (i32, String)> {
        match self.parse(args) {
            Ok(()) => Ok(()),
            Err(ParseError::Help) => Err((0, self.usage())),
            Err(e) => Err((2, format!("{e}\n{}", self.usage()))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{FlagSet, ParseError};

    fn golden() -> std::collections::HashMap<String, String> {
        use base64::Engine as _;
        let b64 = base64::engine::general_purpose::STANDARD;
        include_str!("../testdata/go_flag.txt")
            .lines()
            .map(|line| {
                let (n, v) = line.split_once('\t').expect("tab");
                let n = String::from_utf8(b64.decode(n).expect("b64")).expect("utf8");
                let v = String::from_utf8(b64.decode(v).expect("b64")).expect("utf8");
                (n, v)
            })
            .collect()
    }

    // testdata/go_flag.txt: go1.27.2 flag.NewFlagSet("prog", ContinueOnError) 실측.
    #[test]
    fn parse_matches_go() {
        let g = golden();
        let mut n = 0;
        for (case, want) in &g {
            if case == "defaults" {
                continue;
            }
            let args: Vec<String> = case.split_whitespace().map(str::to_owned).collect();
            let mut fs = FlagSet::new("prog");
            let check = fs.bool("check", false, "고치지 않고 어긋남만 본다");
            let r = fs.parse(&args);
            let (code, err, output) = match &r {
                Ok(()) => (0, "<nil>".to_owned(), String::new()),
                Err(ParseError::Help) => (0, r.clone().expect_err("e").to_string(), fs.usage()),
                Err(e) => (2, e.to_string(), format!("{e}\n{}", fs.usage())),
            };
            let args_q: Vec<String> = fs.args().iter().map(|a| crate::strconv::quote(a)).collect();
            let got = format!(
                "code={code} err={err} check={} args=[{}]\n{output}",
                fs.get(check),
                args_q.join(" ")
            );
            assert_eq!(&got, want, "case {case:?}");
            n += 1;
        }
        assert_eq!(n, 24);
    }

    #[test]
    fn defaults_match_go() {
        let g = golden();
        let mut fs = FlagSet::new("prog");
        fs.bool("on", true, "켜져 있다\n두 줄");
        fs.bool("x", false, "짧은 이름 `NAME` 표시");
        assert_eq!(fs.usage(), g["defaults"]);
        assert_eq!(
            fs.parse_or_exit(&["-h".to_owned()]),
            Err((0, g["defaults"].clone()))
        );
        let e = fs.parse_or_exit(&["-q".to_owned()]).expect_err("unknown");
        assert_eq!(e.0, 2);
        assert!(e.1.starts_with("flag provided but not defined: -q\nUsage of prog:\n"));
    }
}
