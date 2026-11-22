//! 손상 감지·격리·복구 (STATE_FILE_DURABILITY_SRS 묶음 Q).

use std::fs;
use std::io::{self, Read};
use std::path::PathBuf;

use dm_gocompat::oserr::{go_error_string, link_error, path_error};
use dm_shared_dmlog::errorf;
use dm_shared_platform::{STATE_FILE_GENERATIONS, write_state_file};

use crate::Persister;
use crate::parse::{Index, build_index};

/// 읽지 못해 격리했고, 세대에서 되살렸다 (FR-SFD-14).
pub const LOAD_RESTORED: &str = "restored";
/// 읽지 못했고 되살릴 세대도 없었다. 빈 상태로 시작했다.
pub const LOAD_EMPTY: &str = "empty";
/// 마지막 비동기 쓰기가 실패했다 (`GO-10`).
pub const PERSIST_FAILED: &str = "write-failed";

const FILE_PERM: u32 = 0o644;
const QUARANTINE_TS_FORMAT: &str = "%Y%m%dT%H%M%SZ";

/// 손상된 파일을 격리하고 세대에서 되살릴 수 있는 저장소다.
pub trait Recoverable {
    /// 지금 파일을 `<파일>.corrupt-<ts>` 로 옮긴다. 덮어쓰지 않고, 자동으로 지우지 않는다.
    fn quarantine(&self) -> io::Result<()>;
    /// 세대의 내용을 최근 순으로 준다. 없으면 빈 목록이다.
    fn generations(&self) -> Vec<Vec<u8>>;
}

/// [`Persister`] 의 파일 구현이다. 쓰기는 원자적이고 세대를 남긴다 (FR-CAF-11·FR-SFD-1).
#[derive(Clone, Debug)]
pub struct FilePersister {
    pub path: PathBuf,
}

impl FilePersister {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    fn suffixed(&self, suffix: &str) -> PathBuf {
        let mut s = self.path.as_os_str().to_owned();
        s.push(suffix);
        PathBuf::from(s)
    }
}

fn read_file(path: &std::path::Path) -> io::Result<Vec<u8>> {
    let p = path.to_string_lossy();
    let mut f = fs::File::open(path).map_err(|e| path_error("open", &p, e))?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf)
        .map_err(|e| path_error("read", &p, e))?;
    Ok(buf)
}

impl Persister for FilePersister {
    fn read(&self) -> io::Result<Vec<u8>> {
        read_file(&self.path)
    }

    fn write(&self, data: &[u8]) -> io::Result<()> {
        write_state_file(&self.path, data, FILE_PERM)
    }

    fn recoverable(&self) -> Option<&dyn Recoverable> {
        Some(self)
    }
}

impl Recoverable for FilePersister {
    fn quarantine(&self) -> io::Result<()> {
        let ts = chrono::Utc::now().format(QUARANTINE_TS_FORMAT);
        let dst = self.suffixed(&format!(".corrupt-{ts}"));
        fs::rename(&self.path, &dst).map_err(|e| {
            link_error(
                "rename",
                &self.path.to_string_lossy(),
                &dst.to_string_lossy(),
                e,
            )
        })
    }

    /// 읽히지 않는 세대는 건너뛴다 — 더 오래된 멀쩡한 세대에 닿아야 한다.
    fn generations(&self) -> Vec<Vec<u8>> {
        (1..=STATE_FILE_GENERATIONS)
            .filter_map(|i| fs::read(self.suffixed(&format!(".bak.{i}"))).ok())
            .collect()
    }
}

/// 읽지 못한 파일을 격리하고 세대에서 되살린다. (내용, 색인, 분류) 를 돌려준다.
pub(crate) fn recover_corrupt(store: &dyn Persister) -> (Vec<u8>, Index, &'static str) {
    let Some(rec) = store.recoverable() else {
        return (Vec::new(), Index::default(), LOAD_EMPTY);
    };
    if let Err(e) = rec.quarantine() {
        errorf!(None, "workspace: 격리 실패: {}", go_error_string(&e));
    }
    for blob in rec.generations() {
        if let Ok(ix) = build_index(&blob) {
            errorf!(
                None,
                "workspace: 손상된 파일을 격리하고 백업 세대에서 복원했습니다"
            );
            return (blob, ix, LOAD_RESTORED);
        }
    }
    errorf!(
        None,
        "workspace: 손상된 파일을 격리했으나 복원할 백업 세대가 없습니다"
    );
    (Vec::new(), Index::default(), LOAD_EMPTY)
}
