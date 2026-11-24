//! 관측값 정규화 (SPEC FR-PAR-10·11).

use std::path::Path;

use regex::bytes::Regex;

pub const TOKEN_HOME: &str = "<HOME>";
pub const TOKEN_USERHOME: &str = "<USERHOME>";
pub const TOKEN_ROOT: &str = "<ROOT>";
pub const TOKEN_BIN: &str = "<BIN>";
pub const TOKEN_PORT: &str = "<PORT>";

const RFC3339_PATTERN: &str = r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})";
const UUID_PATTERN: &str =
    r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";

#[derive(Debug, Clone)]
enum RuleKind {
    Regex(Regex, Vec<u8>),
    Literal(Vec<u8>, Vec<u8>),
    Invalid(String),
}

/// 시나리오가 선언하는 정규화 규칙 하나.
#[derive(Debug, Clone)]
pub struct Rule {
    kind: RuleKind,
    only: Vec<String>,
}

impl Rule {
    /// 정규식 치환. `replacement` 는 `regex` 의 치환 문법(`${1}`)을 따른다.
    pub fn regex(pattern: &str, replacement: &str) -> Self {
        let kind = match Regex::new(pattern) {
            Ok(re) => RuleKind::Regex(re, replacement.as_bytes().to_vec()),
            Err(e) => RuleKind::Invalid(format!("정규식 {pattern:?} 오류: {e}")),
        };
        Self {
            kind,
            only: Vec::new(),
        }
    }

    pub fn literal(from: &str, to: &str) -> Self {
        let kind = if from.is_empty() {
            RuleKind::Invalid("literal 규칙의 찾을 문자열이 비었다".to_string())
        } else {
            RuleKind::Literal(from.as_bytes().to_vec(), to.as_bytes().to_vec())
        };
        Self {
            kind,
            only: Vec::new(),
        }
    }

    /// RFC 3339 시각(나노초·시간대 포함) → `<TIME>`.
    pub fn rfc3339() -> Self {
        Self::regex(RFC3339_PATTERN, "<TIME>")
    }

    /// UUID → `<UUID>`.
    pub fn uuid() -> Self {
        Self::regex(UUID_PATTERN, "<UUID>")
    }

    /// `prefix` 바로 뒤의 10진수 → `<PID>`. 예: `pid_after("pid=")`.
    pub fn pid_after(prefix: &str) -> Self {
        Self::regex(&format!(r"({})\d+", regex::escape(prefix)), "${1}<PID>")
    }

    /// 이 규칙을 이름이 `names` 중 하나인 관측값에만 적용한다.
    pub fn only<I, S>(mut self, names: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        self.only.extend(names.into_iter().map(Into::into));
        self
    }

    pub(crate) fn error(&self) -> Option<&str> {
        match &self.kind {
            RuleKind::Invalid(e) => Some(e),
            _ => None,
        }
    }

    fn applies_to(&self, observation: &str) -> bool {
        self.only.is_empty() || self.only.iter().any(|n| n == observation)
    }

    fn apply(&self, input: Vec<u8>) -> Vec<u8> {
        match &self.kind {
            RuleKind::Regex(re, rep) => re.replace_all(&input, rep.as_slice()).into_owned(),
            RuleKind::Literal(from, to) => replace_bytes(&input, from, to),
            RuleKind::Invalid(_) => input,
        }
    }
}

/// 한 쪽 실행에서 기본 정규화가 바꿀 실제 값들.
#[derive(Debug, Clone, Default)]
pub struct SideVars {
    pub home: String,
    pub user_home: String,
    pub root: String,
    pub bin: String,
    pub port: Option<u16>,
}

impl SideVars {
    fn literal_pairs(&self) -> Vec<(Vec<u8>, &'static str)> {
        let mut pairs = Vec::new();
        for (value, token) in [
            (&self.bin, TOKEN_BIN),
            (&self.home, TOKEN_HOME),
            (&self.user_home, TOKEN_USERHOME),
            (&self.root, TOKEN_ROOT),
        ] {
            if value.is_empty() {
                continue;
            }
            pairs.push((value.as_bytes().to_vec(), token));
            if let Ok(canon) = std::fs::canonicalize(Path::new(value)) {
                let canon = canon.to_string_lossy().into_owned();
                if canon != *value {
                    pairs.push((canon.into_bytes(), token));
                }
            }
        }
        // 긴 경로를 먼저 바꿔야 뿌리 아래 경로가 `<ROOT>/dmhome` 으로 남지 않는다.
        pairs.sort_by_key(|(v, _)| std::cmp::Reverse(v.len()));
        pairs
    }
}

/// 기본 정규화를 적용한 뒤 시나리오 규칙을 선언 순서대로 적용한다.
pub fn normalize(observation: &str, value: &[u8], vars: &SideVars, rules: &[Rule]) -> Vec<u8> {
    let mut out = value.to_vec();
    for (from, token) in vars.literal_pairs() {
        out = replace_bytes(&out, &from, token.as_bytes());
    }
    if let Some(port) = vars.port {
        out = replace_number(&out, &port.to_string(), TOKEN_PORT);
    }
    for rule in rules.iter().filter(|r| r.applies_to(observation)) {
        out = rule.apply(out);
    }
    out
}

fn replace_bytes(input: &[u8], from: &[u8], to: &[u8]) -> Vec<u8> {
    if from.is_empty() {
        return input.to_vec();
    }
    let mut out = Vec::with_capacity(input.len());
    let mut i = 0;
    while i < input.len() {
        if input[i..].starts_with(from) {
            out.extend_from_slice(to);
            i += from.len();
        } else {
            out.push(input[i]);
            i += 1;
        }
    }
    out
}

/// 앞뒤가 숫자가 아닌 `digits` 만 바꾼다.
fn replace_number(input: &[u8], digits: &str, token: &str) -> Vec<u8> {
    let d = digits.as_bytes();
    let mut out = Vec::with_capacity(input.len());
    let mut i = 0;
    while i < input.len() {
        let before_ok = i == 0 || !input[i - 1].is_ascii_digit();
        let after = i + d.len();
        if before_ok
            && input[i..].starts_with(d)
            && (after == input.len() || !input[after].is_ascii_digit())
        {
            out.extend_from_slice(token.as_bytes());
            i = after;
        } else {
            out.push(input[i]);
            i += 1;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vars() -> SideVars {
        SideVars {
            home: "/tmp/r1/dmhome".into(),
            user_home: "/tmp/r1/home".into(),
            root: "/tmp/r1".into(),
            bin: "/opt/bin/dongminal".into(),
            port: Some(60400),
        }
    }

    fn n(value: &str, rules: &[Rule]) -> String {
        String::from_utf8(normalize("stdout", value.as_bytes(), &vars(), rules)).unwrap()
    }

    #[test]
    fn builtin_paths_longest_first() {
        assert_eq!(
            n(
                "h=/tmp/r1/dmhome/x u=/tmp/r1/home r=/tmp/r1/bin/dmctl b=/opt/bin/dongminal",
                &[]
            ),
            "h=<HOME>/x u=<USERHOME> r=<ROOT>/bin/dmctl b=<BIN>"
        );
    }

    #[test]
    fn port_only_as_whole_number() {
        assert_eq!(
            n("http://localhost:60400/ 604001 160400 :60400", &[]),
            "http://localhost:<PORT>/ 604001 160400 :<PORT>"
        );
    }

    #[test]
    fn no_port_means_no_port_rule() {
        let v = SideVars {
            port: None,
            ..vars()
        };
        assert_eq!(normalize("stdout", b"60400", &v, &[]), b"60400");
    }

    #[test]
    fn rfc3339_and_uuid() {
        let rules = [Rule::rfc3339(), Rule::uuid()];
        assert_eq!(
            n(
                "t=2026-11-23T07:50:16.123456789+09:00 u=2026-01-02T03:04:05Z id=01a20573-74ff-7000-a865-59387344ff2b",
                &rules
            ),
            "t=<TIME> u=<TIME> id=<UUID>"
        );
    }

    #[test]
    fn pid_after_keeps_prefix() {
        assert_eq!(
            n("pid=4242 (pid=1)", &[Rule::pid_after("pid=")]),
            "pid=<PID> (pid=<PID>)"
        );
    }

    #[test]
    fn user_rules_in_declared_order() {
        let rules = [Rule::literal("a", "b"), Rule::regex("b+", "c")];
        assert_eq!(n("aab", &rules), "c");
    }

    #[test]
    fn only_limits_rule_to_named_observations() {
        let rules = [Rule::literal("x", "y").only(["stderr"])];
        assert_eq!(normalize("stdout", b"x", &vars(), &rules), b"x");
        assert_eq!(normalize("stderr", b"x", &vars(), &rules), b"y");
    }

    #[test]
    fn invalid_rules_report_error() {
        assert!(Rule::regex("(", "x").error().is_some());
        assert!(Rule::literal("", "x").error().is_some());
        assert!(Rule::rfc3339().error().is_none());
    }

    #[test]
    fn regex_rule_is_applied_to_non_utf8_bytes() {
        let out = normalize(
            "stdout",
            b"\xff go1.27.2",
            &vars(),
            &[Rule::regex(r"go\d+\.\d+(\.\d+)?", "<GO>")],
        );
        assert_eq!(out, b"\xff <GO>");
    }
}
