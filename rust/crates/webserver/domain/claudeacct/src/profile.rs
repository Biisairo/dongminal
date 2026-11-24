//! 계정별 프로필 폴더(`CLAUDE_CONFIG_DIR`) — 준비·공유 항목 잇기·실행 중 판정·토큰 회수 (FR-CAC-82~88).

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use dm_gocompat::json::{self, RawMessage};
use serde::Deserialize;

use crate::claudecfg::read_config_map;
use crate::dirlock::lock_claude;
use crate::error::{Error, Sentinel};
use crate::live::LiveStore;
use crate::paths::ClaudePaths;
use crate::service::Service;
use crate::store::Account;
use crate::{DIR_MODE, FILE_MODE, fsutil};

const ONBOARDING_KEY: &str = "hasCompletedOnboarding";
const SESSIONS_DIR: &str = "sessions";
const OAUTH_ACCOUNT_KEY: &str = "oauthAccount";

/// 계정에 속해 프로필로 옮기지 않는 설정 키다 (FR-CAC-83).
const ACCOUNT_CONFIG_KEYS: [&str; 6] = [
    OAUTH_ACCOUNT_KEY,
    "userID",
    "claudeCodeFirstTokenDate",
    "passesLastSeenRemaining",
    "penguinModeOrgEnabled",
    "managedSettingsNoticeSeenOrg",
];

fn is_account_config_key(k: &str) -> bool {
    ACCOUNT_CONFIG_KEYS.contains(&k) || k.contains("Cache") || k.starts_with("cached")
}

/// 기본 프로필과 함께 쓰는 항목이다 (FR-CAC-82).
const SHARED_ITEMS: [&str; 10] = [
    "settings.json",
    "keybindings.json",
    "CLAUDE.md",
    "skills",
    "commands",
    "agents",
    "rules",
    "plugins",
    "projects",
    "history.jsonl",
];

pub(crate) type LinkOp = Box<dyn Fn(&Path, &Path) -> io::Result<()>>;

/// 공유 항목을 잇는 방법들. 시험이 바꾼다.
pub(crate) struct SharedLinker {
    pub(crate) symlink: LinkOp,
    pub(crate) junction: LinkOp,
}

fn os_symlink(src: &Path, dst: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(src, dst)
    }
    #[cfg(windows)]
    {
        if fs::metadata(src).is_ok_and(|m| m.is_dir()) {
            std::os::windows::fs::symlink_dir(src, dst)
        } else {
            std::os::windows::fs::symlink_file(src, dst)
        }
    }
}

impl SharedLinker {
    pub(crate) fn default_os() -> Self {
        Self {
            symlink: Box::new(os_symlink),
            junction: Box::new(dm_shared_platform::junction),
        }
    }

    /// home 의 공유 항목을 dir 에 잇는다. 잇지 못한 이름을 돌려준다.
    pub(crate) fn link(&self, home: &Path, dir: &Path) -> Vec<String> {
        let mut warn = Vec::new();
        for name in SHARED_ITEMS {
            let (src, dst) = (home.join(name), dir.join(name));
            let Ok(sst) = fs::metadata(&src) else {
                continue;
            };
            if let Ok(dt) = fs::symlink_metadata(&dst) {
                if dt.file_type().is_symlink() {
                    if fs::read_link(&dst).is_ok_and(|got| got == src) {
                        continue;
                    }
                    let _ = fsutil::remove(&dst);
                } else if dt.is_file() && sst.is_file() {
                    if copy_shared_file(&src, &dst).is_err() {
                        warn.push(name.to_owned());
                    }
                    continue;
                } else {
                    continue;
                }
            }
            if (self.symlink)(&src, &dst).is_ok() {
                continue;
            }
            if sst.is_dir() {
                if (self.junction)(&src, &dst).is_err() {
                    warn.push(name.to_owned());
                }
                continue;
            }
            if copy_shared_file(&src, &dst).is_err() {
                warn.push(name.to_owned());
            }
        }
        warn
    }
}

fn copy_shared_file(src: &Path, dst: &Path) -> Result<(), Error> {
    let b = fsutil::read_file(src)?;
    Ok(dm_shared_platform::write_file_atomic(dst, &b, FILE_MODE)?)
}

impl Service {
    /// 프로필이 쓰는 활성 저장소다.
    pub fn profile_live(&self, id: &str) -> LiveStore {
        LiveStore {
            paths: ClaudePaths::profile(&self.profile_dir(id)),
            sec: self.live.sec.clone(),
            retry_delay: self.live.retry_delay,
        }
    }

    /// 계정의 프로필 폴더를 준비하고 그 경로와 잇지 못한 공유 항목을 돌려준다 (FR-CAC-82~85).
    pub fn prepare_profile(&self, id: &str) -> Result<(PathBuf, Vec<String>), Error> {
        let st = self.store.load()?;
        let i = st.find(id).ok_or(Error::from(Sentinel::NotFound))?;
        let acc = st.accounts[i].clone();
        let dir = self.profile_dir(id);
        fsutil::mkdir_all(&dir, DIR_MODE)?;
        crate::store::set_dir_mode(&dir);
        match self.backup.read(id)? {
            Some(b) if !b.is_empty() => {}
            _ => return Err(Sentinel::EmptyBackup.into()),
        }
        let cfg = match fsutil::read_file(&self.config_copy(id)) {
            Ok(b) if json::valid(&b) => b,
            _ => return Err(Sentinel::EmptyBackup.into()),
        };
        self.reclaim_profile(&acc);
        let backup = self.backup.read(id)?.unwrap_or_default();
        let paths = ClaudePaths::profile(&dir);
        let _lock = lock_claude(&paths, self.lock_timeout())?;
        let pl = self.profile_live(id);
        let cur = match pl.read() {
            Ok(c) => c,
            Err(e) if e.is(Sentinel::KeychainUnavailable) => None,
            Err(e) => return Err(e),
        };
        if cur
            .as_ref()
            .is_none_or(|c| c.is_empty() || c.expires_at() < backup.expires_at())
        {
            pl.write(&backup)?;
        }
        self.merge_profile_config(&paths.global_config, RawMessage(cfg))?;
        let warn = match &self.link_shared {
            Some(f) => f(&self.claude.config_home, &dir),
            None => SharedLinker::default_os().link(&self.claude.config_home, &dir),
        };
        self.set_profile_warnings(id, &warn);
        for w in &warn {
            dm_shared_dmlog::infof!(
                None,
                "claude-accounts: 프로필 {id} 의 공유 항목 {w} 를 잇지 못했다"
            );
        }
        Ok((dir, warn))
    }

    /// 프로필의 설정 파일을 만든다: 프로필 것 위에 기본 프로필의 계정 무관 키를 덮고,
    /// 계정의 `oauthAccount` 와 온보딩 완료를 넣는다 (FR-CAC-83).
    fn merge_profile_config(&self, path: &Path, oauth: RawMessage) -> Result<(), Error> {
        let mut out = read_config_map(path).ok().flatten().unwrap_or_default();
        if let Ok(Some(def)) = read_config_map(&self.claude.global_config) {
            for (k, v) in def {
                if !is_account_config_key(&k) {
                    out.insert(k, v);
                }
            }
        }
        out.insert(OAUTH_ACCOUNT_KEY.to_owned(), oauth);
        out.insert(ONBOARDING_KEY.to_owned(), RawMessage(b"true".to_vec()));
        let b = json::marshal(&out)?;
        Ok(dm_shared_platform::write_file_atomic(path, &b, FILE_MODE)?)
    }

    fn alive(&self, pid: i32) -> bool {
        match &self.alive {
            Some(f) => f(pid),
            None => dm_shared_platform::current().process.alive(pid),
        }
    }

    /// 계정의 프로필로 띄운 Claude Code 가 살아 있는가다 (FR-CAC-87).
    pub fn pinned_running(&self, id: &str) -> bool {
        #[derive(Deserialize, Default)]
        #[serde(default)]
        struct V {
            pid: i64,
        }
        let Ok(rd) = fs::read_dir(self.profile_dir(id).join(SESSIONS_DIR)) else {
            return false;
        };
        let mut files: Vec<PathBuf> = rd
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.extension().is_some_and(|x| x == "json"))
            .collect();
        files.sort();
        files.iter().any(|f| {
            fsutil::read_file(f)
                .ok()
                .and_then(|b| json::unmarshal::<V>(&b).ok())
                .and_then(|v| i32::try_from(v.pid).ok())
                .is_some_and(|pid| pid > 0 && self.alive(pid))
        })
    }

    /// 프로필이 갱신한 더 새 토큰을 계정 백업으로 거둔다 (FR-CAC-86). 프로필의 계정이 다르면
    /// 아무것도 하지 않는다.
    pub fn reclaim_profile(&self, a: &Account) {
        let dir = self.profile_dir(&a.id);
        if fs::metadata(&dir).is_err() {
            return;
        }
        match crate::claudecfg::read_oauth_account(&ClaudePaths::profile(&dir).global_config) {
            Ok(Some(oa)) if oa.email_address == a.email && oa.organization_uuid == a.org_uuid => {}
            _ => return,
        }
        let pc = match self.profile_live(&a.id).read() {
            Ok(Some(c)) if !c.is_empty() => c,
            _ => return,
        };
        let Ok(_lock) = fsutil::lock_file(&self.consume_lock(&a.id), self.lock_timeout()) else {
            return;
        };
        match self.backup.read(&a.id) {
            Err(_) => return,
            Ok(Some(bc)) if pc.expires_at() <= bc.expires_at() => return,
            Ok(_) => {}
        }
        if let Err(e) = self.backup.write(&a.id, &pc) {
            dm_shared_dmlog::infof!(None, "claude-accounts: 프로필 토큰을 회수하지 못했다: {e}");
        }
    }

    pub(crate) fn consume_lock(&self, id: &str) -> PathBuf {
        self.dir
            .join("credentials")
            .join(format!(".consume-{id}.lock"))
    }

    pub(crate) fn remove_profile(&self, id: &str) -> Result<(), Error> {
        let dir = self.profile_dir(id);
        let paths = ClaudePaths::profile(&dir);
        if self.live.sec.available() {
            let sec = &self.live.sec;
            let _ = fsutil::off_worker(|| sec.delete(&paths.keychain_service, &sec.account()));
        }
        let mut lock = dir.clone().into_os_string();
        lock.push(".lock");
        let _ = remove_all(Path::new(&lock));
        Ok(remove_all(&dir)?)
    }
}

/// Go `os.RemoveAll`: 없으면 성공이다.
fn remove_all(p: &Path) -> io::Result<()> {
    match fs::symlink_metadata(p) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
        Ok(m) if m.is_dir() => fs::remove_dir_all(p),
        Ok(_) => fs::remove_file(p),
    }
    .map_err(|e| dm_gocompat::oserr::path_error("unlinkat", &p.to_string_lossy(), e))
}
