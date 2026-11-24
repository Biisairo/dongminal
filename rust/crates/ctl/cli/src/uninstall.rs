//! `otterminal uninstall` — 무엇을 지울지 보이고, `--yes` 가 있을 때만 지운다 (G3-4).

use std::io::Write;

use otter_gocompat::filepath;
use otter_gocompat::oserr::{go_error_string, path_error};

use crate::env::Env;
use crate::homelayout::{HomeEntry, home_layout};
use crate::options::{Common, ParseError, unknown_flag};

/// `otterminal uninstall` 의 옵션이다.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct UninstallOpts {
    pub common: Common,
    pub dry_run: bool,
    pub yes: bool,
    /// 되살릴 수 있는 상태까지 지운다. 기본은 남긴다.
    pub purge: bool,
}

pub fn parse_uninstall(args: &[String]) -> Result<UninstallOpts, ParseError> {
    let mut o = UninstallOpts::default();
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "-h" | "--help" => return Err(ParseError::Help),
            "--dry-run" | "-n" => o.dry_run = true,
            "--yes" | "-y" => o.yes = true,
            "--purge" => o.purge = true,
            a => {
                if !o.common.take(args, &mut i)? {
                    return Err(unknown_flag("uninstall", a));
                }
            }
        }
        i += 1;
    }
    Ok(o)
}

pub fn run_uninstall(o: &UninstallOpts, stdout: &mut dyn Write, stderr: &mut dyn Write) -> i32 {
    run_uninstall_in(o, &Env::process(), stdout, stderr)
}

pub(crate) fn run_uninstall_in(
    o: &UninstallOpts,
    env: &Env<'_>,
    stdout: &mut dyn Write,
    stderr: &mut dyn Write,
) -> i32 {
    let home = match o.common.resolve_home_in(env) {
        Ok(h) => h,
        Err(e) => {
            let _ = writeln!(stderr, "{e}");
            return 1;
        }
    };
    let plan = uninstall_plan(&home, o.purge);

    let _ = write!(stdout, "홈: {home}\n\n");
    if plan.is_empty() {
        let _ = writeln!(
            stdout,
            "지울 것이 없습니다 — 홈이 비었거나 이미 제거됐습니다."
        );
        return 0;
    }
    let _ = writeln!(stdout, "지울 항목 {}개:", plan.len());
    for p in &plan {
        // `!` 는 되살릴 수 있는 상태다 — --purge 일 때만 계획에 든다.
        let mark = if p.entry.keep_on_uninstall { "!" } else { " " };
        let _ = writeln!(stdout, " {mark} {:<24} {}", p.entry.name, p.entry.what);
    }
    if !o.purge {
        let kept = kept_names(&home);
        if !kept.is_empty() {
            let _ = write!(
                stdout,
                "\n남기는 항목 {}개 (되살릴 수 있는 상태):\n  {}\n",
                kept.len(),
                kept.join(" · ")
            );
            let _ = writeln!(stdout, "  전부 지우려면: --purge");
        }
    }

    if o.dry_run {
        let _ = writeln!(stdout, "\n(--dry-run — 아무것도 지우지 않았습니다)");
        return 0;
    }
    if !o.yes {
        let _ = writeln!(
            stderr,
            "\n지우려면 --yes 를 함께 주세요. 되돌릴 수 없습니다."
        );
        let _ = writeln!(
            stderr,
            "먼저 백업하려면: otterminal backup --out <파일.zip>"
        );
        return 1;
    }

    let mut failed = 0;
    for p in &plan {
        if let Err(e) = remove_all(&p.path) {
            let _ = writeln!(stderr, "✗ {}: {}", p.entry.name, go_error_string(&e));
            failed += 1;
        }
    }
    if failed > 0 {
        return 1;
    }
    let _ = write!(stdout, "\n✅ {}개를 지웠습니다.\n", plan.len());
    if !o.purge {
        let _ = writeln!(
            stdout,
            "   설정과 배치는 남아 있습니다 — 다시 설치하면 그대로 돌아옵니다."
        );
    }
    0
}

/// Go `os.RemoveAll` — 링크는 따라가지 않고 링크 자체를 지운다.
fn remove_all(path: &str) -> std::io::Result<()> {
    let md = match std::fs::symlink_metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(path_error("lstat", path, e)),
    };
    let r = if md.is_dir() {
        std::fs::remove_dir_all(path)
    } else {
        std::fs::remove_file(path)
    };
    r.map_err(|e| path_error("unlinkat", path, e))
}

pub(crate) struct UninstallItem {
    pub entry: HomeEntry,
    pub path: String,
}

/// 지울 항목이다. 맨 uninstall 은 보존하기로 한 것을 남기고, --purge 는 전부 가져간다.
pub(crate) fn uninstall_plan(home: &str, purge: bool) -> Vec<UninstallItem> {
    home_layout()
        .into_iter()
        .filter(|e| purge || !e.keep_on_uninstall)
        .map(|e| UninstallItem {
            path: filepath::join(&[home, e.name]),
            entry: e,
        })
        .filter(|it| std::fs::symlink_metadata(&it.path).is_ok())
        .collect()
}

/// 홈에 실제로 있는, 맨 uninstall 이 남기는 이름들이다.
fn kept_names(home: &str) -> Vec<&'static str> {
    home_layout()
        .into_iter()
        .filter(|e| e.keep_on_uninstall)
        .filter(|e| std::fs::symlink_metadata(filepath::join(&[home, e.name])).is_ok())
        .map(|e| e.name)
        .collect()
}
