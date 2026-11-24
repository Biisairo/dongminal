//! `dongminal update` — 최신 판이 있는지 확인한다 (G3-3).
//!
//! 자동 확인은 서버가 한다 (UPDATE_NOTICE_SRS). 이 명령은 사람이 직접 묻는 자리라, 자동 확인을 꺼
//! 두었어도 즉시 확인한다 (FR-UPD-17). 내려받지 않는다 (D-UPD-5) — 무엇을 받을지 알려 주고 멈춘다.

use std::io::Write;

use dm_shared_release as release;

use crate::http::block_on;
use crate::options::{ParseError, unknown_flag};
use crate::version::VERSION;

/// `dongminal update` 의 옵션이다. 공통 옵션을 받지 않는다.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct UpdateOpts {
    pub check: bool,
    /// 검사가 바꿔 끼우는 자리다. 비면 기본값이다.
    pub(crate) endpoint: String,
}

pub fn parse_update(args: &[String]) -> Result<UpdateOpts, ParseError> {
    let mut o = UpdateOpts::default();
    for a in args {
        match a.as_str() {
            "-h" | "--help" => return Err(ParseError::Help),
            "--check" => o.check = true,
            _ => return Err(unknown_flag("update", a)),
        }
    }
    Ok(o)
}

pub fn run_update(o: &UpdateOpts, stdout: &mut dyn Write, stderr: &mut dyn Write) -> i32 {
    run_update_with(o, VERSION, stdout, stderr)
}

/// 판을 인자로 받는다 — 검사가 `dev` 갈래까지 밟기 위해서다.
pub(crate) fn run_update_with(
    o: &UpdateOpts,
    cur: &str,
    stdout: &mut dyn Write,
    stderr: &mut dyn Write,
) -> i32 {
    if !o.check {
        let _ = writeln!(stdout, "지금 확인하려면: dongminal update --check");
        let _ = writeln!(stdout, "  (확인만 합니다 — 내려받거나 덮어쓰지 않습니다.)");
        let _ = writeln!(stdout, "서버의 자동 확인은 설정 화면에서 켜고 끕니다.");
        return 0;
    }
    let res = block_on(release::latest(&o.endpoint))
        .map_err(|e| e.to_string())
        .and_then(|r| r.map_err(|e| e.to_string()));
    let (latest, link) = match res {
        Ok(v) => v,
        Err(e) => {
            let _ = writeln!(stderr, "최신 판을 확인하지 못했습니다: {e}");
            return 1;
        }
    };
    let _ = writeln!(stdout, "지금 판: {cur}\n최신 판: {latest}");

    if !release::comparable(cur) {
        // 견줄 기준이 없다. 이것을 "뒤졌다" 로 말하면 거짓이다.
        let _ = writeln!(
            stdout,
            "\n개발 빌드입니다 — 릴리스 판과 견줄 기준이 없습니다."
        );
        if !link.is_empty() {
            let _ = writeln!(stdout, "최신 릴리스: {link}");
        }
        return 0;
    }
    if release::newer(&latest, cur) {
        let _ = writeln!(stdout, "\n새 판이 있습니다.");
        if !link.is_empty() {
            let _ = writeln!(stdout, "  {link}");
        }
        let _ = writeln!(
            stdout,
            "  내려받은 뒤 dongminal stop --all 하고 바꿔 넣으세요."
        );
        let _ = writeln!(stdout, "  바꾸기 전에: dongminal backup --out <파일.zip>");
        return 0;
    }
    let _ = writeln!(stdout, "\n최신입니다.");
    0
}
