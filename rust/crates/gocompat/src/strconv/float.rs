//! Go `strconv.FormatFloat` 의 관측 규칙.
//!
//! 자릿수는 Rust 의 `{:e}`(최단 왕복 자릿수) 와 `{:.Ne}`·`{:.N}`(정확한 반올림)로 얻고,
//! 배치는 Go `ftoa.go` 의 `formatDigits`·`fmtE`·`fmtF` 와 같게 한다.

/// Go `decimalSlice`. 값은 `0.d1d2d3… × 10^dp`. 끝의 0 은 없고, 0 은 `digits` 가 비어 있다.
struct Decimal {
    neg: bool,
    digits: Vec<u8>,
    dp: i64,
}

/// `{:e}` 형식(`-1.2345e-7`)을 [`Decimal`] 로 푼다.
fn parse_sci(s: &str) -> Decimal {
    let (neg, s) = match s.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, s),
    };
    let (mant, exp) = s.split_once('e').unwrap_or((s, "0"));
    let exp: i64 = exp.parse().unwrap_or(0);
    let mut digits: Vec<u8> = mant.bytes().filter(u8::is_ascii_digit).collect();
    while digits.last() == Some(&b'0') {
        digits.pop();
    }
    let dp = if digits.is_empty() { 0 } else { exp + 1 };
    Decimal { neg, digits, dp }
}

/// `bits` 가 32 이면 `f` 를 float32 로 본다.
fn sci(f: f64, bits: u32, sig: Option<usize>) -> Decimal {
    let s = match (bits == 32, sig) {
        (true, None) => format!("{:e}", f as f32),
        (false, None) => format!("{f:e}"),
        (true, Some(n)) => {
            let p = n.saturating_sub(1);
            format!("{:.p$e}", f as f32)
        }
        (false, Some(n)) => {
            let p = n.saturating_sub(1);
            format!("{f:.p$e}")
        }
    };
    parse_sci(&s)
}

fn digit(d: &Decimal, i: i64) -> char {
    usize::try_from(i)
        .ok()
        .and_then(|i| d.digits.get(i).copied())
        .map_or('0', char::from)
}

fn fmt_e(out: &mut String, d: &Decimal, prec: i64, e: char) {
    if d.neg {
        out.push('-');
    }
    out.push(digit(d, 0));
    if prec > 0 {
        out.push('.');
        for i in 1..=prec {
            out.push(digit(d, i));
        }
    }
    out.push(e);
    let mut exp = if d.digits.is_empty() { 0 } else { d.dp - 1 };
    if exp < 0 {
        out.push('-');
        exp = -exp;
    } else {
        out.push('+');
    }
    if exp < 10 {
        out.push('0');
    }
    out.push_str(&exp.to_string());
}

fn fmt_f(out: &mut String, d: &Decimal, prec: i64) {
    if d.neg {
        out.push('-');
    }
    if d.dp > 0 {
        let m = (d.digits.len() as i64).min(d.dp);
        for i in 0..m {
            out.push(digit(d, i));
        }
        for _ in m..d.dp {
            out.push('0');
        }
    } else {
        out.push('0');
    }
    if prec > 0 {
        out.push('.');
        for i in 1..=prec {
            out.push(digit(d, d.dp + i - 1));
        }
    }
}

/// Go `strconv.FormatFloat(f, fmt, prec, bits)`. `fmt` 는 `b'e'`·`b'E'`·`b'f'`·`b'g'`·`b'G'`,
/// `prec` 가 음수면 최단 왕복 자릿수다. 그 밖의 `fmt` 는 `%` 와 문자를 돌려준다.
pub fn format_float(f: f64, fmt: u8, prec: i32, bits: u32) -> String {
    let f = if bits == 32 { f64::from(f as f32) } else { f };
    if f.is_nan() {
        return "NaN".to_owned();
    }
    if f.is_infinite() {
        return if f > 0.0 { "+Inf" } else { "-Inf" }.to_owned();
    }
    if !matches!(fmt, b'e' | b'E' | b'f' | b'g' | b'G') {
        return format!("%{}", char::from(fmt));
    }
    let shortest = prec < 0;
    let mut prec = i64::from(prec);
    let d = if shortest {
        let d = sci(f, bits, None);
        let nd = d.digits.len() as i64;
        prec = match fmt {
            b'e' | b'E' => (nd - 1).max(0),
            b'f' => (nd - d.dp).max(0),
            _ => nd,
        };
        d
    } else if fmt == b'f' {
        // 고정 소수 자릿수: Rust 의 정확한 반올림(정확히 절반이면 짝수 쪽)이 Go 와 같다.
        let p = prec as usize;
        return if bits == 32 {
            format!("{:.p$}", f as f32)
        } else {
            format!("{f:.p$}")
        };
    } else {
        let digits = match fmt {
            b'e' | b'E' => prec + 1,
            _ => {
                if prec == 0 {
                    prec = 1;
                }
                prec
            }
        };
        sci(f, bits, Some(digits as usize))
    };
    let mut out = String::new();
    match fmt {
        b'e' | b'E' => fmt_e(&mut out, &d, prec, char::from(fmt)),
        b'f' => fmt_f(&mut out, &d, prec),
        _ => {
            let e = if fmt == b'g' { 'e' } else { 'E' };
            let nd = d.digits.len() as i64;
            let mut eprec = prec;
            if eprec > nd && nd >= d.dp {
                eprec = nd;
            }
            if shortest {
                eprec = 6;
            }
            let exp = d.dp - 1;
            if exp < -4 || exp >= eprec {
                if prec > nd {
                    prec = nd;
                }
                fmt_e(&mut out, &d, prec - 1, e);
            } else {
                if prec > d.dp {
                    prec = nd;
                }
                fmt_f(&mut out, &d, (prec - d.dp).max(0));
            }
        }
    }
    out
}
