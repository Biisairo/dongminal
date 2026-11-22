//! go1.27 `encoding/json`(JSONv2 기본, v1 호환 옵션) 의 구문 해석과 오류 문구.
//!
//! 오류 문구는 `jsonwire`·`jsontext` 의 문구에 `transformSyntacticError` 를 적용한 결과와 같다.
//! 잘못된 UTF-8 과 짝 없는 서로게이트는 v1 처럼 받아들이고 U+FFFD 로 바꾼다.

use super::encode::decode_rune;
use super::scanner::SyntaxError;
use crate::strconv::{quote_bytes, quote_rune};

const MAX_NESTING_DEPTH: usize = 10000;
const UNEXPECTED_END: &str = "unexpected end of JSON input";

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Node<'a> {
    Null,
    Bool(bool),
    Number(&'a str),
    String(String),
    Array(Vec<Value<'a>>),
    Object(Vec<(String, Value<'a>)>),
}

/// 해석한 값과 그 값의 원문 바이트.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Value<'a> {
    pub(crate) node: Node<'a>,
    pub(crate) raw: &'a [u8],
}

impl<'a> Value<'a> {
    /// 자식을 떼어 낸다. 값은 `Null` 이 된다.
    pub(crate) fn take_node(&mut self) -> Node<'a> {
        std::mem::replace(&mut self.node, Node::Null)
    }
}

/// 깊게 중첩된 값도 스택을 넘치지 않게 반복으로 버린다.
impl Drop for Value<'_> {
    fn drop(&mut self) {
        let mut pending: Vec<Node<'_>> = vec![std::mem::replace(&mut self.node, Node::Null)];
        while let Some(node) = pending.pop() {
            match node {
                Node::Array(items) => {
                    for mut v in items {
                        pending.push(std::mem::replace(&mut v.node, Node::Null));
                    }
                }
                Node::Object(members) => {
                    for (_, mut v) in members {
                        pending.push(std::mem::replace(&mut v.node, Node::Null));
                    }
                }
                _ => {}
            }
        }
    }
}

fn syntax(msg: String, offset: usize) -> SyntaxError {
    SyntaxError { msg, offset }
}

fn eof(offset: usize) -> SyntaxError {
    syntax(UNEXPECTED_END.to_owned(), offset)
}

/// Go `jsonwire.QuoteRune`: 잘못된 바이트는 `'\xNN'`.
fn quote_char_at(b: &[u8]) -> String {
    match decode_rune(b) {
        (Some(c), _) => quote_rune(c),
        (None, _) => format!("'\\x{:x}'", b[0]),
    }
}

fn invalid_char(b: &[u8], pos: usize, where_: &str) -> SyntaxError {
    syntax(
        format!("invalid character {} {}", quote_char_at(&b[pos..]), where_),
        pos,
    )
}

/// Go `jsonwire.InvalidTextError` 의 문구(escape sequence·surrogate pair).
fn invalid_escape(what: &[u8], pos: usize) -> SyntaxError {
    let label = if what.len() > 6 {
        "surrogate pair"
    } else {
        "escape sequence"
    };
    let runes: Vec<(Option<char>, usize)> = {
        let mut v = Vec::new();
        let mut i = 0;
        while i < what.len() {
            let (c, n) = decode_rune(&what[i..]);
            v.push((c, n));
            i += n;
        }
        v
    };
    let quoted = if runes.len() == 1 {
        quote_char_at(what)
    } else if runes.iter().any(|&(c, _)| match c {
        None => true,
        Some(c) => c == '`' || c == '\u{fffd}' || c.is_whitespace() || !crate::strconv::is_print(c),
    }) {
        quote_bytes(what)
    } else {
        format!("`{}`", String::from_utf8_lossy(what))
    };
    syntax(format!("invalid {label} {quoted} in string"), pos)
}

fn is_space(c: u8) -> bool {
    matches!(c, b' ' | b'\t' | b'\r' | b'\n')
}

pub(crate) struct Parser<'a> {
    b: &'a [u8],
}

/// 입력 전체가 JSON 값 하나인지 보고 값 트리를 만든다. 뒤에 공백 외 바이트가 있으면 오류다.
pub(crate) fn parse_document(b: &[u8]) -> Result<Value<'_>, SyntaxError> {
    let p = Parser { b };
    let (v, end) = p.parse_first(0)?;
    let j = p.skip_ws(end);
    if j < b.len() {
        return Err(invalid_char(b, j, "after top-level value"));
    }
    Ok(v)
}

/// 입력 앞의 JSON 값 하나를 해석하고, 값이 끝난 위치를 함께 돌려준다(뒤의 바이트는 보지 않는다).
pub(crate) fn parse_prefix(b: &[u8]) -> Result<(Value<'_>, usize), SyntaxError> {
    Parser { b }.parse_first(0)
}

impl<'a> Parser<'a> {
    fn skip_ws(&self, mut i: usize) -> usize {
        while i < self.b.len() && is_space(self.b[i]) {
            i += 1;
        }
        i
    }

    fn parse_first(&self, i: usize) -> Result<(Value<'a>, usize), SyntaxError> {
        let i = self.skip_ws(i);
        if i >= self.b.len() {
            return Err(eof(i));
        }
        self.value(i)
    }

    fn need(&self, i: usize) -> Result<u8, SyntaxError> {
        self.b.get(i).copied().ok_or_else(|| eof(i))
    }

    /// 객체 키와 `:` 를 읽고, 값이 시작하는 위치를 돌려준다.
    fn key(&self, i: usize) -> Result<(String, usize), SyntaxError> {
        if self.need(i)? != b'"' {
            return Err(invalid_char(
                self.b,
                i,
                "looking for beginning of object key string",
            ));
        }
        let (key, end) = self.string(i)?;
        let i = self.skip_ws(end);
        if self.need(i)? != b':' {
            return Err(invalid_char(self.b, i, "after object key"));
        }
        let i = self.skip_ws(i + 1);
        self.need(i)?;
        Ok((key, i))
    }

    /// 값 하나를 읽는다. 깊은 중첩에서도 스택을 쓰지 않도록 반복으로 처리한다.
    fn value(&self, mut i: usize) -> Result<(Value<'a>, usize), SyntaxError> {
        enum Frame<'a> {
            Object(usize, Vec<(String, Value<'a>)>, String),
            Array(usize, Vec<Value<'a>>),
        }
        let b = self.b;
        let mut stack: Vec<Frame<'a>> = Vec::new();
        loop {
            // i 에서 값이 시작한다.
            let (mut done, mut end) = match b[i] {
                b'{' | b'[' => {
                    if stack.len() + 1 > MAX_NESTING_DEPTH {
                        return Err(syntax("exceeded max depth".to_owned(), i));
                    }
                    let open = b[i];
                    let start = i;
                    let j = self.skip_ws(i + 1);
                    let close = if open == b'{' { b'}' } else { b']' };
                    if self.need(j)? == close {
                        let node = if open == b'{' {
                            Node::Object(Vec::new())
                        } else {
                            Node::Array(Vec::new())
                        };
                        (
                            Value {
                                node,
                                raw: &b[start..=j],
                            },
                            j + 1,
                        )
                    } else if open == b'{' {
                        let (key, at) = self.key(j)?;
                        stack.push(Frame::Object(start, Vec::new(), key));
                        i = at;
                        continue;
                    } else {
                        stack.push(Frame::Array(start, Vec::new()));
                        i = j;
                        continue;
                    }
                }
                b'"' => {
                    let (s, end) = self.string(i)?;
                    (self.leaf(Node::String(s), i, end), end)
                }
                b'-' | b'0'..=b'9' => {
                    let end = self.number(i)?;
                    // 숫자는 ASCII 다.
                    let text = std::str::from_utf8(&b[i..end]).unwrap_or("0");
                    (self.leaf(Node::Number(text), i, end), end)
                }
                b't' => {
                    let end = self.literal(i, "true")?;
                    (self.leaf(Node::Bool(true), i, end), end)
                }
                b'f' => {
                    let end = self.literal(i, "false")?;
                    (self.leaf(Node::Bool(false), i, end), end)
                }
                b'n' => {
                    let end = self.literal(i, "null")?;
                    (self.leaf(Node::Null, i, end), end)
                }
                _ => return Err(invalid_char(b, i, "looking for beginning of value")),
            };
            // 끝난 값을 감싼 컨테이너에 넣고, 컨테이너가 닫히면 위로 올라간다.
            loop {
                let Some(mut top) = stack.pop() else {
                    return Ok((done, end));
                };
                let j = self.skip_ws(end);
                let c = self.need(j)?;
                match &mut top {
                    Frame::Object(_, members, key) => {
                        members.push((std::mem::take(key), done));
                        match c {
                            b',' => {
                                let (k, at) = self.key(self.skip_ws(j + 1))?;
                                *key = k;
                                i = at;
                                stack.push(top);
                                break;
                            }
                            b'}' => {}
                            _ => return Err(invalid_char(b, j, "after object key:value pair")),
                        }
                    }
                    Frame::Array(_, items) => {
                        items.push(done);
                        match c {
                            b',' => {
                                i = self.skip_ws(j + 1);
                                self.need(i)?;
                                stack.push(top);
                                break;
                            }
                            b']' => {}
                            _ => return Err(invalid_char(b, j, "after array element")),
                        }
                    }
                }
                let (start, node) = match top {
                    Frame::Object(start, members, _) => (start, Node::Object(members)),
                    Frame::Array(start, items) => (start, Node::Array(items)),
                };
                done = Value {
                    node,
                    raw: &b[start..=j],
                };
                end = j + 1;
            }
        }
    }

    fn leaf(&self, node: Node<'a>, start: usize, end: usize) -> Value<'a> {
        Value {
            node,
            raw: &self.b[start..end],
        }
    }

    fn literal(&self, i: usize, lit: &str) -> Result<usize, SyntaxError> {
        for (k, want) in lit.bytes().enumerate().skip(1) {
            let got = self.need(i + k)?;
            if got != want {
                return Err(invalid_char(
                    self.b,
                    i + k,
                    &format!(
                        "in literal {lit} (expecting {})",
                        quote_rune(char::from(want))
                    ),
                ));
            }
        }
        Ok(i + lit.len())
    }

    fn digits(&self, mut i: usize) -> Result<usize, SyntaxError> {
        if !self.need(i)?.is_ascii_digit() {
            return Err(invalid_char(self.b, i, "in numeric literal"));
        }
        while i < self.b.len() && self.b[i].is_ascii_digit() {
            i += 1;
        }
        Ok(i)
    }

    fn number(&self, mut i: usize) -> Result<usize, SyntaxError> {
        if self.b[i] == b'-' {
            i += 1;
        }
        if self.need(i)? == b'0' {
            i += 1;
        } else {
            i = self.digits(i)?;
        }
        if self.b.get(i) == Some(&b'.') {
            i = self.digits(i + 1)?;
        }
        if matches!(self.b.get(i), Some(b'e' | b'E')) {
            i += 1;
            if matches!(self.b.get(i), Some(b'+' | b'-')) {
                i += 1;
            }
            i = self.digits(i)?;
        }
        Ok(i)
    }

    /// Go `jsonwire.ConsumeStringResumable`(validateUTF8=false) + `AppendUnquote` 의 v1 동작.
    fn string(&self, start: usize) -> Result<(String, usize), SyntaxError> {
        let b = self.b;
        let mut out = String::new();
        let mut i = start + 1;
        loop {
            let c = self.need(i)?;
            if c == b'"' {
                return Ok((out, i + 1));
            }
            if (b' '..0x80).contains(&c) && c != b'\\' {
                out.push(char::from(c));
                i += 1;
                continue;
            }
            if c >= 0x80 {
                match decode_rune(&b[i..]) {
                    (Some(r), n) => {
                        out.push(r);
                        i += n;
                    }
                    (None, _) => {
                        if !full_rune(&b[i..]) {
                            return Err(eof(i));
                        }
                        out.push('\u{fffd}');
                        i += 1;
                    }
                }
                continue;
            }
            if c < b' ' {
                return Err(invalid_char(b, i, "in string"));
            }
            // 역슬래시
            if b.len() < i + 2 {
                return Err(eof(i));
            }
            match b[i + 1] {
                b'/' => out.push('/'),
                b'"' => out.push('"'),
                b'\\' => out.push('\\'),
                b'b' => out.push('\u{08}'),
                b'f' => out.push('\u{0c}'),
                b'n' => out.push('\n'),
                b'r' => out.push('\r'),
                b't' => out.push('\t'),
                b'u' => {
                    let v1 = self.hex4(i)?;
                    i += 6;
                    if (0xd800..0xdc00).contains(&v1)
                        && b.len() >= i + 6
                        && b[i] == b'\\'
                        && b[i + 1] == b'u'
                        && let Some(v2) = parse_hex4(&b[i + 2..i + 6])
                        && (0xdc00..0xe000).contains(&v2)
                    {
                        let r = 0x10000 + ((v1 - 0xd800) << 10) + (v2 - 0xdc00);
                        out.push(char::from_u32(r).unwrap_or('\u{fffd}'));
                        i += 6;
                    } else {
                        out.push(char::from_u32(v1).unwrap_or('\u{fffd}'));
                    }
                    continue;
                }
                _ => return Err(invalid_escape(&b[i..i + 2], i)),
            }
            i += 2;
        }
    }

    fn hex4(&self, i: usize) -> Result<u32, SyntaxError> {
        let b = self.b;
        if b.len() < i + 6 {
            if has_escaped_utf16_prefix(&b[i..]) {
                return Err(eof(i));
            }
            return Err(invalid_escape(&b[i..], i));
        }
        parse_hex4(&b[i + 2..i + 6]).ok_or_else(|| invalid_escape(&b[i..i + 6], i))
    }
}

fn parse_hex4(h: &[u8]) -> Option<u32> {
    let s = std::str::from_utf8(h).ok()?;
    if !s.bytes().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    u32::from_str_radix(s, 16).ok()
}

fn has_escaped_utf16_prefix(b: &[u8]) -> bool {
    b.iter().enumerate().all(|(i, &c)| match i {
        0 => c == b'\\',
        1 => c == b'u',
        2..=5 => c.is_ascii_hexdigit(),
        _ => true,
    })
}

/// Go `utf8.FullRune`: 바이트열이 룬 하나를 온전히 담는가(잘린 다바이트 접두면 거짓).
fn full_rune(p: &[u8]) -> bool {
    let need = match p[0] {
        0xc2..=0xdf => 2,
        0xe0..=0xef => 3,
        0xf0..=0xf4 => 4,
        _ => return true,
    };
    if p.len() >= need {
        return true;
    }
    // 이어지는 바이트가 올바른 범위를 벗어나면 이미 잘못된 것이므로 "온전하다"고 본다.
    let (lo, hi) = match p[0] {
        0xe0 => (0xa0, 0xbf),
        0xed => (0x80, 0x9f),
        0xf0 => (0x90, 0xbf),
        0xf4 => (0x80, 0x8f),
        _ => (0x80, 0xbf),
    };
    if p.len() > 1 && !(lo..=hi).contains(&p[1]) {
        return true;
    }
    if p.len() > 2 && !(0x80..=0xbf).contains(&p[2]) {
        return true;
    }
    false
}
