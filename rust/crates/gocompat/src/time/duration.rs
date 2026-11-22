//! Go `time.Duration.String()` (= `%v`).

const NANOSECOND: u64 = 1;
const MICROSECOND: u64 = 1000 * NANOSECOND;
const MILLISECOND: u64 = 1000 * MICROSECOND;
const SECOND: u64 = 1000 * MILLISECOND;

/// Go `time.Duration(nanos).String()`. 예: `1h2m0.5s`, `1.5ms`, `0s`.
pub fn format_duration(nanos: i64) -> String {
    let neg = nanos < 0;
    let mut u = nanos.unsigned_abs();
    // 뒤에서부터 쌓고 마지막에 뒤집는다.
    let mut rev = String::with_capacity(32);
    if u < SECOND {
        rev.push('s');
        let prec;
        if u == 0 {
            return "0s".to_owned();
        } else if u < MICROSECOND {
            prec = 0;
            rev.push('n');
        } else if u < MILLISECOND {
            prec = 3;
            rev.push('µ');
        } else {
            prec = 6;
            rev.push('m');
        }
        u = push_frac_rev(&mut rev, u, prec);
        push_int_rev(&mut rev, u);
    } else {
        rev.push('s');
        u = push_frac_rev(&mut rev, u, 9);
        push_int_rev(&mut rev, u % 60);
        u /= 60;
        if u > 0 {
            rev.push('m');
            push_int_rev(&mut rev, u % 60);
            u /= 60;
            if u > 0 {
                rev.push('h');
                push_int_rev(&mut rev, u);
            }
        }
    }
    if neg {
        rev.push('-');
    }
    rev.chars().rev().collect()
}

/// Go `time.Duration.String()` 을 `std::time::Duration` 에 쓴다. i64 나노초를 넘으면 최댓값으로 자른다.
pub fn format_std_duration(d: std::time::Duration) -> String {
    format_duration(i64::try_from(d.as_nanos()).unwrap_or(i64::MAX))
}

/// Go `fmtFrac`: v/10^prec 의 소수부를 끝의 0 없이 쓴다. 소수부가 0 이면 점도 쓰지 않는다.
fn push_frac_rev(rev: &mut String, mut v: u64, prec: u32) -> u64 {
    let mut print = false;
    for _ in 0..prec {
        let digit = v % 10;
        print = print || digit != 0;
        if print {
            rev.push(char::from(b'0' + digit as u8));
        }
        v /= 10;
    }
    if print {
        rev.push('.');
    }
    v
}

fn push_int_rev(rev: &mut String, mut v: u64) {
    if v == 0 {
        rev.push('0');
        return;
    }
    while v > 0 {
        rev.push(char::from(b'0' + (v % 10) as u8));
        v /= 10;
    }
}
