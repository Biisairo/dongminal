//! home 의 파일에 변환을 적용한다 (NFR-EM-2).

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use otter_gocompat::oserr::{go_error_string, path_error};
use otter_shared_otterenv::{
    PANED_PID_FILE, PANES_FILE, SETTINGS_FILE, TOOLS_FILE, WORKSPACE_FILE,
};

use crate::{Error, Report, rewrite_identifiers, run, settings};

const BACKUP_SUFFIX: &str = ".v1.bak";
/// 구 식별자 재작성 직전 상태의 백업이다 (FR-MGU-8).
const PRE_UUID_SUFFIX: &str = ".preuuid.bak";
#[cfg(unix)]
const FILE_PERM: u32 = 0o644;

fn base(p: &Path) -> String {
    p.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
}

fn lossy(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

fn with_suffix(p: &Path, suffix: &str) -> PathBuf {
    let mut s = p.as_os_str().to_owned();
    s.push(suffix);
    PathBuf::from(s)
}

/// Go `os.ReadFile` 의 오류 모양.
fn read_file(p: &Path) -> io::Result<Vec<u8>> {
    fs::read(p).map_err(|e| {
        let op = if e.kind() == io::ErrorKind::IsADirectory {
            "read"
        } else {
            "open"
        };
        path_error(op, &lossy(p), e)
    })
}

/// Go `os.WriteFile(p, data, 0644)`.
fn write_file(p: &Path, data: &[u8]) -> io::Result<()> {
    let mut o = fs::OpenOptions::new();
    o.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        o.mode(FILE_PERM);
    }
    let mut f = o.open(p).map_err(|e| path_error("open", &lossy(p), e))?;
    f.write_all(data)
        .map_err(|e| path_error("write", &lossy(p), e))
}

/// 없는 파일은 빈 값이다.
fn read_optional(p: &Path) -> Result<Vec<u8>, Error> {
    match read_file(p) {
        Ok(b) => Ok(b),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(Error::Msg(format!(
            "{} 읽기: {}",
            base(p),
            go_error_string(&e)
        ))),
    }
}

/// path 를 suffix 백업으로 남긴다. 백업이 이미 있으면 아무것도 하지 않는다.
fn backup_once(p: &Path, suffix: &str) -> Result<(), Error> {
    let bak = with_suffix(p, suffix);
    if fs::metadata(&bak).is_ok() {
        return Ok(());
    }
    let b = match read_file(p) {
        Ok(b) => b,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(e) => {
            return Err(Error::Msg(format!(
                "{} 백업 읽기: {}",
                base(p),
                go_error_string(&e)
            )));
        }
    };
    write_file(&bak, &b)
        .map_err(|e| Error::Msg(format!("{} 백업 쓰기: {}", base(&bak), go_error_string(&e))))
}

fn write_named(p: &Path, data: &[u8], name: &str) -> Result<(), Error> {
    write_file(p, data).map_err(|e| Error::Msg(format!("{name} 쓰기: {}", go_error_string(&e))))
}

/// paned.pid 가 가리키는 프로세스가 살아 있으면 그 pid. 생존 판정은 platform 이 한다 (FR-WTP-1).
fn daemon_alive(home: &Path) -> Option<i64> {
    let b = fs::read(home.join(PANED_PID_FILE)).ok()?;
    let pid: i64 = String::from_utf8_lossy(&b).trim().parse().ok()?;
    if pid <= 0 {
        return None;
    }
    let p32 = i32::try_from(pid).ok()?;
    otter_shared_platform::current()
        .process
        .alive(p32)
        .then_some(pid)
}

/// home 의 workspace.json·panes.json·settings.json 을 v2 로 바꾼다. 변환을 모두 끝낸 뒤에만
/// 디스크를 건드리므로 입력이 깨져 있으면 어떤 파일도 바뀌지 않는다. 백업이 이미 있으면
/// 덮어쓰지 않는다. dry_run 이면 보고만 낸다.
pub fn apply(home: &Path, dry_run: bool) -> Result<Report, Error> {
    if !dry_run && let Some(pid) = daemon_alive(home) {
        return Err(Error::DaemonRunning(pid));
    }
    let ws_path = home.join(WORKSPACE_FILE);
    let pn_path = home.join(PANES_FILE);
    let tools_path = home.join(TOOLS_FILE);

    let ws_blob = read_optional(&ws_path)?;
    let mut pn_blob = read_optional(&pn_path)?;
    // 재실행 경로: 1차 실행이 panes.json 을 백업으로 옮겼으므로 도구 컬렉션은 tools.json 에서 읽는다.
    let mut from_tools = false;
    if pn_blob.is_empty() {
        pn_blob = read_optional(&tools_path)?;
        from_tools = !pn_blob.is_empty();
    }

    let mut res = run(&ws_blob, &pn_blob)?;
    let (ws_rw, tools_rw, id_rep) = rewrite_identifiers(
        res.workspace.as_deref().unwrap_or_default(),
        res.tools.as_deref().unwrap_or_default(),
        None,
    )?;
    let rewrote = id_rep.total() > 0;
    res.report.identity = id_rep;
    if rewrote {
        res.workspace = ws_rw;
        res.tools = tools_rw;
    }

    let st_path = home.join(SETTINGS_FILE);
    let st_blob = read_optional(&st_path)?;
    let (st_out, renamed) = settings(&st_blob)?;
    res.report.shortcuts_renamed = renamed;

    if (res.report.empty && st_out.is_none()) || dry_run {
        return Ok(res.report);
    }

    if let Some(ws) = &res.workspace {
        backup_once(&ws_path, BACKUP_SUFFIX)?;
        if rewrote {
            backup_once(&ws_path, PRE_UUID_SUFFIX)?;
        }
        write_named(&ws_path, ws, WORKSPACE_FILE)?;
    }
    if let Some(tools) = &res.tools {
        if !from_tools {
            backup_once(&pn_path, BACKUP_SUFFIX)?;
            if let Err(e) = fs::remove_file(&pn_path)
                && e.kind() != io::ErrorKind::NotFound
            {
                return Err(Error::Msg(format!(
                    "{PANES_FILE} 제거: {}",
                    go_error_string(&path_error("remove", &lossy(&pn_path), e))
                )));
            }
        }
        if rewrote {
            backup_once(&tools_path, PRE_UUID_SUFFIX)?;
        }
        write_named(&tools_path, tools, TOOLS_FILE)?;
    }
    if let Some(st) = &st_out {
        backup_once(&st_path, BACKUP_SUFFIX)?;
        write_named(&st_path, st, SETTINGS_FILE)?;
    }
    Ok(res.report)
}
