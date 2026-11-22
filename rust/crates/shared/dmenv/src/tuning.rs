use std::time::Duration;

/// Go `os.Getenv` 과 같다 — 없으면 빈 문자열이다.
fn getenv(name: &str) -> String {
    std::env::var_os(name)
        .map(|v| v.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// 밀리초 정수 변수를 읽는다. 비었거나 정수가 아니거나 `min` 미만이면 `def` 다.
pub fn millis_env(name: &str, def: Duration, min: u64) -> Duration {
    millis_from(&getenv(name), def, min)
}

fn millis_from(v: &str, def: Duration, min: u64) -> Duration {
    if v.is_empty() {
        return def;
    }
    // Go strconv.Atoi 와 같이 부호(+/-)와 10진 숫자만 받는다.
    match v.parse::<i64>() {
        Ok(n) if n >= 0 && n.unsigned_abs() >= min => Duration::from_millis(n.unsigned_abs()),
        _ => def,
    }
}

/// "1" 일 때만 참이다.
pub fn flag_env(name: &str) -> bool {
    flag_from(&getenv(name))
}

fn flag_from(v: &str) -> bool {
    v == "1"
}

/// `key` 가 비었으면 `fallback` 이다 (SHR-30).
pub fn or(key: &str, fallback: &str) -> String {
    or_from(getenv(key), fallback)
}

fn or_from(v: String, fallback: &str) -> String {
    if v.is_empty() { fallback.to_owned() } else { v }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn millis_env_rules() {
        let def = Duration::from_secs(3);
        for (v, min, want) in [
            ("", 0, def),
            ("abc", 0, def),
            ("-1", 0, def),
            ("0", 0, Duration::ZERO),
            ("0", 1, def),
            ("250", 1, Duration::from_millis(250)),
            ("+250", 1, Duration::from_millis(250)),
            ("1_000", 0, def),
            (" 5", 0, def),
            ("99999999999999999999", 0, def),
        ] {
            assert_eq!(millis_from(v, def, min), want, "{v:?} min={min}");
        }
    }

    #[test]
    fn unset_env_falls_back() {
        let name = "DONGMINAL_TEST_SURELY_UNSET_7f3c";
        assert_eq!(
            millis_env(name, Duration::from_secs(1), 0),
            Duration::from_secs(1)
        );
        assert!(!flag_env(name));
        assert_eq!(or(name, "fb"), "fb");
    }

    #[test]
    fn flag_only_one() {
        for (v, want) in [("", false), ("0", false), ("true", false), ("1", true)] {
            assert_eq!(flag_from(v), want, "{v:?}");
        }
    }

    // SHR-30: 비었을 때만 기본값이다.
    #[test]
    fn or_rules() {
        assert_eq!(or_from(String::new(), "fb"), "fb");
        assert_eq!(or_from("v".into(), "fb"), "v");
    }
}
