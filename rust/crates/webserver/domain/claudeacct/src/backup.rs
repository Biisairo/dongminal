//! 계정별 자격증명 백업. 파일이 있으면 파일이 이긴다 — 키체인 쓰기가 실패했을 때만 파일이
//! 생기기 때문이다.

use std::io;
use std::path::PathBuf;
use std::sync::{Arc, LazyLock};

use dm_shared_platform::Secrets;
use regex::Regex;

use crate::creds::Credential;
use crate::error::{Error, Sentinel, join};
use crate::fsutil;
use crate::live::write_secret_file;

/// dongminal 이 계정 백업을 두는 키체인 서비스다 (FR-CAC-4).
const BACKUP_SERVICE: &str = "dongminal-claude-accounts";
const PREV: &str = ".prev";

pub(crate) static ID_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_-]{1,64}$").expect("상수 정규식"));

#[derive(Clone)]
pub struct BackupStore {
    pub dir: PathBuf,
    pub sec: Arc<dyn Secrets>,
}

fn kc_account(id: &str, suffix: &str) -> String {
    format!("account-{id}{suffix}")
}

impl BackupStore {
    fn file(&self, id: &str, suffix: &str) -> PathBuf {
        self.dir
            .join("credentials")
            .join(format!("{id}{suffix}.json"))
    }

    fn read_sfx(&self, id: &str, suffix: &str) -> Result<Option<Credential>, Error> {
        if !ID_RE.is_match(id) {
            return Err(Sentinel::InvalidId.into());
        }
        match fsutil::read_file(&self.file(id, suffix)) {
            Ok(raw) => return Credential::parse(&raw).map(Some),
            Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(e.into()),
            Err(_) => {}
        }
        if !self.sec.available() {
            return Ok(None);
        }
        match self.sec.get(BACKUP_SERVICE, &kc_account(id, suffix))? {
            Some(v) => Credential::parse(v.as_bytes()).map(Some),
            None => Ok(None),
        }
    }

    fn write_sfx(&self, id: &str, suffix: &str, c: &Credential) -> Result<(), Error> {
        let raw = c.marshal()?;
        if self.sec.available()
            && self
                .sec
                .set(
                    BACKUP_SERVICE,
                    &kc_account(id, suffix),
                    &String::from_utf8_lossy(&raw),
                )
                .is_ok()
        {
            return Ok(fsutil::remove_if_exists(&self.file(id, suffix))?);
        }
        write_secret_file(&self.file(id, suffix), &raw)?;
        Ok(self.sec.delete(BACKUP_SERVICE, &kc_account(id, suffix))?)
    }

    /// 계정의 백업이다.
    pub fn read(&self, id: &str) -> Result<Option<Credential>, Error> {
        self.read_sfx(id, "")
    }

    /// 바로 앞 세대의 백업이다.
    pub fn read_prev(&self, id: &str) -> Result<Option<Credential>, Error> {
        self.read_sfx(id, PREV)
    }

    /// 지금 백업을 앞 세대로 남기고 새 백업을 쓴다.
    pub fn write(&self, id: &str, c: &Credential) -> Result<(), Error> {
        if !ID_RE.is_match(id) {
            return Err(Sentinel::InvalidId.into());
        }
        if let Ok(Some(cur)) = self.read(id) {
            self.write_sfx(id, PREV, &cur)?;
        }
        self.write_sfx(id, "", c)
    }

    /// 백업과 앞 세대를 모두 지운다.
    pub fn delete(&self, id: &str) -> Result<(), Error> {
        if !ID_RE.is_match(id) {
            return Err(Sentinel::InvalidId.into());
        }
        let mut errs = Vec::new();
        for sfx in ["", PREV] {
            if let Err(e) = fsutil::remove_if_exists(&self.file(id, sfx)) {
                errs.push(e.into());
            }
            if let Err(e) = self.sec.delete(BACKUP_SERVICE, &kc_account(id, sfx)) {
                errs.push(e.into());
            }
        }
        join(errs)
    }
}
