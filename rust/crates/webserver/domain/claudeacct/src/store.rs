//! accounts.json. 변경은 파일 락 아래의 읽기-고치기-쓰기다 (FR-CAC-3).

use std::collections::BTreeMap;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex, PoisonError};
use std::time::Duration;

use dm_gocompat::json::{self, is_empty};
use dm_gocompat::strconv::quote;
use dm_gocompat::time::GoTime;
use dm_shared_platform::FileLock;
use serde::{Deserialize, Serialize};

use crate::error::{Error, Sentinel};
use crate::{DIR_MODE, FILE_MODE, fsutil};

pub(crate) const ACCOUNTS_FILE: &str = "accounts.json";
const STORE_LOCK_FILE: &str = ".lock";
pub(crate) const SCHEMA_VERSION: i64 = 1;
const DEFAULT_LOCK_TIMEOUT: Duration = Duration::from_secs(10);

const ALIAS_MAX: f64 = 24.0;
pub(crate) const THRESHOLD_MIN: f64 = 50.0;
pub(crate) const THRESHOLD_MAX: f64 = 100.0;
const PRIORITY_MIN: f64 = 0.0;
const PRIORITY_MAX: f64 = 1000.0;

/// 계정 색의 키다. 실제 색은 테마 토큰(`--acct-1`…)이 정한다 (FR-CAC-98).
pub(crate) const PALETTE: [&str; 8] = [
    "acct-1", "acct-2", "acct-3", "acct-4", "acct-5", "acct-6", "acct-7", "acct-8",
];

/// 숫자 칸 하나의 범위다 (양 끝 포함).
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename = "claudeacct.AutoRange")]
pub struct AutoRange {
    pub min: f64,
    pub max: f64,
}

impl AutoRange {
    pub(crate) fn has(&self, v: f64) -> bool {
        v >= self.min && v <= self.max
    }
}

/// 계정 행 칸의 범위다 (양 끝 포함). 키는 Patch 의 JSON 이름이고, `alias` 는 글자 수의 범위다.
/// 범위의 원천은 이 표 하나다 (REFACTOR3_FE_FIX_SRS FR-FFX-20).
pub static ACCOUNT_RANGES: LazyLock<BTreeMap<&'static str, AutoRange>> = LazyLock::new(|| {
    BTreeMap::from([
        (
            "alias",
            AutoRange {
                min: 0.0,
                max: ALIAS_MAX,
            },
        ),
        (
            "threshold",
            AutoRange {
                min: THRESHOLD_MIN,
                max: THRESHOLD_MAX,
            },
        ),
        (
            "priority",
            AutoRange {
                min: PRIORITY_MIN,
                max: PRIORITY_MAX,
            },
        ),
    ])
});

/// 등록된 계정이다 (FR-CAC-11). 토큰은 없다.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename = "claudeacct.Account")]
pub struct Account {
    pub id: String,
    pub email: String,
    #[serde(rename = "accountUuid")]
    pub account_uuid: String,
    #[serde(rename = "organizationUuid")]
    pub org_uuid: String,
    #[serde(rename = "organizationName")]
    pub org_name: String,
    #[serde(rename = "addedAt")]
    pub added_at: GoTime,
    #[serde(skip_serializing_if = "is_empty")]
    pub alias: String,
    pub color: String,
    pub disabled: bool,
    #[serde(skip_serializing_if = "is_empty")]
    pub threshold: Option<f64>,
    pub priority: i64,
}

/// accounts.json 이다. `accounts` 의 순서가 계정 순서다 (FR-CAC-13).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename = "claudeacct.State")]
pub struct State {
    #[serde(rename = "schemaVersion")]
    pub schema_version: i64,
    #[serde(rename = "activeId", skip_serializing_if = "is_empty")]
    pub active_id: String,
    pub accounts: Vec<Account>,
}

impl State {
    /// id 의 자리다.
    pub fn find(&self, id: &str) -> Option<usize> {
        self.accounts.iter().position(|a| a.id == id)
    }
}

/// 계정에서 고칠 수 있는 값이다. `None` 은 그대로 둔다.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename = "claudeacct.Patch")]
pub struct Patch {
    #[serde(skip_serializing_if = "is_empty")]
    pub alias: Option<String>,
    #[serde(skip_serializing_if = "is_empty")]
    pub color: Option<String>,
    #[serde(skip_serializing_if = "is_empty")]
    pub disabled: Option<bool>,
    #[serde(skip_serializing_if = "is_empty")]
    pub threshold: Option<f64>,
    #[serde(rename = "clearThreshold", skip_serializing_if = "is_empty")]
    pub clear_threshold: bool,
    #[serde(skip_serializing_if = "is_empty")]
    pub priority: Option<i64>,
}

impl Patch {
    /// 범위를 본다 (FR-CAC-11).
    pub fn validate(&self) -> Result<(), Error> {
        let r = &*ACCOUNT_RANGES;
        let invalid = |d: String| Err(Error::with_detail(Sentinel::Invalid, d));
        if let Some(a) = &self.alias
            && !r["alias"].has(a.chars().count() as f64)
        {
            return invalid(format!("별칭은 {:.0}자 이하입니다", r["alias"].max));
        }
        if let Some(c) = &self.color
            && !valid_color(c)
        {
            return invalid(format!("알 수 없는 색 {}", quote(c)));
        }
        if let Some(t) = self.threshold
            && !self.clear_threshold
            && !r["threshold"].has(t)
        {
            let t = r["threshold"];
            return invalid(format!("문턱값은 {:.0}~{:.1} 입니다", t.min, t.max));
        }
        if let Some(p) = self.priority
            && !r["priority"].has(p as f64)
        {
            let p = r["priority"];
            return invalid(format!("우선순위는 {:.0}~{:.0} 입니다", p.min, p.max));
        }
        Ok(())
    }

    pub(crate) fn apply(&self, a: &mut Account) {
        if let Some(v) = &self.alias {
            a.alias = v.clone();
        }
        if let Some(v) = &self.color {
            a.color = v.clone();
        }
        if let Some(v) = self.disabled {
            a.disabled = v;
        }
        if self.clear_threshold {
            a.threshold = None;
        } else if let Some(v) = self.threshold {
            a.threshold = Some(v);
        }
        if let Some(v) = self.priority {
            a.priority = v;
        }
    }
}

fn valid_color(c: &str) -> bool {
    PALETTE.contains(&c)
}

/// 아직 쓰지 않은 첫 색이다. 다 썼으면 계정 수로 돌려 쓴다.
pub(crate) fn pick_color(accts: &[Account]) -> String {
    PALETTE
        .iter()
        .find(|c| !accts.iter().any(|a| a.color == **c))
        .unwrap_or(&PALETTE[accts.len() % PALETTE.len()])
        .to_string()
}

pub struct Store {
    mu: Mutex<()>,
    dir: PathBuf,
    pub lock_timeout: Duration,
    /// accounts.json 을 읽은 횟수. 시험이 회차당 읽기 수를 센다 (GD-23).
    reads: AtomicU64,
}

impl Store {
    pub fn open(dir: impl Into<PathBuf>) -> Self {
        Self {
            mu: Mutex::new(()),
            dir: dir.into(),
            lock_timeout: DEFAULT_LOCK_TIMEOUT,
            reads: AtomicU64::new(0),
        }
    }

    /// 저장소 폴더다.
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    #[cfg(test)]
    pub(crate) fn reads(&self) -> u64 {
        self.reads.load(Ordering::Relaxed)
    }

    fn load_unlocked(&self) -> Result<State, Error> {
        self.reads.fetch_add(1, Ordering::Relaxed);
        let mut st = State {
            schema_version: SCHEMA_VERSION,
            ..State::default()
        };
        let b = match fsutil::read_file(&self.dir.join(ACCOUNTS_FILE)) {
            Ok(b) => b,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(st),
            Err(e) => return Err(e.into()),
        };
        st = json::unmarshal::<State>(&b).map_err(|e| Error::from(e).wrap(ACCOUNTS_FILE))?;
        st.schema_version = SCHEMA_VERSION;
        Ok(st)
    }

    /// 지금 상태다.
    pub fn load(&self) -> Result<State, Error> {
        let _g = self.mu.lock().unwrap_or_else(PoisonError::into_inner);
        self.load_unlocked()
    }

    /// 저장소 파일 락을 잡는다. 여러 파일을 한 번에 고치는 쪽(전환)이 쓴다.
    pub fn lock(&self) -> Result<FileLock, Error> {
        fsutil::mkdir_all(&self.dir, DIR_MODE)?;
        set_dir_mode(&self.dir);
        fsutil::lock_file(&self.dir.join(STORE_LOCK_FILE), self.lock_timeout)
            .map_err(|e| Error::new(e.to_string()))
    }

    /// 락 아래에서 상태를 고친다. f 가 오류를 내면 아무것도 쓰지 않는다.
    pub fn update<F: FnOnce(&mut State) -> Result<(), Error>>(&self, f: F) -> Result<(), Error> {
        let _lock = self.lock()?;
        self.update_locked(f)
    }

    /// 이미 [`Store::lock`] 을 잡은 호출부의 update 다.
    pub(crate) fn update_locked<F: FnOnce(&mut State) -> Result<(), Error>>(
        &self,
        f: F,
    ) -> Result<(), Error> {
        let _g = self.mu.lock().unwrap_or_else(PoisonError::into_inner);
        let mut st = self.load_unlocked()?;
        f(&mut st)?;
        let b = json::marshal_indent(&st, "", "  ")?;
        Ok(dm_shared_platform::write_file_atomic(
            &self.dir.join(ACCOUNTS_FILE),
            &b,
            FILE_MODE,
        )?)
    }
}

/// Go `os.Chmod(dir, 0o700)` (실패는 무시한다).
pub(crate) fn set_dir_mode(dir: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(DIR_MODE));
    }
    #[cfg(not(unix))]
    let _ = dir;
}
