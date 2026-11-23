//! 계정 관리와 전환. 같은 프로세스 안의 전환은 `mu` 로, 프로세스 사이는 저장소 파일 락으로
//! 직렬화한다.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use dm_gocompat::json::{self, RawMessage, is_empty};
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;

use crate::backup::BackupStore;
use crate::claudecfg::{read_oauth_account, splice_oauth_account};
use crate::client::ProfileLookup;
use crate::creds::Credential;
use crate::dirlock::{DEFAULT_LOCK_WAIT, lock_claude};
use crate::error::{Error, Sentinel};
use crate::fsutil;
use crate::live::{LiveStore, write_secret_file};
use crate::paths::ClaudePaths;
use crate::store::{Account, Patch, State, Store, pick_color};
use crate::unclaimed::UNCLAIMED_DIR;

/// 전환 때 활성 저장소에 있던 자격증명의 분류다 (FR-CAC-32).
pub const OUTGOING_SAME: &str = "same";
pub const OUTGOING_ROTATED: &str = "rotated";
pub const OUTGOING_KNOWN: &str = "known";
pub const OUTGOING_FOREIGN: &str = "foreign";
pub const OUTGOING_EMPTY: &str = "empty";
pub const OUTGOING_UNRESOLVED: &str = "unresolved";

/// 전환 결과다.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "claudeacct.SwitchResult")]
pub struct SwitchResult {
    pub from: String,
    pub to: String,
    #[serde(skip_serializing_if = "is_empty")]
    pub outgoing: String,
    #[serde(rename = "noop", skip_serializing_if = "is_empty")]
    pub no_op: bool,
    /// `best` 가 전환하지 않은 이유다 (FR-CAC-31a).
    #[serde(skip_serializing_if = "is_empty")]
    pub reason: String,
    /// 떠나는 계정이 프로필로 실행 중이었다는 안내다. 전환을 막지 않는다 (FR-CAC-36, D-CAC-28).
    #[serde(rename = "pinnedRunning", skip_serializing_if = "is_empty")]
    pub pinned_running: bool,
}

pub type Clock = Arc<dyn Fn() -> OffsetDateTime + Send + Sync>;
pub type IdGen = Arc<dyn Fn() -> String + Send + Sync>;
pub type AliveFn = Arc<dyn Fn(i32) -> bool + Send + Sync>;
pub type LinkFn = Arc<dyn Fn(&Path, &Path) -> Vec<String> + Send + Sync>;

pub struct Service {
    pub store: Store,
    pub backup: BackupStore,
    pub live: LiveStore,
    pub claude: ClaudePaths,
    pub dir: PathBuf,
    pub api: Arc<dyn ProfileLookup>,
    pub now: Clock,
    pub new_id: IdGen,
    /// 0 이면 [`DEFAULT_LOCK_WAIT`].
    pub lock_timeout: Duration,
    /// pid 가 살아 있는가다. 비면 운영체제에 묻는다 (FR-CAC-87).
    pub alive: Option<AliveFn>,
    /// 프로필에 공유 항목을 잇고 잇지 못한 이름을 돌려준다. 비면 심볼릭 링크·복사·정션이다 (FR-CAC-82).
    pub link_shared: Option<LinkFn>,
    pub(crate) mu: tokio::sync::Mutex<()>,
    /// 계정마다 마지막 프로필 준비에서 잇지 못한 공유 항목이다 (FR-CAC-88b).
    warns: Mutex<HashMap<String, Vec<String>>>,
}

impl Service {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        store: Store,
        backup: BackupStore,
        live: LiveStore,
        claude: ClaudePaths,
        dir: impl Into<PathBuf>,
        api: Arc<dyn ProfileLookup>,
        now: Clock,
        new_id: IdGen,
    ) -> Self {
        Self {
            store,
            backup,
            live,
            claude,
            dir: dir.into(),
            api,
            now,
            new_id,
            lock_timeout: Duration::ZERO,
            alive: None,
            link_shared: None,
            mu: tokio::sync::Mutex::new(()),
            warns: Mutex::new(HashMap::new()),
        }
    }

    pub(crate) fn lock_timeout(&self) -> Duration {
        if self.lock_timeout.is_zero() {
            DEFAULT_LOCK_WAIT
        } else {
            self.lock_timeout
        }
    }

    pub(crate) fn config_copy(&self, id: &str) -> PathBuf {
        self.dir.join("configs").join(format!("{id}.json"))
    }

    /// 지금 로그인한 계정을 등록한다. 이미 있으면 그 계정의 백업을 갱신한다 (FR-CAC-10).
    /// 새로 만들었으면 `.1` 이 true.
    pub async fn add_current(&self) -> Result<(Account, bool), Error> {
        let _g = self.mu.lock().await;
        let oa = match read_oauth_account(&self.claude.global_config)? {
            Some(oa) if !oa.email_address.is_empty() => oa,
            _ => return Err(Sentinel::NotLoggedIn.into()),
        };
        let live = match self.live.read()? {
            Some(c) if !c.is_empty() => c,
            _ => return Err(Sentinel::LiveEmpty.into()),
        };
        let mut out = Account::default();
        let mut created = false;
        self.store.update(|st| {
            let idx = match st
                .accounts
                .iter()
                .position(|a| a.email == oa.email_address && a.org_uuid == oa.organization_uuid)
            {
                Some(i) => i,
                None => {
                    let color = pick_color(&st.accounts);
                    st.accounts.push(Account {
                        id: (self.new_id)(),
                        email: oa.email_address.clone(),
                        org_uuid: oa.organization_uuid.clone(),
                        added_at: dm_gocompat::time::GoTime(
                            (self.now)().to_offset(time::UtcOffset::UTC),
                        ),
                        color,
                        ..Account::default()
                    });
                    created = true;
                    st.accounts.len() - 1
                }
            };
            let a = &mut st.accounts[idx];
            a.account_uuid = oa.account_uuid.clone();
            a.org_name = oa.organization_name.clone();
            self.backup.write(&a.id, &live)?;
            write_secret_file(&self.config_copy(&a.id), &oa.raw.0)?;
            st.active_id = a.id.clone();
            out = a.clone();
            Ok(())
        })?;
        Ok((out, created))
    }

    /// 계정의 별칭·색·문턱값·우선순위·제외를 고친다.
    pub fn update(&self, id: &str, p: &Patch) -> Result<Account, Error> {
        p.validate()?;
        let mut out = Account::default();
        self.store.update(|st| {
            let i = st.find(id).ok_or(Error::from(Sentinel::NotFound))?;
            p.apply(&mut st.accounts[i]);
            out = st.accounts[i].clone();
            Ok(())
        })?;
        Ok(out)
    }

    /// 계정 순서를 ids 로 바꾼다. 모든 계정을 한 번씩 담아야 한다.
    pub fn reorder(&self, ids: &[String]) -> Result<(), Error> {
        self.store.update(|st| {
            let bad = || Error::with_detail(Sentinel::Invalid, "모든 계정을 한 번씩 담아야 합니다");
            if ids.len() != st.accounts.len() {
                return Err(bad());
            }
            let mut seen = HashSet::new();
            let mut out = Vec::with_capacity(ids.len());
            for id in ids {
                let i = st.find(id).ok_or_else(bad)?;
                if !seen.insert(id) {
                    return Err(bad());
                }
                out.push(st.accounts[i].clone());
            }
            st.accounts = out;
            Ok(())
        })
    }

    /// 계정과 그 백업을 지운다. 활성 저장소는 건드리지 않는다 (FR-CAC-12).
    pub async fn remove(&self, id: &str) -> Result<(), Error> {
        let _g = self.mu.lock().await;
        self.store.update(|st| {
            let i = st.find(id).ok_or(Error::from(Sentinel::NotFound))?;
            st.accounts.remove(i);
            if st.active_id == id {
                st.active_id.clear();
            }
            Ok(())
        })?;
        fsutil::remove_if_exists(&self.config_copy(id))?;
        self.drop_account_mappings(id)?;
        self.remove_profile(id)?;
        self.set_profile_warnings(id, &[]);
        self.backup.delete(id)
    }

    /// 활성 저장소의 자격증명이 누구의 것인지 정한다 (FR-CAC-32). 네트워크를 부를 수 있으므로
    /// 락을 잡기 전에 부른다. 두 번째 값은 백업할 계정이다.
    async fn classify(
        &self,
        st: &State,
        from: &str,
        live: Option<&Credential>,
    ) -> (&'static str, String) {
        let Some(live) = live.filter(|c| !c.is_empty()) else {
            return (OUTGOING_EMPTY, String::new());
        };
        let fp = live.fingerprint();
        if !from.is_empty()
            && let Ok(Some(b)) = self.backup.read(from)
            && b.fingerprint() == fp
        {
            if b.access_token() == live.access_token() {
                return (OUTGOING_SAME, from.to_owned());
            }
            return (OUTGOING_ROTATED, from.to_owned());
        }
        for a in st.accounts.iter().filter(|a| a.id != from) {
            if let Ok(Some(b)) = self.backup.read(&a.id)
                && b.fingerprint() == fp
            {
                return (OUTGOING_KNOWN, a.id.clone());
            }
        }
        let Ok(idn) = self.api.profile(&live.access_token()).await else {
            return (OUTGOING_UNRESOLVED, String::new());
        };
        for a in &st.accounts {
            if a.account_uuid != idn.account_uuid
                || (!idn.org_uuid.is_empty() && a.org_uuid != idn.org_uuid)
            {
                continue;
            }
            if a.id == from || from.is_empty() {
                return (OUTGOING_ROTATED, a.id.clone());
            }
            return (OUTGOING_FOREIGN, String::new());
        }
        (OUTGOING_FOREIGN, String::new())
    }

    /// 주인을 확정하지 못한 자격증명을 버리지 않고 보관한다 (FR-CAC-34).
    fn stash(&self, c: &Credential) -> Result<(), Error> {
        let raw = c.marshal()?;
        let name = format!("{}-{}.json", (self.now)().unix_timestamp(), c.fingerprint());
        write_secret_file(&self.dir.join(UNCLAIMED_DIR).join(name), &raw)
    }

    /// id 를 활성 계정으로 만든다 (FR-CAC-30). 실패하면 이미 끝낸 단계를 되돌린다.
    pub async fn switch(&self, id: &str) -> Result<SwitchResult, Error> {
        let _g = self.mu.lock().await;
        let st = self.store.load()?;
        if st.find(id).is_none() {
            return Err(Sentinel::NotFound.into());
        }
        let from = st.active_id.clone();
        if from == id {
            return Ok(SwitchResult {
                from,
                to: id.to_owned(),
                no_op: true,
                ..SwitchResult::default()
            });
        }
        let mut pinned = false;
        if let Some(i) = st.find(&from)
            && self.pinned_running(&from)
        {
            self.reclaim_profile(&st.accounts[i]);
            pinned = true;
        }
        let live = self.live.read()?;
        let (kind, owner) = self.classify(&st, &from, live.as_ref()).await;
        let res = SwitchResult {
            from,
            to: id.to_owned(),
            outgoing: kind.to_owned(),
            pinned_running: pinned,
            ..SwitchResult::default()
        };

        let _store_lock = self.store.lock()?;
        let _claude_lock = lock_claude(&self.claude, self.lock_timeout())?;

        let again = self.live.read()?;
        if again.is_some() != live.is_some()
            || again.as_ref().map(Credential::fingerprint)
                != live.as_ref().map(Credential::fingerprint)
        {
            return Err(Sentinel::LiveChanged.into());
        }
        let target = match self.backup.read(id)? {
            Some(t) if !t.is_empty() => t,
            _ => return Err(Sentinel::EmptyBackup.into()),
        };
        let cfg = match fsutil::read_file(&self.config_copy(id)) {
            Ok(b) if json::valid(&b) => b,
            _ => return Err(Sentinel::EmptyBackup.into()),
        };

        if let Some(live) = &live {
            match kind {
                OUTGOING_ROTATED => {
                    // 프로필에서 회수한 토큰(FR-CAC-86)이 더 새것이면 낡은 활성 토큰으로 덮지 않는다.
                    let keep_newer = matches!(self.backup.read(&owner), Ok(Some(cur)) if live.expires_at() < cur.expires_at());
                    if !keep_newer {
                        self.backup.write(&owner, live)?;
                    }
                }
                OUTGOING_FOREIGN | OUTGOING_UNRESOLVED => self.stash(live)?,
                _ => {}
            }
        }
        if (kind == OUTGOING_SAME || kind == OUTGOING_ROTATED)
            && !owner.is_empty()
            && let Ok(Some(oa)) = read_oauth_account(&self.claude.global_config)
        {
            let _ = write_secret_file(&self.config_copy(&owner), &oa.raw.0);
        }

        let next = match &live {
            Some(l) => target.with_shared(l),
            None => target,
        };
        self.live.write(&next)?;
        let rollback_live = || {
            if let Some(l) = &live {
                let _ = self.live.write(l);
            }
        };
        let prev = match splice_oauth_account(&self.claude.global_config, Some(&RawMessage(cfg))) {
            Ok(p) => p,
            Err(e) => {
                rollback_live();
                return Err(e);
            }
        };
        let r = self.store.update_locked(|st| {
            if st.find(id).is_none() {
                return Err(Sentinel::NotFound.into());
            }
            st.active_id = id.to_owned();
            Ok(())
        });
        if let Err(e) = r {
            let prev = (!prev.0.is_empty()).then_some(&prev);
            let _ = splice_oauth_account(&self.claude.global_config, prev);
            rollback_live();
            return Err(e);
        }
        Ok(res)
    }

    /// `~/.claude.json` 의 계정과 같은 등록 계정의 ID 다. 없거나 읽지 못하면 빈 값이다.
    pub(crate) fn live_account_id(&self, st: &State) -> String {
        let Ok(Some(oa)) = read_oauth_account(&self.claude.global_config) else {
            return String::new();
        };
        st.accounts
            .iter()
            .find(|a| a.email == oa.email_address && a.org_uuid == oa.organization_uuid)
            .map(|a| a.id.clone())
            .unwrap_or_default()
    }

    /// dongminal 밖(`/login`·cswap)에서 바꾼 활성 계정을 활성 기록에 맞춘다 (FR-CAC-34b).
    /// 등록되지 않은 계정이면 고치지 않는다. 전환 기록은 남기지 않는다. 고쳤으면 true.
    pub fn sync_active_from_live(&self) -> Result<bool, Error> {
        let st = self.store.load()?;
        self.sync_active_from(st)
            .map(|(_, changed)| changed)
            .map_err(|(_, e)| e)
    }

    /// 이미 읽은 st 로 판정하는 sync_active_from_live 다 (GD-23). 고쳤으면 고친 뒤의 상태를,
    /// 아니면 st 를 그대로 준다. 오류면 (고쳤는가, 오류) 다.
    pub(crate) fn sync_active_from(&self, st: State) -> Result<(State, bool), (bool, Error)> {
        let id = self.live_account_id(&st);
        if id.is_empty() || id == st.active_id {
            return Ok((st, false));
        }
        let mut changed = false;
        let mut next = None;
        let r = self.store.update(|cur| {
            let id = self.live_account_id(cur);
            if !id.is_empty() && id != cur.active_id {
                cur.active_id = id;
                changed = true;
            }
            next = Some(cur.clone());
            Ok(())
        });
        match r {
            Err(e) => Err((changed, e)),
            Ok(()) => Ok((next.unwrap_or(st), changed)),
        }
    }

    pub(crate) fn set_profile_warnings(&self, id: &str, warn: &[String]) {
        let mut w = self.warns.lock().unwrap_or_else(PoisonError::into_inner);
        if warn.is_empty() {
            w.remove(id);
        } else {
            w.insert(id.to_owned(), warn.to_vec());
        }
    }

    /// 마지막 프로필 준비에서 잇지 못한 공유 항목이다 (FR-CAC-88b).
    pub fn profile_warnings(&self, id: &str) -> Vec<String> {
        self.warns
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(id)
            .cloned()
            .unwrap_or_default()
    }
}

impl State {
    /// 순서에서 활성 계정 다음의, 제외되지 않았고 ok 를 만족하는 계정이다 (FR-CAC-31 `next`).
    pub(crate) fn next_after(&self, ok: impl Fn(&Account) -> bool) -> Option<String> {
        let n = self.accounts.len() as isize;
        let start = self.find(&self.active_id).map_or(-1, |i| i as isize);
        (1..=n)
            .map(|k| &self.accounts[((start + k + n) % n) as usize])
            .find(|a| a.id != self.active_id && !a.disabled && ok(a))
            .map(|a| a.id.clone())
    }
}
