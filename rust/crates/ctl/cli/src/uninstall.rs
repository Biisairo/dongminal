//! `dongminal uninstall` — 무엇을 지울지 보이고, `--yes` 가 있을 때만 지운다 (G3-4).

use crate::options::{Common, ParseError, unknown_flag};

/// `dongminal uninstall` 의 옵션이다.
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
