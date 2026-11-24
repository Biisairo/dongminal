//! 주인을 확정하지 못한 자격증명의 보관함 (FR-CAC-34).

use std::fs;
use std::io;
use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::error::{Error, Sentinel};
use crate::fsutil;
use crate::service::Service;

pub(crate) const UNCLAIMED_DIR: &str = "unclaimed";

static UNCLAIMED_NAME: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^([0-9]+)-([0-9a-f]{12})\.json$").expect("상수 정규식"));

/// 보관한 자격증명 하나. 내용(토큰)은 싣지 않는다.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "claudeacct.UnclaimedEntry")]
pub struct UnclaimedEntry {
    pub name: String,
    pub at: i64,
    pub fingerprint: String,
}

impl Service {
    /// 보관함 목록이다. 최신 먼저, 같으면 이름 순이다.
    pub fn unclaimed(&self) -> Result<Vec<UnclaimedEntry>, Error> {
        let dir = self.dir.join(UNCLAIMED_DIR);
        let rd = match fs::read_dir(&dir) {
            Ok(rd) => rd,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => {
                return Err(
                    otter_gocompat::oserr::path_error("open", &dir.to_string_lossy(), e).into(),
                );
            }
        };
        let mut out = Vec::new();
        for de in rd.flatten() {
            let name = de.file_name().to_string_lossy().into_owned();
            let Some(m) = UNCLAIMED_NAME.captures(&name) else {
                continue;
            };
            if !de.file_type().is_ok_and(|t| t.is_file()) {
                continue;
            }
            let Ok(at) = m[1].parse::<i64>() else {
                continue;
            };
            let fingerprint = m[2].to_owned();
            out.push(UnclaimedEntry {
                name,
                at,
                fingerprint,
            });
        }
        out.sort_by(|a, b| b.at.cmp(&a.at).then_with(|| a.name.cmp(&b.name)));
        Ok(out)
    }

    /// 보관한 자격증명 하나를 지운다. 이미 없으면 성공이다.
    pub fn remove_unclaimed(&self, name: &str) -> Result<(), Error> {
        if !UNCLAIMED_NAME.is_match(name) {
            return Err(Error::with_detail(
                Sentinel::Invalid,
                "보관 이름 형식이 아닙니다",
            ));
        }
        Ok(fsutil::remove_if_exists(
            &self.dir.join(UNCLAIMED_DIR).join(name),
        )?)
    }
}
