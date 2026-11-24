//! 설치 — 이 에이전트가 붙기 위해 디스크에 놓아야 할 것 (FR-AAC-1~6). 경로 규칙은 runtime 이 안다.

use std::io;
use std::path::{Path, PathBuf};

use otter_gocompat::json;
use otter_shared_platform::write_file_if_changed;

/// 설치 디렉터리의 권한 (Go `os.MkdirAll(..., 0o755)`).
const DIR_PERM: u32 = 0o755;

/// 자산을 놓을 자리들 (FR-AAC-2).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct InstallSpec {
    /// 훅·shim 이 사는 자리 (`bin/agent-hooks`). 호출자가 미리 만든다.
    pub dir: PathBuf,
    /// 세션 스코프 플러그인의 뿌리 (`bin/agent-plugin`). 비면 그 규약을 쓰지 않는다.
    pub plugin_dir: PathBuf,
    /// 이 인스턴스의 헬퍼 절대경로.
    pub otterctl: String,
}

impl InstallSpec {
    /// 에이전트 훅에 적을 명령 한 줄 (FR-AAC-3). 실행 파일만 인용한다 (FR-HPR-4·5).
    pub fn hook_command(&self, args: &[&str]) -> String {
        let mut cmd = format!("\"{}\"", self.otterctl);
        if !args.is_empty() {
            cmd.push(' ');
            cmd.push_str(&args.join(" "));
        }
        cmd
    }
}

/// Go `json.MarshalIndent(v, "", "  ")` 를 0644 로 쓴다.
pub(crate) fn write_json(path: &Path, v: &serde_json::Value) -> io::Result<()> {
    let blob = json::marshal_indent(v, "", "  ").map_err(|e| io::Error::other(e.to_string()))?;
    write_file_if_changed(path, &blob, 0o644)
}

/// Go `os.MkdirAll(p, 0o755)`.
pub(crate) fn mkdir_all(p: &Path) -> io::Result<()> {
    otter_gocompat::oserr::mkdir_all(&p.to_string_lossy(), DIR_PERM)
}
