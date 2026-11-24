//! 쓰기 경로의 단일 지점 (FR-GIT-95~96).

use otter_gocompat::strconv::quote;

use crate::ctx::Ctx;
use crate::error::{Error, Kind, quote_list};
use crate::exec::{Output, Service, check_cwd, finish_exec, reject};
use crate::guard::guard_common;
use crate::record::new_record;

/// stderr tail 의 기본 길이 (FR-GIT-96).
pub const DEFAULT_STDERR_TAIL_LINES: usize = 200;

/// 저장소를 변경할 수 있는 하위 명령이다. 읽기 목록과 교집합이 없어야 한다 (FR-GIT-95).
pub(crate) const WRITE_COMMANDS: &[&str] = &[
    "add",
    "reset",
    "rm",
    "commit",
    "apply",
    "checkout",
    "restore",
    "clean",
    "stash",
    "branch",
    "tag",
    "fetch",
    "pull",
    "push",
    "merge",
    "rebase",
    "cherry-pick",
    "revert",
    "am",
    "bisect",
    "update-ref",
    "symbolic-ref",
    "remote",
    "init",
];

pub(crate) fn is_write_verb(c: &str) -> bool {
    WRITE_COMMANDS.contains(&c)
}

/// `git remote` 가 지날 수 있는 하위 명령과 그 뒤 인자 수다 (FR-GIT-269).
fn remote_sub_args(sub: &str) -> Option<usize> {
    match sub {
        "add" => Some(2),
        "remove" => Some(1),
        _ => None,
    }
}

/// 쓰기 동사 아래의 읽기 하위 명령 (FR-GRF-25).
fn read_only_subcommands(verb: &str) -> Option<&'static [&'static str]> {
    match verb {
        "stash" => Some(&["list", "show"]),
        "branch" => Some(&["--list", "-l", "--show-current"]),
        "tag" => Some(&["-l", "--list"]),
        "remote" => Some(&["-v", "--verbose", "show"]),
        _ => None,
    }
}

/// 인자 없는 형태가 읽기인 동사다.
fn bare_is_read(verb: &str) -> bool {
    matches!(verb, "branch" | "remote" | "tag")
}

/// argv 가 저장소를 바꾸는 실행인지 답한다 (FR-GIT-218). 판정은 (동사, 하위명령) 쌍이다.
pub fn is_write_command<S: AsRef<str>>(argv: &[S]) -> bool {
    let Some(verb) = argv.first().map(AsRef::as_ref) else {
        return false;
    };
    if !is_write_verb(verb) {
        return false;
    }
    if argv.len() == 1 {
        return !bare_is_read(verb);
    }
    match read_only_subcommands(verb) {
        None => true,
        Some(subs) => !subs.contains(&argv[1].as_ref()),
    }
}

/// 쓰기 한 번의 요청이다. destructive 는 호출자가 선언한다 (I5). stdin 의 내용은 기록에
/// 남지 않는다 — 바이트 수만 남는다 (I6).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct WriteSpec {
    pub argv: Vec<String>,
    pub destructive: bool,
    pub stdin: String,
}

/// 진행 중 작업의 출구로만 쓰이는 동사와 그 허용 모양 (FR-GDT-20).
fn op_only_subcommands(verb: &str) -> Option<&'static [&'static str]> {
    match verb {
        "am" => Some(&["--continue", "--skip", "--abort"]),
        "bisect" => Some(&["reset"]),
        _ => None,
    }
}

/// 읽기 가드와 같은 안전 검사를 하고 허용 목록만 바꾼다 (FR-GIT-2).
pub fn guard_write_args<S: AsRef<str>>(args: &[S]) -> Result<(), Error> {
    guard_common(args, is_write_verb, "쓰기")?;
    let verb = args[0].as_ref();
    let rest = &args[1..];
    if verb == "remote" {
        return guard_remote_args(rest);
    }
    if verb == "init" {
        return guard_init_args(rest);
    }
    if let Some(allow) = op_only_subcommands(verb) {
        return guard_op_only_args(verb, rest, allow);
    }
    Ok(())
}

fn guard_op_only_args<S: AsRef<str>>(verb: &str, rest: &[S], allow: &[&str]) -> Result<(), Error> {
    if rest.len() != 1 {
        return Err(Error::new(
            Kind::UnsafeArgument,
            format!(
                "git {verb} 는 하위 명령 하나만 받는다: {}",
                quote_list(rest)
            ),
        ));
    }
    let sub = rest[0].as_ref();
    if !allow.contains(&sub) {
        return Err(Error::new(
            Kind::UnsafeArgument,
            format!("git {verb} 의 {} 는 이 표면이 제공하지 않는다", quote(sub)),
        ));
    }
    Ok(())
}

fn guard_init_args<S: AsRef<str>>(rest: &[S]) -> Result<(), Error> {
    if !rest.is_empty() {
        return Err(Error::new(
            Kind::UnsafeArgument,
            format!("git init 은 인자를 받지 않는다: {}", quote_list(rest)),
        ));
    }
    Ok(())
}

fn guard_remote_args<S: AsRef<str>>(rest: &[S]) -> Result<(), Error> {
    let Some(sub) = rest.first().map(AsRef::as_ref) else {
        return Err(Error::new(
            Kind::UnsafeArgument,
            "git remote 는 하위 명령을 요구한다",
        ));
    };
    let Some(want) = remote_sub_args(sub) else {
        return Err(Error::new(
            Kind::UnsafeArgument,
            format!("git remote 의 {} 는 이 표면이 제공하지 않는다", quote(sub)),
        ));
    };
    if rest.len() - 1 != want {
        return Err(Error::new(
            Kind::UnsafeArgument,
            format!(
                "git remote {sub} 는 인자 {want} 개를 받는다: {}",
                quote_list(&rest[1..])
            ),
        ));
    }
    for a in rest[1..].iter().map(AsRef::as_ref) {
        if a.starts_with('-') {
            return Err(Error::new(
                Kind::UnsafeArgument,
                format!("git remote 의 인자는 - 로 시작할 수 없다: {}", quote(a)),
            ));
        }
    }
    Ok(())
}

impl Service {
    /// 저장소를 변경하는 유일한 경로다 (FR-GIT-95). 거부된 호출도 기록에 남는다.
    pub async fn exec_write(
        &self,
        ctx: &Ctx,
        dir: &str,
        spec: &WriteSpec,
    ) -> Result<Output, Error> {
        let rec = |out: &Output, err: Option<&Error>| self.record_write(dir, spec, out, err);
        if let Err(e) = check_cwd(dir).and_then(|_| guard_write_args(&spec.argv)) {
            return reject(e, rec);
        }
        let ctx2 = ctx.with_timeout(self.timeout);
        let res = (self.write_runner())(
            ctx2.clone(),
            dir.to_owned(),
            spec.argv.clone(),
            spec.stdin.clone(),
        )
        .await;
        let res = finish_exec(&ctx2, dir, &spec.argv, res);
        match &res {
            Ok(out) => rec(out, None),
            Err(e) => rec(e.output().unwrap_or(&Output::default()), Some(e)),
        }
        res
    }

    /// 공통 기록에 호출자의 파괴적 선언과 stdin 의 바이트 수를 더한다 (I5·I6).
    pub fn record_write(&self, dir: &str, spec: &WriteSpec, out: &Output, err: Option<&Error>) {
        let mut rec = new_record(dir, &spec.argv, out, err);
        rec.destructive = spec.destructive;
        rec.stdin_bytes = spec.stdin.len();
        self.rec.add(rec);
    }
}

impl Output {
    /// stderr 의 마지막 n 줄이다 (FR-GIT-96). n 이 0 이면 DEFAULT_STDERR_TAIL_LINES 다.
    pub fn stderr_tail(&self, n: usize) -> String {
        let n = if n == 0 { DEFAULT_STDERR_TAIL_LINES } else { n };
        if self.stderr.is_empty() {
            return String::new();
        }
        let lines: Vec<&str> = self.stderr.trim_end_matches('\n').split('\n').collect();
        let start = lines.len().saturating_sub(n);
        lines[start..].join("\n")
    }
}
