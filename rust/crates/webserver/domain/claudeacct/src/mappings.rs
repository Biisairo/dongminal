//! 폴더·탭과 계정의 연결 (FR-CAC-80~). mappings.json 은 파일 락 아래의 읽기-고치기-쓰기다.

use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::PathBuf;

use dm_gocompat::filepath;
use dm_gocompat::json::{self, is_empty};
use serde::{Deserialize, Serialize};

use crate::error::{Error, Sentinel};
use crate::service::Service;
use crate::{DIR_MODE, FILE_MODE, fsutil};

const MAPPINGS_FILE: &str = "mappings.json";
const MAPPINGS_LOCK_FILE: &str = ".mappings.lock";
pub(crate) const PROFILES_DIR: &str = "profiles";

/// 해석의 출처.
pub const SOURCE_TAB: &str = "tab";
pub const SOURCE_FOLDER: &str = "folder";
pub const SOURCE_NONE: &str = "none";

/// Windows 는 경로의 대소문자를 가리지 않는다.
pub(crate) const FOLD_CASE: bool = cfg!(windows);

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "claudeacct.Mapping")]
pub struct Mapping {
    #[serde(rename = "accountId")]
    pub account_id: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "claudeacct.Mappings")]
pub struct Mappings {
    pub folders: BTreeMap<String, Mapping>,
    pub tabs: BTreeMap<String, Mapping>,
}

/// 탭·폴더가 어느 계정으로 풀리는가다.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "claudeacct.Resolution")]
pub struct Resolution {
    #[serde(rename = "accountId", skip_serializing_if = "is_empty")]
    pub account_id: String,
    pub source: String,
    #[serde(skip_serializing_if = "is_empty")]
    pub folder: String,
    #[serde(rename = "configDir", skip_serializing_if = "is_empty")]
    pub config_dir: String,
    pub path: String,
}

/// Go `filepath.EvalSymlinks`: 없는 경로는 오류다.
fn eval_symlinks(p: &str) -> Option<String> {
    let r = fs::canonicalize(p).ok()?;
    let s = r.to_string_lossy().into_owned();
    #[cfg(windows)]
    let s = match s.strip_prefix(r"\\?\UNC\") {
        Some(rest) => format!(r"\\{rest}"),
        None => s.strip_prefix(r"\\?\").map(str::to_owned).unwrap_or(s),
    };
    Some(s)
}

/// 폴더 경로를 비교할 수 있는 꼴로 만든다. 절대 경로만 받는다. 있는 데까지 심볼릭 링크를 풀고
/// 나머지를 잇는다. fold 면 소문자로 바꾼다.
pub fn normalize_folder(p: &str, fold: bool) -> Result<String, Error> {
    if p.is_empty() || !filepath::is_abs(p) {
        return Err(Error::with_detail(
            Sentinel::Invalid,
            "절대 경로가 필요합니다",
        ));
    }
    let mut p = filepath::clean(p);
    let mut rest = String::new();
    let mut cur = p.clone();
    loop {
        if let Some(r) = eval_symlinks(&cur) {
            p = filepath::join(&[r, rest]);
            break;
        }
        let parent = filepath::dir(&cur);
        if parent == cur {
            break;
        }
        rest = filepath::join(&[filepath::base(&cur), rest]);
        cur = parent;
    }
    if fold {
        p = p.to_lowercase();
    }
    Ok(p)
}

fn under_folder(p: &str, folder: &str) -> bool {
    if p == folder {
        return true;
    }
    let sep = std::path::MAIN_SEPARATOR;
    let mut prefix = folder.to_owned();
    if !prefix.ends_with(sep) {
        prefix.push(sep);
    }
    p.starts_with(&prefix)
}

impl Service {
    fn mappings_path(&self) -> PathBuf {
        self.dir.join(MAPPINGS_FILE)
    }

    /// 계정의 프로필 폴더다 (FR-CAC-82).
    pub fn profile_dir(&self, id: &str) -> PathBuf {
        self.dir.join(PROFILES_DIR).join(id)
    }

    /// Claude Code 가 쓰는 설정 폴더들이다: 기본 프로필, 그다음 프로필 폴더들(이름 순).
    pub fn config_dirs(&self) -> Vec<PathBuf> {
        let mut dirs = vec![self.claude.config_home.clone()];
        let mut names: Vec<String> = fs::read_dir(self.dir.join(PROFILES_DIR))
            .map(|rd| {
                rd.flatten()
                    .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
                    .map(|e| e.file_name().to_string_lossy().into_owned())
                    .collect()
            })
            .unwrap_or_default();
        names.sort();
        dirs.extend(names.iter().map(|n| self.profile_dir(n)));
        dirs
    }

    fn load_mappings(&self) -> Result<Mappings, Error> {
        let b = match fsutil::read_file(&self.mappings_path()) {
            Ok(b) => b,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Mappings::default()),
            Err(e) => return Err(e.into()),
        };
        Ok(json::unmarshal::<Mappings>(&b).unwrap_or_default())
    }

    /// mappings.json 이다. 읽을 수 없는 파일은 빈 것으로 본다.
    pub fn mappings(&self) -> Result<Mappings, Error> {
        self.load_mappings()
    }

    fn update_mappings(&self, f: impl FnOnce(&mut Mappings) -> bool) -> Result<bool, Error> {
        fsutil::mkdir_all(&self.dir, DIR_MODE)?;
        let _lock = fsutil::lock_file(&self.dir.join(MAPPINGS_LOCK_FILE), self.store.lock_timeout)
            .map_err(|e| Error::new(e.to_string()))?;
        let mut m = self.load_mappings()?;
        if !f(&mut m) {
            return Ok(false);
        }
        let b = json::marshal_indent(&m, "", "  ")?;
        dm_shared_platform::write_file_atomic(&self.mappings_path(), &b, FILE_MODE)?;
        Ok(true)
    }

    fn check_account(&self, id: &str) -> Result<(), Error> {
        match self.store.load()?.find(id) {
            Some(_) => Ok(()),
            None => Err(Sentinel::NotFound.into()),
        }
    }

    /// 폴더를 계정에 잇는다. account_id 가 비면 끊는다.
    pub fn set_folder(&self, path: &str, account_id: &str) -> Result<(), Error> {
        let key = normalize_folder(path, FOLD_CASE)?;
        if !account_id.is_empty() {
            self.check_account(account_id)?;
        }
        self.update_mappings(|m| {
            if account_id.is_empty() {
                return m.folders.remove(&key).is_some();
            }
            m.folders.insert(
                key,
                Mapping {
                    account_id: account_id.to_owned(),
                },
            );
            true
        })?;
        Ok(())
    }

    /// 탭을 계정에 잇는다. account_id 가 비면 끊는다.
    pub fn set_tab(&self, tool_id: &str, account_id: &str) -> Result<(), Error> {
        if tool_id.is_empty() {
            return Err(Error::with_detail(
                Sentinel::Invalid,
                "toolId 가 필요합니다",
            ));
        }
        if !account_id.is_empty() {
            self.check_account(account_id)?;
        }
        self.update_mappings(|m| {
            if account_id.is_empty() {
                return m.tabs.remove(tool_id).is_some();
            }
            m.tabs.insert(
                tool_id.to_owned(),
                Mapping {
                    account_id: account_id.to_owned(),
                },
            );
            true
        })?;
        Ok(())
    }

    /// 살아 있지 않은 탭의 연결을 지운다. 지웠으면 true.
    pub fn prune_tabs(&self, alive: impl Fn(&str) -> bool) -> Result<bool, Error> {
        let m = self.load_mappings()?;
        if m.tabs.keys().all(|id| alive(id)) {
            return Ok(false);
        }
        self.update_mappings(|m| {
            let before = m.tabs.len();
            m.tabs.retain(|id, _| alive(id));
            m.tabs.len() != before
        })
    }

    pub(crate) fn drop_account_mappings(&self, id: &str) -> Result<(), Error> {
        self.update_mappings(|m| {
            let before = m.folders.len() + m.tabs.len();
            m.folders.retain(|_, v| v.account_id != id);
            m.tabs.retain(|_, v| v.account_id != id);
            m.folders.len() + m.tabs.len() != before
        })?;
        Ok(())
    }

    /// 탭과 작업 폴더가 어느 계정으로 풀리는가다. 탭 연결이 먼저, 그다음 가장 깊은 폴더 연결이다.
    /// 지워진 계정의 연결은 건너뛴다.
    pub fn resolve(&self, tool_id: &str, cwd: &str) -> Result<Resolution, Error> {
        let key = normalize_folder(cwd, FOLD_CASE)?;
        let st = self.store.load()?;
        let m = self.load_mappings()?;
        let found = |id: &str, source: &str, folder: &str| Resolution {
            account_id: id.to_owned(),
            source: source.to_owned(),
            folder: folder.to_owned(),
            config_dir: self.profile_dir(id).to_string_lossy().into_owned(),
            path: key.clone(),
        };
        if !tool_id.is_empty()
            && let Some(t) = m.tabs.get(tool_id)
            && st.find(&t.account_id).is_some()
        {
            return Ok(found(&t.account_id, SOURCE_TAB, ""));
        }
        let mut best: Option<(&String, &String)> = None;
        for (folder, v) in &m.folders {
            if st.find(&v.account_id).is_none() || !under_folder(&key, folder) {
                continue;
            }
            if best.is_none_or(|(b, _)| folder.len() > b.len()) {
                best = Some((folder, &v.account_id));
            }
        }
        if let Some((folder, id)) = best {
            return Ok(found(id, SOURCE_FOLDER, folder));
        }
        Ok(Resolution {
            source: SOURCE_NONE.to_owned(),
            path: key.clone(),
            ..Resolution::default()
        })
    }
}
