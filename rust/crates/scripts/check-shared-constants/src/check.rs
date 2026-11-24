//! 대조 판정이다 (Go `check.go`). 서버 쪽 원천은 Rust 소스다 — Go 판은 Go 소스를 읽었다.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::LazyLock;

use regex::Regex;

// 대조할 파일 (SERVER_DRIVEN_ACTIONS_SRS K-j). 경로는 저장소 뿌리 기준이다.
pub(crate) const JS_GIT_CHANGES: &str = "web/js/core/constants-git-changes.js";
pub(crate) const JS_GIT_ACTIONS: &str = "web/js/core/constants-git-actions.js";
pub(crate) const JS_EDITOR: &str = "web/js/core/constants-editor.js";
pub(crate) const JS_CORE: &str = "web/js/core/constants.js";
pub(crate) const RS_PREFLIGHT: &str = "rust/crates/webserver/domain/git/query/src/preflight.rs";
pub(crate) const RS_OPERATION: &str = "rust/crates/webserver/domain/git/query/src/operation.rs";
pub(crate) const RS_LSP_WS: &str = "rust/crates/webserver/httpapi/src/lsp_api.rs";
pub(crate) const RS_WORKSPACE: &str = "rust/crates/shared/workspace/src/parse.rs";

/// [`check`] 가 읽는 파일 전부다.
pub(crate) const NEEDED: [&str; 8] = [
    JS_GIT_CHANGES,
    JS_GIT_ACTIONS,
    JS_EDITOR,
    JS_CORE,
    RS_PREFLIGHT,
    RS_OPERATION,
    RS_LSP_WS,
    RS_WORKSPACE,
];

/// 잡 종류 라벨을 볼 화면 카탈로그다.
pub(crate) const LOCALES: [&str; 2] = ["ko", "en"];

/// 대조의 재료다. 파일은 경로 → 내용, 로케일은 이름 → 카탈로그 원문이다.
#[derive(Clone, Default)]
pub(crate) struct Sources {
    pub(crate) files: BTreeMap<String, String>,
    pub(crate) locales: BTreeMap<String, String>,
    pub(crate) indicator_kinds: Vec<String>,
}

/// K10 의 화면 이름. `GIT_OP_AT`·`GIT_OP_CONTINUE` 등은 작업 종류가 아니라 고르지 않는다.
const JS_OP_NAMES: [&str; 6] = [
    "GIT_OP_MERGE",
    "GIT_OP_REBASE",
    "GIT_OP_CHERRY",
    "GIT_OP_REVERT",
    "GIT_OP_AM",
    "GIT_OP_BISECT",
];

fn re(p: &str) -> Regex {
    Regex::new(p).expect("상수 정규식")
}

static RE_BLOCK_IN_PROGRESS: LazyLock<Regex> = LazyLock::new(|| re(r"^BLOCK_\w+_IN_PROGRESS$"));
static RE_OP: LazyLock<Regex> = LazyLock::new(|| re(r"^OP_[A-Z]\w*$"));

/// 이름 → 값, 이름 → 읽지 못한 사유.
type Consts = (BTreeMap<String, String>, BTreeMap<String, String>);

/// 두 벌의 어긋남을 `<짝 ID>: <사유>` 로 돌려준다. 비면 같다.
pub(crate) fn check(s: &Sources) -> Vec<String> {
    let out = std::cell::RefCell::new(Vec::new());
    let say = |id: &str, msg: String| out.borrow_mut().push(format!("{id}: {msg}"));
    let file = |p: &str| s.files.get(p).map(String::as_str);

    let rs_of = |id: &str, f: &str| -> Option<Consts> {
        let v = file(f).map(rust_consts);
        if v.is_none() {
            say(id, format!("{f} 를 Rust 로 읽지 못했다"));
        }
        v
    };
    let rs_one = |id: &str, f: &str, name: &str| -> Option<String> {
        let (vals, bad) = rs_of(id, f)?;
        if let Some(why) = bad.get(name) {
            say(
                id,
                format!(
                    "{f} 의 {name} 식을 읽지 못한다({why}) — 리터럴이나 Duration::from_<단위>(N) 로 둔다"
                ),
            );
            return None;
        }
        let x = vals.get(name).cloned();
        if x.is_none() {
            say(id, format!("{f} 에 상수 {name} 가 없다"));
        }
        x
    };
    let js_one = |id: &str, f: &str, name: &str| -> Option<String> {
        let x = js_consts(file(f).unwrap_or_default()).remove(name);
        if x.is_none() {
            say(id, format!("{f} 에 const {name} 가 없다"));
        }
        x
    };
    let rs_set = |id: &str, f: &str, re: &Regex, skip_empty: bool| -> Vec<String> {
        let Some((vals, _)) = rs_of(id, f) else {
            return Vec::new();
        };
        vals.into_iter()
            .filter(|(k, x)| re.is_match(k) && !(skip_empty && x.is_empty()))
            .map(|(_, x)| x)
            .collect()
    };

    // K9: preflight 의 진행 중 코드 = GIT_OP_BY_BLOCK 의 키.
    match js_object_keys(file(JS_GIT_CHANGES).unwrap_or_default(), "GIT_OP_BY_BLOCK") {
        None => say("K9", format!("{JS_GIT_CHANGES} 에 GIT_OP_BY_BLOCK 이 없다")),
        Some(keys) => {
            let d = set_diff(
                &rs_set("K9", RS_PREFLIGHT, &RE_BLOCK_IN_PROGRESS, false),
                &keys,
            );
            if !d.is_empty() {
                say(
                    "K9",
                    format!("query::BLOCK_…_IN_PROGRESS 와 GIT_OP_BY_BLOCK 의 키가 다르다 — {d}"),
                );
            }
        }
    }

    // K10: 작업 종류.
    let js_ops: Vec<String> = JS_OP_NAMES
        .iter()
        .filter_map(|n| js_one("K10", JS_GIT_ACTIONS, n))
        .collect();
    let d = set_diff(&rs_set("K10", RS_OPERATION, &RE_OP, true), &js_ops);
    if !d.is_empty() {
        say("K10", format!("query::OP_* 와 GIT_OP_* 가 다르다 — {d}"));
    }

    // K12: LSP 통로의 close code. 두 쪽 이름이 같다.
    for n in [
        "LSP_WS_CLOSE_LIMIT",
        "LSP_WS_CLOSE_START",
        "LSP_WS_CLOSE_ENDED",
    ] {
        let j = js_one("K12", JS_EDITOR, n);
        let g = rs_one("K12", RS_LSP_WS, n);
        if let (Some(j), Some(g)) = (j, g)
            && j != g
        {
            say("K12", format!("화면 {n}={j} 와 서버 {n}={g} 가 다르다"));
        }
    }

    // K13: workspace 스키마 판.
    if let Some(j) = js_one("K13", JS_CORE, "WS_SCHEMA_VERSION")
        && let Some(g) = rs_one("K13", RS_WORKSPACE, "SCHEMA_VERSION")
        && j != g
    {
        say(
            "K13",
            format!("WS_SCHEMA_VERSION={j} 와 workspace::SCHEMA_VERSION={g} 가 다르다"),
        );
    }

    // K-h 덧붙임: 표시기 종류마다 라벨.
    for (l, text) in &s.locales {
        for k in &s.indicator_kinds {
            let key = format!("git.job_kind.{}", k.replace('-', "_"));
            if !text.contains(&format!("'{key}'")) {
                say("K-h", format!("{l}: {key} 가 없다"));
            }
        }
    }
    out.into_inner()
}

/// Go `%v` 의 `[]string` — `[a b]`.
fn go_list(xs: &[&String]) -> String {
    let parts: Vec<&str> = xs.iter().map(|s| s.as_str()).collect();
    format!("[{}]", parts.join(" "))
}

/// 서버 쪽(srv)과 화면 쪽(scr)의 집합 차이를 글로 낸다. 같으면 빈 글자다.
pub(crate) fn set_diff(srv: &[String], scr: &[String]) -> String {
    let a: BTreeSet<&String> = srv.iter().collect();
    let b: BTreeSet<&String> = scr.iter().collect();
    let only_srv: Vec<&String> = a.difference(&b).copied().collect();
    let only_scr: Vec<&String> = b.difference(&a).copied().collect();
    if only_srv.is_empty() && only_scr.is_empty() {
        return String::new();
    }
    format!(
        "서버에만 {}, 화면에만 {}",
        go_list(&only_srv),
        go_list(&only_scr)
    )
}

static RE_RS_CONST: LazyLock<Regex> = LazyLock::new(|| {
    re(r"(?m)^[ \t]*(?:pub(?:\([^)\n]*\))?[ \t]+)?const[ \t]+([A-Za-z_]\w*)[ \t]*:[^=;]*=\s*")
});
static RE_RS_INT: LazyLock<Regex> = LazyLock::new(|| {
    re(
        r"^(-?)(0x[0-9A-Fa-f_]+|0o[0-7_]+|0b[01_]+|[0-9][0-9_]*)(?:[iu](?:8|16|32|64|128|size))?\s*;",
    )
});
static RE_RS_STR: LazyLock<Regex> = LazyLock::new(|| re(r#"^"((?:[^"\\]|\\.)*)"\s*;"#));
static RE_RS_DURATION: LazyLock<Regex> = LazyLock::new(|| {
    re(r"^(?:(?:std::)?time::)?Duration::from_(millis|secs|mins|hours)\(\s*([0-9][0-9_]*)\s*\)\s*;")
});

/// 시간 단위의 밀리초 (`Duration::from_<단위>`).
fn duration_ms(unit: &str) -> Option<i64> {
    match unit {
        "millis" => Some(1),
        "secs" => Some(1000),
        "mins" => Some(60_000),
        "hours" => Some(3_600_000),
        _ => None,
    }
}

fn parse_int(sign: &str, lit: &str) -> Option<i64> {
    let lit = lit.replace('_', "");
    let n = if let Some(h) = lit.strip_prefix("0x") {
        i64::from_str_radix(h, 16).ok()?
    } else if let Some(o) = lit.strip_prefix("0o") {
        i64::from_str_radix(o, 8).ok()?
    } else if let Some(b) = lit.strip_prefix("0b") {
        i64::from_str_radix(b, 2).ok()?
    } else {
        lit.parse().ok()?
    };
    Some(if sign == "-" { -n } else { n })
}

fn unescape(s: &str) -> Option<String> {
    let mut out = String::with_capacity(s.len());
    let mut it = s.chars();
    while let Some(c) = it.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match it.next()? {
            'n' => out.push('\n'),
            't' => out.push('\t'),
            'r' => out.push('\r'),
            '0' => out.push('\0'),
            '\\' => out.push('\\'),
            '"' => out.push('"'),
            '\'' => out.push('\''),
            _ => return None,
        }
    }
    Some(out)
}

/// Rust 소스의 `const NAME: T = <값>;` 를 이름 → 값 글자로 읽는다. 정수는 10진, 문자열은 그대로,
/// `Duration::from_<millis|secs|mins|hours>(N)` 는 밀리초다. 그 밖의 식은 둘째 표(이름 → 사유)에 든다 —
/// 게이트가 그 이름을 대조하려 하면 실패한다. 같은 이름이 여럿이면 앞의 것이 이긴다.
pub(crate) fn rust_consts(src: &str) -> Consts {
    let (mut vals, mut bad) = (BTreeMap::new(), BTreeMap::new());
    for m in RE_RS_CONST.captures_iter(src) {
        let (Some(name), Some(all)) = (m.get(1), m.get(0)) else {
            continue;
        };
        let name = name.as_str().to_owned();
        if vals.contains_key(&name) || bad.contains_key(&name) {
            continue;
        }
        let rest = &src[all.end()..];
        let v = if let Some(c) = RE_RS_INT.captures(rest) {
            parse_int(&c[1], &c[2]).map(|n| n.to_string())
        } else if let Some(c) = RE_RS_STR.captures(rest) {
            unescape(&c[1])
        } else if let Some(c) = RE_RS_DURATION.captures(rest) {
            duration_ms(&c[1])
                .zip(parse_int("", &c[2]))
                .and_then(|(ms, n)| n.checked_mul(ms))
                .map(|n| n.to_string())
        } else {
            None
        };
        match v {
            Some(v) => {
                vals.insert(name, v);
            }
            None => {
                bad.insert(name, "지원하지 않는 식".to_owned());
            }
        }
    }
    (vals, bad)
}

static RE_JS_CONST: LazyLock<Regex> = LazyLock::new(|| {
    re(r#"(?m)^\s*const\s+([A-Za-z_$][\w$]*)\s*=\s*('[^'\n]*'|"[^"\n]*"|-?\d+)\s*;"#)
});

/// `const NAME=<문자열|정수>;` 줄을 이름 → 값 글자로 읽는다.
pub(crate) fn js_consts(src: &str) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    for m in RE_JS_CONST.captures_iter(src) {
        let v = &m[2];
        let v = if v.starts_with('\'') || v.starts_with('"') {
            &v[1..v.len() - 1]
        } else {
            v
        };
        out.insert(m[1].to_owned(), v.to_owned());
    }
    out
}

static RE_LINE_COMMENT: LazyLock<Regex> = LazyLock::new(|| re(r"//[^\n]*"));
static RE_OBJ_KEY: LazyLock<Regex> =
    LazyLock::new(|| re(r#"(?:^|[{,])\s*([A-Za-z_$][\w$]*|'[^']*'|"[^"]*")\s*:"#));

/// `const NAME={…};` 객체 리터럴의 맨 위 키를 순서대로 읽는다. 값은 중괄호를 품지 않는 단순
/// 값이어야 한다.
pub(crate) fn js_object_keys(src: &str, name: &str) -> Option<Vec<String>> {
    let start = re(&format!(
        r"(?m)^\s*const\s+{}\s*=\s*\{{",
        regex::escape(name)
    ))
    .find(src)?;
    let tail = &src[start.end()..];
    let end = tail.find('}')?;
    let body = format!("{{{}", RE_LINE_COMMENT.replace_all(&tail[..end], ""));
    Some(
        RE_OBJ_KEY
            .captures_iter(&body)
            .map(|m| {
                let k = &m[1];
                if k.starts_with('\'') || k.starts_with('"') {
                    k[1..k.len() - 1].to_owned()
                } else {
                    k.to_owned()
                }
            })
            .collect(),
    )
}
