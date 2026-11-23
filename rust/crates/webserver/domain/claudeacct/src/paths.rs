//! Claude Code 설정 폴더 하나가 쓰는 자리. Claude Code 의 규칙을 따른다 (cswap `paths.py`).

use std::fs;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

const KEYCHAIN_SERVICE_BASE: &str = "Claude Code-credentials";
const CREDENTIALS_FILE_NAME: &str = ".credentials.json";
const GLOBAL_CONFIG_NAME: &str = ".claude.json";
const LEGACY_CONFIG_NAME: &str = ".config.json";

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ClaudePaths {
    pub config_home: PathBuf,
    pub global_config: PathBuf,
    pub credentials: PathBuf,
    pub keychain_service: String,
}

impl ClaudePaths {
    /// 기본 프로필(`~/.claude`)의 자리다. `CLAUDE_CONFIG_DIR` 은 보지 않는다 — 활성 저장소는 늘
    /// 기본 프로필이다.
    pub fn default_for(user_home: &Path) -> Self {
        let ch = user_home.join(".claude");
        Self {
            global_config: pick_global_config(
                &ch.join(LEGACY_CONFIG_NAME),
                &user_home.join(GLOBAL_CONFIG_NAME),
            ),
            credentials: ch.join(CREDENTIALS_FILE_NAME),
            config_home: ch,
            keychain_service: KEYCHAIN_SERVICE_BASE.to_owned(),
        }
    }

    /// `CLAUDE_CONFIG_DIR=dir` 로 실행한 Claude Code 의 자리다 (FR-CAC-82).
    pub fn profile(dir: &Path) -> Self {
        Self {
            config_home: dir.to_path_buf(),
            global_config: pick_global_config(
                &dir.join(LEGACY_CONFIG_NAME),
                &dir.join(GLOBAL_CONFIG_NAME),
            ),
            credentials: dir.join(CREDENTIALS_FILE_NAME),
            keychain_service: format!(
                "{KEYCHAIN_SERVICE_BASE}-{}",
                profile_hash(&dir.to_string_lossy())
            ),
        }
    }

    /// Claude Code 가 토큰을 갱신할 때 잡는 두 락이다. 순서가 계약이다.
    pub fn cred_lock_dirs(&self) -> [PathBuf; 2] {
        let parent = self
            .config_home
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_default();
        let base = self
            .config_home
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        [
            self.config_home.join(".oauth_refresh.lock"),
            parent.join(format!("{base}.lock")),
        ]
    }

    /// 전역 설정 파일의 락이다.
    pub fn config_lock_dir(&self) -> PathBuf {
        let mut s = self.global_config.clone().into_os_string();
        s.push(".lock");
        PathBuf::from(s)
    }
}

/// `CLAUDE_CONFIG_DIR` 원문(NFC)의 SHA-256 앞 8자다. Claude Code 가 프로필의 키체인 항목 이름을
/// 이렇게 만든다.
pub(crate) fn profile_hash(dir: &str) -> String {
    let nfc = icu_normalizer::ComposingNormalizerBorrowed::new_nfc().normalize(dir);
    let sum = Sha256::digest(nfc.as_bytes());
    hex::encode(sum)[..8].to_owned()
}

/// Claude Code 2.1.299 의 선택이다. 옛 `.config.json` 이 일반 파일이고 비어 있지 않거나, 비어
/// 있어도 쓸 수 있고 `.claude.json` 이 없으면 옛 파일을 쓴다.
fn pick_global_config(legacy: &Path, global: &Path) -> PathBuf {
    let Ok(st) = fs::metadata(legacy) else {
        return global.to_path_buf();
    };
    if !st.is_file() {
        return global.to_path_buf();
    }
    if st.len() > 0 {
        return legacy.to_path_buf();
    }
    if writable(&st) && fs::metadata(global).is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound)
    {
        return legacy.to_path_buf();
    }
    global.to_path_buf()
}

#[cfg(unix)]
fn writable(m: &fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    m.permissions().mode() & 0o222 != 0
}

#[cfg(not(unix))]
fn writable(m: &fs::Metadata) -> bool {
    !m.permissions().readonly()
}
