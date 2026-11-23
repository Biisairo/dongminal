use std::collections::BTreeMap;
use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::Path;

use dm_gocompat::json::{self, RawMessage};
use dm_gocompat::oserr::go_error_string;
use dm_shared_toolhub::HandoverTool;
use serde::{Deserialize, Serialize};

/// exec 를 넘는 데몬의 기억이다 (DAEMON_SESSION_KEEP_SRS FR-DSK-14). JSON 은 Go 와 같다.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "swap.State")]
pub struct State {
    pub version: i64,
    pub tools: Option<Vec<HandoverTool>>,
    #[serde(skip_serializing_if = "json::is_empty")]
    pub global: BTreeMap<String, RawMessage>,
    #[serde(rename = "panedFd")]
    pub paned_fd: u64,
    #[serde(rename = "reportFd")]
    pub report_fd: u64,
}

/// st 를 이름 없는 임시 파일에 쓰고 처음으로 되감은 파일을 돌려준다 (D-DSK-12).
/// dir 은 이름 있는 임시 파일이 잠시 놓일 자리다(memfd 가 없는 OS).
pub fn write_state(dir: &Path, st: &State) -> io::Result<File> {
    let blob = json::marshal(st).map_err(|e| io::Error::other(e.to_string()))?;
    let mut f = dm_shared_platform::anon_file(dir)
        .map_err(|e| io::Error::other(format!("인계 파일: {}", go_error_string(&e))))?;
    f.write_all(&blob)
        .map_err(|e| io::Error::other(format!("인계 파일 쓰기: {}", go_error_string(&e))))?;
    f.seek(SeekFrom::Start(0))?;
    Ok(f)
}

/// f 에서 인계 상태를 읽고 f 를 닫는다. 닫는 순간 OS 가 내용을 치운다 (FR-DSK-25).
pub fn read_state(mut f: File) -> io::Result<State> {
    let mut blob = Vec::new();
    f.read_to_end(&mut blob)
        .map_err(|e| io::Error::other(format!("인계 상태 읽기: {}", go_error_string(&e))))?;
    drop(f);
    json::Decoder::new()
        .decode(&blob)
        .map_err(|e| io::Error::other(format!("인계 상태 읽기: {e}")))
}
