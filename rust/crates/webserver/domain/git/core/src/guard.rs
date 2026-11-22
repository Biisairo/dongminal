//! 읽기 허용 목록과 인자 가드 (FR-GIT-2, 7).

use dm_gocompat::{filepath, path, strconv::quote};

use crate::error::{Error, Kind, plain_list, quote_list};

/// 읽기 경로가 실행할 수 있는 git 하위 명령 전부다. 쓰기 목록과 교집합이 없어야 한다
/// (FR-GIT-95).
pub(crate) const READ_COMMANDS: &[&str] = &[
    "rev-parse",
    "status",
    "diff",
    "diff-tree",
    "diff-index",
    "show",
    "log",
    "for-each-ref",
    "cat-file",
    "ls-files",
    "config",
    "check-ref-format",
    "rev-list",
    "merge-base",
    "blame",
    "ls-tree",
];

/// 임의 명령 실행 또는 파일 쓰기로 가는 인자들이다.
const UNSAFE_PREFIXES: &[&str] = &[
    "--upload-pack",
    "--receive-pack",
    "--exec-path",
    "--output",
    "-o",
];

/// query 의 브랜치 이름 검사가 붙이는 플래그다 (FR-GIT-159).
pub const CHECK_REF_FORMAT_BRANCH: &str = "--branch";
/// 태그 이름 검사가 붙이는 플래그다 (FR-GIT-260).
pub const CHECK_REF_FORMAT_NORMALIZE: &str = "--normalize";
const CHECK_REF_FORMAT_ARGS: usize = 2;
const CHECK_REF_FORMAT_FLAGS: &[&str] = &[CHECK_REF_FORMAT_BRANCH, CHECK_REF_FORMAT_NORMALIZE];

/// `git config` 를 읽기로 유지하는 플래그다. 값이 필요한 것은 `=` 형태로만 받는다.
const CONFIG_READ_FLAGS: &[&str] = &[
    "--get",
    "--get-all",
    "--list",
    "--type",
    "--default",
    "--null",
];

pub(crate) fn is_read_command(c: &str) -> bool {
    READ_COMMANDS.contains(&c)
}

/// 읽기 경로의 인자 배열을 검사한다 (FR-GIT-2, 7).
pub(crate) fn guard_args<S: AsRef<str>>(args: &[S]) -> Result<(), Error> {
    guard_common(args, is_read_command, "읽기")?;
    let rest = &args[1..];
    match args[0].as_ref() {
        "config" => guard_config_args(rest),
        "check-ref-format" => guard_check_ref_format_args(rest),
        _ => Ok(()),
    }
}

fn guard_check_ref_format_args<S: AsRef<str>>(rest: &[S]) -> Result<(), Error> {
    if rest.len() == CHECK_REF_FORMAT_ARGS && CHECK_REF_FORMAT_FLAGS.contains(&rest[0].as_ref()) {
        return Ok(());
    }
    Err(Error::new(
        Kind::UnsafeArgument,
        format!(
            "check-ref-format 은 {} 중 하나와 이름 하나만 받는다: {}",
            plain_list(CHECK_REF_FORMAT_FLAGS),
            quote_list(rest)
        ),
    ))
}

/// 허용 목록만 다른 공통 검사다. 읽기·쓰기 두 경로가 나눠 쓴다.
pub(crate) fn guard_common<S: AsRef<str>>(
    args: &[S],
    allowed: impl Fn(&str) -> bool,
    list: &str,
) -> Result<(), Error> {
    let Some(first) = args.first().map(AsRef::as_ref) else {
        return Err(Error::new(Kind::UnsafeArgument, "인자가 없다"));
    };
    if first.starts_with('-') {
        return Err(Error::new(
            Kind::UnsafeArgument,
            format!("git 전역 옵션은 받지 않는다: {}", quote(first)),
        ));
    }
    if !allowed(first) {
        return Err(Error::new(
            Kind::WriteCommand,
            format!("{} 는 {list} 허용 목록에 없다", quote(first)),
        ));
    }
    if args.iter().any(|a| a.as_ref().contains('\0')) {
        return Err(Error::new(Kind::UnsafeArgument, "NUL 을 포함한 인자"));
    }
    // 위험 접두는 옵션 자리에만 뜻이 있다 (REPO_FIX 01 §7.7).
    let values = value_flags(first);
    let mut i = 1;
    while i < args.len() {
        let a = args[i].as_ref();
        if a == "--" {
            break;
        }
        if values.contains(&a) {
            i += 2;
            continue;
        }
        if attached_value(values, a) {
            i += 1;
            continue;
        }
        if UNSAFE_PREFIXES.iter().any(|p| a.starts_with(p)) {
            return Err(Error::new(
                Kind::UnsafeArgument,
                format!("{} 는 임의 실행·파일 쓰기 경로다", quote(a)),
            ));
        }
        i += 1;
    }
    Ok(())
}

/// 하위 명령별로 다음 인자를 값으로 받는 플래그다.
fn value_flags(cmd: &str) -> &'static [&'static str] {
    match cmd {
        "commit" | "tag" => &["-m", "--message", "-F", "--file"],
        _ => &[],
    }
}

fn attached_value(values: &[&str], a: &str) -> bool {
    values.iter().any(|f| {
        if f.starts_with("--") {
            a.starts_with(&format!("{f}="))
        } else {
            a.len() > f.len() && a.starts_with(f)
        }
    })
}

fn guard_config_args<S: AsRef<str>>(rest: &[S]) -> Result<(), Error> {
    let mut keys = 0;
    for a in rest.iter().map(AsRef::as_ref) {
        if a.starts_with('-') {
            if !config_read_flag(a) {
                return Err(Error::new(
                    Kind::UnsafeArgument,
                    format!("git config 의 {} 는 읽기 플래그가 아니다", quote(a)),
                ));
            }
            continue;
        }
        keys += 1;
    }
    if keys > 1 {
        return Err(Error::new(
            Kind::UnsafeArgument,
            format!("git config 는 키 하나만 읽는다: {}", quote_list(rest)),
        ));
    }
    Ok(())
}

fn config_read_flag(a: &str) -> bool {
    CONFIG_READ_FLAGS
        .iter()
        .any(|f| a == *f || a.starts_with(&format!("{f}=")))
}

/// 리포 상대경로를 검증한다 (FR-GIT-62). 정규화한 값을 돌려주지 않는다 — 다듬을 여지가
/// 있으면 거부한다. 오류의 종류(Go 의 kind)는 호출자가 고른다.
pub fn rel_path(p: &str, kind: Kind) -> Result<String, Error> {
    if p.trim().is_empty() {
        return Err(Error::new(kind, "경로가 비었다"));
    }
    let slashed = filepath::to_slash(p);
    if filepath::is_abs(p) || slashed.starts_with('/') || !filepath::volume_name(p).is_empty() {
        return Err(Error::new(
            kind,
            format!("절대경로는 받지 않는다: {}", quote(p)),
        ));
    }
    if p.contains('\0') {
        return Err(Error::new(kind, "NUL 을 포함한 경로"));
    }
    if slashed.split('/').any(|seg| seg == "..") {
        return Err(Error::new(kind, format!("부모 참조가 있다: {}", quote(p))));
    }
    if path::clean(p) != p {
        return Err(Error::new(
            kind,
            format!("정규화되지 않은 경로다: {}", quote(p)),
        ));
    }
    Ok(p.to_owned())
}

/// 위치 인자로 들어갈 ref 이름을 본다 (FR-GIT-62). 규칙 전체는 check-ref-format 의 일이다.
pub fn check_ref_arg(name: &str, val: &str) -> Result<(), Error> {
    if val.trim().is_empty() {
        return Err(Error::new(Kind::RefName, format!("{name} 가 비었다")));
    }
    if val.starts_with('-') {
        return Err(Error::new(
            Kind::RefName,
            format!("{name} 는 - 로 시작할 수 없다: {}", quote(val)),
        ));
    }
    if val.contains('\0') {
        return Err(Error::new(Kind::RefName, format!("{name} 에 NUL 이 있다")));
    }
    if val.contains("..") {
        return Err(Error::new(
            Kind::RefName,
            format!("{name} 에 범위 표현(..) 이 있다: {}", quote(val)),
        ));
    }
    Ok(())
}
