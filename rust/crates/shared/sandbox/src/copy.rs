use std::fs;
use std::io;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::{CONTAINER_WORKDIR, Error, Manager, PROFILE_DEV, Profile, RunSpec};

/// 작업 폴더를 컨테이너에 주는 방식이다. `Unset` 은 Go 의 빈 문자열이다.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum WorkKind {
    #[default]
    #[serde(rename = "")]
    Unset,
    #[serde(rename = "none")]
    None,
    #[serde(rename = "mount")]
    Mount,
    #[serde(rename = "copy")]
    Copy,
}

impl WorkKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Unset => "",
            Self::None => "none",
            Self::Mount => "mount",
            Self::Copy => "copy",
        }
    }

    /// 아는 값만 읽는다.
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "none" => Some(Self::None),
            "mount" => Some(Self::Mount),
            "copy" => Some(Self::Copy),
            _ => None,
        }
    }
}

/// 복사 방식의 크기·항목 수 상한이다 (FR-SBX-12).
pub const COPY_MAX_BYTES: i64 = 2 << 30;
pub const COPY_MAX_FILES: i64 = 50_000;

struct Walk {
    bytes: i64,
    files: i64,
    max_bytes: i64,
    max_files: i64,
}

enum Stop {
    OverLimit,
    Err(io::Error),
}

impl Walk {
    /// Go `filepath.WalkDir` 의 순서(이름순, 디렉터리는 먼저 방문)로 센다.
    fn visit(&mut self, path: &Path, meta: Option<fs::Metadata>) -> Result<(), Stop> {
        let meta = match meta {
            Some(m) => m,
            None => fs::symlink_metadata(path).map_err(|e| Stop::Err(go_err("lstat", path, e)))?,
        };
        if meta.is_dir() {
            let rd = fs::read_dir(path).map_err(|e| Stop::Err(go_err("open", path, e)))?;
            let mut ents: Vec<_> = rd
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| Stop::Err(go_err("readdirent", path, e)))?;
            ents.sort_by_key(|e| e.file_name());
            for e in ents {
                let p = e.path();
                let m =
                    fs::symlink_metadata(&p).map_err(|err| Stop::Err(go_err("lstat", &p, err)))?;
                self.visit(&p, Some(m))?;
            }
            return Ok(());
        }
        self.files += 1;
        if meta.file_type().is_symlink() {
            return Ok(());
        }
        self.bytes += i64::try_from(meta.len()).unwrap_or(i64::MAX);
        if self.bytes > self.max_bytes || self.files > self.max_files {
            return Err(Stop::OverLimit);
        }
        Ok(())
    }
}

fn go_err(op: &str, path: &Path, e: io::Error) -> io::Error {
    otter_gocompat::oserr::path_error(op, &path.to_string_lossy(), e)
}

/// 복사 방식이면 작업 폴더가 상한 안인지 본다. 넘으면 띄우지 않는다.
pub fn verify_copy_source(
    p: &Profile,
    host_dir: &str,
    max_bytes: i64,
    max_files: i64,
) -> Result<(), Error> {
    if p.work != WorkKind::Copy || host_dir.is_empty() {
        return Ok(());
    }
    let mut w = Walk {
        bytes: 0,
        files: 0,
        max_bytes,
        max_files,
    };
    if let Err(Stop::Err(e)) = w.visit(Path::new(host_dir), None) {
        return Err(Error::msg(format!(
            "작업 폴더를 읽을 수 없습니다: {}",
            otter_gocompat::oserr::go_error_string(&e)
        )));
    }
    if w.bytes > max_bytes {
        return Err(Error::msg(format!(
            "작업 폴더가 너무 큽니다({} > {}) — 더 좁은 폴더를 고르거나 {PROFILE_DEV} 프로파일로 마운트하세요",
            human_bytes(w.bytes),
            human_bytes(max_bytes)
        )));
    }
    if w.files > max_files {
        return Err(Error::msg(format!(
            "작업 폴더의 항목이 너무 많습니다({} > {max_files}) — 더 좁은 폴더를 고르거나 {PROFILE_DEV} 프로파일로 마운트하세요",
            w.files
        )));
    }
    Ok(())
}

/// `1.5 KiB` 처럼 읽기 쉬운 크기다.
pub fn human_bytes(n: i64) -> String {
    const UNIT: i64 = 1024;
    if n < UNIT {
        return format!("{n} B");
    }
    let (mut div, mut exp) = (UNIT, 0usize);
    let mut v = n / UNIT;
    while v >= UNIT {
        div *= UNIT;
        exp += 1;
        v /= UNIT;
    }
    #[allow(clippy::cast_precision_loss)]
    let f = n as f64 / div as f64;
    format!("{f:.1} {}iB", char::from(b"KMGTPE"[exp]))
}

impl Manager {
    pub(crate) fn copy_work(&self, name: &str, p: &Profile, rs: &RunSpec) -> Result<(), Error> {
        if p.work != WorkKind::Copy || rs.host_dir.is_empty() {
            return Ok(());
        }
        let src = format!(
            "{}/.",
            rs.host_dir.strip_suffix('/').unwrap_or(&rs.host_dir)
        );
        let r = self.run(&["cp".into(), src, format!("{name}:{CONTAINER_WORKDIR}")]);
        if let Some(e) = r.err {
            return Err(Error::msg(format!(
                "작업 폴더를 컨테이너에 복사하지 못했습니다({}): {e}: {}",
                rs.host_dir,
                r.out.trim()
            )));
        }
        Ok(())
    }
}
