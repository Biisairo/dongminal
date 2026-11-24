//! 전환 기록 history.jsonl (FR-CAC-110).

use std::io;
use std::path::Path;
use std::sync::{Mutex, PoisonError};

use otter_gocompat::json;
use serde::{Deserialize, Serialize};

use crate::error::Error;
use crate::fsutil;
use crate::live::write_secret_file;

const HISTORY_FILE: &str = "history.jsonl";
const HISTORY_MAX: usize = 1000;

/// 전환 기록의 trigger (FR-CAC-110).
pub const TRIGGER_MANUAL: &str = "manual";
pub const TRIGGER_NEXT: &str = "next";
pub const TRIGGER_NEXT_AVAILABLE: &str = "next-available";
pub const TRIGGER_BEST: &str = "best";
pub const TRIGGER_PROACTIVE: &str = "proactive";
pub const TRIGGER_AT_LIMIT: &str = "at-limit";
pub const TRIGGER_FAILOVER: &str = "failover";
pub const TRIGGER_CONSUME_FIRST: &str = "consume-first";
pub const TRIGGER_PRIORITY: &str = "priority";

/// 전환 기록의 by (FR-CAC-110a).
pub const BY_UI: &str = "ui";
pub const BY_OTTERCTL: &str = "otterctl";
pub const BY_AUTO: &str = "auto";

/// history.jsonl 의 한 줄이다. 헤드룸을 모르면 `None`(null) 이다.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename = "claudeacct.HistoryEntry")]
pub struct HistoryEntry {
    pub at: i64,
    pub from: String,
    pub to: String,
    pub trigger: String,
    #[serde(rename = "headroomFrom")]
    pub headroom_from: Option<f64>,
    #[serde(rename = "headroomTo")]
    pub headroom_to: Option<f64>,
    pub by: String,
}

static HISTORY_MU: Mutex<()> = Mutex::new(());

fn read_history_lines(dir: &Path) -> Result<Vec<Vec<u8>>, Error> {
    let b = match fsutil::read_file(&dir.join(HISTORY_FILE)) {
        Ok(b) => b,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e.into()),
    };
    Ok(b.split(|c| *c == b'\n')
        .filter(|l| !l.trim_ascii().is_empty())
        .map(<[u8]>::to_vec)
        .collect())
}

/// 한 줄을 더하고 HISTORY_MAX 줄을 넘으면 오래된 것부터 지운다 (FR-CAC-110).
pub(crate) fn append_history(dir: &Path, h: &HistoryEntry) -> Result<(), Error> {
    let _g = HISTORY_MU.lock().unwrap_or_else(PoisonError::into_inner);
    let line = json::marshal(h)?;
    let mut lines = read_history_lines(dir)?;
    lines.push(line);
    if lines.len() > HISTORY_MAX {
        lines.drain(..lines.len() - HISTORY_MAX);
    }
    let mut buf = Vec::new();
    for l in lines {
        buf.extend_from_slice(&l);
        buf.push(b'\n');
    }
    write_secret_file(&dir.join(HISTORY_FILE), &buf)
}

/// 최신 limit 건을 최신 먼저 돌려준다. 읽을 수 없는 줄은 건너뛴다.
pub fn read_history(dir: &Path, limit: usize) -> Result<Vec<HistoryEntry>, Error> {
    let lines = {
        let _g = HISTORY_MU.lock().unwrap_or_else(PoisonError::into_inner);
        read_history_lines(dir)?
    };
    Ok(lines
        .iter()
        .rev()
        .filter_map(|l| json::unmarshal::<HistoryEntry>(l).ok())
        .take(limit)
        .collect())
}
