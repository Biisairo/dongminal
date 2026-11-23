//! 도우미의 비밀 파일 (NFR-PCH-2). root 만 읽는다.

use std::fs;
use std::io;
use std::path::Path;

use base64::Engine as _;
use base64::alphabet::STANDARD as STD_ALPHABET;
use base64::engine::general_purpose::{GeneralPurpose, GeneralPurposeConfig, STANDARD};
use data_encoding::{Encoding, Specification};
use dm_gocompat::json;
use dm_gocompat::oserr::path_error;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const TOTP_BYTES: usize = 20;
pub(crate) const RECOVERY_COUNT: usize = 8;
const RECOVERY_RAW_BYTES: usize = 7;
const SEED_SIZE: usize = 32;
/// 비밀 파일의 권한이다 — root 만 읽는다 (NFR-PCH-2).
const SECRET_MODE: u32 = 0o600;
#[cfg(unix)]
const SECRET_DIR_MODE: u32 = 0o700;

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "privhelper.Secret")]
pub struct Secret {
    pub uid: i64,
    /// base32(패딩 없음) 비밀이다.
    pub totp: String,
    /// 사람 명령 서명 키(Ed25519 시드)의 base64 다.
    pub key: String,
    /// 복구 코드의 SHA-256 hex. Go nil 슬라이스는 `null` 로 왕복한다.
    pub recovery: Option<Vec<String>>,
    /// 쓴 복구 코드.
    #[serde(skip_serializing_if = "json::is_empty")]
    pub used: Vec<String>,
}

/// Go `base32.StdEncoding.WithPadding(NoPadding)`: 디코딩은 \r·\n 을 건너뛰고 남는 비트를 받는다.
pub(crate) fn base32_nopad() -> Encoding {
    let mut s = Specification::new();
    s.symbols.push_str("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567");
    s.ignore.push_str("\r\n");
    s.check_trailing_bits = false;
    s.encoding()
        .unwrap_or_else(|_| data_encoding::BASE32_NOPAD.clone())
}

/// Go `base64.StdEncoding.DecodeString`: 패딩은 요구하고, 남는 비트는 받고, \r·\n 은 건너뛴다.
fn decode_std_lenient(s: &str) -> Option<Vec<u8>> {
    const LENIENT: GeneralPurpose = GeneralPurpose::new(
        &STD_ALPHABET,
        GeneralPurposeConfig::new().with_decode_allow_trailing_bits(true),
    );
    let cleaned: Vec<u8> = s.bytes().filter(|&c| c != b'\r' && c != b'\n').collect();
    LENIENT.decode(cleaned).ok()
}

pub(crate) fn hash_recovery(c: &str) -> String {
    hex::encode(Sha256::digest(c.as_bytes()))
}

/// 새 비밀과 복구 코드 원문을 만든다. 원문은 한 번만 보인다.
pub(crate) fn new_secret(uid: i64) -> (Secret, Vec<String>) {
    let mut raw = [0u8; TOTP_BYTES];
    let mut seed = [0u8; SEED_SIZE];
    rand::fill(&mut raw);
    rand::fill(&mut seed);
    let enc = base32_nopad();
    let mut s = Secret {
        uid,
        totp: enc.encode(&raw),
        key: STANDARD.encode(seed),
        recovery: Some(Vec::with_capacity(RECOVERY_COUNT)),
        used: Vec::new(),
    };
    let mut codes = Vec::with_capacity(RECOVERY_COUNT);
    for _ in 0..RECOVERY_COUNT {
        let mut b = [0u8; RECOVERY_RAW_BYTES];
        rand::fill(&mut b);
        let c = enc.encode(&b).to_lowercase()[..10].to_owned();
        let c = format!("{}-{}", &c[..5], &c[5..]);
        if let Some(r) = s.recovery.as_mut() {
            r.push(hash_recovery(&c));
        }
        codes.push(c);
    }
    (s, codes)
}

/// 서명 키의 시드다. 틀리면 `None`.
pub(crate) fn decode_key(k: &str) -> Option<[u8; SEED_SIZE]> {
    decode_std_lenient(k)?.try_into().ok()
}

/// 비밀 파일 읽기 오류.
#[derive(Debug)]
pub(crate) enum LoadError {
    Io(io::Error),
    Json(json::Error),
}

impl std::fmt::Display for LoadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LoadError::Io(e) => f.write_str(&dm_gocompat::oserr::go_error_string(e)),
            LoadError::Json(e) => write!(f, "{e}"),
        }
    }
}

pub(crate) fn load_secret(path: &Path) -> Result<Secret, LoadError> {
    let raw = fs::read(path).map_err(|e| {
        let op = if e.kind() == io::ErrorKind::IsADirectory {
            "read"
        } else {
            "open"
        };
        LoadError::Io(path_error(op, &path.to_string_lossy(), e))
    })?;
    json::unmarshal(&raw).map_err(LoadError::Json)
}

/// 0700 폴더의 0600 파일로 원자 쓰기 한다 (FR-ATF-61).
pub(crate) fn save_secret(path: &Path, s: &Secret) -> io::Result<()> {
    let dir = path.parent().unwrap_or(Path::new("."));
    let dir_s = dir.to_string_lossy().into_owned();
    let mut b = fs::DirBuilder::new();
    b.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
        b.mode(SECRET_DIR_MODE);
        b.create(dir).map_err(|e| path_error("mkdir", &dir_s, e))?;
        fs::set_permissions(dir, fs::Permissions::from_mode(SECRET_DIR_MODE))
            .map_err(|e| path_error("chmod", &dir_s, e))?;
    }
    #[cfg(not(unix))]
    b.create(dir).map_err(|e| path_error("mkdir", &dir_s, e))?;
    let raw = json::marshal_indent(s, "", "  ").map_err(io::Error::other)?;
    dm_shared_platform::write_file_atomic(path, &raw, SECRET_MODE)
}
