//! 묶음 JS 의 주석 걷기 (PERF_OPTIMIZATION_SRS D-35·D-42, perf 이슈 3.4.10).
//!
//! 주석과 줄 끝 공백만 걷는다. 줄바꿈은 남겨 소스맵의 줄 맞춤을 지키고, 들여쓰기·문자열·
//! 정규식·템플릿 안은 건드리지 않는다. `/*!` 주석(라이선스)은 남긴다. 같은 줄 안의 블록
//! 주석이 두 토큰 사이에 있으면 공백 하나로 바꿔 토큰이 붙지 않게 한다.
//!
//! `/` 가 정규식인지 나눗셈인지는 앞의 의미 있는 토큰으로 가른다. 값(이름·수·닫는 괄호·문자열)
//! 뒤면 나눗셈, 그 밖(연산자·여는 괄호·`return` 같은 낱말·처음)이면 정규식이다. 묶음과 원본의
//! 토큰 열이 같은지는 e2e `bundle-strip.spec.ts` 가 실제 묶음으로 잰다.

/// `/` 를 정규식으로 읽는 낱말. 이 낱말 뒤에는 값이 아니라 식이 온다.
const REGEX_AFTER_WORDS: &[&[u8]] = &[
    b"return",
    b"typeof",
    b"instanceof",
    b"in",
    b"of",
    b"new",
    b"delete",
    b"void",
    b"throw",
    b"case",
    b"do",
    b"else",
    b"yield",
    b"await",
];

pub(crate) fn strip_comments(src: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(src.len());
    // 앞의 의미 있는 토큰이 값인가. 값 뒤의 `/` 는 나눗셈이다.
    let mut after_value = false;
    // 템플릿 `${` 마다 그 안에서 열린 `{` 의 수. 0 일 때의 `}` 가 템플릿으로 돌아간다.
    let mut templates: Vec<usize> = Vec::new();
    let mut i = 0;
    while i < src.len() {
        let c = src[i];
        match c {
            b'/' if src.get(i + 1) == Some(&b'/') => {
                trim_line_end(&mut out);
                i = line_end(src, i);
            }
            b'/' if src.get(i + 1) == Some(&b'*') => {
                let end = block_end(src, i);
                let body = &src[i..end];
                if src.get(i + 2) == Some(&b'!') {
                    out.extend_from_slice(body);
                } else if body.contains(&b'\n') {
                    trim_line_end(&mut out);
                    out.extend(body.iter().filter(|b| **b == b'\n'));
                } else if !ends_blank(&out) && !src.get(end).is_some_and(|b| is_blank(*b)) {
                    out.push(b' ');
                }
                i = end;
            }
            b'/' if !after_value => {
                let end = regex_end(src, i);
                out.extend_from_slice(&src[i..end]);
                after_value = true;
                i = end;
            }
            b'\'' | b'"' => {
                let end = string_end(src, i);
                out.extend_from_slice(&src[i..end]);
                after_value = true;
                i = end;
            }
            b'`' => {
                out.push(c);
                i = template(src, i + 1, &mut out, &mut templates, &mut after_value);
            }
            b'\n' | b'\r' => {
                trim_line_end(&mut out);
                out.push(c);
                i += 1;
            }
            b' ' | b'\t' => {
                out.push(c);
                i += 1;
            }
            b'{' => {
                if let Some(t) = templates.last_mut() {
                    *t += 1;
                }
                out.push(c);
                after_value = false;
                i += 1;
            }
            b'}' if templates.last() == Some(&0) => {
                templates.pop();
                out.push(c);
                i = template(src, i + 1, &mut out, &mut templates, &mut after_value);
            }
            b'}' => {
                if let Some(t) = templates.last_mut() {
                    *t -= 1;
                }
                out.push(c);
                after_value = false;
                i += 1;
            }
            b')' | b']' => {
                out.push(c);
                after_value = true;
                i += 1;
            }
            b'+' | b'-' if src.get(i + 1) == Some(&c) => {
                out.extend_from_slice(&src[i..i + 2]);
                after_value = true;
                i += 2;
            }
            _ if is_word(c) => {
                let end = word_end(src, i);
                let w = &src[i..end];
                after_value = c.is_ascii_digit() || !REGEX_AFTER_WORDS.contains(&w);
                out.extend_from_slice(w);
                i = end;
            }
            _ => {
                out.push(c);
                after_value = false;
                i += 1;
            }
        }
    }
    out
}

/// 템플릿 본문(여는 `` ` `` 나 `}` 의 다음부터)을 그대로 옮긴다. 닫는 `` ` `` 나 `${` 의 다음 자리를 돌려준다.
fn template(
    src: &[u8],
    mut i: usize,
    out: &mut Vec<u8>,
    templates: &mut Vec<usize>,
    after_value: &mut bool,
) -> usize {
    while i < src.len() {
        match src[i] {
            b'\\' => {
                let end = (i + 2).min(src.len());
                out.extend_from_slice(&src[i..end]);
                i = end;
            }
            b'`' => {
                out.push(b'`');
                *after_value = true;
                return i + 1;
            }
            b'$' if src.get(i + 1) == Some(&b'{') => {
                out.extend_from_slice(b"${");
                templates.push(0);
                *after_value = false;
                return i + 2;
            }
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    i
}

fn trim_line_end(out: &mut Vec<u8>) {
    while out.last().is_some_and(|b| *b == b' ' || *b == b'\t') {
        out.pop();
    }
}

fn is_blank(b: u8) -> bool {
    matches!(b, b' ' | b'\t' | b'\n' | b'\r')
}

fn ends_blank(out: &[u8]) -> bool {
    out.last().is_none_or(|b| is_blank(*b))
}

fn is_word(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'_' | b'$' | b'#' | b'\\') || b >= 0x80
}

fn word_end(src: &[u8], mut i: usize) -> usize {
    let digit = src[i].is_ascii_digit();
    while i < src.len() && (is_word(src[i]) || (digit && src[i] == b'.')) {
        i += 1;
    }
    i
}

fn line_end(src: &[u8], i: usize) -> usize {
    src[i..]
        .iter()
        .position(|b| *b == b'\n' || *b == b'\r')
        .map_or(src.len(), |p| i + p)
}

fn block_end(src: &[u8], i: usize) -> usize {
    src[i + 2..]
        .windows(2)
        .position(|w| w == b"*/")
        .map_or(src.len(), |p| i + 2 + p + 2)
}

fn string_end(src: &[u8], i: usize) -> usize {
    let q = src[i];
    let mut j = i + 1;
    while j < src.len() {
        match src[j] {
            b'\\' => j += 2,
            b'\n' => return j,
            c if c == q => return j + 1,
            _ => j += 1,
        }
    }
    src.len()
}

fn regex_end(src: &[u8], i: usize) -> usize {
    let mut j = i + 1;
    let mut class = false;
    while j < src.len() {
        match src[j] {
            b'\\' => j += 1,
            b'[' => class = true,
            b']' => class = false,
            b'/' if !class => {
                j += 1;
                while j < src.len() && is_word(src[j]) {
                    j += 1;
                }
                return j;
            }
            b'\n' => return j,
            _ => {}
        }
        j += 1;
    }
    src.len()
}
