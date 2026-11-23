//! `.gitignore` 에 경로를 더한다 (FR-GIT-116). git 을 부르지 않는 파일 쓰기다.

use std::io;

use dm_gocompat::filepath;
use dm_gocompat::oserr;
use dm_gocompat::strconv::quote;
use dm_webserver_domain_git_core as core;
use serde::Serialize;

use crate::error::{Error, WriteKind};

pub const IGNORE_FILE_NAME: &str = ".gitignore";
#[cfg(unix)]
const IGNORE_PERM: u32 = 0o644;

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename = "write.IgnoreResult")]
pub struct IgnoreResult {
    /// 절대경로.
    pub file: String,
    /// 새로 넣은 패턴.
    pub added: Vec<String>,
    /// 이미 있어서 넣지 않은 패턴.
    pub skipped: Vec<String>,
}

pub fn ignore_file(root: &str) -> String {
    filepath::join(&[root, IGNORE_FILE_NAME])
}

/// 저장소 루트에 고정한 패턴(`/rel`)이다.
pub fn ignore_pattern(root: &str, p: &str) -> Result<String, Error> {
    if p.trim().is_empty() {
        return Err(Error::new(WriteKind::IgnorePath, "경로가 비었다"));
    }
    let mut rel = p.to_owned();
    if filepath::is_abs(p) {
        match filepath::rel(root, p) {
            Ok(r) => rel = filepath::to_slash(&r),
            Err(_) => {
                return Err(Error::new(
                    WriteKind::IgnorePath,
                    format!("{} 는 {root} 안의 경로가 아니다", quote(p)),
                ));
            }
        }
    }
    let rel = core::rel_path_detail(&rel).map_err(|d| Error::new(WriteKind::IgnorePath, d))?;
    if rel == "." {
        return Err(Error::new(
            WriteKind::IgnorePath,
            "저장소 루트 자신은 무시할 수 없다",
        ));
    }
    Ok(format!("/{rel}"))
}

/// 없는 패턴만 끝에 덧붙인다. 이미 있는 것은 skipped 로 돌려준다.
pub fn ignore_add(root: &str, paths: &[String]) -> Result<IgnoreResult, Error> {
    let mut res = IgnoreResult {
        file: ignore_file(root),
        ..IgnoreResult::default()
    };
    if paths.is_empty() {
        return Err(Error::new(WriteKind::IgnorePath, "대상 경로가 없다"));
    }
    let want = paths
        .iter()
        .map(|p| ignore_pattern(root, p))
        .collect::<Result<Vec<_>, _>>()?;
    let body = match std::fs::read(&res.file) {
        Ok(b) => b,
        Err(e) if e.kind() == io::ErrorKind::NotFound => Vec::new(),
        Err(e) => return Err(file_err(&res.file, "읽지", "open", e)),
    };
    let mut have = ignore_lines(&String::from_utf8_lossy(&body));
    let mut add = String::new();
    for pat in want {
        if have.contains(&pat) {
            res.skipped.push(pat);
            continue;
        }
        have.push(pat.clone());
        add.push_str(&pat);
        add.push('\n');
        res.added.push(pat);
    }
    if add.is_empty() {
        return Ok(res);
    }
    let mut out = body;
    if !out.is_empty() && !out.ends_with(b"\n") {
        out.push(b'\n');
    }
    out.extend_from_slice(add.as_bytes());
    if let Err(e) = write_file(&res.file, &out) {
        return Err(file_err(&res.file, "쓰지", "open", e));
    }
    Ok(res)
}

fn write_file(path: &str, data: &[u8]) -> io::Result<()> {
    let mut o = std::fs::OpenOptions::new();
    o.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        o.mode(IGNORE_PERM);
    }
    io::Write::write_all(&mut o.open(path)?, data)
}

fn file_err(file: &str, verb: &str, op: &str, e: io::Error) -> Error {
    let pe = oserr::path_error(op, file, e);
    Error::other(format!(
        "{file} 를 {verb} 못했다: {}",
        oserr::go_error_string(&pe)
    ))
}

fn ignore_lines(body: &str) -> Vec<String> {
    let mut out = Vec::new();
    for l in body.split('\n') {
        let l = l.trim();
        if l.is_empty() || l.starts_with('#') {
            continue;
        }
        if l.starts_with('/') {
            out.push(l.to_owned());
        } else {
            out.push(format!("/{l}"));
        }
    }
    out
}
