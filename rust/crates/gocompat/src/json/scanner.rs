//! Go `encoding/json` v1 scanner.go 의 상태 기계. 검사를 통과한 입력의 compact·indent 서식에만 쓴다.
//! 구문 오류는 [`super::parse`] 가 go1.27(JSONv2 기본) 문구로 낸다.

use std::fmt;

use crate::strconv::quote;

const MAX_NESTING_DEPTH: usize = 10000;

/// Go `*json.SyntaxError`. `offset` 은 오류를 읽은 뒤까지의 바이트 수다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SyntaxError {
    pub msg: String,
    pub offset: usize,
}

impl fmt::Display for SyntaxError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.msg)
    }
}

impl std::error::Error for SyntaxError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Op {
    Continue,
    BeginLiteral,
    BeginObject,
    ObjectKey,
    ObjectValue,
    EndObject,
    BeginArray,
    ArrayValue,
    EndArray,
    SkipSpace,
    End,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Parse {
    ObjectKey,
    ObjectValue,
    ArrayValue,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum State {
    BeginValue,
    BeginValueOrEmpty,
    BeginStringOrEmpty,
    BeginString,
    EndValue,
    EndTop,
    InString,
    InStringEsc,
    InStringEscU(u8),
    Neg,
    One,
    Zero,
    Dot,
    Dot0,
    E,
    ESign,
    E0,
    T,
    Tr,
    Tru,
    F,
    Fa,
    Fal,
    Fals,
    N,
    Nu,
    Nul,
    Error,
}

pub(crate) struct Scanner {
    step: State,
    end_top: bool,
    parse_state: Vec<Parse>,
    err: Option<SyntaxError>,
    pub(crate) bytes: usize,
}

fn is_space(c: u8) -> bool {
    matches!(c, b' ' | b'\t' | b'\r' | b'\n')
}

fn quote_char(c: u8) -> String {
    if c == b'\'' {
        return r"'\''".to_owned();
    }
    if c == b'"' {
        return r#"'"'"#.to_owned();
    }
    // Go: strconv.Quote(string(c)) — 바이트를 같은 값의 rune 으로 본다.
    let q = quote(&char::from(c).to_string());
    format!("'{}'", &q[1..q.len() - 1])
}

impl Scanner {
    pub(crate) fn new() -> Self {
        Self {
            step: State::BeginValue,
            end_top: false,
            parse_state: Vec::new(),
            err: None,
            bytes: 0,
        }
    }

    pub(crate) fn take_err(&mut self) -> SyntaxError {
        self.err.take().unwrap_or_else(|| SyntaxError {
            msg: "unexpected end of JSON input".to_owned(),
            offset: self.bytes,
        })
    }

    /// Go `scanner.eof`.
    pub(crate) fn eof(&mut self) -> Op {
        if self.err.is_some() {
            return Op::Error;
        }
        if self.end_top {
            return Op::End;
        }
        self.step(b' ');
        if self.end_top {
            return Op::End;
        }
        if self.err.is_none() {
            self.err = Some(SyntaxError {
                msg: "unexpected end of JSON input".to_owned(),
                offset: self.bytes,
            });
        }
        Op::Error
    }

    fn error(&mut self, c: u8, context: &str) -> Op {
        self.step = State::Error;
        self.err = Some(SyntaxError {
            msg: format!("invalid character {} {}", quote_char(c), context),
            offset: self.bytes,
        });
        Op::Error
    }

    fn push(&mut self, c: u8, p: Parse, ok: Op) -> Op {
        self.parse_state.push(p);
        if self.parse_state.len() <= MAX_NESTING_DEPTH {
            return ok;
        }
        self.error(c, "exceeded max depth")
    }

    fn pop(&mut self) {
        self.parse_state.pop();
        if self.parse_state.is_empty() {
            self.step = State::EndTop;
            self.end_top = true;
        } else {
            self.step = State::EndValue;
        }
    }

    pub(crate) fn step(&mut self, c: u8) -> Op {
        match self.step {
            State::BeginValueOrEmpty => {
                if is_space(c) {
                    return Op::SkipSpace;
                }
                if c == b']' {
                    return self.end_value(c);
                }
                self.begin_value(c)
            }
            State::BeginValue => self.begin_value(c),
            State::BeginStringOrEmpty => {
                if is_space(c) {
                    return Op::SkipSpace;
                }
                if c == b'}' {
                    if let Some(last) = self.parse_state.last_mut() {
                        *last = Parse::ObjectValue;
                    }
                    return self.end_value(c);
                }
                self.begin_string(c)
            }
            State::BeginString => self.begin_string(c),
            State::EndValue => self.end_value(c),
            State::EndTop => self.end_top_state(c),
            State::InString => {
                if c == b'"' {
                    self.step = State::EndValue;
                    return Op::Continue;
                }
                if c == b'\\' {
                    self.step = State::InStringEsc;
                    return Op::Continue;
                }
                if c < 0x20 {
                    return self.error(c, "in string literal");
                }
                Op::Continue
            }
            State::InStringEsc => match c {
                b'b' | b'f' | b'n' | b'r' | b't' | b'\\' | b'/' | b'"' => {
                    self.step = State::InString;
                    Op::Continue
                }
                b'u' => {
                    self.step = State::InStringEscU(0);
                    Op::Continue
                }
                _ => self.error(c, "in string escape code"),
            },
            State::InStringEscU(n) => {
                if c.is_ascii_hexdigit() {
                    self.step = if n == 3 {
                        State::InString
                    } else {
                        State::InStringEscU(n + 1)
                    };
                    return Op::Continue;
                }
                self.error(c, "in \\u hexadecimal character escape")
            }
            State::Neg => {
                if c == b'0' {
                    self.step = State::Zero;
                    return Op::Continue;
                }
                if (b'1'..=b'9').contains(&c) {
                    self.step = State::One;
                    return Op::Continue;
                }
                self.error(c, "in numeric literal")
            }
            State::One => {
                if c.is_ascii_digit() {
                    return Op::Continue;
                }
                self.state0(c)
            }
            State::Zero => self.state0(c),
            State::Dot => {
                if c.is_ascii_digit() {
                    self.step = State::Dot0;
                    return Op::Continue;
                }
                self.error(c, "after decimal point in numeric literal")
            }
            State::Dot0 => {
                if c.is_ascii_digit() {
                    return Op::Continue;
                }
                if c == b'e' || c == b'E' {
                    self.step = State::E;
                    return Op::Continue;
                }
                self.end_value(c)
            }
            State::E => {
                if c == b'+' || c == b'-' {
                    self.step = State::ESign;
                    return Op::Continue;
                }
                self.e_sign(c)
            }
            State::ESign => self.e_sign(c),
            State::E0 => {
                if c.is_ascii_digit() {
                    return Op::Continue;
                }
                self.end_value(c)
            }
            State::T => self.lit(c, b'r', State::Tr, "in literal true (expecting 'r')"),
            State::Tr => self.lit(c, b'u', State::Tru, "in literal true (expecting 'u')"),
            State::Tru => self.lit(c, b'e', State::EndValue, "in literal true (expecting 'e')"),
            State::F => self.lit(c, b'a', State::Fa, "in literal false (expecting 'a')"),
            State::Fa => self.lit(c, b'l', State::Fal, "in literal false (expecting 'l')"),
            State::Fal => self.lit(c, b's', State::Fals, "in literal false (expecting 's')"),
            State::Fals => self.lit(c, b'e', State::EndValue, "in literal false (expecting 'e')"),
            State::N => self.lit(c, b'u', State::Nu, "in literal null (expecting 'u')"),
            State::Nu => self.lit(c, b'l', State::Nul, "in literal null (expecting 'l')"),
            State::Nul => self.lit(c, b'l', State::EndValue, "in literal null (expecting 'l')"),
            State::Error => Op::Error,
        }
    }

    fn lit(&mut self, c: u8, want: u8, next: State, ctx: &str) -> Op {
        if c == want {
            self.step = next;
            return Op::Continue;
        }
        self.error(c, ctx)
    }

    fn begin_value(&mut self, c: u8) -> Op {
        if is_space(c) {
            return Op::SkipSpace;
        }
        let next = match c {
            b'{' => {
                self.step = State::BeginStringOrEmpty;
                return self.push(c, Parse::ObjectKey, Op::BeginObject);
            }
            b'[' => {
                self.step = State::BeginValueOrEmpty;
                return self.push(c, Parse::ArrayValue, Op::BeginArray);
            }
            b'"' => State::InString,
            b'-' => State::Neg,
            b'0' => State::Zero,
            b't' => State::T,
            b'f' => State::F,
            b'n' => State::N,
            b'1'..=b'9' => State::One,
            _ => return self.error(c, "looking for beginning of value"),
        };
        self.step = next;
        Op::BeginLiteral
    }

    fn begin_string(&mut self, c: u8) -> Op {
        if is_space(c) {
            return Op::SkipSpace;
        }
        if c == b'"' {
            self.step = State::InString;
            return Op::BeginLiteral;
        }
        self.error(c, "looking for beginning of object key string")
    }

    fn state0(&mut self, c: u8) -> Op {
        if c == b'.' {
            self.step = State::Dot;
            return Op::Continue;
        }
        if c == b'e' || c == b'E' {
            self.step = State::E;
            return Op::Continue;
        }
        self.end_value(c)
    }

    fn e_sign(&mut self, c: u8) -> Op {
        if c.is_ascii_digit() {
            self.step = State::E0;
            return Op::Continue;
        }
        self.error(c, "in exponent of numeric literal")
    }

    fn end_top_state(&mut self, c: u8) -> Op {
        if !is_space(c) {
            self.error(c, "after top-level value");
        }
        Op::End
    }

    fn end_value(&mut self, c: u8) -> Op {
        let Some(&ps) = self.parse_state.last() else {
            self.step = State::EndTop;
            self.end_top = true;
            return self.end_top_state(c);
        };
        if is_space(c) {
            self.step = State::EndValue;
            return Op::SkipSpace;
        }
        let n = self.parse_state.len() - 1;
        match ps {
            Parse::ObjectKey => {
                if c == b':' {
                    self.parse_state[n] = Parse::ObjectValue;
                    self.step = State::BeginValue;
                    return Op::ObjectKey;
                }
                self.error(c, "after object key")
            }
            Parse::ObjectValue => {
                if c == b',' {
                    self.parse_state[n] = Parse::ObjectKey;
                    self.step = State::BeginString;
                    return Op::ObjectValue;
                }
                if c == b'}' {
                    self.pop();
                    return Op::EndObject;
                }
                self.error(c, "after object key:value pair")
            }
            Parse::ArrayValue => {
                if c == b',' {
                    self.step = State::BeginValue;
                    return Op::ArrayValue;
                }
                if c == b']' {
                    self.pop();
                    return Op::EndArray;
                }
                self.error(c, "after array element")
            }
        }
    }
}

/// Go `checkValid`(go1.27 JSONv2 기본): 전체가 JSON 값 하나인지 보고, 아니면 Go 와 같은 문구의 오류를 낸다.
pub(crate) fn check_valid(data: &[u8]) -> Result<(), SyntaxError> {
    super::parse::parse_document(data).map(|_| ())
}

/// Go `json.Valid`.
pub fn valid(data: &[u8]) -> bool {
    check_valid(data).is_ok()
}

const HEX: &[u8; 16] = b"0123456789abcdef";

fn push_u00(dst: &mut Vec<u8>, c: u8) {
    dst.extend_from_slice(b"\\u00");
    dst.push(HEX[usize::from(c >> 4)]);
    dst.push(HEX[usize::from(c & 0xf)]);
}

/// Go `appendCompact`. `escape` 가 참이면 `<`·`>`·`&`·U+2028·U+2029 를 이스케이프한다.
pub(crate) fn append_compact(
    dst: &mut Vec<u8>,
    src: &[u8],
    escape: bool,
) -> Result<(), SyntaxError> {
    check_valid(src)?;
    let orig = dst.len();
    let mut scan = Scanner::new();
    let mut start = 0;
    for (i, &c) in src.iter().enumerate() {
        if escape && (c == b'<' || c == b'>' || c == b'&') {
            if start < i {
                dst.extend_from_slice(&src[start..i]);
            }
            push_u00(dst, c);
            start = i + 1;
        }
        if escape && c == 0xe2 && i + 2 < src.len() && src[i + 1] == 0x80 && src[i + 2] & !1 == 0xa8
        {
            if start < i {
                dst.extend_from_slice(&src[start..i]);
            }
            dst.extend_from_slice(b"\\u202");
            dst.push(HEX[usize::from(src[i + 2] & 0xf)]);
            start = i + 3;
        }
        let v = scan.step(c);
        if matches!(v, Op::SkipSpace | Op::End | Op::Error) {
            if v == Op::Error {
                break;
            }
            if start < i {
                dst.extend_from_slice(&src[start..i]);
            }
            start = i + 1;
        }
    }
    if scan.eof() == Op::Error {
        dst.truncate(orig);
        return Err(scan.take_err());
    }
    if start < src.len() {
        dst.extend_from_slice(&src[start..]);
    }
    Ok(())
}

/// Go `json.Compact` (HTML 이스케이프를 하지 않는다).
pub fn compact(src: &[u8]) -> Result<Vec<u8>, SyntaxError> {
    let mut dst = Vec::with_capacity(src.len());
    append_compact(&mut dst, src, false)?;
    Ok(dst)
}

fn append_newline(dst: &mut Vec<u8>, prefix: &str, indent: &str, depth: usize) {
    dst.push(b'\n');
    dst.extend_from_slice(prefix.as_bytes());
    for _ in 0..depth {
        dst.extend_from_slice(indent.as_bytes());
    }
}

/// Go `appendIndent`.
pub(crate) fn append_indent(
    dst: &mut Vec<u8>,
    src: &[u8],
    prefix: &str,
    indent: &str,
) -> Result<(), SyntaxError> {
    check_valid(src)?;
    let orig = dst.len();
    let mut scan = Scanner::new();
    let mut need_indent = false;
    let mut depth = 0usize;
    for &c in src {
        scan.bytes += 1;
        let v = scan.step(c);
        if v == Op::SkipSpace {
            continue;
        }
        if v == Op::Error {
            break;
        }
        if need_indent && v != Op::EndObject && v != Op::EndArray {
            need_indent = false;
            depth += 1;
            append_newline(dst, prefix, indent, depth);
        }
        if v == Op::Continue {
            dst.push(c);
            continue;
        }
        match c {
            b'{' | b'[' => {
                need_indent = true;
                dst.push(c);
            }
            b',' => {
                dst.push(c);
                append_newline(dst, prefix, indent, depth);
            }
            b':' => {
                dst.push(c);
                dst.push(b' ');
            }
            b'}' | b']' => {
                if need_indent {
                    need_indent = false;
                } else {
                    depth = depth.saturating_sub(1);
                    append_newline(dst, prefix, indent, depth);
                }
                dst.push(c);
            }
            _ => dst.push(c),
        }
    }
    if scan.eof() == Op::Error {
        dst.truncate(orig);
        return Err(scan.take_err());
    }
    Ok(())
}

/// Go `json.Indent`.
pub fn indent(src: &[u8], prefix: &str, indent: &str) -> Result<Vec<u8>, SyntaxError> {
    let mut dst = Vec::with_capacity(src.len() * 2);
    append_indent(&mut dst, src, prefix, indent)?;
    Ok(dst)
}
