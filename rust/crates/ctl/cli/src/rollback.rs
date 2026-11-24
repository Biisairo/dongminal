//! `otterminal rollback` — 상태 파일을 백업 세대로 되돌린다 (G3-2·G4-4).

use std::io::Write;
use std::path::Path;
use std::time::SystemTime;

use otter_gocompat::filepath;
use otter_gocompat::fmt::v_list;
use otter_gocompat::oserr::{go_error_string, link_error, path_error};
use otter_gocompat::strconv::quote;
use otter_gocompat::time::{format_log_std, local, to_zone};
use otter_shared_otterenv as otterenv;
use otter_shared_platform::{STATE_FILE_GENERATIONS, write_file_atomic};
use time::OffsetDateTime;

use crate::env::Env;
use crate::homelayout::home_layout;
use crate::http::ALIVE_PROBE_TIMEOUT;
use crate::options::{Common, ParseError, atoi, invalid};

/// `otterminal rollback` 의 옵션이다. 공통 파서를 쓰지 않는다 — `--home` 만 받는다.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RollbackOpts {
    pub common: Common,
    /// 되돌릴 세대다. 0 이면 목록만 보인다.
    pub gen_no: i64,
    /// 되돌릴 상태 파일이다. 비면 `workspace.json` 이다.
    pub file: String,
}

pub fn parse_rollback(args: &[String]) -> Result<RollbackOpts, ParseError> {
    let mut o = RollbackOpts::default();
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "-h" | "--help" => return Err(ParseError::Help),
            "--gen" => {
                if i + 1 >= args.len() {
                    return Err(invalid("--gen 에 번호가 필요합니다"));
                }
                i += 1;
                match atoi(&args[i]) {
                    Some(n) if n >= 1 => o.gen_no = n,
                    _ => {
                        return Err(invalid(format!(
                            "--gen 은 1 이상의 번호입니다: {}",
                            quote(&args[i])
                        )));
                    }
                }
            }
            "--file" => {
                if i + 1 >= args.len() {
                    return Err(invalid("--file 에 이름이 필요합니다"));
                }
                i += 1;
                o.file = args[i].clone();
            }
            "--home" => {
                if i + 1 >= args.len() {
                    return Err(invalid("--home 에 경로가 필요합니다"));
                }
                i += 1;
                o.common.home = args[i].clone();
            }
            a => return Err(invalid(format!("알 수 없는 인자: {}", quote(a)))),
        }
        i += 1;
    }
    Ok(o)
}

/// 되돌릴 수 있는 상태 파일이다. **목록으로 막는다** — 임의 경로를 받으면 이 명령이 파일 덮어쓰기
/// 도구가 된다. 표(`home_layout`)의 `rollback` 에서 파생하고, 순서는 표의 순서다 (SHR-19).
pub(crate) fn rollback_targets() -> Vec<&'static str> {
    home_layout()
        .into_iter()
        .filter(|e| e.rollback)
        .map(|e| e.name)
        .collect()
}

/// 고르지 않으면 `workspace.json` 이다 — 잃어서 가장 아픈 것이다.
pub(crate) const DEFAULT_ROLLBACK_TARGET: &str = otterenv::WORKSPACE_FILE;

fn resolve_target(name: &str) -> Result<&'static str, String> {
    if name.is_empty() {
        return Ok(DEFAULT_ROLLBACK_TARGET);
    }
    let targets = rollback_targets();
    if let Some(t) = targets.iter().find(|t| **t == name) {
        return Ok(t);
    }
    Err(format!(
        "되돌릴 수 있는 대상이 아닙니다: {} (가능: {})",
        quote(name),
        v_list(&targets)
    ))
}

pub fn run_rollback(o: &RollbackOpts, stdout: &mut dyn Write, stderr: &mut dyn Write) -> i32 {
    run_rollback_in(o, &Env::process(), stdout, stderr)
}

pub(crate) fn run_rollback_in(
    o: &RollbackOpts,
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
    let target = match resolve_target(&o.file) {
        Ok(t) => t,
        Err(e) => {
            let _ = writeln!(stderr, "{e}");
            return 1;
        }
    };
    let path = filepath::join(&[home.as_str(), target]);

    if o.gen_no == 0 {
        return list_generations(&path, stdout);
    }

    // **도는 인스턴스가 있으면 거부한다.** 지금 되돌려도 그 서버가 곧 자기 메모리로 덮어쓴다. 답하는
    // 상대가 있다는 사실만으로 충분하다 — 그 홈을 누군가 쓰고 있다.
    let ipc = otter_shared_platform::current().ipc;
    if ipc
        .dial(&ipc.endpoint(Path::new(&home)), ALIVE_PROBE_TIMEOUT)
        .is_ok()
    {
        let _ = writeln!(stderr, "이 홈에서 otterminald 가 돌고 있습니다.");
        let _ = writeln!(
            stderr,
            "되돌리기 전에 `otterminal stop --all` 로 내려 주세요 (터미널 세션을 잃습니다)."
        );
        return 1;
    }

    let src = format!("{path}.bak.{}", o.gen_no);
    let blob = match std::fs::read(&src) {
        Ok(b) => b,
        Err(e) => {
            let _ = writeln!(
                stderr,
                "세대 {} 를 읽을 수 없습니다: {}",
                o.gen_no,
                go_error_string(&path_error("open", &src, e))
            );
            return 1;
        }
    };

    // **되돌리기도 되돌릴 수 있어야 한다.** 지금 판을 지우지 않고 옆에 남긴다.
    if std::fs::metadata(&path).is_ok() {
        let keep = format!(
            "{path}.before-rollback-{}",
            compact_utc(OffsetDateTime::now_utc())
        );
        if let Err(e) = std::fs::rename(&path, &keep) {
            let _ = writeln!(
                stderr,
                "지금 판을 남기지 못했습니다: {}",
                go_error_string(&link_error("rename", &path, &keep, e))
            );
            return 1;
        }
        let _ = writeln!(stdout, "지금 판을 {} 로 남겼습니다", filepath::base(&keep));
    }
    if let Err(e) = write_file_atomic(Path::new(&path), &blob, 0o644) {
        let _ = writeln!(stderr, "되돌리기 실패: {}", go_error_string(&e));
        return 1;
    }
    let _ = writeln!(stdout, "✅ {target} 를 세대 {} 로 되돌렸습니다", o.gen_no);
    0
}

/// Go `t.UTC().Format("20060102T150405Z")`.
fn compact_utc(t: OffsetDateTime) -> String {
    format!(
        "{:04}{:02}{:02}T{:02}{:02}{:02}Z",
        t.year(),
        u8::from(t.month()),
        t.day(),
        t.hour(),
        t.minute(),
        t.second()
    )
}

/// Go `t.Format("2006-01-02 15:04:05")` — 지역 시각이다.
fn local_stamp(t: SystemTime) -> String {
    format_log_std(to_zone(OffsetDateTime::from(t), local())).replace('/', "-")
}

/// 되돌릴 수 있는 자리를 보인다. 읽히는지까지는 묻지 않는다 — 그 판단은 되돌린 뒤 기동이 한다.
fn list_generations(path: &str, stdout: &mut dyn Write) -> i32 {
    let _ = writeln!(stdout, "되돌릴 수 있는 세대 ({}):", filepath::base(path));
    let mut found = 0;
    for i in 1..=STATE_FILE_GENERATIONS {
        let p = format!("{path}.bak.{i}");
        let Ok(st) = std::fs::metadata(&p) else {
            continue;
        };
        found += 1;
        let mtime = st.modified().map(local_stamp).unwrap_or_default();
        let _ = writeln!(
            stdout,
            "  {i}  {}  {} bytes  {mtime}",
            filepath::base(&p),
            st.len()
        );
    }
    if found == 0 {
        let _ = writeln!(
            stdout,
            "  (없음 — 아직 덮어쓴 적이 없거나 세대가 지워졌습니다)"
        );
        return 0;
    }
    let _ = writeln!(stdout, "\n되돌리려면: otterminal rollback --gen <번호>");
    0
}
