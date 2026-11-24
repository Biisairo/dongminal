//! 잡 경로가 받는 종류와 그 argv 모양 (REPO_FIX 01 §6.1).

use otter_gocompat::strconv::quote;

use crate::error::{Error, JobsKind};

type ShapeRule = fn(&[String], &str) -> bool;

const CHECKOUT_PATHS_SEP: &str = "--";
const CONTROL_MERGE: &[&str] = &["--continue", "--abort"];
const CONTROL_SEQ: &[&str] = &["--continue", "--skip", "--abort"];

/// 잡 경로의 종류 → 모양 규칙. `None` 은 종류만 맞으면 된다.
fn job_kind(kind: &str) -> Option<Option<ShapeRule>> {
    Some(match kind {
        "fetch" | "push" | "pull" => None,
        "commit" => Some(commit_shape),
        "merge" => Some(|a, s| control_or(a, CONTROL_MERGE) || merge_shape(a, s)),
        "rebase" => Some(|a, s| control_or(a, CONTROL_SEQ) || rebase_shape(a, s)),
        "cherry-pick" => Some(|a, _| control_or(a, CONTROL_SEQ) || pick_shape(a, false)),
        "revert" => Some(|a, _| control_or(a, CONTROL_SEQ) || pick_shape(a, true)),
        "checkout" => Some(checkout_shape),
        "am" => Some(|a, _| control_or(a, CONTROL_SEQ)),
        "bisect" => Some(|a, _| a.len() == 2 && a[0] == "bisect" && a[1] == "reset"),
        _ => return None,
    })
}

const JOB_KINDS: [&str; 11] = [
    "fetch",
    "push",
    "pull",
    "commit",
    "merge",
    "rebase",
    "cherry-pick",
    "revert",
    "checkout",
    "am",
    "bisect",
];

/// 인가를 건너뛰는 잡의 종류 (submodule·worktree add).
fn unguarded_kind(kind: &str) -> Option<Option<ShapeRule>> {
    Some(match kind {
        "submodule" => None,
        "worktree" => Some(|a, _| a.len() > 1 && a[1] == "add"),
        _ => return None,
    })
}

pub(crate) fn indicator_kind(kind: &str) -> bool {
    job_kind(kind).is_some()
}

/// 진행 표시가 서는 종류 전부다. 정렬돼 있다.
pub fn indicator_kinds() -> Vec<String> {
    let mut out: Vec<String> = JOB_KINDS.iter().map(|s| (*s).to_owned()).collect();
    out.sort();
    out
}

pub(crate) fn is_remote_kind(kind: &str) -> bool {
    matches!(kind, "fetch" | "pull" | "push")
}

pub(crate) fn check_job_shape(kind: &str, argv: &[String], stdin: &str) -> Result<(), Error> {
    check_shape(job_kind(kind), kind, argv, stdin)
}

pub(crate) fn check_unguarded_shape(kind: &str, argv: &[String]) -> Result<(), Error> {
    check_shape(unguarded_kind(kind), kind, argv, "")
}

fn check_shape(
    rule: Option<Option<ShapeRule>>,
    kind: &str,
    argv: &[String],
    stdin: &str,
) -> Result<(), Error> {
    let Some(rule) = rule else {
        return Err(Error::new(
            JobsKind::JobKind,
            format!("{} 는 잡 경로에 없다", quote(kind)),
        ));
    };
    if argv.first().map(String::as_str) != Some(kind) {
        return Err(Error::new(
            JobsKind::JobKind,
            format!(
                "kind {} 와 argv {} 가 어긋난다",
                quote(kind),
                quote_list(argv)
            ),
        ));
    }
    if let Some(rule) = rule
        && !rule(argv, stdin)
    {
        return Err(Error::new(
            JobsKind::JobKind,
            format!("{kind} 의 모양이 아니다: {}", quote_list(argv)),
        ));
    }
    Ok(())
}

/// Go `%q` 의 `[]string` 형식: `["a" "b"]`.
fn quote_list(v: &[String]) -> String {
    let parts: Vec<String> = v.iter().map(|s| quote(s)).collect();
    format!("[{}]", parts.join(" "))
}

fn positional(a: &str) -> bool {
    !a.is_empty() && !a.starts_with('-')
}

fn control_or(argv: &[String], controls: &[&str]) -> bool {
    argv.len() == 2 && controls.contains(&argv[1].as_str())
}

fn commit_shape(argv: &[String], stdin: &str) -> bool {
    if stdin.is_empty() || argv.len() < 3 || argv[1] != "--file=-" || argv[2] != "--cleanup=strip" {
        return false;
    }
    flags_only(&argv[3..], &["--amend", "--signoff", "--no-verify", "-a"])
}

fn flags_only(args: &[String], allowed: &[&str]) -> bool {
    let mut seen: Vec<&str> = Vec::new();
    for a in args {
        if !allowed.contains(&a.as_str()) || seen.contains(&a.as_str()) {
            return false;
        }
        seen.push(a);
    }
    true
}

fn merge_shape(argv: &[String], _: &str) -> bool {
    let mut rest = &argv[1..];
    if rest.len() == 2 && flags_only(&rest[..1], &["--ff-only", "--no-ff", "--squash"]) {
        rest = &rest[1..];
    }
    rest.len() == 1 && positional(&rest[0])
}

fn rebase_shape(argv: &[String], _: &str) -> bool {
    let mut rest = &argv[1..];
    if rest.len() == 3 && rest[0] == "--onto" && positional(&rest[1]) {
        rest = &rest[2..];
    }
    rest.len() == 1 && positional(&rest[0])
}

fn pick_shape(argv: &[String], no_commit: bool) -> bool {
    let mut rest = &argv[1..];
    if rest.len() >= 2 && rest[0] == "-m" {
        if !digits(&rest[1]) {
            return false;
        }
        rest = &rest[2..];
    }
    if no_commit && !rest.is_empty() && rest[0] == "--no-commit" {
        rest = &rest[1..];
    }
    rest.len() == 1 && positional(&rest[0])
}

fn digits(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
}

fn checkout_shape(argv: &[String], _: &str) -> bool {
    let mut rest = &argv[1..];
    let sep = rest.last().is_some_and(|l| l == CHECKOUT_PATHS_SEP);
    if sep {
        rest = &rest[..rest.len() - 1];
    }
    let mut take = |flag: &str| -> bool {
        if rest.first().is_some_and(|f| f == flag) {
            rest = &rest[1..];
            return true;
        }
        false
    };
    take("--force");
    take("--detach");
    let mut created = false;
    if take("-b") {
        if rest.is_empty() || !positional(&rest[0]) {
            return false;
        }
        rest = &rest[1..];
        created = true;
    }
    if rest.first().is_some_and(|f| f == "--track") {
        rest = &rest[1..];
        return created && rest.len() == 1 && positional(&rest[0]);
    }
    match rest.len() {
        0 => created,
        1 => (created || sep) && positional(&rest[0]),
        _ => false,
    }
}
