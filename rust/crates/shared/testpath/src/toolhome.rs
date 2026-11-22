use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use dm_shared_dmenv::ENV_TOOL_HOME;

/// 도구 셸의 홈으로 쓸 임시 디렉터리다. 놓으면 지운다.
///
/// 도구 셸은 로그인 셸이라 히스토리를 쓴다. 검사가 주입한 명령이 사용자의 히스토리에
/// 남지 않게, 셸을 띄우는 검사는 [`ToolHome::env`] 를 자식 환경에 심는다.
#[derive(Debug)]
pub struct ToolHome {
    dir: PathBuf,
}

impl ToolHome {
    /// 임시 자리를 못 얻으면 패닉한다 — 조용히 사용자 홈으로 흘러드는 것이 이것이 막으려는 일이다.
    pub fn new() -> Self {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default();
        let dir = std::env::temp_dir().join(format!(
            "dongminal-toolhome-{}-{nanos}",
            std::process::id()
        ));
        if let Err(e) = std::fs::create_dir(&dir) {
            panic!("도구 홈 격리용 임시 디렉터리를 만들지 못했습니다: {e}");
        }
        Self { dir }
    }

    pub fn path(&self) -> &Path {
        &self.dir
    }

    /// 자식 프로세스에 심을 `(DONGMINAL_TOOL_HOME, 경로)` 다.
    pub fn env(&self) -> (&'static OsStr, &OsStr) {
        (OsStr::new(ENV_TOOL_HOME), self.dir.as_os_str())
    }
}

impl Default for ToolHome {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for ToolHome {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}
